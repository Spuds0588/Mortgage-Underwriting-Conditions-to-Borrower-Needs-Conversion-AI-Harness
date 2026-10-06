/**
 * harness.js — Core pipeline logic.
 *
 * Orchestrates:
 *   1. smartChunk()          — regex cascade: Lists → Paragraphs → Sentences
 *   2. aiChunkedExtract()    — Stage 1: messy chunk text → JSON array of conditions
 *   3. translateQueue()      — Stage 2: condition → client-friendly need
 *   4. Telemetry             — per-item timings, prompt counts, success rates
 *
 * The harness depends only on the BaseEngine adapter contract, never directly
 * on window.ai. Inference is ALWAYS sequential (for...of, never Promise.all)
 * to keep hardware load sane on low-memory devices.
 */
import { NanoEngine } from './engines/NanoEngine.js';
import { WebLlmEngine } from './engines/WebLlmEngine.js';
import { TransformersEngine } from './engines/TransformersEngine.js';

/* ── Build identity ─────────────────────────────────────────────── */

/** Bumped with each behavior change so downloaded reports self-identify. */
export const HARNESS_VERSION = '1.4.0';

/* ── Default, user-tunable prompts (Advanced Settings) ──────────── */

export const DEFAULT_EXTRACT_PROMPT = [
  'Extract every loan underwriting condition from the text. A condition is a requirement the borrower must satisfy.',
  'Merge requirements that belong together into one condition; do not split them, and do not output duplicates.',
  'Include requirements stated indirectly ("she wants X redone", "we need Y") — not only imperatives.',
  'The text may contain OCR garble (4=a, 0=o, 1=i/l, 3=e, 8=B, £=l — e.g. P8I/PML = PMI, P1F = PIF, 2Ol9 = 2019); read through it and write the conditions in clean English.',
  'Ignore greetings, signatures, headers and small talk.',
  'Output ONLY a JSON array of strings, one per condition. Output [] if there are none.',
  '',
  'TEXT:',
  '<<<',
  '{{CHUNK}}',
  '>>>',
].join('\n');

export const DEFAULT_TRANSLATE_PROMPT = [
  'Rewrite the mortgage underwriting condition below as ONE short, warm, plain-English sentence addressed directly to the borrower ("you").',
  'State the ACTION or DOCUMENT the borrower must provide — never merely describe the situation.',
  'Keep numbers, dates and dollar amounts exactly as given. Never invent requirements, documents or amounts not present in the condition or context.',
  'Expand jargon and acronyms using this glossary:',
  '- VOE = Verification of Employment (proof of employment or income, NOT equity, NOT valuation).',
  '- PMI = Private Mortgage Insurance (NOT payment indemnity; PML or P8I are garbled forms of PMI).',
  '- YTD = year-to-date (income so far this year).',
  '- Gift letter = signed letter stating a down-payment gift does not need to be repaid.',
  '- Seasoned trail = bank statement proof that gift funds were on deposit for the stated number of days.',
  '- Rent schedule = document listing expected rental income from the property.',
  '- Escrow analysis = recalculation of the monthly tax and insurance escrow payment.',
  'Use the CONTEXT below to resolve what the condition refers to; rely on it whenever the condition alone is ambiguous.',
  'Answer with only that single sentence — no markdown, no quotes, no commentary.',
  '',
  'CONTEXT:',
  '<<<',
  '{{CONTEXT}}',
  '>>>',
  '',
  'CONDITION:',
  '<<<',
  '{{CONDITION}}',
  '>>>',
].join('\n');

/* ── Engine registry (hot-swappable via the adapter contract) ───── */

export const ENGINES = {
  nano: NanoEngine,
  webllm: WebLlmEngine,
  transformers: TransformersEngine,
};

/* ── Small utilities ────────────────────────────────────────────── */

function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ── Stage 0: smart chunking (Lists → Paragraphs → Sentences) ───── */

const LIST_ITEM_RE = /^\s*(?:\d{1,2}[.)\]]|[-*•▪◦])\s+/;
const EMAIL_HEADER_RE = /^\s*(?:subject|from|to|sent|cc|date)\s*:/i;

/**
 * Split raw input into model-sized chunks using the regex cascade:
 *   1. Lists (numbered/bulleted items — each item is a chunk, following
 *      indented lines attach to the item above).
 *   2. Paragraphs (blank-line separated blocks).
 *   3. Sentences (fallback for a single wall of prose).
 * Tiny fragments are merged forward; over-long chunks are re-split by sentence.
 * @param {string} text
 * @param {{minChars?: number, maxChars?: number}} [opts]
 * @returns {{id: string, text: string}[]}
 */
export function smartChunk(text, opts = {}) {
  const minChars = opts.minChars ?? 40;
  const maxChars = opts.maxChars ?? 1200;
  const raw0 = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!raw0) return [];

  // Email headers (Subject:/From:/Sent:/CC:) carry no conditions and only
  // pollute chunks — strip them deterministically before any cascade runs.
  const src = raw0.split('\n').filter((l) => !EMAIL_HEADER_RE.test(l)).join('\n').trim();
  if (!src) return [];

  const lines = src.split('\n');

  // Cascade 1 — Lists
  const listLineIdx = [];
  lines.forEach((ln, i) => { if (LIST_ITEM_RE.test(ln)) listLineIdx.push(i); });
  if (listLineIdx.length >= 2) {
    const raw = [];
    let buf = null;
    const flush = () => { if (buf !== null) { raw.push(buf); buf = null; } };
    for (let i = 0; i < lines.length; i++) {
      if (listLineIdx.includes(i)) { flush(); buf = lines[i].replace(LIST_ITEM_RE, '').trim(); }
      else if (buf !== null) { buf += ' ' + lines[i].trim(); }
    }
    flush();
    if (raw.length >= 2) return finalizeChunks(raw, minChars, maxChars);
  }

  // Cascade 2 — Paragraphs
  const paras = src.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paras.length >= 2) return finalizeChunks(paras, minChars, maxChars);

  // Cascade 3 — Sentences
  const sentences = splitSentences(src);
  return finalizeChunks(sentences.length ? sentences : [src], minChars, maxChars);
}

function finalizeChunks(rawList, minChars, maxChars) {
  // Expand over-long chunks by sentence so no chunk exceeds maxChars.
  const expanded = [];
  for (const raw of rawList) {
    const t = String(raw).trim();
    if (!t) continue;
    if (t.length <= maxChars) { expanded.push(t); continue; }
    let buf = '';
    for (const s of splitSentences(t)) {
      if (buf && (buf + ' ' + s).length > maxChars) { expanded.push(buf.trim()); buf = s; }
      else buf = buf ? buf + ' ' + s : s;
    }
    if (buf.trim()) expanded.push(buf.trim());
  }
  // Merge tiny fragments forward into the previous chunk.
  const merged = [];
  for (const t of expanded) {
    if (t.length < minChars && merged.length) merged[merged.length - 1] += ' ' + t;
    else merged.push(t);
  }
  return merged.map((text, i) => ({ id: `chunk_${i + 1}`, text }));
}

/* ── Robust parsing of model output ─────────────────────────────── */

/**
 * Parse the model's Stage-1 answer into an array of condition strings.
 * Tolerates markdown fences, leading prose and trailing commas.
 * @param {string} raw
 * @returns {string[]}
 */
export function parseConditionsJson(raw) {
  if (raw == null) throw new Error('Empty model output.');
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');

  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON array found in model output.');
  }
  const candidate = s.slice(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    parsed = JSON.parse(candidate.replace(/,\s*([\]}])/g, '$1')); // trailing-comma repair
  }
  if (!Array.isArray(parsed)) throw new Error('Model output was not a JSON array.');

  return parsed
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return item.condition ?? item.text ?? item.description ?? JSON.stringify(item);
      return String(item);
    })
    .map((s2) => s2.trim())
    .filter(Boolean);
}

/* ── Deterministic routing: structured JSON input ───────────────── */

/**
 * If the raw input is already structured JSON — an object with a `conditions`
 * array, or a bare top-level array — return its condition strings so the
 * harness can skip AI extraction entirely (PRD: deterministic vs unstructured
 * routing). Returns null for anything that is not parseable structured input.
 * @param {string} text
 * @returns {string[]|null}
 */
export function parseStructuredConditions(text) {
  const s = String(text ?? '').trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return null;
  let parsed;
  try { parsed = JSON.parse(s); } catch { return null; }
  const list = Array.isArray(parsed) ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray(parsed.conditions)
      ? parsed.conditions
      : null);
  if (!list) return null;
  const items = list
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        const c = item.condition ?? item.text ?? item.description ?? item.summary;
        return c == null ? null : String(c).trim();
      }
      return String(item).trim();
    })
    .filter(Boolean);
  return items.length ? items : null;
}

/* ── The Harness ────────────────────────────────────────────────── */

export class Harness {
  /** Master telemetry object for the current/last run. @type {object|null} */
  #report = null;

  get report() { return this.#report; }

  /**
   * Run the full pipeline. Emits standard event objects to progressCallback:
   *   { phase: 'SYSTEM'|'EXTRACT'|'TRANSLATE', status: 'START'|'SUCCESS'|'ERROR'|'INFO', id, ms, data }
   * @param {object} cfg
   * @param {string} cfg.text Raw user input.
   * @param {string} [cfg.engineKey] 'nano' | 'webllm' | 'transformers'
   * @param {string} [cfg.extractPrompt] Template with {{MAX}} and {{CHUNK}}.
   * @param {string} [cfg.translatePrompt] Template with {{CONDITION}} and {{CONTEXT}}.
   * @param {number} [cfg.maxConditions] Cap per chunk.
   * @param {(evt: object) => void} cfg.progressCallback
   * @param {AbortSignal} [cfg.signal]
   * @returns {Promise<object>} The telemetry report.
   */
  async process(cfg) {
    const {
      text,
      engineKey = 'nano',
      extractPrompt = DEFAULT_EXTRACT_PROMPT,
      translatePrompt = DEFAULT_TRANSLATE_PROMPT,
      maxConditions = 10,
      progressCallback,
      signal,
    } = cfg;

    const emit = (phase, status, id, ms = null, data = null) => {
      const evt = { phase, status, id, ms, data };
      if (typeof progressCallback === 'function') progressCallback(evt);
      const icon = status === 'START' ? '🚀' : status === 'SUCCESS' ? '✅' : status === 'ERROR' ? '❌' : 'ℹ️';
      console.log(`${icon} [${phase}/${status}] ${id}${ms != null ? ` (${ms}ms)` : ''}`);
      return evt;
    };

    const startedAt = new Date().toISOString();
    const report = {
      meta: {
        startedAt,
        finishedAt: null,
        version: HARNESS_VERSION,
        engine: engineKey,
        totalMs: null,
        promptCount: 0,
        successCount: 0,
        errorCount: 0,
        chunkCount: 0,
        errors: [],
      },
      chunks: [],
      items: [],
    };
    this.#report = report;

    emit('SYSTEM', 'START', 'pipeline', null, { engine: report.meta.engine });

    // ── Deterministic routing (PRD): structured JSON bypasses AI extraction ──
    const jsonConditions = parseStructuredConditions(text);
    report.meta.routing = jsonConditions ? 'json' : 'unstructured';

    // ── Chunking (deterministic, no AI) ──
    const tChunk0 = performance.now();
    let chunks = [];
    let conditions = [];
    if (jsonConditions) {
      conditions = jsonConditions.map((c, i) => ({ id: `cond_${i + 1}`, chunkId: null, condition: c }));
      emit('SYSTEM', 'INFO', 'routing:json', 0, { conditions: jsonConditions.length });
      emit('SYSTEM', 'SUCCESS', 'chunking:0', Math.round(performance.now() - tChunk0), { chunks: [] });
    } else {
      chunks = smartChunk(text);
      report.meta.chunkCount = chunks.length;
      report.chunks = chunks.map((c) => ({ ...c }));
      emit('SYSTEM', 'SUCCESS', `chunking:${chunks.length}`, Math.round(performance.now() - tChunk0),
        { chunks: chunks.map((c) => c.id) });

      if (!chunks.length) {
        throw new Error('Nothing to process — the input text is empty.');
      }
    }

    // ── Engine init ──
    const EngineCtor = ENGINES[engineKey];
    if (!EngineCtor) throw new Error(`Unknown engine key: ${engineKey}`);
    const engine = new EngineCtor();

    emit('SYSTEM', 'INFO', `engine:${engine.name}`);
    const tInit0 = performance.now();
    const available = await engine.isAvailable();
    if (!available) {
      throw new Error(
        `Engine "${engine.name}" is not available in this environment. ` +
        'For Gemini Nano: enable it via chrome://flags/#prompt-api-for-gemini-nano and chrome://components ' +
        '(Windows/macOS Chrome). For broad compatibility, select the WebLLM or Transformers.js engine.',
      );
    }
    await engine.init((msg) => emit('SYSTEM', 'INFO', `engine:${engine.name}`, null, { message: msg }));
    report.meta.initMs = Math.round(performance.now() - tInit0);
    report.meta.model = engine.model || engine.device || engine.name;

    const guardAbort = () => { if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError'); };

    try {
      // ── Stage 1: sequential extraction over chunks (skipped for JSON routing) ──
      for (const chunk of chunks) {           // SEQUENTIAL: never Promise.all
        guardAbort();
        emit('EXTRACT', 'START', chunk.id, null, { preview: chunk.text.slice(0, 80) });
        const prompt = extractPrompt
          .replaceAll('{{MAX}}', String(maxConditions))
          .replaceAll('{{CHUNK}}', chunk.text);
        const t0 = performance.now();
        try {
          const raw = await engine.prompt(prompt, { signal, temperature: 0.1 });
          const ms = Math.round(performance.now() - t0);
          report.meta.promptCount += 1;
          let found = parseConditionsJson(raw).slice(0, maxConditions);
          // One-shot retry: a garbled chunk sometimes yields [] on the first
          // pass; a second attempt with the same prompt recovers it.
          if (!found.length && chunk.text.length > 120 && !report.meta.errors.some((e) => e.id === chunk.id)) {
            emit('EXTRACT', 'INFO', chunk.id, ms, { retry: 'empty result — retrying once' });
            const t1 = performance.now();
            const raw2 = await engine.prompt(prompt, { signal, temperature: 0.1 });
            report.meta.promptCount += 1;
            found = parseConditionsJson(raw2).slice(0, maxConditions);
            report.chunks.find((c) => c.id === chunk.id).retry = true;
          }
          conditions.push(...found.map((c, i) => ({ id: `cond_${conditions.length + i + 1}`, chunkId: chunk.id, condition: c })));
          report.chunks.find((c) => c.id === chunk.id).conditionsFound = found.length;
          emit('EXTRACT', 'SUCCESS', chunk.id, ms, { found: found.length });
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          const ms = Math.round(performance.now() - t0);
          const msg = String(err.message || err);
          report.meta.promptCount += 1;
          report.meta.errorCount += 1;
          const entry = report.chunks.find((c) => c.id === chunk.id);
          if (entry) { entry.conditionsFound = 0; entry.error = msg; }
          report.meta.errors.push({ phase: 'EXTRACT', id: chunk.id, ms, error: msg });
          emit('EXTRACT', 'ERROR', chunk.id, ms, { error: msg });
        }
      }

      if (!conditions.length) {
        emit('SYSTEM', 'INFO', 'no-conditions');
        report.meta.finishedAt = new Date().toISOString();
        report.meta.totalMs = null;
        return report;
      }

      // ── Stage 2: sequential translation queue ──
      for (const cond of conditions) {        // SEQUENTIAL: never Promise.all
        guardAbort();
        emit('TRANSLATE', 'START', cond.id, null, { preview: cond.condition.slice(0, 80) });
        // Thread the source chunk through so the translator can resolve
        // pronouns and shorthand against the original wording.
        const srcChunk = cond.chunkId ? chunks.find((c) => c.id === cond.chunkId) : null;
        // Cap context so the translation prompt stays small enough for
        // on-device models to attend to the CONDITION itself.
        const ctx = srcChunk ? srcChunk.text.slice(0, 700) : '(no extra context — rely on the glossary)';
        const prompt = translatePrompt
          .replaceAll('{{CONTEXT}}', ctx)
          .replaceAll('{{CONDITION}}', cond.condition);
        const t0 = performance.now();
        try {
          const raw = await engine.prompt(prompt, { signal });
          const ms = Math.round(performance.now() - t0);
          report.meta.promptCount += 1;
          report.meta.successCount += 1;
          report.items.push({
            id: cond.id,
            chunkId: cond.chunkId,
            condition: cond.condition,
            need: String(raw).trim().replace(/^["“]|["”]$/g, ''),
            translateMs: ms,
          });
          emit('TRANSLATE', 'SUCCESS', cond.id, ms, { need: report.items[report.items.length - 1].need });
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          const ms = Math.round(performance.now() - t0);
          const msg = String(err.message || err);
          report.meta.promptCount += 1;
          report.meta.errorCount += 1;
          report.meta.errors.push({ phase: 'TRANSLATE', id: cond.id, ms, error: msg });
          report.items.push({
            id: cond.id, chunkId: cond.chunkId, condition: cond.condition,
            need: null, translateMs: ms, error: msg,
          });
          emit('TRANSLATE', 'ERROR', cond.id, ms, { error: msg });
        }
      }
    } finally {
      engine.destroy();
    }

    report.meta.finishedAt = new Date().toISOString();
    report.meta.totalMs = Date.parse(report.meta.finishedAt) - Date.parse(report.meta.startedAt);
    console.log(`⏱️ [TELEMETRY] run complete: ${report.meta.promptCount} prompts, ` +
      `${report.meta.successCount} ok, ${report.meta.errorCount} errors, ${report.meta.totalMs}ms total`);
    emit('SYSTEM', 'SUCCESS', 'pipeline', report.meta.totalMs);
    return report;
  }
}

// Singleton used by app.js.
export const harness = new Harness();
