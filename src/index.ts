import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { Page, Locator } from 'playwright';

// Interfaces
import { OriginalElement } from './interfaces/original-element.interface';
import { RecoveryEngine } from './recovery-engine/recovery.engine';
import { ScoringEngine } from './scoring/scoring.engine';
import { SafetyValidator, SemanticValidationGate, VisualValidationGate } from './validation/safety.validator';
import { CandidateFinder } from './recovery-engine/candidate-finder';
import { ElementValidator } from './validation/element.validator';
import { StatusOverlay } from './utils/status-overlay';
import { RelocateElement } from './recovery-engine/relocate-element';

// LLM Connectors
import { OpenAIService } from './llm-connectors/openai.service';
import { GeminiService } from './llm-connectors/gemini.service';
import { VLLMService } from './llm-connectors/vllm.service';
import { OpenRouterService } from './llm-connectors/openrouter.service';

// Rules
import { ObjectNameRule } from './scoring/rules/object-name.rule';
import { LabelTextRule } from './scoring/rules/label-text.rule';
import { RoleRule } from './scoring/rules/role.rule';
import { NearbyTextRule } from './scoring/rules/nearby-text.rule';
import { ParentContextRule } from './scoring/rules/parent-context.rule';
import { DomStructureRule } from './scoring/rules/dom-structure.rule';
import { AncestorPathRule } from './scoring/rules/ancestor-path.rule';
import { ClassNameRule } from './scoring/rules/class-name.rule';
import { VisualSimilarityRule } from './scoring/rules/visual-similarity.rule';
import { CssSelectorRule } from './scoring/rules/css-selector.rule';
import { HorizontalProximityRule } from './scoring/rules/horizontal-proximity.rule';

export interface RelocateConfig {
  aiProvider?: 'openai' | 'gemini' | 'vllm' | 'openrouter';
  envPath?: string;
}

export class RelocateEngine {
  private relocateElementPipeline: RelocateElement;

  constructor(config: RelocateConfig = {}) {
    // Load environment variables
    if (config.envPath) {
      dotenv.config({ path: config.envPath });
    } else {
      dotenv.config({ path: path.resolve(process.cwd(), '.env') });
    }

    const providerType = (config.aiProvider || process.env.AI_PROVIDER || 'gemini').toLowerCase().trim();
    let aiProvider;
    if (providerType === 'gemini') {
      aiProvider = new GeminiService();
    } else if (providerType === 'vllm') {
      aiProvider = new VLLMService();
    } else if (providerType === 'openrouter') {
      aiProvider = new OpenRouterService();
    } else {
      aiProvider = new OpenAIService();
    }

    const rules = [
      new ObjectNameRule(),
      new LabelTextRule(),
      new RoleRule(),
      new AncestorPathRule(),
      new NearbyTextRule(),
      new ParentContextRule(),
      new DomStructureRule(),
      new ClassNameRule(),
      new VisualSimilarityRule(),
      new CssSelectorRule(),
      new HorizontalProximityRule(),
    ];
    const scoringEngine = new ScoringEngine(rules);

    const validationGates = [
      new SemanticValidationGate(0.30),
      new VisualValidationGate(0.15)
    ];
    const safetyValidator = new SafetyValidator(validationGates);

    const recoveryEngine = new RecoveryEngine(aiProvider, scoringEngine, safetyValidator);
    const candidateFinder = new CandidateFinder();
    const elementValidator = new ElementValidator();
    const statusOverlay = new StatusOverlay();

    this.relocateElementPipeline = new RelocateElement(
      recoveryEngine,
      candidateFinder,
      elementValidator,
      statusOverlay
    );
  }

  /**
   * Relocates a target UI element by invoking the recovery pipeline.
   * Traverses candidates, scores them against the recorded identity, and returns the resolved locator.
   */
  async relocateElement(
    page: Page,
    recordedSelector: string,
    recordedIdentity: Partial<OriginalElement> & { Action: string; ObjectName?: string }
  ): Promise<Locator> {
    // Recovery triggers
    const stepMetadata: OriginalElement = {
      ...recordedIdentity,
      ObjectName: recordedIdentity.ObjectName,
      LocCssSelector: recordedIdentity.LocCssSelector,
      interactionType: (recordedIdentity.interactionType || (recordedIdentity.Action?.toLowerCase() === 'enter' ? 'fill' : recordedIdentity.Action?.toLowerCase())) as any,
      OrigTagName: recordedIdentity.OrigTagName || recordedIdentity.LocTagName,
      LocTagName: recordedIdentity.LocTagName || recordedIdentity.OrigTagName,
      LocText: recordedIdentity.LocText || recordedIdentity.labelText || recordedIdentity.accessibleName || recordedIdentity.OwnInnerText,
      Action: recordedIdentity.Action
    } as OriginalElement;

    console.warn(`[RelocateEngine] Target element "${recordedSelector}" failed or recovery requested. Triggering AI Recovery...`);
    const result = await this.relocateElementPipeline.relocate(
      page,
      stepMetadata,
      999, // Dummy step index
      recordedSelector
    );

    return result.locator;
  }
}
