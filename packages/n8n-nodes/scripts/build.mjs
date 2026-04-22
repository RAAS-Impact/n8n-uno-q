import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

function findEntries(dir, suffix) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results; // directory doesn't exist — fine, just no entries
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findEntries(p, suffix));
    } else if (entry.name.endsWith(suffix)) {
      results.push(p);
    }
  }
  return results;
}

const nodeEntries = findEntries('src/nodes', '.node.ts');
const credentialEntries = findEntries('src/credentials', '.credentials.ts');

// n8n-workflow is provided by the host n8n runtime. Everything else
// (bridge, msgpack, BridgeManager, transport-resolver, ...) is bundled into
// each output file so the published package is self-contained and doesn't
// need node_modules in custom/.
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['n8n-workflow'],
  sourcemap: 'linked',
  logLevel: 'info',
};

if (nodeEntries.length > 0) {
  await build({
    ...shared,
    entryPoints: nodeEntries,
    outdir: 'dist/nodes',
    outbase: 'src/nodes',
  });
}

if (credentialEntries.length > 0) {
  await build({
    ...shared,
    entryPoints: credentialEntries,
    outdir: 'dist/credentials',
    outbase: 'src/credentials',
  });
}
