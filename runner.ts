import * as dotenv from 'dotenv';
import * as path from 'path';

// Load config from the root folder .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { Relocator } from './src/index';
import { TestRunner } from './src/runner/test-runner';

async function bootstrap() {
  const providerType = (process.env.AI_PROVIDER || 'openai').toLowerCase().trim();
  console.log(`[Bootstrap] Initializing Relocator with provider: ${providerType}...`);

  const relocator = new Relocator({
    aiProvider: providerType as any
  });

  const testRunner = new TestRunner(relocator);

  await testRunner.run();
}

// Run the bootstrap routine
bootstrap().catch(err => {
  console.error('[Bootstrap] Fatal error occurred during initialization:', err);
});
