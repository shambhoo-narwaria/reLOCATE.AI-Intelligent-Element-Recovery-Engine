import { Locator } from 'playwright';
import { ValidationGate } from '../interfaces/validation-gate.interface';
import { OriginalElement } from '../interfaces/original-element.interface';
import { Candidate } from '../interfaces/candidate.interface';
import { stringSimilarity } from '../scoring/rules/similarity.helper';
import { logger } from '../utils/debug-logger';

export class SemanticValidationGate implements ValidationGate {
  readonly name = 'SemanticValidationGate';
  /** Stores the last computed similarity so SafetyValidator can read it */
  lastSimilarity: number = 0;
  constructor(private threshold: number = 0.30) {}

  validate(original: OriginalElement, candidate: Candidate): boolean {
    const origText = (original.LocText || original.OwnInnerText || original.LocTitle || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const candText = (candidate.semantic.accessibleName || candidate.semantic.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    
    if (!origText) {
      logger.debug(`[SemanticValidationGate] Candidate [ID ${candidate.candidateId}] bypassed (no original text baseline).`);
      this.lastSimilarity = 0.0;
      return true; 
    }

    const similarity = stringSimilarity(origText, candText);
    this.lastSimilarity = similarity;
    const isSubstring = !!(origText && candText) && (candText.includes(origText) || origText.includes(candText));
    
    // Substring match counts as full similarity for bypass purposes
    if (isSubstring) {
      this.lastSimilarity = Math.max(similarity, 1.0);
    }

    const passed = similarity >= this.threshold || isSubstring;
    const similarityPercent = (similarity * 100).toFixed(1);
    const thresholdPercent = (this.threshold * 100).toFixed(0);

    if (!passed) {
      logger.warn(`[SemanticValidationGate] Candidate [ID ${candidate.candidateId}] FAILED: only ${similarityPercent}% semantically similar to original element (Required: ${thresholdPercent}%, SubstringMatch = ${isSubstring}). Texts: "${origText}" vs "${candText}"`);
    } else {
      logger.debug(`[SemanticValidationGate] Candidate [ID ${candidate.candidateId}] PASSED: ${similarityPercent}% semantically similar to original element (SubstringMatch = ${isSubstring})`);
    }

    return passed;
  }
}

export class VisualValidationGate implements ValidationGate {
  readonly name = 'VisualValidationGate';
  constructor(private threshold: number = 0.15) {}

  validate(original: OriginalElement, candidate: Candidate): boolean {
    if (!original.Screenshot || candidate.visual.similarity === undefined) {
      logger.debug(`[VisualValidationGate] Candidate [ID ${candidate.candidateId}] bypassed (no screenshot or similarity missing).`);
      return true; 
    }

    const similarity = candidate.visual.similarity;

    if (similarity === 0) {
      logger.debug(`[VisualValidationGate] Candidate [ID ${candidate.candidateId}] bypassed (similarity score is 0/fallback).`);
      return true;
    }

    if (similarity === -1.0 || similarity === -0.5) {
      logger.warn(`[VisualValidationGate] Candidate [ID ${candidate.candidateId}] FAILED due to size-penalized anomaly (visual score = ${similarity})`);
      return false;
    }

    const passed = similarity >= this.threshold;
    const similarityPercent = (similarity * 100).toFixed(1);
    const thresholdPercent = (this.threshold * 100).toFixed(0);

    if (!passed) {
      logger.warn(`[VisualValidationGate] Candidate [ID ${candidate.candidateId}] FAILED: only ${similarityPercent}% visually similar to original element (Required: ${thresholdPercent}%)`);
    } else {
      logger.debug(`[VisualValidationGate] Candidate [ID ${candidate.candidateId}] PASSED: ${similarityPercent}% visually similar to original element`);
    }

    return passed;
  }
}

/** Threshold above which semantic similarity causes VisualValidationGate to be bypassed */
const SEMANTIC_VISUAL_BYPASS_THRESHOLD = 0.50;

export class SafetyValidator {
  constructor(private gates: ValidationGate[]) {}

  validate(original: OriginalElement, candidate: Candidate): { passes: boolean; failedGates: string[] } {
    const failedGates: string[] = [];

    // Run SemanticValidationGate first to determine if visual gate should be bypassed
    const semanticGate = this.gates.find(g => g instanceof SemanticValidationGate) as SemanticValidationGate | undefined;
    let skipVisualGate = false;

    if (semanticGate) {
      const semanticPassed = semanticGate.validate(original, candidate);
      if (!semanticPassed) {
        failedGates.push(semanticGate.name);
      } else if (semanticGate.lastSimilarity >= SEMANTIC_VISUAL_BYPASS_THRESHOLD) {
        // Candidate is ≥50% semantically similar — bypass visual gate
        skipVisualGate = true;
        logger.debug(`[SafetyValidator] Candidate [ID ${candidate.candidateId}] semantic similarity ${(semanticGate.lastSimilarity * 100).toFixed(1)}% ≥ ${(SEMANTIC_VISUAL_BYPASS_THRESHOLD * 100).toFixed(0)}% → bypassing VisualValidationGate`);
      }
    }

    // Run remaining gates (skip visual if semantic similarity is high enough)
    for (const gate of this.gates) {
      if (gate instanceof SemanticValidationGate) continue; // already ran above
      if (skipVisualGate && gate instanceof VisualValidationGate) continue; // bypassed
      if (!gate.validate(original, candidate)) {
        failedGates.push(gate.name);
      }
    }

    return {
      passes: failedGates.length === 0,
      failedGates
    };
  }
}

export async function validateOriginalLocatorSemantically(element: Locator, originalElement: OriginalElement): Promise<boolean> {
  const rawTarget = originalElement.LocText || originalElement.LocTitle || originalElement.OwnInnerText || '';
  if (!rawTarget.trim()) {
    logger.debug(`[validateOriginalLocatorSemantically] Bypassing semantic validation: No target text present in originalElement.`);
    return true;
  }

  const targetText = rawTarget.toLowerCase().replace(/\s+/g, ' ').trim();

  let textContent = '';
  let title = '';
  let placeholder = '';
  let ariaLabel = '';

  try {
    textContent = await element.textContent() || '';
  } catch {}
  try {
    title = await element.getAttribute('title') || '';
  } catch {}
  try {
    placeholder = await element.getAttribute('placeholder') || '';
  } catch {}
  try {
    ariaLabel = await element.getAttribute('aria-label') || '';
  } catch {}

  const properties = [textContent, title, placeholder, ariaLabel].map(val => val.toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean);

  let passed = false;
  let maxSimilarity = 0;
  let isSubstringMatch = false;
  let matchedProp = '';

  const threshold = 0.30;

  for (const prop of properties) {
    const similarity = stringSimilarity(targetText, prop);
    const isSubstring = prop.includes(targetText) || targetText.includes(prop);

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
    }
    if (isSubstring) {
      isSubstringMatch = true;
    }

    if (similarity >= threshold || isSubstring) {
      passed = true;
      matchedProp = prop;
    }
  }

  const similarityPercent = (maxSimilarity * 100).toFixed(1);
  const thresholdPercent = (threshold * 100).toFixed(0);

  if (!passed) {
    logger.warn(`[validateOriginalLocatorSemantically] Original locator semantic validation FAILED: Max similarity was only ${similarityPercent}% (Required: ${thresholdPercent}%, SubstringMatch = ${isSubstringMatch}). Target: "${targetText}" vs Available properties: ${JSON.stringify(properties)}`);
  } else {
    logger.debug(`[validateOriginalLocatorSemantically] Original locator semantic validation PASSED: matched attribute "${matchedProp}" with ${similarityPercent}% similarity (SubstringMatch = ${isSubstringMatch}). Target: "${targetText}"`);
  }

  return passed;
}
