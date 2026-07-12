import * as https from 'https';
import { AIProvider } from '../interfaces/ai-provider.interface';
import { OriginalElement } from '../interfaces/original-element.interface';
import { Candidate } from '../interfaces/candidate.interface';
import { logger } from '../utils/debug-logger';
import { prepareAIContext } from './prompt-builder';

function postJson(url: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            let detailSummary = data;
            try {
              const parsed = JSON.parse(data);
              if (parsed?.error?.message) {
                detailSummary = parsed.error.message.split('\n')[0];
              }
            } catch {}
            reject(new Error(`HTTP Error Status: ${res.statusCode}. Details: ${detailSummary}`));
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(bodyStr);
    req.end();
  });
}

export class GeminiService implements AIProvider {
  private apiKey: string;
  private model: string;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || '';
    if (!this.apiKey) {
      console.warn('[GeminiService] Warning: GEMINI_API_KEY is not defined in environment variables.');
    }
    // Default to gemini-2.5-flash for cost, speed and JSON schema support
    this.model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  }

  async askAI(original: OriginalElement, candidates: Candidate[]): Promise<{
    candidateId: number;
    confidence: number;
    reason: string;
  }> {
    const { cleanedOriginal, cleanedCandidates, systemPrompt, userPrompt, resolvedName } = prepareAIContext(original, candidates);
    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const payload = {
      contents: [
        {
          parts: [
            {
              text: fullPrompt
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            candidateId: { type: 'INTEGER' },
            confidence: { type: 'NUMBER' },
            reason: { type: 'STRING' }
          },
          required: ['candidateId', 'confidence', 'reason']
        }
      }
    };

    logger.logAIRequest(resolvedName || 'unknown', payload);

    try {
      const response = await postJson(url, payload);
      const textResponse = response?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const parsed = JSON.parse(textResponse);

      logger.logAIResponse(resolvedName || 'unknown', parsed);

      return parsed;
    } catch (error: any) {
      const cleanMsg = error.message ? error.message.split('\n')[0] : String(error);
      console.error(`[GeminiService] Error communicating with Gemini API: ${cleanMsg}`);
      throw error;
    }
  }
}
