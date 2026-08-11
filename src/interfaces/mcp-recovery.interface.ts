export interface Tier3CompactMcpInputPayload {
  targetMetadata: {
    objectName: string;
    action: string;
    valueToEnter?: string;
    originalSelector?: string;
    labelText?: string;
  };
  failureContext: {
    reason: string;
  };
  accessibilityTree: string | object;
  screenshotBase64?: string;
}

export interface Tier3McpOutputResult {
  success: boolean;
  healedSelector: string;
  healedCandidateId?: number;
  confidenceScore: number;
  visualVerificationPassed: boolean;
  reasoning: string;
  actionExecuted: boolean;
}
