import { Page } from 'playwright';
import { logger } from './debug-logger';

// Common loader selectors to check for page loading spinners, skeletons, or overlay blocks
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

const ABSOLUTE_MAX_DURATION_MS = 30000;       // 30s absolute maximum execution time limit
const DOM_SETTLE_SILENCE_WINDOW_MS = 400;     // Time window of absolute silence required (no DOM changes)
const MIN_DOM_STABILITY_TIMEOUT_MS = 1000;    // Minimum time budget allowed for checking DOM mutations

/**
 * Stabilizes the page state by waiting for dynamic loading screens to hide,
 * and checking browser DOM mutation frequency until changes fully settle.
 * Capped at a maximum execution time of 30 seconds.
 */
export async function waitForPageSettle(page: Page, timeoutMs = 15000): Promise<void> {
  if (page.isClosed()) {
    logger.debug('[PageStabilizer] Aborting stabilization: Page is closed.');
    return;
  }

  const startTime = Date.now();
  console.log(`[PageStabilizer] Page stabilization started at ${new Date(startTime).toLocaleTimeString()}`);
  logger.debug(`[PageStabilizer] Page stabilization started at ${new Date(startTime).toLocaleTimeString()}`);

  try {
    // Phase 1: Wait for visible loaders/spinners/skeletons to disappear
    const phase1Start = Date.now();
    for (const selector of LOADER_SELECTORS) {
      if (page.isClosed()) return;

      const elapsed = Date.now() - startTime;
      const remainingTime = ABSOLUTE_MAX_DURATION_MS - elapsed - 4000;
      
      if (remainingTime <= 0) {
        logger.debug('[PageStabilizer] Hard-limit budget reached. Skipping remaining loader checks.');
        break;
      }

      try {
        const loader = page.locator(selector).first();
        if (await loader.isVisible()) {
          logger.debug(`[PageStabilizer] Active loader detected: "${selector}". Awaiting transition to hidden...`);
          const maxWait = Math.min(3000, remainingTime);
          await page.waitForSelector(selector, { state: 'hidden', timeout: maxWait });
        }
      } catch (err) {
        // Ignored: Loader timed out or got detached from DOM tree during wait
      }
    }
    const phase1Duration = Date.now() - phase1Start;
    if (page.isClosed()) {
      logger.debug('[PageStabilizer] Aborting stabilization: Page closed after loader loop.');
      return;
    }

    // Phase 2: Monitor DOM activity and wait for mutations to settle
    const phase2Start = Date.now();
    const elapsed = Date.now() - startTime;
    const remainingDomWait = Math.max(MIN_DOM_STABILITY_TIMEOUT_MS, ABSOLUTE_MAX_DURATION_MS - elapsed);

    logger.debug(`[PageStabilizer] Monitoring DOM stability (max wait: ${remainingDomWait}ms)...`);
    
    await page.evaluate(
      async ({ silenceWindow, maxWait }) => {
        return new Promise<void>((resolve) => {
          if (!document.body) {
            resolve();
            return;
          }

          let lastMutationTime = Date.now();
          const observer = new MutationObserver(() => {
            lastMutationTime = Date.now();
          });

          // Start observing layout shifts, attribute changes, style changes, or text updates
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
          });

          // Check mutation timing periodically every 100ms
          const intervalId = setInterval(() => {
            const idleDuration = Date.now() - lastMutationTime;
            if (idleDuration >= silenceWindow) {
              cleanup();
              resolve();
            }
          }, 100);

          // Enforce safety boundary timeout to prevent hanging on dynamic pages
          const timeoutId = setTimeout(() => {
            cleanup();
            resolve();
          }, maxWait);

          function cleanup() {
            observer.disconnect();
            clearInterval(intervalId);
            clearTimeout(timeoutId);
          }
        });
      },
      { silenceWindow: DOM_SETTLE_SILENCE_WINDOW_MS, maxWait: remainingDomWait }
    );
    const phase2Duration = Date.now() - phase2Start;

    // Phase 3: Force layout engine calculation (reflow check)
    const phase3Start = Date.now();
    await page.evaluate(() => {
      if (document.body) {
        document.body.getBoundingClientRect();
      }
    });
    const phase3Duration = Date.now() - phase3Start;

    const totalDuration = Date.now() - startTime;
    console.log(`[PageStabilizer] Page stabilization successfully completed. Total duration: ${totalDuration}ms`);
    logger.debug(`[PageStabilizer] Page stabilization successfully completed. Total duration: ${totalDuration}ms`);
  } catch (err: any) {
    const errorMsg = err.message || String(err);
    const totalDuration = Date.now() - startTime;
    if (errorMsg.includes('closed') || errorMsg.includes('Target page, context or browser has been closed')) {
      console.log(`[PageStabilizer] Aborting stabilization: Browser context was closed. (after ${totalDuration}ms)`);
      logger.debug(`[PageStabilizer] Aborting stabilization: Browser context was closed. (after ${totalDuration}ms)`);
      return;
    }
    console.log(`[PageStabilizer] Stabilization wait encountered an error (after ${totalDuration}ms): ${errorMsg}`);
    logger.debug(`[PageStabilizer] Stabilization wait encountered an error (after ${totalDuration}ms): ${errorMsg}`);
  }
}
