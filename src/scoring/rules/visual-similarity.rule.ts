import { ScoringRule } from '../scoring-rule.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';

/**
 * Scores candidates based on their visual similarity index computed from screenshot comparison.
 * Weight: 20 – visual similarity is a high-confidence signal for element matching.
 */
export class VisualSimilarityRule implements ScoringRule {
  readonly name = 'VisualSimilarityRule';
  readonly weight = 20;

  calculate(original: OriginalElement, candidate: Candidate): number {
    const origTag = (original.OrigTagName || original.LocTagName || '').toUpperCase().trim();
    const candTag = (candidate.functional.tagName || '').toUpperCase().trim();

    // Transparent elements (like SVGs and Icons) cause edge-detection algorithms to capture 
    // the background color instead of the icon. If the background changes across UI updates, 
    // visual similarity produces massive false positives. 
    // We strictly throttle its weight for transparent elements to prevent them from hijacking the engine.
    const isTransparentIcon = origTag === 'SVG' || candTag === 'SVG' || candTag.includes('ICON');
    const effectiveWeight = isTransparentIcon ? 5 : this.weight;

    return (candidate.visual.similarity ?? 0) * effectiveWeight;
  }
}
