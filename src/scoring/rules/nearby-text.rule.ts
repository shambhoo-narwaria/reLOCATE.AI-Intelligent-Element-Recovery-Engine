import { ScoringRule } from '../../interfaces/scoring-rule.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';
import { stringSimilarity } from './similarity.helper';

/**
 * Scores based on nearby / sibling text proximity.
 * Weight: 10 – nearby context is a weak tiebreaker; page-level nav text
 * pollutes this signal in complex DOMs, so weight is kept low.
 */
export class NearbyTextRule implements ScoringRule {
  readonly name = 'NearbyTextRule';
  readonly weight = 10;

  calculate(original: OriginalElement, candidate: Candidate): number {
    const origNearby = ((original.NearByText || original.nearbyText || []) as string[]).slice(0, 3);
    if (origNearby.length === 0) return 0;

    const rawCandNearby = [
      candidate.neighborhood.closestLabel,
      candidate.neighborhood.previousText,
      candidate.neighborhood.nextText,
      ...candidate.neighborhood.siblings,
      ...candidate.neighborhood.nearbyText,
      candidate.ancestorContext.parentText,
    ].filter(Boolean).map(s => s.toLowerCase().trim());

    // Get unique 3 nearest texts
    const candNearby: string[] = [];
    for (const text of rawCandNearby) {
      if (text && !candNearby.includes(text)) {
        candNearby.push(text);
        if (candNearby.length === 3) break;
      }
    }

    const origTexts = origNearby.map(s => s.toLowerCase().trim());

    let totalScore = 0;
    for (const ot of origTexts) {
      const best = Math.max(0, ...candNearby.map(ct => stringSimilarity(ot, ct)));
      totalScore += best;
    }

    return (totalScore / origTexts.length) * this.weight;
  }
}
