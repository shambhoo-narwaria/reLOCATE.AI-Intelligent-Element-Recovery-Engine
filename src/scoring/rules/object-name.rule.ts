import { ScoringRule } from '../scoring-rule.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';
import { stringSimilarity } from './similarity.helper';

/**
 * Scores based on how closely the candidate's accessible name / text matches the
 * original element's ObjectName, LocName, or accessibleName.
 * Weight: 30 – highest weight because the visible label is the primary human signal.
 */
export class ObjectNameRule implements ScoringRule {
  readonly name = 'ObjectNameRule';
  readonly weight = 30;

  calculate(original: OriginalElement, candidate: Candidate): number {
    const origTag = (original.OrigTagName || original.LocTagName || original.tagName || '').toUpperCase().trim();
    const isInput = ['INPUT', 'TEXTAREA'].includes(origTag);

    let origName = '';
    let ruleWeight = this.weight; // Default is 30

    if (isInput) {
      origName = original.ObjectName || '';
    } else {
      origName = original.LocText || original.LocTitle || original.OwnInnerText || '';
      if (!origName && original.ObjectName) {
        origName = original.ObjectName;
        ruleWeight = 5; // Throttle to 5 if non-input falls back to metadata ObjectName
      }
    }

    origName = origName.toLowerCase().trim();
    if (!origName) return 0;

    const candName   = candidate.semantic.accessibleName.toLowerCase().trim();
    const candLabel  = candidate.neighborhood.closestLabel.toLowerCase().trim();
    const candText   = candidate.semantic.text.toLowerCase().trim();
    const candNorm   = candidate.functional.normalizedText.toLowerCase().trim();

    const scores = [candName, candLabel, candText, candNorm].filter(Boolean).map(s => stringSimilarity(origName, s));

    return Math.max(0, ...scores) * ruleWeight;
  }
}
