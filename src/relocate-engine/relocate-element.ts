import { Locator, Page } from 'playwright';
import { OriginalElement } from '../interfaces/original-element.interface';
import { RelocateEngine } from './relocate.engine';
import { CandidateFinder } from './candidate-finder';
import { ElementValidator } from '../validation/element.validator';
import { StatusOverlay } from '../utils/status-overlay';
import { logger } from '../utils/debug-logger';
import { IRelocateElement } from '../interfaces/relocate-element.interface';
import { McpRecoveryAgent } from '../mcp/mcp-recovery-agent';
import { IRecoveryStrategy } from '../interfaces/recovery-strategy.interface';
import { FingerprintRecoveryStrategy } from '../strategies/fingerprint-recovery.strategy';
import { McpRecoveryStrategy } from '../strategies/mcp-recovery.strategy';

export function resolvePlaywrightLocator(page: Page, selectorStr: string): Locator {
  if (!selectorStr) return page.locator('body');
  
  const trimmed = selectorStr.trim();
  
  const cleanExpr = trimmed
    .replace(/^(?:await\s+)?page\./, '')
    .trim();

  if (/^(?:getBy[A-Za-z]+|locator)\s*\(/.test(cleanExpr)) {
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

  return page.locator(trimmed);
}

export class RelocateElement implements IRelocateElement {
  private strategies: IRecoveryStrategy[];
  private statusOverlay?: StatusOverlay;

  constructor(
    strategies: IRecoveryStrategy[],
    statusOverlay?: StatusOverlay
  );
  constructor(
    relocateEngine: RelocateEngine,
    candidateFinder: CandidateFinder,
    elementValidator: ElementValidator,
    statusOverlay: StatusOverlay,
    mcpRecoveryAgent?: McpRecoveryAgent
  );
  constructor(
    arg1: IRecoveryStrategy[] | RelocateEngine,
    arg2?: StatusOverlay | CandidateFinder,
    arg3?: ElementValidator,
    arg4?: StatusOverlay,
    arg5?: McpRecoveryAgent
  ) {
    if (Array.isArray(arg1)) {
      this.strategies = arg1;
      this.statusOverlay = arg2 as StatusOverlay | undefined;
    } else {
      const relocateEngine = arg1 as RelocateEngine;
      const candidateFinder = arg2 as CandidateFinder;
      const elementValidator = arg3 as ElementValidator;
      const statusOverlay = arg4 as StatusOverlay;
      const mcpRecoveryAgent = arg5 as McpRecoveryAgent | undefined;

      this.statusOverlay = statusOverlay;
      this.strategies = [
        new FingerprintRecoveryStrategy(relocateEngine, candidateFinder, elementValidator, statusOverlay)
      ];
      if (mcpRecoveryAgent) {
        this.strategies.push(new McpRecoveryStrategy(mcpRecoveryAgent));
      }
    }
  }

  /**
   * Relocates a target UI element by iterating through registered recovery strategies in priority order.
   */
  async relocate(
    page: Page,
    originalElement: OriginalElement
  ): Promise<{
    locator: Locator;
    oldLocator: string;
    newLocator: string;
    didHeal: boolean;
    triggeredAI: boolean;
    confidence: number;
    reason: string;
    candidateId?: number;
    topCandidates?: any[];
  }> {
    const originalLocator = originalElement.LocCssSelector || originalElement.LocXpath || '';
    logger.warn(`[RelocateElement] Original locator failed for "${originalElement.ObjectName}". Initializing recovery strategy chain...`);

    let lastError: any = null;
    let accumulatedCandidates: any[] = [];

    // Sort strategies by priority ascending (10, 20, 30...)
    const sortedStrategies = [...this.strategies].sort((a, b) => a.priority - b.priority);

    for (const strategy of sortedStrategies) {
      if (!strategy.isEnabled()) {
        logger.debug(`[RelocateElement] Strategy "${strategy.name}" is disabled. Skipping...`);
        continue;
      }

      logger.warn(`[RelocateElement] Executing strategy "${strategy.name}" (priority ${strategy.priority})...`);
      try {
        const result = await strategy.execute(page, originalElement, lastError?.message || '');
        if (result && result.success && result.locator) {
          if (this.statusOverlay) {
            await this.statusOverlay.show(page, 'COMPLETE').catch(() => {});
            await page.waitForTimeout(1000).catch(() => {});
          }
          return {
            locator: result.locator,
            oldLocator: originalLocator,
            newLocator: result.healedSelector,
            didHeal: true,
            triggeredAI: result.triggeredAI,
            confidence: result.confidence,
            reason: result.reason,
            candidateId: result.candidateId,
            topCandidates: result.topCandidates || accumulatedCandidates
          };
        }
        if (result?.topCandidates?.length) {
          accumulatedCandidates = result.topCandidates;
        }
      } catch (err: any) {
        lastError = err;
        logger.warn(`[RelocateElement] Strategy "${strategy.name}" failed: ${err.message || err}`);
      }
    }

    if (this.statusOverlay) {
      await this.statusOverlay.show(page, 'FAILED').catch(() => {});
      await page.waitForTimeout(2000).catch(() => {});
      await this.statusOverlay.hide(page).catch(() => {});
    }

    throw lastError || new Error(`All recovery strategies failed for "${originalElement.ObjectName}"`);
  }
}
