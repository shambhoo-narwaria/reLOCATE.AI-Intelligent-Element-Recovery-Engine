import { Page, Locator } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger/debug-logger';

/**
 * Pre-crops the original template image from the full screenshot and saves it to the visual-debug folder.
 */
export async function saveOriginalTemplateImage(
  page: Page,
  originalB64: string,
  originalRect: number[],
  stepIndex: number
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
        const imgOrig = await loadImage("data:image/jpeg;base64," + originalB64);
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
      const debugDir = path.join(process.cwd(), 'logs', 'visual-debug', `step-${stepIndex + 1}`);
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }
      fs.writeFileSync(path.join(debugDir, `original_template.png`), Buffer.from(origImgData, 'base64'));
    }
  } catch (err) {
    logger.warn(`[VisualUtils] Failed to pre-crop and save original template image:`, err);
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
    const box = await locator.boundingBox();
    if (!box || box.width === 0 || box.height === 0) {
      // Fallback: take screenshot without highlight
      await page.screenshot({ path: screenshotPath });
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
    }, { x: box.x, y: box.y, width: box.width, height: box.height });

    // Capture screenshot with the highlighted overlay
    await page.screenshot({ path: screenshotPath });

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
