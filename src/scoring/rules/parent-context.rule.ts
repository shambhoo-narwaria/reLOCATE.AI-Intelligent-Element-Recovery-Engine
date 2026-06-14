import { ScoringRule } from '../scoring-rule.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';

/**
 * Scores based on parent element tag and id context match.
 * Weight: 10 – parentage is a useful disambiguation signal.
 */
export class ParentContextRule implements ScoringRule {
  readonly name = 'ParentContextRule';
  readonly weight = 10;

  calculate(original: OriginalElement, candidate: Candidate): number {
    const origParentTag = (original.parentTag || '').toLowerCase().trim();
    const origParentId  = (original.parentId  || '').toLowerCase().trim();

    const candParentTag = candidate.structure.parentTag.toLowerCase().trim();
    const candParentId  = candidate.structure.parentId.toLowerCase().trim();

    let score = 0;

    if (origParentTag && candParentTag && origParentTag === candParentTag) score += 0.5;
    if (origParentId  && candParentId  && origParentId  === candParentId)  score += 0.5;

    return score * this.weight;
  }
}
