// Re-use the reference Jolt bench in its own checkout, changing only its frequency list.
// node tools/contact-audit-jolt.mjs /path/to/codex-car-physics-01 out.json
import { readFile, writeFile, unlink, mkdtemp, rmdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error('Expected Jolt checkout directory and output JSON path.');
const directory = resolve(root, 'tools');
const source = await readFile(join(directory, 'car-contact-stand.ts'), 'utf8');
const original = '[240, 480, 960]';
if (source.split(original).length !== 2) throw new Error('The reference stand changed. Review its frequency configuration.');
// Keep the same directory depth for relative imports into ../src.
const temp = await mkdtemp(join(directory, '.audit-'));
const modulePath = temp + '.ts';
try {
  await writeFile(modulePath, source.replace(original, '[300, 600, 1200]'), { flag: 'wx' });
  const { runContactStand } = await import(pathToFileURL(modulePath));
  const data = await runContactStand(false);
  const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  await writeFile(output, JSON.stringify({ revision, sourceSha256, frequencyOverride: [300,600,1200], ...data }, null, 2)+'\n');
  process.exitCode = data.passed ? 0 : 1;
} finally {
  await unlink(modulePath).catch(e => { if (e.code !== 'ENOENT') throw e; });
  await rmdir(temp);
}
