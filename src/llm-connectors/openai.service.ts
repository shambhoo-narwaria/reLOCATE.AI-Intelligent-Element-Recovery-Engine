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
}
