import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
// Include the installed dependency licenses in both local distributions.
for (const target of ['public/licenses', 'mobile/assets/licenses']) {
  await mkdir(resolve(root, target), { recursive: true });
  await copyFile(resolve(root, 'node_modules/pdfjs-dist/LICENSE'), resolve(root, target, 'PDFjs-Apache-2.0.txt'));
  await copyFile(resolve(root, 'node_modules/ts-fsrs/LICENSE'), resolve(root, target, 'ts-fsrs-MIT.txt'));
}
// Text extraction may need CMaps and standard font metrics for older books.
// Ship them locally along with their own notices; do not fetch a public CDN.
for (const target of ['public/pdfjs', 'mobile/assets/pdfjs']) {
  const destination = resolve(root, target);
  if (relative(root, destination).replaceAll('\\', '/') !== target) throw new Error('PDF资源清理路径越界');
  await rm(destination, { recursive: true, force: true });
  for (const folder of ['cmaps', 'standard_fonts']) await cp(resolve(root, 'node_modules/pdfjs-dist', folder), resolve(root, target, folder), { recursive: true, force: true });
}
