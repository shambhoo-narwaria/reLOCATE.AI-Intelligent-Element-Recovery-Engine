import { OriginalElement } from './original-element.interface';
import { Candidate } from './candidate.interface';

export interface ScoringRule {
  readonly name: string;
  readonly weight: number;
  calculate(original: OriginalElement, candidate: Candidate): number;
}
