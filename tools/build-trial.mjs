/** node tools/build-trial.mjs [файл.html] — автономная копия той же страницы. */
import { build } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? resolve(root, 'dist', 'trial-offline.html'));
const bundled = await build({
  root,
  configFile: false,
  logLevel: 'error',
  build: {
    write: false,
    target: 'es2022',
    lib: { entry: resolve(root, 'src/trial/main.ts'), name: 'DrivingTrial', formats: ['iife'] },
  },
});
const outputBundle = Array.isArray(bundled) ? bundled[0] : bundled;
const script = outputBundle.output.find((chunk) => chunk.type === 'chunk' && chunk.isEntry);
if (!script) throw Error('Не найден сценарий полигона');
const [html, css] = await Promise.all([
  readFile(resolve(root, 'trial.html'), 'utf8'),
  readFile(resolve(root, 'src/trial/style.css'), 'utf8'),
]);
const document = html
  .replace('<link rel="stylesheet" href="./src/trial/style.css">', () => '<style>' + css + '</style>')
  .replace(
    '<script type="module" src="./src/trial/main.ts"></script>',
    () => '<script>' + script.code.replace(/<\/script/gi, '<\\/script') + '</script>',
  );
await mkdir(dirname(output), { recursive: true });
await writeFile(output, document);
console.log(output);
