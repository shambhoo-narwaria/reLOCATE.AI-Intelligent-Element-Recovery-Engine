import { ScoringRule } from './scoring-rule.interface';
import { OriginalElement } from '../interfaces/original-element.interface';
import { Candidate } from '../interfaces/candidate.interface';

export class ScoringEngine {
  constructor(public rules: ScoringRule[]) {}

  scoreCandidates(original: OriginalElement, candidates: Candidate[]): Array<{ candidate: Candidate; score: number }> {
    const results = candidates.map(candidate => {
      let totalScore = 0;
      this.rules.forEach(rule => {
        totalScore += rule.calculate(original, candidate);
      });
      // Round to 1 decimal place
      const roundedScore = Math.round(totalScore * 10) / 10;
      return { candidate, score: roundedScore };
    });

    // Sort by score descending
    return results.sort((a, b) => b.score - a.score);
  }
}
