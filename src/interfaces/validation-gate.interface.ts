import { OriginalElement } from './original-element.interface';
import { Candidate } from './candidate.interface';

export interface ValidationGate {
  readonly name: string;
  validate(original: OriginalElement, candidate: Candidate): boolean;
}
