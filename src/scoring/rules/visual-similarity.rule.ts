import { ScoringRule } from '../scoring-rule.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';

/**
 * Scores candidates based on their visual similarity index computed from screenshot comparison.
 * Weight: 20 – visual similarity is a high-confidence signal for element matching.
 */
export class VisualSimilarityRule implements ScoringRule {
  readonly name = 'VisualSimilarityRule';
  readonly weight = 20;

  calculate(original: OriginalElement, candidate: Candidate): number {
    // Return the visual similarity score (defaults to 0 if missing)
    return (candidate.visual.similarity ?? 0) * this.weight;
  }
}
