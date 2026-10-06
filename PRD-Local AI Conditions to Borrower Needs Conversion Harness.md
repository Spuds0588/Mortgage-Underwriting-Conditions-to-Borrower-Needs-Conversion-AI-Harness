# Master Dev Document: Local AI Conditions to Borrower Needs Conversion Harness

## 1. Product Requirements Document (PRD)

### 1.1 Objective
Build a lightweight, zero-dependency, open-source test bench demonstrating the viability of in-browser Local Large Language Models (LLMs). The tool will ingest loan underwriting conditions (clean or messy), extract individual conditions, and translate them into client-friendly needs using Chrome's built-in Gemini Nano API. 

### 1.2 Target Audience
*   **Developers/Architects:** Looking for a template to implement `window.ai` and local RAG/extraction pipelines without cloud dependencies.
*   **Product Managers:** Evaluating local AI for cost savings and PII privacy.
*   **Loan Officers/Brokers:** End-users testing the translation capabilities.

### 1.3 Scope (V1)
*   **Framework:** 100% Vanilla HTML, CSS, and JS (No React, no build steps, no heavy dependencies).
*   **Inference Engine:** Google Gemini Nano (via Chrome `window.ai` / `languageModel`).
*   **Future-Proofing:** UI and architectural support for WebLLM and Transformers.js (hot-swappable), but implemented as "Coming in V2" stubs for now to avoid massive weight downloads.
*   **Pipeline Pattern:** 
    *   Smart text chunking (by lists, paragraphs, sentences).
    *   Stage 1: AI Extraction (Messy text -> JSON array of conditions).
    *   Stage 2: AI Translation (Condition -> Client-facing text).
*   **UI/UX:**
    *   Environment Gatekeeper (checks for Nano, provides Chrome flag instructions).
    *   Sample Data Dropdown (Clean JSON, Email, Messy OCR).
    *   "Advanced Settings" for live Prompt Tuning.
    *   CSS Flexbox Waterfall visualization (showing execution time per item).
    *   "Download JSON Report" for telemetry and accuracy benchmarking.

### 1.4 Non-Goals (YAGNI)
*   No local vector databases or RAG embeddings for this specific use case.
*   No client-side OCR library (`Tesseract.js`) or PDF parsing (`pdf.js`) in V1. We assume text extraction happens upstream or user pastes raw text.
*   No Web Workers in V1 (Nano runs asynchronously via the browser's implementation).

---

## 2. Implementation Guide

### 2.1 Architecture Overview
The application follows a strictly decoupled **Adapter Pattern** for the inference engines and a **Pipeline Pattern** for data processing.

1.  **The UI Layer (`app.js`)**: Manages state, listens to user input, handles the flexbox waterfall rendering, and triggers the pipeline.
2.  **The Pipeline Engine (`harness.js`)**: Orchestrates the smart chunking, routing (deterministic vs. unstructured), and the sequential AI queue.
3.  **The LLM Adapters (`engines/`)**: Wrappers standardizing the initialization and prompting of different local AI models.

### 2.2 File Structure
```text
/nano-underwriting-harness
 ├── index.html             # Main entry point, UI layout
 ├── css/
 │    └── styles.css        # CSS variables, layout, waterfall animations
 ├── js/
 │    ├── app.js            # UI Controller and DOM bindings
 │    ├── harness.js        # Core pipeline logic and chunking heuristic
 │    ├── samples.js        # Hardcoded sample data exports
 │    └── engines/
 │         ├── BaseEngine.js       # Interface contract
 │         ├── NanoEngine.js       # V1 Implementation (window.ai)
 │         ├── WebLlmEngine.js     # V2 Stub (Throws "Coming Soon")
 │         └── TransformersEngine.js # V2 Stub (Throws "Coming Soon")
 └── README.md              # SEO content, Chrome flag setup instructions
```

### 2.3 The Engine Adapter Contract
Every engine in `/engines/` must implement the following methods to ensure `harness.js` can hot-swap them:
*   `async isAvailable()`: Returns boolean if the environment supports it.
*   `async init(progressCallback)`: Initializes session/downloads weights.
*   `async prompt(text)`: Executes inference and returns string.
*   `destroy()`: Cleans up memory.

### 2.4 State & Event Flow
Avoid two-way data binding. `app.js` calls `harness.process()`. `harness.process()` accepts a `progressCallback` that emits standard event objects:
`{ phase: 'EXTRACT'|'TRANSLATE', status: 'START'|'SUCCESS'|'ERROR', id: 'chunk_1', ms: 450, data: {...} }`
The UI maps these events directly to the DOM to grow the waterfall UI.

---

## 3. Dev Task List

### Phase 1: Foundation & UI Scaffold
- [ ] **Task 1.1:** Setup project directory and file structure.
- [ ] **Task 1.2:** Create `index.html`. Implement a responsive two-column CSS grid (Input/Config on left, Output/Waterfall on right).
- [ ] **Task 1.3:** Build the "Environment Gatekeeper" banner in HTML/CSS. (Hidden by default, shown if Nano is missing).
- [ ] **Task 1.4:** Create `css/styles.css`. Define CSS variables for themes and write the CSS for the flexbox waterfall timing bars.

### Phase 2: Engine Adapters & Data
- [ ] **Task 2.1:** Create `BaseEngine.js` interface.
- [ ] **Task 2.2:** Implement `NanoEngine.js`. Wrap `window.ai.languageModel` with proper error handling and fallback logic.
- [ ] **Task 2.3:** Implement stubs for `WebLlmEngine.js` and `TransformersEngine.js` that resolve with a polite "V2" message.
- [ ] **Task 2.4:** Create `samples.js`. Populate with 3 constants: `SAMPLE_JSON`, `SAMPLE_EMAIL`, `SAMPLE_OCR`.

### Phase 3: The Core Pipeline
- [ ] **Task 3.1:** Build `harness.js`. Implement the `smartChunk()` method using the Regex cascade (Lists -> Paragraphs -> Sentences).
- [ ] **Task 3.2:** Implement `harness.aiChunkedExtract()` using sequential iteration over chunks.
- [ ] **Task 3.3:** Implement `harness.translateQueue()`.
- [ ] **Task 3.4:** Add telemetry tracking (prompts, execution times per item, success rates) into a master JSON object.

### Phase 4: UI Integration
- [ ] **Task 4.1:** In `app.js`, bind the UI dropdowns (Sample Data, Engine Selection) to populate the DOM.
- [ ] **Task 4.2:** Bind the "Run" button to invoke the pipeline and pass a callback function to render the Waterfall UI.
- [ ] **Task 4.3:** Build the "Download JSON Report" functionality using a Blob and `URL.createObjectURL()`.

### Phase 5: Documentation & SEO
- [ ] **Task 5.1:** Write the `README.md`. Include exact steps for enabling Chrome flags (`chrome://flags/#prompt-api-for-gemini-nano`).
- [ ] **Task 5.2:** Add SEO meta tags, OpenGraph data, and a descriptive semantic HTML structure to `index.html`.

---

## 4. `agents.md`

```markdown
# Agent Instructions: Local AI Harness Developer

## Role Definition
You are a Senior JavaScript Engineer and Architect. You strictly adhere to YAGNI (You Aren't Gonna Need It) principles. You write clean, functional, dependency-free vanilla JavaScript (ES6+). You prioritize performance and hardware empathy.

## Development Rules
1. **No Frameworks:** You are forbidden from using React, Vue, Svelte, Tailwind, or jQuery. Use native browser APIs, CSS Flexbox/Grid, and standard ES Modules.
2. **Adapter Pattern:** Maintain strict adherence to the Engine Adapter pattern defined in the Implementation Guide. Never tightly couple the `harness.js` logic directly to the `window.ai` API.
3. **Sequential Execution:** Never run local AI models concurrently using `Promise.all`. Always use `for...of` loops to execute inference sequentially to prevent hardware crashes.
4. **Console Logging:** Every major phase change or error must be clearly logged in the console using emojis for easy visual parsing (e.g., `🚀 [START]`, `❌ [ERROR]`, `⏱️ [TELEMETRY]`).

## ⚠️ CRITICAL: Environment & Memory Management
You are operating in a highly restricted, low-memory development container. You must aggressively manage your workspace to prevent out-of-memory (OOM) errors or filesystem bloat.

**Mandatory Post-Task Cleanup Protocol:**
After completing *any* task on the Dev Task List, you MUST execute the following steps before reporting completion:
1. **Clear Temporary Files:** Delete any `.tmp`, `.bak`, or arbitrary log files you generated during testing.
2. **Close Unused Ports:** Ensure any local live-servers or background worker processes you started are killed.
3. **Clear Node Modules (If accidentally created):** This project requires zero dependencies. If you accidentally ran `npm install` or created a `package-lock.json` or `node_modules` folder, `rm -rf` them immediately.
4. **Memory Verification:** Verify that only the absolute minimum required files (HTML, CSS, JS) remain in the working directory. Do not leave bloated test-data files on the disk; keep them localized strictly to `samples.js`.
```