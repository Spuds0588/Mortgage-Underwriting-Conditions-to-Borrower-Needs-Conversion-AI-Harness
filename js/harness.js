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
export const HARNESS_VERSION = '1.8.0';

/* ── Default, user-tunable prompts (Advanced Settings) ──────────── */

export const DEFAULT_EXTRACT_PROMPT = [
  'Extract every loan underwriting condition from the text. A condition is a requirement the borrower must satisfy.',
  'Merge requirements that belong together into one condition; do not split them, and do not output duplicates. Facts about the same matter are ONE condition (e.g. "Appraisal ordered 10/2, value $412,000, effective 90 days" — not three).',
  'Include requirements stated indirectly ("she wants X redone", "we need Y") — not only imperatives.',
  'Title/vesting language is a requirement on the document: "vesting must read X" means the title must show ownership exactly as X (names verbatim) — never turn it into a marriage-status question.',
  'Fold vague fragments ("No exceptions.", "still pending", "if it helps") into the specific requirement they modify — never output them as standalone conditions.',
  'For OCR-garbled amounts, keep the digit order exactly as written when de-garbling (e.g. $4l2,O00 = $412,000).',
  'The text may contain OCR garble (4=a, 0=o, 1=i/l, 3=e, 8=B, £=l — e.g. P8I/PML = PMI, P1F = PIF, 2Ol9 = 2019); read through it and write the conditions in clean English.',
  'Ignore greetings, signatures, headers and small talk.',
  'Output ONLY a JSON array of strings, one per condition. Output [] if there are none.',
  '',
  'TEXT:',
  '<<<',
  '{{CHUNK}}',
  '>>>',
].join('\n');

/**
 * Default Stage-2 rewrite instructions. Kept deliberately SHORT: every
 * prompt token is paid for in CPU prefill on every condition (measured
 * ~28s of pure prefill on a T480 before the first token even lands). The
 * detailed mortgage glossary moved to expandAcronyms(), which rewrites
 * known jargon deterministically before the model ever sees it — that
 * both shrinks the prompt and stopped the model from pasting unrelated
 * glossary entries into translations (observed failure on Qwen2.5-0.5B).
 */
export const DEFAULT_TRANSLATE_PROMPT = [
  'Rewrite the mortgage underwriting condition below as ONE short, warm, plain-English sentence addressed directly to the borrower ("you").',
  'State the ACTION or DOCUMENT the borrower must provide — never merely describe the situation.',
  'Keep all numbers, dates, dollar amounts and names exactly as given, in their original role. Never invent requirements, documents or amounts not present in the condition.',
  'Answer with only that single sentence — no markdown, no quotes, no commentary.',
  '',
  'CONDITION:',
  '<<<',
  '{{CONDITION}}',
  '>>>',
].join('\n');

/* ── Engine registry (hot-swappable via the adapter contract) ───── */
/* Engines that can run inside ANY modern browser download their weights
 * from public CDNs on first init and are cached by the browser; Nano is
 * preinstalled on supported Chrome builds. */

export const ENGINES = {
  nano: NanoEngine,
  webllm: WebLlmEngine,
  transformers: TransformersEngine,
};

/* ── Small utilities ────────────────────────────────────────────── */

/**
 * Max tokens for one Stage-2 translation: a single sentence. A tight cap
 * keeps CPU engines (0.5B on single-threaded WASM ≈ 1–5 tok/s on older
 * hardware) from sitting for minutes per condition, and greedy decoding
 * reaches EOS sooner while keeping output deterministic.
 */
const TRANSLATE_MAX_TOKENS = 120;

/**
 * Build an onToken callback that surfaces generation progress as INFO
 * events (throttled) so the UI can show a live token counter while a slow
 * CPU engine generates. Streaming engines call it per token; engines
 * without streaming support simply never invoke it.
 * @param {(phase: string, status: string, id: string, ms: number|null, data: object|null) => void} emit
 */
function makeTokenHeartbeat(emit, phase, id, t0, store = null) {
  let lastEmitted = 0;
  return (tokens) => {
    if (store) store.set(id, tokens);
    if (tokens - lastEmitted >= 8) {
      lastEmitted = tokens;
      emit(phase, 'INFO', id, Math.round(performance.now() - t0), { tokens });
    }
  };
}

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

/* ── Deterministic post-extraction filter ───────────────────────── */

const VAGUE_FRAGMENT_RE = /^(?:no\s+exceptions?\.?|still\s+pending\.?|if\s+it\s+helps\.?)$/i;

/**
 * Drop vague fragments that small models keep emitting as standalone
 * conditions despite fold instructions. Dropped items are recorded in the
 * report (chunk.dropped / meta.dropped), never silently lost.
 * @param {string[]} list
 * @returns {{kept: string[], dropped: string[]}}
 */
export function filterVagueFragments(list) {
  const kept = [];
  const dropped = [];
  for (const item of list) {
    const norm = String(item).trim().replace(/\s+/g, ' ');
    (VAGUE_FRAGMENT_RE.test(norm) ? dropped : kept).push(item);
  }
  return { kept, dropped };
}

/* ── Engine capability chain ────────────────────────────────────── */

/**
 * Capability chain per engine: if an engine cannot run here despite being
 * selectable (lightweight check), init falls back to the next engine that
 * CAN download-and-run anywhere — never to one with equal requirements.
 */
/* ── Deterministic acronym expansion ───────────────────────────── */

/**
 * Mortgage jargon the 0.5B models reliably mangle or hallucinate around.
 * Rewritten in plain English BEFORE translation: deterministic (no model
 * tokens spent), shrinks the prompt, and removes the glossary-following
 * burden that caused wrong-term hallucinations on Qwen2.5-0.5B.
 * Longest phrases first so multi-word matches win.
 * @type {[RegExp, string][]}
 */
const ACRONYM_EXPANSIONS = [
  [/\bseasoned?\s+trail\b/gi, 'bank statements proving the funds sat in the account for the stated number of days'],
  [/\bescrow analysis\b/gi, 'recalculated monthly tax and insurance escrow payment (escrow analysis)'],
  [/\brent schedule\b/gi, 'document listing expected rental income (rent schedule)'],
  [/\bgift letter\b/gi, 'signed letter stating the down-payment gift does not need to be repaid (gift letter)'],
  [/\bVOE\b/g, 'proof of employment (VOE)'],
  [/\bYTD\b/g, 'year-to-date (YTD)'],
  [/\bPMI\b/g, 'private mortgage insurance (PMI)'],
  [/\bP[18][FI]\b/g, 'private mortgage insurance (PMI)'],
  [/\bPML\b/g, 'private mortgage insurance (PMI)'],
];

/**
 * Expand known mortgage acronyms/garble in a condition string.
 * @param {string} text
 * @returns {string}
 */
export function expandAcronyms(text) {
  let out = String(text ?? '');
  for (const [re, replacement] of ACRONYM_EXPANSIONS) out = out.replace(re, replacement);
  return out;
}

const FALLBACKS = {
  nano: 'webllm',      // Next try: WebGPU backend.
  webllm: 'transformers', // Has a WASM backend that runs everywhere.
  // 'transformers' is terminal: it runs on WASM even without WebGPU.
};

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
   * @param {object} [cfg.engineInstance] Pre-initialized engine (from the UI's
   *        ⤓ Download step). Skips availability/init and is NEVER destroyed
   *        here — the caller owns the cached instance.
   * @param {boolean} [cfg.noFallback] Forbid the automatic engine fallback
   *        chain (used by the UI so Run never downloads models silently).
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
      engineInstance = null,
      noFallback = false,
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
      // Surface the human-readable payload (engine init chatter, item
      // errors) in the console too — bare event ids made engine-init
      // progress look like an unexplained flood.
      const detail = data && data.message != null ? ` — ${data.message}`
        : data && data.error != null ? ` — ${data.error}`
        : data && data.tokens != null ? ` — ${data.tokens} tokens` : '';
      console.log(`${icon} [${phase}/${status}] ${id}${ms != null ? ` (${ms}ms)` : ''}${detail}`);
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
        dropped: 0,
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
    // Two paths:
    //   a) cfg.engineInstance — a pre-initialized engine handed over by the
    //      UI's ⤓ Download step. Skip availability/init entirely and never
    //      destroy it (the caller owns the cached instance and reuses it
    //      across runs).
    //   b) engineKey — construct fresh, availability-check, init (with the
    //      fallback chain unless cfg.noFallback forbids it).
    let engine = engineInstance ?? null;
    const callerOwned = engine != null;
    const tInit0 = performance.now();

    if (callerOwned) {
      report.meta.preloaded = true;
      report.meta.engine = engine.name;
      emit('SYSTEM', 'INFO', `engine:${engine.name}`, null,
        { message: 'reusing the model loaded by the ⤓ Download step — init skipped' });
    } else {
      const EngineCtor = ENGINES[engineKey];
      if (!EngineCtor) throw new Error(`Unknown engine key: ${engineKey}`);
      engine = new EngineCtor();

      emit('SYSTEM', 'INFO', `engine:${engine.name}`);
      const sayInit = (msg) => emit('SYSTEM', 'INFO', `engine:${engine.name}`, null, { message: msg });

      try {
        if (!await engine.isAvailable()) {
          throw new Error(`Engine "${engine.name}" is not supported in this environment (no compatible backend found).`);
        }
        await engine.init(sayInit, { signal });
      } catch (err) {
        // User aborted mid-init (Stop during a model download): re-throw so
        // the pipeline ends immediately, with no fallback attempt.
        if (signal && signal.aborted) throw err;
        if (noFallback || !FALLBACKS[engineKey]) {
          throw new Error(
            `Engine "${engine.name}" is not available in this environment. ` +
            (engineKey === 'nano'
              ? 'For Gemini Nano: enable it via chrome://flags/#prompt-api-for-gemini-nano and chrome://components (Windows/macOS Chrome). Otherwise select the Transformers.js engine and click ⤓ Download model.'
              : 'Download its model with the ⤓ Download model button first, or select another engine.'),
          );
        }
        const next = FALLBACKS[engineKey];
        sayInit(`${engine.name} unavailable (${String(err.message || err).slice(0, 120)}) — falling back to ${next}…`);
        emit('SYSTEM', 'INFO', `fallback:${engineKey}_to_${next}`);
        const FallbackCtor = ENGINES[next];
        engine = new FallbackCtor();
        report.meta.modelFallback = engineKey;
        report.meta.engine = engine.name;
        await engine.init(sayInit, { signal });
      }
    }
    report.meta.initMs = Math.round(performance.now() - tInit0);
    report.meta.model = engine.model || engine.device || engine.name;

    const guardAbort = () => { if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError'); };
    const tokenCounts = new Map(); // item id -> tokens generated (via onToken heartbeats)
    const lastTokenCount = (id) => tokenCounts.get(id) ?? 0;

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
          const raw = await engine.prompt(prompt, {
            signal,
            temperature: 0.1,
            onToken: makeTokenHeartbeat(emit, 'EXTRACT', chunk.id, t0, tokenCounts),
          });
          const ms = Math.round(performance.now() - t0);
          report.meta.promptCount += 1;
          let found = parseConditionsJson(raw).slice(0, maxConditions);
          // One-shot retry: a garbled chunk sometimes yields [] on the first
          // pass; a second attempt with the same prompt recovers it.
          if (!found.length && chunk.text.length > 120 && !report.meta.errors.some((e) => e.id === chunk.id)) {
            emit('EXTRACT', 'INFO', chunk.id, ms, { retry: 'empty result — retrying once' });
            const t1 = performance.now();
            const raw2 = await engine.prompt(prompt, {
              signal,
              temperature: 0.1,
              onToken: makeTokenHeartbeat(emit, 'EXTRACT', chunk.id, t1, tokenCounts),
            });
            report.meta.promptCount += 1;
            found = parseConditionsJson(raw2).slice(0, maxConditions);
            report.chunks.find((c) => c.id === chunk.id).retry = true;
          }
          // Deterministic post-filter: vague fragments Nano keeps emitting.
          const filtered = filterVagueFragments(found);
          found = filtered.kept;
          if (filtered.dropped.length) {
            const entry = report.chunks.find((c) => c.id === chunk.id);
            if (entry) entry.dropped = filtered.dropped;
            report.meta.dropped = (report.meta.dropped ?? 0) + filtered.dropped.length;
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
        // Deterministic acronym expansion before the model sees the text:
        // cheaper than prompt tokens and immune to 0.5B glossary
        // hallucinations (observed: unrelated terms pasted into needs).
        cond.condition = expandAcronyms(cond.condition);
        const prompt = translatePrompt
          .replaceAll('{{CONTEXT}}', '')
          .replaceAll('{{CONDITION}}', cond.condition);
        const t0 = performance.now();
        try {
          // Greedy + tight token cap + per-token heartbeat: a translation
          // is ONE sentence, so a CPU engine should finish in well under a
          // minute instead of minutes of silent generation (v1.7 fix for
          // the "appears to hang" reports).
          const raw = await engine.prompt(prompt, {
            signal,
            temperature: 0,
            maxTokens: TRANSLATE_MAX_TOKENS,
            onToken: makeTokenHeartbeat(emit, 'TRANSLATE', cond.id, t0, tokenCounts),
          });
          const ms = Math.round(performance.now() - t0);
          report.meta.promptCount += 1;
          report.meta.successCount += 1;
          const need = String(raw).trim().replace(/^["“]|["”]$/g, '');
          const tok = lastTokenCount(cond.id);
          report.items.push({
            id: cond.id,
            chunkId: cond.chunkId,
            condition: cond.condition,
            need,
            translateMs: ms,
            tokens: tok,
            tokPerSec: tok ? +(tok / (ms / 1000)).toFixed(2) : null,
          });
          emit('TRANSLATE', 'SUCCESS', cond.id, ms, { need, tokens: tok });
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
      // Caller-owned (cached) engines are reused across runs — never destroy.
      if (!callerOwned) engine.destroy();
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
