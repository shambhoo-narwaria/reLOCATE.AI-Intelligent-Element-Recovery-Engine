import { ScoringRule } from '../scoring-rule.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';

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
      return 0.5 * this.weight;
    }

    // Split selectors into segments by combinators
    const splitSegments = (css: string) => {
      return css
        .split(/[\s>+~]+/)
        .map(s => {
          // Clean pseudoclasses like :nth-child, :nth-of-type, etc.
          return s.replace(/:[a-zA-Z0-9-]+(\([^)]*\))?/g, '').toLowerCase().trim();
        })
        .filter(Boolean);
    };

    const origSegs = splitSegments(origCss);
    const candSegs = splitSegments(candCss);

    if (origSegs.length === 0 || candSegs.length === 0) {
      return 0;
    }

    // Compare segments right-to-left (innermost first)
    const seq1 = [...origSegs].reverse();
    const seq2 = [...candSegs].reverse();

    // Compute similarity between two individual segments (0.0 to 1.0)
    const getSegmentSimilarity = (seg1: string, seg2: string): number => {
      if (seg1 === seg2) return 1.0;

      // Extract tag, classes, and ID
      const parseSeg = (s: string) => {
        const tag = (s.match(/^([a-zA-Z0-9-]+)/) || [])[1] || '';
        const classes = s.split('.').slice(1).map(c => c.split('#')[0]);
        const id = (s.match(/#([a-zA-Z0-9_-]+)/) || [])[1] || '';
        return { tag, classes, id };
      };

      const p1 = parseSeg(seg1);
      const p2 = parseSeg(seg2);

      // If tags are defined and mismatched, similarity is 0
      if (p1.tag && p2.tag && p1.tag !== p2.tag) return 0;

      // If IDs are defined and mismatched, similarity is 0
      if (p1.id && p2.id && p1.id !== p2.id) return 0;

      let score = 0;
      let total = 0;

      // Tag name match
      if (p1.tag && p2.tag) {
        score += 1;
        total += 1;
      }

      // ID match
      if (p1.id || p2.id) {
        total += 1;
        if (p1.id === p2.id) score += 1;
      }

      // Class match
      if (p1.classes.length > 0 || p2.classes.length > 0) {
        total += 1;
        const intersection = p1.classes.filter(c => p2.classes.includes(c));
        const union = Array.from(new Set([...p1.classes, ...p2.classes]));
        if (union.length > 0) {
          score += intersection.length / union.length;
        }
      }

      return total === 0 ? 0 : score / total;
    };

    // Run custom LCS algorithm with segment similarity weights
    const m = seq1.length;
    const n = seq2.length;
    const dp = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));

    for (let i = 1; i <= m; i++) {
      const s1 = seq1[i - 1];
      for (let j = 1; j <= n; j++) {
        const s2 = seq2[j - 1];
        const sim = getSegmentSimilarity(s1, s2);
        if (sim > 0) {
          dp[i][j] = Math.max(
            dp[i - 1][j - 1] + sim,
            dp[i - 1][j],
            dp[i][j - 1]
          );
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    const lcsScore = dp[m][n];
    // Normalize by original CSS selector length to evaluate alignment coverage
    const similarity = lcsScore / m;
    const score = similarity * this.weight;
    console.log(`[CssSelectorRule Debug] object="${original.ObjectName || 'unknown'}" orig="${origCss}" cand="${candCss}" m=${m} n=${n} lcsScore=${lcsScore} score=${score} candId=${candidate.candidateId}`);

    return score;

  }
}

