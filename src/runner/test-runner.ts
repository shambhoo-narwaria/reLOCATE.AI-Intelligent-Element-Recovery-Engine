import { chromium, Page, Locator } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { HealingEngine } from '../healing/healing.engine';
import { ScoringEngine } from '../scoring/scoring.engine';
import { CandidateFinder } from './candidate-finder';
import { ElementValidator } from './element-validator';
import { OriginalElement } from '../interfaces/original-element.interface';
import { Candidate } from '../interfaces/candidate.interface';
import { logger } from '../logger/debug-logger';

export class TestRunner {
  private testCasePath = path.resolve(__dirname, '../../Testcase/NeuroTestcase.json');

  constructor(
    private healingEngine: HealingEngine,
    private candidateFinder: CandidateFinder,
    private elementValidator: ElementValidator
  ) {}

  async run(isSimulation: boolean) {
    console.log(`[TestRunner] Starting Playwright Test Execution (Simulation Mode: ${isSimulation})`);
    
    if (!fs.existsSync(this.testCasePath)) {
      console.error(`[TestRunner] Testcase file not found at: ${this.testCasePath}`);
      process.exit(1);
    }
    const testcase = JSON.parse(fs.readFileSync(this.testCasePath, 'utf8'));
    const steps: OriginalElement[] = testcase.TestSteps;
    console.log(`[TestRunner] Loaded ${steps.length} steps for testcase: "${testcase.ProjectName || 'Untitled'}"`);

    // ── Clear visual-debug from previous runs ──────────────────────────────────
    // Stale images from a prior run would mix with the current run's data,
    // making it impossible to tell which step produced which image.
    const visualDebugRoot = path.join(process.cwd(), 'logs', 'visual-debug');
    if (fs.existsSync(visualDebugRoot)) {
      fs.rmSync(visualDebugRoot, { recursive: true, force: true });
      console.log(`[TestRunner] Cleared stale visual-debug folder from previous run.`);
    }
    fs.mkdirSync(visualDebugRoot, { recursive: true });

    // ── Clear report from previous runs ────────────────────────────────────────
    const reportRoot = path.join(process.cwd(), 'report');
    if (fs.existsSync(reportRoot)) {
      fs.rmSync(reportRoot, { recursive: true, force: true });
      console.log(`[TestRunner] Cleared stale report folder from previous run.`);
    }
    fs.mkdirSync(reportRoot, { recursive: true });


    const browser = await chromium.launch({
      // open window maximized, hide "Chrome is being controlled by automated software"
      headless: false,
      args: [
        '--start-maximized',
        '--disable-infobars',
        '--js-flags=--max-old-space-size=4096',
        '--ignore-gpu-blocklist',
        '--disable-gpu-sandbox',
        '--no-sandbox'
      ],
    });
    const context = await browser.newContext({
      viewport: null,                 // null = use the actual maximized window size
    });
    const page = await context.newPage();

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        logger.stepStart(i + 1, steps.length, step.Action, step.ObjectName || 'unknown');
        console.log(`\n==================================================`);
        console.log(`[TestRunner] STEP ${i + 1}/${steps.length}: Action="${step.Action}" Object="${step.ObjectName}"`);
        
        // Simulation mode: Deliberately corrupt username locator to show healing
        if (isSimulation && i === 1 && step.Action === 'Click') {
          console.log(`[Simulation] Deliberately corrupting CSS and XPath locators for "${step.ObjectName}"...`);
          step.LocCssSelector = '#fakeSignInName_doesNotExist';
          step.LocXpath = "//*[@id='fakeSignInName_doesNotExist']";
        }
        
        if (isSimulation && i === 2 && step.Action === 'Enter') {
          console.log(`[Simulation] Deliberately corrupting CSS and XPath locators for "${step.ObjectName}"...`);
          step.LocCssSelector = '#fakeSignInName_doesNotExist';
          step.LocXpath = "//*[@id='fakeSignInName_doesNotExist']";
        }

        if (step.Action === 'Navigate') {
          console.log(`[TestRunner] Navigating to: ${step.InputData}`);
          await page.goto(step.InputData, { waitUntil: 'load', timeout: 60000 });
          console.log(`[TestRunner] Navigation complete.`);

          // Capture step screenshot in report folder
          const stepNumStr = String(i + 1).padStart(2, '0');
          const screenshotPath = path.join(reportRoot, `step-${stepNumStr}.png`);
          try {
            await page.screenshot({ path: screenshotPath });
            console.log(`[TestRunner] Captured step screenshot: ${screenshotPath}`);
          } catch (err: any) {
            console.warn(`[TestRunner] Failed to capture screenshot for Navigate step:`, err.message || err);
          }
        } else if (step.Action === 'Click' || step.Action === 'Enter') {
          let stepSuccess = false;
          let lastActionErr: any = null;

          for (let attempt = 1; attempt <= 2; attempt++) {
            const result = await this.findAndHeal(page, step, i);

            // confidence=0 means the step was auto-skipped (page navigated away)
            if (result.confidence === 0) {
              console.log(`[TestRunner] Step "${step.ObjectName}" skipped — page has navigated away from the recorded URL.`);
              stepSuccess = true;
              break;
            }

            const element = result.locator;

            try {
              // ── Visual bounding-box highlight & screenshot ─────────────────
              await this.highlightAndScreenshot(page, element, i, reportRoot);

              const candIdStr = result.candidateId !== undefined ? ` (Candidate ID: ${result.candidateId})` : '';

              if (step.Action === 'Click') {
                console.log(`[TestRunner] Clicking element: "${result.newLocator}"${candIdStr}`);
                try {
                  await element.click({ timeout: 8000 });
                } catch (firstClickErr: any) {
                  const firstMsg = firstClickErr?.message || String(firstClickErr);
                  const isInterceptedOrTimeout = 
                    firstMsg.includes('intercepts pointer events') || 
                    firstMsg.includes('pointer-events') || 
                    firstMsg.includes('Timeout') || 
                    firstClickErr?.name === 'TimeoutError';

                  if (isInterceptedOrTimeout) {
                    console.warn(`[TestRunner] ⚠  Click failed or timed out on "${result.newLocator}"${candIdStr} (${firstClickErr?.name || 'Error'}). Retrying with force:true...`);
                    await element.click({ force: true, timeout: 8000 });
                  } else {
                    throw firstClickErr;
                  }
                }
              } else if (step.Action === 'Enter') {
                console.log(`[TestRunner] Filling input element "${result.newLocator}"${candIdStr} with text: "${step.InputData}"`);
                await element.fill(step.InputData);
              }

              if (result.didHeal) {
                logger.logHealResult(step.ObjectName || 'unknown', result.oldLocator, result.newLocator, result.confidence, result.reason || 'Healed', result.candidateId);
                this.healingEngine.recordOutcome(result.oldLocator, result.newLocator, true, result.triggeredAI, result.confidence);
                console.log(`[TestRunner] Healing recorded.`);
              }

              stepSuccess = true;
              break; // Success! Exit the retry loop.

            } catch (actionErr: any) {
              lastActionErr = actionErr;
              const msg: string = actionErr?.message || String(actionErr);

              // If the element became invisible or detached between candidate finding and the actual click,
              // we retry the entire findAndHeal process once because the page layout likely just settled.
              if (attempt === 1 && (msg.includes('not visible') || msg.includes('detached') || msg.includes('stale'))) {
                console.warn(`[TestRunner] ⚠ Element became invisible or detached during action (e.g. cookie banner closed). Retrying step ${i + 1} from scratch...`);
                await page.waitForTimeout(1500); // Wait for animations to finish
                continue;
              }

              // Otherwise, or if it fails twice, throw the error
              console.error(`[TestRunner] Action execution failed on element: "${result.newLocator}"`, actionErr);
              if (result.didHeal) {
                logger.logHealResult(step.ObjectName || 'unknown', result.oldLocator, result.newLocator, result.confidence, `Failed: ${msg}`, result.candidateId);
                this.healingEngine.recordOutcome(result.oldLocator, result.newLocator, false, result.triggeredAI, result.confidence);
              }
              throw actionErr;
            }
          }

          if (!stepSuccess && lastActionErr) {
            throw lastActionErr;
          }
        } else {
          console.log(`[TestRunner] Action "${step.Action}" not recognized. Skipping step.`);
          // Capture fallback step screenshot in report folder to keep step numbers aligned
          const stepNumStr = String(i + 1).padStart(2, '0');
          const screenshotPath = path.join(reportRoot, `step-${stepNumStr}.png`);
          try {
            await page.screenshot({ path: screenshotPath });
            console.log(`[TestRunner] Captured fallback step screenshot: ${screenshotPath}`);
          } catch (err: any) {
            console.warn(`[TestRunner] Failed to capture fallback screenshot for unrecognized step:`, err.message || err);
          }
        }
        
        await page.waitForTimeout(1000);
      }
      
      console.log(`\n==================================================`);
      console.log(`[TestRunner] All test steps executed successfully!`);
      
      console.log(`\n[TestRunner] Final Session Healing Stats:`);
      console.log(JSON.stringify(this.healingEngine.getStats(), null, 2));

    } catch (error) {
      console.error(`\n[TestRunner] Test Execution Failed at some step:`, error);
    } finally {
      console.log(`[TestRunner] Closing browser...`);
      await browser.close();
    }
  }

  /**
   * Draws a red bounding-box highlight around the target element for a short
   * duration so the user can visually confirm what is about to be actioned.
   * The overlay is always removed before the caller continues.
   */
  /**
   * Draws a red bounding-box highlight around the target element,
   * captures a full-page screenshot saved inside the 'report' directory,
   * and removes the highlight overlay.
   */
  private async highlightAndScreenshot(page: Page, locator: Locator, stepIndex: number, reportDir: string): Promise<void> {
    const stepNumStr = String(stepIndex + 1).padStart(2, '0');
    const screenshotPath = path.join(reportDir, `step-${stepNumStr}.png`);

    try {
      const box = await locator.boundingBox();
      if (!box || box.width === 0 || box.height === 0) {
        // Fallback: take screenshot without highlight
        await page.screenshot({ path: screenshotPath });
        return;
      }

      // Inject a fixed-position overlay div
      await page.evaluate(({ x, y, width, height }: { x: number; y: number; width: number; height: number }) => {
        const existing = document.getElementById('__ai-healing-highlight__');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = '__ai-healing-highlight__';
        overlay.style.cssText = [
          'position:fixed',
          `left:${x}px`,
          `top:${y}px`,
          `width:${width}px`,
          `height:${height}px`,
          'border:3px solid #FF2244',
          'background:rgba(255,34,68,0.12)',
          'z-index:2147483647',          // max z-index
          'pointer-events:none',         // don't intercept clicks
          'box-sizing:border-box',
          'border-radius:3px',
          'transition:opacity 0.15s ease',
        ].join(';');
        document.body.appendChild(overlay);
      }, box);

      // Brief wait to ensure overlay renders
      await page.waitForTimeout(100);

      // Take the screenshot while highlighted
      await page.screenshot({ path: screenshotPath });
      console.log(`[TestRunner] Captured step screenshot with highlight: ${screenshotPath}`);

      // Keep the highlight visible briefly for human/simulation feedback
      await page.waitForTimeout(500);

      // Always remove before acting
      await page.evaluate(() => {
        const overlay = document.getElementById('__ai-healing-highlight__');
        if (overlay) overlay.remove();
      });
    } catch (err: any) {
      console.warn(`[TestRunner] Highlight/screenshot failed for step ${stepIndex + 1}:`, err.message || err);
      // Fallback: attempt screenshot anyway
      try {
        await page.screenshot({ path: screenshotPath });
      } catch {
        // silently ignore screenshot failures
      }
    }
  }

  private async findAndHeal(page: Page, step: OriginalElement, stepIndex: number): Promise<{ locator: Locator; oldLocator: string; newLocator: string; didHeal: boolean; triggeredAI: boolean; confidence: number; reason?: string; candidateId?: number }> {
    const locCss = step.LocCssSelector;
    const locXpath = step.LocXpath;
    const originalLocator = locCss || locXpath || '';

    // as the testing purpose break the classical locators on any step
    const shouldForceAI = [2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 22, 23, 24, 25, 26].includes(stepIndex);

    // Helper function to try locating the element using original locators
    const tryOriginalLocators = async (timeoutMs: number): Promise<Locator | null> => {
      // ── Shadow DOM piercing attempts ──────────────────────────────────────
      // If the recorded element lives inside a shadow root, prioritize host-piercing.
      // Generic inner selectors (like div#default-slot-container) are not unique globally
      // and can cause Playwright to click the wrong element if tried globally first.
      const hosts: string[] = (step.ShadowDomHostArray || []).filter(Boolean);
      if (hosts.length > 0) {
        const locClass = step.LocClassName;
        const hostVariantOf = (raw: string) =>
          [raw, raw.replace(/:nth-child\(\d+\)/g, '').trim()].filter((v, i, a) => a.indexOf(v) === i);

        // 1) Try LocClassName first — most unique identifier
        if (locClass) {
          for (const rawHost of hosts) {
            for (const hostSel of hostVariantOf(rawHost)) {
              try {
                const inner = page.locator(hostSel).first().locator(`.${locClass}`).first();
                if (await inner.isVisible({ timeout: timeoutMs })) {
                  console.log(`[TestRunner] Shadow piercing via LocClassName ".${locClass}" succeeded.`);
                  return inner;
                }
              } catch { /* silent */ }
            }
          }
        }

        // 2) Try inner CSS selector (less unique but recorded precisely)
        // Skip if the inner CSS is targeting a shadow DOM implementation-detail element.
        const SHADOW_INTERNAL_KEYWORDS = ['slot', 'wrapper', 'placeholder', 'container', 'inner'];
        const isShadowInternalCss = (css: string | undefined): boolean => {
          if (!css) return false;
          const lower = css.toLowerCase().trim();
          // Match id-based selectors: #id or tag#id
          const idMatch = lower.match(/(?:^|[\s>+~])(?:[a-z]+)?#([a-z][a-z0-9_-]*)/);
          if (idMatch) {
            const id = idMatch[1];
            return SHADOW_INTERNAL_KEYWORDS.some(kw => id.includes(kw));
          }
          return false;
        };
        const innerCssIsInternal = isShadowInternalCss(locCss);

        if (locCss && !innerCssIsInternal) {
          for (const rawHost of hosts) {
            for (const hostSel of hostVariantOf(rawHost)) {
              try {
                const inner = page.locator(hostSel).first().locator(locCss).first();
                if (await inner.isVisible({ timeout: timeoutMs / 2 })) return inner;
              } catch { /* silent */ }
            }
          }
        }

        // 3) Try clicking the shadow HOST element directly ─────────────────
        // Innermost (most specific) shadow host first.
        for (const rawHost of [...hosts].reverse()) {
          for (const hostSel of hostVariantOf(rawHost)) {
            try {
              const hostEl = page.locator(hostSel).first();
              if (await hostEl.isVisible({ timeout: Math.min(timeoutMs / 4, 3000) })) {
                console.log(`[TestRunner] Shadow host direct click: "${hostSel}" (host itself is the target)`);
                return hostEl;
              }
            } catch { /* silent */ }
          }
        }
      }

      // ── Global locator attempts (fallback) ──────────────────────────────────
      const locatorsToTry = [locCss, locXpath].filter(Boolean) as string[];
      for (const loc of locatorsToTry) {
        try {
          await page.waitForSelector(loc, { timeout: timeoutMs, state: 'attached' });
          const el = page.locator(loc).first();
          if (await el.isVisible()) return el;
        } catch (err: any) {
          // silent failure to keep logs clean
        }
      }

      return null;
    };

    // Try original locators first (quick check / wait) unless we force AI for specific steps
    let el = null;
    if (shouldForceAI) {
      logger.debug(`[Simulation] Bypassing original locators for step ${stepIndex + 1} (index ${stepIndex}) "${step.ObjectName}" to force AI healing...`);
      step.forceAI = true;

      // ── Page stabilization wait for forced AI ─────────────────────────────────────
      logger.debug(`[Simulation] Waiting for page load and stabilization before initializing AI healing...`);
      await this.waitForPageSettle(page, 30000);
    } else {
      el = await tryOriginalLocators(5000);
    }
    
    if (el) {
      return {
        locator: el,
        oldLocator: originalLocator,
        newLocator: originalLocator,
        didHeal: false,
        triggeredAI: false,
        confidence: 1.0
      };
    }

    // Tier 2: Wait 5 seconds and retry (Final attempt before healing)
    if (!shouldForceAI) {
      logger.debug(`[TestRunner] Original locator failed. Waiting 5s before retrying...`);
      await page.waitForTimeout(5000);
      el = await tryOriginalLocators(5000);
    }
    
    if (el) {
      logger.debug(`[TestRunner] Success! Original locator found on 2nd attempt.`);
      return {
        locator: el,
        oldLocator: originalLocator,
        newLocator: originalLocator,
        didHeal: false,
        triggeredAI: false,
        confidence: 1.0
      };
    }

    // Locator STILL failed, trigger AI healing!
    logger.warn(`[TestRunner] Original locators genuinely failed for object "${step.ObjectName}". Initializing healing engine...`);

    // (Domain mismatch check removed as requested)
    
    // Ensure the page is fully loaded before scraping candidates and creating the AI payload
    logger.debug(`[TestRunner] Ensuring page is fully loaded before creating AI payload...`);
    await this.waitForPageSettle(page, 30000);

    const consoleListener = (msg: any) => {
      if (msg.text().includes('[CandidateFinder]')) {
        logger.debug(msg.text());
      }
    };
    page.on('console', consoleListener);

    // Scrape candidates with loading retries
    let candidates = await this.candidateFinder.findCandidates(page, step.OrigTagName);

    page.removeListener('console', consoleListener);

    // ── Filter shadow-internal and loading-placeholder elements ──────────────
    // Generic keyword-based heuristic: elements with IDs containing 'slot',
    // 'wrapper', 'placeholder', 'container', 'inner' are shadow DOM layout helpers
    // in virtually every web component library (ZUI, Material, Shoelace, etc.).
    // They intercept pointer events and are never valid click targets.
    const SHADOW_INTERNAL_ID_KEYWORDS = ['slot', 'wrapper', 'placeholder', 'container', 'inner'];
    const isInternalById = (id: string) => id.length > 0 && SHADOW_INTERNAL_ID_KEYWORDS.some(kw => id.includes(kw));

    candidates = candidates.filter(c => {
      const testId = (c.functional.dataTestId || '').toLowerCase();
      const css    = (c.functional.cssSelector || '').toLowerCase();
      const id     = (c.functional.id || '').toLowerCase();

      // Named loading/skeleton placeholders
      if (testId.includes('skeleton')) return false;
      if (css.includes('skeleton'))   return false;

      // Generic shadow-internal layout elements (slot, wrapper, placeholder, container)
      // Only exclude if no useful identity — some containers have data-test, text, or accessibleName
      if (isInternalById(id) && !c.functional.dataTestId && !c.semantic.text && !c.semantic.accessibleName && !c.functional.role) return false;

      // Generic layout class wrappers with no identity
      // e.g. div.content, div.checkbox-container — present in many frameworks
      const PLAIN_WRAPPER_CLASSES = /^div\.(content|checkbox-container|inner|layout|col|row|cell|wrapper|container|grid|main)$/;
      if (PLAIN_WRAPPER_CLASSES.test(css) && !c.functional.id && !c.functional.dataTestId && !c.semantic.text) return false;

      return true;
    });
    console.log(`[TestRunner] Candidates after internal-element filter: ${candidates.length}`);

    // ── CSS-in-JS / framework loading-state detection ──────────────────────
    // When a SPA is still rendering only hashed CSS class divs appear (e.g.
    // styled-components: div.sc-xXzFt, Emotion: div.css-abc123).
    // Detect by checking if ANY candidate has meaningful identity.
    // Common root divs like #app or #root have ids but are not meaningful
    // interaction targets, so we also exclude known root ids from the check.
    const ROOT_IDS = new Set(['app', 'root', 'main', 'body', '__next', 'application']);
    const isLoadingStateDom = (cands: typeof candidates): boolean => {
      if (cands.length === 0) return false;
      // A meaningful candidate has text OR role OR data-test OR a non-root id
      const hasAnyMeaningful = cands.some(c =>
        c.semantic.text ||
        c.functional.role ||
        c.functional.dataTestId ||
        c.functional.dataQa ||
        c.functional.dataCy ||
        (c.functional.id && !ROOT_IDS.has(c.functional.id.toLowerCase()))
      );
      // Also require at least one sc-/css- hash class to confirm loading state
      const hasCssHash = cands.some(c =>
        /\.(sc-|css-)[a-zA-Z0-9]+/.test(c.functional.cssSelector || '')
      );
      return !hasAnyMeaningful && hasCssHash;
    };

    let retries = 15;
    while ((candidates.length === 0 || isLoadingStateDom(candidates)) && retries > 0) {
      const reason = candidates.length === 0 ? '0 candidates (waiting for skeleton/loading to settle)' : 'page still in loading-state (CSS-in-JS hashes only)';
      console.log(`[TestRunner] ${reason}. Retrying in 2000ms... (${retries} retries left)`);
      await page.waitForTimeout(2000);
      candidates = await this.candidateFinder.findCandidates(page, step.OrigTagName);
      candidates = candidates.filter(c => {
        const testId = (c.functional.dataTestId || '').toLowerCase();
        const css    = (c.functional.cssSelector || '').toLowerCase();
        const id     = (c.functional.id || '').toLowerCase();
        if (testId.includes('skeleton') || css.includes('skeleton')) return false;
        if (isInternalById(id) && !c.functional.dataTestId && !c.semantic.text && !c.semantic.accessibleName && !c.functional.role) return false;
        return true;
      });
      retries--;
    }

    // ── Tag-name hard filter ──────────────────────────────────────────────────
    // When OrigTagName is recorded, restrict the ENTIRE candidate pool to only
    // elements with that exact tag — across the whole DOM, regardless of type
    // (native or custom element).
    // e.g. OrigTagName="INPUT"  → pool = all INPUT elements only
    //      OrigTagName="ZUI-SELECT-V3-17" → pool = all ZUI-SELECT-V3-17 only
    // Safety fallback: if zero same-tag candidates are found (element type was
    // completely redesigned), keep the full pool so healing can still attempt recovery.
    if (step.OrigTagName) {
      const origTagUpper = step.OrigTagName.toUpperCase();
      const sameTagCandidates = candidates.filter(c => c.functional.tagName.toUpperCase() === origTagUpper);
      if (sameTagCandidates.length > 0) {
        logger.debug(`[TestRunner] Tag filter: restricting ${candidates.length} → ${sameTagCandidates.length} candidates with tagName="${origTagUpper}"`);
        candidates = sameTagCandidates;
      } else {
        logger.debug(`[TestRunner] Tag filter: no candidates with tagName="${origTagUpper}" found — keeping full pool of ${candidates.length}`);
      }
    }

    // ── Relevance cap ─────────────────────────────────────────────────────────
    // On pages like patient lists, the DOM can have 700+ candidates (one for
    // each repeated row element). Sending all of them to the AI is very slow
    // and leads to wrong picks.  We score each candidate by keyword overlap with
    // ObjectName + NearByText PLUS a shadow host chain affinity bonus to ensure
    // deeply-nested form controls (e.g. input#raw inside ZUI-TEXTFIELD-V3-17)
    // are never discarded when they live inside the correct shadow component tree.
    const MAX_CANDIDATES = 70;
    if (candidates.length > MAX_CANDIDATES) {
      const resolvedName = (step.LocText || step.LocTitle || step.OwnInnerText || '').trim();
      const objectWords = resolvedName.toLowerCase().split(/\W+/).filter(Boolean);
      const nearbyWords = (step.NearByText || step.nearbyText || []).slice(0, 4).join(' ').toLowerCase().split(/\W+/).filter(Boolean);
      // Include class name words for robust matching of unlabeled elements
      const classWords = (step.LocClassName || '').toLowerCase().split(/\W+/).filter(Boolean);

      const allKeywords = [...new Set([...objectWords, ...nearbyWords, ...classWords])];

      // Build a set of shadow host tag names from the original element's recorded host array.
      // Used to give affinity bonus to candidates nested inside the same shadow component tree.
      const origHostTagSet = new Set<string>(
        (step.ShadowDomHostArray || []).flatMap((sel: string) =>
          sel.split(/[\s>+~]+/).map((p: string) => {
            const m = p.match(/^([a-zA-Z0-9-]+)/);
            return m ? m[1].toUpperCase() : '';
          }).filter(Boolean)
        )
      );

      // Extract original tail tags from CSS Selector for structural matching
      // e.g. "div#modal > form > div > button" -> ["BUTTON", "DIV", "FORM", "DIV"]
      const origTailTags: string[] = [];
      if (step.LocCssSelector) {
        const parts = step.LocCssSelector.split('>');
        // reverse it so index 0 is the element itself, index 1 is parent, etc.
        for (let i = parts.length - 1; i >= 0; i--) {
          const match = parts[i].trim().match(/^([a-zA-Z0-9-]+)/);
          if (match) {
            origTailTags.push(match[1].toUpperCase());
          }
        }
      }

      const scored = candidates.map(c => {
        const haystack = [
          c.semantic.text,
          c.semantic.accessibleName,
          c.functional.cssSelector,
          c.functional.className,
          c.functional.dataTestId,
          c.functional.id,
          c.functional.ariaLabel,
          c.ancestorContext.parentText,
        ].join(' ').toLowerCase();

        // Keyword hits (primary signal)
        let hits = allKeywords.filter(kw => haystack.includes(kw)).length;

        // ── Smarter Precision Bonuses ──
        // 1. Text Conciseness Bonus
        // If the candidate contains the target text, reward it if it doesn't have too much EXTRA text.
        // This prevents bulky parent containers from beating precise child elements.
        if (step.LocText && c.semantic.text) {
          const targetLen = step.LocText.length;
          const candLen = c.semantic.text.length;
          const textLower = c.semantic.text.toLowerCase();
          const targetLower = step.LocText.toLowerCase();
          
          if (textLower.includes(targetLower) || (c.semantic.accessibleName && c.semantic.accessibleName.toLowerCase().includes(targetLower))) {
            hits += 5; // Contains the text
            const lenDiff = Math.abs(candLen - targetLen);
            if (lenDiff <= 5) hits += 30;       // Almost exact length
            else if (lenDiff <= 20) hits += 15; // Close length
          }
        }

        // 2. Unlabeled Element Handle (Icon/Button Bonus)
        // If the element has no text, its class name is critical. Reward candidates whose
        // class name closely matches the original class name without too many extra utility classes.
        if (step.LocClassName && c.functional.className) {
          const classLower = c.functional.className.toLowerCase();
          const targetClassLower = step.LocClassName.toLowerCase();
          if (classLower.includes(targetClassLower)) {
            hits += 5; // Contains the class
            const lenDiff = Math.abs(classLower.length - targetClassLower.length);
            if (lenDiff <= 5) hits += 20;       // Almost exact class match
          }
        }

        // 3. Ancestor Tail Similarity Bonus
        // Compare the last few ancestors to strictly distinguish deeply nested UI elements from top-level wrappers
        if (origTailTags.length > 1 && c.ancestorContext && c.ancestorContext.ancestorTagNames) {
          const candAncestors = c.ancestorContext.ancestorTagNames;
          // candAncestors[0] is parent, candAncestors[1] is grandparent.
          // origTailTags[0] is the element itself, origTailTags[1] is parent.
          let tailMatches = 0;
          const maxDepthToCheck = Math.min(4, origTailTags.length - 1); // check up to 4 ancestors
          for (let i = 0; i < maxDepthToCheck; i++) {
            if (candAncestors.length > i && candAncestors[i] === origTailTags[i + 1]) {
              tailMatches++;
              hits += 5; // +5 per matching ancestor level
            } else {
              break; // Break on first mismatch to enforce continuous structural tail
            }
          }
          // Extra bonus if the entire tail checked matches perfectly
          if (tailMatches === maxDepthToCheck && tailMatches > 0) {
            hits += 15;
          }
        }

        // 4. Shadow host chain affinity: count how many of the original's shadow host
        // tags appear in this candidate's recorded shadowHostChain.
        // Score is normalised to [0, 8] — heavier than a single keyword hit —
        // so that inputs with correct shadow hierarchy survive even with 0 text hits.
        const candChain = c.ancestorContext.shadowHostChain || [];
        let hostOverlap = 0;
        if (origHostTagSet.size > 0 && candChain.length > 0) {
          for (const tag of candChain) {
            if (origHostTagSet.has(tag)) hostOverlap++;
          }
        }
        const hostScore = origHostTagSet.size > 0 ? (hostOverlap / origHostTagSet.size) * 8 : 0;

        return { c, score: hits + hostScore };
      });

      // Sort: combined score DESC, then candidateId ASC (DOM order as tiebreak)
      scored.sort((a, b) => b.score - a.score || a.c.candidateId - b.c.candidateId);
      candidates = scored.slice(0, MAX_CANDIDATES).map(s => s.c);
      logger.debug(`[TestRunner] Relevance cap applied: kept top ${candidates.length} of ${scored.length} candidates (keywords: [${allKeywords.slice(0, 8).join(', ')}])`);
    }

    const targetName = step.ObjectName || step.accessibleName || 'unknown';
    logger.debug(`[TestRunner] Extracted ${candidates.length} final candidate elements for object "${targetName}":`);
    candidates.forEach((c, idx) => {
      logger.debug(`   - Candidate #${idx + 1} [ID ${c.candidateId}] text="${c.semantic.text?.substring(0,30) || ''}" cls="${c.functional.className || ''}" xpath="${c.functional.cssSelector || ''}"`);
    });

    // ── Visual Verification: calculate screenshot similarity ─────────────────
    if (step.Screenshot && step.ElementViewportRect && Array.isArray(step.ElementViewportRect) && step.ElementViewportRect.length === 4) {
      console.log(`[TestRunner] Initializing visual verification matching...`);
      try {
        // Pre-filter candidates to prevent visual comparison on irrelevant elements
        const tagFilteredCandidates = this.getFilteredCandidates(step, candidates);
        console.log(`[TestRunner] Restricting visual comparison to ${tagFilteredCandidates.length} tag-matched candidates (out of ${candidates.length} total).`);

        // 1. Get structural rules (excluding VisualSimilarityRule)
        const structuralRules = this.healingEngine.scoringEngine.rules.filter(r => r.name !== 'VisualSimilarityRule');
        const tempEngine = new ScoringEngine(structuralRules);

        // 2. Pre-score the tag-filtered candidates
        const preScored = tempEngine.scoreCandidates(step, tagFilteredCandidates);

        // 3. Take the top 20 candidates
        const topCandidates = preScored.slice(0, 20).map(item => item.candidate);
        logger.debug(`[TestRunner] Pre-scored tag-matched candidates. Verifying top ${topCandidates.length} sequentially with scroll-into-view.`);

        const similarities: any[] = [];
        const originalScreenshotB64 = step.Screenshot;
        const originalRect = step.ElementViewportRect;

        // 4. Sequentially scroll each candidate into view and compare
        for (const c of topCandidates) {
          try {
            // Check if element is visible in DOM using the unbreakable injected ID
            const locator = page.locator(`[data-ai-healed-id="${c.candidateId}"]`).first();
            const isVisible = await locator.isVisible();
            if (!isVisible) {
              similarities.push({ candidateId: c.candidateId, similarity: 0 });
              continue;
            }

            // Scroll candidate into view (short timeout to avoid hanging)
            try {
              await locator.scrollIntoViewIfNeeded({ timeout: 1000 });
              await page.waitForTimeout(100);
            } catch (err: any) {
              // Silently ignore scroll failures and attempt visual comparison anyway
            }

            // Take current viewport screenshot
            const currentScreenshotB64 = await page.screenshot({ type: 'jpeg', quality: 80 }).then(buf => buf.toString('base64'));

            // Get updated client rect of candidate in viewport (piercing shadow DOM)
            const currentRect = await locator.evaluate((el) => {
              const getElementRectWithFallback = (element: Element): DOMRect => {
                const rect = element.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  return rect;
                }
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
            }).catch(() => null);

            // Compare inside page context
            const result = await page.evaluate(async ({ originalB64, currentB64, originalRect, candRect, devicePixelRatio }) => {
              const loadImage = (src: string): Promise<HTMLImageElement> => {
                return new Promise((resolve, reject) => {
                  const img = new Image();
                  img.onload = () => resolve(img);
                  img.onerror = reject;
                  img.src = src;
                });
              };

              const getGrayscale = (imgData: Uint8ClampedArray): Float32Array => {
                const gray = new Float32Array(imgData.length / 4);
                for (let i = 0; i < imgData.length; i += 4) {
                  gray[i / 4] = 0.299 * imgData[i] + 0.587 * imgData[i + 1] + 0.114 * imgData[i + 2];
                }
                return gray;
              };

              const getEdges = (gray: Float32Array, w: number, h: number): Float32Array => {
                const edges = new Float32Array(w * h);
                for (let y = 0; y < h; y++) {
                  for (let x = 0; x < w; x++) {
                    const idx = y * w + x;
                    const val = gray[idx];
                    const valRight = (x < w - 1) ? gray[idx + 1] : val;
                    const valDown = (y < h - 1) ? gray[idx + w] : val;
                    const dx = valRight - val;
                    const dy = valDown - val;
                    edges[idx] = Math.abs(dx) + Math.abs(dy);
                  }
                }
                return edges;
              };

              const blurEdges = (edges: Float32Array, w: number, h: number): Float32Array => {
                const blurred = new Float32Array(w * h);
                for (let y = 0; y < h; y++) {
                  for (let x = 0; x < w; x++) {
                    let sum = 0;
                    let count = 0;
                    for (let dy = -1; dy <= 1; dy++) {
                      const ny = y + dy;
                      if (ny < 0 || ny >= h) continue;
                      for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx;
                        if (nx < 0 || nx >= w) continue;
                        sum += edges[ny * w + nx];
                        count++;
                      }
                    }
                    blurred[y * w + x] = sum / count;
                  }
                }
                return blurred;
              };

              try {
                const imgOrig = await loadImage("data:image/jpeg;base64," + originalB64);
                const imgCurr = await loadImage("data:image/jpeg;base64," + currentB64);

                const [origLeft, origTop, origRight, origBottom] = originalRect;
                const rawOrigW = origRight - origLeft;
                const rawOrigH = origBottom - origTop;

                if (rawOrigW <= 0 || rawOrigH <= 0) return { similarity: 0 };
                if (!candRect || candRect.width <= 0 || candRect.height <= 0) return { similarity: 0 };

                // Shave off the edges to ignore bounding-box artifacts drawn during recording
                // We shave off up to 4px, but no more than 10% of the element's width/height to protect tiny icons
                const INSET_X = Math.floor(Math.min(rawOrigW * 0.1, 4));
                const INSET_Y = Math.floor(Math.min(rawOrigH * 0.1, 4));

                const origCropLeft = origLeft + INSET_X;
                const origCropTop = origTop + INSET_Y;
                const origW = rawOrigW - (INSET_X * 2);
                const origH = rawOrigH - (INSET_Y * 2);

                if (origW <= 0 || origH <= 0) return { similarity: 0 };

                // Proportional target canvas dimensions based on cropped original element (capped at 256px max)
                const maxDimOrig = Math.max(origW, origH);
                const scaleOrig = 256 / maxDimOrig;
                const targetW = Math.max(1, Math.round(origW * scaleOrig));
                const targetH = Math.max(1, Math.round(origH * scaleOrig));

                // Create canvas for original element crop
                const canvasOrig = document.createElement('canvas');
                canvasOrig.width = targetW;
                canvasOrig.height = targetH;
                const ctxOrig = canvasOrig.getContext('2d');
                if (!ctxOrig) return { similarity: 0 };

                ctxOrig.drawImage(imgOrig, origCropLeft, origCropTop, origW, origH, 0, 0, targetW, targetH);
                const dataOrig = ctxOrig.getImageData(0, 0, targetW, targetH).data;
                const origImgData = canvasOrig.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');

                // Pre-calculate original edge map and blur it
                const grayOrig = getGrayscale(dataOrig);
                const edgesOrig = getEdges(grayOrig, targetW, targetH);
                const blurredOrig = blurEdges(edgesOrig, targetW, targetH);

                // Create canvas for candidate crop
                const canvasCand = document.createElement('canvas');
                canvasCand.width = targetW;
                canvasCand.height = targetH;
                const ctxCand = canvasCand.getContext('2d');
                if (!ctxCand) return { similarity: 0 };

                // Convert logical CSS coordinates to physical pixels
                const candBaseLeft = candRect.left * devicePixelRatio;
                const candBaseTop = candRect.top * devicePixelRatio;
                const candBaseW = candRect.width * devicePixelRatio;
                const candBaseH = candRect.height * devicePixelRatio;

                // Scale the original inset proportionally for the candidate
                const candInsetX = (INSET_X / rawOrigW) * candBaseW;
                const candInsetY = (INSET_Y / rawOrigH) * candBaseH;

                const candLeft = candBaseLeft + candInsetX;
                const candTop = candBaseTop + candInsetY;
                const candW = candBaseW - (candInsetX * 2);
                const candH = candBaseH - (candInsetY * 2);

                if (candW <= 0 || candH <= 0) return { similarity: 0 };

                ctxCand.drawImage(imgCurr, candLeft, candTop, candW, candH, 0, 0, targetW, targetH);
                const dataCand = ctxCand.getImageData(0, 0, targetW, targetH).data;

                // Compute candidate edge map and blur it
                const grayCand = getGrayscale(dataCand);
                const edgesCand = getEdges(grayCand, targetW, targetH);
                const blurredCand = blurEdges(edgesCand, targetW, targetH);

                // Compare original vs candidate blurred edge maps using Weighted Jaccard Similarity (intersection over union of edges)
                let sumMin = 0;
                let sumMax = 0;
                for (let i = 0; i < blurredOrig.length; i++) {
                  const o = blurredOrig[i];
                  const c = blurredCand[i];
                  sumMin += Math.min(o, c);
                  sumMax += Math.max(o, c);
                }

                let similarity = sumMax > 0.001 ? (sumMin / sumMax) : 1.0;

                // If candidate area is 5 times or more than the original area, penalize similarity
                const origArea = origW * origH;
                const candArea = candRect.width * candRect.height;
                if (candArea >= origArea * 10) {
                  similarity = -1.0;
                } else if (candArea >= origArea * 5) {
                  similarity = -0.5;
                }

                // Annotate candidate canvas (with lower Jaccard threshold reflecting wider, more sensitive score range)
                if (similarity > 0.70) {
                  ctxCand.strokeStyle = '#22CC44'; // Green for high similarity
                } else {
                  ctxCand.strokeStyle = '#FF2244'; // Red for low similarity
                }
                ctxCand.lineWidth = 2;
                ctxCand.strokeRect(0, 0, targetW, targetH);

                const candImgData = canvasCand.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');

                return {
                  similarity,
                  origImgData,
                  candImgData
                };
              } catch (err) {
                console.error('Image loading/processing failed:', err);
                return { similarity: 0 };
              }
            }, {
              originalB64: originalScreenshotB64,
              currentB64: currentScreenshotB64,
              originalRect: originalRect,
              candRect: currentRect,
              devicePixelRatio: await page.evaluate(() => window.devicePixelRatio || 1)
            });

            if (result && typeof result === 'object') {
              similarities.push({
                candidateId: c.candidateId,
                similarity: result.similarity,
                origImgData: result.origImgData,
                candImgData: result.candImgData
              });
            } else {
              similarities.push({ candidateId: c.candidateId, similarity: 0 });
            }
          } catch (err) {
            console.warn(`[TestRunner] Visual comparison failed for candidate ${c.candidateId}, defaulting to 0 similarity.`, err);
            similarities.push({ candidateId: c.candidateId, similarity: 0 });
          }
        }

        // Map results back to candidates list
        const similarityMap = new Map(similarities.map((s: any) => [s.candidateId, s.similarity]));
        candidates.forEach(c => {
          c.visual.similarity = similarityMap.get(c.candidateId) ?? 0;
        });

        // Save visual debug images
        const debugDir = path.join(process.cwd(), 'logs', 'visual-debug', `step-${stepIndex + 1}`);
        if (!fs.existsSync(debugDir)) {
          fs.mkdirSync(debugDir, { recursive: true });
        }

        // Save original template (first one has it)
        const firstWithImg = similarities.find((s: any) => s.origImgData);
        if (firstWithImg) {
          fs.writeFileSync(path.join(debugDir, `original_template.png`), Buffer.from(firstWithImg.origImgData, 'base64'));
        }

        similarities.forEach((s: any) => {
          if (s.candImgData) {
            const fileName = `candidate_${s.candidateId}_score_${s.similarity.toFixed(2)}.png`;
            fs.writeFileSync(path.join(debugDir, fileName), Buffer.from(s.candImgData, 'base64'));
          }
        });

        console.log(`[TestRunner] Visual verification scores mapped to candidate pool and logged under logs/visual-debug/step-${stepIndex + 1}/`);
      } catch (err) {
        console.warn(`[TestRunner] Visual comparison failed, defaulting to neutral similarity scores.`, err);
        candidates.forEach(c => {
          c.visual.similarity = 0;
        });
      }
    } else {
      console.log(`[TestRunner] Step has no recorded Screenshot/ElementViewportRect data. Defaulting to neutral visual similarity.`);
      candidates.forEach(c => {
        c.visual.similarity = 0;
      });
    }

    // Perform healing
    const healResult = await this.healingEngine.heal(step, candidates);
    console.log(`[TestRunner] Healing engine successfully resolved locator:`);
    console.log(`  - Old: "${originalLocator}"`);
    console.log(`  - New: "${healResult.healedLocator}"`);
    console.log(`  - Candidate ID: ${healResult.candidateId !== undefined ? healResult.candidateId : 'N/A'}`);
    console.log(`  - Confidence: ${healResult.confidence * 100}%`);
    console.log(`  - Reason: ${healResult.reason}`);

    let healedEl: Locator;
    if (healResult.candidateId !== undefined) {
      // Execute the action using the completely unbreakable injected data ID!
      healedEl = page.locator(`[data-ai-healed-id="${healResult.candidateId}"]`).first();
    } else {
      healedEl = page.locator(healResult.healedLocator).first();
    }
    // Ensure element is scrolled into view before validation/action
    await healedEl.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(err => {
      console.warn(`[TestRunner] Failed to scroll element "${healResult.healedLocator}" into view:`, err.message || err);
    });

    // Validate healed element actionability
    let isValid = await this.elementValidator.validate(healedEl, step.Action === 'Enter');
    if (!isValid) {
      console.warn(`[TestRunner] Healed element "${healResult.healedLocator}" (Chosen Candidate: ${JSON.stringify(healResult, null, 2)}) failed initial validation. Page may still be loading. Waiting 10s...`);
      await page.waitForTimeout(10000);
      isValid = await this.elementValidator.validate(healedEl, step.Action === 'Enter');
    }

    if (!isValid) {
      const candidateList = candidates.map(c => `[ID ${c.candidateId}] tag=${c.functional.tagName} css=${c.functional.cssSelector} text="${c.semantic.accessibleName}"`).join(', ');
      console.warn(`[TestRunner] Healed element "${healResult.healedLocator}" failed actionability validation. Chosen Candidate: ${JSON.stringify(healResult, null, 2)}. Proceeding with action anyway (relying on Playwright's native interaction/scrolling).`);
    }

    return {
      locator: healedEl,
      oldLocator: originalLocator,
      newLocator: healResult.healedLocator,
      didHeal: true,
      triggeredAI: healResult.triggeredAI,
      confidence: healResult.confidence,
      reason: healResult.reason,
      candidateId: healResult.candidateId
    };
  }

  /**
   * Robust multi-iteration page-stabilization helper.
   * Runs up to 3 load checks, with a brief wait between them, to handle client-side navigations,
   * redirects, and active loader skeletons, without waiting indefinitely on networkidle.
   */
  private async waitForPageSettle(page: Page, timeoutMs = 15000): Promise<void> {
    if (page.isClosed()) {
      logger.debug(`[TestRunner] Page/browser was closed. Aborting page stabilization.`);
      return;
    }

    try {
      // Check common spinner/loader selectors
      const loaderSelectors = [
        '[class*="spinner"]',
        '[class*="loader"]',
        '[class*="loading"]',
        '[aria-busy="true"]',
        'mat-spinner',
        'zui-spinner',
        '[class*="skeleton"]', 
        '[data-test*="skeleton"]'
      ];
      
      for (const selector of loaderSelectors) {
        try {
          if (await page.locator(selector).first().isVisible()) {
            logger.debug(`[TestRunner] Detected active loader/skeleton: "${selector}". Waiting for it to hide...`);
            await page.waitForSelector(selector, { state: 'hidden', timeout: timeoutMs });
          }
        } catch {
          // ignore timeouts or invalid selectors
        }
      }

      if (page.isClosed()) {
        logger.debug(`[TestRunner] Page/browser was closed during loader checks. Aborting.`);
        return;
      }

      // Reactive DOM Stability Check using MutationObserver
      logger.debug(`[TestRunner] Monitoring DOM stability...`);
      await page.evaluate(async (maxWait) => {
        return new Promise<void>((resolve) => {
          let timeoutId: any;
          let lastMutationTime = Date.now();

          const observer = new MutationObserver(() => {
            lastMutationTime = Date.now();
          });

          // Observe all child updates, attributes, and subtree mutations
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
          });

          // Poll every 100ms. If no mutations occurred in the last 400ms, the DOM is stable
          const intervalId = setInterval(() => {
            if (Date.now() - lastMutationTime >= 400) {
              cleanup();
              resolve();
            }
          }, 100);

          // Hard fallback limit
          timeoutId = setTimeout(() => {
            cleanup();
            resolve();
          }, maxWait);

          function cleanup() {
            observer.disconnect();
            clearInterval(intervalId);
            clearTimeout(timeoutId);
          }
        });
      }, 5000); // Capped at 5 seconds maximum wait for stability

      // Force layout recalculation
      await page.evaluate(() => {
        // trigger reflow
        document.body.getBoundingClientRect();
      });
      
      logger.debug(`[TestRunner] Page stabilization complete.`);
    } catch (err: any) {
      if (err.message && (err.message.includes('closed') || err.message.includes('Target page, context or browser has been closed'))) {
        logger.debug(`[TestRunner] Page/browser was closed during wait operations. Aborting.`);
        return;
      }
      logger.debug(`[TestRunner] Page stabilization wait encountered an error (ignoring):`, err);
    }
  }

  private getFilteredCandidates(step: OriginalElement, candidates: Candidate[]): Candidate[] {
    const origTag = (step.OrigTagName || '').toUpperCase().trim();
    const shadowHostTagsSet = new Set<string>();

    (step.ShadowDomHostArray || []).forEach((sel: string) => {
      const parts = sel.split(/[\s>+~]+/);
      parts.forEach(part => {
        const match = part.match(/^([a-zA-Z0-9-]+)/);
        if (match) {
          const tag = match[1].toUpperCase();
          if (tag && tag !== 'HTML' && tag !== 'BODY') {
            shadowHostTagsSet.add(tag);
          }
        }
      });
    });

    (step.ShadowDomFullXpathArray || []).forEach((xpath: string) => {
      xpath.split('/').filter(Boolean).forEach(seg => {
        const tag = seg.replace(/\[\d+\]/g, '').toUpperCase().trim();
        if (tag && tag !== 'HTML' && tag !== 'BODY') {
          shadowHostTagsSet.add(tag);
        }
      });
    });

    const shadowHostTags = [...shadowHostTagsSet];
    let pool = candidates;

    // 2a: Tag name filter
    if (origTag) {
      const filtered = candidates.filter(c => {
        const cTag = c.functional.tagName.toUpperCase();
        return cTag === origTag || shadowHostTags.includes(cTag);
      });
      if (filtered.length > 0) {
        pool = filtered;
      }
    }

    // 2b: Input type sub-filter
    if (origTag === 'INPUT' && step.inputType) {
      const origInputType = step.inputType.toLowerCase().trim();
      const inputTypeFiltered = pool.filter(
        c => (c.functional.inputType || '').toLowerCase() === origInputType
      );
      if (inputTypeFiltered.length > 0) {
        pool = inputTypeFiltered;
      }
    }

    return pool;
  }
}
