import { ScoringRule } from '../scoring-rule.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';

/**
 * Scores candidates based on how closely their class names match the original element's class name.
 * Excludes Angular-specific context attributes (e.g. _ngcontent-*, _nghost-*) for stability.
 * Weight: 15 — class names are a strong widget/styling identifier.
 */
export class ClassNameRule implements ScoringRule {
  readonly name = 'ClassNameRule';
  readonly weight = 10;

  calculate(original: OriginalElement, candidate: Candidate): number {
    const rawOrigClass = (original.LocClassName || original.className || '');
    const rawCandClass = (candidate.functional.className || '');

    if (!rawOrigClass && !rawCandClass) {
      // Both elements have no classes — neutral
      return 0.5 * this.weight;
    }
    if (!rawOrigClass || !rawCandClass) {
      // One has classes, the other doesn't
      return 0;
    }

    const cleanClassToken = (cls: string) => {
      const trimmed = cls.trim();
      if (!trimmed) return null;
      if (trimmed.startsWith('_ngcontent') || trimmed.startsWith('_nghost')) return null;
      return trimmed.toLowerCase();
    };

    const origTokens = rawOrigClass.split(/\s+/).map(cleanClassToken).filter(Boolean) as string[];
    const candTokens = rawCandClass.split(/\s+/).map(cleanClassToken).filter(Boolean) as string[];

    if (origTokens.length === 0 && candTokens.length === 0) {
      return 0.5 * this.weight;
    }
    if (origTokens.length === 0 || candTokens.length === 0) {
      return 0;
    }

    const origSet = new Set(origTokens);
    const candSet = new Set(candTokens);

    const intersection = new Set([...origSet].filter(x => candSet.has(x)));
    const union = new Set([...origSet, ...candSet]);

    const jaccard = intersection.size / union.size;

    return jaccard * this.weight;
  }
}
