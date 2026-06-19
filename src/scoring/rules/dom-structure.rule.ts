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
    const origDepth = this.inferDepth(original);
    const origIndex = this.inferIndex(original);

    const candDepth = candidate.structure.domDepth;
    const candIndex = typeof candidate.structure.positionAmongSameRole === 'number'
      ? candidate.structure.positionAmongSameRole
      : candidate.structure.indexInParent;

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

  private inferDepth(original: OriginalElement): number {
    if (typeof original.domDepth === 'number' && original.domDepth >= 0) {
      return original.domDepth;
    }

    let depth = 0;
    const paths = [
      ...(original.ShadowDomFullXpathArray || []),
      original.FullLocXpath || original.fullXpath || original.LocXpath || original.locXpath
    ];

    paths.forEach(p => {
      if (p && typeof p === 'string') {
        depth += p.split('/').filter(Boolean).length;
      }
    });

    return depth > 0 ? depth : -1;
   }

  private inferIndex(original: OriginalElement): number {
    if (typeof original.indexInParent === 'number' && original.indexInParent >= 0) {
      return original.indexInParent;
    }

    const xpath = original.FullLocXpath || original.fullXpath || original.LocXpath || original.locXpath;
    if (xpath && typeof xpath === 'string') {
      const segments = xpath.split('/').filter(Boolean);
      if (segments.length > 0) {
        const last = segments[segments.length - 1];
        const match = last.match(/\[(\d+)\]/);
        if (match) {
          return parseInt(match[1], 10) - 1; // Convert 1-based XPath index to 0-based
        }
      }
    }
    return 0; // Default to 0 if no index is specified
  }
}
