import { ScoringRule } from '../interfaces/scoring-rule.interface';
import { OriginalElement } from '../interfaces/original-element.interface';
import { Candidate } from '../interfaces/candidate.interface';

export class ScoringEngine {
  constructor(public rules: ScoringRule[]) {}

  scoreCandidates(original: OriginalElement, candidates: Candidate[]): Array<{ candidate: Candidate; score: number; ruleScores: Record<string, number> }> {
    const maxWeight = this.getMaxScore();

    const results = candidates.map(candidate => {
      let rawScoreSum = 0;
      const ruleScores: Record<string, number> = {};
      this.rules.forEach(rule => {
        const rScore = rule.calculate(original, candidate);
        ruleScores[rule.name] = Math.round(rScore * 10) / 10;
        rawScoreSum += rScore;
      });
      // Normalize to 100-scale
      const normalizedScore = maxWeight > 0 ? (rawScoreSum / maxWeight) * 100 : 0;
      const roundedScore = Math.round(normalizedScore * 10) / 10;
      return { candidate, score: roundedScore, ruleScores };
    });

    // Sort by score descending
    return results.sort((a, b) => b.score - a.score);
  }
  getMaxScore(): number {
    return this.rules.reduce((sum, r) => sum + r.weight, 0);
  }
}
