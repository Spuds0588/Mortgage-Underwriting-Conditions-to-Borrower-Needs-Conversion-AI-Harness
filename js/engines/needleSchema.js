/**
 * needleSchema.js — the tuned Needle 2 contract, shared by the browser engine
 * (NeedleEngine.js) and the Node tuning bench (tools/needle-bench.mjs).
 *
 * Why the schemas live apart: with Needle 2 the tool schema IS the prompt.
 * The model declares no free-text mode — it answers with a grammar-constrained
 * call, so the schema (name + description + property descriptions) is what
 * tells it what to produce and the "query" is only the material to read.
 *
 * Framing rules were derived by measurement (see docs/needle2-evaluation.md):
 *   - a bare passage is REFUSED ("[]", confidence 1.0); a labeled passage
 *     ("Underwriting conditions:\n- …") is accepted, so frameExtract() adds
 *     the label the tool description promises;
 *   - the model reliably copies contiguous spans of the input (so extraction
 *     must stay span-shaped), and it does NOT originate language: a required
 *     field it cannot answer by copying gets an invented value instead. Both
 *     facts are measured — see docs/needle2-evaluation.md §3 and §4.
 */

/** @typedef {{name: string, description: string, parameters: object}} NeedleTool */

/**
 * Stage 1: the record to extract. Description reads like the label the input
 * is framed with, which is what made the model accept the extract task.
 * @type {NeedleTool[]}
 */
export const NEEDLE_EXTRACT_TOOL = [{
  name: 'underwriting_conditions',
  description: 'Loan underwriting conditions stated in the text: the complete requirements the borrower must satisfy, merged where facts belong together',
  parameters: {
    type: 'object',
    properties: {
      conditions: {
        type: 'array',
        max_items: 5,
        items: { type: 'string', min_length: 30, max_length: 400 },
        description: 'one requirement per item, written out in full — never a fragment of a requirement',
      },
    },
    required: ['conditions'],
  },
}];

/**
 * Stage 2 attempt #1: a borrower-facing message. Kept in the repo because the
 * measurement that matters is that Needle 2 ECHOES the condition here rather
 * than rewriting it — any frame asking for new wording is answered with either
 * a copy of the input or a refusal (docs/needle2-evaluation.md §3).
 *
 * Attempt #2 (enumerated slots + a deterministic sentence template, so the model
 * never has to originate wording) also fails, and worse: it invents slot values
 * that appear nowhere in the input, including fabricated deadlines. That probe
 * lives in tools/needle-bench.mjs (`--stage=slot`), not here, because the
 * template approach was rejected rather than shipped — see §4.
 * @type {NeedleTool[]}
 */
export const NEEDLE_TRANSLATE_TOOL = [{
  name: 'ask_borrower_for_documents',
  description: 'Ask the borrower to provide a required document or take a required action',
  parameters: {
    type: 'object',
    properties: {
      need: { type: 'string', description: 'one sentence addressed to the borrower' },
    },
    required: ['need'],
  },
}];

/**
 * Frame a chunk as a labeled record so the model accepts the extract call.
 * Measured (tools/needle-bench.mjs --stage=frame, 11 real chunks × 4 framings):
 *   bare passage                      → refused, "[]"
 *   "Underwriting conditions:\n- …"   → 46 items, 1 whole requirement, 45 fragments
 *   …plus "(each item one full requirement, never a fragment)" → 24 items, 4 whole
 * The parenthetical is the single cheapest quality lever found, so it stays.
 */
export function frameExtract(payload) {
  return `Underwriting conditions (each item one full requirement, never a fragment):\n- ${String(payload).trim()}`;
}

/** Frame one condition as an explicit request (the shape that gets a call back). */
export function frameTranslate(payload) {
  return `Ask the borrower to provide: ${String(payload).trim()}`;
}

/**
 * Pull the material out of a harness prompt. The pipeline wraps the payload in
 * `<<< … >>>` and spends the rest of the prompt on instructions Needle 2 does
 * not read, so the engine takes only the delimited part.
 * @param {string} prompt
 * @returns {string}
 */
export function unwrapHarnessPrompt(prompt) {
  const s = String(prompt);
  const start = s.indexOf('<<<');
  const end = s.lastIndexOf('>>>');
  if (start === -1 || end === -1 || end <= start) return s.trim();
  return s.slice(start + 3, end).trim();
}
