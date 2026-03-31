import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, '..', 'wrangler.jsonc');

function patchConfig() {
  const limit = process.env.RATE_LIMIT;
  const period = process.env.RATE_PERIOD;

  if (!limit && !period) {
    console.log('No RATE_LIMIT or RATE_PERIOD environment variables found. Using defaults from wrangler.jsonc.');
    return;
  }

  console.log('Patching wrangler.jsonc with custom rate limits...');
  
  const configContent = readFileSync(configPath, 'utf8');
  // Use a regex or JSON parse to update. JSONC might have comments, 
  // but for a simple object update, JSON.parse often works if the file is clean.
  const config = JSON.parse(configContent.replace(/\/\/.*/g, '')); // Strip comments for parsing

  if (config.ratelimits && config.ratelimits[0]) {
    if (limit) {
      config.ratelimits[0].simple.limit = Number.parseInt(limit, 10);
      console.log(`  + Set limit to ${limit}`);
    }
    if (period) {
      config.ratelimits[0].simple.period = Number.parseInt(period, 10);
      console.log(`  + Set period to ${period}`);
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('Successfully updated wrangler.jsonc');
  } else {
    console.error('Could not find ratelimits section in wrangler.jsonc');
    process.exit(1);
  }
}

patchConfig();
