import { OpenAI } from 'openai';
import { AIProvider } from '../interfaces/ai-provider.interface';
import { OriginalElement } from '../interfaces/original-element.interface';
import { Candidate } from '../interfaces/candidate.interface';
import { logger } from '../utils/debug-logger';
import { prepareAIContext } from './prompt-builder';

export class OpenRouterService implements AIProvider {
  private openai: OpenAI;
  private modelName: string;

  constructor() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.warn('[OpenRouterService] Warning: OPENROUTER_API_KEY is not defined in environment variables.');
    }
    const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    this.openai = new OpenAI({
      apiKey: apiKey || 'dummy-key',
      baseURL: baseURL,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/google-deepmind/antigravity',
        'X-Title': 'AI-Element-Identifier',
      }
    });
    this.modelName = process.env.OPENROUTER_MODEL_NAME || 'qwen/qwen-2.5-7b-instruct:free';
  }

  async askAI(original: OriginalElement, candidates: Candidate[]): Promise<{
    candidateId: number;
    confidence: number;
    reason: string;
  }> {
    const { cleanedOriginal, cleanedCandidates, systemPrompt, userPrompt, resolvedName } = prepareAIContext(original, candidates);

    const payload = {
      model: this.modelName,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userPrompt },
      ],
      response_format: { type: 'json_object' } as const,
    };

    logger.logAIRequest(resolvedName || 'unknown', payload);

    const MAX_ATTEMPTS = 1;
    const PER_CALL_TIMEOUT_MS = 60_000;

    let lastError: any;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        console.log(`[OpenRouterService] AI request attempt ${attempt}/${MAX_ATTEMPTS} for "${resolvedName || 'unknown'}"...`);

        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);

        let response: any;
        try {
          response = await (this.openai.chat.completions.create as any)(
            payload,
            { signal: controller.signal }
          );
        } finally {
          clearTimeout(timeoutHandle);
        }

        const content = response?.choices?.[0]?.message?.content || '{}';
        const parsed = JSON.parse(content);

        console.log(`[OpenRouterService] Response successfully served by model: "${response.model}"`);
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.reason === 'string') {
            parsed.reason = `${parsed.reason} (Model: ${response.model})`;
          } else {
            parsed.reason = `(Model: ${response.model})`;
          }
        }

        logger.logAIResponse(resolvedName || 'unknown', parsed);

        return parsed;

      } catch (err: any) {
        lastError = err;
        const isAbort = err?.name === 'AbortError' || err?.message?.includes('aborted');
        const status  = err?.status ?? err?.response?.status ?? 0;
        const isRetryable = isAbort || status === 429 || status === 500 || status === 503 || status === 0;

        console.warn(
          `[OpenRouterService] Attempt ${attempt}/${MAX_ATTEMPTS} failed for "${resolvedName || 'unknown'}": ` +
          `${err.message || err}`
        );

        if (!isRetryable || attempt === MAX_ATTEMPTS) {
          break;
        }

        const backOffDelay = 3000 * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, backOffDelay));
      }
    }

    throw lastError || new Error('OpenRouter AI call failed');
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
      model: this.modelName,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userContent },
      ],
      response_format: { type: 'json_object' } as const,
    };

    const response = await (this.openai.chat.completions.create as any)(payload);
    const content = response?.choices?.[0]?.message?.content || '{}';
    return JSON.parse(content);
  }
}
