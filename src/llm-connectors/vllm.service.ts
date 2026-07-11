import { OpenAI } from 'openai';
import { AIProvider } from '../interfaces/ai-provider.interface';
import { OriginalElement } from '../interfaces/original-element.interface';
import { Candidate } from '../interfaces/candidate.interface';
import { logger } from '../utils/debug-logger';
import { prepareAIContext } from './ai-helpers';

export class VLLMService implements AIProvider {
  private openai: OpenAI;
  private modelName: string;

  constructor() {
    const baseURL = process.env.VLLM_BASE_URL;
    if (!baseURL) {
      console.warn('[VLLMService] Warning: VLLM_BASE_URL is not defined in environment variables. Defaulting to http://localhost:8000/v1');
    }
    this.openai = new OpenAI({
      apiKey: process.env.VLLM_API_KEY || 'dummy-key',
      baseURL: baseURL || 'http://localhost:8000/v1',
    });
    this.modelName = process.env.VLLM_MODEL_NAME || 'Qwen/Qwen2.5-14B-Instruct';
  }

  async askAI(original: OriginalElement, candidates: Candidate[]): Promise<{
    candidateId: number;
    confidence: number;
    reason: string;
  }> {
    const { cleanedOriginal, cleanedCandidates, systemPrompt, userPrompt, resolvedName } = prepareAIContext(original, candidates);

    // Append JSON instruction specifically for local models without structured outputs
    const vllmSystemPrompt = `${systemPrompt}\n\nOutput your response as a valid JSON object ONLY (no markdown, no explanation outside JSON):\n{\n  "candidateId": number,\n  "confidence": number (0.0 to 1.0),\n  "reason": "string (concise explanation)"\n}`;

    const payload = {
      model: this.modelName,
      messages: [
        { role: 'system' as const, content: vllmSystemPrompt },
        { role: 'user' as const, content: userPrompt },
      ],
      response_format: { type: 'json_object' } as const,
    };

    logger.logAIRequest(resolvedName || 'unknown', payload);

    const response = await this.openai.chat.completions.create(payload);

    const content = response?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);

    logger.logAIResponse(resolvedName || 'unknown', parsed);

    return parsed;
  }
}
