import { Page, Locator } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './debug-logger';
import { OriginalElement } from '../interfaces/original-element.interface';

export function getStepDebugDir(originalElement: OriginalElement): string {
  const stepIndex = originalElement.index !== undefined ? originalElement.index : 999;
  const action = originalElement.Action || originalElement.interactionType || 'Action';
  const stepNameClean = (originalElement.ObjectName || originalElement.LocText || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const folderName = `step-${stepIndex + 1}_${action}_${stepNameClean}`;
  const debugDir = path.join(process.cwd(), '.workspace', 'logs', 'visual-debug', folderName);
  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }
  return debugDir;
}

/**
 * Pre-crops the original template image from the full screenshot and saves it to the visual-debug folder.
 */
export async function saveOriginalTemplateImage(
  page: Page,
  originalB64: string,
  originalRect: number[],
  originalElement: OriginalElement
): Promise<void> {
  try {
    const origImgData = await page.evaluate(async ({ originalB64, originalRect }) => {
      const loadImage = (src: string): Promise<HTMLImageElement> => {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        });
      };
      try {
        const cleanSrc = originalB64.startsWith('data:') ? originalB64 : "data:image/jpeg;base64," + originalB64;
        const imgOrig = await loadImage(cleanSrc);
        const [origLeft, origTop, origRight, origBottom] = originalRect;
        const rawOrigW = origRight - origLeft;
        const rawOrigH = origBottom - origTop;
        if (rawOrigW <= 0 || rawOrigH <= 0) return null;

        const INSET_X = Math.floor(Math.min(rawOrigW * 0.1, 4));
        const INSET_Y = Math.floor(Math.min(rawOrigH * 0.1, 4));
        const origCropLeft = origLeft + INSET_X;
        const origCropTop = origTop + INSET_Y;
        const origW = rawOrigW - (INSET_X * 2);
        const origH = rawOrigH - (INSET_Y * 2);
        if (origW <= 0 || origH <= 0) return null;

        const maxDimOrig = Math.max(origW, origH);
        const scaleOrig = 256 / maxDimOrig;
        const targetW = Math.max(1, Math.round(origW * scaleOrig));
        const targetH = Math.max(1, Math.round(origH * scaleOrig));

        const canvasOrig = document.createElement('canvas');
        canvasOrig.width = targetW;
        canvasOrig.height = targetH;
        const ctxOrig = canvasOrig.getContext('2d');
        if (!ctxOrig) return null;

        ctxOrig.drawImage(imgOrig, origCropLeft, origCropTop, origW, origH, 0, 0, targetW, targetH);
        return canvasOrig.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
      } catch {
        return null;
      }
    }, { originalB64, originalRect });

    if (origImgData) {
      const debugDir = getStepDebugDir(originalElement);
      fs.writeFileSync(path.join(debugDir, `original_template.png`), Buffer.from(origImgData, 'base64'));
    }
  } catch (err) {
    logger.warn(`[VisualUtils] Failed to pre-crop and save original template image:`, err);
  }
}

/**
 * Performs in-browser edge detection and canvas cropping for visual similarity matching.
 * Uses a single cached full-viewport screenshot (no per-element loc.screenshot calls), eliminating screen flickering.
 */
export async function performVisualComparison(
  page: Page,
  originalElement: OriginalElement,
  candidates: any[]
): Promise<void> {
  const stepIndex = originalElement.index !== undefined ? originalElement.index : 999;
  const originalScreenshotB64 = originalElement.Screenshot || (originalElement as any).ScreenshotBase64;
  const originalRect = originalElement.ElementViewportRect || (originalElement as any).boundingBox;

  if (!originalScreenshotB64 || !originalRect || !Array.isArray(originalRect) || originalRect.length !== 4) {
    logger.debug(`[VisualUtils] No screenshot data available. Defaulting visual similarity to 0.`);
    candidates.forEach(c => {
      c.visual = c.visual || {};
      c.visual.similarity = 0;
    });
    return;
  }

  try {
    const topCandidates = candidates.slice(0, 10);
    logger.debug(`[VisualUtils] Comparing ${topCandidates.length} candidates using in-memory canvas edge matching...`);

    const debugDir = getStepDebugDir(originalElement);
    await saveOriginalTemplateImage(page, originalScreenshotB64, originalRect, originalElement);

    // Capture initial page viewport screenshot once — cached and reused across candidates
    let cachedScreenshotB64 = await page.screenshot({ type: 'jpeg', quality: 80 }).then(buf => buf.toString('base64')).catch(() => '');
    let cachedScroll = await page.evaluate(() => ({
      x: window.scrollX,
      y: window.scrollY,
      w: window.innerWidth,
      h: window.innerHeight
    })).catch(() => ({ x: 0, y: 0, w: 1920, h: 1080 }));

    const logLines: string[] = [
      `==================================================`,
      `VISUAL MATCH DEBUG LOG FOR STEP ${stepIndex + 1} (${originalElement.ObjectName || originalElement.Action || 'Element'})`,
      `Timestamp: ${new Date().toISOString()}`,
      `Candidate Pool Size: ${candidates.length}`,
      `==================================================\n`
    ];

    for (let i = 0; i < topCandidates.length; i++) {
      const candidate = topCandidates[i];
      const selector = candidate.functional?.cssSelector;
      if (!selector) continue;

      try {
        let loc = page.locator(selector).first();
        let isVisible = await loc.isVisible({ timeout: 500 }).catch(() => false);

        let currentRect = await loc.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        }).catch(() => null);

        let currentScreenshotB64 = cachedScreenshotB64;
        let scrollInfo = cachedScroll;

        const isInsideViewport = currentRect &&
          currentRect.left >= 0 &&
          currentRect.top >= 0 &&
          (currentRect.left + currentRect.width) <= scrollInfo.w &&
          (currentRect.top + currentRect.height) <= scrollInfo.h;

        if (!isInsideViewport && isVisible) {
          try {
            await loc.scrollIntoViewIfNeeded({ timeout: 1000 });
            await page.waitForTimeout(50);
          } catch {}

          currentRect = await loc.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
          }).catch(() => null);

          cachedScreenshotB64 = await page.screenshot({ type: 'jpeg', quality: 80 }).then(buf => buf.toString('base64')).catch(() => cachedScreenshotB64);
          cachedScroll = await page.evaluate(() => ({
            x: window.scrollX,
            y: window.scrollY,
            w: window.innerWidth,
            h: window.innerHeight
          })).catch(() => cachedScroll);
          currentScreenshotB64 = cachedScreenshotB64;
          scrollInfo = cachedScroll;
        }

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
            for (let j = 0; j < imgData.length; j += 4) {
              gray[j / 4] = 0.299 * imgData[j] + 0.587 * imgData[j + 1] + 0.114 * imgData[j + 2];
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
                edges[idx] = Math.abs(valRight - val) + Math.abs(valDown - val);
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
            const cleanOrigB64 = originalB64.startsWith('data:') ? originalB64 : "data:image/jpeg;base64," + originalB64;
            const cleanCurrB64 = currentB64.startsWith('data:') ? currentB64 : "data:image/jpeg;base64," + currentB64;
            const imgOrig = await loadImage(cleanOrigB64);
            const imgCurr = await loadImage(cleanCurrB64);

            const [origLeft, origTop, origRight, origBottom] = originalRect;
            const rawOrigW = origRight - origLeft;
            const rawOrigH = origBottom - origTop;

            if (rawOrigW <= 0 || rawOrigH <= 0 || !candRect || candRect.width <= 0 || candRect.height <= 0) {
              return { similarity: 0 };
            }

            const INSET_X = Math.floor(Math.min(rawOrigW * 0.1, 4));
            const INSET_Y = Math.floor(Math.min(rawOrigH * 0.1, 4));
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

            ctxOrig.drawImage(imgOrig, origLeft + INSET_X, origTop + INSET_Y, origW, origH, 0, 0, targetW, targetH);
            const dataOrig = ctxOrig.getImageData(0, 0, targetW, targetH).data;

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
            const candW = candBaseW - (candInsetX * 2);
            const candH = candBaseH - (candInsetY * 2);

            if (candW <= 0 || candH <= 0) return { similarity: 0 };

            ctxCand.drawImage(imgCurr, candBaseLeft + candInsetX, candBaseTop + candInsetY, candW, candH, 0, 0, targetW, targetH);
            const dataCand = ctxCand.getImageData(0, 0, targetW, targetH).data;

            const grayCand = getGrayscale(dataCand);
            const edgesCand = getEdges(grayCand, targetW, targetH);
            const blurredCand = blurEdges(edgesCand, targetW, targetH);

            let maxSimilarity = 0;
            const maxShift = 4;

            for (let oy = -maxShift; oy <= maxShift; oy++) {
              for (let ox = -maxShift; ox <= maxShift; ox++) {
                const startY = Math.max(0, -oy);
                const endY = Math.min(targetH, targetH - oy);
                const startX = Math.max(0, -ox);
                const endX = Math.min(targetW, targetW - ox);

                let sumMin = 0;
                let sumMax = 0;

                for (let y = startY; y < endY; y++) {
                  const rowOrigOffset = y * targetW;
                  const rowCandOffset = (y + oy) * targetW;
                  for (let x = startX; x < endX; x++) {
                    const o = blurredOrig[rowOrigOffset + x];
                    const c = blurredCand[rowCandOffset + (x + ox)];
                    sumMin += Math.min(o, c);
                    sumMax += Math.max(o, c);
                  }
                }

                const sim = sumMax > 0.001 ? (sumMin / sumMax) : 1.0;
                if (sim > maxSimilarity) maxSimilarity = sim;
                if (maxSimilarity >= 0.70) break;
              }
              if (maxSimilarity >= 0.70) break;
            }

            let similarity = maxSimilarity;
            const origArea = origW * origH;
            const candArea = candRect.width * candRect.height;
            if (candArea >= origArea * 10) {
              similarity = -1.0;
            } else if (candArea >= origArea * 5) {
              similarity = -0.5;
            }

            ctxCand.strokeStyle = similarity > 0.70 ? '#22CC44' : '#FF2244';
            ctxCand.lineWidth = 2;
            ctxCand.strokeRect(0, 0, targetW, targetH);

            const candImgData = canvasCand.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');

            return { similarity, candImgData };
          } catch {
            return { similarity: 0 };
          }
        }, {
          originalB64: originalScreenshotB64,
          currentB64: currentScreenshotB64,
          originalRect,
          candRect: currentRect,
          devicePixelRatio: await page.evaluate(() => window.devicePixelRatio || 1).catch(() => 1)
        });

        candidate.visual = candidate.visual || {};
        candidate.visual.similarity = result ? result.similarity : 0;

        if (result && result.candImgData) {
          const filename = `candidate_${candidate.candidateId}_score_${candidate.visual.similarity.toFixed(2)}.png`;
          saveBase64Image(path.join(debugDir, filename), result.candImgData);
        }

        const candName = candidate.semantic?.accessibleName || candidate.semantic?.text || 'unlabeled';
        logLines.push(`Candidate [ID ${candidate.candidateId}] ("${candName}"): Visual similarity = ${candidate.visual.similarity.toFixed(2)}`);
      } catch (err: any) {
        candidate.visual = candidate.visual || {};
        candidate.visual.similarity = 0;
        logLines.push(`Candidate [ID ${candidate.candidateId}]: Visual comparison error (${err.message || err})`);
      }
    }

    fs.writeFileSync(path.join(debugDir, 'visual-matches.log'), logLines.join('\n'));
    logger.debug(`[VisualUtils] Visual verification finished. Debug log saved in ${debugDir}`);
  } catch (err: any) {
    logger.warn(`[VisualUtils] Visual comparison failed: ${err.message || err}`);
  }
}

/**
 * Draws a red bounding-box highlight around the target element,
 * captures a full-page screenshot saved inside the 'report' directory,
 * and removes the highlight overlay.
 */
export async function highlightAndScreenshot(
  page: Page,
  locator: Locator,
  screenshotPath: string
): Promise<void> {
  try {
    const box = await locator.boundingBox({ timeout: 3000 }).catch(() => null);
    if (!box || box.width === 0 || box.height === 0) {
      // Fallback: take screenshot without highlight
      await page.screenshot({ path: screenshotPath }).catch(() => {});
      return;
    }

    // Inject a fixed-position overlay div
    await page.evaluate(({ x, y, width, height }: { x: number; y: number; width: number; height: number }) => {
      const existing = document.getElementById('__ai-healing-highlight__');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = '__ai-healing-highlight__';
      overlay.style.cssText = [
        'position:fixed',
        `left:${x}px`,
        `top:${y}px`,
        `width:${width}px`,
        `height:${height}px`,
        'border:3px solid #FF2244',
        'background:rgba(255,34,68,0.12)',
        'z-index:2147483647',          // max z-index
        'pointer-events:none',         // don't intercept clicks
        'box-sizing:border-box',
        'border-radius:3px',
        'transition:opacity 0.15s ease',
      ].join(';');
      document.body.appendChild(overlay);
    }, { x: box.x, y: box.y, width: box.width, height: box.height }).catch(() => {});

    // Capture screenshot with the highlighted overlay
    await page.screenshot({ path: screenshotPath }).catch(() => {});

    // Remove the highlight overlay
    await page.evaluate(() => {
      const overlay = document.getElementById('__ai-healing-highlight__');
      if (overlay) overlay.remove();
    }).catch(() => {});
  } catch (err: any) {
    logger.warn(`[VisualUtils] Failed to highlight and capture screenshot:`, err.message || err);
    // Try to capture basic screenshot as final fallback
    try {
      await page.screenshot({ path: screenshotPath });
    } catch { /* ignore */ }
  }
}

/**
 * Decodes and saves a base64 encoded image to the specified path.
 */
export function saveBase64Image(filePath: string, base64Data: string): void {
  try {
    let cleanBase64 = base64Data.trim();
    if (cleanBase64.startsWith('data:image/')) {
      cleanBase64 = cleanBase64.replace(/^data:image\/[a-z]+;base64,/, '');
    }
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, Buffer.from(cleanBase64, 'base64'));
  } catch (err: any) {
    logger.warn(`[VisualUtils] Failed to save base64 image to ${filePath}:`, err.message || err);
  }
}
