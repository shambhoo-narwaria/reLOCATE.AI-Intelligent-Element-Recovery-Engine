import { ScoringRule } from './scoring-rule.interface';
import { OriginalElement } from '../interfaces/original-element.interface';
import { Candidate } from '../interfaces/candidate.interface';

export class ScoringEngine {
  constructor(public rules: ScoringRule[]) {}

  scoreCandidates(original: OriginalElement, candidates: Candidate[]): Array<{ candidate: Candidate; score: number; ruleScores: Record<string, number> }> {
    const results = candidates.map(candidate => {
      let totalScore = 0;
      const ruleScores: Record<string, number> = {};
      this.rules.forEach(rule => {
        const rScore = rule.calculate(original, candidate);
        ruleScores[rule.name] = Math.round(rScore * 10) / 10;
        totalScore += rScore;
      });
      // Round to 1 decimal place
      const roundedScore = Math.round(totalScore * 10) / 10;
      return { candidate, score: roundedScore, ruleScores };
    });

    // Sort by score descending
    return results.sort((a, b) => b.score - a.score);
  }
}
