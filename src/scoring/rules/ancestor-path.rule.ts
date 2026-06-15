import { ScoringRule } from '../scoring-rule.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';

/**
 * Scores based on shadow host chain and ancestor path alignment.
 * Weight: 15 – shadow host chain is the strongest disambiguator for
 * elements inside web components (e.g. multiple instances of
 * ZUI-TRUNCATE-WITH-TOOLTIP each containing div#trunky-wrapper).
 *
 * Scoring breakdown:
 *   0.5 – shadow host chain overlap with original's ShadowDomHostArray
 *   0.3 – ancestor tag name overlap with original's XPath segments
 *   0.2 – table column header match (when element is inside a table)
 */
export class AncestorPathRule implements ScoringRule {
  readonly name = 'AncestorPathRule';
  readonly weight = 15;

  calculate(original: OriginalElement, candidate: Candidate): number {
    let score = 0;

    // ── 1. Shadow Host Chain LCS Match (0.5) ────────────────────────────
    // Compare the sequence of original shadow host tags and candidate shadow host chain
    const origHostTags = this.extractHostTags(original);
    const candHostChain = candidate.ancestorContext.shadowHostChain || [];

    if (origHostTags.length > 0 && candHostChain.length > 0) {
      const similarity = this.calculateLcsSimilarity(origHostTags, candHostChain);
      score += similarity * 0.5;
    } else if (origHostTags.length === 0 && candHostChain.length === 0) {
      // Both not in shadow DOM — neutral (no penalty, no bonus)
      score += 0.25;
    }

    // ── 2. Full Tag Path LCS Sequence Match (0.3) ────────────────────────
    // Reconstruct full ordered tag paths for both original and candidate
    const origTagPath = this.getOriginalTagPath(original);
    const candTagPath = this.getCandidateTagPath(candidate);

    if (origTagPath.length > 0 && candTagPath.length > 0) {
      const similarity = this.calculateLcsSimilarity(origTagPath, candTagPath);
      score += similarity * 0.3;
    }

    // ── 3. Table column header match (0.2) ────────────────────────────
    if (candidate.tableContext && candidate.tableContext.columnHeader) {
      // Check if the original's ObjectName or nearby text mentions the column header
      const origName = (original.LocText || original.LocTitle || original.OwnInnerText || '').toLowerCase().trim();
      const colHeader = candidate.tableContext.columnHeader.toLowerCase().trim();
      const origNearby = (original.NearByText || []).map(s => s.toLowerCase().trim());

      if (origNearby.some(t => t.includes(colHeader) || colHeader.includes(t))) {
        score += 0.2;
      } else if (origName && colHeader) {
        // Partial credit if column header appears in context
        score += 0;
      }
    }

    return score * this.weight;
  }

  /**
   * Extract tag names from the original element's ShadowDomHostArray selectors.
   * Filters out combinators, class/ID qualifiers, and pseudos to yield tag names.
   */
  private extractHostTags(original: OriginalElement): string[] {
    const tags = new Set<string>();
    (original.ShadowDomHostArray || []).forEach((sel: string) => {
      const parts = sel.split(/[\s>+~]+/);
      parts.forEach(part => {
        const match = part.match(/^([a-zA-Z0-9-]+)/);
        if (match) {
          const tag = match[1].toUpperCase();
          if (tag && tag !== 'HTML' && tag !== 'BODY') {
            tags.add(tag);
          }
        }
      });
    });
    return [...tags];
  }

  /**
   * Reconstruct the complete tag path for the original element in order.
   * Merges shadow host XPath tags and the final target XPath.
   */
  private getOriginalTagPath(original: OriginalElement): string[] {
    const pathTags: string[] = [];

    // Extract tags from ShadowDomFullXpathArray
    (original.ShadowDomFullXpathArray || []).forEach((xpath: string) => {
      xpath.split('/').filter(Boolean).forEach((seg: string) => {
        const tag = seg.replace(/\[\d+\]/g, '').toUpperCase().trim();
        if (tag && tag !== 'HTML' && tag !== 'BODY') {
          pathTags.push(tag);
        }
      });
    });

    // Extract tags from FullLocXpath
    if (original.FullLocXpath) {
      (original.FullLocXpath as string).split('/').filter(Boolean).forEach((seg: string) => {
        const tag = seg.replace(/\[\d+\]/g, '').toUpperCase().trim();
        if (tag && tag !== 'HTML' && tag !== 'BODY') {
          pathTags.push(tag);
        }
      });
    }

    // Deduplicate consecutive identical tag names (normalize shadow DOM boundaries)
    const cleanTags: string[] = [];
    pathTags.forEach(tag => {
      if (cleanTags.length === 0 || cleanTags[cleanTags.length - 1] !== tag) {
        cleanTags.push(tag);
      }
    });

    return cleanTags;
  }

  /**
   * Reconstruct the complete tag path for a candidate element in order.
   * Reverses ancestorTagNames and appends the candidate's tag name.
   */
  private getCandidateTagPath(candidate: Candidate): string[] {
    const pathTags: string[] = [];

    // ancestorTagNames is collected innermost first, so reverse it
    const reversedAncestors = [...(candidate.ancestorContext.ancestorTagNames || [])].reverse();
    reversedAncestors.forEach(tag => {
      const cleanTag = tag.toUpperCase().trim();
      if (cleanTag && cleanTag !== 'HTML' && cleanTag !== 'BODY') {
        pathTags.push(cleanTag);
      }
    });

    // Append target element's tag name
    if (candidate.functional.tagName) {
      pathTags.push(candidate.functional.tagName.toUpperCase().trim());
    }

    // Deduplicate consecutive identical tag names
    const cleanTags: string[] = [];
    pathTags.forEach(tag => {
      if (cleanTags.length === 0 || cleanTags[cleanTags.length - 1] !== tag) {
        cleanTags.push(tag);
      }
    });

    return cleanTags;
  }

  /**
   * Calculate Longest Common Subsequence (LCS) similarity between two tag arrays.
   * Returns a normalized score between 0.0 and 1.0 based on seq1 length.
   */
  private calculateLcsSimilarity(seq1: string[], seq2: string[]): number {
    if (seq1.length === 0 || seq2.length === 0) return 0;

    const m = seq1.length;
    const n = seq2.length;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));

    for (let i = 1; i <= m; i++) {
      const val1 = seq1[i - 1];
      for (let j = 1; j <= n; j++) {
        if (val1 === seq2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    const lcsLength = dp[m][n];
    return lcsLength / m;
  }
}
