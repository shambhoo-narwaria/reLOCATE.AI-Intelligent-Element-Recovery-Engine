import { Page } from 'playwright';
import { logger } from './debug-logger';
import { StatusOverlay } from '../runner/status-overlay';

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

const DOM_SETTLE_SILENCE_WINDOW_MS = 600;     // Time window of absolute silence required (no DOM changes)
const MIN_DOM_STABILITY_TIMEOUT_MS = 3000;    // Minimum time budget allowed for checking DOM mutations

/**
 * Stabilizes the page state by waiting for dynamic loading screens to hide,
 * and checking browser DOM mutation frequency until changes fully settle.
 * Capped at a maximum execution time of timeoutMs.
 */
export async function waitForPageSettle(page: Page, timeoutMs = 30000, statusOverlay?: StatusOverlay): Promise<void> {
  if (page.isClosed()) {
    logger.debug('[PageStabilizer] Aborting stabilization: Page is closed.');
    return;
  }

  const startTime = Date.now();
  logger.debug(`[PageStabilizer] Page stabilization started at ${new Date(startTime).toLocaleTimeString()}`);

  try {
    // Phase 1: Wait for visible loaders/spinners/skeletons to disappear
    for (const selector of LOADER_SELECTORS) {
      if (page.isClosed()) return;

      const elapsed = Date.now() - startTime;
      const remainingTime = timeoutMs - elapsed - 4000;
      
      if (remainingTime <= 0) {
        logger.debug('[PageStabilizer] Hard-limit budget reached. Skipping remaining loader checks.');
        break;
      }

      try {
        const loader = page.locator(selector).first();
        const isLoaderVisible = await loader.isVisible();
        
        if (isLoaderVisible) {
          const isInteractive = await loader.evaluate(el => {
            const interactiveTags = ['BUTTON', 'INPUT', 'A', 'SELECT', 'TEXTAREA'];
            if (interactiveTags.includes(el.tagName)) return true;
            const role = el.getAttribute('role');
            if (role === 'button' || role === 'link') return true;
            return false;
          }).catch(() => false);

          if (isInteractive) continue;

          const isWrapperOrContainer = await loader.evaluate(el => {
            const className = (el.className || '').toLowerCase();
            const id = (el.id || '').toLowerCase();
            const combined = className + ' ' + id;
            const containerKeywords = ['wrapper', 'container', 'box', 'holder', 'parent', 'block', 'layout', 'zone'];
            return containerKeywords.some(kw => combined.includes(kw));
          }).catch(() => false);

          if (isWrapperOrContainer) continue;

          const text = await loader.innerText().catch(() => '');
          if (text.trim().length > 150) continue;

          const maxWait = Math.min(35000, remainingTime);
          logger.debug(`[PageStabilizer] Active loader detected: "${selector}". Awaiting transition to hidden...`);
          await page.waitForSelector(selector, { state: 'hidden', timeout: maxWait });
        }
      } catch (err) {
        // Ignored: Loader timed out or got detached from DOM tree during wait
      }
    }

    if (page.isClosed()) {
      logger.debug('[PageStabilizer] Aborting stabilization: Page closed after loader loop.');
      return;
    }

    // Phase 2: Monitor DOM activity and wait for mutations to settle
    const elapsed = Date.now() - startTime;
    const remainingDomWait = Math.max(MIN_DOM_STABILITY_TIMEOUT_MS, timeoutMs - elapsed);

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

    // Phase 2.5: Wait for all image elements to complete loading
    try {
      const remainingTime = timeoutMs - (Date.now() - startTime);
      if (remainingTime > 0) {
        const imageTimeout = Math.min(4000, remainingTime);
        logger.debug(`[PageStabilizer] Awaiting image resources to load (max wait: ${imageTimeout}ms)...`);

        // Wait for image resources to load
        await statusOverlay?.show(page, 'IMAGELOAD');

        // Wait for image elements to complete loading
        await page.waitForFunction(() => {
          const images = Array.from(document.querySelectorAll('img'));
          return images.every(img => img.complete);
        }, { timeout: imageTimeout }).catch(() => {
          logger.debug('[PageStabilizer] Image loading wait timed out or was bypassed.');
        });
      }
    } catch (imgErr) {
      // Ignored
    }

    // Phase 3: Force layout engine calculation (reflow check)
    await page.evaluate(() => {
      if (document.body) {
        document.body.getBoundingClientRect();
      }
    });

    const totalDuration = Date.now() - startTime;
    logger.debug(`[PageStabilizer] Page stabilization successfully completed. Total duration: ${totalDuration}ms`);
  } catch (err: any) {
    const errorMsg = err.message || String(err);
    const totalDuration = Date.now() - startTime;
    if (errorMsg.includes('closed') || errorMsg.includes('Target page, context or browser has been closed')) {
      logger.debug(`[PageStabilizer] Aborting stabilization: Browser context was closed. (after ${totalDuration}ms)`);
      return;
    }
    logger.debug(`[PageStabilizer] Stabilization wait encountered an error (after ${totalDuration}ms): ${errorMsg}`);
  }
}
