import { readdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function walk(dir) {
  const results = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.artifacts', '.wrangler'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...await walk(file));
    else if (entry.name.endsWith('.md')) results.push(file);
  }
  return results;
}
const files = await walk(root);
for (const file of files) {
  const text = await readFile(file, 'utf8');
  const refs = [...text.matchAll(/\]\(([^)]+)\)/g), ...text.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
  for (const ref of refs) {
    if (/^(https?:|mailto:|#)/.test(ref)) continue;
    const target = ref.split('#')[0];
    if (!target) continue;
    const absolute = path.resolve(path.dirname(file), target);
    if (!absolute.startsWith(root + path.sep)) throw new Error(`Link escapes project: ${file}: ${ref}`);
    await access(absolute).catch(() => { throw new Error(`Broken relative link: ${path.relative(root, file)} -> ${ref}`); });
  }
}
console.log(`Checked relative paths in ${files.length} Markdown documents.`);
