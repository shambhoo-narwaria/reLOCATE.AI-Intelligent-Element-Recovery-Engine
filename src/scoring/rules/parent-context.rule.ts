import { ScoringRule } from '../scoring-rule.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';

/**
 * Scores based on parent element tag and id context match.
 * Weight: 10 – parentage is a useful disambiguation signal.
 */
export class ParentContextRule implements ScoringRule {
  readonly name = 'ParentContextRule';
  readonly weight = 10;

  calculate(original: OriginalElement, candidate: Candidate): number {
    const origParentTag = this.inferParentTag(original).toLowerCase().trim();
    const origParentId  = this.inferParentId(original).toLowerCase().trim();

    const candParentTag = candidate.structure.parentTag.toLowerCase().trim();
    const candParentId  = candidate.structure.parentId.toLowerCase().trim();

    let score = 0;

    if (origParentTag && candParentTag && origParentTag === candParentTag) score += 0.5;
    if (origParentId  && candParentId  && origParentId  === candParentId)  score += 0.5;

    return score * this.weight;
  }

  private inferParentTag(original: OriginalElement): string {
    if (original.parentTag) {
      return original.parentTag;
    }

    const pathTags: string[] = [];

    // 1. Extract from ShadowDomFullXpathArray
    (original.ShadowDomFullXpathArray || []).forEach((xpath: string) => {
      xpath.split('/').filter(Boolean).forEach((seg: string) => {
        let tag = seg.replace(/\[\d+\]/g, '').toUpperCase().trim();
        if (tag.includes('NAME()=')) {
          const match = tag.match(/NAME\(\)=['"]([^'"]+)['"]/);
          if (match) tag = match[1].toUpperCase();
        }
        if (tag && tag !== 'HTML' && tag !== 'BODY') {
          pathTags.push(tag);
        }
      });
    });

    // 2. Extract from FullLocXpath (or fallbacks)
    const xpathSource = original.FullLocXpath || original.fullXpath || original.LocXpath || original.locXpath;
    if (xpathSource) {
      (xpathSource as string).split('/').filter(Boolean).forEach((seg: string) => {
        let tag = seg.replace(/\[\d+\]/g, '').toUpperCase().trim();
        if (tag.includes('NAME()=')) {
          const match = tag.match(/NAME\(\)=['"]([^'"]+)['"]/);
          if (match) tag = match[1].toUpperCase();
        }
        if (tag && tag !== 'HTML' && tag !== 'BODY') {
          pathTags.push(tag);
        }
      });
    }

    if (pathTags.length >= 2) {
      return pathTags[pathTags.length - 2];
    }

    return '';
  }

  private inferParentId(original: OriginalElement): string {
    if (original.parentId) {
      return original.parentId;
    }

    const paths = [
      original.FullLocXpath || original.fullXpath || original.LocXpath || original.locXpath,
      ...(original.ShadowDomFullXpathArray || [])
    ];

    for (const p of paths) {
      if (p && typeof p === 'string') {
        const segments = p.split('/').filter(Boolean);
        for (let i = 0; i < segments.length - 1; i++) {
          const seg = segments[i];
          if (seg.includes('@id=')) {
            const match = seg.match(/@id=['"]([^'"]+)['"]/);
            if (match) return match[1];
          }
        }
      }
    }

    if (original.LocCssSelector && typeof original.LocCssSelector === 'string') {
      const parts = original.LocCssSelector.split(/[\s>+~]+/);
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        const match = part.match(/#([a-zA-Z0-9_-]+)/);
        if (match) return match[1];
      }
    }

    return '';
  }
}
