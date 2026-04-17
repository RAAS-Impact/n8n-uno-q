import { build } from 'esbuild';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function findNodeEntries(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findNodeEntries(p));
    } else if (entry.name.endsWith('.node.ts')) {
      results.push(p);
    }
  }
  return results;
}

const entryPoints = findNodeEntries('src/nodes');

// n8n-workflow is provided by the host n8n runtime; everything else
// (bridge, msgpack, BridgeManager, ...) is bundled into each .node.js
// so the output is self-contained and doesn't need node_modules in custom/.
await build({
  entryPoints,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outdir: 'dist/nodes',
  outbase: 'src/nodes',
  external: ['n8n-workflow'],
  sourcemap: 'linked',
  logLevel: 'info',
});
