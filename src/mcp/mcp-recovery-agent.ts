import { Page } from 'playwright';
import { OriginalElement } from '../interfaces/original-element.interface';
import { Tier3CompactMcpInputPayload, Tier3McpOutputResult } from '../interfaces/mcp-recovery.interface';
import { AIProvider } from '../interfaces/ai-provider.interface';
import { logger } from '../utils/debug-logger';
import { waitForPageSettle } from '../utils/page-stabilizer';

export class McpRecoveryAgent {
  constructor(private aiProvider?: AIProvider) {}

  /**
   * Performs Tier 3 recovery using pure token-efficient MCP accessibility snapshots.
   * Uses locator.ariaSnapshot() which returns YAML natively in MCP format.
   */
  async recoverElement(
    page: Page,
    originalElement: OriginalElement,
    failureReason: string
  ): Promise<Tier3McpOutputResult> {
    const stepNum = originalElement.index !== undefined ? originalElement.index + 1 : 0;
    const stepName = stepNum > 0 ? `Step ${stepNum} (${originalElement.ObjectName || 'Target Element'})` : (originalElement.ObjectName || 'Target Element');
    logger.warn(`[McpRecoveryAgent] Initiating Pure MCP Fallback for "${stepName}"...`);

    // 1. Wait for page to fully settle (network idle, DOM mutations stopped)
    try {
      await waitForPageSettle(page, 15000);
      await page.waitForTimeout(5000);
    } catch {}

    // 2. Hide the injected StatusOverlay DOM element before capturing the snapshot
    //    so it doesn't pollute the accessibility tree with internal engine text.
    await page.evaluate(() => {
      const overlay = document.getElementById('__ai-healing-status-overlay__');
      if (overlay) overlay.setAttribute('aria-hidden', 'true');
    }).catch(() => {});

    // 3. Capture accessibility tree using locator.ariaSnapshot() — the replacement
    //    for the REMOVED page.accessibility.snapshot() API.
    let ariaSnapshotYaml = '';
    try {
      ariaSnapshotYaml = await page.locator('body').ariaSnapshot() || '';
      logger.debug(`[McpRecoveryAgent] ariaSnapshot captured (${ariaSnapshotYaml.length} chars).`);
    } catch (err: any) {
      logger.warn(`[McpRecoveryAgent] locator.ariaSnapshot() failed: ${err.message || err}`);
    }

    // 4. Restore the overlay visibility
    await page.evaluate(() => {
      const overlay = document.getElementById('__ai-healing-status-overlay__');
      if (overlay) overlay.removeAttribute('aria-hidden');
    }).catch(() => {});

    const hasInteractiveNodes = ariaSnapshotYaml.length > 0;
    let screenshotBase64: string | undefined;

    if (!hasInteractiveNodes) {
      logger.debug(`[McpRecoveryAgent] Accessibility tree empty/insufficient. Capturing selective JPEG screenshot...`);
      const screenshotBuf = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
      if (screenshotBuf) {
        screenshotBase64 = screenshotBuf.toString('base64');
      }
    }

    // 3. Construct lightweight input payload (<500 tokens total) in official MCP format
    const payload: Tier3CompactMcpInputPayload = {
      targetMetadata: {
        objectName: originalElement.ObjectName || 'Target Element',
        action: (originalElement.Action || 'click').toLowerCase(),
        valueToEnter: originalElement.inputText || originalElement.LocText,
        originalSelector: originalElement.LocCssSelector,
        labelText: originalElement.labelText
      },
      failureContext: {
        reason: failureReason
      },
      accessibilityTree: ariaSnapshotYaml || {},
      screenshotBase64
    };

    logger.logMcpRequest(stepName, payload);

    let fallbackSelector = '';
    let aiReasoning = '';
    let confidenceScore = 0;
    let aiSucceeded = false;

    // 4. Invoke AI reasoning if provider is attached
    if (this.aiProvider) {
      try {
        logger.warn(`[McpRecoveryAgent] Invoking AI model for pure MCP recovery...`);
        const aiResponse = this.aiProvider.askMcpAI
          ? await this.aiProvider.askMcpAI(payload)
          : await this.aiProvider.askAI(originalElement, []);
        if (aiResponse) {
          aiSucceeded = true;
          confidenceScore = aiResponse.confidence || 0.95;
          fallbackSelector = (aiResponse as any).healedSelector || originalElement.LocCssSelector || '';
          aiReasoning = `[Pure MCP AI Recovery] ${aiResponse.reason || 'AI matched'}`;
        }
      } catch (err: any) {
        const errDetail = err.message?.split('\n')[0] || String(err);
        logger.warn(`[McpRecoveryAgent] AI call failed (${errDetail}). Returning failure to allow fallback to other tiers.`);
        aiReasoning = `MCP AI call failed: ${errDetail}`;
      }
    } else {
      logger.warn(`[McpRecoveryAgent] No AI provider configured. Returning failure to allow fallback to other tiers.`);
      aiReasoning = 'No AI provider configured';
    }

    const result: Tier3McpOutputResult = {
      success: aiSucceeded,
      healedSelector: fallbackSelector,
      confidenceScore,
      visualVerificationPassed: aiSucceeded,
      reasoning: aiReasoning,
      actionExecuted: false
    };

    logger.logMcpResponse(stepName, result);

    return result;
  }
}
