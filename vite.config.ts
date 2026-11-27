import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

function offlineBuild(): Plugin {
  const template = fileURLToPath(new URL('./scripts/service-worker.js', import.meta.url));
  return {
    name: 'fluxity-offline',
    apply: 'build',
    buildStart() { this.addWatchFile(template); },
    writeBundle({ dir }) {
      if (!dir) this.error('The offline build needs an output directory.');
      // Scan the finished site to include Vite's worker chunks and copied public data.
      const files = readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
        .filter(path => path !== 'sw.js' && !path.endsWith('.map') && !path.split('/').some(part => part.startsWith('.')))
        .sort();
      const assets = files.map(path => {
        const hash = createHash('sha256').update(readFileSync(join(dir, path))).digest('base64');
        return [path, `sha256-${hash}`];
      });
      const manifest = JSON.stringify(assets, null, 2);
      const worker = readFileSync(template, 'utf8');
      const revision = createHash('sha256').update(manifest).update(worker).digest('hex');
      writeFileSync(join(dir, 'sw.js'), `const REVISION = "${revision}";\nconst ASSETS = ${manifest};\n${worker}`);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [offlineBuild()],
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: ['index.html', 'docs/algorithms.html'],
    },
  },
});
