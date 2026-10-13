# Can Needle 2 do this pipeline alone?

**Verdict: no.** Needle 2 can do Stage 1 (extraction) and _cannot_ do Stage 2
(rewriting a condition into borrower-friendly language). Stage 2 was tested two
independent ways and fails both: asked for prose it echoes the input (§3), and
asked to fill narrow slots for a deterministic template it invents values that
appear nowhere in the input (§4). On Stage 1 it does not beat the deterministic
chunker that already exists in `js/harness.js`, and on this pipeline its
extraction is, after tuning, equivalent to the chunker's output.

It is still shipped as a selectable, experimental engine (`needle`) because the
part it does do is remarkable — a 13.7 MB model returning schema-valid JSON in
~0.5–4.5 s per chunk on CPU, with no WebGPU and no 500 MB download — and because
the negative result is worth keeping measurable.

- Model: `Cactus-Compute/needle2` — 45M parameters, CQ2-quantized, Apache-2.0
- Runtime: vendored `js/vendor/needle/needle.js` + `needle.wasm` (394 KB)
- Weights: `needle2.cact`, 13,737,807 bytes (13.1 MiB), fetched from the
  Hugging Face CDN at init and cached in Cache Storage
- Engine: [js/engines/NeedleEngine.js](../js/engines/NeedleEngine.js)
- Tuning loop: `node tools/needle-bench.mjs` (Node, seconds per change)

## How it was measured

Every claim below comes from either `tools/needle-bench.mjs` (Node, same vendored
runtime and same schemas as the browser engine) or from the headed browser run
(`node tests/headed/run.mjs --engine=needle --sample=ocr`). Raw per-call output
is reproducible with `--raw`.

### 1. The API works, and the arguments matter

`needle_load` takes a 64-bit length and _requires_ a `BigInt`:

```js
Module.HEAPU8.set(bytes, ptr);
Module._needle_load(ptr, BigInt(bytes.length));   // -1 otherwise: "Cannot convert … to a BigInt"
```

`needle_init` returns the number of cached prefix tokens and `needle_complete`
returns the number of generated tokens — both are _positive on success_; only
negative values are failures. Reading either as a status code produces a false
error (the first probe did exactly that).

### 2. A bare passage is refused; a labeled one is accepted

`needle_complete("<a paragraph of conditions>")` returns `[]` with confidence
`1.0` and a reasoning line like _"No tool available for queries, pricing, or PIP
credit management."_ — for every framing of the OCR and email samples.

Adding a label that matches the tool's description fixes it:

| Framing of the passage | Items returned | Whole requirements | Fragments | Refusals | ms/chunk |
|---|---|---|---|---|---|
| bare passage | 0 | 0 | 0 | 11/11 | 1 200 |
| `Underwriting conditions:\n- …` | 46 | 1 | 45 | 0/11 | 2 879 |
| **`Underwriting conditions (each item one full requirement, never a fragment):\n- …`** | **24** | **4** | **20** | **1/11** | **3 168** |
| `…(requirements listed one per item, quoted in full)` | 29 | 4 | 25 | 1/11 | 3 538 |
| trailing instruction after the payload | 34 | 2 | 32 | 1/11 | 2 913 |

(`node tools/needle-bench.mjs --stage=frame`, 11 real chunks from the OCR and
email samples, 44 calls.) The winning frame is kept in
[js/engines/needleSchema.js](../js/engines/needleSchema.js).
Schema-level constraints (`min_items`, `min_length`) did **not** change
behaviour — they appear not to reach the decode grammar through this JSON path.

### 3. Free-text rewriting: it quotes instead of writing

Needle's contract is explicit: _"Arguments contain only values evidenced by the
input. An optional field with no evidence is omitted, not guessed."_ Measured
against that:

| Stage-2 ask | Result |
|---|---|
| `borrower_need` (noun-phrase tool description) | `[]`, confidence 1.0 |
| `ask_borrower_for_documents` ("Ask the borrower to provide…") | call emitted, `need` = **the input sentence, verbatim** |
| `translate_to_plain_english` | call emitted, `message` = **the input sentence, verbatim** |
| `summarize` | call emitted, output = input minus the final period |
| `rewrite_condition` + "do not copy the input" | call emitted, `rewritten` = **the input, verbatim** |
| "Rewrite in your own words (do not copy): …" | `[]` — _"No tool available for rewriting or managing borrower operations."_ |

Nine framings, zero paraphrases. A model whose arguments may only contain spans
of the input cannot produce a warmth-and-clarity rewrite, because the rewrite is
by definition text that is not in the input. That is a property of the model,
not of the prompt — hence Stage 2 in `NeedleEngine` is a documented
**pass-through** (the condition is returned with the harness's deterministic
acronym expansion already applied).

### 4. Filling narrow slots instead of writing free text

The verdict in §3 leaves one escape hatch. Asking Needle to _write_ a sentence
fails, but a `borrower_request` tool with enumerated slots
(`action` ∈ 5 values, `documents[]`, `deadline`, `subject`) asks it only to
_select and copy_, leaving the sentence itself to a deterministic JS template.
If that worked, Needle could still deliver borrower-facing language, and a
"small extractor + larger rewriter" pairing would be a real design.

It does not work. `node tools/needle-bench.mjs --stage=slot` — 6 real
conditions × 3 framings, 18 calls:

| | `ask-borrower` | `requirement` | `request-label` | Total |
|---|---|---|---|---|
| calls emitted | 3/6 | 4/6 | 6/6 | **13/18** |
| refused outright | 3 | 2 | 0 | **5** |
| `required` field left empty | 1 | 0 | 2 | **3** |
| `documents[]` value not in the input | 4 | 2 | 0 | **6** |
| `deadline` not in the input | 1 | 1 | 1 | **3** |

(The write-framing makes refusals worse and the neutral `request-label` framing
makes fabrication worse, so no framing wins — the trade is refusal against
invention, not a tuning problem.)

Refusals are the _better_ failure: the model reads the tool description as a
claim about what it is able to do, and declines when the requirement has no
matching capability — _"No tool available for document retrieval or VOE
lookup."_, _"No tool for property rental or additional rent schedules."_

The bad failure is when it does call. Where a `required` slot cannot be answered
by copying, the model invents a value:

| Slot value returned | What it should have been |
|---|---|
| `["2019-dissolution-clear-out", "2019-vesting-must-read-john-alvarez-husband-wife"]` | kebab-case identifiers appearing **nowhere** in the condition |
| `"2026-03-21T09:00:00"` | an invented ISO timestamp for a relative "30 days" |
| `"2025-03-21"` (3 calls, two framings) | an invented **past** date for "within 30 days of the note date" |
| `"5-day"` | right number, wrong shape — the source says "5-day seasoned trail" |
| `["Most recent paystub is missing the year-to-date figure"]` | a whole sentence in a slot wanting a document name |
| `subject: ""` (3 calls) | a `required` field returned empty |

#### This corrects §3

The contract's promise — _"an optional field with no evidence is omitted, not
guessed"_ — is real but **scoped to fields the model can answer by copying**.
It holds in Stage 1, where every returned span is contiguous source text. It
does **not** hold for a `required` field the model cannot copy: there it
guesses. So "Needle only returns spans of the input" is not a property of the
model in general; it is a property of asking it for spans.

That distinction decides the case for this pipeline. A free-text echo is
harmless — the borrower sees the original requirement. A fabricated date or
invented identifier is not: `deadline: "2025-03-21"` would state a deadline
that appears in no condition, in a message a borrower may rely on. The failure
mode of slot-filling is therefore **strictly worse** than the failure mode of
free-text rewriting, and both rule Needle out of Stage 2.

Stage 2 stays a documented pass-through. The template approach was rejected on
this evidence rather than shipped.

### 5. Stage 1 works, but adds nothing here

`smartChunk()` in [js/harness.js](../js/harness.js) already splits input into
requirement-sized chunks (numbered list → one chunk per item, which is exactly
what the OCR sample is). Fed one of those chunks, Needle splits it again at
commas, so the adapter:

1. **grounds** each returned span against the source (`groundConditions`) —
   which removes invented spans like `P2M0NTR`, observed on a garbled OCR chunk;
2. **re-joins** adjacent spans (`mergeContiguousSpans`) and returns the
   _original source slice_, so punctuation and wording survive;
3. falls back to the chunk itself when the model refuses, or when its spans
   cover less than 60 % of the chunk — the OCR title chunk lost its whole
   `vesting must read …` clause without that guard.

Headed results (`node tests/headed/run.mjs --engine=needle …`, Chrome 153, real
page, header-less local server):

| Sample | Before tuning | After tuning | Wall clock | Prompts |
|---|---|---|---|---|
| Clean JSON (routing: json) | — | 6/6 | 0.0 s (Stage 2 is a pass-through) | 6 |
| Messy OCR (6 chunks) | 27 fragments, 15 usable | **6 whole conditions, 6/6** | 19.0 s | 12 |
| Email thread (5 chunks) | 8 fragments | 8 conditions, 8/8 (2 fragments, 1 noise item) | 15.4 s | 13 |

Those six OCR conditions are the six chunks. The model's contribution is
zero on already-chunked input — its value would be on un-chunked prose, where it
does split a paragraph into requirement-ish sentences (visible in the email
run: "double-check notes for reserves" came back as its own condition, which the
paragraph cascade would have merged into the neighbour).

**"6/6" counts needs produced, not needs that read well — and on garbled input
they do not.** Because grounding returns the _source_ slice rather than the
model's rewording (deliberate: fidelity over fluency), and Stage 2 is the
deterministic acronym expansion rather than a model call, OCR garble survives
into the borrower-facing text. `expandAcronyms()` repairs known jargon (YTD →
"year-to-date (YTD)", VOE → "proof of employment (VOE)", "rent schedule" →
"document listing expected rental income (rent schedule)"), so `cond_5` does
read cleanly. Everything else is passed through untouched — `cond_1` still
begins `qu4lifiedescrow: w4it 3O d4ys t0 pull 4ny Escr0w reserves fr0m p4r
p4yment`, and `cond_4` keeps `£lear`, `2Ol9` and `re4d`.

That is the honest comparison against the 0.5B engine, which on the same sample
emits clean, sentence-shaped English at ~318 s. The Needle path is ~12× faster,
~35× smaller and gives 6/6, but on the OCR sample its Stage-2 text is not
something to send a borrower — which is the cost of a model that can only quote.
Verified on the deployed site (v1.9.0), same sample, `27.4 s`, 6/6, 0 errors, and
byte-identical output to the local headed run.

For reference, the same OCR sample on Transformers.js (Qwen2.5-0.5B, WASM,
multi-core) takes ~318 s and produces 6 conditions, and Gemini Nano is
Chrome-native. Needle 2 is ~17× faster than the 0.5B and ~200× smaller — its
ceiling is the task, not the hardware.

## Reproducing

```sh
node tools/needle-bench.mjs --download        # fetch needle2.cact into .cache/
node tools/needle-bench.mjs --stage=frame     # the 44-call framing A/B (§2)
node tools/needle-bench.mjs --stage=slot      # the 18-call slot-fill probe (§4)
node tools/needle-bench.mjs --raw             # raw call JSON per sample
node tests/headed/run.mjs --engine=needle --sample=ocr   # real browser, real UI
```

## What would change the verdict

- A Needle-family model that is trained to _generate_ (not only to quote) inside
  its schema fields, **or** to abstain rather than guess when a `required` slot
  has no supporting span. §4 shows the current model does neither: it will not
  originate language, and it invents values to satisfy a field it cannot copy.
- Constraining the tool so every field is answerable by copying — `documents[]`
  restricted to spans of ≥3 contiguous source words, `deadline` dropped since a
  relative deadline cannot be copied, `action` inferred in JS from keyword
  presence rather than chosen by the model. That removes the fabrication risk by
  removing the model's choices, which leaves little for it to do: the `frame`
  A/B in §2 already showed the chunker matches it.
- Fine-tuning: the repo ships training and export code, so a variant trained on
  `condition → borrower sentence` pairs with the target sentence present in the
  context (e.g. as a retrieval-selected candidate) would fit the tool-calling
  frame. Out of scope here.
