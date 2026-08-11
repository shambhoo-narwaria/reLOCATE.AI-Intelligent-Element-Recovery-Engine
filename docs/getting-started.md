# RelocateEngine Integration Guide (Getting Started)

This guide documents how to integrate the **reLOCATE.AI** runtime element recovery engine directly into your own Playwright automation frameworks and test runners.

---

## Overview

The **`Relocator`** / **`RelocateEngine`** SDK is designed to be imported directly into your existing test runners, automation frameworks, or Page Object models.

It acts as a **Pure Standalone Element Recovery Engine**:
1. Your existing runner executes its own classical locators (`page.locator(selector)`).
2. ONLY IF all locators fail in your runner, your catch block calls `relocator.relocateElement(page, step)`.
3. `relocateElement()` executes the 2-Stage recovery pipeline (Stage 1 Fingerprint Recovery Engine + Stage 2 MCP Accessibility Recovery Engine) and returns the healed Playwright `Locator` object (`Promise<Locator>`).
4. Your runner receives the healed `Locator` and executes the action (`.click()`, `.fill()`, etc.) itself.

---

## Setup

Ensure your automation project can reference the built files. You can link the `reLOCATE.AI` project locally using `npm link` or install it directly from its directory:

```bash
# From your target automation repository
npm install /path/to/reLOCATE.AI
```

Ensure your `.env` configuration file contains your AI provider credentials (e.g., `GEMINI_API_KEY`, `OPENAI_API_KEY`, etc.).

Optionally customize recovery behavior in `config.json`:
```json
{
  "ENABLE_MCP_FALLBACK": true
}
```
* **`ENABLE_MCP_FALLBACK`**: Global flag to enable or disable Stage 2 MCP accessibility tree recovery.

---

## Integration Example

Here is an example showing how an existing runner or page object hooks `Relocator` inside its error catch block:

```typescript
import { test, expect } from '@playwright/test';
import { Relocator } from 'relocate-ai';

test.describe('Smart Client Automation', () => {
  let relocator: Relocator;

  test.beforeAll(async () => {
    // 1. Initialize the Relocator SDK once
    relocator = new Relocator({
      aiProvider: 'gemini', // 'gemini' | 'openai' | 'vllm' | 'openrouter'
    });
  });

  test('Execute action with recovery fallback', async ({ page }) => {
    await page.goto('https://stg.mayer.hdp-cicd.zeiss.com');

    let loginButton;
    const classicalSelector = 'button#login-btn-mutated-id-123';

    try {
      // 2. Runner tries classical locator first
      loginButton = page.locator(classicalSelector).first();
      await loginButton.waitFor({ state: 'visible', timeout: 2000 });
    } catch (err) {
      // 3. Classical locator failed -> Call reLOCATE.AI Recovery Engine
      console.warn(`[Runner] Selector "${classicalSelector}" failed. Calling reLOCATE.AI Recovery Engine...`);

      loginButton = await relocator.relocateElement(page, {
        LocCssSelector: classicalSelector,
        ObjectName: 'Login Button',
        Action: 'Click',
        LocTagName: 'BUTTON',
        labelText: 'Login to Mayer Portal',
        LocClassName: 'zui-btn zui-btn-primary'
      });
    }

    // 4. Runner executes click action on the returned Playwright Locator
    await loginButton.click();

    // 5. Verify outcome
    await expect(page.locator('.dashboard')).toBeVisible();
  });
});
```

---

## API Reference

### `RelocateEngine` Class

#### Constructor
```typescript
constructor(config?: RelocateConfig)
```
- **`RelocateConfig`**:
  - `aiProvider` (`'openai' | 'gemini' | 'vllm' | 'openrouter'`): The active LLM backend. Defaults to `process.env.AI_PROVIDER` (or `'gemini'`).
  - `envPath` (`string`): Custom path to your `.env` credentials file. Defaults to looking in the execution root directory.

---

### `relocateElement` Method

```typescript
async relocateElement(
  page: Page,
  originalElement: Partial<OriginalElement> & { Action: string; ObjectName?: string }
): Promise<Locator>
```

#### Parameters
1. **`page`** (`Page`): The active Playwright page instance.
2. **`originalElement`** (`OriginalElement`): The metadata describing the expected state, selectors (e.g. `LocCssSelector`), and characteristics of the element. Providing more properties increases recovery scoring accuracy.

The recovery engine categorizes these properties into three types:

### 1. Primary Properties (Provided by Developer)
These are easy to provide manually or capture when writing test cases.

| Property | Type | Description |
| :--- | :--- | :--- |
| **`Action`** *(Required)* | `string` | The action intended to be executed (e.g., `"Click"`, `"Fill"`, `"Check"`, `"Select"`). |
| `ObjectName` | `string` | Human-readable descriptor of the element (e.g., `"Submit Button"`). Used for reporting. |
| `LocTagName` | `string` | Expected HTML tag name of the element (e.g., `"BUTTON"`, `"INPUT"`, `"A"`, `"DIV"`). |
| `LocClassName` | `string` | Expected class names of the element. |
| `accessibleName` | `string` | Computed accessibility name or screen-reader title text. |
| `labelText` | `string` | Inferred text content of the element or of its associated `<label>`. |
| `NearByText` | `string[]` | List of text strings found in sibling nodes or nearby on the screen. |

### 2. Path Selectors (Provided by Developer or Recorder)
Used for nesting and shadow DOM boundary traversal.

| Property | Type | Description |
| :--- | :--- | :--- |
| `LocCssSelector` | `string` | Original recorded CSS selector path of the target element. |
| `LocXpath` | `string` | Original recorded XPath of the target element. |
| `ShadowDomHostArray` | `string[]` | Outer-to-inner selectors of host elements if the target is nested inside Shadow DOM. |
| `ShadowDomXpathArray` | `string[]` | Outer-to-inner XPaths of host elements if the target is nested inside Shadow DOM. |

### 3. Internally Inferred Properties (Automatically Resolved)
You **do not** need to provide these manually. The engine automatically infers/computes these properties from the path selectors and tag names above. However, you can optionally supply them if you want to override the default inference:

| Property | Type | Description |
| :--- | :--- | :--- |
| `role` | `string` | Inferred ARIA role (e.g. `"button"`, `"textbox"`, `"checkbox"`). *Automatically resolved from `LocTagName`*. |
| `inputType` | `string` | For `INPUT` elements, the `type` attribute value (e.g. `"text"`, `"checkbox"`). *Automatically resolved*. |
| `parentTag` | `string` | Expected HTML tag name of the direct parent. *Automatically inferred from XPath*. |
| `parentId` | `string` | Expected `id` attribute of the direct parent. *Automatically inferred from XPath/CSS*. |
| `indexInParent` | `number` | Sibling index position of the element. *Automatically inferred from XPath indices*. |
| `domDepth` | `number` | Inferred DOM tree depth level. *Automatically inferred from XPath segments*. |

#### Returns
- **`Promise<Locator>`**: Resolves to a standard Playwright `Locator` wrapping the recovered element, ready to have actions (`.click()`, `.fill()`, etc.) executed on it.
