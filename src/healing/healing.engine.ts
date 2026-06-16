import { AIProvider } from '../interfaces/ai-provider.interface';
import { ScoringEngine } from '../scoring/scoring.engine';
import { OriginalElement } from '../interfaces/original-element.interface';
import { Candidate } from '../interfaces/candidate.interface';
import { HealingResult } from '../interfaces/healing-result.interface';
import { logger } from '../logger/debug-logger';
import * as fs from 'fs';
import * as path from 'path';

function loadConfig() {
  try {
    const configPath = path.join(process.cwd(), 'config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (err) {
    console.error('[HealingEngine] Failed to read config.json, using defaults.', err);
  }
  return { USE_AI_MODEL: false, LOG_CANDIDATES: false, AI_MAX_CANDIDATES: 10 };
}

export class HealingEngine {
  private stats = {
    totalHealAttempts: 0,
    successfulHealings: 0,
    failedHealings: 0,
    totalAISelections: 0,
    correctAISelections: 0,
    confidenceScores: [] as number[]
  };

  constructor(public aiProvider: AIProvider, public scoringEngine: ScoringEngine) {}

  async heal(original: OriginalElement, candidates: Candidate[]): Promise<HealingResult> {
    if (!candidates || candidates.length === 0) {
      throw new Error('No candidate elements found on the current page to perform healing.');
    }

    // ── Step 2: Stable-attribute pre-filters ─────────────────────────────────
    // We assume tag name, inputType (for INPUT elements), and ARIA role are
    // all stable across UI changes and can safely narrow the candidate pool
    // before any scoring or AI reasoning begins.

    // 2a: Tag-name filter (including shadow host tags as valid alternatives)
    const origTag = (original.OrigTagName || '').toUpperCase().trim();
    const shadowHostTagsSet = new Set<string>();

    // Extract tags from ShadowDomHostArray (selectors)
    (original.ShadowDomHostArray || []).forEach((sel: string) => {
      const parts = sel.split(/[\s>+~]+/);
      parts.forEach(part => {
        const match = part.match(/^([a-zA-Z0-9-]+)/);
        if (match) {
          const tag = match[1].toUpperCase();
          if (tag && tag !== 'HTML' && tag !== 'BODY') {
            shadowHostTagsSet.add(tag);
          }
        }
      });
    });

    // Extract tags from ShadowDomFullXpathArray (XPaths)
    (original.ShadowDomFullXpathArray || []).forEach((xpath: string) => {
      xpath.split('/').filter(Boolean).forEach(seg => {
        const tag = seg.replace(/\[\d+\]/g, '').toUpperCase().trim();
        if (tag && tag !== 'HTML' && tag !== 'BODY') {
          shadowHostTagsSet.add(tag);
        }
      });
    });

    const shadowHostTags = [...shadowHostTagsSet];

    let pool = candidates;
    if (origTag) {
      const filtered = candidates.filter(c => {
        const cTag = c.functional.tagName.toUpperCase();
        return cTag === origTag || shadowHostTags.includes(cTag);
      });

      if (filtered.length > 0) {
        pool = filtered;
        console.log(`\n[HealingEngine] ── FILTER 2a: Tag = "${origTag}" (Shadow hosts: ${shadowHostTags.join(', ') || 'none'}) ──`);
        console.log(`[HealingEngine]    ${pool.length} of ${candidates.length} candidates survived.`);
      } else {
        console.warn(`[HealingEngine] No candidates match tag "${origTag}" or shadow hosts [${shadowHostTags.join(', ')}]. Falling back to full pool.`);
        pool = candidates;
      }
    }

    // 2b: inputType sub-filter (only for INPUT elements)
    if (origTag === 'INPUT' && original.inputType) {
      const origInputType = original.inputType.toLowerCase().trim();
      const inputTypeFiltered = pool.filter(
        c => (c.functional.inputType || '').toLowerCase() === origInputType
      );
      if (inputTypeFiltered.length > 0) {
        pool = inputTypeFiltered;
        console.log(`\n[HealingEngine] ── FILTER 2b: inputType = "${origInputType}" ──────────────────`);
        console.log(`[HealingEngine]    ${pool.length} candidates survived.`);
      } else {
        console.warn(`[HealingEngine] ⚠  No candidates match inputType "${origInputType}". Keeping tag-filtered pool.`);
      }
    }

    // ── Step 3: Rule-based scoring ────────────────────────────────────────────
    const sortedPool = [...pool].sort((a, b) => a.candidateId - b.candidateId);
    const scoredPool = this.scoringEngine.scoreCandidates(original, sortedPool);
    const bestMatch  = scoredPool[0];
    const runnerUp   = scoredPool[1];

    console.log(`\n[HealingEngine] ── STEP 3: Rule-based Scores (Top 3) ───────────────────────────────`);
    scoredPool.slice(0, 3).forEach((r, i) =>
      console.log(`[HealingEngine]    #${i + 1}  score=${r.score.toFixed(1).padStart(5)}  [ID ${r.candidate.candidateId}] ${r.candidate.functional.tagName}  css="${r.candidate.functional.cssSelector}"  text="${r.candidate.semantic.accessibleName}"`)
    );
    console.log(`[HealingEngine]    → Best: [ID ${bestMatch.candidate.candidateId}] score=${bestMatch.score}  RunnerUp: ${runnerUp ? `[ID ${runnerUp.candidate.candidateId}] score=${runnerUp.score}` : 'N/A'}`);

    const config = loadConfig();

    // Prepare the pruned candidate pool (we do this regardless of AI so we can log it)
    const maxAiCandidates = config.AI_MAX_CANDIDATES || 10;
    const topScoredCandidates = scoredPool.slice(0, maxAiCandidates);
    
    // Log the top candidates to the debug file for manual inspection if enabled
    if (config.LOG_CANDIDATES) {
      const debugPayload = topScoredCandidates.map(item => ({
        ...item.candidate,
        _totalScore: item.score,
        _ruleScores: item.ruleScores
      }));
      logger.logCandidates(original.ObjectName || 'unknown', debugPayload);
    }

    const prunedPool = topScoredCandidates.map(item => item.candidate);

    // Determine if AI is needed:
    // 1. Top score is less than 90
    // 2. Margin between top match and runner-up is close (difference < 5)
    const needsAI = !!original.forceAI || bestMatch.score < 90 || (runnerUp && (bestMatch.score - runnerUp.score) < 5);

    if (needsAI) {
      if (config.USE_AI_MODEL === false) {
        console.log(`[HealingEngine] AI Reasoning is disabled in .env (USE_AI_MODEL=false). Falling back directly to highest rule-based candidate.`);
      } else {
        console.log(`[HealingEngine] Triggering AI Reasoning Layer (Top Score: ${bestMatch.score}, Needs AI: ${needsAI})`);
        this.stats.totalAISelections++;
        
        try {
          console.log(`[HealingEngine] Pruning candidate pool for AI: ${sortedPool.length} -> ${prunedPool.length} (Max limit: ${maxAiCandidates})`);
          console.log(`[HealingEngine] Sending candidate IDs to AI: ${prunedPool.map(c => c.candidateId).join(', ')}`);

          const aiResult = await this.aiProvider.askAI(original, prunedPool);
          const selectedCandidate = sortedPool.find(c => c.candidateId === aiResult.candidateId);
          
          if (selectedCandidate) {
            const locator = selectedCandidate.functional.cssSelector;
            return {
              healedLocator: locator,
              confidence: aiResult.confidence,
              reason: `AI reasoning selected this element. AI Reason: ${aiResult.reason}`,
              triggeredAI: true,
              candidateId: selectedCandidate.candidateId
            };
          }
        } catch (err: any) {
          // Keep logs clean: print just the message instead of the massive stack trace
          console.error(`[HealingEngine] ⚠ Error invoking AI reasoning: ${err.message?.split('\n')[0] || err}. Falling back to highest rule-based candidate.`);
        }
      }
    }

    // Fall back to rule-based best candidate
    const locator = bestMatch.candidate.functional.cssSelector;
    return {
      healedLocator: locator,
      confidence: bestMatch.score / 100,
      reason: `Rule-based scoring selected this element with a score of ${bestMatch.score}.`,
      triggeredAI: false,
      candidateId: bestMatch.candidate.candidateId
    };
  }

  /**
   * Returns a formatted multi-line string listing all candidates in a pool.
   * Used after each filter stage to give full visibility into what survived.
   */
  private formatCandidates(pool: Candidate[]): string {
    if (pool.length === 0) return '[HealingEngine]    (empty pool)';
    return pool
      .map(c => {
        const id      = String(c.candidateId).padStart(4);
        const tag     = c.functional.tagName.padEnd(40);
        const depth   = `depth=${c.structure.domDepth}`;
        const itype   = c.functional.inputType ? ` type=${c.functional.inputType}` : '';
        const role    = c.functional.role ? ` role=${c.functional.role}` : '';
        const css     = c.functional.cssSelector;
        const text    = c.semantic.accessibleName ? `"${c.semantic.accessibleName.substring(0, 50)}"` : '(no text)';
        return `[HealingEngine]    [ID ${id}]  ${tag}  ${depth}${itype}${role}  css="${css}"  text=${text}`;
      }).join('\n');
  }

  // Record healing outcomes and metrics
  recordOutcome(oldLocator: string, newLocator: string, success: boolean, triggeredAI: boolean, confidence: number) {
    this.stats.totalHealAttempts++;
    this.stats.confidenceScores.push(confidence);

    if (success) {
      this.stats.successfulHealings++;
      if (triggeredAI) {
        this.stats.correctAISelections++;
      }
    } else {
      this.stats.failedHealings++;
    }
  }

  // Get formatted stats
  getStats() {
    const total = this.stats.totalHealAttempts;
    const success = this.stats.successfulHealings;
    const aiTotal = this.stats.totalAISelections;
    const aiCorrect = this.stats.correctAISelections;
    const successRate = total > 0 ? (success / total) * 100 : 0;
    const aiAccuracy = aiTotal > 0 ? (aiCorrect / aiTotal) * 100 : 0;
    const avgConfidence = this.stats.confidenceScores.length > 0 ? this.stats.confidenceScores.reduce((a, b) => a + b, 0) / this.stats.confidenceScores.length * 100 : 0;

    return {
      totalHealAttempts: total,
      successfulHealings: success,
      failedHealings: this.stats.failedHealings,
      healingSuccessRate: `${successRate.toFixed(1)}%`,
      totalAISelections: aiTotal,
      aiAccuracy: `${aiAccuracy.toFixed(1)}%`,
      averageConfidence: `${avgConfidence.toFixed(1)}%`
    };
  }
}
