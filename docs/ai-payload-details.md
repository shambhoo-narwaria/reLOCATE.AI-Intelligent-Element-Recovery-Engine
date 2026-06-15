# RelocateAI: AI Request Payload & Schema Details

This document explains the structural payload and JSON schema utilized when interacting with the AI Reasoning Layer. It defines what metadata is sent regarding the **Object of Interest** (the broken element) and the **Candidate Pool** (extracted page elements).

---

## 1. Request Payload Overview

To optimize token usage, minimize API latency, and avoid LLM confusion, all raw DOM and testcase properties are passed through a **pre-filter and cleaning processor** (`cleanObject`). This processor removes:
*   Falsy boolean states (e.g., `false`).
*   Empty string tags, titles, or descriptions.
*   `null` and `undefined` properties.
*   Empty arrays.

The final request payload sent to the LLM is structured into two main components:
1.  **Original Element Metadata** (the Object of Interest).
2.  **Candidate Pool** (a collection of potential target elements on the current page).

---

## 2. The Object of Interest (Original Element)

This object describes the element as it was originally recorded during the testcase creation. It provides the reference properties that the AI tries to match.

| Field Name | Type | Description / Usecase |
| :--- | :---: | :--- |
| `objectName` | `string` | The logical, human-readable name of the element assigned during recording (e.g. `"Today’s patients"`, `"Settings"`). |
| `tagName` | `string` | The recorded HTML element tag (e.g., `SLOT`, `BUTTON`, `DIV`). |
| `id` | `string` | The element's recorded ID attribute (if it had one). |
| `name` | `string` | The element's recorded name attribute (e.g. for inputs). |
| `role` | `string` | The recorded ARIA role of the element (e.g. `checkbox`, `combobox`). |
| `inputType` | `string` | The HTML input type (e.g. `text`, `password`, `email`) if the tag is an input. |
| `interactionType` | `string` | The action being performed (`Click`, `Enter`, `Navigate`). |
| `accessibleName` | `string` | The computed text label of the element at recording time. |
| `labelText` | `string` | The text of any associated `<label>` tag. |
| `parentTag` | `string` | The tag name of the element's parent. |
| `parentId` | `string` | The ID attribute of the element's parent. |
| `indexInParent` | `number` | The zero-based index of the element relative to its siblings. |
| `domDepth` | `number` | The nesting depth from the document root. |
| `nearbyText` | `string[]` | Sibling and nearby page text extracted at recording time to represent visual context. |
| `cssSelector` | `string` | The CSS selector. |
| `fullXpath` | `string` | The recorded full absolute XPath locator. |
| `shadowDomFullXpathArray`| `string[]` | Absolute XPath for each shadow host in the boundary chain. |

---

## 3. The Candidate Element Model

The candidate elements are scraped from the current live DOM. Rather than sending the full DOM structure (which is too large), candidates are sent as clean, flat objects.

| Field Name | Type | Description / Usecase |
| :--- | :---: | :--- |
| `candidateId` | `number` | **Critical unique identifier** (monotonic session-wide index) injected by the scraper. The AI returns this ID to select the element. |
| `tagName` | `string` | The candidate's HTML tag name. |
| `id` | `string` | The candidate's ID attribute. |
| `name` | `string` | The candidate's name attribute. |
| `role` | `string` | The candidate's ARIA role. |
| `inputType` | `string` | The candidate's input type (if applicable). |
| `interactionType` | `string` | The runtime capability (`click`, `fill`, `check`, `select`). |
| `accessibleName` | `string` | The computed accessible name (the text displayed or read on this element). |
| `labelText` | `string` | The closest associated label text for the candidate. |
| `parentTag` | `string` | The tag name of the candidate's parent element. |
| `parentId` | `string` | The ID of the candidate's parent element. |
| `indexInParent` | `number` | Sibling position in parent. |
| `domDepth` | `number` | True absolute DOM depth (accounting for shadow boundaries). |
| `nearbyText` | `string[]` | Surrounding words on the page to provide local context. |
| `xpath` | `string` | The generated candidate XPath. |
| `cssSelector` | `string` | The computed unique CSS selector. |
| `shadowHostName` | `string` | The custom element tag name of the enclosing shadow root host (if nested). |
| `ancestorTagNames`| `string[]` | Ordered list of ancestor tag names up to 4 levels deep (innermost first) for structural path matching. |

---

## 4. Concrete Payload Example

Below is a real-world payload sent to the LLM during Step 11 (`Today’s patients` healing) after cleaning:

### System Prompt (Context Rules)
```text
You are an expert AI element healing system for web UI automation.
Your task: Given the metadata of an original UI element that CANNOT be located on the current page, and a pool of candidate elements extracted from the current DOM, identify the single candidate MOST LIKELY to be the same logical element.

Evaluation criteria (in priority order):
1. SEMANTIC match: Does the candidate's accessibleName or labelText closely match...
...
```

### User Prompt (Data Payload)
```json
Original Element Metadata:
{
  "objectName": "Today’s patients",
  "tagName": "SLOT",
  "interactionType": "Click",
  "accessibleName": "Today’s patients",
  "nearbyText": [
    "Today’s patients",
    "Home",
    "Patients",
    "Worklist",
    "Collaboration"
  ],
  "xpath": "/span[1]/zui-truncate-with-tooltip-v3-17[1]/slot[1]",
  "cssSelector": "span > zui-truncate-with-tooltip-v3-17:nth-of-type(1) > slot:nth-of-type(1)",
  "shadowDomHostArray": [
    "zui-select-v3-17",
    "div > zui-select-button-v3-17:nth-of-type(1)"
  ]
}

Candidate Pool (3 candidates):
[
  {
    "candidateId": 109,
    "tagName": "ZUI-SELECT-V3-17",
    "role": "listbox",
    "interactionType": "click",
    "accessibleName": "All patients",
    "parentTag": "CURIE-PATIENT-FILTER-AND-SEARCH",
    "indexInParent": 0,
    "domDepth": 14,
    "cssSelector": "zui-select-v3-17[data-test=\"patient-list-filter-select\"]"
  },
  {
    "candidateId": 170,
    "tagName": "DIV",
    "interactionType": "click",
    "accessibleName": "View/edit patient Create order...",
    "parentTag": "ZUI-SCROLLABLE-DIRECTIVE-V3-17",
    "indexInParent": -1,
    "domDepth": 16,
    "cssSelector": "div.wrapper",
    "shadowHostName": "ZUI-SCROLLABLE-DIRECTIVE-V3-17"
  },
  {
    "candidateId": 237,
    "tagName": "DIV",
    "role": "checkbox",
    "interactionType": "check",
    "accessibleName": "Only show selected patients",
    "parentTag": "ZUI-CHECKBOX-V3-17",
    "indexInParent": -1,
    "domDepth": 15,
    "cssSelector": "div[role=\"checkbox\"]",
    "shadowHostName": "ZUI-CHECKBOX-V3-17"
  }
]

Select the single best matching candidate. Output the result matching the requested JSON schema.
```

---

## 5. Output Response Contract

The AI provider enforces structured JSON output. The LLM response must match the following JSON Schema:

```json
{
  "type": "OBJECT",
  "properties": {
    "candidateId": {
      "type": "INTEGER",
      "description": "The matching candidateId selected from the Candidate Pool."
    },
    "confidence": {
      "type": "NUMBER",
      "description": "Confidence level between 0.0 and 1.0 representing matching certainty."
    },
    "reason": {
      "type": "STRING",
      "description": "A concise reasoning explaining why this candidate matches the object of interest."
    }
  },
  "required": ["candidateId", "confidence", "reason"]
}
```
