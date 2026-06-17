import { ValidationGate } from '../../interfaces/validation-gate.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';
import { stringSimilarity } from '../../scoring/rules/similarity.helper';
import { logger } from '../../logger/debug-logger';

export class SemanticValidationGate implements ValidationGate {
  readonly name = 'SemanticValidationGate';
  constructor(private threshold: number = 0.25) {}

  validate(original: OriginalElement, candidate: Candidate): boolean {
    const origText = (original.LocText || original.ObjectName || original.accessibleName || original.OwnInnerText || original.LocTitle || '').toLowerCase().replace(/\s+/g, ' ').trim();
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
