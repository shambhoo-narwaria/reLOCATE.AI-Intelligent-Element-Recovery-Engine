import * as dotenv from 'dotenv';
import * as path from 'path';

// Load config from the root folder .env file
dotenv.config({ path: path.resolve(__dirname, './.env') });

// Import Interfaces and Services
import { OpenAIService } from './src/ai/openai.service';
import { GeminiService } from './src/ai/gemini.service';
import { VLLMService } from './src/ai/vllm.service';
import { OpenRouterService } from './src/ai/openrouter.service';
import { ScoringEngine } from './src/scoring/scoring.engine';
import { HealingEngine } from './src/healing/healing.engine';

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

// Import Runner components
import { CandidateFinder } from './src/runner/candidate-finder';
import { ElementValidator } from './src/runner/element-validator';
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
    new ObjectNameRule(),       // weight 30 – object name / text
    new LabelTextRule(),        // weight 15 – associated labels
    new RoleRule(),             // weight 15 – tag / ARIA role
    new AncestorPathRule(),     // weight 15 – shadow host chain + ancestor path
    new NearbyTextRule(),       // weight  5 – sibling & nearby text
    new ParentContextRule(),    // weight 10 – parent tag / id
    new DomStructureRule(),     // weight  5 – DOM depth & index
    new ClassNameRule(),        // weight 15 – CSS class matching
    new VisualSimilarityRule(), // weight 20 – visual similarity matching
  ];
  
  const scoringEngine = new ScoringEngine(rules);

  // 3. Instantiate Healer Orchestrator
  const healingEngine = new HealingEngine(aiProvider, scoringEngine);

  // 4. Instantiate Runner components
  const candidateFinder = new CandidateFinder();
  const elementValidator = new ElementValidator();

  const testRunner = new TestRunner(
    healingEngine,
    candidateFinder,
    elementValidator
  );

  // 5. Detect simulation and usehealing modes and execute test runner
  const isSimulation = process.argv.includes('--simulate');
  const useHealing = process.argv.includes('--usehealing');
  await testRunner.run(isSimulation, useHealing);
}

// Run the bootstrap routine
bootstrap().catch(err => {
  console.error('[Bootstrap] Fatal error occurred during initialization:', err);
});
