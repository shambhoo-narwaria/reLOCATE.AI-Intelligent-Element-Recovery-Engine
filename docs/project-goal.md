# Project Goal

The primary goal of reLOCATE.AI is to serve as an intelligent, plug-and-play element recovery engine for Playwright web automation.

When an automation script fails to find a web element due to UI changes, dynamic text updates, or broken selectors, reLOCATE.AI recovers the broken element and returns a valid Playwright locator.

# How It Works

1. Your Runner Runs Normally
Your test script tries its normal selectors. You do not change your test logic.

2. Your Runner Calls reLOCATE.AI Only on Failure
If your selectors fail, your script calls relocator.relocateElement(page, step).

3. reLOCATE.AI Recovers the Element in 2 Stages
Stage 1: Fingerprint Recovery Engine uses local math (11 scoring rules) and candidate AI reasoning to find the element.
Stage 2: Accessibility Recovery Engine uses lightweight ARIA accessibility snapshots (<500 tokens) if Stage 1 fails.

4. Your Runner Performs the Action
reLOCATE.AI returns the healed Playwright locator. Your runner then clicks or fills the element.

# Core Principles

No Overwriting: Your existing runner keeps full control of test execution and browser actions.

Fast and Private: Uses local math first (0 token cost) and supports self-hosted LLMs (vLLM / Qwen) so sensitive test data stays private inside your infrastructure.
