import { Page } from 'playwright';
import { OriginalElement } from '../interfaces/original-element.interface';
import { IRecoveryStrategy, RecoveryResult } from '../interfaces/recovery-strategy.interface';
import { McpRecoveryAgent } from '../mcp/mcp-recovery-agent';
import { resolvePlaywrightLocator } from './fingerprint-recovery.strategy';
import { logger } from '../utils/debug-logger';
import * as fs from 'fs';
import * as path from 'path';

function isMcpFallbackEnabled(): boolean {
  try {
    const configPath = path.resolve(process.cwd(), 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config.ENABLE_MCP_FALLBACK !== false;
    }
  } catch {}
  return true;
}

/**
 * Stage 2: MCP Accessibility Recovery Strategy
 *
 * Captures Playwright's native locator('body').ariaSnapshot() YAML (<500 tokens)
 * and invokes the AI provider to resolve the element from the accessibility tree.
 * This strategy is self-gated via the ENABLE_MCP_FALLBACK config flag.
 */
export class McpRecoveryStrategy implements IRecoveryStrategy {
  readonly name = 'Stage2-MCP';
  readonly priority = 20;

  constructor(private mcpRecoveryAgent: McpRecoveryAgent) {}

  isEnabled(): boolean {
    return isMcpFallbackEnabled();
  }

  async execute(
    page: Page,
    originalElement: OriginalElement,
    failureReason: string
  ): Promise<RecoveryResult> {
    logger.warn(`[McpRecoveryStrategy] Escalating to Stage 2 MCP Recovery for "${originalElement.ObjectName}"...`);

    try {
      const mcpResult = await this.mcpRecoveryAgent.executeStage2McpRecovery(
        page,
        originalElement,
        failureReason
      );

      if (mcpResult && mcpResult.success) {
        return {
          success: true,
          locator: resolvePlaywrightLocator(page, mcpResult.healedSelector).first(),
          healedSelector: mcpResult.healedSelector,
          confidence: mcpResult.confidenceScore,
          reason: `Stage 2 MCP Recovery: ${mcpResult.reasoning}`,
          candidateId: mcpResult.healedCandidateId,
          triggeredAI: true
        };
      }

      return {
        success: false,
        healedSelector: mcpResult?.healedSelector || '',
        confidence: mcpResult?.confidenceScore || 0,
        reason: mcpResult?.reasoning || 'Stage 2 MCP recovery returned no match',
        triggeredAI: true
      };
    } catch (mcpErr: any) {
      console.error(`[McpRecoveryStrategy] Stage 2 MCP recovery failed:`, mcpErr.message || mcpErr);
      return {
        success: false,
        healedSelector: '',
        confidence: 0,
        reason: `Stage 2 MCP recovery threw: ${mcpErr.message || mcpErr}`,
        triggeredAI: false
      };
    }
  }
}
