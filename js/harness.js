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

/* ── Default, user-tunable prompts (Advanced Settings) ──────────── */

export const DEFAULT_EXTRACT_PROMPT = [
  'Extract every loan underwriting condition from the text. A condition is a requirement the borrower must satisfy.',
  'Ignore greetings, signatures, headers and small talk.',
  'Output ONLY a JSON array of strings, one per condition. Output [] if there are none.',
  '',
  'TEXT:',
  '<<<',
  '{{CHUNK}}',
  '>>>',
].join('\n');

export const DEFAULT_TRANSLATE_PROMPT = [
  'Rewrite the following mortgage underwriting condition as ONE short, warm, plain-English sentence addressed directly to the borrower ("you").',
  'Focus on what the borrower must do or provide.',
  'Expand jargon and acronyms; keep numbers, dates and dollar amounts.',
  'Answer with only that single sentence — no markdown, no quotes, no commentary.',
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
  const src = String(text ?? '').replace(/\r\n?/g, '\n').trim();
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
   * @param {string} [cfg.translatePrompt] Template with {{CONDITION}}.
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
        engine: engineKey,
        totalMs: null,
        promptCount: 0,
        successCount: 0,
        errorCount: 0,
        chunkCount: 0,
      },
      chunks: [],
      items: [],
    };
    this.#report = report;

    emit('SYSTEM', 'START', 'pipeline', null, { engine: report.meta.engine });

    // ── Chunking (deterministic, no AI) ──
    const tChunk0 = performance.now();
    const chunks = smartChunk(text);
    report.meta.chunkCount = chunks.length;
    report.chunks = chunks.map((c) => ({ ...c }));
    emit('SYSTEM', 'SUCCESS', `chunking:${chunks.length}`, Math.round(performance.now() - tChunk0),
      { chunks: chunks.map((c) => c.id) });

    if (!chunks.length) {
      throw new Error('Nothing to process — the input text is empty.');
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
      // ── Stage 1: sequential extraction over chunks ──
      const conditions = [];
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
          const found = parseConditionsJson(raw).slice(0, maxConditions);
          conditions.push(...found.map((c, i) => ({ id: `cond_${conditions.length + i + 1}`, chunkId: chunk.id, condition: c })));
          report.chunks.find((c) => c.id === chunk.id).conditionsFound = found.length;
          emit('EXTRACT', 'SUCCESS', chunk.id, ms, { found: found.length });
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          const ms = Math.round(performance.now() - t0);
          report.meta.promptCount += 1;
          report.meta.errorCount += 1;
          emit('EXTRACT', 'ERROR', chunk.id, ms, { error: String(err.message || err) });
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
        const prompt = translatePrompt.replaceAll('{{CONDITION}}', cond.condition);
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
          report.meta.promptCount += 1;
          report.meta.errorCount += 1;
          report.items.push({
            id: cond.id, chunkId: cond.chunkId, condition: cond.condition,
            need: null, translateMs: ms, error: String(err.message || err),
          });
          emit('TRANSLATE', 'ERROR', cond.id, ms, { error: String(err.message || err) });
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
