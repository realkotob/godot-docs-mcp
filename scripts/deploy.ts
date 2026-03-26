import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPPORTED_VERSIONS = ['stable', 'latest', '4.6', '4.5', '4.4', '4.3'] as const;
const INDEXES_DIR = resolve(__dirname, '..', 'src', 'indexes');

const supportsColor = process.stdout.isTTY ?? false;
const green = (s: string) => supportsColor ? `\x1b[32m${s}\x1b[0m` : s;
const yellow = (s: string) => supportsColor ? `\x1b[33m${s}\x1b[0m` : s;
const red = (s: string) => supportsColor ? `\x1b[31m${s}\x1b[0m` : s;

const found: string[] = [];
const missing: string[] = [];

for (const version of SUPPORTED_VERSIONS) {
  const indexFile = resolve(INDEXES_DIR, version, 'searchindex.js.json');
  if (existsSync(indexFile)) {
    found.push(version);
  } else {
    missing.push(version);
  }
}

if (found.length === 0) {
  console.error(red('ERROR: No documentation index files found for any supported version.'));
  console.error(red('Run "npm run generate-indexes" to download and generate them.'));
  process.exit(1);
}

if (missing.length > 0) {
  console.warn(yellow(`WARNING: Missing index files for versions: ${missing.join(', ')}`));
  console.warn(yellow(`Run "npm run generate-indexes -- ${missing.join(' ')}" to generate them.`));
  console.warn(yellow(`Continuing with available versions: ${found.join(', ')}\n`));
}

const extraArgs = process.argv.slice(2).join(' ');
const command = `npx wrangler deploy ${extraArgs}`.trim();

console.log('Deploying with wrangler...');
execSync(command, { stdio: 'inherit' });

console.log(green('\nDeploy complete. Documentation indexes included for versions:'));
for (const version of found) {
  console.log(green(`  + ${version}`));
}

if (missing.length > 0) {
  console.log(yellow('\nMissing (skipped) versions:'));
  for (const version of missing) {
    console.log(yellow(`  - ${version}`));
  }
}
