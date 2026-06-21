import { AIProvider } from '../interfaces/ai-provider.interface';
import { ScoringEngine } from '../scoring/scoring.engine';
import { OriginalElement } from '../interfaces/original-element.interface';
import { Candidate } from '../interfaces/candidate.interface';
import { HealingResult } from '../interfaces/healing-result.interface';
import { logger } from '../utils/debug-logger';
import * as fs from 'fs';
import * as path from 'path';
import { SafetyValidator } from '../validation/safety.validator';

function loadConfig() {
  try {
    const configPath = path.join(process.cwd(), 'config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (err) {
    console.error('[RecoveryEngine] Failed to read config.json, using defaults.', err);
  }
  return { USE_AI_MODEL: false, LOG_CANDIDATES: false, AI_MAX_CANDIDATES: 10 };
}

export class RecoveryEngine {
  private stats = {
    totalHealAttempts: 0,
    successfulHealings: 0,
    failedHealings: 0,
    totalAISelections: 0,
    correctAISelections: 0,
    confidenceScores: [] as number[]
  };

  constructor(
    public aiProvider: AIProvider,
    public scoringEngine: ScoringEngine,
    public safetyValidator: SafetyValidator
  ) {}

  // Executes AI healing using DOM scraping, visual validations, and rule-scoring engines
  async heal(
    original: OriginalElement,
    candidates: Candidate[],
    onPhaseChange?: (phase: 'AI' | 'SAFETY') => Promise<void>
  ): Promise<HealingResult> {
    if (!candidates || candidates.length === 0) {
      throw new Error('No candidate elements found on the current page to perform healing.');
    }

    // Step 2: Apply stable-attribute pre-filters to narrow candidates pool
    let pool = this.filterByTagName(original, candidates);
    pool = this.filterByInputType(original, pool);

    // Step 3: Run rule-based scoring models
    const config = loadConfig();
    const { scoredPool, bestMatch, runnerUp, prunedPool } = this.rankCandidates(original, pool, config);

    // Determine if AI is needed based on initial raw rule scores
    const needsAI = !!original.forceAI || bestMatch.score < 90 || (runnerUp && (bestMatch.score - runnerUp.score) < 5);

    // Step 4: Trigger AI reasoning layer (if enabled and scores require it)
    let resolved = await this.runAIReasoning(original, pool, prunedPool, bestMatch.score, config, needsAI, onPhaseChange);
    let triggeredAI = resolved !== null;

    // Step 5: Heuristic fallback validation check if AI was not run or failed safety gates
    if (!resolved) {
      if (onPhaseChange) await onPhaseChange('SAFETY');
      resolved = this.tryTopCandidates(original, scoredPool);
    }

    return {
      healedLocator: resolved.candidate.functional.cssSelector,
      confidence: resolved.confidence,
      reason: resolved.reason,
      triggeredAI,
      candidateId: resolved.candidate.candidateId
    };
  }

  // Filters candidates by tag name (including shadow host tags)
  private filterByTagName(original: OriginalElement, candidates: Candidate[]): Candidate[] {
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
    const isSlot = origTag === 'SLOT';
    const origTagFiltered = isSlot ? '' : origTag;

    if (origTagFiltered || shadowHostTags.length > 0) {
      const filtered = candidates.filter(c => {
        const cTag = c.functional.tagName.toUpperCase();
        return (origTagFiltered && cTag === origTagFiltered) || shadowHostTags.includes(cTag);
      });

      if (filtered.length > 0) {
        console.log(`\n[RecoveryEngine] ── FILTER 2a: Tag = "${origTagFiltered || 'SLOT (Ignored)'}" (Shadow hosts: ${shadowHostTags.join(', ') || 'none'}) ──`);
        console.log(`[RecoveryEngine]    ${filtered.length} of ${candidates.length} candidates survived.`);
        return filtered;
      }

      console.warn(`[RecoveryEngine] No candidates match tag "${origTagFiltered || 'SLOT'}" or shadow hosts [${shadowHostTags.join(', ')}]. Falling back to full pool.`);
    }

    return candidates;
  }

  // Sub-filters candidate elements by inputType (only for INPUT elements)
  private filterByInputType(original: OriginalElement, candidates: Candidate[]): Candidate[] {
    const origTag = (original.OrigTagName || '').toUpperCase().trim();
    if (origTag === 'INPUT' && original.inputType) {
      const origInputType = original.inputType.toLowerCase().trim();
      const inputTypeFiltered = candidates.filter(
        c => (c.functional.inputType || '').toLowerCase() === origInputType
      );
      if (inputTypeFiltered.length > 0) {
        console.log(`\n[RecoveryEngine] ── FILTER 2b: inputType = "${origInputType}" ──────────────────`);
        console.log(`[RecoveryEngine]    ${inputTypeFiltered.length} candidates survived.`);
        return inputTypeFiltered;
      }
      console.warn(`[RecoveryEngine] No candidates match inputType "${origInputType}". Keeping tag-filtered pool.`);
    }
    return candidates;
  }

  // Ranks candidate elements and logs results
  private rankCandidates(
    original: OriginalElement,
    pool: Candidate[],
    config: any
  ): { scoredPool: any[]; bestMatch: any; runnerUp: any; prunedPool: Candidate[] } {
    const sortedPool = [...pool].sort((a, b) => a.candidateId - b.candidateId);
    const scoredPool = this.scoringEngine.scoreCandidates(original, sortedPool);

    if (scoredPool.length === 0) {
      throw new Error('[RecoveryEngine] Scored candidate pool is empty.');
    }

    const bestMatch = scoredPool[0];
    const runnerUp = scoredPool[1];

    console.log(`\n[RecoveryEngine] ── STEP 3: Rule-based Scores (Top 3) ───────────────────────────────`);
    scoredPool.slice(0, 3).forEach((r, i) =>
      console.log(`[RecoveryEngine]    #${i + 1}  score=${r.score.toFixed(1).padStart(5)}  [ID ${r.candidate.candidateId}] ${r.candidate.functional.tagName}  css="${r.candidate.functional.cssSelector}"  text="${r.candidate.semantic.accessibleName}"`)
    );
    console.log(`[RecoveryEngine]    → Best: [ID ${bestMatch.candidate.candidateId}] score=${bestMatch.score}  RunnerUp: ${runnerUp ? `[ID ${runnerUp.candidate.candidateId}] score=${runnerUp.score}` : 'N/A'}`);

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

    return { scoredPool, bestMatch, runnerUp, prunedPool };
  }

  // Triggers the AI reasoning layer and validates selection against safety gates
  private async runAIReasoning(
    original: OriginalElement,
    candidates: Candidate[],
    prunedPool: Candidate[],
    bestMatchScore: number,
    config: any,
    needsAI: boolean,
    onPhaseChange?: (phase: 'AI' | 'SAFETY') => Promise<void>
  ): Promise<{ candidate: Candidate; confidence: number; reason: string } | null> {
    if (!needsAI) {
      return null;
    }

    const isStepTesting = original.stepIndex === 4;
    if (config.USE_AI_MODEL === false && !isStepTesting) {
      console.log(`[RecoveryEngine] AI Reasoning is disabled or bypassed for this step (USE_AI_MODEL=${config.USE_AI_MODEL}, isStepTesting=${isStepTesting}). Falling back directly to highest rule-based candidate.`);
      if (onPhaseChange) await onPhaseChange('SAFETY');
      return null;
    }

    console.log(`[RecoveryEngine] Triggering AI Reasoning Layer (Top Score: ${bestMatchScore}, Needs AI: ${needsAI})`);
    this.stats.totalAISelections++;
    if (onPhaseChange) await onPhaseChange('AI');

    try {
      console.log(`[RecoveryEngine] Pruning candidate pool for AI: ${candidates.length} -> ${prunedPool.length} (Max limit: ${config.AI_MAX_CANDIDATES || 10})`);
      console.log(`[RecoveryEngine] Sending candidate IDs to AI: ${prunedPool.map(c => c.candidateId).join(', ')}`);

      const aiResult = await this.aiProvider.askAI(original, prunedPool);
      const selectedCandidate = candidates.find(c => c.candidateId === aiResult.candidateId);

      if (selectedCandidate) {
        // Validate the AI's selection against safety gates
        if (onPhaseChange) await onPhaseChange('SAFETY');
        const gateResult = this.safetyValidator.validate(original, selectedCandidate);
        if (gateResult.passes) {
          return {
            candidate: selectedCandidate,
            confidence: aiResult.confidence,
            reason: `AI reasoning selected this element. AI Reason: ${aiResult.reason}`
          };
        }
        logger.warn(`[RecoveryEngine] AI-selected Candidate [ID ${selectedCandidate.candidateId}] ("${selectedCandidate.semantic.accessibleName || 'unlabeled'}") FAILED pre-action safety validation (Failed gates: ${gateResult.failedGates.join(', ')}). Bypassing AI choice.`);
      }
    } catch (err: any) {
      logger.warn(`[RecoveryEngine] Error invoking AI reasoning: ${err.message?.split('\n')[0] || err}. Falling back to rule-based evaluation.`);
    }

    return null;
  }

  // Evaluates top heuristic candidates against safety validation gates
  private tryTopCandidates(
    original: OriginalElement,
    scoredPool: any[]
  ): { candidate: Candidate; confidence: number; reason: string } {
    let chosenMatch = null;
    let fallbackIndex = -1;
    let confidence = 0;
    let healingReason = '';

    for (let i = 0; i < Math.min(3, scoredPool.length); i++) {
      const match = scoredPool[i];
      const gateResult = this.safetyValidator.validate(original, match.candidate);
      if (gateResult.passes) {
        chosenMatch = match.candidate;
        fallbackIndex = i;
        confidence = match.score / 100;
        healingReason = `Rule-based scoring selected this element with a score of ${match.score}.`;
        break;
      }
      logger.warn(`[RecoveryEngine] Heuristic Candidate #${i + 1} [ID ${match.candidate.candidateId}] ("${match.candidate.semantic.accessibleName || 'unlabeled'}") FAILED pre-action safety validation (Failed gates: ${gateResult.failedGates.join(', ')}).`);
    }

    if (!chosenMatch) {
      logger.warn(`[RecoveryEngine] Aborting Healing Process: Top 3 heuristic candidates failed pre-action safety validation.`);
      throw new Error(`[RecoveryEngine] Healing aborted: Top 3 candidates failed pre-action safety validation (semantic text / visual shape mismatch).`);
    }

    if (fallbackIndex > 0) {
      logger.warn(`[RecoveryEngine] Falling back to Heuristic Candidate #${fallbackIndex + 1} [ID ${chosenMatch.candidateId}] due to validation failures on higher ranked candidates.`);
    }

    return {
      candidate: chosenMatch,
      confidence,
      reason: healingReason
    };
  }

  /**
   * Returns a formatted multi-line string listing all candidates in a pool.
   * Used after each filter stage to give full visibility into what survived.
   */
  private formatCandidates(pool: Candidate[]): string {
    if (pool.length === 0) return '[RecoveryEngine]    (empty pool)';
    return pool
      .map(c => {
        const id = String(c.candidateId).padStart(4);
        const tag = c.functional.tagName.padEnd(40);
        const depth = `depth=${c.structure.domDepth}`;
        const itype = c.functional.inputType ? ` type=${c.functional.inputType}` : '';
        const role = c.functional.role ? ` role=${c.functional.role}` : '';
        const css = c.functional.cssSelector;
        const text = c.semantic.accessibleName ? `"${c.semantic.accessibleName.substring(0, 50)}"` : '(no text)';
        return `[RecoveryEngine]    [ID ${id}]  ${tag}  ${depth}${itype}${role}  css="${css}"  text=${text}`;
      }).join('\n');
  }

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
