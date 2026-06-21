export interface StepOutcome {
  stepIndex: number;
  action: string;
  objectName: string;
  status: 'Passed' | 'Failed' | 'Skipped';
  healed: boolean;
  oldLocator?: string;
  newLocator?: string;
  confidence?: number;
  reason?: string;
  triggeredAI?: boolean;
  candidateId?: number;
  topCandidates?: Array<{
    candidateId: number;
    tagName: string;
    cssSelector: string;
    text: string;
    score: number;
    ruleScores: Record<string, number>;
  }>;
  screenshotPath?: string; // relative path within execution-report folder
  originalScreenshotPath?: string; // relative path within execution-report folder
  originalFullScreenshotPath?: string; // relative path within execution-report folder
  errorMessage?: string;
}
