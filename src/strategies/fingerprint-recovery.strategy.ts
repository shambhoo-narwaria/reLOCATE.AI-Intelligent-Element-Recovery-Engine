import { Page, Locator } from 'playwright';
import { OriginalElement } from '../interfaces/original-element.interface';
import { IRecoveryStrategy, RecoveryResult } from '../interfaces/recovery-strategy.interface';
import { RelocateEngine } from '../relocate-engine/relocate.engine';
import { CandidateFinder } from '../relocate-engine/candidate-finder';
import { ElementValidator } from '../validation/element.validator';
import { StatusOverlay } from '../utils/status-overlay';
import { Candidate } from '../interfaces/candidate.interface';
import { logger } from '../utils/debug-logger';
import { waitForPageSettle } from '../utils/page-stabilizer';
import { saveBase64Image, saveOriginalTemplateImage, performVisualComparison } from '../utils/visual-utils';
import * as fs from 'fs';
import * as path from 'path';

function loadConfig() {
  try {
    const configPath = path.join(process.cwd(), 'config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {}
  return { ENABLE_MCP_FALLBACK: true };
}

export function resolvePlaywrightLocator(page: Page, selectorStr: string): Locator {
  if (!selectorStr) return page.locator('body');

  const trimmed = selectorStr.trim();

  // Handle native Playwright locator expressions (getByRole, getByText, locator, etc.)
  const nativeExprPrefixes = ['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder',
    'getByAltText', 'getByTitle', 'getByTestId', 'locator', 'first()', 'last()'];

  const cleanExpr = trimmed.replace(/^(await\s+)?page\./, '');
  if (nativeExprPrefixes.some(prefix => cleanExpr.startsWith(prefix))) {
    try {
      const fn = new Function('page', `return page.${cleanExpr};`);
      const loc = fn(page);
      if (loc && (typeof loc.elementHandle === 'function' || typeof loc.click === 'function' || typeof loc.first === 'function')) {
        return loc;
      }
    } catch {
      // Fallback to standard selector if dynamic evaluation fails
    }
  }

  // Standard Playwright locator fallback
  return page.locator(trimmed);
}

/**
 * Stage 1: Fingerprint Recovery Strategy
 *
 * Executes DOM scraping, 11-rule heuristic scoring, optional LLM candidate
 * reasoning, and safety validation. Runs up to 2 healing cycle attempts.
 * Token cost: 0 for Stage 1A (heuristic), variable for Stage 1B (LLM).
 */
export class FingerprintRecoveryStrategy implements IRecoveryStrategy {
  readonly name = 'Stage1-Fingerprint';
  readonly priority = 10;

  constructor(
    private relocateEngine: RelocateEngine,
    private candidateFinder: CandidateFinder,
    private elementValidator: ElementValidator,
    private statusOverlay: StatusOverlay
  ) {}

  isEnabled(): boolean {
    return true; // Fingerprint recovery is always enabled
  }

  async execute(
    page: Page,
    originalElement: OriginalElement,
    failureReason: string
  ): Promise<RecoveryResult> {
    const originalLocator = originalElement.LocCssSelector || originalElement.LocXpath || '';

    // Attempt 1
    let firstAttempt: any = null;
    let firstAttemptErr: any = null;
    try {
      firstAttempt = await this.runHealingCycle(page, originalElement);
    } catch (err: any) {
      firstAttemptErr = err;
      console.warn(`[FingerprintRecovery] Healing attempt 1 failed. Re-running...`);
    }

    if (firstAttempt && firstAttempt.validationPassed) {
      await this.statusOverlay.show(page, 'COMPLETE');
      await page.waitForTimeout(1000).catch(() => {});
      return {
        success: true,
        locator: firstAttempt.locator,
        healedSelector: firstAttempt.healResult.healedLocator,
        confidence: firstAttempt.healResult.confidence,
        reason: firstAttempt.healResult.reason,
        candidateId: firstAttempt.healResult.candidateId,
        triggeredAI: firstAttempt.healResult.triggeredAI,
        topCandidates: firstAttempt.topCandidates
      };
    }

    // Attempt 2
    console.warn(`[FingerprintRecovery] Re-running healing cycle (Attempt 2)...`);
    try {
      await waitForPageSettle(page, 10000, this.statusOverlay);
    } catch { /* page may be closed */ }

    let secondAttempt: any = null;
    let secondAttemptErr: any = null;
    try {
      secondAttempt = await this.runHealingCycle(page, originalElement);
    } catch (retryErr: any) {
      secondAttemptErr = retryErr;
      console.error(`[FingerprintRecovery] Both attempts failed. First: ${firstAttemptErr?.message || firstAttemptErr}, Second: ${retryErr.message || retryErr}`);
    }

    if (secondAttempt && secondAttempt.validationPassed) {
      await this.statusOverlay.show(page, 'COMPLETE').catch(() => {});
      await page.waitForTimeout(1000).catch(() => {});
      return {
        success: true,
        locator: secondAttempt.locator,
        healedSelector: secondAttempt.healResult.healedLocator,
        confidence: secondAttempt.healResult.confidence,
        reason: secondAttempt.healResult.reason,
        candidateId: secondAttempt.healResult.candidateId,
        triggeredAI: secondAttempt.healResult.triggeredAI,
        topCandidates: secondAttempt.topCandidates
      };
    }

    // Both attempts failed validation -- return failure with best-effort data
    return {
      success: false,
      locator: secondAttempt?.locator || firstAttempt?.locator,
      healedSelector: secondAttempt?.healResult?.healedLocator || firstAttempt?.healResult?.healedLocator || '',
      confidence: secondAttempt?.healResult?.confidence || firstAttempt?.healResult?.confidence || 0,
      reason: (secondAttemptErr || firstAttemptErr)?.message || 'Both fingerprint healing cycles failed pre-action validation',
      candidateId: secondAttempt?.healResult?.candidateId || firstAttempt?.healResult?.candidateId,
      triggeredAI: secondAttempt?.healResult?.triggeredAI || firstAttempt?.healResult?.triggeredAI || false,
      topCandidates: secondAttempt?.topCandidates || firstAttempt?.topCandidates
    };
  }

  // ─── Private helpers (moved from RelocateElement) ───────────────────

  private async runHealingCycle(
    page: Page,
    originalElement: OriginalElement
  ): Promise<{ locator: Locator; healResult: any; topCandidates: any[]; validationPassed: boolean }> {
    await this.statusOverlay.show(page, 'STABILIZE');
    console.log(`[FingerprintRecovery] Waiting 3s for layout to settle...`);
    try {
      await page.waitForTimeout(3000);
    } catch { /* page closed */ }

    await waitForPageSettle(page, 30000, this.statusOverlay);

    // Scrape DOM and filter loading states/skeletons/internal elements
    let candidates = await this.scrapeAndFilterCandidates(page, originalElement);

    // Prune candidate pool
    await this.statusOverlay.show(page, 'PRUNE');
    candidates = this.pruneCandidatesByRelevance(originalElement, candidates);

    // Visual template match scoring
    await this.performVisualVerification(page, originalElement, candidates);

    await this.statusOverlay.show(page, 'SAFETY');

    // Run healing rule compilation
    const healResult = await this.relocateEngine.heal(originalElement, candidates, async (phase) => {
      await this.statusOverlay.show(page, phase);
    });

    // Resolve locator and validate
    const { locator: healedEl, validationPassed } = await this.resolveAndValidateHealedLocator(page, originalElement, healResult);

    const topCandidates = this.getTopCandidatesForReport(originalElement, candidates);

    return { locator: healedEl, healResult, topCandidates, validationPassed };
  }

  // The following methods are delegated stubs. They will be populated
  // by moving private methods from RelocateElement during the refactoring.
  // For now, they reference the same logic patterns.

  private async scrapeAndFilterCandidates(page: Page, originalElement: OriginalElement): Promise<Candidate[]> {
    const consoleListener = (msg: any) => {
      if (msg.text().includes('[CandidateFinder]')) {
        logger.debug(msg.text());
      }
    };
    page.on('console', consoleListener);

    await this.statusOverlay.show(page, 'SCRAPE');
    let candidates = await this.safeFindCandidates(page, originalElement.OrigTagName?.toUpperCase() === 'SLOT' ? undefined : originalElement.OrigTagName);

    page.removeListener('console', consoleListener);

    const SHADOW_INTERNAL_ID_KEYWORDS = ['slot', 'wrapper', 'placeholder', 'container', 'inner'];
    const isInternalById = (id: string) => id.length > 0 && SHADOW_INTERNAL_ID_KEYWORDS.some(kw => id.includes(kw));

    candidates = candidates.filter(c => {
      const testId = (c.functional.dataTestId || '').toLowerCase();
      const css = (c.functional.cssSelector || '').toLowerCase();
      const id = (c.functional.id || '').toLowerCase();

      if (testId.includes('skeleton')) return false;
      if (css.includes('skeleton')) return false;
      if (isInternalById(id) && !c.functional.dataTestId && !c.semantic.text && !c.semantic.accessibleName && !c.functional.role) return false;

      const PLAIN_WRAPPER_CLASSES = /^div\.(content|checkbox-container|inner|layout|col|row|cell|wrapper|container|grid|main)$/;
      if (PLAIN_WRAPPER_CLASSES.test(css) && !c.functional.id && !c.functional.dataTestId && !c.semantic.text) return false;

      return true;
    });
    console.log(`[FingerprintRecovery] Candidates found: ${candidates.length}`);

    const ROOT_IDS = new Set(['app', 'root', 'main', 'body', '__next', 'application']);
    const isLoadingStateDom = (cands: typeof candidates): boolean => {
      if (cands.length === 0) return false;
      const hasAnyMeaningful = cands.some(c =>
        c.semantic.text ||
        c.functional.role ||
        c.functional.dataTestId ||
        c.functional.dataQa ||
        c.functional.dataCy ||
        (c.functional.id && !ROOT_IDS.has(c.functional.id.toLowerCase()))
      );
      const hasCssHash = cands.some(c =>
        /\.(sc-|css-)[a-zA-Z0-9]+/.test(c.functional.cssSelector || '')
      );
      return !hasAnyMeaningful && hasCssHash;
    };

    if (isLoadingStateDom(candidates)) {
      console.warn(`[FingerprintRecovery] Detected loading-state DOM (CSS hash classes with no semantic content). Waiting 5s and re-scraping...`);
      try { await page.waitForTimeout(5000); } catch {}
      try {
        await waitForPageSettle(page, 15000, this.statusOverlay);
      } catch {}
      await this.statusOverlay.show(page, 'SCRAPE');
      page.on('console', consoleListener);
      candidates = await this.safeFindCandidates(page, originalElement.OrigTagName?.toUpperCase() === 'SLOT' ? undefined : originalElement.OrigTagName);
      page.removeListener('console', consoleListener);

      candidates = candidates.filter(c => {
        const testId = (c.functional.dataTestId || '').toLowerCase();
        const css = (c.functional.cssSelector || '').toLowerCase();
        const id = (c.functional.id || '').toLowerCase();
        if (testId.includes('skeleton')) return false;
        if (css.includes('skeleton')) return false;
        if (isInternalById(id) && !c.functional.dataTestId && !c.semantic.text && !c.semantic.accessibleName && !c.functional.role) return false;
        const PLAIN_WRAPPER_CLASSES = /^div\.(content|checkbox-container|inner|layout|col|row|cell|wrapper|container|grid|main)$/;
        if (PLAIN_WRAPPER_CLASSES.test(css) && !c.functional.id && !c.functional.dataTestId && !c.semantic.text) return false;
        return true;
      });
      console.log(`[FingerprintRecovery] Re-scraped after loading state: ${candidates.length} candidates.`);
    }

    return candidates;
  }

  private async safeFindCandidates(page: Page, targetTagName?: string): Promise<Candidate[]> {
    try {
      return await this.candidateFinder.findCandidates(page, targetTagName);
    } catch (err: any) {
      console.warn(`[FingerprintRecovery] CandidateFinder threw: ${err.message || err}`);
      return [];
    }
  }

  private pruneCandidatesByRelevance(original: OriginalElement, candidates: Candidate[]): Candidate[] {
    const config = loadConfig();
    const maxCandidates = config.AI_MAX_CANDIDATES || 10;
    if (candidates.length <= maxCandidates) return candidates;

    const origText = (original.ObjectName || original.LocText || original.OwnInnerText || '').toLowerCase().trim();
    const origLabel = (original.labelText || original.accessibleName || '').toLowerCase().trim();
    const origTag = (original.LocTagName || original.OrigTagName || '').toLowerCase().trim();

    const scored = candidates.map(c => {
      let relevance = 0;
      const cText = (c.semantic.text || '').toLowerCase();
      const cLabel = (c.semantic.accessibleName || c.semantic.ariaLabel || '').toLowerCase();
      const cTag = (c.functional.tagName || '').toLowerCase();

      if (origText && cText.includes(origText)) relevance += 5;
      if (origLabel && cLabel.includes(origLabel)) relevance += 4;
      if (origTag && cTag === origTag) relevance += 3;
      if (c.functional.role) relevance += 1;
      if (c.functional.dataTestId) relevance += 2;

      return { candidate: c, relevance };
    });

    scored.sort((a, b) => b.relevance - a.relevance);
    const pruned = scored.slice(0, maxCandidates).map(s => s.candidate);
    console.log(`[FingerprintRecovery] Pruned from ${candidates.length} to ${pruned.length} candidates.`);
    return pruned;
  }

  private async performVisualVerification(page: Page, original: OriginalElement, candidates: Candidate[]): Promise<void> {
    // ── Tag filter candidates first so visual comparison is only performed on tag-matched elements ──
    const tagFilteredCandidates = this.relocateEngine.filterByTagName(original, candidates);

    // ── Fast dimension pre-filter (zero cost: uses existing bounding box data) ──
    // Skip expensive visual comparison for candidates whose area is ≥5x the original.
    const origRect = original.ElementViewportRect;
    let candidatesForVerification = tagFilteredCandidates;

    if (origRect && Array.isArray(origRect) && origRect.length === 4) {
      const origW = Math.abs(origRect[2] - origRect[0]);
      const origH = Math.abs(origRect[3] - origRect[1]);
      const origArea = origW * origH;

      if (origArea > 0) {
        candidatesForVerification = tagFilteredCandidates.filter(c => {
          const candArea = c.visual.boundingWidth * c.visual.boundingHeight;
          const areaRatio = candArea / origArea;
          if (areaRatio >= 5) {
            c.visual = c.visual || {};
            c.visual.similarity = areaRatio >= 10 ? -1.0 : -0.5;
            return false;
          }
          return true;
        });
        const skipped = tagFilteredCandidates.length - candidatesForVerification.length;
        if (skipped > 0) {
          console.log(`[FingerprintRecovery] Dimension pre-filter: Skipped ${skipped} oversized candidates (≥5x area). ${candidatesForVerification.length} remain for visual verification.`);
        }
      }
    }

    try {
      if (candidatesForVerification.length > 0) {
        await performVisualComparison(page, original, candidatesForVerification);
      }
    } catch (err: any) {
      logger.debug(`[FingerprintRecovery] Visual verification skipped: ${err.message || err}`);
    }
  }

  private async resolveAndValidateHealedLocator(
    page: Page,
    original: OriginalElement,
    healResult: any
  ): Promise<{ locator: Locator; validationPassed: boolean }> {
    const locator = resolvePlaywrightLocator(page, healResult.healedLocator).first();
    let validationPassed = false;

    try {
      const isInput = original.Action === 'Enter' || (original.interactionType as string) === 'fill';
      validationPassed = await this.elementValidator.validate(locator, isInput);
    } catch (err: any) {
      logger.debug(`[FingerprintRecovery] Element validation threw: ${err.message || err}`);
    }

    return { locator, validationPassed };
  }

  private getTopCandidatesForReport(original: OriginalElement, candidates: Candidate[]): any[] {
    const scored = this.relocateEngine.scoringEngine.scoreCandidates(original, candidates);
    return scored.slice(0, 5).map(s => ({
      candidateId: s.candidate.candidateId,
      score: s.score,
      text: s.candidate.semantic?.text || '',
      cssSelector: s.candidate.functional?.cssSelector || '',
      ruleScores: s.ruleScores
    }));
  }
}
