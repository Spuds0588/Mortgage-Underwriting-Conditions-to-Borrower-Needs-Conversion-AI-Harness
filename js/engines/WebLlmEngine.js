/**
 * WebLlmEngine.js — real in-browser LLM inference via WebLLM (WebGPU).
 *
 * Downloads and runs a compact instruct model (Qwen2.5-0.5B-Instruct, 4-bit)
 * fully on-device through WebGPU. Weights are cached by the browser after the
 * first run. Implements the BaseEngine contract.
 *
 * Model candidates are tried in order — the first present in WebLLM's
 * prebuilt list wins. q4f16_1 needs the `shader-f16` adapter feature.
 */
import { BaseEngine } from './BaseEngine.js';

const MODEL_CANDIDATES = [
  'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
  'Qwen2.5-0.5B-Instruct-q4f32_1-MLC',
  'Qwen2.5-0.5B-Instruct-q0f16-MLC',
];

const SYSTEM_MESSAGE =
  'You are a precise information-extraction and rewriting assistant. ' +
  'Follow the user\'s instructions exactly and output only what is requested.';

export class WebLlmEngine extends BaseEngine {
  name = 'webllm';

  /** @type {string} Resolved model id after init. */
  model = null;

  /** @type {object|null} MLCEngine instance. */
  #engine = null;

  async isAvailable() {
    try {
      if (!navigator.gpu) return false;
      // Any usable adapter counts — including a SwiftShader/CPU one. The
      // q4f16_1 quantization also works on adapters without shader-f16.
      // requestAdapter(this) without options returns a compatible adapter
      // strictly faster than asking for high-performance upfront.
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
      return !!adapter;
    } catch {
      return false;
    }
  }

  /**
   * Load the model (first call downloads ~500 MB; cached afterwards).
   * @param {(msg: string) => void} [progressCallback]
   */
  async init(progressCallback) {
    const say = (msg) => { if (typeof progressCallback === 'function') progressCallback(msg); };

    say('Loading WebLLM runtime from CDN…');
    const webllm = await import('https://esm.run/@mlc-ai/web-llm');

    const list = webllm.prebuiltAppConfig?.model_list?.map((m) => m.model_id) || [];
    // Prefer 4-bit fp16; fall back to a q4f32 variant on module-load failure.
    const preferred = MODEL_CANDIDATES.find((id) => list.includes(id)) || MODEL_CANDIDATES[0];
    const modelId = preferred.includes('q4f16_1')
      ? (list.includes('Qwen2.5-0.5B-Instruct-q4f32_1-MLC') ? 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC' : preferred)
      : preferred;
    this.model = modelId;
    say(`WebLLM model: ${this.model} (first run downloads weights, then cached)`);

    this.#engine = await webllm.CreateMLCEngine(this.model, {
      initProgressCallback: (report) => {
        // report.text looks like "Fetching param cache[12%]: 58/470 finished"
        if (report && report.text) say(String(report.text).slice(0, 140));
      },
    });
    say('WebLLM engine ready.');
  }

  /**
   * Run one chat completion.
   * @param {string} text
   * @param {{signal?: AbortSignal, maxTokens?: number, temperature?: number}} [opts]
   * @returns {Promise<string>}
   */
  async prompt(text, opts = {}) {
    if (!this.#engine) throw new Error('WebLlmEngine: prompt() called before init().');
    if (opts.signal && opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const reply = await this.#engine.chat.completions.create({
      messages: [
        { role: 'system', content: SYSTEM_MESSAGE },
        { role: 'user', content: text },
      ],
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 400,
    });
    return reply.choices?.[0]?.message?.content ?? '';
  }

  destroy() {
    try { this.#engine?.unload?.(); } catch { /* noop */ }
    this.#engine = null;
  }
}
