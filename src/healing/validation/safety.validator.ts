import { Locator } from 'playwright';
import { ValidationGate } from '../../interfaces/validation-gate.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';
import { stringSimilarity } from '../../scoring/rules/similarity.helper';
import { logger } from '../../logger/debug-logger';

export class SemanticValidationGate implements ValidationGate {
  readonly name = 'SemanticValidationGate';
  constructor(private threshold: number = 0.25) {}

  validate(original: OriginalElement, candidate: Candidate): boolean {
    const origText = (original.LocText || original.OwnInnerText || original.LocTitle || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const candText = (candidate.semantic.accessibleName || candidate.semantic.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    
    if (!origText) {
      logger.debug(`[SemanticValidationGate] Candidate [ID ${candidate.candidateId}] bypassed (no original text baseline).`);
      return true; 
    }

    const similarity = stringSimilarity(origText, candText);
    const isSubstring = candText.includes(origText) || origText.includes(candText);
    
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

export class SafetyValidator {
  constructor(private gates: ValidationGate[]) {}

  validate(original: OriginalElement, candidate: Candidate): { passes: boolean; failedGates: string[] } {
    const failedGates: string[] = [];
    for (const gate of this.gates) {
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

export async function validateOriginalLocatorSemantically(element: Locator, step: OriginalElement): Promise<boolean> {
  const rawTarget = step.LocText || step.LocTitle || step.OwnInnerText || '';
  if (!rawTarget.trim()) {
    logger.debug(`[validateOriginalLocatorSemantically] Bypassing semantic validation: No target text present in step.`);
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

  const threshold = 0.25;

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

