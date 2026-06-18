import { Page } from 'playwright';
import { logger } from '../logger/debug-logger';

export class StatusOverlay {
  private originalTitle: string | null = null;
  private currentAlign: 'left' | 'right' = 'right';

  getCurrentAlign(): 'left' | 'right' {
    return this.currentAlign;
  }

  async show(
    page: Page,
    phase: 'STABILIZE' | 'SCRAPE' | 'PRUNE' | 'VISUAL' | 'AI' | 'SAFETY' | 'VALIDATE' | 'COMPLETE' | 'FAILED' | 'NAVIGATING' | 'LOCATING' | 'RETRYING' | 'INTERACTING',
    details?: { current?: number; total?: number; align?: 'left' | 'right'; candidateRect?: { left: number; top: number; width: number; height: number } | null }
  ): Promise<void> {
    const HEALING_PHASES: Record<string, { simple: string; tough: string }> = {
      NAVIGATING: {
        simple: "Connecting to target page URL...",
        tough: "Initializing target page context..."
      },
      LOCATING: {
        simple: "Locating primary target element...",
        tough: "Resolving dynamic locator bindings..."
      },
      RETRYING: {
        simple: "Re-locating original target element...",
        tough: "Re-indexing entire DOM hierarchy..."
      },
      INTERACTING: {
        simple: "Interacting with target element...",
        tough: "Dispatching synthetic DOM click events..."
      },
      STABILIZE: {
        simple: "Waiting for entire page to settle...",
        tough: "Awaiting stable DOM layout state..."
      },
      SCRAPE: {
        simple: "Locating target page element...",
        tough: "Compiling complete element inventory..."
      },
      PRUNE: {
        simple: "Locating target candidate region...",
        tough: "Executing heuristic topology pruning..."
      },
      VISUAL: {
        simple: "Verifying target element appearance...",
        tough: "Analyzing spatial 2D edge contours..."
      },
      AI: {
        simple: "Resolving target element attributes...",
        tough: "Querying neural cognitive reasoning engine..."
      },
      SAFETY: {
        simple: "Verifying target element similarity...",
        tough: "Evaluating Wagner-Fischer edit distances..."
      },
      VALIDATE: {
        simple: "Checking element actionability state...",
        tough: "Assessing dynamic visibility vectors..."
      },
      COMPLETE: {
        simple: "Interacting with healed target...",
        tough: "Dynamic locator healing successful..."
      },
      FAILED: {
        simple: "Target element not found.",
        tough: "Locator confidence threshold mismatch..."
      }
    };

    const phaseInfo = HEALING_PHASES[phase];
    if (!phaseInfo) return;

    if (details?.align) {
      this.currentAlign = details.align;
    } else if (details?.candidateRect) {
      const rect = details.candidateRect;
      const viewportWidth = await page.evaluate(() => window.innerWidth).catch(() => 1920);
      const viewportHeight = await page.evaluate(() => window.innerHeight).catch(() => 1080);

      const candLeft = rect.left;
      const candRight = rect.left + rect.width;
      const candTop = rect.top;
      const candBottom = rect.top + rect.height;

      if (this.currentAlign === 'right') {
        const ovLeft = viewportWidth - 340;
        const ovRight = viewportWidth - 20;
        const ovTop = 20;
        const ovBottom = 220;

        const overlaps = (candLeft < ovRight && candRight > ovLeft && candTop < ovBottom && candBottom > ovTop);
        if (overlaps) {
          this.currentAlign = 'left';
          logger.debug(`[StatusOverlay] Candidate overlaps with top-right overlay. Relocating overlay to bottom-left.`);
        }
      } else {
        const ovLeft = 20;
        const ovRight = 340;
        const ovTop = viewportHeight - 220;
        const ovBottom = viewportHeight - 20;

        const overlaps = (candLeft < ovRight && candRight > ovLeft && candTop < ovBottom && candBottom > ovTop);
        if (overlaps) {
          this.currentAlign = 'right';
          logger.debug(`[StatusOverlay] Candidate overlaps with bottom-left overlay. Relocating overlay to top-right.`);
        }
      }
    }

    let toughText = phaseInfo.tough;
    let simpleText = phaseInfo.simple;

    if (phase === 'VISUAL' && details?.current !== undefined && details?.total !== undefined) {
      toughText = `Computing Jaccard.. contour coeffi..: ${details.current}...`;
      simpleText = `Verifying target element appearance...`;
    }

    try {
      // 1. Update document title prefix
      if (this.originalTitle === null) {
        this.originalTitle = await page.title().catch(() => '');
      }
      const titlePrefix = `[RelocateAI: ${phaseInfo.simple}] `;
      await page.evaluate((prefix) => {
        const cleanTitle = document.title.replace(/^\[RelocateAI:[^\]]+\]\s*/, '');
        document.title = prefix + cleanTitle;
      }, titlePrefix);

      // 2. Inject or update glassmorphic status card on page
      const isVisual = (phase === 'VISUAL');
      await page.evaluate(({ tough, simple, isVisual, align }) => {
        let overlay = document.getElementById('__ai-healing-status-overlay__');
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = '__ai-healing-status-overlay__';
          overlay.style.cssText = [
            'position: fixed',
            'top: 20px',
            'right: 20px',
            'width: 320px',
            'padding: 16px',
            'background: rgba(20, 26, 34, 0.9)', // Deep Black-Grey Base (#141A22) with opacity
            'backdrop-filter: blur(12px)',
            '-webkit-backdrop-filter: blur(12px)',
            'border: 1px solid rgba(61, 78, 97, 0.7)', // Slate Blue Contrast (#3D4E61) with opacity
            'border-left: 4px solid #FFBA69', // Orange/Peach Accent (#FFBA69) left border highlight
            'border-radius: 12px',
            'box-shadow: 0 10px 40px -10px rgba(0, 0, 0, 0.5), inset 0 1px 1px rgba(255, 255, 255, 0.05)',
            'z-index: 2147483646',
            'pointer-events: none',
            'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
            'color: #ffffff',
            'box-sizing: border-box',
            'transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
          ].join(';');

          const header = document.createElement('div');
          header.id = '__ai-healing-status-header__';
          header.style.cssText = [
            'font-size: 11px',
            'font-weight: 700',
            'letter-spacing: 2.5px',
            'color: #FFBA69', // Orange/Peach Accent (#FFBA69) for header
            'margin-bottom: 8px',
            'display: flex',
            'align-items: center'
          ].join(';');
          header.innerText = 'reLOCATE.AI ENGINE';

          // Glowing active indicator dot
          const dot = document.createElement('span');
          dot.style.cssText = [
            'display: inline-block',
            'width: 6px',
            'height: 6px',
            'background-color: #FFBA69',
            'border-radius: 50%',
            'box-shadow: 0 0 6px #FFBA69',
            'margin-right: 6px',
            'vertical-align: middle'
          ].join(';');
          header.prepend(dot);

          const toughLabel = document.createElement('div');
          toughLabel.id = '__ai-healing-status-tough__';
          toughLabel.style.cssText = [
            'font-size: 13px',
            'font-weight: 600',
            'line-height: 1.4',
            'margin-bottom: 10px',
            'margin-left: 12px',
            'color: #ffffff'
          ].join(';');

          const simpleLabel = document.createElement('div');
          simpleLabel.id = '__ai-healing-status-simple__';
          simpleLabel.style.cssText = [
            'font-size: 11px',
            'line-height: 1.35',
            'color: #e2e8f0', // Soft readable light gray text
            'background: rgba(40, 51, 68, 0.5)', // Dark Blue-Grey Base (#283344) with opacity
            'border: 1px solid rgba(61, 78, 97, 0.4)', // Slate Blue Contrast (#3D4E61) with opacity
            'border-radius: 6px',
            'padding: 8px 10px',
            'margin-top: 4px',
            'margin-left: 2px'
          ].join(';');

          overlay.appendChild(header);
          overlay.appendChild(toughLabel);
          overlay.appendChild(simpleLabel);
          document.body.appendChild(overlay);
        }

        // Apply dynamic layout shifts based on phase and element alignment
        if (align === 'left') {
          // Move to bottom-left corner to avoid candidate in top-right area
          overlay.style.top = 'auto';
          overlay.style.bottom = '20px';
          overlay.style.right = 'auto';
          overlay.style.left = '20px';
          overlay.style.borderLeft = '1px solid rgba(61, 78, 97, 0.7)';
          overlay.style.borderRight = '4px solid #FFBA69';
        } else {
          // Default/restore to top-right corner
          overlay.style.top = '20px';
          overlay.style.right = '20px';
          overlay.style.bottom = 'auto';
          overlay.style.left = 'auto';
          overlay.style.borderLeft = '4px solid #FFBA69';
          overlay.style.borderRight = '1px solid rgba(61, 78, 97, 0.7)';
        }

        const toughEl = document.getElementById('__ai-healing-status-tough__');
        const simpleEl = document.getElementById('__ai-healing-status-simple__');
        if (toughEl) toughEl.innerText = tough;
        if (simpleEl) simpleEl.innerText = simple;
      }, { tough: toughText, simple: simpleText, isVisual, align: this.currentAlign });
    } catch (err: any) {
      // Silently ignore browser context errors during navigation
    }
  }

  async hide(page: Page): Promise<void> {
    try {
      // 1. Restore original document title
      if (this.originalTitle !== null) {
        const titleToRestore = this.originalTitle;
        await page.evaluate((original) => {
          document.title = original;
        }, titleToRestore);
        this.originalTitle = null;
      }

      // 2. Remove visual overlay from the DOM
      await page.evaluate(() => {
        const overlay = document.getElementById('__ai-healing-status-overlay__');
        if (overlay) overlay.remove();
      });
    } catch (err: any) {
      // Silently ignore browser context errors during navigation
    }
  }
}
