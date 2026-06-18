import { ScoringRule } from '../scoring-rule.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';

/**
 * Scores candidates based on their horizontal coordinate proximity to the original element.
 * Helps break ties for identical candidates arranged in column/grid layouts (e.g. OD vs OS columns).
 * Uses a low weight as a minor tiebreaker, robust to vertical page scrolling.
 * Weight: 5
 */
export class HorizontalProximityRule implements ScoringRule {
  readonly name = 'HorizontalProximityRule';
  readonly weight = 5;

  calculate(original: OriginalElement, candidate: Candidate): number {
    const origRect = original.ElementViewportRect;
    const candLeft = candidate.visual.left;
    const candWidth = candidate.visual.boundingWidth;

    if (!origRect || !Array.isArray(origRect) || origRect.length !== 4 || candLeft === undefined) {
      // No coordinates available to compare — neutral score (0.5)
      return 0.5 * this.weight;
    }

    const origLeft = origRect[0];
    const origRight = origRect[2];
    const origCenterX = origLeft + (origRight - origLeft) / 2;

    const candCenterX = candLeft + candWidth / 2;

    const diffX = Math.abs(candCenterX - origCenterX);

    // Normalize score between 0 and 1:
    // If exact match (diffX = 0), similarity is 1.0.
    // If distance is large, similarity decays towards 0.0.
    const similarity = 1 / (1 + diffX / 100);

    return similarity * this.weight;
  }
}
