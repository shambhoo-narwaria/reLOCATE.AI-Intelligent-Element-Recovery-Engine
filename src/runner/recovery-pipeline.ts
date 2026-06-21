import { Locator, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { OriginalElement } from '../interfaces/original-element.interface';
import { Candidate } from '../interfaces/candidate.interface';
import { RecoveryEngine } from '../recovery-engine/recovery.engine';
import { ScoringEngine } from '../scoring/scoring.engine';
import { CandidateFinder } from './candidate-finder';
import { ElementValidator } from '../validation/element.validator';
import { StatusOverlay } from './status-overlay';
import { logger } from '../utils/debug-logger';
import { saveBase64Image, saveOriginalTemplateImage } from '../utils/visual-utils';
import { IRecoveryPipeline } from '../interfaces/recovery-pipeline.interface';
import { waitForPageSettle } from '../utils/page-stabilizer';

export class RecoveryPipeline implements IRecoveryPipeline {
  constructor(
    private recoveryEngine: RecoveryEngine,
    private candidateFinder: CandidateFinder,
    private elementValidator: ElementValidator,
    private statusOverlay: StatusOverlay
  ) {}

  // Executes the AI healing flow using DOM scraping, visual validation, and scoring engines
  async recoverElement(
    page: Page,
    step: OriginalElement,
    stepIndex: number,
    originalLocator: string
  ): Promise<{
    locator: Locator;
    oldLocator: string;
    newLocator: string;
    didHeal: boolean;
    triggeredAI: boolean;
    confidence: number;
    reason?: string;
    candidateId?: number;
    topCandidates?: any[];
  }> {
    logger.warn(`[RecoveryPipeline] Original locator failed for "${step.ObjectName}". Initializing healing...`);

    try {
      // --- Attempt 1: Full healing cycle ---
      const firstAttempt = await this.runHealingCycle(page, step, stepIndex);

      // If validation passed on first attempt, return immediately
      if (firstAttempt.validationPassed) {
        await this.statusOverlay.show(page, 'COMPLETE');
        await page.waitForTimeout(1000).catch(() => { });

        return {
          locator: firstAttempt.locator,
          oldLocator: originalLocator,
          newLocator: firstAttempt.healResult.healedLocator,
          didHeal: true,
          triggeredAI: firstAttempt.healResult.triggeredAI,
          confidence: firstAttempt.healResult.confidence,
          reason: firstAttempt.healResult.reason,
          candidateId: firstAttempt.healResult.candidateId,
          topCandidates: firstAttempt.topCandidates
        };
      }

      // --- Attempt 2: Validation failed — re-run full healing cycle from scratch ---
      console.warn(`[RecoveryPipeline] Validation failed on first healing attempt for "${step.ObjectName}". Re-running full healing cycle...`);
      try {
        await waitForPageSettle(page, 10000);
      } catch { /* page may be closed */ }

      let secondAttempt;
      try {
        secondAttempt = await this.runHealingCycle(page, step, stepIndex);
      } catch (retryErr: any) {
        // Second healing cycle itself failed — fall back to first attempt's element
        console.warn(`[RecoveryPipeline] Re-healing cycle failed: ${retryErr.message || retryErr}. Proceeding with first attempt's element anyway.`);
        await this.statusOverlay.show(page, 'COMPLETE').catch(() => {});
        return {
          locator: firstAttempt.locator,
          oldLocator: originalLocator,
          newLocator: firstAttempt.healResult.healedLocator,
          didHeal: true,
          triggeredAI: firstAttempt.healResult.triggeredAI,
          confidence: firstAttempt.healResult.confidence,
          reason: firstAttempt.healResult.reason + ' (validation failed, re-healing also failed)',
          candidateId: firstAttempt.healResult.candidateId,
          topCandidates: firstAttempt.topCandidates
        };
      }

      if (!secondAttempt.validationPassed) {
        console.warn(`[RecoveryPipeline] Validation failed on second healing attempt for "${step.ObjectName}". Proceeding with action anyway.`);
      }

      await this.statusOverlay.show(page, 'COMPLETE').catch(() => {});
      await page.waitForTimeout(1000).catch(() => { });

      return {
        locator: secondAttempt.locator,
        oldLocator: originalLocator,
        newLocator: secondAttempt.healResult.healedLocator,
        didHeal: true,
        triggeredAI: secondAttempt.healResult.triggeredAI,
        confidence: secondAttempt.healResult.confidence,
        reason: secondAttempt.healResult.reason + (secondAttempt.validationPassed ? '' : ' (validation failed, proceeding anyway)'),
        candidateId: secondAttempt.healResult.candidateId,
        topCandidates: secondAttempt.topCandidates
      };
    } catch (err) {
      try {
        await this.statusOverlay.show(page, 'FAILED');
        await page.waitForTimeout(2000).catch(() => { });
      } catch { /* ignore */ }
      try {
        await this.statusOverlay.hide(page);
      } catch { /* ignore */ }
      throw err;
    }
  }

  // Scrapes DOM candidates with loading-state retries and tag filters
  private async scrapeAndFilterCandidates(page: Page, step: OriginalElement): Promise<Candidate[]> {
    const consoleListener = (msg: any) => {
      if (msg.text().includes('[CandidateFinder]')) {
        logger.debug(msg.text());
      }
    };
    page.on('console', consoleListener);

    await this.statusOverlay.show(page, 'SCRAPE');
    let candidates = await this.safeFindCandidates(page, step.OrigTagName?.toUpperCase() === 'SLOT' ? undefined : step.OrigTagName);

    page.removeListener('console', consoleListener);

    const SHADOW_INTERNAL_ID_KEYWORDS = ['slot', 'wrapper', 'placeholder', 'container', 'inner'];
    const isInternalById = (id: string) => id.length > 0 && SHADOW_INTERNAL_ID_KEYWORDS.some(kw => id.includes(kw));

    candidates = candidates.filter(c => {
      const testId = (c.functional.dataTestId || '').toLowerCase();
      const css = (c.functional.cssSelector || '').toLowerCase();
      const id = (c.functional.id || '').toLowerCase();

      if (testId.includes('skeleton')) return false;
      if (css.includes('skeleton')) return false;

      if (isInternalById(id) && !c.functional.dataTestId && !c.semantic.text && !c.semantic.accessibleName && !c.functional.role) return false;

      const PLAIN_WRAPPER_CLASSES = /^div\.(content|checkbox-container|inner|layout|col|row|cell|wrapper|container|grid|main)$/;
      if (PLAIN_WRAPPER_CLASSES.test(css) && !c.functional.id && !c.functional.dataTestId && !c.semantic.text) return false;

      return true;
    });
    console.log(`[RecoveryPipeline] Candidates after internal-element filter: ${candidates.length}`);

    const ROOT_IDS = new Set(['app', 'root', 'main', 'body', '__next', 'application']);
    const isLoadingStateDom = (cands: typeof candidates): boolean => {
      if (cands.length === 0) return false;
      const hasAnyMeaningful = cands.some(c =>
        c.semantic.text ||
        c.functional.role ||
        c.functional.dataTestId ||
        c.functional.dataQa ||
        c.functional.dataCy ||
        (c.functional.id && !ROOT_IDS.has(c.functional.id.toLowerCase()))
      );
      const hasCssHash = cands.some(c =>
        /\.(sc-|css-)[a-zA-Z0-9]+/.test(c.functional.cssSelector || '')
      );
      return !hasAnyMeaningful && hasCssHash;
    };

    let retries = 15;
    while ((candidates.length === 0 || isLoadingStateDom(candidates)) && retries > 0) {
      const reason = candidates.length === 0 ? '0 candidates (waiting for skeleton/loading to settle)' : 'page still in loading-state (CSS-in-JS hashes only)';
      console.log(`[RecoveryPipeline] ${reason}. Retrying in 2000ms... (${retries} retries left)`);
      
      // Update status overlay progress (from attempt 1 to 15)
      await this.statusOverlay.show(page, 'SCRAPE', { current: 16 - retries, total: 15 });
      
      await page.waitForTimeout(2000);
      candidates = await this.safeFindCandidates(page, step.OrigTagName?.toUpperCase() === 'SLOT' ? undefined : step.OrigTagName);
      candidates = candidates.filter(c => {
        const testId = (c.functional.dataTestId || '').toLowerCase();
        const css = (c.functional.cssSelector || '').toLowerCase();
        const id = (c.functional.id || '').toLowerCase();
        if (testId.includes('skeleton') || css.includes('skeleton')) return false;
        if (isInternalById(id) && !c.functional.dataTestId && !c.semantic.text && !c.semantic.accessibleName && !c.functional.role) return false;
        return true;
      });
      retries--;
    }

    if (step.OrigTagName && step.OrigTagName.toUpperCase() !== 'SLOT') {
      const origTagUpper = step.OrigTagName.toUpperCase();
      const sameTagCandidates = candidates.filter(c => c.functional.tagName.toUpperCase() === origTagUpper);
      if (sameTagCandidates.length > 0) {
        logger.debug(`[RecoveryPipeline] Tag filter: restricting ${candidates.length} → ${sameTagCandidates.length} candidates with tagName="${origTagUpper}"`);
        candidates = sameTagCandidates;
      } else {
        logger.debug(`[RecoveryPipeline] Tag filter: no candidates with tagName="${origTagUpper}" found — keeping full pool of ${candidates.length}`);
      }
    }

    return candidates;
  }

  // Prunes candidate elements based on text & selector keywords down to a budget of maxLimit elements
  private pruneCandidatesByRelevance(step: OriginalElement, candidates: Candidate[], maxLimit = 70): Candidate[] {
    if (candidates.length <= maxLimit) {
      return candidates;
    }

    const resolvedName = (step.LocText || step.LocTitle || step.OwnInnerText || '').trim();
    const objectWords = resolvedName.toLowerCase().split(/\W+/).filter(Boolean);
    const nearbyWords = (step.NearByText || step.nearbyText || []).slice(0, 4).join(' ').toLowerCase().split(/\W+/).filter(Boolean);
    const classWords = (step.LocClassName || '').toLowerCase().split(/\W+/).filter(Boolean);

    const allKeywords = [...new Set([...objectWords, ...nearbyWords, ...classWords])];

    const origHostTagSet = new Set<string>(
      (step.ShadowDomHostArray || []).flatMap((sel: string) =>
        sel.split(/[\s>+~]+/).map((p: string) => {
          const m = p.match(/^([a-zA-Z0-9-]+)/);
          return m ? m[1].toUpperCase() : '';
        }).filter(Boolean)
      )
    );

    const origTailTags: string[] = [];
    if (step.LocCssSelector) {
      const parts = step.LocCssSelector.split('>');
      for (let i = parts.length - 1; i >= 0; i--) {
        const match = parts[i].trim().match(/^([a-zA-Z0-9-]+)/);
        if (match) {
          origTailTags.push(match[1].toUpperCase());
        }
      }
    }

    const scored = candidates.map(c => {
      const haystack = [
        c.semantic.text,
        c.semantic.accessibleName,
        c.functional.cssSelector,
        c.functional.className,
        c.functional.dataTestId,
        c.functional.id,
        c.functional.ariaLabel,
        c.ancestorContext.parentText,
      ].join(' ').toLowerCase();

      let hits = allKeywords.filter(kw => haystack.includes(kw)).length;

      if (step.LocText && c.semantic.text) {
        const targetLen = step.LocText.length;
        const candLen = c.semantic.text.length;
        const textLower = c.semantic.text.toLowerCase();
        const targetLower = step.LocText.toLowerCase();

        if (textLower.includes(targetLower) || (c.semantic.accessibleName && c.semantic.accessibleName.toLowerCase().includes(targetLower))) {
          hits += 5;
          const lenDiff = Math.abs(candLen - targetLen);
          if (lenDiff <= 5) hits += 30;
          else if (lenDiff <= 20) hits += 15;
        }
      }

      if (step.LocClassName && c.functional.className) {
        const classLower = c.functional.className.toLowerCase();
        const targetClassLower = step.LocClassName.toLowerCase();
        if (classLower.includes(targetClassLower)) {
          hits += 5;
          const lenDiff = Math.abs(classLower.length - targetClassLower.length);
          if (lenDiff <= 5) hits += 20;
        }
      }

      if (origTailTags.length > 1 && c.ancestorContext && c.ancestorContext.ancestorTagNames) {
        const candAncestors = c.ancestorContext.ancestorTagNames;
        let tailMatches = 0;
        const maxDepthToCheck = Math.min(4, origTailTags.length - 1);
        for (let i = 0; i < maxDepthToCheck; i++) {
          if (candAncestors.length > i && candAncestors[i] === origTailTags[i + 1]) {
            tailMatches++;
            hits += 5;
          } else {
            break;
          }
        }
        if (tailMatches === maxDepthToCheck && tailMatches > 0) {
          hits += 15;
        }
      }

      const candChain = c.ancestorContext.shadowHostChain || [];
      let hostOverlap = 0;
      if (origHostTagSet.size > 0 && candChain.length > 0) {
        for (const tag of candChain) {
          if (origHostTagSet.has(tag)) hostOverlap++;
        }
      }
      const hostScore = origHostTagSet.size > 0 ? (hostOverlap / origHostTagSet.size) * 8 : 0;

      return { c, score: hits + hostScore };
    });

    scored.sort((a, b) => b.score - a.score || a.c.candidateId - b.c.candidateId);
    const pruned = scored.slice(0, maxLimit).map(s => s.c);
    logger.debug(`[RecoveryPipeline] Relevance cap applied: kept top ${pruned.length} of ${scored.length} candidates (keywords: [${allKeywords.slice(0, 8).join(', ')}])`);
    return pruned;
  }

  // Sequentially checks visual templates and screenshots to calculate edge similarity
  private async performVisualVerification(
    page: Page,
    step: OriginalElement,
    stepIndex: number,
    candidates: Candidate[]
  ): Promise<void> {
    if (!step.Screenshot || !step.ElementViewportRect || !Array.isArray(step.ElementViewportRect) || step.ElementViewportRect.length !== 4) {
      console.log(`[RecoveryPipeline] Step has no recorded Screenshot/ElementViewportRect data. Defaulting to neutral visual similarity.`);
      candidates.forEach(c => {
        c.visual.similarity = 0;
      });
      return;
    }

    console.log(`[RecoveryPipeline] Initializing visual verification matching...`);
    try {
      const tagFilteredCandidates = this.getFilteredCandidates(step, candidates);
      console.log(`[RecoveryPipeline] Restricting visual comparison to ${tagFilteredCandidates.length} tag-matched candidates (out of ${candidates.length} total).`);

      const structuralRules = this.recoveryEngine.scoringEngine.rules.filter(r => r.name !== 'VisualSimilarityRule');
      const tempEngine = new ScoringEngine(structuralRules);
      const preScored = tempEngine.scoreCandidates(step, tagFilteredCandidates);
      const topCandidates = preScored.slice(0, 20).map(item => item.candidate);
      logger.debug(`[RecoveryPipeline] Pre-scored tag-matched candidates. Verifying top ${topCandidates.length} sequentially with scroll-into-view.`);

      const similarities: any[] = [];
      const originalScreenshotB64 = step.Screenshot;
      const originalRect = step.ElementViewportRect;

      await saveOriginalTemplateImage(page, originalScreenshotB64, originalRect, stepIndex);

      for (const c of topCandidates) {
        const index = topCandidates.indexOf(c) + 1;
        const result = await this.compareCandidateVisually(page, c, originalScreenshotB64, originalRect, index, topCandidates.length);
        similarities.push(result);
      }

      const similarityMap = new Map<number, number>(similarities.map(s => [s.candidateId, s.similarity]));
      candidates.forEach(c => {
        c.visual.similarity = similarityMap.get(c.candidateId) ?? 0;
      });

      const debugDir = path.join(process.cwd(), 'logs', 'visual-debug', `step-${stepIndex + 1}`);
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }

      const firstWithImg = similarities.find(s => s.origImgData);
      if (firstWithImg) {
        saveBase64Image(path.join(debugDir, `original_template.png`), firstWithImg.origImgData);
      }

      similarities.forEach(s => {
        if (s.candImgData) {
          const fileName = `candidate_${s.candidateId}_score_${s.similarity.toFixed(2)}.png`;
          saveBase64Image(path.join(debugDir, fileName), s.candImgData);
        }
      });

      console.log(`[RecoveryPipeline] Visual verification scores mapped to candidate pool and logged under logs/visual-debug/step-${stepIndex + 1}/`);
    } catch (err) {
      console.warn(`[RecoveryPipeline] Visual comparison failed, defaulting to neutral visual similarity scores.`, err);
      candidates.forEach(c => {
        c.visual.similarity = 0;
      });
    }
  }

  // Visual edge-detection comparison executing in the Playwright Page context
  private async compareCandidateVisually(
    page: Page,
    c: Candidate,
    originalScreenshotB64: string,
    originalRect: number[],
    index: number,
    total: number
  ): Promise<{ candidateId: number; similarity: number; origImgData?: string; candImgData?: string }> {
    await this.statusOverlay.show(page, 'VISUAL', { current: index, total });
    try {
      let locator = page.locator(`[data-ai-healed-id="${c.candidateId}"]`).first();
      let isVisible = await locator.isVisible();

      if (!isVisible && c.functional.cssSelector) {
        const fallbackLoc = page.locator(c.functional.cssSelector).first();
        if (await fallbackLoc.count() > 0 && await fallbackLoc.isVisible()) {
          try {
            await fallbackLoc.evaluate((el, id) => {
              el.setAttribute('data-ai-healed-id', id);
            }, String(c.candidateId));
            locator = fallbackLoc;
            isVisible = true;
            logger.debug(`[RecoveryPipeline] Recovered visibility for candidate ${c.candidateId} (${c.functional.tagName}) by re-stamping CSS selector.`);
          } catch (err: any) { }
        }
      }

      const forceZeroScore = !isVisible;

      try {
        await locator.scrollIntoViewIfNeeded({ timeout: 1000 });
        await page.waitForTimeout(100);
      } catch (err: any) { }

      const currentRect = await locator.evaluate((el) => {
        const getElementRectWithFallback = (element: Element): DOMRect => {
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return rect;
          const slots = element.tagName.toLowerCase() === 'slot' ? [element] : Array.from(element.querySelectorAll('slot'));
          for (const slot of slots) {
            if (typeof (slot as any).assignedNodes === 'function') {
              const assigned = (slot as HTMLSlotElement).assignedNodes({ flatten: true });
              for (const node of assigned) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                  const r = (node as Element).getBoundingClientRect();
                  if (r.width > 0 && r.height > 0) return r;
                }
              }
            }
          }
          for (const child of Array.from(element.children)) {
            const r = getElementRectWithFallback(child);
            if (r.width > 0 && r.height > 0) return r;
          }
          if (element.shadowRoot) {
            for (const child of Array.from(element.shadowRoot.children)) {
              const r = getElementRectWithFallback(child);
              if (r.width > 0 && r.height > 0) return r;
            }
          }
          return rect;
        };

        const rect = getElementRectWithFallback(el);
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        };
      }).catch(() => null);

      await this.statusOverlay.show(page, 'VISUAL', { current: index, total, candidateRect: currentRect });

      const currentScreenshotB64 = await page.screenshot({ type: 'jpeg', quality: 80 }).then(buf => buf.toString('base64'));

      const result = await page.evaluate(async ({ originalB64, currentB64, originalRect, candRect, devicePixelRatio }) => {
        const loadImage = (src: string): Promise<HTMLImageElement> => {
          return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
          });
        };

        const getGrayscale = (imgData: Uint8ClampedArray): Float32Array => {
          const gray = new Float32Array(imgData.length / 4);
          for (let i = 0; i < imgData.length; i += 4) {
            gray[i / 4] = 0.299 * imgData[i] + 0.587 * imgData[i + 1] + 0.114 * imgData[i + 2];
          }
          return gray;
        };

        const getEdges = (gray: Float32Array, w: number, h: number): Float32Array => {
          const edges = new Float32Array(w * h);
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const idx = y * w + x;
              const val = gray[idx];
              const valRight = (x < w - 1) ? gray[idx + 1] : val;
              const valDown = (y < h - 1) ? gray[idx + w] : val;
              const dx = valRight - val;
              const dy = valDown - val;
              edges[idx] = Math.abs(dx) + Math.abs(dy);
            }
          }
          return edges;
        };

        const blurEdges = (edges: Float32Array, w: number, h: number): Float32Array => {
          const blurred = new Float32Array(w * h);
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              let sum = 0;
              let count = 0;
              for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                  const nx = x + dx;
                  if (nx < 0 || nx >= w) continue;
                  sum += edges[ny * w + nx];
                  count++;
                }
              }
              blurred[y * w + x] = sum / count;
            }
          }
          return blurred;
        };

        try {
          const imgOrig = await loadImage("data:image/jpeg;base64," + originalB64);
          const imgCurr = await loadImage("data:image/jpeg;base64," + currentB64);

          const [origLeft, origTop, origRight, origBottom] = originalRect;
          const rawOrigW = origRight - origLeft;
          const rawOrigH = origBottom - origTop;

          if (rawOrigW <= 0 || rawOrigH <= 0) return { similarity: 0 };
          if (!candRect || candRect.width <= 0 || candRect.height <= 0) return { similarity: 0 };

          const INSET_X = Math.floor(Math.min(rawOrigW * 0.1, 4));
          const INSET_Y = Math.floor(Math.min(rawOrigH * 0.1, 4));

          const origCropLeft = origLeft + INSET_X;
          const origCropTop = origTop + INSET_Y;
          const origW = rawOrigW - (INSET_X * 2);
          const origH = rawOrigH - (INSET_Y * 2);

          if (origW <= 0 || origH <= 0) return { similarity: 0 };

          const maxDimOrig = Math.max(origW, origH);
          const scaleOrig = 256 / maxDimOrig;
          const targetW = Math.max(1, Math.round(origW * scaleOrig));
          const targetH = Math.max(1, Math.round(origH * scaleOrig));

          const canvasOrig = document.createElement('canvas');
          canvasOrig.width = targetW;
          canvasOrig.height = targetH;
          const ctxOrig = canvasOrig.getContext('2d');
          if (!ctxOrig) return { similarity: 0 };

          ctxOrig.drawImage(imgOrig, origCropLeft, origCropTop, origW, origH, 0, 0, targetW, targetH);
          const dataOrig = ctxOrig.getImageData(0, 0, targetW, targetH).data;
          const origImgData = canvasOrig.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');

          const grayOrig = getGrayscale(dataOrig);
          const edgesOrig = getEdges(grayOrig, targetW, targetH);
          const blurredOrig = blurEdges(edgesOrig, targetW, targetH);

          const canvasCand = document.createElement('canvas');
          canvasCand.width = targetW;
          canvasCand.height = targetH;
          const ctxCand = canvasCand.getContext('2d');
          if (!ctxCand) return { similarity: 0 };

          const candBaseLeft = candRect.left * devicePixelRatio;
          const candBaseTop = candRect.top * devicePixelRatio;
          const candBaseW = candRect.width * devicePixelRatio;
          const candBaseH = candRect.height * devicePixelRatio;

          const candInsetX = (INSET_X / rawOrigW) * candBaseW;
          const candInsetY = (INSET_Y / rawOrigH) * candBaseH;

          const candLeft = candBaseLeft + candInsetX;
          const candTop = candBaseTop + candInsetY;
          const candW = candBaseW - (candInsetX * 2);
          const candH = candBaseH - (candInsetY * 2);

          if (candW <= 0 || candH <= 0) return { similarity: 0 };

          const scaledW = candW * scaleOrig;
          const scaledH = candH * scaleOrig;
          const dx = (targetW - scaledW) / 2;
          const dy = (targetH - scaledH) / 2;

          ctxCand.drawImage(imgCurr, candLeft, candTop, candW, candH, dx, dy, scaledW, scaledH);
          const dataCand = ctxCand.getImageData(0, 0, targetW, targetH).data;

          const grayCand = getGrayscale(dataCand);
          const edgesCand = getEdges(grayCand, targetW, targetH);
          const blurredCand = blurEdges(edgesCand, targetW, targetH);

          let sumMin = 0;
          let sumMax = 0;
          for (let i = 0; i < blurredOrig.length; i++) {
            const o = blurredOrig[i];
            const c = blurredCand[i];
            sumMin += Math.min(o, c);
            sumMax += Math.max(o, c);
          }

          let similarity = sumMax > 0.001 ? (sumMin / sumMax) : 1.0;

          const origArea = origW * origH;
          const candArea = candRect.width * candRect.height;
          if (candArea >= origArea * 10) {
            similarity = -1.0;
          }

          if (similarity > 0.70) {
            ctxCand.strokeStyle = '#22CC44';
          } else {
            ctxCand.strokeStyle = '#FF2244';
          }
          ctxCand.lineWidth = 2;
          ctxCand.strokeRect(0, 0, targetW, targetH);

          const candImgData = canvasCand.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');

          return {
            similarity,
            origImgData,
            candImgData
          };
        } catch (err) {
          console.error('Image loading/processing failed:', err);
          return { similarity: 0 };
        }
      }, {
        originalB64: originalScreenshotB64,
        currentB64: currentScreenshotB64,
        originalRect: originalRect,
        candRect: currentRect,
        devicePixelRatio: await page.evaluate(() => window.devicePixelRatio || 1)
      });

      if (result && typeof result === 'object') {
        return {
          candidateId: c.candidateId,
          similarity: forceZeroScore ? 0 : result.similarity,
          origImgData: result.origImgData,
          candImgData: result.candImgData
        };
      }
      return { candidateId: c.candidateId, similarity: 0 };
    } catch (err) {
      console.warn(`[RecoveryPipeline] Visual comparison failed for candidate ${c.candidateId}, defaulting to 0 similarity.`, err);
      return { candidateId: c.candidateId, similarity: 0 };
    }
  }

  /**
   * Runs a single full healing cycle: stabilize → scrape → prune → visual verify → score → resolve → validate.
   */
  private async runHealingCycle(
    page: Page,
    step: OriginalElement,
    stepIndex: number
  ): Promise<{ locator: Locator; healResult: any; topCandidates: any[]; validationPassed: boolean }> {
    await this.statusOverlay.show(page, 'STABILIZE');
    logger.debug(`[RecoveryPipeline] Ensuring page is fully loaded before creating AI payload...`);
    
    // Wait for 3 seconds before starting the healing cycle / candidate scraping
    console.log(`[RecoveryPipeline] Waiting 3 seconds to let layout settle before starting candidate scraping...`);
    try {
      await page.waitForTimeout(3000);
    } catch { /* page closed */ }

    await waitForPageSettle(page, 30000);

    // Scrape DOM and filter loading states/skeletons/internal elements
    let candidates = await this.scrapeAndFilterCandidates(page, step);

    // Prune candidate pool based on text and structure relevance to fit budget limit
    await this.statusOverlay.show(page, 'PRUNE');
    candidates = this.pruneCandidatesByRelevance(step, candidates);

    // Execute sequential visual template match scoring if template screenshots are available
    await this.performVisualVerification(page, step, stepIndex, candidates);

    await this.statusOverlay.show(page, 'SAFETY');

    // Trigger recovery engine healing rule compilation
    const healResult = await this.recoveryEngine.heal(step, candidates, async (phase) => {
      await this.statusOverlay.show(page, phase);
    });

    // Resolve Playwright locator and perform post-healing actionability validation
    const { locator: healedEl, validationPassed } = await this.resolveAndValidateHealedLocator(page, step, healResult);

    const topCandidates = this.getTopCandidatesForReport(step, candidates);

    return { locator: healedEl, healResult, topCandidates, validationPassed };
  }

  // Resolves healed locator fallback details and validates actionability gates
  private async resolveAndValidateHealedLocator(page: Page, step: OriginalElement, healResult: any): Promise<{ locator: Locator; validationPassed: boolean }> {
    let healedEl: Locator;
    const cssLocator = page.locator(healResult.healedLocator).first();
    let cssVisible = false;
    try {
      cssVisible = await cssLocator.isVisible({ timeout: 500 });
    } catch { }

    if (cssVisible) {
      healedEl = cssLocator;
    } else {
      if (healResult.candidateId !== undefined) {
        console.warn(`[RecoveryPipeline] Healed CSS locator "${healResult.healedLocator}" not visible or detached. Falling back to custom attribute [data-ai-healed-id="${healResult.candidateId}"]`);
        healedEl = page.locator(`[data-ai-healed-id="${healResult.candidateId}"]`).first();
      } else {
        healedEl = cssLocator;
      }
    }
    try {
      await healedEl.scrollIntoViewIfNeeded({ timeout: 3000 });
    } catch (err: any) {
      console.warn(`[RecoveryPipeline] Failed to scroll element "${healResult.healedLocator}" into view:`, err.message || err);
    }

    // Actionability validation with one retry after 5s wait
    let validationPassed = false;
    try {
      await this.statusOverlay.show(page, 'VALIDATE');
      validationPassed = await this.elementValidator.validate(healedEl, step.Action === 'Enter');

      if (!validationPassed) {
        console.warn(`[RecoveryPipeline] Healed element "${healResult.healedLocator}" failed initial validation. Waiting 5s and retrying...`);
        try {
          await page.waitForTimeout(5000);
        } catch { /* page may be closed, ignore */ }
        validationPassed = await this.elementValidator.validate(healedEl, step.Action === 'Enter');
      }

      if (!validationPassed) {
        console.warn(`[RecoveryPipeline] Healed element "${healResult.healedLocator}" failed actionability validation after retry.`);
      }
    } catch (validationErr: any) {
      console.warn(`[RecoveryPipeline] Validation encountered an error: ${validationErr.message || validationErr}.`);
      validationPassed = false;
    }

    return { locator: healedEl, validationPassed };
  }

  // Generates scored list of candidates for HTML report mapping
  private getTopCandidatesForReport(step: OriginalElement, candidates: Candidate[]): any[] {
    try {
      const scoredPool = this.recoveryEngine.scoringEngine.scoreCandidates(step, candidates);
      return scoredPool.slice(0, 5).map(item => ({
        candidateId: item.candidate.candidateId,
        tagName: item.candidate.functional.tagName,
        cssSelector: item.candidate.functional.cssSelector,
        text: item.candidate.semantic.accessibleName || item.candidate.semantic.text || '',
        score: item.score,
        ruleScores: item.ruleScores
      }));
    } catch (scoreErr) {
      console.warn(`[RecoveryPipeline] Failed to retrieve candidate scores for report:`, scoreErr);
      return [];
    }
  }

  // Scrapes DOM candidates with retry handling in case of sudden page navigation
  private async safeFindCandidates(page: Page, tagName?: string): Promise<Candidate[]> {
    let retries = 3;
    while (retries > 0) {
      try {
        if (page.isClosed()) {
          return [];
        }
        return await this.candidateFinder.findCandidates(page, tagName);
      } catch (err: any) {
        retries--;
        const msg = err?.message || String(err);
        const isNavErr = msg.includes('context was destroyed') || msg.includes('navigation') || msg.includes('navigated') || msg.includes('closed') || msg.includes('detached') || msg.includes('stale') || msg.includes('Target page, context or browser has been closed');

        if (retries > 0 && isNavErr) {
          console.warn(`[RecoveryPipeline] findCandidates failed due to navigation/context destruction: ${msg}. Waiting 8s for page layout to settle and retrying (${retries} retries left)...`);
          await this.statusOverlay.show(page, 'STABILIZE');
          await waitForPageSettle(page, 8000);
          await this.statusOverlay.show(page, 'SCRAPE');
          continue;
        }
        console.error(`[RecoveryPipeline] findCandidates encountered a fatal or unrecoverable error:`, err);
        throw err;
      }
    }
    return [];
  }

  // Filters candidate elements by tag name and input type to speed up visual comparison
  private getFilteredCandidates(step: OriginalElement, candidates: Candidate[]): Candidate[] {
    const origTag = (step.OrigTagName || '').toUpperCase().trim();
    const shadowHostTagsSet = new Set<string>();

    (step.ShadowDomHostArray || []).forEach((sel: string) => {
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

    (step.ShadowDomFullXpathArray || []).forEach((xpath: string) => {
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
      }
    }

    if (origTag === 'INPUT' && step.inputType) {
      const origInputType = step.inputType.toLowerCase().trim();
      const inputTypeFiltered = pool.filter(
        c => (c.functional.inputType || '').toLowerCase() === origInputType
      );
      if (inputTypeFiltered.length > 0) {
        pool = inputTypeFiltered;
      }
    }

    return pool;
  }
}
