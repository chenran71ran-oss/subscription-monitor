import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFile(path.join(root, p), 'utf8');
const [backend, template, styles, app] = await Promise.all([
  read('src/worker.js'), read('web/index.html'), read('web/styles.css'), read('web/app.js'),
]);
function replaceOnce(text, marker, value) {
  if (text.split(marker).length !== 2) throw new Error(`Expected one marker: ${marker}`);
  return text.replace(marker, () => value);
}
const html = replaceOnce(replaceOnce(template, '/* __INLINE_STYLES__ */', styles), '/* __INLINE_APP__ */', app);
const worker = replaceOnce(backend, '/* __EMBED_DASHBOARD__ */', `function page(){return ${JSON.stringify(html)};}`);
await mkdir(path.join(root, '.artifacts'), { recursive: true });
await writeFile(path.join(root, '.artifacts/page.html'), html);
for (const name of ['worker.js', 'worker.txt']) {
  if (process.argv.includes('--check')) {
    if (await read(name) !== worker) throw new Error(`${name} is stale. Run npm run build.`);
  } else await writeFile(path.join(root, name), worker);
}
console.log(process.argv.includes('--check') ? 'Generated Worker files are up to date.' : 'Built worker.js and worker.txt.');
