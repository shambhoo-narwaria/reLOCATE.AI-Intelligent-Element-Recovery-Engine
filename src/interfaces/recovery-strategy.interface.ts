import { Page, Locator } from 'playwright';
import { OriginalElement } from './original-element.interface';

/**
 * Unified result shape returned by all recovery strategies.
 * The orchestrator (RelocateElement) works exclusively with this type,
 * so it never needs to know about strategy-specific result formats.
 */
export interface RecoveryResult {
  success: boolean;
  locator?: Locator;
  healedSelector: string;
  confidence: number;
  reason: string;
  candidateId?: number;
  triggeredAI: boolean;
  topCandidates?: any[];
}

/**
 * Common contract for all element recovery strategies.
 *
 * Follows the same Strategy Pattern already used by ScoringRule, ValidationGate,
 * and AIProvider. To add a new recovery strategy, implement this interface in a
 * new file and register it in src/index.ts -- no orchestrator changes required.
 */
export interface IRecoveryStrategy {
  /** Human-readable strategy identifier (e.g. "Stage1-Fingerprint", "Stage2-MCP"). */
  readonly name: string;

  /** Execution priority. Lower numbers are tried first (10, 20, 30...). */
  readonly priority: number;

  /**
   * Returns true if this strategy is currently enabled and available.
   * Each strategy manages its own configuration flags internally.
   */
  isEnabled(): boolean;

  /**
   * Execute the recovery strategy for the given element on the given page.
   * Must return a unified RecoveryResult regardless of internal implementation.
   */
  execute(
    page: Page,
    originalElement: OriginalElement,
    failureReason: string
  ): Promise<RecoveryResult>;
}
