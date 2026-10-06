/**
 * NanoEngine.js — V1 implementation backed by Chrome's built-in Gemini Nano.
 *
 * Targets the modern Prompt API surface (`window.LanguageModel`, the
 * `languageModel` namespace) with fallbacks to the older experimental
 * `window.ai.languageModel` shape so the engine works across Chrome versions.
 *
 * Implements the BaseEngine contract (see BaseEngine.js).
 */
import { BaseEngine } from './BaseEngine.js';

/** Resolve the Prompt API namespace across Chrome versions. @returns {object|null} */
function resolveApi() {
  if (typeof window === 'undefined') return null;
  if (typeof window.LanguageModel !== 'undefined') return window.LanguageModel;
  if (window.ai && typeof window.ai.languageModel !== 'undefined') return window.ai.languageModel;
  return null;
}

export class NanoEngine extends BaseEngine {
  name = 'nano';

  /** @type {object|null} GenericLanguageModel session. */
  #session = null;

  /** @type {AbortController|null} Aborts the in-flight prompt() call. */
  #abort = null;

  async isAvailable() {
    const api = resolveApi();
    if (!api || typeof api.availability !== 'function') return false;
    try {
      const verdict = await api.availability();
      // Newer API returns 'unavailable' | 'downloadable' | 'downloading' | 'available'.
      // Older API returned a boolean (true === usable).
      return verdict === true || (typeof verdict === 'string' && verdict !== 'unavailable');
    } catch {
      return false;
    }
  }

  /**
   * Create the Nano session. If the model is downloadable-but-absent,
   * attempt a user-gesture-gated download and wait for completion.
   * @param {(msg: string) => void} [progressCallback]
   */
  async init(progressCallback) {
    const say = (msg) => { if (typeof progressCallback === 'function') progressCallback(msg); };

    const api = resolveApi();
    if (!api) throw new Error('NanoEngine: Prompt API not found (need Chrome with Gemini Nano enabled).');

    if (this.#session) this.destroy();

    const availability = typeof api.availability === 'function' ? await api.availability() : 'available';
    say(`Gemini Nano availability: ${availability}`);

    const params = {
      initialPrompts: [{
        role: 'system',
        content:
          'You are a precise information-extraction and rewriting assistant for a mortgage underwriting harness. ' +
          'Always answer with exactly what the user request specifies and nothing else.',
      }],
      // Low temperature + narrow topK keep extraction and translation
      // deterministic (the Prompt API tunes sampling at session level).
      temperature: 0.2,
      topK: 8,
      monitor: undefined,
    };

    // Wire a download progress monitor when the API supports one.
    if (typeof ProgressEvent !== 'undefined' && availability !== 'available') {
      params.monitor = (m) => {
        m.addEventListener('downloadprogress', (e) => {
          say(`Downloading Nano weights: ${Math.round(e.loaded * 100)}%`);
        });
      };
    }

    try {
      this.#session = await api.create(params);
    } catch (err) {
      // Older flag builds reject { initialPrompts }; retry minimal.
      try {
        say('Session create with system prompt failed — retrying minimal session…');
        this.#session = await api.create({});
      } catch (err2) {
        throw new Error(`NanoEngine: could not create session (${err2 && err2.message ? err2.message : err2})`);
      }
    }

    say('Gemini Nano session ready.');
  }

  /**
   * Execute one inference call. Aborting via destroy() or an external
   * AbortSignal is surfaced as a thrown error so the harness can mark
   * the item as ERROR and move on.
   * @param {string} text
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<string>}
   */
  async prompt(text, opts = {}) {
    if (!this.#session) throw new Error('NanoEngine: prompt() called before init().');

    this.#abort = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) throw new Error('NanoEngine: aborted before inference.');
      opts.signal.addEventListener('abort', () => this.#abort.abort(), { once: true });
    }

    try {
      return await this.#session.prompt(text, { signal: this.#abort.signal });
    } finally {
      this.#abort = null;
    }
  }

  /** Destroy the session and free memory. */
  destroy() {
    try {
      if (this.#abort) this.#abort.abort();
    } catch { /* noop */ }
    try {
      if (this.#session && typeof this.#session.destroy === 'function') this.#session.destroy();
    } catch { /* noop */ }
    this.#session = null;
    this.#abort = null;
  }
}
