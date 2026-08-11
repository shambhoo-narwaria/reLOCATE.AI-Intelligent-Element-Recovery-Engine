import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { Page, Locator } from 'playwright';

// Interfaces
import { OriginalElement } from './interfaces/original-element.interface';
import { RelocateEngine } from './relocate-engine/relocate.engine';
import { ScoringEngine } from './scoring/scoring.engine';
import { SafetyValidator, SemanticValidationGate, VisualValidationGate } from './validation/safety.validator';
import { CandidateFinder } from './relocate-engine/candidate-finder';
import { ElementValidator } from './validation/element.validator';
import { StatusOverlay } from './utils/status-overlay';
import { RelocateElement } from './relocate-engine/relocate-element';
import { McpRecoveryAgent } from './mcp/mcp-recovery-agent';

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

export class Relocator {
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

    const relocateEngine = new RelocateEngine(aiProvider, scoringEngine, safetyValidator);
    const candidateFinder = new CandidateFinder();
    const elementValidator = new ElementValidator();
    const statusOverlay = new StatusOverlay();
    const mcpRecoveryAgent = new McpRecoveryAgent(aiProvider);

    this.relocateElementPipeline = new RelocateElement(
      relocateEngine,
      candidateFinder,
      elementValidator,
      statusOverlay,
      mcpRecoveryAgent
    );
  }

  /**
   * Relocates a target UI element by invoking the recovery pipeline.
   * Traverses candidates, scores them against the recorded identity, and returns the resolved locator.
   */
  async relocateElement(
    page: Page,
    originalElement: Partial<OriginalElement> & { Action: string; ObjectName?: string }
  ): Promise<Locator> {
    // Recovery triggers
    const normalizedElement: OriginalElement = {
      ...originalElement,
      ObjectName: originalElement.ObjectName,
      LocCssSelector: originalElement.LocCssSelector,
      interactionType: (originalElement.interactionType || (originalElement.Action?.toLowerCase() === 'enter' ? 'fill' : originalElement.Action?.toLowerCase())) as any,
      OrigTagName: originalElement.OrigTagName || originalElement.LocTagName,
      LocTagName: originalElement.LocTagName || originalElement.OrigTagName,
      LocText: originalElement.LocText || originalElement.labelText || originalElement.accessibleName || originalElement.OwnInnerText,
      Action: originalElement.Action
    } as OriginalElement;

    const result = await this.relocateElementPipeline.relocate(
      page,
      normalizedElement
    );

    return result.locator;
  }
}
