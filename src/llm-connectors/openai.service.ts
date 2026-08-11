import { OpenAI } from 'openai';
import { AIProvider } from '../interfaces/ai-provider.interface';
import { OriginalElement } from '../interfaces/original-element.interface';
import { Candidate } from '../interfaces/candidate.interface';
import { logger } from '../utils/debug-logger';
import { prepareAIContext } from './prompt-builder';

export class OpenAIService implements AIProvider {
  private openai: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn('[OpenAIService] Warning: OPENAI_API_KEY is not defined in environment variables.');
    }
    this.openai = new OpenAI({ apiKey });
  }

  async askAI(original: OriginalElement, candidates: Candidate[]): Promise<{
    candidateId: number;
    confidence: number;
    reason: string;
  }> {
    const { cleanedOriginal, cleanedCandidates, systemPrompt, userPrompt, resolvedName } = prepareAIContext(original, candidates);

    const payload = {
      model: 'gpt-4o',
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const,   content: userPrompt   },
      ],
      response_format: { type: 'json_object' } as const,
    };

    logger.logAIRequest(resolvedName || 'unknown', payload);

    const response = await this.openai.chat.completions.create(payload);

    const content = response?.choices?.[0]?.message?.content || '{}';
    const parsed  = JSON.parse(content);

    logger.logAIResponse(resolvedName || 'unknown', parsed);

    return parsed;
  }

  async askMcpAI(mcpPayload: import('../interfaces/mcp-recovery.interface').Tier3CompactMcpInputPayload): Promise<{
    healedSelector: string;
    confidence: number;
    reason: string;
  }> {
    const systemPrompt = `You are an expert AI element healing system operating in MCP mode.
Given target metadata, failure context, and page accessibility tree (or screenshot), identify the single best CSS selector or ARIA locator to locate and interact with the target element.

CRITICAL SELECTOR RULES:
1. The original selector has FAILED on the page. Do NOT return the exact failing original selector. You MUST formulate a NEW, resilient locator based on the accessibility tree.
2. For ARIA role selectors based on the accessibility tree, use getByRole format:
   - getByRole('textbox', { name: 'Username' })
   - getByRole('button', { name: 'Sign in' })
   - getByRole('heading', { name: 'Patients' })
3. DO NOT output invalid CSS selectors like [role='textbox']. Always use getByRole(...) locators.

Output your response as a valid JSON object matching this structure:
{
  "healedSelector": "string",
  "confidence": number,
  "reason": "string"
}`;

    const userPrompt = `Target Metadata:
${JSON.stringify(mcpPayload.targetMetadata, null, 2)}

Failure Context:
${JSON.stringify(mcpPayload.failureContext, null, 2)}

Accessibility Tree:
${typeof mcpPayload.accessibilityTree === 'string' ? mcpPayload.accessibilityTree : JSON.stringify(mcpPayload.accessibilityTree, null, 2)}`;

    const userContent: any[] = [{ type: 'text', text: userPrompt }];
    if (mcpPayload.screenshotBase64) {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${mcpPayload.screenshotBase64}` }
      });
    }

    const payload = {
      model: 'gpt-4o',
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userContent },
      ],
      response_format: { type: 'json_object' } as const,
    };

    const response = await this.openai.chat.completions.create(payload as any);
    const content = response?.choices?.[0]?.message?.content || '{}';
    return JSON.parse(content);
  }
}
