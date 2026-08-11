import { ScoringRule } from '../../interfaces/scoring-rule.interface';
import { OriginalElement } from '../../interfaces/original-element.interface';
import { Candidate } from '../../interfaces/candidate.interface';

/**
 * Scores candidates based on visual dimension similarity between the original element
 * and candidate bounding boxes. Applies strong negative penalties when a candidate
 * is grossly oversized compared to the original (e.g. a page container vs a button).
 *
 * Penalty tiers:
 *   - ≥10x area ratio → score = -2 (hard reject signal)
 *   - ≥5x  area ratio → score = -1 (strong penalty)
 *   - Otherwise        → 0..1 similarity scaled by effective weight
 *
 * Weight: 20 (throttled to 5 for transparent/icon elements like SVG).
 */
export class VisualSimilarityRule implements ScoringRule {
  readonly name = 'VisualSimilarityRule';
  readonly weight = 20;

  calculate(original: OriginalElement, candidate: Candidate): number {
    const origTag = (original.OrigTagName || original.LocTagName || '').toUpperCase().trim();
    const candTag = (candidate.functional.tagName || '').toUpperCase().trim();

    // Throttle weight for transparent/icon elements to prevent false positives
    const isTransparentIcon = origTag === 'SVG' || candTag === 'SVG' || candTag.includes('ICON');
    const effectiveWeight = isTransparentIcon ? 5 : this.weight;

    // ── 1. If a pre-computed pixel-level similarity exists, use it directly ──
    if (candidate.visual.similarity !== undefined && candidate.visual.similarity !== 0) {
      // Sentinel values from the visual comparison pipeline
      if (candidate.visual.similarity === -1.0 || candidate.visual.similarity === -0.5) {
        return candidate.visual.similarity * effectiveWeight;
      }
      return candidate.visual.similarity * effectiveWeight;
    }

    // ── 2. Compute dimension-based similarity from bounding box data ─────
    const origRect = original.ElementViewportRect; // [left, top, right, bottom]
    const candW = candidate.visual.boundingWidth;
    const candH = candidate.visual.boundingHeight;

    // If original dimensions are unavailable, return neutral (half weight)
    if (!origRect || !Array.isArray(origRect) || origRect.length !== 4) {
      return 0;
    }

    const origW = Math.abs(origRect[2] - origRect[0]);
    const origH = Math.abs(origRect[3] - origRect[1]);

    // If either element has zero dimensions, can't compare — neutral
    if (origW <= 0 || origH <= 0 || candW <= 0 || candH <= 0) {
      return 0;
    }

    // ── 3. Compute area ratio (candidate area / original area) ───────────
    const origArea = origW * origH;
    const candArea = candW * candH;
    const areaRatio = candArea / origArea;

    // ── 4. Apply negative penalties for grossly oversized candidates ─────
    //    A 10x area candidate is likely a page section / container
    //    A 5x area candidate is likely a parent wrapper element
    if (areaRatio >= 10) {
      // Hard reject: candidate is 10x+ larger (e.g. <body>, main container)
      candidate.visual.similarity = -1.0;
      return -2 * effectiveWeight;
    }
    if (areaRatio >= 5) {
      // Strong penalty: candidate is 5x-10x larger (e.g. parent div, card wrapper)
      candidate.visual.similarity = -0.5;
      return -1 * effectiveWeight;
    }

    // ── 5. Compute width + height similarity for normal-sized candidates ─
    //    Uses min/max ratio so shrinking is penalized equally to growing
    const widthSimilarity = Math.min(origW, candW) / Math.max(origW, candW);
    const heightSimilarity = Math.min(origH, candH) / Math.max(origH, candH);

    // Combined similarity: geometric mean of width + height match (0..1)
    const dimensionSimilarity = Math.sqrt(widthSimilarity * heightSimilarity);

    // Store the computed value for downstream consumers (VisualValidationGate, debug logs)
    candidate.visual.similarity = dimensionSimilarity;

    return dimensionSimilarity * effectiveWeight;
  }
}
