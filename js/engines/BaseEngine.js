/**
 * BaseEngine.js — Interface contract for all inference engines.
 *
 * The harness (js/harness.js) depends ONLY on this contract, never on a
 * concrete engine. Every engine in /engines/ must implement:
 *
 *   async isAvailable()          -> boolean  (does this environment support the engine?)
 *   async init(progressCallback) -> void     (create session / download weights)
 *   async prompt(text)           -> string   (run inference, return raw text)
 *   destroy()                    -> void     (clean up memory / close sessions)
 *
 * Engines may also use the shared static capability probe below
 * (BaseEngine.probeWebGPU) so WebGPU detection stays consistent.
 *
 * Keep this file dependency-free: no imports, no DOM access.
 */
export class BaseEngine {
  /** Human-readable engine name for UI + telemetry. @type {string} */
  name = 'base';

  /** Construct the engine. Subclasses may accept no arguments. */
  constructor() {
    if (new.target === BaseEngine) {
      throw new TypeError('BaseEngine is an interface contract — extend it, do not instantiate it directly.');
    }
  }

  /**
   * Report whether this engine can run in the current environment.
   * MUST NOT throw; return false on any doubt.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return false;
  }

  /**
   * Initialize the engine (create a session, download weights, warm up).
   * @param {(msg: string) => void} [progressCallback] Optional progress reporter.
   * @returns {Promise<void>}
   */
  async init(progressCallback) {
    void progressCallback;
    throw new Error(`${this.name}: init() not implemented.`);
  }

  /**
   * Run one inference call and return the raw model output as a string.
   * @param {string} text The fully-built prompt text.
   * @returns {Promise<string>}
   */
  async prompt(text) {
    void text;
    throw new Error(`${this.name}: prompt() not implemented.`);
  }

  /**
   * Release all resources (sessions, caches). Safe to call repeatedly.
   * @returns {void}
   */
  destroy() {}

  /**
   * Tolerant WebGPU capability probe shared by engines and UI gating.
   * Any usable adapter counts — including software/CPU adapters — because
   * a working (slow) adapter still beats no WebGPU at all. Never throws.
   * @returns {Promise<boolean>}
   */
  static async probeWebGPU() {
    try {
      if (typeof navigator === 'undefined' || !navigator.gpu) return false;
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
      return !!adapter;
    } catch {
      return false;
    }
  }
}
