import * as fs from 'fs';
import * as path from 'path';

import { chromium, Locator, Page } from 'playwright';

import { OriginalElement } from '../interfaces/original-element.interface';
import { RecoveryEngine } from '../recovery-engine/recovery.engine';
import { IRecoveryPipeline } from '../interfaces/recovery-pipeline.interface';
import { StatusOverlay } from './status-overlay';
import { StepOutcome, HtmlReportGeneratorService } from '../reporting/execution-reporter';
import { validateOriginalLocatorSemantically } from '../validation/safety.validator';
import { logger } from '../utils/debug-logger';
import { highlightAndScreenshot } from '../utils/visual-utils';
import { waitForPageSettle } from '../utils/page-stabilizer';

export class TestRunner {
  private readonly testCasePath = path.resolve(__dirname, '../../Testcase/AstroTestcase.json');
  private useHealing = false;
  private outcomes: StepOutcome[] = [];

  constructor(
    private readonly recoveryEngine: RecoveryEngine,
    private readonly statusOverlay: StatusOverlay,
    private readonly recoveryPipeline: IRecoveryPipeline
  ) {}

  /**
   * Main orchestrator method to execute the test suite steps.
   */
  async run(useHealing = false): Promise<void> {
    this.useHealing = useHealing;
    this.outcomes = [];
    console.log(`[TestRunner] Starting Playwright Test Execution`);

    const testcase = this.loadTestCase();
    const steps = testcase.TestSteps || [];
    const projectName = testcase.ProjectName || 'Untitled';

    const runReportDir = this.prepareLoggingDirectories();
    const { browser, page } = await this.launchBrowser();
    const { sigintListener, sigtermListener } = this.setupTerminationHandler(browser, runReportDir, projectName);

    try {
      for (let i = 0; i < steps.length; i++) {
        await this.executeTestStep(page, steps[i], i, steps.length, runReportDir);
      }
      console.log(`\n==================================================`);
      console.log(`[TestRunner] All test steps executed successfully!`);
      console.log(`\n[TestRunner] Final Session Healing Stats:`);
      console.log(JSON.stringify(this.recoveryEngine.getStats(), null, 2));
    } catch (error: any) {
      this.logTestSuiteError(error);
    } finally {
      await this.finalizeTestSuite(browser, sigintListener, sigtermListener, runReportDir, projectName);
    }
  }

  /**
   * Loads and parses the test steps configuration.
   */
  private loadTestCase(): { TestSteps: OriginalElement[]; ProjectName?: string } {
    if (!fs.existsSync(this.testCasePath)) {
      console.error(`[TestRunner] Testcase file not found at: ${this.testCasePath}`);
      process.exit(1);
    }
    return JSON.parse(fs.readFileSync(this.testCasePath, 'utf8'));
  }

  /**
   * Recreates fresh folders for outputs and returns the new report directory path.
   */
  private prepareLoggingDirectories(): string {
    const visualDebugRoot = path.join(process.cwd(), 'logs', 'visual-debug');
    const screenshotDir = path.join(process.cwd(), 'logs', 'screenshot');

    // Clean old paths
    [visualDebugRoot, screenshotDir].forEach((dir) => {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      fs.mkdirSync(dir, { recursive: true });
    });

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    
    const runReportDir = path.join(process.cwd(), 'reports', `Execution-Report-${ts}`);
    fs.mkdirSync(runReportDir, { recursive: true });
    console.log(`[TestRunner] Execution report directory created at: ${runReportDir}`);
    return runReportDir;
  }

  /**
   * Spawns a Chromium page context.
   */
  private async launchBrowser(): Promise<{ browser: any; page: Page }> {
    const browser = await chromium.launch({
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

    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    return { browser, page };
  }

  /**
   * Dispatches steps according to action type.
   */
  private async executeTestStep(page: Page, step: OriginalElement, index: number, totalSteps: number, runReportDir: string): Promise<void> {
    logger.stepStart(index + 1, totalSteps, step.Action, step.ObjectName || 'unknown');
    console.log(`\n==================================================`);
    console.log(`[TestRunner] STEP ${index + 1}/${totalSteps}: Action="${step.Action}" Object="${step.ObjectName}"`);

    if (step.Action === 'Navigate') {
      await this.handleNavigationStep(page, step, index);
    } else if (step.Action === 'Click' || step.Action === 'Enter') {
      await this.handleInteractionStep(page, step, index, runReportDir);
    } else {
      await this.handleUnsupportedStep(page, step, index);
    }

    await page.waitForTimeout(800);
  }

  /**
   * Performs standard navigation actions.
   */
  private async handleNavigationStep(page: Page, step: OriginalElement, index: number): Promise<void> {
    try {
      console.log(`[TestRunner] Navigating to: ${step.InputData}`);
      await page.goto(step.InputData, { waitUntil: 'load', timeout: 60000 });
      console.log(`[TestRunner] Navigation complete.`);
      this.recordOutcome(index, step.Action, step.ObjectName || 'Navigation Step', 'Passed', false, step.InputData, step.InputData);
    } catch (navErr: any) {
      this.recordOutcome(index, step.Action, step.ObjectName || 'Navigation Step', 'Failed', false, step.InputData, step.InputData, navErr.message || String(navErr));
      throw navErr;
    }
  }

  /**
   * Executes Click and Enter steps with retries and healing callbacks.
   */
  private async handleInteractionStep(page: Page, step: OriginalElement, index: number, runReportDir: string): Promise<void> {
    let stepSuccess = false;
    let lastActionErr: any = null;
    let healedResultForReport: any = null;

    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        let result;
        
        try {
          // 1. Locate and/or recover target element
          result = await this.locateAndRecoverElement(page, step, index);

          // 2. Handle page transition skips (confidence is 0)
          if (result.confidence === 0) {
            console.log(`[TestRunner] Step "${step.ObjectName}" skipped — page has navigated away.`);
            this.recordOutcome(index, step.Action, step.ObjectName || 'unknown', 'Skipped', false, result.oldLocator, result.newLocator, undefined, 'Page has navigated away from the recorded URL.');
            stepSuccess = true;
            break;
          }

          // 3. Interact with the resolved element
          await this.executeInteractionAction(page, result.locator, result, step, index, runReportDir);
          healedResultForReport = result;
          stepSuccess = true;
          break;

        } catch (err: any) {
          lastActionErr = err;
          const msg = err?.message || String(err);

          // Retry logic on the first attempt failure
          if (attempt === 1) {
            const isStale = msg.includes('not visible') || msg.includes('detached') || msg.includes('stale');
            if (isStale) {
              console.warn(`[TestRunner] Element became invisible or detached. Retrying step from scratch...`);
              await this.statusOverlay.show(page, 'RETRYING');
              await page.waitForTimeout(1500);
              continue;
            } else {
              console.warn(`[TestRunner] Healing/Validation process failed on attempt 1: ${msg}. Waiting 4s and retrying...`);
              await this.statusOverlay.show(page, 'STABILIZE');
              await waitForPageSettle(page, 15000);
              await this.statusOverlay.show(page, 'RETRYING');
              await page.waitForTimeout(4000);
              continue;
            }
          }

          // Log failure details on the final attempt
          if (result) {
            healedResultForReport = result;
            console.error(`[TestRunner] Action execution failed on element: "${result.newLocator}"`, err);
            if (result.didHeal) {
              logger.logHealResult(step.ObjectName || 'unknown', result.oldLocator, result.newLocator, result.confidence, `Failed: ${msg}`, result.candidateId);
              this.recoveryEngine.recordOutcome(result.oldLocator, result.newLocator, false, result.triggeredAI, result.confidence);
            }
          } else {
            console.error(`[TestRunner] Healing process failed on step ${index + 1} attempt ${attempt}: ${msg}`);
            // Capture failure screenshot if healing fails completely
            const stepNumStr = String(index + 1).padStart(2, '0');
            const screenshotDir = path.join(process.cwd(), 'logs', 'screenshot');
            if (!fs.existsSync(screenshotDir)) {
              fs.mkdirSync(screenshotDir, { recursive: true });
            }
            const screenshotPath = path.join(screenshotDir, `step-${stepNumStr}-live.png`);
            try {
              await page.screenshot({ path: screenshotPath });
              console.log(`[TestRunner] Captured failure screenshot: ${screenshotPath}`);
            } catch (ssErr: any) {
              console.warn(`[TestRunner] Failed to capture failure screenshot: ${ssErr.message || ssErr}`);
            }
          }
        }
      }
    } finally {
      await this.statusOverlay.hide(page);
    }

    this.compileInteractionOutcome(step, index, stepSuccess, lastActionErr, healedResultForReport);
  }

  /**
   * Executes the actual user click/fill action, logs recovery, and takes step screenshots.
   */
  private async executeInteractionAction(
    page: Page,
    element: Locator,
    result: any,
    step: OriginalElement,
    index: number,
    runReportDir: string
  ): Promise<void> {
    // Scroll target element to center
    try {
      await element.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
      await page.waitForTimeout(200);
    } catch (scrollErr) { /* ignore scroll issues */ }

    // Shift status overlay alignment if element collision occurs
    await this.statusOverlay.show(page, 'INTERACTING', { element });
    await this.captureStepScreenshot(page, element, step, index, runReportDir);

    const candIdStr = result.candidateId !== undefined ? ` (Candidate ID: ${result.candidateId})` : '';

    // Perform click/fill action
    if (step.Action === 'Click') {
      await this.performClickAction(element, result.newLocator, candIdStr);
    } else if (step.Action === 'Enter') {
      await this.performFillAction(element, result.newLocator, step.InputData || '', candIdStr);
    }

    if (result.didHeal) {
      logger.logHealResult(step.ObjectName || 'unknown', result.oldLocator, result.newLocator, result.confidence, result.reason || 'Healed', result.candidateId);
      this.recoveryEngine.recordOutcome(result.oldLocator, result.newLocator, true, result.triggeredAI, result.confidence);
      console.log(`[TestRunner] Healing recorded.`);
    }
  }

  /**
   * Performs standard clicks with automated forced fallbacks.
   */
  private async performClickAction(element: Locator, newLocator: string, candIdStr: string): Promise<void> {
    console.log(`[TestRunner] Clicking element: "${newLocator}"${candIdStr}`);
    try {
      await element.click({ timeout: 2000 });
    } catch (firstClickErr: any) {
      const firstMsg = firstClickErr?.message || String(firstClickErr);
      const isInterceptedOrTimeout = 
        firstMsg.includes('intercepts pointer events') || 
        firstMsg.includes('pointer-events') || 
        firstMsg.includes('Timeout') || 
        firstClickErr?.name === 'TimeoutError';

      if (isInterceptedOrTimeout) {
        console.warn(`[TestRunner] Click failed or timed out. Retrying with force:true...`);
        await element.click({ force: true, timeout: 8000 });
        const resolvedTag = await element.evaluate((el) => el.tagName).catch(() => 'unknown');
        console.log(`[TestRunner] Click succeeded on element of tag name: "${resolvedTag}"`);
      } else {
        throw firstClickErr;
      }
    }
  }

  /**
   * Performs input fill operations.
   */
  private async performFillAction(element: Locator, newLocator: string, data: string, candIdStr: string): Promise<void> {
    console.log(`[TestRunner] Filling input element "${newLocator}"${candIdStr} with text: "${data}"`);
    await element.fill(data);
  }

  /**
   * Compiles step outcomes for click and enter operations.
   */
  private compileInteractionOutcome(step: OriginalElement, index: number, stepSuccess: boolean, lastActionErr: any, healedResultForReport: any): void {
    if (!stepSuccess && lastActionErr) {
      const padIndex = String(index + 1).padStart(2, '0');
      const healed = healedResultForReport ? healedResultForReport.didHeal : false;
      this.outcomes.push({
        stepIndex: index + 1,
        action: step.Action,
        objectName: step.ObjectName || 'unknown',
        status: 'Failed',
        healed,
        oldLocator: healedResultForReport ? healedResultForReport.oldLocator : (step.LocCssSelector || step.LocXpath || ''),
        newLocator: healedResultForReport ? healedResultForReport.newLocator : (step.LocCssSelector || step.LocXpath || ''),
        confidence: healedResultForReport ? healedResultForReport.confidence : undefined,
        reason: healedResultForReport ? healedResultForReport.reason : undefined,
        triggeredAI: healedResultForReport ? healedResultForReport.triggeredAI : undefined,
        candidateId: healedResultForReport ? healedResultForReport.candidateId : undefined,
        topCandidates: healedResultForReport ? healedResultForReport.topCandidates : undefined,
        errorMessage: lastActionErr.message || String(lastActionErr),
        screenshotPath: `step-${padIndex}-live.png`,
        originalScreenshotPath: step.Screenshot ? `step-${padIndex}-original.png` : undefined
      });
      throw lastActionErr;
    }

    if (stepSuccess) {
      const isSkipped = this.outcomes.some((o) => o.stepIndex === index + 1 && o.status === 'Skipped');
      if (!isSkipped) {
        const padIndex = String(index + 1).padStart(2, '0');
        const healed = healedResultForReport ? healedResultForReport.didHeal : false;

        this.outcomes.push({
          stepIndex: index + 1,
          action: step.Action,
          objectName: step.ObjectName || 'unknown',
          status: 'Passed',
          healed,
          oldLocator: healedResultForReport ? healedResultForReport.oldLocator : (step.LocCssSelector || step.LocXpath || ''),
          newLocator: healedResultForReport ? healedResultForReport.newLocator : (step.LocCssSelector || step.LocXpath || ''),
          confidence: healedResultForReport ? healedResultForReport.confidence : undefined,
          reason: healedResultForReport ? healedResultForReport.reason : undefined,
          triggeredAI: healedResultForReport ? healedResultForReport.triggeredAI : undefined,
          candidateId: healedResultForReport ? healedResultForReport.candidateId : undefined,
          topCandidates: healedResultForReport ? healedResultForReport.topCandidates : undefined,
          screenshotPath: `step-${padIndex}-live.png`,
          originalScreenshotPath: step.Screenshot ? `step-${padIndex}-original.png` : undefined
        });
      }
    }
  }

  /**
   * Skips and logs unsupported actions.
   */
  private async handleUnsupportedStep(page: Page, step: OriginalElement, index: number): Promise<void> {
    console.log(`[TestRunner] Action "${step.Action}" not recognized. Skipping step.`);
    const stepNumStr = String(index + 1).padStart(2, '0');
    const screenshotDir = path.join(process.cwd(), 'logs', 'screenshot');
    
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }
    const screenshotPath = path.join(screenshotDir, `step-${stepNumStr}-live.png`);
    try {
      await page.screenshot({ path: screenshotPath });
      console.log(`[TestRunner] Captured fallback step screenshot: ${screenshotPath}`);
    } catch (err: any) {
      console.warn(`[TestRunner] Failed to capture fallback screenshot for unrecognized step:`, err.message || err);
    }
    this.recordOutcome(index, step.Action, step.ObjectName || 'unknown', 'Skipped', false, '', '', undefined, `Action "${step.Action}" not recognized.`);
  }

  /**
   * Centralized helper to push step execution metadata to outcome lists.
   */
  private recordOutcome(
    index: number,
    action: string,
    objectName: string,
    status: 'Passed' | 'Failed' | 'Skipped',
    healed: boolean,
    oldLocator: string,
    newLocator: string,
    errorMessage?: string,
    reason?: string
  ): void {
    this.outcomes.push({
      stepIndex: index + 1,
      action,
      objectName,
      status,
      healed,
      oldLocator,
      newLocator,
      errorMessage,
      reason
    });
  }

  private logTestSuiteError(error: any): void {
    const msg = error?.message || String(error);
    if (msg.includes('[RecoveryEngine]')) {
      console.error(`\n[TestRunner] Test Execution Failed: ${msg}`);
    } else {
      console.error(`\n[TestRunner] Test Execution Failed at some step:`, error);
    }
  }

  /**
   * Generates execution report documents and shuts down active contexts.
   */
  private async finalizeTestSuite(browser: any, sigintListener: any, sigtermListener: any, runReportDir: string, projectName: string): Promise<void> {
    process.off('SIGINT', sigintListener);
    process.off('SIGTERM', sigtermListener);

    if (this.outcomes.length > 0) {
      try {
        for (const outcome of this.outcomes) {
          this.archiveStepArtifacts(outcome.stepIndex, runReportDir, outcome);
        }
        HtmlReportGeneratorService.generate(this.outcomes, runReportDir, projectName);
      } catch (repErr: any) {
        console.error(`[TestRunner] Failed to generate HTML report:`, repErr);
      }
    }
    console.log(`[TestRunner] Closing browser...`);
    await browser.close();
  }

  /**
   * Gracefully listens to terminal events and captures outcome reports.
   */
  private setupTerminationHandler(browser: any, runReportDir: string, projectName: string) {
    const handleTermination = async (signal: string) => {
      console.warn(`\n[TestRunner] Received ${signal}. Executing cleanup and generating final report...`);
      if (this.outcomes.length > 0) {
        try {
          for (const outcome of this.outcomes) {
            this.archiveStepArtifacts(outcome.stepIndex, runReportDir, outcome);
          }
          HtmlReportGeneratorService.generate(this.outcomes, runReportDir, projectName);
        } catch (repErr: any) {
          console.error(`[TestRunner] Failed to generate HTML report:`, repErr);
        }
      }
      try {
        await browser.close();
      } catch { }
      process.exit(1);
    };

    const sigintListener = () => handleTermination('SIGINT');
    const sigtermListener = () => handleTermination('SIGTERM');
    process.once('SIGINT', sigintListener);
    process.once('SIGTERM', sigtermListener);

    return { sigintListener, sigtermListener };
  }

  /**
   * Copies debugging captures and step screenshots to their destination folders.
   */
  private archiveStepArtifacts(stepIndex: number, runReportDir: string, outcome: StepOutcome): void {
    const padIndex = String(stepIndex).padStart(2, '0');
    const screenshotDir = path.join(process.cwd(), 'logs', 'screenshot');
    const liveScreenshotPath = path.join(screenshotDir, `step-${padIndex}-live.png`);

    if (fs.existsSync(liveScreenshotPath)) {
      outcome.screenshotPath = `../../logs/screenshot/step-${padIndex}-live.png`;
    }

    outcome.originalFullScreenshotPath = undefined;

    const stepFolder = path.join(runReportDir, `step-${padIndex}`);
    if (outcome.healed && outcome.candidateId !== undefined) {
      if (!fs.existsSync(stepFolder)) {
        fs.mkdirSync(stepFolder, { recursive: true });
      }

      const debugDir = path.join(process.cwd(), 'logs', 'visual-debug', `step-${stepIndex}`);
      const origCropSrc = path.join(debugDir, 'original_template.png');
      const origCropDest = path.join(stepFolder, `step-${padIndex}-original.png`);
      
      if (fs.existsSync(origCropSrc)) {
        try {
          fs.copyFileSync(origCropSrc, origCropDest);
          outcome.originalScreenshotPath = `step-${padIndex}/step-${padIndex}-original.png`;
        } catch (err: any) {
          console.warn(`[TestRunner] Failed to copy original crop template: ${err.message}`);
        }
      }

      if (fs.existsSync(debugDir)) {
        try {
          const files = fs.readdirSync(debugDir);
          const candFile = files.find((f) => f.startsWith(`candidate_${outcome.candidateId}_score_`));
          if (candFile) {
            fs.copyFileSync(path.join(debugDir, candFile), path.join(stepFolder, `step-${padIndex}-healed.png`));
          }
        } catch (err: any) {
          console.warn(`[TestRunner] Failed to copy candidate crop: ${err.message}`);
        }
      }
    }
  }

  /**
   * Highlights the element and takes screenshot.
   * Saves two images to logs/screenshot for debugging:
   *   - step-XX-live.png     → current page with element highlighted
   *   - step-XX-original.png → original recorded screenshot from test case
   */
  private async captureStepScreenshot(page: Page, locator: Locator, step: OriginalElement, stepIndex: number, reportDir: string): Promise<void> {
    const stepNumStr = String(stepIndex + 1).padStart(2, '0');
    const screenshotDir = path.join(process.cwd(), 'logs', 'screenshot');
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    // 1. Save current live screenshot (with element highlight)
    const liveScreenshotPath = path.join(screenshotDir, `step-${stepNumStr}-live.png`);
    await highlightAndScreenshot(page, locator, liveScreenshotPath);

    // 2. Save original recorded screenshot from test case (if available)
    if (step.Screenshot) {
      try {
        const originalScreenshotPath = path.join(screenshotDir, `step-${stepNumStr}-original.png`);
        let base64Data = step.Screenshot.trim();
        if (base64Data.startsWith('data:image/')) {
          base64Data = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');
        }
        fs.writeFileSync(originalScreenshotPath, Buffer.from(base64Data, 'base64'));
        console.log(`[TestRunner] Saved debug screenshots: step-${stepNumStr}-original.png & step-${stepNumStr}-live.png`);
      } catch (err: any) {
        console.warn(`[TestRunner] Failed to save original screenshot for step ${stepNumStr}: ${err.message || err}`);
      }
    }
  }

  /**
   * Main entrypoint for locator healing sequence.
   */
  private async locateAndRecoverElement(page: Page, step: OriginalElement, stepIndex: number): Promise<{ locator: Locator; oldLocator: string; newLocator: string; didHeal: boolean; triggeredAI: boolean; confidence: number; reason?: string; candidateId?: number; topCandidates?: any[] }> {
    step.stepIndex = stepIndex;
    const locCss = step.LocCssSelector;
    const locXpath = step.LocXpath;
    const originalLocator = locCss || locXpath || '';

    this.statusOverlay.setObjectName(step.ObjectName || '');

    const shouldForceAI = [12].includes(stepIndex) || this.useHealing;

    if (!shouldForceAI) {
      await this.statusOverlay.show(page, 'LOCATING');
      const result = await this.resolveViaOriginalSelectors(page, step, stepIndex, originalLocator);
      if (result) {
        return result;
      }
    } else {
      await this.statusOverlay.show(page, 'STABILIZE');
      logger.debug(`[TestRunner] Bypassing original locators for step ${stepIndex + 1} (index ${stepIndex}) "${step.ObjectName}" to force recovery...`);
      step.forceAI = true;
    }

    return await this.recoveryPipeline.recoverElement(page, step, stepIndex, originalLocator);
  }

  /**
   * Direct execution of standard selectors.
   */
  private async resolveViaOriginalSelectors(
    page: Page,
    step: OriginalElement,
    stepIndex: number,
    originalLocator: string
  ): Promise<{ locator: Locator; oldLocator: string; newLocator: string; didHeal: boolean; triggeredAI: boolean; confidence: number } | null> {
    let el = await this.tryOriginalLocators(page, step, 1500);

    if (el) {
      const isValid = await validateOriginalLocatorSemantically(el, step);
      if (isValid) {
        await this.statusOverlay.show(page, 'INTERACTING');
        return {
          locator: el,
          oldLocator: originalLocator,
          newLocator: originalLocator,
          didHeal: false,
          triggeredAI: false,
          confidence: 1.0
        };
      } else {
        logger.warn(`[TestRunner] Original locator matched on 1st attempt, but semantic validation failed.`);
      }
    }

    await this.statusOverlay.show(page, 'STABILIZE');

    await waitForPageSettle(page, 15000);
    await this.statusOverlay.show(page, 'RETRYING');
    el = await this.tryOriginalLocators(page, step, 5000);

    if (el) {
      const isValid = await validateOriginalLocatorSemantically(el, step);
      if (isValid) {
        logger.debug(`[TestRunner] Success! Original locator found on 2nd attempt.`);
        await this.statusOverlay.show(page, 'INTERACTING');
        return {
          locator: el,
          oldLocator: originalLocator,
          newLocator: originalLocator,
          didHeal: false,
          triggeredAI: false,
          confidence: 1.0
        };
      } else {
        logger.warn(`[TestRunner] Original locator matched on 2nd attempt, but semantic validation failed.`);
      }
    }

    return null;
  }

  /**
   * Attempts to locate the element using CSS/XPath selectors and shadow DOM fallbacks.
   */
  private async tryOriginalLocators(page: Page, step: OriginalElement, timeoutMs: number): Promise<Locator | null> {
    const locCss = step.LocCssSelector;
    const locXpath = step.LocXpath;
    const hosts: string[] = (step.ShadowDomHostArray || []).filter(Boolean);

    if (hosts.length > 0) {
      const locClass = step.LocClassName;
      const hostVariantOf = (raw: string) => [raw, raw.replace(/:nth-child\(\d+\)/g, '').trim()].filter((v, i, a) => a.indexOf(v) === i);

      // 1. Piercing by class
      if (locClass) {
        for (const rawHost of hosts) {
          for (const hostSel of hostVariantOf(rawHost)) {
            try {
              const inner = page.locator(hostSel).first().locator(`.${locClass}`).first();
              if (await inner.isVisible({ timeout: timeoutMs })) {
                console.log(`[TestRunner] Shadow piercing via LocClassName ".${locClass}" succeeded.`);
                return inner;
              }
            } catch { }
          }
        }
      }

      // 2. Piercing by CSS
      const SHADOW_INTERNAL_KEYWORDS = ['slot', 'wrapper', 'placeholder', 'container', 'inner'];
      const isShadowInternalCss = (css: string | undefined): boolean => {
        if (!css) return false;
        const lower = css.toLowerCase().trim();
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
            } catch { }
          }
        }
      }

      // 3. Shadow host fallback
      for (const rawHost of [...hosts].reverse()) {
        for (const hostSel of hostVariantOf(rawHost)) {
          try {
            const hostEl = page.locator(hostSel).first();
            if (await hostEl.isVisible({ timeout: Math.min(timeoutMs / 4, 3000) })) {
              console.log(`[TestRunner] Shadow host direct click: "${hostSel}"`);
              return hostEl;
            }
          } catch { }
        }
      }
    }

    const locatorsToTry = [locCss, locXpath].filter(Boolean) as string[];
    for (const loc of locatorsToTry) {
      try {
        await page.waitForSelector(loc, { timeout: timeoutMs, state: 'attached' });
        const el = page.locator(loc).first();
        if (await el.isVisible()) return el;
      } catch (err: any) { }
    }

    return null;
  }
}
