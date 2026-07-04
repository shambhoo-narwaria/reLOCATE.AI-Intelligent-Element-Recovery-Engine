import { Page, Locator } from 'playwright';
import { logger } from '../utils/debug-logger';

// Type definitions for overlay phases and positioning
export type OverlayPhase =
  | 'STABILIZE'
  | 'IMAGELOAD'
  | 'SCRAPE'
  | 'PRUNE'
  | 'VISUAL'
  | 'AI'
  | 'SAFETY'
  | 'VALIDATE'
  | 'COMPLETE'
  | 'FAILED'
  | 'NAVIGATING'
  | 'LOCATING'
  | 'RETRYING'
  | 'INTERACTING';

export interface BoundingRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ShowDetails {
  current?: number;
  total?: number;
  align?: 'left' | 'right';
  candidateRect?: BoundingRect | null;
  element?: Locator;
}

// User-facing text mapping for healing engine phases
const HEALING_PHASES: Record<OverlayPhase, { simple: string; tough: string }> = {
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
    tough: "Retrying original locator bindings..."
  },
  INTERACTING: {
    simple: "Interacting with target element...",
    tough: "Dispatching synthetic DOM click events..."
  },
  STABILIZE: {
    simple: "Waiting for entire page to settle...",
    tough: "Awaiting stable DOM layout state..."
  },
  IMAGELOAD: {
    simple: "Wait for Loading image elements...",
    tough: "Awaiting image resource resolution..."
  },
  SCRAPE: {
    simple: "Locating target page element...",
    tough: "Re-indexing entire DOM hierarchy..."
  },
  PRUNE: {
    simple: "Locating target candidate region...",
    tough: "Executing heuristic topology pruning..."
  },
  VISUAL: {
    simple: "Evaluating spatial similarity...",
    tough: "Evaluating MinMax Jaccard contours..."
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

export class StatusOverlay {
  private originalTitle: string | null = null;
  private currentAlign: 'left' | 'right' = 'right';
  private currentObjectName: string = '';

  getCurrentAlign(): 'left' | 'right' {
    return this.currentAlign;
  }

  setObjectName(name: string): void {
    const cleanName = name.trim();
    this.currentObjectName = cleanName.length > 7 ? cleanName.substring(0, 7) + '...' : cleanName;
  }

  /**
   * Primary entrypoint to display/update the healing overlay on the page.
   */
  async show(page: Page, phase: OverlayPhase, details?: ShowDetails): Promise<void> {
    const phaseInfo = HEALING_PHASES[phase];
    if (!phaseInfo) return;

    // 1. Resolve bounding client rect for alignment checking
    const candRect = await this.resolveCandidateRect(details);
    if (details?.align) {
      this.currentAlign = details.align;
    } else if (candRect) {
      await this.adjustOverlayAlignment(page, candRect);
    }

    // 2. Format simple and tough status strings
    let simpleText = phaseInfo.simple;
    const toughText = phaseInfo.tough;

    if (details?.current !== undefined) {
      if (phase === 'VISUAL') {
        simpleText = `Evaluating spatial similarity for candidate ${details.current} of {{DOM_COUNT}}...`;
      } else if (phase === 'SCRAPE') {
        if (details.total !== undefined) {
          simpleText = `Locating target page element on attempt ${details.current} of ${details.total}...`;
        } else {
          simpleText = `Locating target page element on attempt ${details.current}...`;
        }
      } else {
        if (details.total !== undefined) {
          simpleText = `${simpleText} (attempt ${details.current} of ${details.total})`;
        } else {
          simpleText = `${simpleText} (attempt ${details.current})`;
        }
      }
    }

    // 3. Perform Page UI / Title Updates
    try {
      await this.updatePageTitle(page, simpleText);
      await this.updateBrowserOverlay(page, simpleText, toughText);
    } catch (err) {
      // Silently ignore browser context errors during navigation (e.g. detached frames)
    }
  }

  /**
   * Restores the page title and removes the overlay from the DOM.
   */
  async hide(page: Page): Promise<void> {
    try {
      if (this.originalTitle !== null) {
        const titleToRestore = this.originalTitle;
        await page.evaluate((original) => {
          document.title = original;
        }, titleToRestore);
        this.originalTitle = null;
      }

      await page.evaluate(() => {
        const overlay = document.getElementById('__ai-healing-status-overlay__');
        if (overlay) overlay.remove();
      });
    } catch (err) {
      // Silently ignore browser context errors
    }
  }

  /**
   * Resolves the viewport-relative bounding rect, either directly or via evaluating the locator.
   */
  private async resolveCandidateRect(details?: ShowDetails): Promise<BoundingRect | null> {
    if (details?.candidateRect) {
      return details.candidateRect;
    }

    if (details?.element) {
      try {
        return await details.element.evaluate((el) => {
          const getElementRectWithFallback = (element: Element): DOMRect => {
            const rect = element.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return rect;
            const slots = element.tagName.toLowerCase() === 'slot' ? [element] : Array.from(element.querySelectorAll('slot'));
            for (const slot of slots) {
              if (typeof (slot as any).assignedNodes === 'function') {
                const assigned = (slot as HTMLSlotElement).assignedNodes({ flatten: true });
                for (const node of assigned) {
                  if (node.nodeType === Node.ELEMENT_NODE) {
                    const r = (node as Element).getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) return r;
                  }
                }
              }
            }
            for (const child of Array.from(element.children)) {
              const r = getElementRectWithFallback(child);
              if (r.width > 0 && r.height > 0) return r;
            }
            if (element.shadowRoot) {
              for (const child of Array.from(element.shadowRoot.children)) {
                const r = getElementRectWithFallback(child);
                if (r.width > 0 && r.height > 0) return r;
              }
            }
            return rect;
          };

          const rect = getElementRectWithFallback(el);
          return {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
          };
        });
      } catch (err) {
        // Evaluate failed, return null
      }
    }

    return null;
  }

  /**
   * Dynamically repositions the status overlay if it overlaps with the candidate rect.
   */
  private async adjustOverlayAlignment(page: Page, rect: BoundingRect): Promise<void> {
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
      }
    } else {
      const ovLeft = 20;
      const ovRight = 340;
      const ovTop = viewportHeight - 220;
      const ovBottom = viewportHeight - 20;

      const overlaps = (candLeft < ovRight && candRight > ovLeft && candTop < ovBottom && candBottom > ovTop);
      if (overlaps) {
        this.currentAlign = 'right';
      }
    }
  }

  /**
   * Updates the document title prefix with the current engine status.
   */
  private async updatePageTitle(page: Page, simpleText: string): Promise<void> {
    if (this.originalTitle === null) {
      this.originalTitle = await page.title().catch(() => '');
    }

    const titlePrefix = this.currentObjectName ? `[reLOCATE.AI] - ${this.currentObjectName} - ` : `[reLOCATE.AI] - `;
    const baseTitle = this.originalTitle;

    await page.evaluate(({ prefix, baseTitle }) => {
      document.title = prefix + baseTitle;
    }, { prefix: titlePrefix, baseTitle });
  }

  /**
   * Injects or updates the HTML glassmorphic status card on the page.
   */
  private async updateBrowserOverlay(page: Page, simple: string, tough: string): Promise<void> {
    await page.evaluate(({ tough, simple, align, objectName }) => {
      const domCount = document.querySelectorAll('*').length;
      const resolvedSimple = simple.replace('{{DOM_COUNT}}', String(domCount));
      // 1. Add CSS rules for animation if not present
      let styleEl = document.getElementById('__ai-healing-status-styles__');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = '__ai-healing-status-styles__';
        styleEl.innerHTML = `
          @keyframes relfPulse {
            0% { box-shadow: 0 0 4px #FFBA69; opacity: 0.6; }
            50% { box-shadow: 0 0 12px #FFBA69; opacity: 1; }
            100% { box-shadow: 0 0 4px #FFBA69; opacity: 0.6; }
          }
          @keyframes relfScan {
            0% { left: -100%; }
            50% { left: 100%; }
            100% { left: 100%; }
          }
        `;
        document.head.appendChild(styleEl);
      }

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

        // Glowing active indicator dot with pulse animation
        const dot = document.createElement('span');
        dot.style.cssText = [
          'display: inline-block',
          'width: 8px',
          'height: 8px',
          'background-color: #FFBA69',
          'border-radius: 50%',
          'margin-right: 8px',
          'vertical-align: middle',
          'animation: relfPulse 1.5s infinite ease-in-out'
        ].join(';');
        header.appendChild(dot);

        const headerText = document.createElement('span');
        headerText.id = '__ai-healing-status-header-text__';
        headerText.innerText = objectName ? 'reLOCATE.AI ENGINE [' + objectName + ']' : 'reLOCATE.AI ENGINE';
        header.appendChild(headerText);

        // Dynamic visual progress bar to indicate active processing
        const loadingBarContainer = document.createElement('div');
        loadingBarContainer.style.cssText = [
          'width: 100%',
          'height: 3px',
          'background: rgba(255, 255, 255, 0.05)',
          'border-radius: 2px',
          'overflow: hidden',
          'margin: 10px 0',
          'position: relative'
        ].join(';');

        const loadingBarFill = document.createElement('div');
        loadingBarFill.style.cssText = [
          'position: absolute',
          'top: 0',
          'bottom: 0',
          'left: -100%',
          'width: 100%',
          'background: linear-gradient(90deg, transparent, #FFBA69 50%, transparent)',
          'animation: relfScan 2s infinite ease-in-out'
        ].join(';');
        loadingBarContainer.appendChild(loadingBarFill);

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
        overlay.appendChild(loadingBarContainer);
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
      const headerTextEl = document.getElementById('__ai-healing-status-header-text__');
      if (toughEl) toughEl.innerText = tough;
      if (simpleEl) simpleEl.innerText = resolvedSimple;
      if (headerTextEl) headerTextEl.innerText = objectName ? 'reLOCATE.AI ENGINE [' + objectName + ']' : 'reLOCATE.AI ENGINE';
    }, { tough, simple, align: this.currentAlign, objectName: this.currentObjectName });
  }
}
