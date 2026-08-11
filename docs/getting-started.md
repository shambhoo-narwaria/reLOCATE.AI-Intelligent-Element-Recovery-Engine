# RelocateEngine Integration Guide (Getting Started)

This guide documents how to integrate the **reLOCATE.AI** runtime element recovery engine directly into your own Playwright automation frameworks and test runners.

---

## Overview

Unlike standalone test runners, the **`RelocateEngine`** is designed to be imported directly as an SDK inside your test files. It is typically invoked inside a `try-catch` block (on locator failure) or to wrap critical selector statements: when called, it immediately executes the element recovery pipeline. It crawls the DOM, ranks candidate elements, uses visual similarity scoring, and falls back to LLMs to dynamically locate the correct element of interest at runtime.

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
  "ENABLE_MCP_FALLBACK": true,
  "FORCE_MCP_STEP": ""
}
```
* **`ENABLE_MCP_FALLBACK`**: Global flag to enable or disable Tier 3 Pure MCP accessibility tree recovery.
* **`FORCE_MCP_STEP`**: Force Tier 3 MCP fallback directly for a specific step index (e.g., `"1"`, `"2"`, or `"all"`).

---

## Integration Example

Here is a standard Playwright test showing how to initialize `RelocateEngine` and run locator queries through the recovery logic:

```typescript
import { test, expect } from '@playwright/test';
import { RelocateEngine } from 'relocate-ai';

test.describe('Smart Client Login Test', () => {
  let relocate: RelocateEngine;

  test.beforeAll(async () => {
    // 1. Initialize the RelocateEngine (loads env paths & boots up AI scoring engines)
    relocate = new RelocateEngine({
      aiProvider: 'gemini', // 'gemini' | 'openai' | 'vllm' | 'openrouter'
    });
  });

  test('Execute action with element recovery', async ({ page }) => {
    await page.goto('https://stg.mayer.hdp-cicd.zeiss.com');

    // 2. Relocate element dynamically (checks selector first, recovers if failed)
    const loginButton = await relocate.relocateElement(page, {
      LocCssSelector: 'button#login-btn-mutated-id-123',
      ObjectName: 'Login Button',
      Action: 'Click',
      LocTagName: 'BUTTON',
      accessibleName: 'Login',
      labelText: 'Login to Mayer Portal',
      LocClassName: 'zui-btn zui-btn-primary'
    });

    // 3. Execute the click action on the resolved Playwright Locator
    await loginButton.click();

    // 4. Verify outcome
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
