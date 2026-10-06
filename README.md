# 🧪 Nano Underwriting Harness

**Local AI Conditions → Borrower Needs Conversion Harness**

A lightweight, zero-build, open-source test bench demonstrating the viability of in-browser Local Large Language Models (LLMs). It ingests loan underwriting conditions (clean or messy), extracts individual conditions, and translates them into client-friendly needs — running **entirely on your device** via Chrome's Gemini Nano, WebLLM (WebGPU), or Transformers.js (ONNX).

> **Live demo:** https://spuds0588.github.io/Mortgage-Underwriting-Conditions-to-Borrower-Needs-Conversion-AI-Harness/

No cloud. No API keys. No data leaves the machine — ideal for PII-sensitive mortgage workflows.

---

## ✅ Browser & engine support

The harness auto-detects three **local** inference engines — every run happens on your device, zero cloud:

| Engine | Runtime | Notes |
|---|---|---|
| **Gemini Nano** | Chrome built-in Prompt API (`window.LanguageModel`) | Zero download on supported builds. Distributed only for Windows/macOS Chrome — **not served to Linux** (verified: the `Optimization Guide On Device Model` component is absent from `chrome://components` on Linux Chrome 153). |
| **WebLLM** | WebGPU | Runs Qwen2.5-0.5B-Instruct (4-bit) in-browser; ~500 MB one-time download, cached by the browser. |
| **Transformers.js** | ONNX Runtime Web (WebGPU → WASM fallback) | Same model family, ~350–500 MB one-time download, cached. |

### 🔧 Enabling Gemini Nano (Windows/macOS only)

1. Open **`chrome://flags/#prompt-api-for-gemini-nano`** → **Enabled** → relaunch.
2. Open **`chrome://components`** → **"Optimization Guide On Device Model"** → **Check for update** (wait for the full ~2 GB download).
3. Relaunch Chrome and reload this page — the status pill should show **"Gemini Nano: available ✓"**.

On Linux or unsupported hardware, select the **WebLLM** or **Transformers.js** engine instead — identical pipeline, real local model.

---

## 🚀 How to use

1. **Pick a sample** — *Clean JSON*, *Email thread*, or *Messy OCR scan* — or paste your own conditions text.
2. **Run Pipeline.**
3. Watch the **waterfall** grow: one bar per chunk (Stage 1 — extraction) and per condition (Stage 2 — translation), each bar showing execution time.
4. Review **Extracted Conditions → Client Needs** cards.
5. **Download JSON Report** for telemetry: prompt counts, per-item timings, success rates.

### ⚙️ Advanced Settings (live prompt tuning)

- Edit the **Stage 1 extraction** and **Stage 2 translation** prompts *live* — changes apply on the next run.
- **Max conditions per chunk** caps extraction breadth per prompt.

> Prompt-shape matters a lot for small on-device models: the concise default extraction prompt was selected by A/B benchmarking on real hardware (long multi-rule prompts made a 0.5B model return `[]`; the terse variant extracts correctly).

---

## 📊 Real-machine benchmark (published results)

Measured against **this live production site**, driving the real UI in a headed Chrome session via CDP. Three full pipeline runs (email sample ×2, messy-OCR sample ×1).

**Test machine:**

| Spec | Value |
|---|---|
| CPU | Intel Core i5-8350U @ 1.70 GHz (4C/8T, up to 3.6 GHz) |
| RAM | 16 GB DDR4 |
| GPU | Intel UHD Graphics 620 (integrated, gen-9) — WebGPU via Vulkan |
| Storage | 217 GB NVMe SSD (111 GB free) |
| OS | Debian GNU/Linux 13 (trixie), kernel 6.12.69+deb13-amd64 |
| Browser | Google Chrome 153.0.8010.36 (stable), headed session, X11 |
| Model | `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` via WebLLM (WebGPU) |

**Results (all from the app's own telemetry report):**

| Run | Input | Chunks | Prompts | Conditions → Needs | Errors | Wall time | Engine init |
|---|---|---|---|---|---|---|---|
| cold* | email (1.2 KB) | 8 | 20 | 12 | 0 | 62.3 s | 1.9 s |
| warm-1 | email | 8 | 20 | 12 | 0 | 62.9 s | 1.3 s |
| warm-2 | messy OCR (0.9 KB) | 6 | 10 | 4 | 0 | 31.0 s | 1.3 s |

\* "cold" = fresh session + shader compile; the ~500 MB weight download itself happened once before these runs and is cached by the browser afterwards.

**Per-item timing:** translation ≈ 1.5–3.6 s per condition (mean ≈ 2.5 s); extraction ≈ 2–7 s per chunk. Sequential throughout (hardware-empathy rule).

**Honest quality notes:**
- Clean/messy prose (email thread): extraction and translation are usable — real conditions found, jargon expanded.
- Heavy OCR garble: a 0.5B model struggles — it extracts garbled fragments and occasionally hallucinates the "need". This is precisely what the harness exists to measure; a larger WebLLM model can be swapped in via one adapter constant.
- Header-only chunks correctly yield `[]` (no fabricated conditions).

Raw JSON of these runs: captured via the app's **Download JSON Report** (same schema shipped to users).

---

## 🧠 How it works

```
Raw text (JSON / email / OCR garbage)
        │
        ▼
smartChunk()            Lists → Paragraphs → Sentences regex cascade
        │               (tiny fragments merged, long items re-split)
        ▼
Stage 1 — EXTRACT       messy chunk ──AI──▶ JSON array of conditions   (sequential)
        │
        ▼
Stage 2 — TRANSLATE     condition ──AI──▶ one warm plain-English "you" sentence  (sequential)
        │
        ▼
Waterfall UI + JSON telemetry report
```

- **Chunking is deterministic** (pure regex, no AI) and shown live under the input box.
- **Inference is strictly sequential** (`for...of`, never `Promise.all`) — hardware empathy for low-memory machines.
- Model output is parsed defensively (markdown fences, trailing commas, prose-wrapped JSON all tolerated).

## 🏗️ Architecture

```
├── index.html              # Entry point, UI layout, gatekeeper banner
├── css/styles.css          # CSS variables, layout, waterfall animations
├── js/
│   ├── app.js              # UI controller — maps pipeline events → DOM
│   ├── harness.js          # Pipeline: chunking, extraction, translation, telemetry
│   ├── samples.js          # The 3 sample datasets
│   └── engines/
│       ├── BaseEngine.js        # Adapter interface contract
│       ├── NanoEngine.js        # Gemini Nano via window.LanguageModel (Windows/macOS Chrome)
│       ├── WebLlmEngine.js      # Qwen2.5-0.5B via WebLLM (WebGPU)
│       └── TransformersEngine.js# Qwen2.5-0.5B via Transformers.js (ONNX/WASM fallback)
```

**Engine adapter contract** (implemented by every engine in `js/engines/`):

| Method | Purpose |
|---|---|
| `async isAvailable()` | Does this environment support the engine? |
| `async init(progressCallback)` | Create session / download weights |
| `async prompt(text)` | One inference call → raw string |
| `destroy()` | Free memory |

`harness.js` never touches any model runtime directly — engines are hot-swappable. Adding a bigger model = one constant in `WebLlmEngine.js`.

## 📊 Telemetry report format

`Download JSON Report` emits one JSON object per run:

```json
{
  "meta": { "startedAt": "…", "engine": "nano", "totalMs": 0, "promptCount": 0, "successCount": 0, "errorCount": 0, "chunkCount": 0 },
  "chunks": [ { "id": "chunk_1", "text": "…", "conditionsFound": 3 } ],
  "items": [ { "id": "cond_1", "chunkId": "chunk_1", "condition": "…", "need": "…", "translateMs": 450 } ]
}
```

---

## 🛠️ Development

Zero dependencies, zero build step:

```bash
# any static server works, e.g.:
python3 -m http.server 8080
# then open http://localhost:8080
```

Or just open `index.html` — but note some Chrome builds gate the Prompt API to secure contexts, so a local server is more reliable.

## 🗺️ Roadmap

- Optional Web Worker isolation and streaming translation
- Larger WebLLM model variants (1B–3B) for OCR-grade extraction
- Batch benchmarking mode across sample corpora

## 📄 License

MIT — see [LICENSE](LICENSE).
