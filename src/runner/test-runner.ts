import * as fs from 'fs';
import * as path from 'path';
import { chromium, Locator, Page } from 'playwright';
import { OriginalElement } from '../interfaces/original-element.interface';
import { RelocateEngine } from '../index';
import { StepOutcome, HtmlReportGeneratorService } from '../reporting/execution-reporter';
import { highlightAndScreenshot } from '../utils/visual-utils';

export class TestRunner {
  private readonly testCasePath = path.resolve(process.cwd(), 'Testcase/ZeissTestcase.json');
  private outcomes: StepOutcome[] = [];

  constructor(
    private readonly relocateEngine: RelocateEngine
  ) {}

  /**
   * Main orchestrator method to execute the test suite steps.
   */
  async run(useHealing = false): Promise<void> {
    this.outcomes = [];
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
    } catch (error: any) {
      console.error(`\n[TestRunner] Test Execution Failed:`, error);
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
    const visualDebugRoot = path.join(process.cwd(), '.workspace', 'logs', 'visual-debug');
    const screenshotDir = path.join(process.cwd(), '.workspace', 'logs', 'screenshot');

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
    
    const runReportDir = path.join(process.cwd(), '.workspace', 'reports', `Execution-Report-${ts}`);
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
      await page.goto(step.InputData!, { waitUntil: 'load', timeout: 60000 });
      console.log(`[TestRunner] Navigation complete.`);
      this.recordOutcome(index, step.Action, step.ObjectName || 'Navigation Step', 'Passed', false, step.InputData!, step.InputData!);
    } catch (navErr: any) {
      this.recordOutcome(index, step.Action, step.ObjectName || 'Navigation Step', 'Failed', false, step.InputData!, step.InputData!, navErr.message || String(navErr));
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
      const originalLocator = step.LocCssSelector || step.LocXpath || '';
      let locator: Locator;
      let didHeal = false;
      let triggeredAI = false;

      // 1. Try to resolve the element using the original selector first
      try {
        locator = page.locator(originalLocator).first();
        await locator.waitFor({ state: 'visible', timeout: 2000 });
      } catch (err) {
        // Fallback: trigger relocation engine
        didHeal = true;
        triggeredAI = true;
        locator = await this.relocateEngine.relocateElement(page, originalLocator, step);
      }

      // 2. Scroll the element into view
      try {
        await locator.scrollIntoViewIfNeeded({ timeout: 1000 });
      } catch {}

      // 3. Highlight and capture step screenshot
      const padIndex = String(index + 1).padStart(2, '0');
      const liveScreenshotPath = path.join(runReportDir, `step-${padIndex}-live.png`);
      try {
        await highlightAndScreenshot(page, locator, liveScreenshotPath);
      } catch {}

      // 4. Perform interaction click/fill
      if (step.Action === 'Click') {
        console.log(`[TestRunner] Clicking element: "${originalLocator}"`);
        await locator.click({ timeout: 5000 }).catch(async () => {
          await locator.click({ force: true, timeout: 5000 });
        });
      } else if (step.Action === 'Enter') {
        console.log(`[TestRunner] Filling input element with data: "${step.InputData}"`);
        await locator.fill(step.InputData || '');
      }

      healedResultForReport = {
        didHeal,
        oldLocator: originalLocator,
        newLocator: await locator.evaluate((el) => {
          const id = el.id ? `#${el.id}` : '';
          const tag = el.tagName.toLowerCase();
          const cls = el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
          return id || `${tag}${cls}`;
        }).catch(() => originalLocator),
        confidence: didHeal ? 0.9 : 1.0,
        triggeredAI,
        reason: didHeal ? 'Recovered via AI' : 'Resolved via original selector'
      };
      stepSuccess = true;

    } catch (err: any) {
      lastActionErr = err;
      console.error(`[TestRunner] Interaction step failed:`, err);
    }

    this.compileInteractionOutcome(step, index, stepSuccess, lastActionErr, healedResultForReport);
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
        errorMessage: lastActionErr.message || String(lastActionErr),
        screenshotPath: `step-${padIndex}-live.png`
      });
      throw lastActionErr;
    }

    if (stepSuccess) {
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
        screenshotPath: `step-${padIndex}-live.png`
      });
    }
  }

  /**
   * Skips and logs unsupported actions.
   */
  private async handleUnsupportedStep(page: Page, step: OriginalElement, index: number): Promise<void> {
    console.log(`[TestRunner] Action "${step.Action}" not recognized. Skipping step.`);
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

  /**
   * Generates execution report documents and shuts down active contexts.
   */
  private async finalizeTestSuite(browser: any, sigintListener: any, sigtermListener: any, runReportDir: string, projectName: string): Promise<void> {
    process.off('SIGINT', sigintListener);
    process.off('SIGTERM', sigtermListener);

    if (this.outcomes.length > 0) {
      try {
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
}
