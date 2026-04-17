import { cpSync, statSync } from 'node:fs';

cpSync('src/nodes', 'dist/nodes', {
  recursive: true,
  filter: (src) => {
    try {
      return statSync(src).isDirectory() || src.endsWith('.svg') || src.endsWith('.png');
    } catch {
      return false;
    }
  },
});
