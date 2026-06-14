import { Candidate } from './candidate.interface';
import { OriginalElement } from './original-element.interface';

export interface AIProvider {
  askAI(original: OriginalElement, candidates: Candidate[]): Promise<{
    candidateId: number;
    confidence: number;
    reason: string;
  }>;
}
