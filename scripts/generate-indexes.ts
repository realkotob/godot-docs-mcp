/**
 * generate-indexes.ts
 *
 * Downloads Godot documentation search indexes from docs.godotengine.org and
 * converts them into JSON files used by the MCP server's search tools.
 *
 * Each version's searchindex.js (a JSONP-style file wrapped in `Search.setIndex(...)`)
 * is downloaded, unwrapped, and its `docnames` array is transformed into a flat JSON
 * array of {id, name, category, url} objects stored at src/indexes/<version>/searchindex.js.json.
 *
 * Usage:
 *   npm run generate-indexes              # generate all supported versions
 *   npm run generate-indexes -- stable    # generate only "stable"
 *   npm run generate-indexes -- 4.5 4.6   # generate specific versions
 *   npm run generate-indexes -- --help    # show this help message
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEXES_DIR = resolve(__dirname, '..', 'src', 'indexes');

const SUPPORTED_VERSIONS = ['stable', 'latest', '4.6', '4.5', '4.4', '4.3'] as const;

type SearchIndexItem = {
  id: number;
  name: string;
  category: string;
  url: string;
};

function parseSearchIndex(js: string): SearchIndexItem[] {
  // Strip the `Search.setIndex(` prefix and `)` suffix
  const jsonStr = js.replace(/^Search\.setIndex\(/, '').replace(/\)$/, '');
  const data = JSON.parse(jsonStr);

  const docnames: string[] = data.docnames;

  return docnames.map((name, id) => ({
    id,
    name,
    category: name.split('/')[0],
    url: `/${name}.html`,
  }));
}

async function generateIndex(version: string): Promise<boolean> {
  const url = `https://docs.godotengine.org/en/${version}/searchindex.js`;
  const dir = resolve(INDEXES_DIR, version);

  console.log(`[${version}] Downloading ${url}...`);

  const res = await fetch(url);

  if (!res.ok) {
    console.error(`[${version}] Failed to download: ${res.status} ${res.statusText}`);
    return false;
  }

  const js = await res.text();

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Save the raw .js file
  const jsPath = resolve(dir, 'searchindex.js');
  writeFileSync(jsPath, js);
  console.log(`[${version}] Saved ${jsPath}`);

  // Parse and save the .json file
  const items = parseSearchIndex(js);
  const jsonPath = resolve(dir, 'searchindex.js.json');
  writeFileSync(jsonPath, JSON.stringify(items, null, 2));
  console.log(`[${version}] Generated ${jsonPath} (${items.length} entries)`);

  return true;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: generate-indexes [version ...]

Downloads Godot documentation search indexes and converts them to JSON
for use by the MCP server's search tools.

With no arguments, all supported versions are generated.
Pass one or more version names to generate only those.

Supported versions: ${SUPPORTED_VERSIONS.join(', ')}

Examples:
  npm run generate-indexes                # all versions
  npm run generate-indexes -- stable 4.6  # specific versions`);
    process.exit(0);
  }

  const versions = args.length > 0 ? args : [...SUPPORTED_VERSIONS];

  const invalid = versions.filter((v) => !(SUPPORTED_VERSIONS as readonly string[]).includes(v));
  if (invalid.length > 0) {
    console.error(`Unknown version(s): ${invalid.join(', ')}`);
    console.error(`Supported versions: ${SUPPORTED_VERSIONS.join(', ')}`);
    process.exit(1);
  }

  console.log(`Generating indexes for: ${versions.join(', ')}\n`);

  const results = await Promise.allSettled(versions.map((v) => generateIndex(v)));

  const succeeded: string[] = [];
  const failed: string[] = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value) {
      succeeded.push(versions[i]);
    } else {
      failed.push(versions[i]);
    }
  });

  console.log(`\nDone. ${succeeded.length}/${versions.length} indexes generated.`);

  if (succeeded.length > 0) {
    console.log(`  Succeeded: ${succeeded.join(', ')}`);
  }
  if (failed.length > 0) {
    console.log(`  Failed: ${failed.join(', ')}`);
    process.exit(1);
  }
}

main();
