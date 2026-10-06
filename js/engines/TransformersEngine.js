/**
 * TransformersEngine.js — V2 STUB.
 *
 * Planned V2: in-browser inference via Transformers.js (ONNX Runtime Web).
 * See https://github.com/huggingface/transformers.js
 *
 * Implements the BaseEngine contract but deliberately refuses to run in V1
 * so the UI can hot-swap engines later without harness changes.
 */
import { BaseEngine } from './BaseEngine.js';

export class TransformersEngine extends BaseEngine {
  name = 'transformers';

  async isAvailable() {
    // V2 will check for WASM/WebGPU support here. For V1, always false.
    return false;
  }

  async init(progressCallback) {
    void progressCallback;
    throw new Error('Transformers.js engine is coming in V2. This adapter is a stub in V1.');
  }

  async prompt(text) {
    void text;
    throw new Error('Transformers.js engine is coming in V2. This adapter is a stub in V1.');
  }

  destroy() {}
}
