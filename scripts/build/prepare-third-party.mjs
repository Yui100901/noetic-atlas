import { copyFile, cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
const root = resolve(import.meta.dirname, '../..');
// Include the installed dependency licenses in both local distributions.
for (const target of ['public/licenses', 'mobile/assets/licenses']) {
  await mkdir(resolve(root, target), { recursive: true });
  await copyFile(
    resolve(root, 'node_modules/pdfjs-dist/LICENSE'),
    resolve(root, target, 'PDFjs-Apache-2.0.txt'),
  );
  await copyFile(
    resolve(root, 'node_modules/ts-fsrs/LICENSE'),
    resolve(root, target, 'ts-fsrs-MIT.txt'),
  );
  await copyFile(
    resolve(root, 'node_modules/katex/LICENSE'),
    resolve(root, target, 'KaTeX-MIT.txt'),
  );
  await copyFile(
    resolve(root, 'node_modules/html-to-image/LICENSE'),
    resolve(root, target, 'html-to-image-MIT.txt'),
  );
  await copyFile(
    resolve(root, 'node_modules/fflate/LICENSE'),
    resolve(root, target, 'fflate-MIT.txt'),
  );
  await copyFile(
    resolve(root, 'node_modules/@noble/hashes/LICENSE'),
    resolve(root, target, 'noble-hashes-MIT.txt'),
  );
  await copyFile(
    resolve(root, 'node_modules/@capacitor/app/LICENSE'),
    resolve(root, target, 'capacitor-app-MIT.txt'),
  );
  await copyFile(
    resolve(root, 'web/assets/fonts/OFL-NotoSansCJK.txt'),
    resolve(root, target, 'NotoSansCJK-OFL.txt'),
  );
  const mhchem = await readFile(
      resolve(root, 'node_modules/katex/contrib/mhchem/mhchem.js'),
      'utf8',
    ),
    start = mhchem.indexOf('/********');
  await writeFile(
    resolve(root, target, 'mhchem-NOTICE.txt'),
    mhchem.slice(start, mhchem.indexOf('*/', start) + 2) +
      '\nFull Apache 2.0 text: PDFjs-Apache-2.0.txt\n',
  );
}
// Keep the complete CJK font, stored gzip-compressed until an offline PDF export
// needs it. No lossy font subsetting or network font fallback is involved.
const exportFont = gzipSync(
  await readFile(resolve(root, 'web/assets/fonts/NotoSansSC-Regular.ttf')),
  { level: 9 },
);
for (const target of ['public/fonts', 'mobile/assets/fonts']) {
  await mkdir(resolve(root, target), { recursive: true });
  // AAPT expands .gz assets and strips the suffix. Keep gzip bytes under a
  // neutral extension so the native loader can explicitly decode them.
  await rm(resolve(root, target, 'NotoSansSC-Regular.ttf.gz'), { force: true });
  await writeFile(resolve(root, target, 'NotoSansSC-Regular.ttf.bin'), exportFont);
}
// Text extraction may need CMaps and standard font metrics for older books.
// Ship them locally along with their own notices; do not fetch a public CDN.
for (const target of ['public/pdfjs', 'mobile/assets/pdfjs']) {
  const destination = resolve(root, target);
  if (relative(root, destination).replaceAll('\\', '/') !== target)
    throw new Error('PDF资源清理路径越界');
  await rm(destination, { recursive: true, force: true });
  for (const folder of ['cmaps', 'standard_fonts'])
    await cp(resolve(root, 'node_modules/pdfjs-dist', folder), resolve(root, target, folder), {
      recursive: true,
      force: true,
    });
}
