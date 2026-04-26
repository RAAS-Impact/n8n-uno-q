import { build } from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Wipe dist/ before every build. esbuild only writes outputs for current
// entry points and never deletes stale ones — so a renamed or removed
// .node.ts / .credentials.ts file would leave its old .js behind, and n8n
// scans dist/ recursively and would happily load both. Bit us once with
// UnoQSshApi after the SSH-relay credential merge.
rmSync('dist', { recursive: true, force: true });

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

// n8n-workflow is provided by the host n8n runtime. ssh2 ships native
// bindings (.node files) that esbuild can't bundle, so it must be resolved
// at runtime from node_modules — declared as a regular dependency in
// package.json so n8n's community-package installer pulls it in. Everything
// else (bridge, msgpack, BridgeManager, transport-resolver, ...) is bundled
// into each output file.
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['n8n-workflow', 'ssh2'],
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
