import { Locator, Page } from 'playwright';
import { OriginalElement } from './original-element.interface';

export interface IRecoveryPipeline {
  recoverElement(
    page: Page,
    step: OriginalElement,
    stepIndex: number,
    originalLocator: string
  ): Promise<{
    locator: Locator;
    oldLocator: string;
    newLocator: string;
    didHeal: boolean;
    triggeredAI: boolean;
    confidence: number;
    reason?: string;
    candidateId?: number;
    topCandidates?: any[];
  }>;
}
