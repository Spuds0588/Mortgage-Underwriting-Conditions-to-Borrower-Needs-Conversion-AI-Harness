/**
 * needle-bench.mjs — tune the Needle 2 example engine without the browser.
 *
 * Runs the SAME vendored runtime and the SAME schemas/framing that
 * js/engines/NeedleEngine.js uses, but in Node, so a schema or framing
 * change can be measured in seconds instead of a page round-trip.
 *
 *   node tools/needle-bench.mjs                 # both stages, all samples
 *   node tools/needle-bench.mjs --stage=extract
 *   node tools/needle-bench.mjs --stage=frame    # label A/B (the cheapest quality lever)
 *   node tools/needle-bench.mjs --stage=slot     # slot-fill probe (the Stage-2 falsification)
 *   node tools/needle-bench.mjs --download       # fetch the .cact into .cache/
 *   node tools/needle-bench.mjs --raw            # dump raw call JSON
 *
 * The weights live in .cache/needle2.cact (gitignored, 13.7 MB, Apache-2.0).
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smartChunk } from '../js/harness.js';
import { SAMPLE_JSON, SAMPLE_EMAIL, SAMPLE_OCR } from '../js/samples.js';
import { NEEDLE_EXTRACT_TOOL, NEEDLE_TRANSLATE_TOOL, frameExtract, frameTranslate } from '../js/engines/needleSchema.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNTIME = join(ROOT, 'js/vendor/needle/needle.js');
const WEIGHTS = join(ROOT, '.cache/needle2.cact');
export const MODEL_URL = 'https://huggingface.co/Cactus-Compute/needle2/resolve/main/needle2.cact';

const argv = process.argv.slice(2);
const stage = argv.find((a) => a.startsWith('--stage='))?.split('=')[1] ?? 'both';
const RAW = argv.includes('--raw');

async function ensureWeights() {
  if (existsSync(WEIGHTS)) return;
  if (!argv.includes('--download')) {
    throw new Error(`Missing ${WEIGHTS}\n  fetch it with: node tools/needle-bench.mjs --download`);
  }
  console.log('⤓ downloading needle2.cact (~13.7 MB)…');
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await mkdir(dirname(WEIGHTS), { recursive: true });
  await writeFile(WEIGHTS, Buffer.from(await res.arrayBuffer()));
  console.log('   saved', WEIGHTS);
}

/**
 * Load the vendored UMD runtime in a CommonJS scope.
 * The repo is `type: module`, so require() would parse needle.js as ESM and
 * return a namespace object instead of the factory — evaluating the source by
 * hand keeps the runtime in the CommonJS branch it was built for.
 */
async function loadFactory() {
  const src = await readFile(RUNTIME, 'utf8');
  const mod = { exports: {} };
  const evaluate = new Function('module', 'exports', 'require', '__dirname', '__filename', src);
  evaluate(mod, mod.exports, createRequire(import.meta.url), dirname(RUNTIME), RUNTIME);
  const factory = mod.exports.default ?? mod.exports;
  if (typeof factory !== 'function') throw new Error('needle.js did not export a factory');
  return factory;
}

/** Load the runtime + weights and return a `complete(query, {tools, phase})` closure. */
export async function loadNeedle({ cactPath = WEIGHTS } = {}) {
  const createNeedle = await loadFactory();
  const Module = await createNeedle({});
  const bytes = await readFile(cactPath);
  const ptr = Module._malloc(bytes.length);
  Module.HEAPU8.set(bytes, ptr);
  const loadRc = Module._needle_load(ptr, BigInt(bytes.length));   // i64 → BigInt
  Module._free(ptr);
  if (loadRc < 0) throw new Error(`needle_load failed: ${loadRc}`);

  const init = Module.cwrap('needle_init', 'number', ['string', 'string', 'string']);
  const complete = Module.cwrap('needle_complete', 'number', ['string', 'number', 'number', 'number']);
  const OUT_CAP = 64 * 1024;
  const OUT = Module._malloc(OUT_CAP);

  return {
    /** @returns {{json: object|null, raw: string, ms: number, generated: number}} */
    complete(query, tools, maxNewTokens = 512) {
      Module._needle_reset();
      const rc = init(null, JSON.stringify(tools), null);   // negative == failure
      if (rc < 0) throw new Error(`needle_init failed: ${rc}`);
      const t0 = Date.now();
      const generated = complete(query, maxNewTokens, OUT, OUT_CAP);
      const ms = Date.now() - t0;
      const raw = Module.UTF8ToString(OUT);
      let json = null;
      try { json = JSON.parse(raw); } catch { /* keep raw */ }
      return { json, raw, ms, generated };
    },
  };
}

const calls = (out) => out.json?.function_calls ?? [];

function report(label, out, pick) {
  const call = calls(out)[0];
  const value = call ? pick(call.arguments ?? {}) : undefined;
  console.log(`\n── ${label}  (${out.ms}ms, ${out.generated} tokens, conf=${out.json?.confidence ?? '—'})`);
  if (RAW) console.log('   raw: ' + out.raw);
  console.log('   → ' + (value === undefined
    ? `NO CALL (refused: ${out.json?.reasoning ?? out.raw.slice(0, 120)})`
    : JSON.stringify(value)));
}

/**
 * Framing A/B. The label the passage is framed with is the single biggest
 * lever on extraction quality: a bare passage is refused, and a label that
 * states the expectation ("each item one full requirement") cuts fragment
 * splitting roughly in half. This loop scores each candidate.
 */
const FRAME_VARIANTS = [
  ['plain label', (p) => `Underwriting conditions:\n- ${p}`],
  ['label + full-requirement note', (p) => `Underwriting conditions (each item one full requirement, never a fragment):\n- ${p}`],
  ['label + quoted-in-full label', (p) => `Underwriting conditions (requirements listed one per item, quoted in full):\n- ${p}`],
  ['trailing instruction', (p) => `Underwriting conditions:\n- ${p}\nQuote each requirement in full above.`],
];

async function framingAb() {
  await ensureWeights();
  const needle = await loadNeedle();
  const chunks = [...smartChunk(SAMPLE_OCR), ...smartChunk(SAMPLE_EMAIL)];
  console.log(`framing A/B over ${chunks.length} real chunks (${chunks.length * FRAME_VARIANTS.length} calls)\n`);
  for (const [label, frame] of FRAME_VARIANTS) {
    let items = 0; let whole = 0; let refusals = 0; let ms = 0;
    for (const chunk of chunks) {
      const out = needle.complete(frame(chunk.text), NEEDLE_EXTRACT_TOOL, 256);
      ms += out.ms;
      const list = calls(out)[0]?.arguments?.conditions;
      if (!Array.isArray(list) || !list.length) { refusals += 1; continue; }
      items += list.length;
      for (const it of list) if (it.length >= 0.6 * chunk.text.length) whole += 1;
    }
    console.log(`${label.padEnd(32)} items=${String(items).padStart(3)}  whole=${String(whole).padStart(3)}  ` +
      `fragments=${String(items - whole).padStart(3)}  refusals=${refusals}/${chunks.length}  ${(ms / chunks.length).toFixed(0)}ms/chunk`);
  }
}

/**
 * Stage-2 probe, part 2: SLOT FILLING.
 *
 * Part 1 (see main(), `--stage=translate`) showed Needle will not originate
 * free text — asked for a rewrite it echoes the input. The remaining hope was
 * that it could fill narrow slots a deterministic template then renders, so
 * the model never has to invent wording. It cannot: measured here, it refuses
 * 6 of 18 calls outright, and when it does call it invents identifiers and
 * dates that appear nowhere in the input ("2019-dissolution-clear-out",
 * "2025-03-21") in fields it must fill but cannot quote.
 *
 * So the contract's promise — "an optional field with no evidence is omitted,
 * not guessed" — holds only for fields it can answer by copying. It fills a
 * REQUIRED field it cannot copy by guessing.
 */
const SLOT_TOOL = [{
  name: 'borrower_request',
  description: 'The request to send to the borrower, with each slot taken from the requirement text',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['send_documents', 'sign_or_correct_document', 'wait', 'review_notes', 'provide_explanation'],
        description: 'The kind of action the requirement asks of the borrower',
      },
      documents: {
        type: 'array',
        items: { type: 'string' },
        description: 'Each document the borrower must send, named exactly as it appears in the requirement',
      },
      deadline: {
        type: 'string',
        description: 'The time limit stated in the requirement, copied exactly; empty string when none is stated',
      },
      subject: {
        type: 'string',
        description: 'The matter the requirement is about, copied from the requirement text',
      },
    },
    required: ['action', 'subject'],
  },
}];

const SLOT_CONDITIONS = [
  'Most recent paystub is missing the year-to-date figure. Provide a VOE dated within 30 days of the note date.',
  'We will allow 2 months of the PMI premium to be in the escrow reserves, if the PIF premium plan credit is allowed.',
  'Clear the outstanding judgment from the 2019 dissolution; vesting must read "John Alvarez and Maria Alvarez, husband and wife".',
  'Wait the full 30 days before pulling reserves from the partial payment, and redo the experience escrow analysis.',
  'If the subject property has a rental unit, an additional rent schedule is required.',
  'Provide the signed gift letter and a 5-day seasoned trail for the gift from the maternal aunt.',
];

const SLOT_FRAMES = [
  ['ask-borrower', (c) => `Ask the borrower to provide: ${c}`],
  ['requirement', (c) => `Requirement: ${c}`],
  ['request-label', (c) => `Borrower request (each slot taken from the requirement below):\n${c}`],
];

/**
 * Deterministic sentence assembly: the model supplies slots, JS supplies the
 * language. Only used to show what the fabricated slots would have rendered as.
 */
function renderSlot(a = {}) {
  const docs = (a.documents ?? []).filter((d) => d && d.trim());
  const list = docs.length === 1 ? docs[0]
    : docs.length === 2 ? `${docs[0]} and ${docs[1]}`
    : docs.length ? `${docs.slice(0, -1).join(', ')}, and ${docs.at(-1)}` : '';
  const due = a.deadline && a.deadline.trim()
    ? ` (${/^within\b/i.test(a.deadline.trim()) ? a.deadline.trim() : `within ${a.deadline.trim()}`})` : '';
  switch (a.action) {
    case 'send_documents':
      return list ? `Could you send us your ${list}${due}?` : `Could you send us the documents for ${a.subject}${due}?`;
    case 'sign_or_correct_document':
      return `Could you sign or correct the paperwork for ${a.subject}${due}?`;
    case 'wait':
      return `Nothing to do yet — we just need to wait ${a.deadline || 'out the required period'} before moving ahead with ${a.subject}.`;
    case 'review_notes':
      return `Please review the notes on ${a.subject} and let us know if anything changed.`;
    default:
      return `Could you tell us a bit more about ${a.subject}${due}?`;
  }
}

/**
 * Is a slot value traceable to the requirement, or invented?
 * True when the whole value appears in the source, or when any two adjacent
 * significant words of it do (a value the model re-arranged but did not invent).
 */
function groundedIn(value, source) {
  const v = String(value ?? '').toLowerCase().trim();
  if (!v) return false;
  const s = String(source).toLowerCase();
  if (s.includes(v)) return true;
  const words = v.split(/\s+/).filter((w) => w.length > 3);
  if (words.length === 1) return s.includes(words[0]);
  for (let i = 0; i + 1 < words.length; i += 1) {
    if (s.includes(`${words[i]} ${words[i + 1]}`)) return true;
  }
  return false;
}

async function slotFill() {
  await ensureWeights();
  const needle = await loadNeedle();
  console.log(`slot-fill probe over ${SLOT_CONDITIONS.length} real conditions × ${SLOT_FRAMES.length} framings ` +
    `(${SLOT_CONDITIONS.length * SLOT_FRAMES.length} calls)\n`);
  const totals = { calls: 0, refusals: 0, emptyRequired: 0, ungroundedDocs: 0, ungroundedDeadline: 0, ms: 0 };
  for (const [label, frame] of SLOT_FRAMES) {
    const t = { calls: 0, refusals: 0, emptyRequired: 0, ungroundedDocs: 0, ungroundedDeadline: 0, ms: 0 };
    console.log(`──── frame: ${label} ────`);
    for (const c of SLOT_CONDITIONS) {
      const out = needle.complete(frame(c), SLOT_TOOL, 256);
      t.ms += out.ms;
      const call = calls(out)[0];
      if (!call) {
        t.refusals += 1;
        console.log(`  ✗ NO CALL (${out.ms}ms, conf=${out.json?.confidence ?? '—'}) ${JSON.stringify(out.json?.reasoning ?? out.raw.slice(0, 100))}`);
        continue;
      }
      t.calls += 1;
      const a = call.arguments ?? {};
      const empty = ['action', 'subject'].filter((k) => !String(a[k] ?? '').trim());
      if (empty.length) t.emptyRequired += 1;
      const badDocs = (a.documents ?? []).filter((d) => !groundedIn(d, c));
      t.ungroundedDocs += badDocs.length;
      const badDeadline = a.deadline && !groundedIn(a.deadline, c);
      if (badDeadline) t.ungroundedDeadline += 1;
      console.log(`  ${String(a.action ?? '(none)').padEnd(24)} docs=${JSON.stringify(a.documents ?? null)} deadline=${JSON.stringify(a.deadline ?? null)}`);
      console.log(`     subject=${JSON.stringify(a.subject ?? null)}${empty.length ? `  ⚠ EMPTY REQUIRED: ${empty.join(', ')}` : ''}`);
      if (badDocs.length || badDeadline) {
        console.log(`     ⚠ NOT IN INPUT: ${[...badDocs, ...(badDeadline ? [a.deadline] : [])].map((x) => JSON.stringify(x)).join(', ')}`);
      }
      console.log(`     → ${renderSlot(a)}`);
    }
    for (const k of Object.keys(totals)) totals[k] += t[k];
    console.log(`${label.padEnd(16)} calls=${t.calls}/${SLOT_CONDITIONS.length}  refusals=${t.refusals}  ` +
      `empty-required=${t.emptyRequired}  ungrounded-docs=${t.ungroundedDocs}  ` +
      `ungrounded-deadline=${t.ungroundedDeadline}  ${(t.ms / SLOT_CONDITIONS.length).toFixed(0)}ms/call\n`);
  }
  console.log(`TOTAL              calls=${totals.calls}/18  refusals=${totals.refusals}  empty-required=${totals.emptyRequired}  ` +
    `ungrounded-docs=${totals.ungroundedDocs}  ungrounded-deadline=${totals.ungroundedDeadline}`);
}

async function main() {
  if (stage === 'frame') return framingAb();
  if (stage === 'slot') return slotFill();
  await ensureWeights();
  const needle = await loadNeedle();
  console.log(`needle2.cact loaded (${(await readFile(WEIGHTS)).length} bytes)`);

  const samples = { json: SAMPLE_JSON, email: SAMPLE_EMAIL, ocr: SAMPLE_OCR };

  if (stage === 'both' || stage === 'extract') {
    console.log('\n════ Stage 1 — extraction (schema-constrained) ════');
    for (const [name, text] of Object.entries(samples)) {
      const chunks = smartChunk(text);
      console.log(`\n[${name}] ${chunks.length} chunk(s)`);
      for (const chunk of chunks.slice(0, 3)) {
        const out = needle.complete(frameExtract(chunk.text), NEEDLE_EXTRACT_TOOL, 256);
        report(`${name}/${chunk.id}`, out, (a) => a.conditions);
      }
    }
  }

  if (stage === 'both' || stage === 'translate') {
    console.log('\n════ Stage 2 — borrower rewrite (generation) ════');
    const conditions = [
      'Provide proof of employment (VOE) dated within 30 days of the note date.',
      'We will allow 2 months of the private mortgage insurance (PMI) premium to be in the escrow reserves.',
      'Clear the outstanding judgment from the 2019 dissolution; vesting must read "John Alvarez and Maria Alvarez, husband and wife".',
    ];
    for (const c of conditions) {
      const out = needle.complete(frameTranslate(c), NEEDLE_TRANSLATE_TOOL, 128);
      report(`translate: ${c.slice(0, 48)}…`, out, (a) => a.need ?? a.message);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
}
