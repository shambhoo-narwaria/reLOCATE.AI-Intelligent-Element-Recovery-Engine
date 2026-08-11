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
    // Default to gemini-2.0-flash (official active model for Gemini API)
    this.model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
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

    logger.logAIRequest(resolvedName || 'unknown', payload, {
      provider: 'gemini',
      endpoint: url.replace(/\?key=.*/, '?key=***MASKED***'),
      mode: 'Stage 1B Fingerprint AI',
      model: this.model
    });

    try {
      const response = await postJson(url, payload);
      const textResponse = response?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const parsed = JSON.parse(textResponse);
      const candidateId = Number(parsed.candidateId ?? parsed.selectedCandidateId ?? parsed.candidate_id ?? parsed.id);
      const result = {
        candidateId,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.95,
        reason: parsed.reason || parsed.reasoning || 'AI matched candidate'
      };

      logger.logAIResponse(resolvedName || 'unknown', result);

      return result;
    } catch (error: any) {
      const cleanMsg = error.message ? error.message.split('\n')[0] : String(error);
      console.error(`[GeminiService] Error communicating with Gemini API: ${cleanMsg}`);
      throw error;
    }
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
3. DO NOT output invalid CSS selectors like [role='textbox']. Always use getByRole(...) locators.`;

    const userPrompt = `Target Metadata:
${JSON.stringify(mcpPayload.targetMetadata, null, 2)}

Failure Context:
${JSON.stringify(mcpPayload.failureContext, null, 2)}

Accessibility Tree:
${typeof mcpPayload.accessibilityTree === 'string' ? mcpPayload.accessibilityTree : JSON.stringify(mcpPayload.accessibilityTree, null, 2)}`;

    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    
    const parts: any[] = [{ text: fullPrompt }];
    if (mcpPayload.screenshotBase64) {
      parts.push({
        inline_data: {
          mime_type: 'image/jpeg',
          data: mcpPayload.screenshotBase64
        }
      });
    }

    const payload = {
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            healedSelector: { type: 'STRING' },
            confidence: { type: 'NUMBER' },
            reason: { type: 'STRING' }
          },
          required: ['healedSelector', 'confidence', 'reason']
        }
      }
    };

    const stepName = mcpPayload.targetMetadata?.objectName || 'MCP Recovery';
    logger.logAIRequest(stepName, payload, {
      provider: 'gemini',
      endpoint: url.replace(/\?key=.*/, '?key=***MASKED***'),
      mode: 'Stage 2 MCP AI',
      model: this.model
    });

    const response = await postJson(url, payload);
    const textResponse = response?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(textResponse);
    logger.logAIResponse(stepName, parsed);
    return parsed;
  }
}

