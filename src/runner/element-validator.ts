import { Locator } from 'playwright';

export class ElementValidator {
  async validate(element: Locator, isInput: boolean): Promise<boolean> {
    try {
      const isVisible = await element.isVisible();
      const isEnabled = await element.isEnabled({ timeout: 6000 });
      const isEditable = isInput ? await element.isEditable({ timeout: 6000 }) : true;
      
      return isVisible && isEnabled && isEditable;
    } catch (err) {
      console.error('[ElementValidator] Validation threw an error:', err);
      return false;
    }
  }
}
