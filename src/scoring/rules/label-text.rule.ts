import { ScoringRule } from '../scoring-rule.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';
import { stringSimilarity } from './similarity.helper';

/**
 * Scores based on associated label, aria-labelledby, or nearby text similarity.
 * Weight: 15 – labels are a strong semantic anchor but partially overlap with ObjectNameRule.
 */
export class LabelTextRule implements ScoringRule {
  readonly name = 'LabelTextRule';
  readonly weight = 15;

  calculate(original: OriginalElement, candidate: Candidate): number {
    const origName = (original.LocText || original.LocTitle || original.OwnInnerText || original.LocName || original.accessibleName || '').toLowerCase().trim();
    if (!origName) return 0;

    const sources = [
      candidate.neighborhood.closestLabel,
      candidate.neighborhood.associatedLabel,
      candidate.functional.ariaLabel,
      candidate.functional.ariaLabelledBy,
      ...candidate.neighborhood.nearbyText,
    ].filter(Boolean).map(s => s.toLowerCase().trim());

    const scores = sources.map(s => stringSimilarity(origName, s));
    return Math.max(0, ...scores) * this.weight;
  }
}
