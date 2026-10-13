/**
 * NeedleEngine.js — EXPERIMENTAL example engine backed by Cactus Compute's
 * Needle 2 (45M parameters, ~14 MB, Apache-2.0), running in WebAssembly.
 *
 * What this engine is, and is not (measured — see docs/needle2-evaluation.md):
 *   ✅ Stage 1 extraction is real: a 13.7 MB schema-constrained model returns
 *      guaranteed-valid JSON in ~0.5–4.5 s per chunk on CPU, with no
 *      WebGPU and no 500 MB download.
 *   ❌ Stage 2 is impossible for it, and fails two different ways. Needle 2 is
 *      a tool-caller, not a generator. Asked for prose it either refuses ("[]")
 *      or answers with a copy of the input; asked instead to fill narrow slots
 *      for a deterministic sentence template, it invents values that appear
 *      nowhere in the input (a fabricated deadline "2025-03-21", kebab-case
 *      document ids). The contract's "omit rather than guess" holds only for
 *      fields it can answer by copying — which is why Stage 1, made of
 *      contiguous source spans, works and Stage 2 does not.
 *      So Stage 2 here is a documented PASS-THROUGH: the requirement is handed
 *      back with the harness's deterministic acronym expansion applied, and the
 *      UI says so. See docs/needle2-evaluation.md §3 and §4.
 *
 * Runtime files (needle.js + needle.wasm) are vendored in js/vendor/needle/;
 * the weights (needle2.cact) are fetched once from the Hugging Face CDN and
 * cached in Cache Storage, because 13.7 MB of binary does not belong in git.
 *
 * Implements the BaseEngine contract (see BaseEngine.js).
 */
import { BaseEngine } from './BaseEngine.js';
import { NEEDLE_EXTRACT_TOOL, frameExtract, unwrapHarnessPrompt } from './needleSchema.js';

const RUNTIME_URL = new URL('../vendor/needle/needle.js', import.meta.url).href;
const MODEL_URL = 'https://huggingface.co/Cactus-Compute/needle2/resolve/main/needle2.cact';
const MODEL_BYTES = 13737807;
const CACHE_NAME = 'needle2-weights-v1';
const OUT_CAPACITY = 64 * 1024;      // one call's JSON is well under 64 KB
const EXTRACT_MAX_TOKENS = 256;
/** Longest edge: a chunk's conditions array; keep it from rambling. */
const LOAD_TIMEOUT_MS = 120000;

/** Injection: load the vendored UMD runtime as a classic script once. */
function loadRuntime(signal) {
  if (typeof window === 'undefined') return Promise.reject(new Error('NeedleEngine: no window.'));
  if (typeof window.createNeedle === 'function') return Promise.resolve(window.createNeedle);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = RUNTIME_URL;
    script.async = true;
    const timer = setTimeout(() => reject(new Error('NeedleEngine: needle.js load timed out.')), LOAD_TIMEOUT_MS);
    const onAbort = () => { clearTimeout(timer); script.remove(); reject(new DOMException('Aborted', 'AbortError')); };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    script.onload = () => {
      clearTimeout(timer);
      typeof window.createNeedle === 'function'
        ? resolve(window.createNeedle)
        : reject(new Error('NeedleEngine: needle.js loaded but exposed no factory.'));
    };
    script.onerror = () => { clearTimeout(timer); reject(new Error('NeedleEngine: failed to load needle.js.')); };
    document.head.appendChild(script);
  });
}

/**
 * Fetch the weights, preferring the Cache Storage copy so repeat runs are
 * instant and offline-capable. Reports coarse progress to the caller.
 * @returns {Promise<Uint8Array>}
 */
async function fetchWeights(onProgress, signal) {
  let cache = null;
  try { if (typeof caches !== 'undefined') cache = await caches.open(CACHE_NAME); } catch { /* private mode */ }

  if (cache) {
    try {
      const hit = await cache.match(MODEL_URL);
      if (hit) {
        onProgress('weights: cached by this browser — loading locally');
        return new Uint8Array(await hit.arrayBuffer());
      }
    } catch { /* fall through to the network */ }
  }

  onProgress('weights: downloading 13.7 MB from the Cactus/HF CDN…');
  const res = await fetch(MODEL_URL, { signal });
  if (!res.ok) throw new Error(`NeedleEngine: weights download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || MODEL_BYTES;

  let bytes;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const parts = [];
    let received = 0;
    let lastPct = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.length;
      const pct = Math.round((received / total) * 100);
      if (pct !== lastPct && pct % 10 === 0) {
        lastPct = pct;
        onProgress(`weights: ${pct}% (${(received / 1048576).toFixed(1)} MB)`);
      }
    }
    bytes = new Uint8Array(received);
    let off = 0;
    for (const part of parts) { bytes.set(part, off); off += part.length; }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }

  if (bytes.length !== MODEL_BYTES) {
    throw new Error(`NeedleEngine: weights are ${bytes.length} bytes, expected ${MODEL_BYTES}.`);
  }
  if (cache) {
    try {
      await cache.put(MODEL_URL, new Response(bytes, {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
      }));
    } catch { /* quota — the page still works, just without the cache */ }
  }
  return bytes;
}

/**
 * Keep only the model's spans that really occur in the source text. Needle 2
 * answers with quoted spans, but it also occasionally invents one (measured:
 * "P2M0NTR" from an OCR chunk); grounding them deterministically is cheaper
 * and more reliable than asking the model to be careful.
 * @param {string[]} items
 * @param {string} source
 * @returns {{kept: string[], dropped: string[]}}
 */
export function groundConditions(items, source) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9$%.]+/g, ' ').trim();
  const hay = norm(source);
  const kept = [];
  const dropped = [];
  for (const raw of items) {
    const item = String(raw ?? '').trim();
    if (!item) continue;
    const needle = norm(item);
    // Whole span, or (for spans the model lightly trimmed) a long prefix of it.
    const prefix = needle.slice(0, Math.max(24, Math.floor(needle.length * 0.6)));
    (hay.includes(needle) || (prefix.length >= 24 && hay.includes(prefix)) ? kept : dropped).push(item);
  }
  return { kept, dropped };
}

/**
 * Re-join model spans that sit next to each other in the source.
 *
 * Needle 2 returns ORDERED, VERBATIM spans, and it splits a requirement at
 * every comma: extraction of "gift funds 30% from aunt: signed gift letter…"
 * comes back as ["g1ft funds", "fr0m", "4unt:", "s1gned g1ft", "letter"].
 * Because the spans are ordered and quoted, adjacent ones can be stitched
 * back together — and the ORIGINAL source slice is returned rather than the
 * concatenated fragments, so punctuation and wording stay intact.
 * @param {string[]} items
 * @param {string} source
 * @param {number} [maxGap] largest non-quoted gap to bridge (", " / " & " / labels)
 * @returns {string[]}
 */
export function mergeContiguousSpans(items, source, maxGap = 48) {
  const hay = String(source).toLowerCase();
  const pieces = [];
  for (const raw of items) {
    const needle = String(raw ?? '').trim().toLowerCase();
    if (!needle) continue;
    const from = pieces.length ? pieces[pieces.length - 1].end : 0;
    const at = hay.indexOf(needle, from);
    if (at === -1) continue;                       // never drop silently: ungrounded spans are already filtered
    pieces.push({ start: at, end: at + needle.length });
  }
  if (!pieces.length) return [];
  const merged = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && piece.start - last.end <= maxGap) { last.end = piece.end; continue; }
    merged.push({ ...piece });
  }
  return merged
    .map((m) => String(source).slice(m.start, m.end).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export class NeedleEngine extends BaseEngine {
  name = 'needle';

  /** Telemetry label shown in the UI/report. */
  model = 'Cactus Needle 2 (45M, CQ2) — wasm';

  /** @type {object|null} Emscripten module (holds the wasm heap + exports). */
  #module = null;

  /** @type {(() => void)|null} */ #initFn = null;
  /** @type {((input: string, max: number, out: number, cap: number) => number)|null} */ #completeFn = null;
  /** @type {number} */ #outPtr = 0;

  async isAvailable() {
    // Pure WebAssembly — no WebGPU, no special browser features. The only
    // requirement is the ability to fetch the weights.
    return typeof WebAssembly !== 'undefined' && typeof fetch === 'function';
  }

  async init(progressCallback, opts = {}) {
    const say = (msg) => {
      if (opts.signal && opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (typeof progressCallback === 'function') progressCallback(msg);
    };

    if (this.#module) return;   // already loaded (cached engine reuse)

    const createNeedle = await loadRuntime(opts.signal);
    say('runtime: needle.js ready (wasm engine)');
    const Module = await createNeedle({});
    say('runtime: needle.wasm instantiated');
    const bytes = await fetchWeights(say, opts.signal);

    say('model: loading 13.7 MB archive into the wasm heap…');
    const ptr = Module._malloc(bytes.length);
    Module.HEAPU8.set(bytes, ptr);
    // needle_load takes (const unsigned char*, unsigned long long) → BigInt.
    const rc = Module._needle_load(ptr, BigInt(bytes.length));
    Module._free(ptr);
    if (rc < 0) throw new Error(`NeedleEngine: needle_load failed (${rc}).`);

    this.#module = Module;
    this.#initFn = Module.cwrap('needle_init', 'number', ['string', 'string', 'string']);
    this.#completeFn = Module.cwrap('needle_complete', 'number', ['string', 'number', 'number', 'number']);
    this.#outPtr = Module._malloc(OUT_CAPACITY);
    say('model: Needle 2 ready ✓ (extraction only — Stage 2 is a pass-through)');
  }

  /**
   * Run one call.
   * @param {string} text Fully-built harness prompt (payload inside <<< >>>).
   * @param {{signal?: AbortSignal, phase?: 'EXTRACT'|'TRANSLATE'}} [opts]
   * @returns {Promise<string>}
   */
  async prompt(text, opts = {}) {
    if (opts.signal && opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const payload = unwrapHarnessPrompt(text);

    // Stage 2 is a documented pass-through: Needle 2 cannot generate new
    // wording (it copies or refuses), so spending 1–2 s per condition to get
    // the input back would be dishonest telemetry. No model call happens
    // here, which is why this branch sits before the init() guard.
    if (opts.phase === 'TRANSLATE') return payload;

    if (!this.#module) throw new Error('NeedleEngine: prompt() called before init().');

    const out = this.#run(frameExtract(payload), NEEDLE_EXTRACT_TOOL, EXTRACT_MAX_TOKENS);
    if (opts.signal && opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const raw = out.json;
    const calls = raw && Array.isArray(raw.function_calls) ? raw.function_calls : [];
    const conditions = calls.length ? (calls[0].arguments?.conditions ?? []) : [];

    // Ground first (the model invents the occasional span), then stitch the
    // ordered spans back into whole requirements.
    const { kept } = groundConditions(Array.isArray(conditions) ? conditions : [], payload);
    const whole = mergeContiguousSpans(kept, payload);

    // The harness's parser expects a JSON array of condition strings. Two
    // guards keep this lossless: a refusal ("[]" — common on run-on garbled
    // prose), and a merge that covers too little of the chunk (measured: the
    // OCR title chunk lost its whole vesting clause). Both fall back to the
    // chunk itself — smartChunk() already yields requirement-sized chunks.
    const covered = whole.join(' ').length;
    const keptWhole = whole.length && covered >= 0.6 * payload.length ? whole : [payload];
    return JSON.stringify(keptWhole);
  }

  /**
   * One grammar-constrained completion.
   * @returns {{json: object|null, raw: string, ms: number, generated: number}}
   */
  #run(query, tools, maxNewTokens) {
    const Module = this.#module;
    Module._needle_reset();
    // needle_init returns cached prefix tokens; negative means failure.
    const rc = this.#initFn(null, JSON.stringify(tools), null);
    if (rc < 0) throw new Error(`NeedleEngine: needle_init failed (${rc}).`);
    const t0 = performance.now();
    const generated = this.#completeFn(query, maxNewTokens, this.#outPtr, OUT_CAPACITY);
    const ms = Math.round(performance.now() - t0);
    const out = Module.UTF8ToString(this.#outPtr);
    let json = null;
    try { json = JSON.parse(out); } catch { /* leave raw for the caller */ }
    return { json, raw: out, ms, generated };
  }

  /**
   * Release references. The wasm build exposes no unload entry point, so the
   * heap is reclaimed with the page/worker rather than eagerly here.
   */
  destroy() {
    this.#initFn = null;
    this.#completeFn = null;
    this.#module = null;
    this.#outPtr = 0;
  }
}
