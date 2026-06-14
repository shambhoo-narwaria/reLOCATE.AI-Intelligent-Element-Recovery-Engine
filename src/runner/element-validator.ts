import { Locator } from 'playwright';

export class ElementValidator {
  async validate(element: Locator, isInput: boolean): Promise<boolean> {
    try {
      const isVisible = await element.isVisible();
      const isEnabled = await element.isEnabled();
      const isEditable = isInput ? await element.isEditable() : true;
      
      return isVisible && isEnabled && isEditable;
    } catch (err) {
      console.error('[ElementValidator] Validation threw an error:', err);
      return false;
    }
  }
}
