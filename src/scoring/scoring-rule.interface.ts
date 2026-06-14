import { OriginalElement } from '../interfaces/original-element.interface';
import { Candidate } from '../interfaces/candidate.interface';

export interface ScoringRule {
  readonly name: string;
  readonly weight: number;
  calculate(original: OriginalElement, candidate: Candidate): number;
}
