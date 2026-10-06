// Shared helpers for the browser tests in this folder (run with `npm run test:browser` and `npm run test:live`).
// They drive an installed Chromium-based browser (Edge or Chrome) through puppeteer-core; nothing is downloaded.
// Set BROWSER_PATH to choose the browser. Without one, the tests are skipped with a message.

const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
];
const browserPath = process.env.BROWSER_PATH || CANDIDATES.find((p) => fs.existsSync(p)) || null;
const noBrowser = browserPath ? false : 'No Chromium-based browser found (set BROWSER_PATH)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launch() {
  return puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--no-first-run'] });
}

// Screenshots are written only when SCREENSHOT_DIR is set, for a person to inspect afterwards.
async function screenshot(page, name, { fullPage = true, element } = {}) {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  if (element) await (await page.$(element)).screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage });
}

// Small page helpers. Every wait has a timeout and fails with a description of what was expected.
function helpers(page) {
  const text = (selector) => page.$eval(selector, (el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  const waitFor = async (description, fn, arg, timeout = 15000) => {
    try {
      await page.waitForFunction(fn, { timeout, polling: 100 }, arg);
    } catch {
      throw new Error(`Timed out after ${timeout} ms waiting for: ${description}`);
    }
  };
  const waitText = (selector, pattern, timeout) => waitFor(`${selector} to match ${pattern}`,
    ([sel, src, flags]) => new RegExp(src, flags).test(document.querySelector(sel)?.textContent ?? ''),
    [selector, pattern.source, pattern.flags], timeout);
  const deliveryBadge = () => text('#detail .jd-delivery .jd-badge');
  const clickButton = async (container, label) => {
    const clicked = await page.evaluate(([sel, name]) => {
      const button = [...document.querySelectorAll(`${sel} button`)].find((b) => b.textContent.trim() === name && !b.disabled);
      button?.click();
      return Boolean(button);
    }, [container, label]);
    if (!clicked) throw new Error(`No enabled "${label}" button in ${container}`);
  };
  // A person's double click or double tap: two clicks about 200 ms apart. By then a fast server
  // may already have answered the first.
  const doubleClick = async (target, gap = 200) => {
    const el = typeof target === 'string' ? await page.$(target) : target;
    await el.scrollIntoView();
    const box = await el.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.click(x, y);
    await sleep(gap);
    await page.mouse.click(x, y);
  };
  return { text, waitFor, waitText, deliveryBadge, clickButton, doubleClick };
}

// Records every illustration element the page adds to the motion layer: its effect type, key and when it was
// added. One effect can draw several elements in the same frame; a replay would add them again later.
function recordMotion(page) {
  return page.evaluateOnNewDocument(() => {
    window.__motion = [];
    document.addEventListener('DOMContentLoaded', () => {
      const layer = document.getElementById('journey-motion');
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n.nodeType === 1 && n.dataset.effect) {
              window.__motion.push({ type: n.dataset.effect, key: n.dataset.key ?? '', at: performance.now() });
            }
          }
        }
      }).observe(layer, { childList: true, subtree: true });
    });
  });
}

// Groups recorded motion by effect and reports any effect drawn twice (added again more than 300 ms later).
async function motionPlays(page) {
  const records = await page.evaluate(() => window.__motion ?? []);
  const plays = new Map();
  for (const r of records) {
    const id = `${r.type}|${r.key}`;
    const play = plays.get(id) ?? { type: r.type, key: r.key, first: r.at, repeated: false };
    if (r.at - play.first > 300) play.repeated = true;
    plays.set(id, play);
  }
  return [...plays.values()];
}

module.exports = { browserPath, noBrowser, launch, sleep, screenshot, helpers, recordMotion, motionPlays };
