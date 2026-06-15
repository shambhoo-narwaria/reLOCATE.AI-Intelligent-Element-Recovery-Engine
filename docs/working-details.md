# RelocateAI: Detailed Technical Working & Mechanics

This document provides a deep dive into the inner workings, algorithms, and modules of **RelocateAI**. It covers candidate collection, pre-scoring mechanics, the LLM reasoning layers, and the runtime integration pattern with Playwright.

---

## 📁 Project Directory Structure

```
RelocateAI/
├── runner.ts                     # Application entry point & service bootstrap
├── package.json                  # Dependencies & start scripts
├── .env                          # Local environment settings (keys & active AI config)
├── .gitignore                    # Git file exclusions
├── Testcase/
│   └── AIHealing.json            # Playwright automation recording & steps data
├── logs/                         # Dynamic timestamped execution logs
├── docs/
│   ├── working-details.md        # Technical architecture documentation (this file)
│   ├── ai-payload-details.md     # In-depth AI payload and JSON schema details
│   └── project-architecture.md   # Visual decision flowchart and architecture guide
└── src/
    ├── ai/
    │   ├── openai.service.ts     # OpenAI GPT-4o integration
    │   └── gemini.service.ts     # Google Gemini API REST integration
    ├── interfaces/               # Strong typing & OOP contracts
    │   ├── ai-provider.interface.ts
    │   ├── candidate.interface.ts
    │   ├── healing-result.interface.ts
    │   └── original-element.interface.ts
    ├── healing/
    │   └── healing.engine.ts     # Decision orchestrator (Rules vs AI layer)
    ├── logger/
    │   └── debug-logger.ts       # Structured file-mirror debugger
    ├── runner/
    │   ├── candidate-finder.ts   # Shadow-DOM & slot-aware candidate scraper
    │   ├── element-validator.ts  # Actionability validation guard
    │   └── test-runner.ts        # Playwright loop, highlights, & state machine
    └── scoring/
        ├── scoring.engine.ts     # Candidate scoring pipeline
        └── rules/                # Metric rules scoring components
            ├── similarity.helper.ts
            ├── object-name.rule.ts
            ├── label-text.rule.ts
            ├── role.rule.ts
            ├── nearby-text.rule.ts
            ├── parent-context.rule.ts
            └── dom-structure.rule.ts
```

---

## 1. Candidate Extraction & DOM Scrape
Location: [`src/runner/candidate-finder.ts`](file:///c:/Users/shaam/Desktop/AIElementIdentification/src/runner/candidate-finder.ts)

When the original locator fails, the page runs a recursive Javascript evaluation script inside the browser context to collect candidate interactive nodes.

### A. Shadow DOM Recursion
The crawler starts at the light-DOM root and walks the node tree. Whenever it encounters a node with a `.shadowRoot`, it:
1. Records the host element into the `hostChain` array (maintaining ancestry).
2. Traverses recursively into the `shadowRoot` structure.
3. Increments the `absoluteDepth` counter so that elements nested deeply in shadow DOM have a proportional structural depth index compared to light-DOM elements.

### B. Shadow & Slot-Aware Text Scraper (`getElementText`)
Standard `.textContent` can pull in thousands of characters of polluted parent text if called on layout elements. The custom text scraper avoids this:
* **Pruning deep containers**: If a container node contains more than 20 descendant elements (`querySelectorAll('*').length > 20`), it halts recursive deep scraping and only reads **direct text children**.
* **Slot Piercing**: If it encounters a `<slot>` element, it invokes `.assignedNodes({ flatten: true })` to capture text from elements projected from the light DOM into that slot.
* **Shadow Traversing**: Crawls shadow tree nodes recursively to extract text nodes.

### C. `display: contents` and Visibility Filters
Elements with `display: contents` do not generate a layout box themselves, yielding a bounding rectangle of `0x0` dimensions, which causes normal visibility filters to treat them as hidden.
RelocateAI resolves this by checking:
```typescript
const isDisplayContents = style && style.display === 'contents';
const visible = (rect.width > 0 && rect.height > 0) || isDisplayContents;
```
This preserves custom buttons and web component trigger slots inside the candidate pool.

---

## 2. Dynamic Rule-Based Scoring Engine
Location: [`src/scoring/scoring.engine.ts`](file:///c:/Users/shaam/Desktop/AIElementIdentification/src/scoring/scoring.engine.ts)

Before deciding to invoke the LLM, the candidates are scored using nine dedicated metric rules.

| Rule Component | Weight | Matching Criteria / Logic |
| :--- | :---: | :--- |
| **`ObjectNameRule`** | **30** | Computes the maximum similarity (Levenshtein distance) between the original `ObjectName` and the candidate's `accessibleName`, `closestLabel`, or `normalizedText`. |
| **`LabelTextRule`** | **15** | Matches associated forms or field labels. |
| **`RoleRule`** | **15** | Matches `tagName` and ARIA `role`. **Shadow Host tag matching bonus**: Grants `80%` of this weight if the candidate's tag matches one of the shadow hosts in the original element's `ShadowDomHostArray`. |
| **`AncestorPathRule`**| **15** | Calculates LCS (Longest Common Subsequence) path matching on shadow host chains and DOM tag sequences. |
| **`NearbyTextRule`** | **5**  | Compares sibling texts and layout neighbors to confirm visual neighborhood. |
| **`ParentContextRule`**| **10** | Scores based on parent tag name and parent element ID alignment. |
| **`DomStructureRule`** | **5**  | Scores based on DOM nesting depth and relative sibling index. |
| **`ClassNameRule`** | **10** | Scores CSS class token similarity using Jaccard index (filtering out Angular-specific helper attributes). |
| **`VisualSimilarityRule`**| **20** | Compares physical element crops against recorded visual templates using Weighted Jaccard edge-similarity. |

---

## 3. Decision Orchestrator
Location: [`src/healing/healing.engine.ts`](file:///c:/Users/shaam/Desktop/AIElementIdentification/src/healing/healing.engine.ts)

The orchestrator receives the scraped candidate pool, applies pre-filters (tag-name fallback for shadow hosts, input type constraints, and role matches), runs the scoring engine, and checks:
```typescript
const needsAI = !!original.forceAI || bestMatch.score < 90 || (runnerUp && (bestMatch.score - runnerUp.score) < 5);
```
* If the best-scored candidate has a score $\ge 90$ and a safety margin $\ge 5$ points over the runner-up, it heals **rules-based** instantly (saving LLM latency/costs).
* Otherwise, it delegates the candidate pool to the active **AI Reasoning Layer** for deep semantic analysis.

---

## 4. AI Reasoning Layer & API Clients
Location: [`src/ai/openai.service.ts`](file:///c:/Users/shaam/Desktop/AIElementIdentification/src/ai/openai.service.ts), [`src/ai/gemini.service.ts`](file:///c:/Users/shaam/Desktop/AIElementIdentification/src/ai/gemini.service.ts)

For a detailed breakdown of the request properties (the clean Original Element and Candidate Pool model fields) and concrete examples, refer to the [AI Payload Details Guide](file:///c:/Users/shaam/Desktop/AIElementIdentification/docs/ai-payload-details.md).

### A. Strict Response Schema
Both providers invoke their structured output configurations to force the model response format to match:
```json
{
  "candidateId": number,
  "confidence": number,
  "reason": "string"
}
```
* **Gemini Implementation**: Uses a native standard `https` POST client targeting the Google Generative Language REST API (`v1beta` endpoint). It passes the structural output schema in `generationConfig.responseSchema`.
* **OpenAI Implementation**: Employs the `openai` npm SDK in JSON object mode.

### B. Prompt Engineering Rules
The system prompt contains specialized notes:
1. **Dynamic Dropdowns**: Alerts the model that select triggers frequently change their label to reflect the *currently selected value* (e.g. `"All patients"` at runtime vs recorded `"Today's patients"`).
2. **Shadow Host Mapping**: Instructs the model that when original elements are inside a shadow root, the custom element host (e.g. `ZUI-SELECT-V3-17`) is the target interactive candidate.
3. **Behavioral Compatibility**: Clarifies that listboxes, comboboxes, and tabs are opened/activated by a click, meaning `interactionType: "click"` or role listbox matches an original `"Click"` action.

---

## 5. Playwright Integration & Action Execution
Location: [`src/runner/test-runner.ts`](file:///c:/Users/shaam/Desktop/AIElementIdentification/src/runner/test-runner.ts)

1. **Page Stabilization**: If an element is missing, the runner pauses to wait for the document load state (`document.readyState === 'complete'`) and network-idle states to complete before scraping.
2. **Domain Protection**: Checks the protocol, hostname, and port of the current page. If the domain changed entirely (a different site), it halts healing to prevent false-positive clicks.
3. **Attribute Insertion**: When a candidate is scanned, its DOM node is stamped with a unique monotonic ID: `el.setAttribute('data-ai-healed-id', String(uniqueId))`. The `uniqueId` is derived from a persistent monotonic counter on the browser's `window` object (`window.__ai_healing_counter__`). This ensures that every scanned candidate receives a globally unique locator ID across all steps of the test case, even in Single Page Applications (SPAs) where DOM nodes from previous steps remain in memory and could otherwise cause selector collisions. The new locator becomes `[data-ai-healed-id="X"]`.
4. **Visual Highlights**: Bounding box coordinates are queried, and a red border overlay is drawn around the target element for `600ms` so testers can visually verify what the runner is about to click.
5. **Action Guard**: If the target element is disabled, the runner warns and skips to prevent execution timeouts, ensuring clean execution of the test suite.
