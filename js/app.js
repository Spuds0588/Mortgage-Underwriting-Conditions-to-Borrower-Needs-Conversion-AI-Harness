/**
 * app.js — UI Controller and DOM bindings.
 *
 * One-way flow only: app.js calls harness.process() and maps the emitted
 * event objects directly onto the DOM (no two-way data binding).
 */
import { harness, smartChunk, DEFAULT_EXTRACT_PROMPT, DEFAULT_TRANSLATE_PROMPT } from './harness.js';
import { NanoEngine } from './engines/NanoEngine.js';
import { SAMPLE_JSON, SAMPLE_EMAIL, SAMPLE_OCR } from './samples.js';

/* ── DOM handles ────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const els = {
  gatekeeper: $('gatekeeper'),
  gatekeeperDismiss: $('gatekeeper-dismiss'),
  engineStatusDot: document.querySelector('#engine-status .status-dot'),
  engineStatusText: $('engine-status-text'),
  sampleSelect: $('sample-select'),
  inputText: $('input-text'),
  inputChars: $('input-chars'),
  inputChunks: $('input-chunks'),
  engineSelect: $('engine-select'),
  engineHint: $('engine-hint'),
  runBtn: $('run-btn'),
  stopBtn: $('stop-btn'),
  clearBtn: $('clear-btn'),
  waterfall: $('waterfall'),
  waterfallEmpty: $('waterfall-empty'),
  runSummary: $('run-summary'),
  resultsHeader: $('results-header'),
  resultsList: $('results-list'),
  reportRow: $('report-row'),
  downloadReportBtn: $('download-report-btn'),
  extractPrompt: $('setting-extract-prompt'),
  translatePrompt: $('setting-translate-prompt'),
  maxConditions: $('setting-max-conditions'),
  demoMode: $('setting-demo-mode'),
  resetPromptsBtn: $('reset-prompts-btn'),
};

const SAMPLES = { json: SAMPLE_JSON, email: SAMPLE_EMAIL, ocr: SAMPLE_OCR };

/* ── State ──────────────────────────────────────────────────────── */
let controller = null;      // AbortController for the running pipeline
let wfRows = new Map();     // id -> { row, bar, label }
let wfMaxMs = 0;            // widest bar so far (auto-rescales)
let resultCount = 0;

/* ── Environment Gatekeeper ─────────────────────────────────────── */
async function checkEnvironment() {
  setEngineStatus('pending', 'Checking environment…');
  const nano = new NanoEngine();
  const ok = await nano.isAvailable();   // isAvailable never throws
  if (ok) {
    setEngineStatus('ok', 'Gemini Nano: available ✓');
    els.gatekeeper.classList.add('hidden');
    els.engineHint.textContent = 'Runs entirely on-device. Your data never leaves this machine.';
  } else {
    setEngineStatus('error', 'Gemini Nano: not detected');
    els.gatekeeper.classList.remove('hidden');
    els.engineHint.textContent = 'Nano unavailable here — enable Chrome flags above, or use Demo mode in Advanced Settings.';
  }
}

function setEngineStatus(state, text) {
  els.engineStatusDot.className = `status-dot dot-${state}`;
  els.engineStatusText.textContent = text;
}

/* ── Sample data + input bindings ───────────────────────────────── */
els.sampleSelect.addEventListener('change', () => {
  const key = els.sampleSelect.value;
  els.inputText.value = key ? (SAMPLES[key] ?? '') : '';
  refreshInputMeta();
});

els.inputText.addEventListener('input', refreshInputMeta);

let chunkDebounce = null;
function refreshInputMeta() {
  const text = els.inputText.value;
  els.inputChars.textContent = `${text.length.toLocaleString()} chars`;
  clearTimeout(chunkDebounce);
  chunkDebounce = setTimeout(() => {
    try {
      const n = smartChunk(text).length;
      els.inputChunks.textContent = `chunking: ${n} chunk${n === 1 ? '' : 's'}`;
    } catch {
      els.inputChunks.textContent = 'chunking: —';
    }
  }, 150);
}

/* ── Engine selection ───────────────────────────────────────────── */
els.engineSelect.addEventListener('change', () => {
  if (els.engineSelect.value === 'nano') {
    els.engineHint.textContent = 'Runs entirely on-device. Your data never leaves this machine.';
  }
});

/* ── Advanced settings ──────────────────────────────────────────── */
function loadAdvancedDefaults() {
  els.extractPrompt.value = DEFAULT_EXTRACT_PROMPT;
  els.translatePrompt.value = DEFAULT_TRANSLATE_PROMPT;
  els.maxConditions.value = '10';
  els.demoMode.checked = false;
}
els.resetPromptsBtn.addEventListener('click', () => {
  els.extractPrompt.value = DEFAULT_EXTRACT_PROMPT;
  els.translatePrompt.value = DEFAULT_TRANSLATE_PROMPT;
});

/* ── Run / stop / clear ─────────────────────────────────────────── */
els.runBtn.addEventListener('click', runPipeline);
els.stopBtn.addEventListener('click', () => controller?.abort());
els.clearBtn.addEventListener('click', resetOutput);
els.gatekeeperDismiss.addEventListener('click', () => els.gatekeeper.classList.add('hidden'));

async function runPipeline() {
  const text = els.inputText.value.trim();
  if (!text) { alert('Paste underwriting conditions or pick a sample first.'); els.inputText.focus(); return; }

  resetOutput();
  setRunning(true);

  controller = new AbortController();
  const started = performance.now();

  try {
    const report = await harness.process({
      text,
      engineKey: els.engineSelect.value,
      demoMode: els.demoMode.checked,
      extractPrompt: els.extractPrompt.value || DEFAULT_EXTRACT_PROMPT,
      translatePrompt: els.translatePrompt.value || DEFAULT_TRANSLATE_PROMPT,
      maxConditions: clampInt(els.maxConditions.value, 1, 20, 10),
      signal: controller.signal,
      progressCallback: onPipelineEvent,
    });
    showSummary(report.meta, started);
    if (!report.items.length) {
      addSystemRow('No conditions extracted — check the input or tune the extraction prompt.', false);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      addSystemRow('Pipeline stopped by user.', false);
    } else {
      console.error('❌ [APP] pipeline failed:', err);
      addSystemRow(`Pipeline error: ${err.message || err}`, true);
    }
  } finally {
    setRunning(false);
    controller = null;
  }
}

function setRunning(running) {
  els.runBtn.disabled = running;
  els.runBtn.classList.toggle('hidden', running);
  els.stopBtn.classList.toggle('hidden', !running);
}

/* ── Pipeline event → DOM mapping (the waterfall grows here) ────── */
function onPipelineEvent(evt) {
  const { phase, status, id, ms, data } = evt;

  if (phase === 'SYSTEM') {
    if (id === 'pipeline' && status === 'ERROR') addSystemRow('Pipeline error — see console.', true);
    return;
  }

  if (status === 'START') {
    addWaterfallRow(phase, id);
  } else if (status === 'SUCCESS') {
    if (phase === 'EXTRACT') {
      finishWaterfallRow(id, ms, `+${data.found} condition${data.found === 1 ? '' : 's'}`);
    } else if (phase === 'TRANSLATE') {
      finishWaterfallRow(id, ms, `${ms}ms`);
      appendResultCard({ id, condition: lastConditionFor(id), need: data.need });
    }
  } else if (status === 'ERROR') {
    failWaterfallRow(id, ms);
  }
}

// Extraction events don't carry the condition text; remember the pairing
// via the report order — simplest robust approach: read from harness report.
function lastConditionFor(id) {
  const rep = harness.report;
  if (!rep) return '(condition unavailable)';
  const item = rep.items.find((it) => it.id === id);
  return item ? item.condition : '(condition unavailable)';
}

/* ── Waterfall rendering ────────────────────────────────────────── */
function addWaterfallRow(phase, id) {
  if (wfRows.has(id)) return;
  els.waterfallEmpty.classList.add('hidden');

  const row = document.createElement('div');
  row.className = 'wf-row';

  const label = document.createElement('div');
  label.className = 'wf-label';
  label.textContent = id;
  label.title = id;

  const track = document.createElement('div');
  track.className = 'wf-track';

  const bar = document.createElement('div');
  bar.className = `wf-bar phase-${phase}`;
  bar.style.width = '4%';
  bar.textContent = '…';

  track.appendChild(bar);
  row.appendChild(label);
  row.appendChild(track);
  els.waterfall.appendChild(row);

  wfRows.set(id, { row, bar, label });
}

function finishWaterfallRow(id, ms, suffix) {
  const entry = wfRows.get(id);
  if (!entry) return;
  const safeMs = Number.isFinite(ms) ? ms : 0;
  wfMaxMs = Math.max(wfMaxMs, safeMs);
  entry.bar.textContent = `${safeMs}ms ${suffix}`.trim();
  // Rescale every bar to the current max.
  for (const { bar, } of wfRows.values()) {
    const m = parseMsFromBar(bar.textContent);
    bar.style.width = `${Math.max(8, Math.round((m / wfMaxMs) * 100))}%`;
  }
}

function parseMsFromBar(text) {
  const m = /(\d+)ms/.exec(text || '');
  return m ? Number(m[1]) : 0;
}

function failWaterfallRow(id, ms) {
  const entry = wfRows.get(id);
  if (!entry) return;
  entry.bar.classList.add('is-error');
  entry.bar.textContent = `${Number(ms) || 0}ms error`;
}

function addSystemRow(message, isError) {
  els.waterfallEmpty.classList.add('hidden');
  const row = document.createElement('div');
  row.className = 'wf-row';
  const label = document.createElement('div');
  label.className = 'wf-label';
  label.textContent = 'system';
  const track = document.createElement('div');
  track.className = 'wf-track';
  const bar = document.createElement('div');
  bar.className = `wf-bar phase-SYSTEM${isError ? ' is-error' : ''}`;
  bar.style.width = '100%';
  bar.textContent = message;
  track.appendChild(bar);
  row.appendChild(label);
  row.appendChild(track);
  els.waterfall.appendChild(row);
}

/* ── Results list ───────────────────────────────────────────────── */
function appendResultCard({ id, condition, need, error }) {
  els.resultsHeader.classList.remove('hidden');
  resultCount += 1;

  const li = document.createElement('li');
  li.className = `result-card${error ? ' is-error' : ''}`;

  const idx = document.createElement('div');
  idx.className = 'result-idx';
  idx.textContent = `${id} · item ${resultCount}`;

  const cond = document.createElement('p');
  cond.className = 'cond';
  cond.textContent = condition;

  li.appendChild(idx);
  li.appendChild(cond);

  const needEl = document.createElement('p');
  needEl.className = 'need';
  needEl.textContent = error ? `translation failed: ${error}` : need;
  li.appendChild(needEl);

  els.resultsList.appendChild(li);
}

/* ── Summary + report download ──────────────────────────────────── */
function showSummary(meta, started) {
  const wallMs = Math.round(performance.now() - started);
  const secs = ((meta.totalMs ?? wallMs) / 1000).toFixed(1);
  els.runSummary.textContent =
    `${meta.chunkCount} chunks · ${meta.promptCount} prompts · ${meta.successCount} ok · ` +
    `${meta.errorCount} errors · ${secs}s`;
  els.runSummary.classList.remove('hidden');
  els.reportRow.classList.remove('hidden');
}

els.downloadReportBtn.addEventListener('click', () => {
  const rep = harness.report;
  if (!rep) { alert('No report available yet — run the pipeline first.'); return; }
  const blob = new Blob([JSON.stringify(rep, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nano-harness-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

/* ── Reset ──────────────────────────────────────────────────────── */
function resetOutput() {
  wfRows.clear();
  wfMaxMs = 0;
  resultCount = 0;
  els.waterfall.innerHTML = '';
  els.waterfall.appendChild(els.waterfallEmpty);
  els.waterfallEmpty.classList.remove('hidden');
  els.runSummary.classList.add('hidden');
  els.resultsHeader.classList.add('hidden');
  els.resultsList.innerHTML = '';
  els.reportRow.classList.add('hidden');
}

/* ── Util ───────────────────────────────────────────────────────── */
function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* ── Boot ───────────────────────────────────────────────────────── */
loadAdvancedDefaults();
refreshInputMeta();
checkEnvironment();
console.log('🚀 [APP] Nano Underwriting Harness ready.');
