import { ScoringRule } from '../scoring-rule.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';
import { stringSimilarity } from './similarity.helper';

/**
 * Scores candidates based on how closely their full CSS selector path matches the original element's CSS selector.
 * This is the ultimate tiebreaker for duplicate elements in identical structural branches.
 * Weight: 10
 */
export class CssSelectorRule implements ScoringRule {
  readonly name = 'CssSelectorRule';
  readonly weight = 10;

  calculate(original: OriginalElement, candidate: Candidate): number {
    const origCss = (original.LocCssSelector || original.LocXpath || '').trim();
    const candCss = (candidate.functional.cssSelector || '').trim();

    if (!origCss || !candCss) {
      // No CSS paths to compare — neutral
      return 0.5 * this.weight;
    }

    // Compute Levenshtein string similarity score
    const similarity = stringSimilarity(origCss, candCss);
    return similarity * this.weight;
  }
}
