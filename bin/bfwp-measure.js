#!/usr/bin/env node
// What one page costs per engine, measured rather than argued about.
//
// WHY THIS EXISTS. "Can it use less memory" and "would another engine be lighter"
// are questions with answers, and the answer for this server turned out to be
// neither of the two guesses: a different engine is not lighter (see the numbers
// below), and the flags already in src/browser.js are not the cheapest they could
// be. Both facts came out of this file, and either one is a claim nobody should
// have to take on trust -- `BFWP_CHROMIUM_LOW_MEMORY` exists because of the first
// two rows.
//
// WHAT IT MEASURES, and how: it loads one page in one engine, waits for it to
// settle, and adds up the resident memory of every process that appeared while the
// browser was alive. Shared libraries are therefore counted once per process, which
// makes the totals pessimistic -- but pessimistic in the same direction for every
// engine, which is the only thing a comparison needs. It is the same method that
// produced the table in docs/DEPLOY.md.
//
// It needs to run where Playwright and its browsers are, which is this image:
//
//     docker compose exec -T render node bin/bfwp-measure.js
//     docker compose exec -T render node bin/bfwp-measure.js --url https://example.org/
//     docker compose exec -T render node bin/bfwp-measure.js --engines chromium
//
// It is NOT part of the server and nothing imports it. It launches browsers of its
// own, next to whatever sessions the server is serving, so run it where the memory
// it borrows does not matter.

import fs from 'node:fs';

const USAGE = `Usage: node bin/bfwp-measure.js [options]

Loads one page in each engine Playwright ships and prints what it costs.

Options:
  --url <url>        the page to load (default https://example.com/)
  --engines <list>   comma-separated: chromium, chromium-low, webkit, firefox
                     (default: all of them)
  --timeout <ms>     how long to give a browser to launch and load (default 45000)
  -h, --help         this text

Run it inside the container, where the browsers are.`;

const args = process.argv.slice(2);
function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE);
  process.exit(0);
}

const PAGE = valueOf('--url') ?? 'https://example.com/';
const TIMEOUT_MS = Number(valueOf('--timeout') ?? 45000);
const WANTED = (valueOf('--engines') ?? 'chromium,chromium-low,webkit,firefox')
  .split(',').map((name) => name.trim()).filter(Boolean);

const mb = (bytes) => Math.round(bytes / 1048576);

function pids() {
  return fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
}

function rssBytes(pid) {
  try {
    // The second field of statm is the resident set, in pages.
    return Number(fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * 4096;
  } catch {
    // A process that exited between the listing and the read: it contributed
    // nothing to the peak, and a throw here would abort a measurement over a race.
    return 0;
  }
}

function cmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch {
    return '';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The same two lists as src/browser.js, written out here on purpose: a
 *  measurement that shares the code it is measuring cannot detect a change to it. */
const BASE_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--mute-audio',
];

const ENGINES = {
  'chromium': async (playwright) => playwright.chromium.launch({ headless: true, args: BASE_ARGS }),
  'chromium-low': async (playwright) => playwright.chromium.launch({
    headless: true,
    args: [
      ...BASE_ARGS,
      '--single-process',
      '--renderer-process-limit=1',
      '--js-flags=--max-old-space-size=128',
      '--disable-background-networking',
      '--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints',
    ],
  }),
  'webkit': async (playwright) => playwright.webkit.launch({ headless: true }),
  'firefox': async (playwright) => playwright.firefox.launch({ headless: true }),
};

async function measure(name, launch) {
  const before = new Set(pids());
  let browser = null;
  try {
    browser = await launch();
    const page = await browser.newPage({
      viewport: { width: 480, height: 800 },
      deviceScaleFactor: 2,
    });
    try {
      await page.goto(PAGE, { waitUntil: 'load', timeout: TIMEOUT_MS });
    } catch (error) {
      console.log(`  (${name}: the page said "${error.message}")`);
    }
    await sleep(4000);

    const fresh = pids().filter((pid) => !before.has(pid));
    const total = fresh.reduce((sum, pid) => sum + rssBytes(pid), 0);
    console.log(`${name}: ${mb(total)} MiB in ${fresh.length} process(es)`);
    for (const pid of fresh) {
      console.log(`    ${mb(rssBytes(pid))} MiB  ${cmdline(pid).slice(0, 88)}`);
    }
    return total;
  } catch (error) {
    // A browser that will not launch is a RESULT, not an interruption: it is how
    // Firefox was ruled out here.
    console.log(`${name}: did not launch: ${error.message}`);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await sleep(2000);
  }
}

const playwright = await import('playwright');
console.log(`page: ${PAGE}`);

const totals = {};
for (const name of WANTED) {
  const launch = ENGINES[name];
  if (!launch) {
    console.log(`${name}: no such engine (try ${Object.keys(ENGINES).join(', ')})`);
    continue;
  }
  totals[name] = await measure(name, () => launch(playwright));
}

const measured = Object.entries(totals).filter(([, bytes]) => bytes !== null);
if (measured.length > 1) {
  const cheapest = measured.reduce((lowest, entry) => (entry[1] < lowest[1] ? entry : lowest));
  console.log(`\ncheapest here: ${cheapest[0]}, ${mb(cheapest[1])} MiB`);
}
