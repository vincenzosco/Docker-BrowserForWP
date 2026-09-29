// The Chromium side: one page per device, screencast frames out, input in.
//
// Everything here needs a real browser, so nothing here is unit-tested. The
// split exists so that is not a problem: the protocol, the sealing, the tokens
// and the session state machine are all pure and covered by test/, and this file
// is the thin part that has to be exercised against a running container.
//
// Playwright is imported LAZILY, inside create(). A static import would make
// `npm test` require a Chromium download, which would quietly turn this
// repository's test suite into something that cannot run in CI without a 400 MB
// dependency it does not otherwise need.
//
// The screencast is Chromium's own: Page.startScreencast hands back a JPEG each
// time the page changes, acknowledged with Page.screencastFrameAck. Frames are
// therefore never queued by us on a slow link -- the SESSION decides when to ask
// for the next one, and this file only starts and stops the tap.

import { FRAME_FLAG_FULL, LoadState } from '../protocol/index.js';

const AD_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adservice.google.com',
  'scorecardresearch.com',
  'adnxs.com',
  'criteo.com',
  'outbrain.com',
  'taboola.com',
];

const NIGHT_MODE_CSS = `
html { background: #101010 !important; }
body { background: #101010 !important; color: #d8d8d8 !important; }
* { background-color: transparent !important; color: inherit !important; border-color: #303030 !important; }
img, video { opacity: 0.82 !important; }
a, a * { color: #6fb3ff !important; }
`;

const DESKTOP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/**
 * @returns a factory whose create() resolves to the object src/session.js drives.
 *          The shape is deliberately small: navigate, back, forward, reload,
 *          stop, tap, scroll, key, text, resize, applySettings, find, startFrames,
 *          stopFrames, close.
 */
export function createPlaywrightBrowserFactory({ config, log }) {
  let browserPromise = null;
  const pages = new Map();

  async function browser() {
    if (!browserPromise) {
      browserPromise = (async () => {
        const { chromium } = await import('playwright');
        log.info('launching chromium');
        return chromium.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--force-color-profile=srgb',
            '--hide-scrollbars',
            '--mute-audio',
          ],
        });
      })();
    }
    return browserPromise;
  }

  return {
    async create({ deviceId, viewport, onEvent }) {
      const instance = await browser();
      const context = await instance.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.dpr,
        userAgent: MOBILE_USER_AGENT,
        locale: viewport.locale || 'en-US',
        ignoreHTTPSErrors: false,
      });

      if (config.blockAds) {
        await context.route('**/*', (route) => {
          let host = '';
          try {
            host = new URL(route.request().url()).hostname;
          } catch {
            return route.continue();
          }
          if (AD_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) {
            return route.abort();
          }
          return route.continue();
        });
      }

      const page = await context.newPage();
      page.setDefaultTimeout(config.pageTimeoutMs);

      const cdp = await context.newCDPSession(page);
      let framesRunning = false;
      let nightStyleHandle = null;
      let desktopMode = false;

      cdp.on('Page.screencastFrame', async (event) => {
        try {
          onEvent({
            kind: 'frame',
            jpeg: Buffer.from(event.data, 'base64'),
            width: event.metadata?.deviceWidth ?? viewport.width,
            height: event.metadata?.deviceHeight ?? viewport.height,
            flags: FRAME_FLAG_FULL,
          });
        } finally {
          try {
            await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
          } catch {
            // The session may have gone away between the frame and the ack.
          }
        }
      });

      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) onEvent({ kind: 'url', url: frame.url() });
      });
      page.on('domcontentloaded', () => onEvent({ kind: 'load', state: LoadState.STARTED, detail: '' }));
      page.on('load', async () => {
        onEvent({ kind: 'load', state: LoadState.DONE, detail: '' });
        try {
          onEvent({ kind: 'title', title: await page.title() });
        } catch {
          // A page can close itself between load and title().
        }
      });
      page.on('pageerror', (error) => log.debug('page error', error.message));

      const browserHandle = {
        deviceId,
        page,

        async navigate(url) {
          onEvent({ kind: 'load', state: LoadState.STARTED, detail: '' });
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMs });
          } catch (error) {
            onEvent({ kind: 'load', state: LoadState.FAILED, detail: error.message });
          }
        },

        async back() {
          try {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMs });
          } catch {
            onEvent({ kind: 'load', state: LoadState.FAILED, detail: 'no previous page' });
          }
        },

        async forward() {
          try {
            await page.goForward({ waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMs });
          } catch {
            onEvent({ kind: 'load', state: LoadState.FAILED, detail: 'no next page' });
          }
        },

        async reload() {
          try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMs });
          } catch (error) {
            onEvent({ kind: 'load', state: LoadState.FAILED, detail: error.message });
          }
        },

        async stop() {
          try {
            await page.evaluate(() => window.stop());
          } catch {
            // Nothing to stop is not a failure.
          }
        },

        async tap({ x, y, clickCount = 1 }) {
          try {
            await page.mouse.click(x, y, { clickCount, delay: 20 });
          } catch (error) {
            log.debug('tap failed', error.message);
          }
        },

        async scroll({ x, y, deltaX, deltaY }) {
          try {
            await page.mouse.move(x, y);
            await page.mouse.wheel(deltaX, deltaY);
          } catch (error) {
            log.debug('scroll failed', error.message);
          }
        },

        async key({ key, text }) {
          try {
            if (text) await page.keyboard.insertText(text);
            else await page.keyboard.press(key);
          } catch (error) {
            log.debug('key failed', error.message);
          }
        },

        /**
         * Whether the page's focused element can take text.
         *
         * One evaluate, because the question is about the DOCUMENT and the
         * document is the only place that knows: an <input> with a type nobody
         * types into (button, checkbox, submit, radio, file, image) holds focus
         * without accepting a keystroke, contenteditable holds focus and does,
         * and nothing else does. Mirroring this in the session would need the
         * session to know about HTML, so the answer is produced here.
         *
         * Returns False rather than throwing when the page cannot be asked: a
         * focus report is worth a great deal less than the navigation it would
         * otherwise break.
         */
        async focus() {
          try {
            // The list lives INSIDE this function on purpose: page.evaluate
            // serialises it and runs it in the page, where a closure variable
            // from here does not exist. A Set defined outside would be a
            // ReferenceError at the first tap.
            const editable = await page.evaluate(() => {
              const NOT_TEXT = [
                'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio',
                'range', 'reset', 'submit',
              ];
              const active = document.activeElement;
              if (!active || active === document.body || active === document.documentElement) {
                return false;
              }
              if (active.isContentEditable) return true;
              const tag = active.tagName;
              if (tag === 'TEXTAREA') return true;
              if (tag !== 'INPUT') return false;
              const type = (active.getAttribute('type') || 'text').toLowerCase();
              return NOT_TEXT.indexOf(type) < 0;
            });
            return { editable: editable === true };
          } catch (error) {
            log.debug('focus query failed', error.message);
            return { editable: false };
          }
        },

        async text({ text }) {
          try {
            await page.keyboard.insertText(text);
          } catch (error) {
            log.debug('text failed', error.message);
          }
        },

        async resize({ width, height, devicePixelRatio }) {
          try {
            await page.setViewportSize({ width, height });
            if (devicePixelRatio) {
              await cdp.send('Emulation.setDeviceMetricsOverride', {
                width,
                height,
                deviceScaleFactor: devicePixelRatio,
                mobile: true,
              });
            }
          } catch (error) {
            log.debug('resize failed', error.message);
          }
        },

        async applySettings({ nightMode, desktopMode: wantsDesktop }) {
          try {
            if (Boolean(wantsDesktop) !== desktopMode) {
              desktopMode = Boolean(wantsDesktop);
              await cdp.send('Emulation.setUserAgentOverride', {
                userAgent: desktopMode ? DESKTOP_USER_AGENT : MOBILE_USER_AGENT,
              });
            }
            if (nightMode && !nightStyleHandle) {
              nightStyleHandle = await page.addStyleTag({ content: NIGHT_MODE_CSS });
            } else if (!nightMode && nightStyleHandle) {
              await nightStyleHandle.evaluate((node) => node.remove());
              nightStyleHandle = null;
            }
          } catch (error) {
            log.debug('settings failed', error.message);
          }
        },

        async find({ text }) {
          try {
            return await page.evaluate((needle) => {
              const haystack = (document.body ? document.body.innerText : '').toLowerCase();
              const lowered = needle.toLowerCase();
              let matches = 0;
              let cursor = 0;
              while (lowered.length > 0) {
                const at = haystack.indexOf(lowered, cursor);
                if (at === -1) break;
                matches += 1;
                cursor = at + lowered.length;
              }
              const found = window.find(needle, false, false, true, false, false, false);
              return { found: Boolean(found), matches };
            }, text);
          } catch (error) {
            log.debug('find failed', error.message);
            return { found: false, matches: 0 };
          }
        },

        /** Start the screencast tap. Called only when no frame is in flight. */
        async startFrames() {
          if (framesRunning) return;
          framesRunning = true;
          try {
            await cdp.send('Page.startScreencast', {
              format: 'jpeg',
              quality: config.frameQuality,
              maxWidth: config.viewportWidth * config.devicePixelRatio,
              maxHeight: config.viewportHeight * config.devicePixelRatio,
              everyNthFrame: 1,
            });
          } catch (error) {
            framesRunning = false;
            log.warn('could not start the screencast', error.message);
          }
        },

        /** Stop it, which is how backpressure is applied on a slow link. */
        async stopFrames() {
          if (!framesRunning) return;
          framesRunning = false;
          try {
            await cdp.send('Page.stopScreencast');
          } catch {
            // Already stopped.
          }
        },

        async capture() {
          try {
            return await page.screenshot({ type: 'jpeg', quality: config.frameQuality });
          } catch {
            return null;
          }
        },

        async close() {
          pages.delete(deviceId);
          try {
            await context.close();
          } catch {
            // The browser may already be gone.
          }
        },
      };

      pages.set(deviceId, browserHandle);
      return browserHandle;
    },

    get openPages() {
      return pages.size;
    },

    async close() {
      if (!browserPromise) return;
      const instance = await browserPromise.catch(() => null);
      if (instance) await instance.close().catch(() => {});
      browserPromise = null;
    },
  };
}
