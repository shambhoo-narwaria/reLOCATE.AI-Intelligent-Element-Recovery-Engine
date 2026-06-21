import * as dotenv from 'dotenv';
import * as path from 'path';

// Load config from the root folder .env file
dotenv.config({ path: path.resolve(__dirname, './.env') });

// Import Interfaces and Services
import { OpenAIService } from './src/llm-connectors/openai.service';
import { GeminiService } from './src/llm-connectors/gemini.service';
import { VLLMService } from './src/llm-connectors/vllm.service';
import { OpenRouterService } from './src/llm-connectors/openrouter.service';
import { ScoringEngine } from './src/scoring/scoring.engine';
import { RecoveryEngine } from './src/recovery-engine/recovery.engine';
import { SemanticValidationGate, VisualValidationGate, SafetyValidator } from './src/validation/safety.validator';

// Import Rules
import { ObjectNameRule } from './src/scoring/rules/object-name.rule';
import { LabelTextRule } from './src/scoring/rules/label-text.rule';
import { RoleRule } from './src/scoring/rules/role.rule';
import { NearbyTextRule } from './src/scoring/rules/nearby-text.rule';
import { ParentContextRule } from './src/scoring/rules/parent-context.rule';
import { DomStructureRule } from './src/scoring/rules/dom-structure.rule';
import { AncestorPathRule } from './src/scoring/rules/ancestor-path.rule';
import { ClassNameRule } from './src/scoring/rules/class-name.rule';
import { VisualSimilarityRule } from './src/scoring/rules/visual-similarity.rule';
import { CssSelectorRule } from './src/scoring/rules/css-selector.rule';
import { HorizontalProximityRule } from './src/scoring/rules/horizontal-proximity.rule';

// Import Runner components
import { CandidateFinder } from './src/runner/candidate-finder';
import { ElementValidator } from './src/validation/element.validator';
import { StatusOverlay } from './src/runner/status-overlay';
import { RecoveryPipeline } from './src/runner/recovery-pipeline';
import { TestRunner } from './src/runner/test-runner';

async function bootstrap() {
  // 1. Instantiate Core Abstractions (DIP)
  const providerType = (process.env.AI_PROVIDER || 'openai').toLowerCase().trim();
  let aiProvider;
  if (providerType === 'gemini') {
    console.log('[Bootstrap] Initializing Gemini AI Service...');
    aiProvider = new GeminiService();
  } else if (providerType === 'vllm') {
    console.log('[Bootstrap] Initializing EC2/vLLM AI Service (Qwen)...');
    aiProvider = new VLLMService();
  } else if (providerType === 'openrouter') {
    console.log('[Bootstrap] Initializing OpenRouter Service (Qwen)...');
    aiProvider = new OpenRouterService();
  } else {
    console.log('[Bootstrap] Initializing OpenAI AI Service...');
    aiProvider = new OpenAIService();
  }

  // 2. Instantiate and Register Scoring Rules (OCP / LSP)
  const rules = [
    new ObjectNameRule(),         // weight 30 – object name / text
    new LabelTextRule(),          // weight 15 – associated labels
    new RoleRule(),               // weight 15 – tag / ARIA role
    new AncestorPathRule(),       // weight 15 – shadow host chain + ancestor path
    new NearbyTextRule(),         // weight 10 – sibling & nearby text
    new ParentContextRule(),      // weight 10 – parent tag / id
    new DomStructureRule(),       // weight 5 – DOM depth & index
    new ClassNameRule(),          // weight 10 – CSS class matching
    new VisualSimilarityRule(),   // weight 20 – visual similarity matching
    new CssSelectorRule(),        // weight 10 – CSS selector path similarity matching
    new HorizontalProximityRule(),// weight 5 – horizontal proximity tiebreaker matching
  ];
  
  const scoringEngine = new ScoringEngine(rules);

  // 2b. Instantiate Validation Gates & Safety Validator (SOLID/OOP architecture)
  const validationGates = [
    new SemanticValidationGate(0.30),
    new VisualValidationGate(0.15)
  ];
  const safetyValidator = new SafetyValidator(validationGates);

  // 3. Instantiate Healer Orchestrator
  const recoveryEngine = new RecoveryEngine(aiProvider, scoringEngine, safetyValidator);

  // 4. Instantiate Runner components
  const candidateFinder = new CandidateFinder();
  const elementValidator = new ElementValidator();
  const statusOverlay = new StatusOverlay();
  const recoveryPipeline = new RecoveryPipeline(
    recoveryEngine,
    candidateFinder,
    elementValidator,
    statusOverlay
  );

  const testRunner = new TestRunner(
    recoveryEngine,
    statusOverlay,
    recoveryPipeline
  );

  // 5. Detect usehealing mode and execute test runner
  const useHealing = process.argv.includes('--usehealing');
  await testRunner.run(useHealing);
}

// Run the bootstrap routine
bootstrap().catch(err => {
  console.error('[Bootstrap] Fatal error occurred during initialization:', err);
});
