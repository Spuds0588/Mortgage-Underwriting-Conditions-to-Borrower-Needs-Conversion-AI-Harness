/**
 * TransformersEngine.js — real in-browser inference via Transformers.js.
 *
 * Runs Qwen2.5-0.5B-Instruct (quantized ONNX) through ONNX Runtime Web,
 * preferring WebGPU when an adapter actually exists and falling back to
 * WASM otherwise. Weights are downloaded once (via the UI's ⤓ Download
 * model button) and cached by the browser. Implements the BaseEngine
 * contract.
 */
import { BaseEngine } from './BaseEngine.js';

const MODEL_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5';

const SYSTEM_MESSAGE =
  'You are a precise information-extraction and rewriting assistant. ' +
  'Follow the user\'s instructions exactly and output only what is requested.';

/** Approximate per-dtype weight sizes (MB) — measured on HF, Oct 2026. */
const DTYPE_SIZE_MB = { q4f16: 483, q4: 786, q8: 512, int8: 512, fp32: 1994 };

/**
 * Reject as soon as `signal` aborts, even while the underlying download
 * keeps running in the background (Transformers.js has no cancel API —
 * the leftover fetch is harmless and lands in the browser cache).
 */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

export class TransformersEngine extends BaseEngine {
  name = 'transformers';

  /** @type {string} Resolved device after init ('webgpu' | 'wasm'). */
  device = null;

  /** @type {string} Resolved quantization after init ('q4' | 'q8' | …). */
  dtype = null;

  /** @type {string|null} Full model label after init. */
  model = null;

  /** @type {object|null} Text-generation pipeline. */
  #pipe = null;

  /** @type {object|null} The transformers.js module (for TextStreamer + stopping criteria). */
  #mod = null;

  async isAvailable() {
    // WASM fallback means this engine can run anywhere; WebGPU is a bonus.
    return true;
  }

  /**
   * Load the ONNX model. First call downloads 480–790 MB (cached after);
   * the UI routes this through its dedicated ⤓ Download step.
   * @param {(msg: string) => void} [progressCallback]
   * @param {{signal?: AbortSignal}} [opts]
   */
  async init(progressCallback, opts = {}) {
    const say = (msg) => {
      if (opts.signal && opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (typeof progressCallback === 'function') progressCallback(msg);
    };

    say('Loading Transformers.js runtime from CDN…');
    this.#mod = await import(TRANSFORMERS_CDN);
    const { pipeline, env } = this.#mod;
    env.allowLocalModels = false;

    // GitHub Pages (and most static hosts) send no COOP/COEP headers, so
    // crossOriginIsolated is false and SharedArrayBuffer is unavailable.
    // ONNX Runtime's multi-threaded WASM backend requires SAB and throws
    // deep inside ort-wasm otherwise — pin WASM to a single thread unless
    // the page really is cross-origin isolated.
    const isolated = typeof self !== 'undefined' && self.crossOriginIsolated === true;
    try {
      env.backends.onnx.wasm.numThreads = isolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    } catch { /* env shape changed in a future lib version — defaults apply */ }
    say(`ONNX Runtime WASM: numThreads=${isolated ? 'auto (page isolated)' : '1'} — page is ${isolated ? '' : 'NOT '}crossOriginIsolated.`);

    // Progress ticks fire for every parallel file. A per-file
    // "announce on change" rule floods the log when tokenizer + model
    // shards download simultaneously (each event alternates files), so
    // throttle per file on BOTH ≥5% steps and ≥750ms wall time.
    const progress = (() => {
      const last = new Map(); // file -> { pct, t }
      return (p) => {
        if (!p) return;
        if (p.status === 'progress' && p.file) {
          const pct = Math.round(p.progress || 0);
          const prev = last.get(p.file) ?? { pct: -100, t: 0 };
          const now = performance.now();
          if (pct - prev.pct >= 5 || pct >= 100 || now - prev.t >= 750) {
            last.set(p.file, { pct, t: now });
            say(`${p.file}: ${pct}%`);
          }
        } else if (p.status === 'ready') {
          say('ONNX model ready.');
        }
      };
    })();

    // Only attempt WebGPU when an adapter actually exists — a WebGPU-less
    // machine (e.g. Linux Chrome without a GPU backend) must not download
    // the 483 MB q4f16 weights first and then fail at session creation.
    const webgpuOk = await BaseEngine.probeWebGPU();
    /** @type {{device: string, dtypes: string[]}[]} */
    const plans = [];
    if (webgpuOk) {
      let shaderF16 = false;
      try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
        shaderF16 = !!(adapter && adapter.features && adapter.features.has('shader-f16'));
      } catch { /* probe failed — assume no shader-f16 */ }
      plans.push({ device: 'webgpu', dtypes: shaderF16 ? ['q4f16', 'q4'] : ['q4'] });
    } else {
      say('No WebGPU adapter — going straight to WASM (CPU inference, works everywhere).');
    }
    // WASM: q4 (MatMulNBits) is smallest-per-quality; q8 (model_quantized)
    // is the most battle-tested CPU quantization — try both before giving up.
    plans.push({ device: 'wasm', dtypes: ['q4', 'q8'] });

    /** @type {string[]} Real per-attempt failure reasons, surfaced on total failure. */
    const attempts = [];
    for (const plan of plans) {
      for (const dtype of plan.dtypes) {
        if (opts.signal && opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const size = DTYPE_SIZE_MB[dtype] ? ` (~${DTYPE_SIZE_MB[dtype]} MB first load)` : '';
        say(`Trying ${plan.device}/${dtype}${size}…`);
        // WASM sessions run inside a dedicated ORT worker (proxy) so each
        // forward pass never blocks the page's main thread. With
        // numThreads=1 the proxy worker needs no SharedArrayBuffer, so it
        // works without cross-origin isolation (canary-verified).
        try { env.backends.onnx.wasm.proxy = plan.device === 'wasm'; } catch { /* noop */ }
        try {
          this.#pipe = await raceAbort(
            pipeline('text-generation', MODEL_ID, {
              device: plan.device,
              dtype,
              progress_callback: progress,
            }),
            opts.signal,
          );
          this.device = plan.device;
          this.dtype = dtype;
          this.model = `${MODEL_ID} · ${plan.device}/${dtype}`;
          say(`Transformers.js ready on ${plan.device}/${dtype}.`);
          return;
        } catch (err) {
          this.#pipe = null;
          if (err && err.name === 'AbortError') throw err;
          const msg = String(err && err.message ? err.message : err);
          attempts.push(`${plan.device}/${dtype}: ${msg}`);
          say(`${plan.device}/${dtype} failed: ${msg.slice(0, 160)}`);
        }
      }
    }
    throw new Error(
      `TransformersEngine: could not initialize on any device/dtype. Attempts — ${attempts.join(' | ')}`,
    );
  }

  /**
   * Run one chat completion.
   * @param {string} text
   * @param {{signal?: AbortSignal, maxTokens?: number, temperature?: number,
   *          onToken?: (count: number) => void}} [opts]
   * @returns {Promise<string>}
   */
  async prompt(text, opts = {}) {
    if (!this.#pipe) throw new Error('TransformersEngine: prompt() called before init().');
    if (opts.signal && opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const signal = opts.signal ?? null;
    const onToken = typeof opts.onToken === 'function' ? opts.onToken : null;

    const messages = [
      { role: 'system', content: SYSTEM_MESSAGE },
      { role: 'user', content: text },
    ];

    // temperature <= 0 means greedy: the key must stay absent (the warper
    // throws on temperature <= 0 and is only built when do_sample is true).
    const temperature = opts.temperature ?? 0.3;
    const genOpts = { max_new_tokens: opts.maxTokens ?? 400 };
    if (temperature > 0) {
      genOpts.do_sample = true;
      genOpts.temperature = temperature;
    } else {
      genOpts.do_sample = false;
    }

    // Liveness + mid-flight cancellation: a 0.5B model on single-threaded
    // WASM generates only a few tokens per second on an older laptop, so
    // without a streamer the pipeline looks frozen for minutes and Stop
    // cannot cancel anything once generation has started. token_callback_
    // function fires once per generated token (skip_prompt keeps the
    // prefill silent); an InterruptableStoppingCriteria winds the loop
    // down gracefully when the caller's signal aborts. Semantics verified
    // against the transformers.js 3.7.5 source: a custom stopping_criteria
    // EXTENDS the default EOS/MaxLength criteria, so normal early-stopping
    // still works.
    if (onToken || signal) {
      const { TextStreamer, InterruptableStoppingCriteria } = this.#mod;
      const stopCriteria = InterruptableStoppingCriteria ? new InterruptableStoppingCriteria() : null;
      if (stopCriteria) genOpts.stopping_criteria = stopCriteria;
      let tokenCount = 0;
      genOpts.streamer = new TextStreamer(this.#pipe.tokenizer, {
        skip_prompt: true,
        callback_function: () => {}, // TextStreamer defaults this to console.log — silence it
        token_callback_function: (tokens) => {
          tokenCount += Array.isArray(tokens) ? tokens.length : 1;
          if (onToken) onToken(tokenCount);
          if (signal && signal.aborted) {
            if (stopCriteria) stopCriteria.interrupt();
            else throw new DOMException('Aborted', 'AbortError'); // lib changed — hard abort
          }
        },
      });
    }

    // raceAbort rejects the outer await the moment Stop fires (the pipeline
    // ends immediately) while the orphaned generate() winds down at its
    // next token callback via the stopping criteria — the session stays
    // healthy for the next run.
    const out = await raceAbort(this.#pipe(messages, genOpts), signal);
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const turns = out?.[0]?.generated_text;
    if (Array.isArray(turns)) return turns.at(-1)?.content ?? '';
    return String(turns ?? '');
  }

  destroy() {
    try { this.#pipe?.dispose?.(); } catch { /* noop */ }
    this.#pipe = null;
  }
}
