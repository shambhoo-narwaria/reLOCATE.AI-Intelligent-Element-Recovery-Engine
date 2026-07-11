import { Page } from 'playwright';
import { logger } from './debug-logger';
import { StatusOverlay } from './status-overlay';

// CSS selectors for common loading spinners, skeletons, and overlay blocks
const LOADER_SELECTORS = [
  '[class*="spinner"]',
  '[class*="loader"]',
  '[class*="loading"]',
  '[aria-busy="true"]',
  'mat-spinner',
  'zui-spinner',
  '[class*="skeleton"]',
  '[data-test*="skeleton"]'
];

const DOM_SETTLE_SILENCE_WINDOW_MS = 600;  // ms of DOM silence required before settling

/**
 * Waits for the page to fully stabilize — hides loaders, settles DOM mutations,
 * and waits for images to finish loading. Capped at `timeoutMs`.
 */
export async function waitForPageSettle(page: Page, timeoutMs = 30000, statusOverlay?: StatusOverlay): Promise<void> {
  console.log(`[PageStabilizer] Waiting for page to settle max time: ${timeoutMs}ms`);
  const startTime = Date.now();

  // Phase 1: Wait for loaders/spinners/skeletons to disappear
  try {
    for (const selector of LOADER_SELECTORS) {
      const remainingTime = timeoutMs - (Date.now() - startTime);
      if (remainingTime <= 0) break;

      const loader = page.locator(selector).first();
      if (!await loader.isVisible()) continue;

      // Skip interactive elements
      const isInteractive = await loader.evaluate(el => {
        const interactiveTags = ['BUTTON', 'INPUT', 'A', 'SELECT', 'TEXTAREA'];
        if (interactiveTags.includes(el.tagName)) return true;
        const role = el.getAttribute('role');
        return role === 'button' || role === 'link';
      }).catch(() => false);
      if (isInteractive) continue;

      // Skip container/wrapper elements
      const isContainer = await loader.evaluate(el => {
        const combined = `${el.className || ''} ${el.id || ''}`.toLowerCase();
        return ['wrapper', 'container', 'box', 'holder', 'parent', 'block', 'layout', 'zone'].some(kw => combined.includes(kw));
      }).catch(() => false);
      if (isContainer) continue;

      const text = await loader.innerText().catch(() => '');
      if (text.trim().length > 150) continue;

      await page.waitForSelector(selector, { state: 'hidden', timeout: remainingTime });
    }
  } catch (err: any) {
    logger.debug(`[PageStabilizer] Settle error: ${err.message || err}`);
  }

  // Phase 2: Wait for DOM mutations to settle
  try {
    const elapsed = Date.now() - startTime;
    const domWaitBudget = Math.max(0, timeoutMs - elapsed);

    await page.evaluate(
      async ({ silenceWindow, maxWait }) => {
        return new Promise<void>(resolve => {
          if (!document.body) { resolve(); return; }

          let lastMutationTime = Date.now();
          const observer = new MutationObserver(() => { lastMutationTime = Date.now(); });
          observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

          const intervalId = setInterval(() => { if (Date.now() - lastMutationTime >= silenceWindow) { cleanup(); resolve(); } }, 100);
          const timeoutId = setTimeout(() => { cleanup(); resolve(); }, maxWait);

          function cleanup() {
            observer.disconnect();
            clearInterval(intervalId);
            clearTimeout(timeoutId);
          }
        });
      },
      { silenceWindow: DOM_SETTLE_SILENCE_WINDOW_MS, maxWait: domWaitBudget }
    );
  } catch (err: any) {
    logger.debug(`[PageStabilizer] Settle error: ${err.message || err}`);
  }

  // Phase 3: Wait for images to finish loading
  try {
    const remainingTime = timeoutMs - (Date.now() - startTime);
    if (remainingTime > 0) {
      await statusOverlay?.show(page, 'IMAGELOAD');
      await page.waitForFunction(() => Array.from(document.querySelectorAll('img')).every(img => img.complete), { timeout: remainingTime });
    }
  } catch (err: any) {
    logger.debug(`[PageStabilizer] Settle error: ${err.message || err}`);
  }

  // Phase 4: Force layout reflow
  try {
    await page.evaluate(() => { document.body?.getBoundingClientRect(); });
  } catch (err: any) {
    logger.debug(`[PageStabilizer] Settle error: ${err.message || err}`);
  }
}
