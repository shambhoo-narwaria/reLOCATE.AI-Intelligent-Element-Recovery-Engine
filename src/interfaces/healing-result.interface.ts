export interface HealingResult {
  healedLocator: string;
  confidence: number;
  reason: string;
  triggeredAI: boolean;
  candidateId?: number;
}
