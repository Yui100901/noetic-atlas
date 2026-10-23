import { readFile, readdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const files = [resolve(root, 'README.md'), resolve(root, 'API-CONTRACT.md'), ...(await readdir(resolve(root, 'docs'))).filter(name => name.endsWith('.md')).map(name => resolve(root, 'docs', name))];
const stripCode = text => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
const slug = text => text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
const errors = []; let count = 0;
for (const file of files) {
  const content = stripCode(await readFile(file, 'utf8'));
  for (const match of content.matchAll(/\]\(([^\n)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, ''); if (/^(?:https?:|mailto:)/i.test(target)) continue;
    count++; const [path, fragment] = target.split('#');
    if (/^(?:[A-Za-z]:|\/|\\)/.test(path)) { errors.push({ file, target, error: 'Use a relative local path.' }); continue; }
    const destination = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
    try {
      await access(destination);
      if (fragment && destination.endsWith('.md')) {
        const text = stripCode(await readFile(destination, 'utf8'));
        const headings = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => slug(match[1]));
        if (!headings.includes(decodeURIComponent(fragment).toLowerCase())) errors.push({ file, target, error: 'Missing heading anchor.' });
      }
    } catch { errors.push({ file, target, error: 'Missing local file.' }); }
  }
}
console.log(JSON.stringify({ files: files.length, checkedLinks: count, errors }, null, 2));
if (errors.length) process.exitCode = 1;
