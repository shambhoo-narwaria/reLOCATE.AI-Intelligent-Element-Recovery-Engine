import { ScoringRule } from '../scoring-rule.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';

/**
 * Scores based on DOM depth and sibling index proximity.
 * Weight: 5 – structural position is a weak but useful tiebreaker.
 */
export class DomStructureRule implements ScoringRule {
  readonly name = 'DomStructureRule';
  readonly weight = 5;

  calculate(original: OriginalElement, candidate: Candidate): number {
    const origDepth = original.domDepth ?? -1;
    const origIndex = original.indexInParent ?? -1;

    const candDepth = candidate.structure.domDepth;
    const candIndex = candidate.structure.indexInParent;

    let score = 0;

    if (origDepth >= 0) {
      const depthDiff = Math.abs(origDepth - candDepth);
      score += depthDiff === 0 ? 0.6 : depthDiff <= 2 ? 0.3 : 0;
    }

    if (origIndex >= 0) {
      const indexDiff = Math.abs(origIndex - candIndex);
      score += indexDiff === 0 ? 0.4 : indexDiff <= 1 ? 0.2 : 0;
    }

    return score * this.weight;
  }
}
