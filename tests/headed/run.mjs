/**
 * tests/headed/run.mjs — end-to-end tests in a real, headed Google Chrome.
 *
 * Runs the actual page against the real engines. Nothing here is mocked:
 * the same UI, the same harness, the same on-device models a user gets.
 *
 *   node tests/headed/run.mjs                          # environment probe only
 *   node tests/headed/run.mjs --engine=needle --sample=json
 *   node tests/headed/run.mjs --engine=transformers --sample=ocr --timeout=900
 *   node tests/headed/run.mjs --matrix                 # every engine × sample json
 *   node tests/headed/run.mjs --headless --fresh       # CI-ish / clean profile
 *
 * Exit code is 0 only when every check passed — the report JSON under
 * tests/out/ always records what actually happened.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startStaticServer } from '../../tools/serve.mjs';
import { openPage, wipeProfile, PROFILE_DIR, ROOT } from '../../tools/headed.mjs';

/* ── CLI ────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const ENGINE = flag('engine', null);
const SAMPLE = flag('sample', 'json');
const TIMEOUT_MS = Number(flag('timeout', 600)) * 1000;
const HEADLESS = has('headless');
const MATRIX = has('matrix');
const FRESH = has('fresh');
const KEEP = has('keep');
const OUT_DIR = join(ROOT, 'tests/out');

/* ── Tiny check runner ──────────────────────────────────────────── */
const results = [];
let failed = 0;
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? null });
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (err) {
    failed += 1;
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(err.message ?? err) });
    console.error(`  ❌ ${name} — ${String(err.message ?? err)}`);
    return false;
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/* ── One engine × sample run ────────────────────────────────────── */
async function runOnce(ctx, { engine, sample }) {
  const { page, serverUrl } = ctx;
  console.log(`\n▶ ${engine} × ${sample}`);

  // Fresh page for every combination so engine state never leaks across runs.
  await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
  await settleCrossOriginIsolation(page);

  await settleCrossOriginIsolation(page);
  const env = await safeEvaluate(page, async () => ({
    crossOriginIsolated: self.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    languageModel: typeof self.LanguageModel !== 'undefined',
    nanoAvailability: typeof self.LanguageModel?.availability === 'function'
      ? await self.LanguageModel.availability().catch((e) => `error: ${e.message}`)
      : null,
    webgpu: !!navigator.gpu,
    footer: document.querySelector('.app-footer p')?.textContent?.trim().slice(-20) ?? null,
  }));

  let report = null;

  await check(`${engine}/${sample}: page loads`, async () => {
    assert(env.footer && env.footer.includes('harness v'), 'footer build id missing');
    return `build ${env.footer.replace('· harness v', 'v')}`;
  });

  // ── UI: configure the run exactly like a user would ──
  await check(`${engine}/${sample}: select engine + sample`, async () => {
    await page.selectOption('#engine-select', engine);
    await page.selectOption('#sample-select', sample);
    const hint = await page.textContent('#engine-hint');
    return hint?.slice(0, 60) ?? '';
  });

  // Downloadable engines need the ⤓ step before Run unlocks.
  const needsDownload = !(await page.isDisabled('#download-model-btn')) || !(await page.locator('#download-model-btn').isHidden());
  if (needsDownload) {
    await check(`${engine}/${sample}: model download/init`, async () => {
      const t0 = Date.now();
      await page.click('#download-model-btn');
      await page.waitForFunction(
        () => !document.getElementById('run-btn').disabled,
        null,
        { timeout: TIMEOUT_MS },
      );
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const label = await page.textContent('#download-label').catch(() => '');
      return `${secs}s — ${String(label ?? '').slice(0, 90)}`;
    });
  }

  // Paint probe, installed before the click. A synchronous engine blocks the
  // main thread, so the browser produces no frames while work is in flight and
  // the results only appear once everything has finished. Counting frames that
  // land BETWEEN waterfall rows is the difference between "live" and "frozen" —
  // a MutationObserver alone would report the DOM changing even while blocked.
  await page.evaluate(() => {
    window.__lastReport = null;
    const probe = { t0: performance.now(), frames: [], rows: [], ticks: 0 };
    window.__paint = probe;
    const stamp = () => performance.now() - probe.t0;
    (function frame() { probe.frames.push(stamp()); requestAnimationFrame(frame); })();
    setInterval(() => { probe.ticks += 1; }, 100);
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.classList?.contains('wf-row')) probe.rows.push(stamp());
        }
      }
    }).observe(document.getElementById('waterfall'), { childList: true });
  });

  await check(`${engine}/${sample}: run pipeline`, async () => {
    await page.evaluate(() => { window.__lastReport = null; });
    await page.click('#run-btn');
    await page.waitForFunction(
      () => window.__lastReport && window.__lastReport.meta && window.__lastReport.meta.finishedAt,
      null,
      { timeout: TIMEOUT_MS, polling: 1000 },
    );
    report = await page.evaluate(() => window.__lastReport);
    const { meta } = report;
    return `${report.items.length} conditions in ${(meta.totalMs / 1000).toFixed(1)}s ` +
      `(${meta.promptCount} prompts, ${meta.errorCount} errors, engine=${meta.engine}${meta.preloaded ? ', preloaded' : ''})`;
  });

  await check(`${engine}/${sample}: UI stays live while running`, async () => {
    const p = await page.evaluate(() => {
      const { frames, rows, ticks } = window.__paint ?? { frames: [], rows: [], ticks: 0 };
      const start = rows[0] ?? 0;
      const end = rows[rows.length - 1] ?? start;
      return {
        framesInSpan: frames.filter((t) => t >= start && t <= end).length,
        spanMs: end - start,
        rows: rows.length,
        ticks,
      };
    });
    const spanSec = p.spanMs / 1000;
    if (spanSec < 0.2) return `run too short to judge (${spanSec.toFixed(2)}s)`;
    const fps = p.framesInSpan / spanSec;
    assert(fps >= 5,
      `main thread was blocked while work was in flight: ${fps.toFixed(1)} frames/s ` +
      `(${p.framesInSpan} frames over ${spanSec.toFixed(1)}s, ${p.ticks} ticker ticks)`);
    return `${fps.toFixed(0)} frames/s while running ` +
      `(${p.rows} rows, ${p.ticks} ticker ticks over ${spanSec.toFixed(1)}s)`;
  });

  if (report) {
    await check(`${engine}/${sample}: produced needs`, async () => {
      assert(report.items.length > 0, 'no conditions extracted');
      const withNeeds = report.items.filter((it) => it.need && it.need.length > 10);
      assert(withNeeds.length > 0, 'no usable borrower needs');
      return `${withNeeds.length}/${report.items.length} with needs`;
    });

    await check(`${engine}/${sample}: report is sane`, async () => {
      const bad = report.items.filter((it) => it.need && (it.need.includes('{{') || it.need.includes('<<<')));
      assert(bad.length === 0, `${bad.length} items leaked template placeholders`);
      return `routing=${report.meta.routing}, dropped=${report.meta.dropped ?? 0}`;
    });

    const itemTok = report.items.map((it) => it.tokPerSec).filter(Boolean);
    if (itemTok.length) {
      const avg = (itemTok.reduce((a, b) => a + b, 0) / itemTok.length).toFixed(2);
      console.log(`  ℹ️  decode ${avg} tok/s avg (${itemTok.length} measured items), ` +
        `total ${(report.meta.totalMs / 1000).toFixed(1)}s`);
    }

    await mkdir(OUT_DIR, { recursive: true });
    const file = join(OUT_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${engine}-${sample}.json`);
    await writeFile(file, JSON.stringify({ env, checks: results, report }, null, 2));
    console.log(`  💾 ${file}`);
  }

  return { env, report };
}

/**
 * The COI shim registers a service worker and reloads the page once by itself.
 * That reload destroys the JS execution context, so every probe here has to
 * tolerate a torn-down evaluate instead of dying on it.
 */
async function settleCrossOriginIsolation(page) {
  const isolated = () => page.evaluate(() => self.crossOriginIsolated === true).catch(() => false);
  for (let i = 0; i < 8; i++) {
    if (await isolated()) return;
    await page.waitForTimeout(1000);
  }
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  for (let i = 0; i < 8; i++) {
    if (await isolated()) return;
    await page.waitForTimeout(1000);
  }
}

/** evaluate() that survives the shim's reload by retrying once. */
async function safeEvaluate(page, fn) {
  try { return await page.evaluate(fn); }
  catch (err) {
    if (!/Execution context was destroyed|navigation/i.test(String(err.message))) throw err;
    await settleCrossOriginIsolation(page);
    return page.evaluate(fn);
  }
}

/* ── Main ───────────────────────────────────────────────────────── */
async function main() {
  if (FRESH) {
    console.log(`🧹 wiping ${PROFILE_DIR}`);
    await wipeProfile();
  }

  const server = await startStaticServer({ port: 0 });
  console.log(`🌐 static server (no COOP/COEP, GitHub Pages style): ${server.url}`);

  let session = null;
  try {
    session = await openPage({ url: server.url, headless: HEADLESS });
    const { page, context } = session;
    console.log(`🖥️  Chrome: ${session.chromePath} (${HEADLESS ? 'headless' : 'headed'})`);

    const consoleLog = [];
    context.on('console', (m) => consoleLog.push(`${m.type()}: ${m.text()}`));

    await settleCrossOriginIsolation(page);
    const envProbe = await safeEvaluate(page, async () => ({
      crossOriginIsolated: self.crossOriginIsolated === true,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      languageModelPresent: typeof self.LanguageModel !== 'undefined',
      nanoAvailability: typeof self.LanguageModel?.availability === 'function'
        ? await self.LanguageModel.availability().catch((e) => `error: ${e.message}`)
        : null,
      nanoParams: typeof self.LanguageModel?.params === 'function'
        ? await self.LanguageModel.params().catch(() => null)
        : null,
      webgpu: !!navigator.gpu,
      webgpuAdapter: navigator.gpu ? !!(await navigator.gpu.requestAdapter().catch(() => null)) : false,
      hardwareConcurrency: navigator.hardwareConcurrency,
    }));

    console.log('\n▶ environment');
    await check('COI shim isolates the page on a header-less host', async () => {
      await settleCrossOriginIsolation(page);
      assert(await safeEvaluate(page, () => self.crossOriginIsolated === true),
        'crossOriginIsolated never became true (COI shim did not activate)');
      return 'crossOriginIsolated: true';
    });
    console.log(`  ℹ️  ${JSON.stringify(envProbe)}`);

    const jobs = MATRIX
      ? ['nano', 'webllm', 'transformers', 'needle'].map((engine) => ({ engine, sample: 'json' }))
      : ENGINE ? [{ engine: ENGINE, sample: SAMPLE }] : [];

    for (const job of jobs) {
      await runOnce({ page, serverUrl: server.url }, job);
    }

    if (jobs.length) {
      await check('no uncaught page errors', async () => {
        const errs = consoleLog.filter((l) => l.startsWith('error:') && !/favicon/i.test(l));
        assert(errs.length === 0, `${errs.length} console errors: ${errs.slice(0, 3).join(' | ')}`);
        return `${consoleLog.length} console messages`;
      });
    }

    console.log(`\n${failed === 0 ? '✅' : '❌'} ${results.length - failed}/${results.length} checks passed`);
    for (const r of results.filter((x) => !x.ok)) console.log(`   • ${r.name}: ${r.error}`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (err) {
    console.error(`\n💥 runner failed: ${err.stack ?? err}`);
    process.exitCode = 2;
  } finally {
    if (session && !KEEP) await session.close().catch(() => {});
    await server.close();
  }
}

await main();
