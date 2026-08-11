import { Page } from 'playwright';
import { OriginalElement } from '../interfaces/original-element.interface';
import { Tier3CompactMcpInputPayload, Tier3McpOutputResult } from '../interfaces/mcp-recovery.interface';
import { AIProvider } from '../interfaces/ai-provider.interface';
import { logger } from '../utils/debug-logger';
import { waitForPageSettle } from '../utils/page-stabilizer';

import * as fs from 'fs';
import * as path from 'path';

function isMcpFallbackEnabled(): boolean {
  try {
    const configPath = path.resolve(process.cwd(), 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config.ENABLE_MCP_FALLBACK !== false;
    }
  } catch { }
  return true;
}

export class McpRecoveryAgent {
  constructor(private aiProvider?: AIProvider) { }

  /**
   * Performs Stage 2 recovery using pure token-efficient MCP accessibility snapshots.
   * Uses locator.ariaSnapshot() which returns YAML natively in MCP format.
   */
  async executeStage2McpRecovery(
    page: Page,
    originalElement: OriginalElement,
    failureReason: string
  ): Promise<Tier3McpOutputResult> {
    if (!isMcpFallbackEnabled()) {
      logger.warn(`[McpRecoveryAgent] Stage 2 MCP Fallback disabled via config.json (ENABLE_MCP_FALLBACK: false).`);
      return {
        healedSelector: '',
        confidenceScore: 0,
        visualVerificationPassed: false,
        reasoning: 'Stage 2 MCP Fallback disabled via ENABLE_MCP_FALLBACK config',
        actionExecuted: false,
        success: false
      };
    }

    const stepNum = originalElement.index !== undefined ? originalElement.index + 1 : 0;
    const stepName = stepNum > 0 ? `Step ${stepNum} (${originalElement.ObjectName || 'Target Element'})` : (originalElement.ObjectName || 'Target Element');
    logger.warn(`[McpRecoveryAgent] Initiating Stage 2 MCP Fallback for "${stepName}"...`);

    // 1. Wait for page to fully settle (network idle, DOM mutations stopped)
    try {
      await waitForPageSettle(page, 15000);
      await page.waitForTimeout(5000);
    } catch { }

    // 2. Hide the injected StatusOverlay DOM element before capturing the snapshot
    //    so it doesn't pollute the accessibility tree with internal engine text.
    await page.evaluate(() => {
      const overlay = document.getElementById('__ai-healing-status-overlay__');
      if (overlay) overlay.setAttribute('aria-hidden', 'true');
    }).catch(() => { });

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
    }).catch(() => { });

    const hasInteractiveNodes = ariaSnapshotYaml.length > 0;
    let screenshotBase64: string | undefined;

    if (!hasInteractiveNodes) {
      logger.debug(`[McpRecoveryAgent] Accessibility tree empty/insufficient. Capturing selective JPEG screenshot...`);
      const screenshotBuf = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
      if (screenshotBuf) {
        screenshotBase64 = screenshotBuf.toString('base64');
      }
    }

    function inferRole(originalElement: OriginalElement): string {
      if (originalElement.role) return originalElement.role.toLowerCase();
      if (originalElement.LocRole) return originalElement.LocRole.toLowerCase();

      const tag = (originalElement.OrigTagName || originalElement.LocTagName || '').toUpperCase();
      const type = (originalElement.inputType || originalElement.LocType || '').toLowerCase();
      const action = (originalElement.Action || '').toLowerCase();
      const selector = (originalElement.LocCssSelector || originalElement.LocXpath || '').toLowerCase();

      if (tag === 'IMG') return 'img';
      if (tag === 'BUTTON') return 'button';
      if (tag === 'A') return 'link';
      if (tag === 'INPUT') {
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'submit' || type === 'button') return 'button';
        return 'textbox';
      }
      if (tag === 'SELECT') return 'combobox';
      if (tag === 'TEXTAREA') return 'textbox';
      if (tag === 'NAV') return 'navigation';
      if (/^H[1-6]$/.test(tag)) return 'heading';

      // Selector hints
      if (selector.includes('img') || selector.includes('image') || selector.includes('thumbnail')) return 'img';
      if (selector.includes('button') || selector.includes('btn')) return 'button';
      if (selector.includes('link') || selector.includes('nav')) return 'link';

      // Action hints
      if (action === 'enter' || action === 'fill') return 'textbox';
      if (action === 'click') return 'button';

      return tag ? tag.toLowerCase() : '';
    }

    // 3. Construct lightweight input payload (<500 tokens total) in official MCP format
    const payload: Tier3CompactMcpInputPayload = {
      targetMetadata: {
        objectName: originalElement.ObjectName || 'Target Element',
        action: (originalElement.Action || 'click').toLowerCase(),
        role: inferRole(originalElement),
        tagName: originalElement.OrigTagName || originalElement.LocTagName || undefined,
        locText: originalElement.LocText || originalElement.OwnInnerText || originalElement.accessibleName || undefined,
        inputType: originalElement.inputType || originalElement.LocType || undefined,
        valueToEnter: originalElement.inputText || originalElement.InputData || originalElement.LocText || undefined,
        originalSelector: originalElement.LocCssSelector || originalElement.LocXpath || undefined,
        labelText: originalElement.labelText || undefined
      },
      failureContext: {
        reason: failureReason
      },
      accessibilityTree: ariaSnapshotYaml || {},
      screenshotBase64
    };


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
