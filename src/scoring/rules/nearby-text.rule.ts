import { ScoringRule } from '../scoring-rule.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';
import { stringSimilarity } from './similarity.helper';

/**
 * Scores based on nearby / sibling text proximity.
 * Weight: 5 – nearby context is a weak tiebreaker; page-level nav text
 * pollutes this signal in complex DOMs, so weight is kept low.
 */
export class NearbyTextRule implements ScoringRule {
  readonly name = 'NearbyTextRule';
  readonly weight = 5;

  calculate(original: OriginalElement, candidate: Candidate): number {
    const origNearby = ((original.NearByText || []) as string[]).slice(0, 4);
    if (origNearby.length === 0) return 0;

    const candNearby = [
      ...candidate.neighborhood.nearbyText,
      ...candidate.neighborhood.siblings,
      candidate.neighborhood.previousText,
      candidate.neighborhood.nextText,
      candidate.ancestorContext.parentText,
    ].filter(Boolean).map(s => s.toLowerCase().trim());

    const origTexts = origNearby.map(s => s.toLowerCase().trim());

    let totalScore = 0;
    for (const ot of origTexts) {
      const best = Math.max(0, ...candNearby.map(ct => stringSimilarity(ot, ct)));
      totalScore += best;
    }

    return (totalScore / origTexts.length) * this.weight;
  }
}
