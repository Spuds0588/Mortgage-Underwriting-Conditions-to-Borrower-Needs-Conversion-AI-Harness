/**
 * tests/smoke.mjs — deterministic unit checks for the pipeline's pure logic.
 *
 *   node tests/smoke.mjs
 *
 * No browser, no model, no network: these are the regex/parse/expand paths
 * that decide what the models are even asked, plus the Needle 2 adapter
 * helpers (grounding, span merge, framing round-trip). Exit code 0 only when
 * every check passes.
 */
import {
  smartChunk,
  parseConditionsJson,
  parseStructuredConditions,
  filterVagueFragments,
  expandAcronyms,
  DEFAULT_EXTRACT_PROMPT,
  DEFAULT_TRANSLATE_PROMPT,
  HARNESS_VERSION,
  ENGINES,
} from '../js/harness.js';
import { NeedleEngine, groundConditions, mergeContiguousSpans } from '../js/engines/NeedleEngine.js';
import { frameExtract, unwrapHarnessPrompt } from '../js/engines/needleSchema.js';
import { SAMPLE_JSON, SAMPLE_OCR, SAMPLE_EMAIL } from '../js/samples.js';

let failed = 0;
function check(name, fn) {
  try {
    const detail = fn();
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failed += 1;
    console.error(`  ❌ ${name} — ${err.message}`);
  }
}
const eq = (a, b, msg) => {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg ?? 'mismatch'}: got ${ja}, want ${jb}`);
};
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

console.log(`\nharness v${HARNESS_VERSION}`);

console.log('\n▶ chunking');
check('numbered list → one chunk per item, marker stripped', () => {
  // Items must clear smartChunk's 40-char minimum or tiny fragments merge forward.
  const chunks = smartChunk([
    '1. Provide the most recent paystub covering the last thirty days of income',
    '2. Provide a proof of employment dated within thirty days of the note date',
    '3. Provide bank statements covering the sixty days before the application',
  ].join('\n'));
  eq(chunks.length, 3, 'chunk count');
  eq(chunks[0].id, 'chunk_1', 'first id');
  ok(!chunks[1].text.startsWith('2.'), 'list marker should be stripped');
});
check('blank-line paragraphs split', () => {
  const chunks = smartChunk(`${'a'.repeat(60)} one\n\n${'b'.repeat(60)} two`);
  eq(chunks.length, 2, 'paragraph count');
});
check('email headers are stripped before chunking', () => {
  const chunks = smartChunk('Subject: Re: loan\nFrom: Tina\n' + 'x'.repeat(80));
  ok(chunks.every((c) => !/subject:/i.test(c.text)), 'Subject header survived');
});
check('OCR sample → 6 item chunks', () => eq(smartChunk(SAMPLE_OCR).length, 6, 'OCR chunk count'));
check('email sample chunks are non-empty', () => ok(smartChunk(SAMPLE_EMAIL).length >= 4, 'too few email chunks'));

console.log('\n▶ parsing');
check('parseConditionsJson tolerates markdown fences + trailing comma', () => {
  eq(parseConditionsJson('```json\n["a requirement", "b requirement",]\n```'), ['a requirement', 'b requirement']);
});
check('parseConditionsJson accepts object items', () => {
  eq(parseConditionsJson('[{"condition":"x"},{"text":"y"}]'), ['x', 'y']);
});
check('parseConditionsJson rejects prose with no array', () => {
  let threw = false;
  try { parseConditionsJson('no array here'); } catch { threw = true; }
  ok(threw, 'expected a throw');
});
check('parseStructuredConditions routes the clean JSON sample', () => {
  const list = parseStructuredConditions(SAMPLE_JSON);
  eq(list.length, 6, 'condition count');
});
check('parseStructuredConditions returns null for prose', () => eq(parseStructuredConditions(SAMPLE_OCR), null));
check('filterVagueFragments drops only the vague ones', () => {
  const { kept, dropped } = filterVagueFragments(['Provide the paystub.', 'No exceptions.', 'still pending']);
  eq(kept, ['Provide the paystub.']);
  eq(dropped, ['No exceptions.', 'still pending']);
});

console.log('\n▶ deterministic glossary expansion');
check('VOE / YTD / PMI / P1F expand', () => {
  const out = expandAcronyms('Provide a VOE and YTD figure; PMI premium; P1F premium');
  ok(out.includes('proof of employment (VOE)'), 'VOE');
  ok(out.includes('year-to-date (YTD)'), 'YTD');
  ok(out.includes('private mortgage insurance (PMI)'), 'PMI');
});
check('gift letter expansion does not duplicate words', () => {
  const out = expandAcronyms('provide the signed gift letter and 5-day seasoned trail');
  ok(!/signed signed/i.test(out), `duplicated adjective: ${out}`);
  ok(out.includes('bank statements proving the funds sat in the account'), 'seasoned trail');
});

console.log('\n▶ prompt contracts');
check('extract prompt carries the {{CHUNK}} payload slot', () => {
  ok(DEFAULT_EXTRACT_PROMPT.includes('{{CHUNK}}') && DEFAULT_EXTRACT_PROMPT.includes('<<<') && DEFAULT_EXTRACT_PROMPT.includes('>>>'),
    'missing slot or delimiters');
});
check('translate prompt carries {{CONDITION}} plus a worked example', () => {
  ok(DEFAULT_TRANSLATE_PROMPT.includes('{{CONDITION}}'), 'missing slot');
  ok(/Good answer:/.test(DEFAULT_TRANSLATE_PROMPT), 'missing worked example');
});

console.log('\n▶ engine registry');
check('all four engines are registered', () => {
  eq(Object.keys(ENGINES).sort(), ['nano', 'needle', 'transformers', 'webllm']);
  eq(new ENGINES.needle().name, 'needle');
});
check('NeedleEngine exposes a model label for telemetry', () => ok(/Needle 2/.test(new NeedleEngine().model)));

console.log('\n▶ Needle 2 adapter');
check('framing round-trips through the harness prompt template', () => {
  const prompt = DEFAULT_EXTRACT_PROMPT.replace('{{CHUNK}}', 'wait 30 days for escrow');
  eq(unwrapHarnessPrompt(prompt), 'wait 30 days for escrow');
});
check('extract framing carries the label that gets a call back', () => {
  ok(frameExtract('x').startsWith('Underwriting conditions'), 'missing label');
  ok(/one full requirement/i.test(frameExtract('x')), 'missing the measured quality hint');
});
check('groundConditions drops invented spans and keeps quoted ones', () => {
  const src = 'Provide a proof of employment (VOE) dated within 30 days of the note date.';
  const { kept, dropped } = groundConditions(['proof of employment (VOE)', 'P2M0NTR'], src);
  eq(kept, ['proof of employment (VOE)']);
  eq(dropped, ['P2M0NTR']);
});
check('mergeContiguousSpans rejoins fragments into the original text', () => {
  const src = 'g1ft funds 3O% fr0m 4unt: s1gned g1ft letter + 5 d4y se4s0ned tr41l';
  const merged = mergeContiguousSpans(
    ['g1ft funds', '3O% fr0m', '4unt:', 's1gned g1ft letter', '5 d4y se4s0ned tr41l'], src);
  eq(merged, [src]);
});
check('mergeContiguousSpans keeps widely separated requirements apart', () => {
  const src = `first requirement here${' '.repeat(60)}unrelated filler text second requirement here`;
  const merged = mergeContiguousSpans(['first requirement here', 'second requirement here'], src);
  eq(merged.length, 2, 'a 60-char gap should not be bridged');
});
check('translate prompt payload survives the pass-through unchanged', () => {
  const condition = 'Provide updated paystubs.';
  const prompt = DEFAULT_TRANSLATE_PROMPT.replace('{{CONDITION}}', condition).replace('{{CONTEXT}}', '');
  eq(unwrapHarnessPrompt(prompt), condition);
});

// The adapter behaviours that involve the contract are async: await them
// explicitly so a rejection counts as a failure instead of a floating promise.
for (const [name, fn] of [
  ['NeedleEngine is usable without WebGPU or Nano', async () => {
    const available = await new NeedleEngine().isAvailable();
    ok(available === true, 'isAvailable() must not depend on Nano or WebGPU');
    return 'WebAssembly + fetch only';
  }],
  ['Stage 2 is a documented pass-through (no model call needed)', async () => {
    const engine = new NeedleEngine();   // note: never init()ed — no weights loaded
    const prompt = DEFAULT_TRANSLATE_PROMPT.replace('{{CONDITION}}', 'Provide updated paystubs.').replace('{{CONTEXT}}', '');
    eq(await engine.prompt(prompt, { phase: 'TRANSLATE' }), 'Provide updated paystubs.');
    return 'returns the payload without touching the model';
  }],
]) {
  try {
    const detail = await fn();
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failed += 1;
    console.error(`  ❌ ${name} — ${err.message}`);
  }
}

console.log(`\n${failed === 0 ? '✅' : '❌'} ${failed === 0 ? 'all checks passed' : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
