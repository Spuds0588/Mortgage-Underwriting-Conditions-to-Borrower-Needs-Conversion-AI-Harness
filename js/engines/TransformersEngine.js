/**
 * TransformersEngine.js — real in-browser inference via Transformers.js.
 *
 * Runs Qwen2.5-0.5B-Instruct (4-bit ONNX) through ONNX Runtime Web,
 * preferring WebGPU and falling back to WASM. Weights are cached by the
 * browser after the first run. Implements the BaseEngine contract.
 */
import { BaseEngine } from './BaseEngine.js';

const MODEL_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';

const SYSTEM_MESSAGE =
  'You are a precise information-extraction and rewriting assistant. ' +
  'Follow the user\'s instructions exactly and output only what is requested.';

export class TransformersEngine extends BaseEngine {
  name = 'transformers';

  /** @type {string} Resolved device after init ('webgpu' | 'wasm'). */
  device = null;

  /** @type {object|null} Text-generation pipeline. */
  #pipe = null;

  async isAvailable() {
    // WASM fallback means this engine can run anywhere; WebGPU is a bonus.
    return true;
  }

  /**
   * Load the ONNX model (first call downloads ~350–500 MB; cached afterwards).
   * @param {(msg: string) => void} [progressCallback]
   */
  async init(progressCallback) {
    const say = (msg) => { if (typeof progressCallback === 'function') progressCallback(msg); };

    say('Loading Transformers.js runtime from CDN…');
    const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5');
    env.allowLocalModels = false;

    const progress = (p) => {
      if (p && p.status === 'progress' && p.file) {
        say(`${p.file}: ${Math.round(p.progress || 0)}%`);
      } else if (p && p.status === 'ready') {
        say('ONNX model ready.');
      }
    };

    // Prefer WebGPU; fall back to WASM on any failure.
    for (const device of ['webgpu', 'wasm']) {
      try {
        say(`Trying device: ${device}…`);
        this.#pipe = await pipeline('text-generation', MODEL_ID, {
          device,
          dtype: device === 'webgpu' ? 'q4f16' : 'q4',
          progress_callback: progress,
        });
        this.device = device;
        break;
      } catch (err) {
        say(`${device} failed (${String(err.message || err).slice(0, 80)}) — trying next device…`);
        this.#pipe = null;
      }
    }
    if (!this.#pipe) throw new Error('TransformersEngine: could not initialize on webgpu or wasm.');
    say(`Transformers.js ready on ${this.device}.`);
  }

  /**
   * Run one chat completion.
   * @param {string} text
   * @param {{signal?: AbortSignal, maxTokens?: number, temperature?: number}} [opts]
   * @returns {Promise<string>}
   */
  async prompt(text, opts = {}) {
    if (!this.#pipe) throw new Error('TransformersEngine: prompt() called before init().');
    if (opts.signal && opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const messages = [
      { role: 'system', content: SYSTEM_MESSAGE },
      { role: 'user', content: text },
    ];
    const out = await this.#pipe(messages, {
      max_new_tokens: opts.maxTokens ?? 400,
      do_sample: (opts.temperature ?? 0.3) > 0,
      temperature: opts.temperature ?? 0.3,
    });
    const turns = out?.[0]?.generated_text;
    if (Array.isArray(turns)) return turns.at(-1)?.content ?? '';
    return String(turns ?? '');
  }

  destroy() {
    try { this.#pipe?.dispose?.(); } catch { /* noop */ }
    this.#pipe = null;
  }
}
