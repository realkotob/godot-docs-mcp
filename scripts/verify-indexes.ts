import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_VERSIONS } from '../src/utils';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
  console.error(red('Build failed because documentation is required for the MCP server.'));
  process.exit(1);
}

if (missing.length > 0) {
  console.warn(yellow(`WARNING: Missing index files for versions: ${missing.join(', ')}`));
  console.warn(yellow('The server will still deploy but these versions will be unavailable.'));
}

console.log(green('\nVerification complete. Documentation indexes ready for:'));
for (const version of found) {
  console.log(green(`  + ${version}`));
}

if (missing.length > 0) {
  console.log(yellow('\nMissing (skipped) versions:'));
  for (const version of missing) {
    console.log(yellow(`  - ${version}`));
  }
}
