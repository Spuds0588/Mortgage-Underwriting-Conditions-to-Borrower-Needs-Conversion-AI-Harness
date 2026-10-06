/**
 * WebLlmEngine.js — V2 STUB.
 *
 * Planned V2: in-browser LLM inference via WebLLM (WebGPU).
 * See https://github.com/mlc-ai/web-llm
 *
 * Implements the BaseEngine contract but deliberately refuses to run in V1
 * so the UI can hot-swap engines later without harness changes.
 */
import { BaseEngine } from './BaseEngine.js';

export class WebLlmEngine extends BaseEngine {
  name = 'webllm';

  async isAvailable() {
    // V2 will probe navigator.gpu here. For V1, always false.
    return false;
  }

  async init(progressCallback) {
    void progressCallback;
    throw new Error('WebLLM engine is coming in V2. This adapter is a stub in V1.');
  }

  async prompt(text) {
    void text;
    throw new Error('WebLLM engine is coming in V2. This adapter is a stub in V1.');
  }

  destroy() {}
}
