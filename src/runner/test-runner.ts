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

    // ── Clear visual-debug from previous runs ──────────────────────────────────
    // Stale images from a prior run would mix with the current run's data,
    // making it impossible to tell which step produced which image.
    const visualDebugRoot = path.join(process.cwd(), 'logs', 'visual-debug');
    if (fs.existsSync(visualDebugRoot)) {
      fs.rmSync(visualDebugRoot, { recursive: true, force: true });
      console.log(`[TestRunner] Cleared stale visual-debug folder from previous run.`);
    }
    fs.mkdirSync(visualDebugRoot, { recursive: true });

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
            const candIdStr = result.candidateId !== undefined ? ` (Candidate ID: ${result.candidateId})` : '';
            if (isDisabled) {
              console.warn(`[TestRunner] ⚠  Element "${result.newLocator}"${candIdStr} for step "${step.ObjectName}" is DISABLED. Skipping action and continuing to next step.`);
            } else if (step.Action === 'Click') {
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
                  // Another overlay element is on top or layout is unstable — dispatch the click directly
                  // bypassing Playwright's pointer-event interception/stability checks.
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
          } catch (actionErr: any) {
            const msg: string = actionErr?.message || String(actionErr);
            console.error(`[TestRunner] Action execution failed on element: "${result.newLocator}"`, actionErr);
            if (result.didHeal) {
              logger.logHealResult(step.ObjectName || 'unknown', result.oldLocator, result.newLocator, result.confidence, `Failed: ${msg}`, result.candidateId);
              this.healingEngine.recordOutcome(result.oldLocator, result.newLocator, false, result.triggeredAI, result.confidence);
            }
            throw actionErr;
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

  private async findAndHeal(page: Page, step: OriginalElement, stepIndex: number): Promise<{ locator: Locator; oldLocator: string; newLocator: string; didHeal: boolean; triggeredAI: boolean; confidence: number; reason?: string; candidateId?: number }> {
    const locCss = step.LocCssSelector;
    const locXpath = step.LocXpath;
    const originalLocator = locCss || locXpath || '';

    // as the testing purpose break the classical locators on any step
    const shouldForceAI = [22, 23, 24, 25, 26].includes(stepIndex);

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
      console.log(`[TestRunner] Original locator failed. Waiting 5s before retrying...`);
      await page.waitForTimeout(5000);
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

    // (Domain mismatch check removed as requested)
    
    // Ensure the page is fully loaded before scraping candidates and creating the AI payload
    console.log(`[TestRunner] Ensuring page is fully loaded before creating AI payload...`);
    await this.waitForPageSettle(page);

    // Scrape candidates with loading retries
    let candidates = await this.candidateFinder.findCandidates(page, step.OrigTagName);

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

    let retries = 2;
    while ((candidates.length === 0 || isLoadingStateDom(candidates)) && retries > 0) {
      const reason = candidates.length === 0 ? '0 candidates' : 'page still in loading-state (CSS-in-JS hashes only)';
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
        console.log(`[TestRunner] Tag filter: restricting ${candidates.length} → ${sameTagCandidates.length} candidates with tagName="${origTagUpper}"`);
        candidates = sameTagCandidates;
      } else {
        console.log(`[TestRunner] Tag filter: no candidates with tagName="${origTagUpper}" found — keeping full pool of ${candidates.length}`);
      }
    }

    // ── Relevance cap ─────────────────────────────────────────────────────────
    // On pages like patient lists, the DOM can have 700+ candidates (one for
    // each repeated row element). Sending all of them to the AI is very slow
    // and leads to wrong picks.  We score each candidate by keyword overlap with
    // ObjectName + NearByText PLUS a shadow host chain affinity bonus to ensure
    // deeply-nested form controls (e.g. input#raw inside ZUI-TEXTFIELD-V3-17)
    // are never discarded when they live inside the correct shadow component tree.
    const MAX_CANDIDATES = 60;
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
        const hits = allKeywords.filter(kw => haystack.includes(kw)).length;

        // Shadow host chain affinity: count how many of the original's shadow host
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
      console.log(`[TestRunner] Relevance cap applied: kept top ${candidates.length} of ${scored.length} candidates (keywords: [${allKeywords.slice(0, 8).join(', ')}])`);
    }

    const targetName = step.ObjectName || step.accessibleName || 'unknown';
    console.log(`[TestRunner] Extracted ${candidates.length} candidate elements for object "${targetName}".`);

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
        console.log(`[TestRunner] Pre-scored tag-matched candidates. Verifying top ${topCandidates.length} sequentially with scroll-into-view.`);

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
            await locator.scrollIntoViewIfNeeded({ timeout: 500 }).catch(err => {
              console.warn(`[TestRunner] Candidate ${c.candidateId} is not scrollable.`);
            });
            await page.waitForTimeout(100);

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
                const origW = origRight - origLeft;
                const origH = origBottom - origTop;

                if (origW <= 0 || origH <= 0) return { similarity: 0 };
                if (!candRect || candRect.width <= 0 || candRect.height <= 0) return { similarity: 0 };

                // Proportional target canvas dimensions based on original element (capped at 256px max)
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

                ctxOrig.drawImage(imgOrig, origLeft, origTop, origW, origH, 0, 0, targetW, targetH);
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
                const candLeft = candRect.left * devicePixelRatio;
                const candTop = candRect.top * devicePixelRatio;
                const candW = candRect.width * devicePixelRatio;
                const candH = candRect.height * devicePixelRatio;

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
                if (candArea >= origArea * 5) {
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
    const startTime = Date.now();

    for (let i = 1; i <= 3; i++) {
      try {
        await page.waitForLoadState('load', { timeout: timeoutMs });
        await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: timeoutMs });
      } catch (err: any) {
        if (err.message?.includes('closed') || err.message?.includes('Target page, context or browser has been closed')) {
          console.log(`[TestRunner] Page/browser was closed. Aborting page stabilization.`);
          return;
        }
      }

      if (i < 3) {
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
