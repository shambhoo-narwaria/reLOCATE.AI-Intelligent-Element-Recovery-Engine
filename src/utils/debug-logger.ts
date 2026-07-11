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

  logAIRequest(stepName: string, original: unknown, candidates: unknown[], systemPrompt: string, userPrompt: string, apiPayload?: unknown): void {
    const header = `\n── AI REQUEST (step="${stepName}") ────────────────────────────────────────────\n`;
    this.write(header);
    this.write(`[SYSTEM PROMPT]\n${systemPrompt}\n\n`);
    this.write(`[USER PROMPT]\n${userPrompt}\n\n`);
    this.write(`[ORIGINAL ELEMENT]\n${JSON.stringify(original, null, 2)}\n\n`);
    this.write(`[CANDIDATES]\n${JSON.stringify(candidates, null, 2)}\n\n`);
    this.write(`[CANDIDATE COUNT] ${Array.isArray(candidates) ? candidates.length : '?'}\n`);
    if (apiPayload !== undefined) {
      this.write(`\n[API PAYLOAD]\n${JSON.stringify(apiPayload, null, 2)}\n\n`);
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

  getLogPath(): string {
    return this.logPath;
  }
}

export const logger = DebugLogger.getInstance();
