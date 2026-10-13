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
 * INFERENCE RUNS IN A WEB WORKER (needleWorker.js). The vendored build exposes a
 * SYNCHRONOUS entry point, so calling it from the page blocked the main thread
 * for the length of every decode: nothing painted, timers did not fire, and the
 * results appeared all at once when the pipeline finished. That file carries the
 * before/after measurements.
 *
 * Implements the BaseEngine contract (see BaseEngine.js).
 */
import { BaseEngine } from './BaseEngine.js';
import { NEEDLE_EXTRACT_TOOL, frameExtract, unwrapHarnessPrompt } from './needleSchema.js';

const MODEL_URL = 'https://huggingface.co/Cactus-Compute/needle2/resolve/main/needle2.cact';
const MODEL_BYTES = 13737807;
const CACHE_NAME = 'needle2-weights-v1';
/** Longest edge: a chunk's conditions array; keep it from rambling. */
const EXTRACT_MAX_TOKENS = 256;

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

  /** @type {Worker|null} Runs the blocking wasm call off the main thread. */
  #worker = null;

  /** @type {Uint8Array|null} Retained weights, so a torn-down worker can be rebuilt. */
  #weights = null;

  /** @type {boolean} Worker booted with the runtime and the archive loaded. */
  #ready = false;

  /** @type {number} Correlates a request with its reply. */
  #seq = 0;

  /** @type {Map<number, {resolve: (v: object) => void, reject: (e: Error) => void}>} */
  #pending = new Map();

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

    if (this.#ready && this.#worker) return;   // already loaded (cached engine reuse)

    // Fetch once and retain: a Stop tears the worker down, and the next run
    // rebuilds it from this copy instead of re-downloading 13.7 MB.
    if (this.#weights) {
      say('weights: reusing the archive already in memory');
    } else {
      this.#weights = await fetchWeights(say, opts.signal);
    }
    await this.#boot(say, opts.signal);
    say('model: Needle 2 ready ✓ (extraction only — Stage 2 is a pass-through)');
  }

  /**
   * Boot the worker (if needed), instantiate the runtime inside it, and load
   * the archive into its heap.
   * @param {(msg: string) => void} say
   * @param {AbortSignal} [signal]
   */
  async #boot(say, signal) {
    if (this.#ready && this.#worker) return;
    if (!this.#weights) throw new Error('NeedleEngine: boot() called before the weights were fetched.');
    if (!this.#worker) this.#spawn();

    say('runtime: needle.js + needle.wasm loading in a worker…');
    await this.#request('init', {}, signal);
    say('model: loading 13.7 MB archive into the wasm heap…');
    // Transfer a copy rather than the original, so the retained archive
    // survives for a rebuild after Stop.
    const copy = this.#weights.slice();
    await this.#request('weights', { bytes: copy.buffer }, signal, [copy.buffer]);
    this.#ready = true;
  }

  /** Boot on demand — a Stop discards the worker, so the next run rebuilds it. */
  async #ensure(signal) {
    if (this.#ready && this.#worker) return;
    await this.#boot(() => {}, signal);
  }

  /** Create the inference worker and wire its message plumbing. */
  #spawn() {
    if (typeof Worker === 'undefined') {
      throw new Error('NeedleEngine: this environment has no Worker support.');
    }
    const worker = new Worker(new URL('./needleWorker.js', import.meta.url), { type: 'classic' });
    worker.onmessage = (event) => {
      const msg = event.data ?? {};
      const entry = this.#pending.get(msg.id);
      if (!entry) return;                       // reply to an abandoned request
      this.#pending.delete(msg.id);
      if (msg.type === 'error') entry.reject(new Error(`NeedleEngine: ${msg.message}`));
      else entry.resolve(msg);
    };
    worker.onerror = (event) => {
      const err = new Error(`NeedleEngine: worker failed — ${event?.message ?? 'unknown error'}`);
      for (const entry of this.#pending.values()) entry.reject(err);
      this.#killWorker();
    };
    this.#worker = worker;
  }

  /**
   * Post one request and await its reply.
   *
   * This round trip is the whole point of the worker: the reply arrives as a
   * message, i.e. in a later task, so the browser gets to paint between chunks
   * instead of being blocked by a synchronous call. It is also what makes Stop
   * immediate, since the abort discards the worker rather than waiting for the
   * current decode to finish.
   * @param {'init'|'weights'|'run'} type
   * @param {object} payload
   * @param {AbortSignal} [signal]
   * @param {Transferable[]} [transfer]
   * @returns {Promise<object>}
   */
  #request(type, payload, signal, transfer = []) {
    const worker = this.#worker;
    if (!worker) throw new Error('NeedleEngine: the worker is not running.');
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#pending.delete(id);
        this.#killWorker();   // a synchronous wasm call cannot be interrupted
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#pending.set(id, {
        resolve: (v) => { signal?.removeEventListener('abort', onAbort); resolve(v); },
        reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
      });
      worker.postMessage({ type, id, ...payload }, transfer);
    });
  }

  /** Tear the worker down. Safe to call repeatedly. */
  #killWorker() {
    const worker = this.#worker;
    this.#worker = null;
    this.#ready = false;
    this.#pending.clear();
    try { worker?.terminate(); } catch { /* already gone */ }
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

    await this.#ensure(opts.signal);

    const out = await this.#request('run', {
      query: frameExtract(payload),
      tools: JSON.stringify(NEEDLE_EXTRACT_TOOL),
      maxNewTokens: EXTRACT_MAX_TOKENS,
    }, opts.signal);
    if (opts.signal && opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    let raw = null;
    try { raw = JSON.parse(out.raw); } catch { /* refusal — the guards below cover it */ }
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
   * Release resources. The wasm build exposes no unload entry point, so the
   * heap goes away with the worker; the retained weights are dropped too.
   */
  destroy() {
    this.#killWorker();
    this.#weights = null;
  }
}
