# Project Goal & Core Purpose

## Overview

The goal of **reLOCATE.AI** is to provide an autonomous, intelligent element recovery engine for web UI test automation built on Playwright.

When a UI element locator breaks due to DOM mutations, dynamic text updates, ID shifts, or framework updates, reLOCATE.AI intercepts the failure and recovers the target element in real time.

---

## Architecture Boundary

reLOCATE.AI operates with a clear separation of responsibilities:

1. **Host Execution Layer (Your Automation Runner)**:
   - Executes recorded test steps and tries primary locators.
   - Performs actual browser actions (`click`, `fill`, `select`).
   - Invokes reLOCATE.AI ONLY when all primary locators fail.

2. **reLOCATE.AI Recovery Engine**:
   - Invoked exclusively on locator failure.
   - Scrapes runtime DOM elements (Light DOM + Shadow DOM).
   - Heals the broken element using a 2-Stage recovery pipeline.
   - Returns the healed Playwright `Locator` object back to the host runner.

---

## 2-Stage Recovery Model

When invoked, reLOCATE.AI heals broken elements through 2 progressive stages:

### Stage 1: Fingerprint Recovery Engine
- **Heuristic Engine (Local Math)**: Ranks scraped candidates using 11 mathematical scoring rules (ObjectName, LabelText, Role, AncestorPath, ClassName, VisualSimilarity, ParentContext, NearbyText, CssSelector, DomStructure, HorizontalProximity). If candidate score is high (≥ 0.90), heals locally without calling an LLM.
- **LLM Candidate Reasoning**: If heuristic scores are ambiguous, sends top 10 candidate fingerprints to the LLM (`askAI`) to select the correct element.

### Stage 2: Accessibility Recovery Engine
- Executed if Stage 1 fails pre-action safety validation.
- Captures a native YAML accessibility tree snapshot (`locator('body').ariaSnapshot()`) consuming under 500 tokens.
- Invokes `askMcpAI()` to resolve the element via Playwright accessibility locators (e.g. `getByRole('button', { name: 'Sign in' })`).

---

## Key Benefits

- **Zero Test Script Rewrite**: Plug into existing Playwright runners without altering test logic.
- **Token Efficiency**: Uses native ARIA YAML accessibility trees (<500 tokens) instead of large raw DOM trees.
- **Multi-LLM Support**: Supports Gemini, OpenAI, OpenRouter, and self-hosted local models (vLLM / Qwen).
- **Data Privacy**: Allows running self-hosted models so test data never leaves your enterprise infrastructure.
