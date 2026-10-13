/**
 * headed.mjs — headed (or headless) Google Chrome sessions driven by
 * Playwright, for testing the real page outside the editor's built-in
 * browser tooling.
 *
 * Why this exists:
 *   - Gemini Nano only exists in a real Google Chrome (channel: chrome),
 *     not in bundled Chromium, so engine tests need the system browser.
 *   - Long runs (0.5B WASM decode, Nano downloads) far exceed what an
 *     interactive preview session is good for.
 *   - A persistent user-data-dir is REQUIRED for the Nano model store and
 *     for the Transformers.js cache to survive between runs.
 *
 * Usage:
 *   import { startStaticServer } from './serve.mjs';
 *   import { openPage } from './headed.mjs';
 *
 * The profile lives in .chrome-profile/ (gitignored). `shareNanoWeights`
 * hard-links the system profile's Nano model store into it so a test run
 * does not re-download ~4 GB of weights.
 */
import { chromium } from 'playwright-core';
import { mkdir, readdir, symlink, rm, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const PROFILE_DIR = process.env.HARNESS_CHROME_PROFILE ?? join(ROOT, '.chrome-profile');

/** Candidate system Chrome installs, most likely first. */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

/** System Chrome user-data-dir, where the Nano weights live. */
const SYSTEM_PROFILE_DIR = process.env.SYSTEM_CHROME_PROFILE ?? join(homedir(), '.config/google-chrome');

/**
 * Chrome 138+ still gates the Prompt API behind flags on some channels.
 * Enabling them is harmless when they are already the default.
 */
const NANO_FLAGS = [
  '--enable-features=PromptAPIForGeminiNano,PromptAPIForGeminiNanoMultimodalInput,OptimizationGuideModelDownloading',
  '--disable-features=Translate',
  '--no-first-run',
  '--no-default-browser-check',
];

export function resolveChromePath() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error(
    'No Google Chrome found. Set CHROME_PATH to the Chrome executable.\n' +
    `Tried: ${CHROME_CANDIDATES.join(', ')}`,
  );
}

/**
 * Symlink ~/.config/google-chrome's on-device model store into the test
 * profile so Gemini Nano is usable without re-downloading ~4 GB of weights.
 * A symlink (not a copy/hard-link) is deliberate: the system Chrome is
 * usually running and holds some of these files open, and the store is
 * version-pinned by directory name, so the worst case is that Chrome sees
 * the component as stale and downloads its own copy.
 * @param {string} [profileDir]
 * @returns {Promise<string[]>} names that were linked (for logging)
 */
export async function linkNanoWeights(profileDir = PROFILE_DIR) {
  const linked = [];
  await mkdir(profileDir, { recursive: true });
  for (const name of ['OptGuideOnDeviceModel', 'OptGuideOnDeviceClassifierModel']) {
    const src = join(SYSTEM_PROFILE_DIR, name);
    const dst = join(profileDir, name);
    if (!existsSync(src)) continue;
    const existing = await lstat(dst).catch(() => null);
    if (existing) { linked.push(`${name} (already present)`); continue; }
    try {
      await symlink(src, dst);
      linked.push(`${name} -> ${src}`);
    } catch (err) {
      console.warn(`⚠️  could not link ${name}: ${err.message}`);
    }
  }
  return linked;
}

/** Remove the throwaway profile (for a clean-slate run). */
export async function wipeProfile(profileDir = PROFILE_DIR) {
  await rm(profileDir, { recursive: true, force: true });
}

/**
 * Open a page in a persistent, headed (by default) Chrome session.
 * @param {object} cfg
 * @param {string} cfg.url
 * @param {boolean} [cfg.headless] default false — a real window, real GPU path
 * @param {string} [cfg.profileDir]
 * @param {string[]} [cfg.args] extra Chrome flags
 * @param {boolean} [cfg.shareNano] link the system Nano weights into the profile
 * @param {number} [cfg.viewport]
 * @returns {Promise<{context, page, chromePath, close: () => Promise<void>}>}
 */
export async function openPage(cfg) {
  const {
    url,
    headless = false,
    profileDir = PROFILE_DIR,
    args = [],
    shareNano = true,
    viewport = { width: 1440, height: 1000 },
  } = cfg;

  const chromePath = resolveChromePath();
  const linked = shareNano ? await linkNanoWeights(profileDir) : [];
  if (linked.length) console.log(`🔗 Nano model store: ${linked.join(', ')}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless,
    viewport,
    args: [...NANO_FLAGS, ...args],
    // Keep the download prompt for models out of the way.
    acceptDownloads: true,
  });

  context.on('page', (p) => p.on('console', (m) => {
    if (m.type() === 'error') console.error(`🖥️  [page] ${m.text()}`);
  }));

  const page = context.pages()[0] ?? await context.newPage();
  if (page.url() === 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { context, page, chromePath, close: async () => { await context.close(); } };
}

/** List profile dirs so a stale one can be spotted in logs. */
export async function listProfiles() {
  return readdir(SYSTEM_PROFILE_DIR).catch(() => []);
}
