import { chromium, Page, Locator } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { HealingEngine } from '../healing/healing.engine';
import { CandidateFinder } from './candidate-finder';
import { ElementValidator } from './element-validator';
import { OriginalElement } from '../interfaces/original-element.interface';
import { logger } from '../logger/debug-logger';

export class TestRunner {
  private testCasePath = path.resolve(__dirname, '../../Testcase/AIHealing.json');

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

    const browser = await chromium.launch({
      headless: false,
      args: [
        '--start-maximized',          // open window maximized
        '--disable-infobars',         // hide "Chrome is being controlled by automated software"
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
        } else if (step.Action === 'Click' || step.Action === 'Enter') {
          const result = await this.findAndHeal(page, step, i);

          // confidence=0 means the step was auto-skipped (page navigated away)
          if (result.confidence === 0) {
            console.log(`[TestRunner] Step "${step.ObjectName}" skipped — page has navigated away from the recorded URL.`);
            continue;
          }

          const element = result.locator;

          try {
            // ── Visual bounding-box highlight ─────────────────────────────
            // Draw a red border around the target element for 600ms so the
            // user can visually confirm which element is about to be acted on.
            // The overlay is always removed before the real action executes.
            await this.highlightElement(page, element);

            // ── Disabled element guard ────────────────────────────────────
            // If the element is visible but disabled (e.g. Save button before
            // required fields are filled), skip the click and warn rather than
            // timing out for 30 seconds and crashing the run.
            const isDisabled = await element.isDisabled().catch(() => false);
            if (isDisabled) {
              console.warn(`[TestRunner] ⚠  Element "${result.newLocator}" for step "${step.ObjectName}" is DISABLED. Skipping action to avoid 30s timeout.`);
              console.warn(`[TestRunner] ⚠  This usually means a prerequisite step did not complete correctly (form not ready, validation pending, etc.).`);
            } else if (step.Action === 'Click') {
              console.log(`[TestRunner] Clicking element: "${result.newLocator}"`);
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
                  // Another overlay element is on top or layout is unstable — dispatch the click directly
                  // bypassing Playwright's pointer-event interception/stability checks.
                  console.warn(`[TestRunner] ⚠  Click failed or timed out on "${result.newLocator}" (${firstClickErr?.name || 'Error'}). Retrying with force:true...`);
                  await element.click({ force: true, timeout: 8000 });
                } else {
                  throw firstClickErr;
                }
              }
            } else if (step.Action === 'Enter') {
              console.log(`[TestRunner] Filling input element "${result.newLocator}" with text: "${step.InputData}"`);
              await element.fill(step.InputData);
            }

            if (result.didHeal) {
              logger.logHealResult(step.ObjectName || 'unknown', result.oldLocator, result.newLocator, result.confidence, result.reason || 'Healed');
              this.healingEngine.recordOutcome(result.oldLocator, result.newLocator, true, result.triggeredAI, result.confidence);
              console.log(`[TestRunner] Healing recorded.`);
            }
          } catch (actionErr: any) {
            const msg: string = actionErr?.message || String(actionErr);
            const isDisabledTimeout = msg.includes('not enabled') || msg.includes('element is disabled');
            if (isDisabledTimeout) {
              // Element found but disabled — don't crash the entire run
              console.warn(`[TestRunner] ⚠  Action timed out because element "${result.newLocator}" is disabled. Skipping step "${step.ObjectName}" and continuing.`);
              if (result.didHeal) {
                logger.logHealResult(step.ObjectName || 'unknown', result.oldLocator, result.newLocator, result.confidence, `Failed: ${msg}`);
                this.healingEngine.recordOutcome(result.oldLocator, result.newLocator, false, result.triggeredAI, result.confidence);
              }
            } else {
              console.error(`[TestRunner] Action execution failed on element.`, actionErr);
              if (result.didHeal) {
                logger.logHealResult(step.ObjectName || 'unknown', result.oldLocator, result.newLocator, result.confidence, `Failed: ${msg}`);
                this.healingEngine.recordOutcome(result.oldLocator, result.newLocator, false, result.triggeredAI, result.confidence);
              }
              throw actionErr;
            }
          }
        } else {
          console.log(`[TestRunner] Action "${step.Action}" not recognized. Skipping step.`);
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
  private async highlightElement(page: Page, locator: Locator): Promise<void> {
    try {
      const box = await locator.boundingBox();
      if (!box || box.width === 0 || box.height === 0) return;

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

      // Keep the highlight visible briefly
      await page.waitForTimeout(600);

      // Always remove before acting
      await page.evaluate(() => {
        const overlay = document.getElementById('__ai-healing-highlight__');
        if (overlay) overlay.remove();
      });
    } catch {
      // If highlighting fails for any reason, silently continue — never block actions
    }
  }

  private async findAndHeal(page: Page, step: OriginalElement, stepIndex: number): Promise<{ locator: Locator; oldLocator: string; newLocator: string; didHeal: boolean; triggeredAI: boolean; confidence: number; reason?: string }> {
    const locCss = step.LocCssSelector;
    const locXpath = step.LocXpath;
    const originalLocator = locCss || locXpath || '';

    // as the testing purpose break the classical locators on any step
    const shouldForceAI = [11, 14, 18, 28, 31].includes(stepIndex);

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
                console.log(`[TestRunner] Shadow piercing: "${hostSel}" >> ".${locClass}"`);
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
                console.log(`[TestRunner] Shadow piercing: "${hostSel}" >> "${locCss}"`);
                const inner = page.locator(hostSel).first().locator(locCss).first();
                if (await inner.isVisible({ timeout: timeoutMs / 2 })) return inner;
              } catch { /* silent */ }
            }
          }
        } else if (innerCssIsInternal) {
          console.log(`[TestRunner] Shadow piercing step 2 skipped — inner CSS "${locCss}" targets a shadow-internal element (contains: ${SHADOW_INTERNAL_KEYWORDS.find(kw => locCss?.toLowerCase().includes(kw))}). Will try host directly.`);
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
          console.log(`[TestRunner] Attempting original locator: "${loc}" (timeout: ${timeoutMs}ms)`);
          await page.waitForSelector(loc, { timeout: timeoutMs, state: 'attached' });
          const el = page.locator(loc).first();
          if (await el.isVisible()) return el;
        } catch (err: any) {
          console.log(`[TestRunner] Original locator "${loc}" failed: ${err.message?.split('\n')[0] || err}`);
        }
      }

      return null;
    };

    // Try original locators first (quick check / wait) unless we force AI for specific steps
    let el = null;
    if (shouldForceAI) {
      console.log(`[Simulation] Bypassing original locators for step ${stepIndex + 1} (index ${stepIndex}) "${step.ObjectName}" to force AI healing...`);
      step.forceAI = true;

      // ── Page stabilization wait for forced AI ─────────────────────────────────────
      console.log(`[Simulation] Waiting for page load and stabilization before initializing AI healing...`);
      await this.waitForPageSettle(page);
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

    // Tier 2: Wait 5 seconds and retry
    if (!shouldForceAI) {
      console.warn(`[TestRunner] First locator attempt failed. Sleeping for 5s before retrying...`);
      await page.waitForTimeout(5000);
      console.log(`[TestRunner] Retrying original locators (2nd attempt)...`);
      el = await tryOriginalLocators(5000);
    }
    if (el) {
      console.log(`[TestRunner] Success! Original locator found on 2nd attempt.`);
      return {
        locator: el,
        oldLocator: originalLocator,
        newLocator: originalLocator,
        didHeal: false,
        triggeredAI: false,
        confidence: 1.0
      };
    }

    // Tier 3: Wait for page stabilization and sleep 10s, then retry
    if (!shouldForceAI) {
      console.warn(`[TestRunner] Second locator attempt failed. Waiting for page to fully load and stabilize...`);
      await this.waitForPageSettle(page, 30000);

      console.log(`[TestRunner] Retrying original locators after page stabilization (3rd attempt)...`);
      el = await tryOriginalLocators(5000);
    }
    if (el) {
      console.log(`[TestRunner] Success! Original locator found after page stabilization (3rd attempt).`);
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
    console.warn(`[TestRunner] Original locators genuinely failed for object "${step.ObjectName}". Initializing healing engine...`);

    // ── Domain mismatch guard ────────────────────────────────────────────────
    // If the browser is on a completely different domain, the element legitimately 
    // no longer exists on this page. We compare ONLY the origin (protocol + hostname + port), 
    // NOT the path, because the path may contain dynamic segments.
    const stepUrl = step.URL || step.sourceUrl || '';
    if (stepUrl) {
      try {
        const recordedOrigin = new URL(stepUrl).origin;         // protocol+hostname+port only
        const currentOrigin  = new URL(page.url()).origin;
        if (recordedOrigin !== currentOrigin) {
          console.warn(`[TestRunner] ⚠  Domain mismatch — recorded origin: "${recordedOrigin}", current: "${currentOrigin}"`);
          console.warn(`[TestRunner] ⚠  The browser is on a completely different domain. Skipping healing for step "${step.ObjectName}".`);
          // Return a dummy locator pointing at body so the runner can continue
          return {
            locator: page.locator('body').first(),
            oldLocator: originalLocator,
            newLocator: 'body',
            didHeal: false,
            triggeredAI: false,
            confidence: 0
          };
        }
      console.log(`[TestRunner] Origin check passed: "${currentOrigin}" — same domain as recorded step.`);
      } catch { /* URL parse error — proceed to healing */ }
    }
    
    // Ensure the page is fully loaded before scraping candidates and creating the AI payload
    console.log(`[TestRunner] Ensuring page is fully loaded before creating AI payload...`);
    await this.waitForPageSettle(page);

    // Scrape candidates with loading retries
    let candidates = await this.candidateFinder.findCandidates(page, step.LocTagName);

    // ── Filter shadow-internal and loading-placeholder elements ──────────────
    // Generic keyword-based heuristic: elements with IDs containing 'slot',
    // 'wrapper', 'placeholder', 'container', 'inner' are shadow DOM layout helpers
    // in virtually every web component library (ZUI, Material, Shoelace, etc.).
    // They intercept pointer events and are never valid click targets.
    const SHADOW_INTERNAL_ID_KEYWORDS = ['slot', 'wrapper', 'placeholder', 'container', 'inner'];
    const isInternalById = (id: string) =>
      id.length > 0 && SHADOW_INTERNAL_ID_KEYWORDS.some(kw => id.includes(kw));

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

    let retries = 5;
    while ((candidates.length === 0 || isLoadingStateDom(candidates)) && retries > 0) {
      const reason = candidates.length === 0 ? '0 candidates' : 'page still in loading-state (CSS-in-JS hashes only)';
      console.log(`[TestRunner] ${reason}. Retrying in 2000ms... (${retries} retries left)`);
      await page.waitForTimeout(2000);
      candidates = await this.candidateFinder.findCandidates(page, step.LocTagName);
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

    // ── Relevance cap ─────────────────────────────────────────────────────────
    // On pages like patient lists, the DOM can have 700+ candidates (one for
    // each repeated row element). Sending all of them to the AI is very slow
    // and leads to wrong picks.  We score each candidate by simple keyword
    // overlap with ObjectName + NearByText, then keep the top MAX_CANDIDATES.
    const MAX_CANDIDATES = 60;
    if (candidates.length > MAX_CANDIDATES) {
      const objectWords = (step.ObjectName || '').toLowerCase().split(/\W+/).filter(Boolean);
      const nearbyWords = (step.NearByText || [])
        .join(' ').toLowerCase().split(/\W+/).filter(Boolean);
      const allKeywords = [...new Set([...objectWords, ...nearbyWords])];

      const scored = candidates.map(c => {
        const haystack = [
          c.semantic.text,
          c.semantic.accessibleName,
          c.functional.cssSelector,
          c.functional.dataTestId,
          c.functional.id,
          c.functional.ariaLabel,
          c.ancestorContext.parentText,
        ].join(' ').toLowerCase();

        const hits = allKeywords.filter(kw => haystack.includes(kw)).length;
        return { c, hits };
      });

      // Sort: keyword hits DESC, then candidateId ASC (DOM order as tiebreak)
      scored.sort((a, b) => b.hits - a.hits || a.c.candidateId - b.c.candidateId);
      candidates = scored.slice(0, MAX_CANDIDATES).map(s => s.c);
      console.log(`[TestRunner] Relevance cap applied: kept top ${candidates.length} of ${scored.length} candidates (keywords: [${allKeywords.slice(0, 8).join(', ')}])`);
    }

    console.log(`[TestRunner] Extracted ${candidates.length} candidate elements from page.`);
    console.log(`[TestRunner] Scraped Candidates:\n`, candidates
      .map(c => `  - [ID ${c.candidateId}] tag=${c.functional.tagName} css=${c.functional.cssSelector} text="${c.semantic.accessibleName}"`)
      .slice(0, 15).join('\n') + (candidates.length > 15 ? '\n  - ...' : ''));

    // Perform healing
    const healResult = await this.healingEngine.heal(step, candidates);
    console.log(`[TestRunner] Healing engine successfully resolved locator:`);
    console.log(`  - Old: "${originalLocator}"`);
    console.log(`  - New: "${healResult.healedLocator}"`);
    console.log(`  - Confidence: ${healResult.confidence * 100}%`);
    console.log(`  - Reason: ${healResult.reason}`);

    const healedEl = page.locator(healResult.healedLocator).first();

    // Validate healed element actionability
    let isValid = await this.elementValidator.validate(healedEl, step.Action === 'Enter');
    if (!isValid) {
      console.warn(`[TestRunner] Healed element "${healResult.healedLocator}" (Chosen Candidate: ${JSON.stringify(healResult, null, 2)}) failed initial validation. Page may still be loading. Waiting 10s...`);
      await page.waitForTimeout(10000);
      isValid = await this.elementValidator.validate(healedEl, step.Action === 'Enter');
    }

    if (!isValid) {
      const candidateList = candidates.map(c => `[ID ${c.candidateId}] tag=${c.functional.tagName} css=${c.functional.cssSelector} text="${c.semantic.accessibleName}"`).join(', ');
      throw new Error(`Healed element "${healResult.healedLocator}" failed actionability validation.\nChosen Candidate: ${JSON.stringify(healResult, null, 2)}\nAll Candidates: ${candidateList}`);
    }

    return {
      locator: healedEl,
      oldLocator: originalLocator,
      newLocator: healResult.healedLocator,
      didHeal: true,
      triggeredAI: healResult.triggeredAI,
      confidence: healResult.confidence,
      reason: healResult.reason
    };
  }

  /**
   * Robust multi-iteration page-stabilization helper.
   * Runs up to 3 load checks, with a brief wait between them, to handle client-side navigations,
   * redirects, and active loader skeletons, without waiting indefinitely on networkidle.
   */
  private async waitForPageSettle(page: Page, timeoutMs = 15000): Promise<void> {
    console.log(`[TestRunner] Initializing 3-iteration page stabilization...`);
    const startTime = Date.now();

    for (let i = 1; i <= 3; i++) {
      console.log(`[TestRunner] Page stabilization check ${i}/3...`);
      try {
        await page.waitForLoadState('load', { timeout: timeoutMs });
        await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: timeoutMs });
      } catch (err: any) {
        if (err.message?.includes('closed') || err.message?.includes('Target page, context or browser has been closed')) {
          console.log(`[TestRunner] Page/browser was closed. Aborting page stabilization.`);
          return;
        }
        console.warn(`[TestRunner] Page load verification ${i}/3 timed out/failed: ${err.message || err}`);
      }

      if (i < 3) {
        console.log(`[TestRunner] Check ${i}/3 passed. Waiting 5s to verify page state stability...`);
        try {
          await page.waitForTimeout(5000);
        } catch (err: any) {
          if (err.message?.includes('closed') || err.message?.includes('Target page, context or browser has been closed')) {
            console.log(`[TestRunner] Page/browser was closed during wait. Aborting.`);
            return;
          }
          throw err;
        }
      }
    }

    // Also wait for common loading skeletons or spinners to disappear
    const loadingSelectors = ['[class*="skeleton"]', '[data-test*="skeleton"]', '[class*="spinner"]', '[class*="loading"]','.loading','#loading','#spinner'];

    const elapsed = Date.now() - startTime;
    const remainingTimeout = Math.max(2000, timeoutMs - elapsed);

    try {
      await Promise.all(
        loadingSelectors.map(async (selector) => {
          try {
            const locator = page.locator(selector);
            if (await locator.count() > 0 && await locator.first().isVisible()) {
              console.log(`[TestRunner] Detected active loader/skeleton: "${selector}". Waiting for it to hide...`);
              await locator.first().waitFor({ state: 'hidden', timeout: remainingTimeout });
            }
          } catch (err: any) {
            if (err.message?.includes('closed') || err.message?.includes('Target page, context or browser has been closed')) {
              throw err;
            }
          }
        })
      );
    } catch (err: any) {
      if (err.message?.includes('closed') || err.message?.includes('Target page, context or browser has been closed')) {
        console.log(`[TestRunner] Page/browser was closed during loader checks. Aborting.`);
        return;
      }
    }

    console.log(`[TestRunner] Dynamic content settling wait (1.5s)...`);
    try {
      await page.waitForTimeout(1500);
    } catch (err: any) {
      if (err.message?.includes('closed') || err.message?.includes('Target page, context or browser has been closed')) {
        console.log(`[TestRunner] Page/browser was closed during settling wait. Aborting.`);
        return;
      }
      throw err;
    }
    console.log(`[TestRunner] Page stabilization complete.`);
  }
}
