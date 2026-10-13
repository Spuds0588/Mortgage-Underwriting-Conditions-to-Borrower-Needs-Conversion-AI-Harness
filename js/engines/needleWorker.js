/**
 * needleWorker.js — Needle 2 inference, off the main thread.
 *
 * Why this exists
 * ---------------
 * The vendored Cactus build exposes a SYNCHRONOUS entry point: `needle_complete`
 * returns only once the whole completion has been decoded. Called from the page,
 * decoding one chunk of OCR prose occupies the main thread for seconds, so the
 * browser never reaches a frame and nothing can be painted, animated or clicked.
 * Measured before this file existed (headed Chrome, needle × ocr, 40 s run):
 *
 *   rows created .............. 12, spread over 30 s
 *   animation frames .......... 5 in the whole run, 0 between chunks
 *   setInterval ticks ......... 1 (the waterfall's 500 ms ticker never ran)
 *   inter-chunk gaps painted .. 0/11
 *
 * i.e. the UI froze and then revealed everything at once, while nano (which
 * awaits real async IPC) streamed normally. Running the same call here keeps the
 * page free to paint between chunks, lets the ticker animate, and makes Stop
 * take effect immediately instead of at the end of the current decode.
 *
 * Classic worker, not a module: the emscripten glue is a UMD build loaded with
 * importScripts. It also relies on `document.currentScript.src` to locate
 * needle.wasm, which does not exist in a worker scope — hence the shim below.
 */

const VENDOR = new URL('../vendor/needle/', self.location.href).href;
/** One call's JSON is well under this; the same cap the main thread used. */
const OUT_CAPACITY = 64 * 1024;

/** @type {object|null} Emscripten module (holds the wasm heap + exports). */
let Module = null;
/** @type {Function|null} */
let initFn = null;
/** @type {Function|null} */
let completeFn = null;
/** @type {number} */
let outPtr = 0;

const post = (msg) => self.postMessage(msg);

/**
 * Instantiate the runtime and expose its entry points.
 * @returns {Promise<void>}
 */
async function boot() {
  if (Module) return;

  // The glue computes its script directory from document.currentScript; in a
  // worker there is no document, so give it the real URL before it evaluates
  // or it cannot find needle.wasm next to needle.js.
  if (typeof self.document === 'undefined') {
    self.document = { currentScript: { src: new URL('needle.js', VENDOR).href } };
  }

  importScripts(new URL('needle.js', VENDOR).href);
  const factory = self.createNeedle;
  if (typeof factory !== 'function') throw new Error('needle.js exposed no factory');

  // Hand the wasm over explicitly as well, so instantiation never depends on
  // how the glue resolves its own path in a worker.
  const wasmBinary = await (await fetch(new URL('needle.wasm', VENDOR).href)).arrayBuffer();
  Module = await factory({
    wasmBinary,
    locateFile: (file) => new URL(file, VENDOR).href,
  });

  initFn = Module.cwrap('needle_init', 'number', ['string', 'string', 'string']);
  completeFn = Module.cwrap('needle_complete', 'number', ['string', 'number', 'number', 'number']);
  outPtr = Module._malloc(OUT_CAPACITY);
}

/**
 * Copy the 13.7 MB archive into the wasm heap and load it.
 * @param {Uint8Array} bytes
 */
function loadWeights(bytes) {
  const ptr = Module._malloc(bytes.length);
  Module.HEAPU8.set(bytes, ptr);
  // needle_load takes (const unsigned char*, unsigned long long) → BigInt.
  const rc = Module._needle_load(ptr, BigInt(bytes.length));
  Module._free(ptr);
  if (rc < 0) throw new Error(`needle_load failed (${rc})`);
}

/**
 * One grammar-constrained completion. BLOCKING by design — that is exactly why
 * it runs here rather than on the page.
 * @param {{query: string, tools: string, maxNewTokens: number}} req
 */
function complete(req) {
  if (!Module) throw new Error('worker not initialised');
  Module._needle_reset();
  // needle_init returns cached prefix tokens; negative means failure.
  const rc = initFn(null, req.tools, null);
  if (rc < 0) throw new Error(`needle_init failed (${rc})`);
  const t0 = performance.now();
  const generated = completeFn(req.query, req.maxNewTokens, outPtr, OUT_CAPACITY);
  const ms = Math.round(performance.now() - t0);
  return { raw: Module.UTF8ToString(outPtr), generated, ms };
}

self.onmessage = async (event) => {
  const msg = event.data ?? {};
  const id = msg.id ?? null;
  try {
    switch (msg.type) {
      case 'init':
        await boot();
        post({ type: 'ready', id });
        return;
      case 'weights':
        loadWeights(new Uint8Array(msg.bytes));
        post({ type: 'loaded', id });
        return;
      case 'run':
        post({ type: 'result', id, ...complete(msg) });
        return;
      default:
        throw new Error(`unknown message type: ${String(msg.type)}`);
    }
  } catch (err) {
    post({ type: 'error', id, message: String((err && err.message) || err) });
  }
};
