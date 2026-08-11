import { Candidate } from './candidate.interface';
import { OriginalElement } from './original-element.interface';
import { Tier3CompactMcpInputPayload } from './mcp-recovery.interface';

export interface AIProvider {
  askAI(original: OriginalElement, candidates: Candidate[]): Promise<{
    candidateId: number;
    confidence: number;
    reason: string;
  }>;
  askMcpAI?(payload: Tier3CompactMcpInputPayload): Promise<{
    healedSelector: string;
    confidence: number;
    reason: string;
  }>;
}
