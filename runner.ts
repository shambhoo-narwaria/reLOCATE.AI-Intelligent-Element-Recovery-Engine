import * as dotenv from 'dotenv';
import * as path from 'path';

// Load config from the root folder .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { RelocateEngine } from './src/index';
import { TestRunner } from './src/runner/test-runner';

async function bootstrap() {
  const providerType = (process.env.AI_PROVIDER || 'openai').toLowerCase().trim();
  console.log(`[Bootstrap] Initializing RelocateEngine with provider: ${providerType}...`);

  const relocateEngine = new RelocateEngine({
    aiProvider: providerType as any
  });

  const testRunner = new TestRunner(relocateEngine);

  // Detect usehealing mode and execute test runner
  const useHealing = process.argv.includes('--usehealing');
  await testRunner.run(useHealing);
}

// Run the bootstrap routine
bootstrap().catch(err => {
  console.error('[Bootstrap] Fatal error occurred during initialization:', err);
});
