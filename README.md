# 🧪 Nano Underwriting Harness

**Local AI Conditions → Borrower Needs Conversion Harness**

A lightweight, zero-dependency, open-source test bench demonstrating the viability of in-browser Local Large Language Models (LLMs). It ingests loan underwriting conditions (clean or messy), extracts individual conditions, and translates them into client-friendly needs using Chrome's built-in **Gemini Nano**.

> **Live demo:** https://spuds0588.github.io/Mortgage-Underwriting-Conditions-to-Borrower-Needs-Conversion-AI-Harness/

No cloud. No API keys. No data leaves the machine — ideal for PII-sensitive mortgage workflows.

---

## ✅ Browser requirements (read first)

AI inference runs on **Chrome's built-in Gemini Nano** via the Prompt API (`window.LanguageModel`, formerly `window.ai.languageModel`). Requires:

- **Google Chrome** (desktop; v138+ stable recommended)
- The device meeting Chrome's on-device model requirements (roughly 22+ GB free disk, 4+ GB VRAM/GPU minimum per Chrome's guidance)
- Flags/components enabled as below

### 🔧 Enabling Gemini Nano (exact steps)

1. Open **`chrome://flags/#prompt-api-for-gemini-nano`** → set to **Enabled** → relaunch.
2. Open **`chrome://components`** → find **"Optimization Guide On Device Model"** → click **Check for update**. Wait for the full download to complete (this is the actual Nano model, ~1.5–2.5 GB).
3. Relaunch Chrome once more and reload this page. The status pill in the header should show **"Gemini Nano: available ✓"**.

> The page detects availability via `LanguageModel.availability()`. If it still shows "not detected": confirm you're on Chrome (not Edge/Brave without the component), check disk space, and try a relaunch — the component sometimes needs two.

**No Nano? The app still runs.** Explore samples, chunking, and the UI, or tick **Demo mode** in ⚙️ Advanced Settings to exercise the full pipeline with an in-memory mock engine.

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
- **Demo mode** runs a mock engine so you can try the tool on any browser without Nano.

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
│       ├── NanoEngine.js        # V1: window.LanguageModel / window.ai.languageModel
│       ├── WebLlmEngine.js      # V2 stub
│       └── TransformersEngine.js# V2 stub
```

**Engine adapter contract** (implemented by every engine in `js/engines/`):

| Method | Purpose |
|---|---|
| `async isAvailable()` | Does this environment support the engine? |
| `async init(progressCallback)` | Create session / download weights |
| `async prompt(text)` | One inference call → raw string |
| `destroy()` | Free memory |

`harness.js` never touches `window.ai` directly — engines are hot-swappable. Adding WebLLM in V2 means filling in one adapter file.

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

- **V2 — WebLLM adapter** (WebGPU, hot-swappable via the same contract)
- **V2 — Transformers.js adapter** (ONNX Runtime Web)
- Post-V1 candidates: Web Worker isolation, streaming translation, export to CSV, batch benchmarking mode

## 📄 License

MIT — see [LICENSE](LICENSE).
