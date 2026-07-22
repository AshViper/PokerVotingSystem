import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

function fixScriptTag(): Plugin {
  let outputDir: string;
  return {
    name: 'fix-script-tag',
    configResolved(config) {
      outputDir = config.build.outDir;
    },
    closeBundle() {
      const candidates = ['index.html', 'vite.html'];
      for (const name of candidates) {
        const htmlPath = resolve(outputDir, name);
        try {
          let html = readFileSync(htmlPath, 'utf-8');

          // Remove type="module" crossorigin from script tag
          html = html.replace(
            '<script type="module" crossorigin>',
            '<script>'
          );

          // Move the <script> tag to right before </body>
          const scriptMatch = html.match(/<script>[\s\S]*?<\/script>/);
          if (scriptMatch) {
            const scriptTag = scriptMatch[0];
            html = html.replace(scriptTag, '');
            html = html.replace('</body>', scriptTag + '\n</body>');
          }

          writeFileSync(htmlPath, html, 'utf-8');
          break;
        } catch {
          // try next
        }
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [viteSingleFile(), fixScriptTag()],
  build: {
    target: 'es2020',
    rollupOptions: {
      input: 'vite.html',
    },
  },
});
