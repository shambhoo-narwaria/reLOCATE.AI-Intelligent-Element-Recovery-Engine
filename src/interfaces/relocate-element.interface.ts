import { Locator, Page } from 'playwright';
import { OriginalElement } from './original-element.interface';

export interface IRelocateElement {
  relocate(
    page: Page,
    originalElement: OriginalElement
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
