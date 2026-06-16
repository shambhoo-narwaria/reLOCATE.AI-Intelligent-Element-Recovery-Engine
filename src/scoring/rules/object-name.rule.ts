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

    // For input elements, use original.ObjectName.
    // For non-input elements, use only LocText || LocTitle || OwnInnerText.
    const origName   = (isInput ? (original.ObjectName || '') : (original.LocText || original.LocTitle || original.OwnInnerText || '')).toLowerCase().trim();
    const candName   = candidate.semantic.accessibleName.toLowerCase().trim();
    const candLabel  = candidate.neighborhood.closestLabel.toLowerCase().trim();
    const candText   = candidate.semantic.text.toLowerCase().trim();
    const candNorm   = candidate.functional.normalizedText.toLowerCase().trim();

    if (!origName) return 0;

    const scores = [candName, candLabel, candText, candNorm].filter(Boolean).map(s => stringSimilarity(origName, s));

    return Math.max(0, ...scores) * this.weight;
  }
}
