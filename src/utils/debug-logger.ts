import * as fs from 'fs';
import * as path from 'path';
import { cleanCandidate } from '../utils/candidate-cleaner';

export class DebugLogger {
  private static instance: DebugLogger;
  private logPath: string;

  private constructor() {
    const logsDir = path.join(process.cwd(), '.workspace', 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.logPath = path.join(logsDir, `healing-debug-${ts}.log`);
    this.write(`\n${'='.repeat(80)}\nHEALING DEBUG SESSION — ${new Date().toISOString()}\n${'='.repeat(80)}\n`);
  }

  static getInstance(): DebugLogger {
    if (!DebugLogger.instance) DebugLogger.instance = new DebugLogger();
    return DebugLogger.instance;
  }

  private write(text: string): void {
    try {
      fs.appendFileSync(this.logPath, text);
    } catch {
      // Ignore write errors to not block execution
    }
  }

  private formatData(data: unknown): string {
    if (data === undefined) return '';
    if (typeof data === 'string') return data;
    if (data instanceof Error) {
      return `${data.name}: ${data.message}`;
    }
    if (data && typeof data === 'object') {
      const obj = data as any;
      if (obj.message) {
        return `${obj.name || 'Error'}: ${obj.message}`;
      }
    }
    try {
      return JSON.stringify(data, null, 2);
    } catch (err) {
      return String(data);
    }
  }

  log(tag: string, message: string, data?: unknown): void {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${tag}] ${message}`;
    console.log(message);
    this.write(line + '\n');
    if (data !== undefined) {
      this.write(this.formatData(data) + '\n');
    }
  }

  warn(message: string, data?: unknown): void {
    const ts = new Date().toISOString();
    const line = `[${ts}] [WARN] ${message}`;
    console.warn(message);
    this.write(line + '\n');
    if (data !== undefined) {
      this.write(this.formatData(data) + '\n');
    }
  }

  debug(message: string, data?: unknown): void {
    const ts = new Date().toISOString();
    const line = `[${ts}] [DEBUG] ${message}`;
    this.write(line + '\n');
    if (data !== undefined) {
      this.write(this.formatData(data) + '\n');
    }
  }

  stepStart(index: number, total: number, action: string, objectName: string): void {
    const header = `\n${'─'.repeat(80)}\nSTEP ${index}/${total}  action="${action}"  object="${objectName}"\n${'─'.repeat(80)}`;
    this.write(header + '\n');
  }

  logCandidates(stepName: string, candidates: any[]): void {
    const cleaned = candidates.map(c => cleanCandidate(c));
    const header = `\n── CANDIDATES SENT TO AI (step="${stepName}", count=${candidates.length}) ──────────\n`;
    this.write(header);
    this.write(JSON.stringify(cleaned, null, 2) + '\n');
  }

  logAIRequest(stepName: string, apiPayload: unknown, meta?: { provider?: string; endpoint?: string; mode?: string; model?: string }): void {
    const header = `\n── AI REQUEST (step="${stepName}") ────────────────────────────────────────────\n`;
    this.write(header);

    let rawTextPrompt = '';
    let payloadConfig: any = {};
    try {
      const payload = apiPayload as any;
      const metaInfo = meta || payload?._meta || {};

      if (payload?.contents?.[0]?.parts?.[0]?.text) {
        rawTextPrompt = payload.contents[0].parts[0].text;
        const { contents, _meta, ...rest } = payload;
        payloadConfig = {
          provider: metaInfo.provider || 'gemini',
          endpoint: metaInfo.endpoint || 'https://generativelanguage.googleapis.com',
          mode: metaInfo.mode || 'Stage 1B Fingerprint AI',
          model: metaInfo.model || 'gemini-2.5-flash',
          ...rest
        };
      } else if (payload?.messages) {
        const sysMsg = payload.messages.find((m: any) => m.role === 'system')?.content || '';
        const usrMsgObj = payload.messages.find((m: any) => m.role === 'user')?.content;
        const usrMsg = typeof usrMsgObj === 'string'
          ? usrMsgObj
          : Array.isArray(usrMsgObj)
            ? usrMsgObj.map((c: any) => c.text || JSON.stringify(c)).join('\n')
            : '';
        rawTextPrompt = `[SYSTEM PROMPT]\n${sysMsg}\n\n[USER PROMPT]\n${usrMsg}`;
        const { messages, _meta, ...rest } = payload;
        payloadConfig = {
          provider: metaInfo.provider || 'openai',
          endpoint: metaInfo.endpoint || 'https://api.openai.com/v1/chat/completions',
          mode: metaInfo.mode || 'Stage 1B Fingerprint AI',
          model: metaInfo.model || rest.model || 'gpt-4o',
          ...rest
        };
      } else {
        const { _meta, ...rest } = payload || {};
        payloadConfig = {
          provider: metaInfo.provider || 'unknown',
          endpoint: metaInfo.endpoint,
          mode: metaInfo.mode,
          ...rest
        };
      }
    } catch {}

    if (rawTextPrompt) {
      this.write(`[RAW PROMPT]\n${rawTextPrompt}\n\n`);
    }

    if (payloadConfig && Object.keys(payloadConfig).length > 0) {
      this.write(`[API CONFIG]\n${JSON.stringify(payloadConfig, null, 2)}\n\n`);
    }
  }

  logAIResponse(stepName: string, response: unknown): void {
    const header = `\n── AI RESPONSE (step="${stepName}") ───────────────────────────────────────────\n`;
    this.write(header);
    this.write(JSON.stringify(response, null, 2) + '\n');
  }

  logHealResult(stepName: string, oldLocator: string, newLocator: string, confidence: number, reason: string, candidateId?: number): void {
    const header = `\n── HEAL RESULT (step="${stepName}") ────────────────────────────────────────────\n`;
    this.write(header);
    this.write(`  Old locator : ${oldLocator}\n`);
    this.write(`  New locator : ${newLocator}\n`);
    if (candidateId !== undefined) {
      this.write(`  Candidate ID: ${candidateId}\n`);
    }
    this.write(`  Confidence  : ${(confidence * 100).toFixed(0)}%\n`);
    this.write(`  Reason      : ${reason}\n`);
  }

  logMcpRequest(stepName: string, mcpPayload: any): void {
    const header = `\n── MCP RECOVERY REQUEST (step="${stepName}") ────────────────────────────────────\n`;
    this.write(header);
    
    // Omit base64 string and accessibilityTree from raw JSON to keep log clean
    const { screenshotBase64, accessibilityTree, ...cleanedPayload } = mcpPayload || {};
    const loggablePayload = {
      ...cleanedPayload,
      screenshotAttached: !!screenshotBase64
    };

    this.write(`[MCP PAYLOAD]\n${JSON.stringify(loggablePayload, null, 2)}\n`);

    // Print accessibility tree as readable multi-line YAML
    if (accessibilityTree && typeof accessibilityTree === 'string' && accessibilityTree.length > 0) {
      this.write(`\n[ACCESSIBILITY TREE]\n${accessibilityTree}\n\n`);
    } else {
      this.write(`\n[ACCESSIBILITY TREE] (empty)\n\n`);
    }
  }

  logMcpResponse(stepName: string, response: unknown): void {
    const header = `\n── MCP RECOVERY RESPONSE (step="${stepName}") ───────────────────────────────────\n`;
    this.write(header);
    this.write(`[MCP RESULT]\n${JSON.stringify(response, null, 2)}\n\n`);
  }

  getLogPath(): string {
    return this.logPath;
  }
}

export const logger = DebugLogger.getInstance();
