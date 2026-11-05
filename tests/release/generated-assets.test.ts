import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import {
  createGeneratedAssetPlan,
  inspectGeneratedAssets,
  prepareGeneratedAssets,
} from '../../scripts/build/generated-assets.mjs';

const project = resolve(import.meta.dirname, '../..');
const licenses = {
  'PDFjs-Apache-2.0.txt': 'node_modules/pdfjs-dist/LICENSE',
  'ts-fsrs-MIT.txt': 'node_modules/ts-fsrs/LICENSE',
  'KaTeX-MIT.txt': 'node_modules/katex/LICENSE',
  'html-to-image-MIT.txt': 'node_modules/html-to-image/LICENSE',
  'fflate-MIT.txt': 'node_modules/fflate/LICENSE',
  'noble-hashes-MIT.txt': 'node_modules/@noble/hashes/LICENSE',
  'capacitor-app-MIT.txt': 'node_modules/@capacitor/app/LICENSE',
  'NotoSansCJK-OFL.txt': 'web/assets/fonts/OFL-NotoSansCJK.txt',
};
const font = Buffer.from('完整 CJK source font fixture. 不允许损失字符。');
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const mhchemNotice = '/********\n * mhchem attribution fixture\n */';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'noetic-generated-assets-'));
  const links: string[] = [];
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    for (const link of links)
      await unlink(link).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    await rm(root, { recursive: true, force: true });
  });
  const put = async (name: string, value: string | Buffer = name) => {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), value);
  };
  const link = async (name: string, destination: string) => {
    await mkdir(dirname(join(root, name)), { recursive: true });
    const path = join(root, name);
    await symlink(destination, path, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(path);
  };
  for (const [name, source] of Object.entries(licenses)) await put(source, `License: ${name}\n`);
  await put('node_modules/katex/contrib/mhchem/mhchem.js', `${mhchemNotice}\nexport default {};`);
  await put('web/assets/fonts/NotoSansSC-Regular.ttf', font);
  await put('node_modules/pdfjs-dist/cmaps/Adobe-Test.bcmap', 'CMap binary fixture');
  await put('node_modules/pdfjs-dist/cmaps/LICENSE', 'CMap license');
  await put('node_modules/pdfjs-dist/standard_fonts/LICENSE_FOXIT', 'Font attribution fixture');
  await put(
    'node_modules/pdfjs-dist/standard_fonts/subdir/Example.pfb',
    'Font metric binary fixture',
  );
  await put('node_modules/sql.js/dist/sql-wasm.wasm', wasm);
  const defaults = await readFile(join(project, 'config/defaults.json'));
  await put('config/defaults.json', defaults);
  return { root, put, link, defaults };
}

async function tree(path: string, prefix = ''): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) {
      for (const [child, bytes] of await tree(join(path, entry.name), `${name}/`))
        result.set(child, bytes);
    } else result.set(name, await readFile(join(path, entry.name)));
  }
  return new Map([...result].sort(([left], [right]) => left.localeCompare(right)));
}

test('resource plan preserves complete offline font, PDF compatibility files and legal notices in both targets', async (t) => {
  const { root, defaults } = await fixture(t);
  const plan = await createGeneratedAssetPlan(root);
  assert.deepEqual(
    plan.map((item) => item.name),
    ['public/licenses', 'public/fonts', 'public/pdfjs', 'mobile/assets'],
  );
  assert.deepEqual(
    plan.map((item) => item.snapshot),
    [true, false, false, false],
  );
  const report = await prepareGeneratedAssets(root);
  assert.ok(report.every((item) => item.status === 'updated'));
  assert.ok((await inspectGeneratedAssets(plan)).every((item) => item.matches));
  const webFonts = await tree(join(root, 'public/fonts'));
  assert.deepEqual([...webFonts.keys()], ['NotoSansSC-Regular.ttf.bin']);
  assert.deepEqual(gunzipSync(webFonts.get('NotoSansSC-Regular.ttf.bin')!), font);
  assert.deepEqual(await tree(join(root, 'mobile/assets/fonts')), webFonts);
  assert.deepEqual(
    await tree(join(root, 'mobile/assets/pdfjs')),
    await tree(join(root, 'public/pdfjs')),
  );
  assert.deepEqual(
    await tree(join(root, 'mobile/assets/licenses')),
    await tree(join(root, 'public/licenses')),
  );
  assert.deepEqual(await readFile(join(root, 'mobile/assets/config/defaults.json')), defaults);
  assert.deepEqual(await readFile(join(root, 'mobile/assets/sql-wasm.wasm')), wasm);
  assert.deepEqual(
    (await readdir(join(root, 'public/licenses'))).sort(),
    [...Object.keys(licenses), 'mhchem-NOTICE.txt'].sort(),
  );
  assert.equal(
    await readFile(join(root, 'public/licenses/mhchem-NOTICE.txt'), 'utf8'),
    mhchemNotice + '\nFull Apache 2.0 text: PDFjs-Apache-2.0.txt\n',
  );
  assert.equal(
    await readFile(join(root, 'public/pdfjs/standard_fonts/subdir/Example.pfb'), 'utf8'),
    'Font metric binary fixture',
  );
  assert.equal(await readFile(join(root, 'public/pdfjs/cmaps/LICENSE'), 'utf8'), 'CMap license');
});

test('repeat preparation is byte deterministic and leaves output modification times unchanged', async (t) => {
  const { root } = await fixture(t);
  await prepareGeneratedAssets(root);
  const plan = await createGeneratedAssetPlan(root);
  const modified = new Date('2001-02-03T04:05:06.000Z');
  const before = new Map<string, { bytes: Buffer; mtime: number }>();
  for (const item of plan)
    for (const name of item.files.keys()) {
      const file = join(root, item.name, name);
      await utimes(file, modified, modified);
      before.set(file, { bytes: await readFile(file), mtime: (await stat(file)).mtimeMs });
    }
  assert.ok((await prepareGeneratedAssets(root)).every((item) => item.status === 'unchanged'));
  assert.deepEqual(
    (await createGeneratedAssetPlan(root)).map((item) => [...item.files]),
    plan.map((item) => [...item.files]),
  );
  for (const [file, previous] of before) {
    assert.deepEqual(await readFile(file), previous.bytes, file);
    assert.equal((await stat(file)).mtimeMs, previous.mtime, file);
  }
});

test('inspection distinguishes missing, changed and obsolete output; preparation removes stale files only in owned directories', async (t) => {
  const { root, put } = await fixture(t);
  await prepareGeneratedAssets(root);
  await put('public/custom.svg', '<svg>primary source resource</svg>');
  await put('public/fonts/obsolete.ttf.gz', 'old compressed font');
  await put('public/fonts/old/hash.js', 'old bundle');
  await put('public/fonts/empty/.keep', 'old entry');
  await rm(join(root, 'public/fonts/empty/.keep'));
  await put('public/pdfjs/cmaps/Adobe-Test.bcmap', 'corrupted');
  await rm(join(root, 'public/pdfjs/standard_fonts/subdir/Example.pfb'));
  await put('mobile/assets/font-old.ttf', 'outdated mobile asset');
  const report = await inspectGeneratedAssets(await createGeneratedAssetPlan(root));
  const fonts = report.find((item) => item.name === 'public/fonts')!;
  assert.ok(fonts.stale.includes('obsolete.ttf.gz'));
  assert.ok(fonts.stale.includes('old/hash.js'));
  assert.ok(fonts.stale.includes('empty/'));
  const pdfjs = report.find((item) => item.name === 'public/pdfjs')!;
  assert.deepEqual(pdfjs.changed, ['cmaps/Adobe-Test.bcmap']);
  assert.deepEqual(pdfjs.missing, ['standard_fonts/subdir/Example.pfb']);
  await prepareGeneratedAssets(root);
  assert.ok(
    (await inspectGeneratedAssets(await createGeneratedAssetPlan(root))).every(
      (item) => item.matches,
    ),
  );
  assert.equal(
    await readFile(join(root, 'public/custom.svg'), 'utf8'),
    '<svg>primary source resource</svg>',
  );
  assert.deepEqual(await readFile(join(root, 'web/assets/fonts/NotoSansSC-Regular.ttf')), font);
});

test('a missing late mobile source prevents writes and cleanup in every target', async (t) => {
  const { root, put } = await fixture(t);
  await prepareGeneratedAssets(root);
  await put('public/fonts/old-file.bin', 'keep until plan is valid');
  await put('public/licenses/PDFjs-Apache-2.0.txt', 'old snapshot');
  const publicBefore = await tree(join(root, 'public'));
  const mobileBefore = await tree(join(root, 'mobile/assets'));
  await rm(join(root, 'node_modules/sql.js/dist/sql-wasm.wasm'));
  await assert.rejects(prepareGeneratedAssets(root), { code: 'ENOENT' });
  assert.deepEqual(await tree(join(root, 'public')), publicBefore);
  assert.deepEqual(await tree(join(root, 'mobile/assets')), mobileBefore);
});

test('invalid clean defaults or a changed mhchem notice format fails before existing output changes', async (t) => {
  for (const invalid of ['defaults', 'notice'])
    await t.test(invalid, async (t) => {
      const { root, put, defaults } = await fixture(t);
      await prepareGeneratedAssets(root);
      await put('public/fonts/stale-file.bin', 'untouched');
      const before = await tree(join(root, 'public'));
      if (invalid === 'defaults') {
        const privateDefaults = JSON.parse(defaults.toString('utf8'));
        privateDefaults.ai.enabled = true;
        await put('config/defaults.json', JSON.stringify(privateDefaults));
      } else
        await put('node_modules/katex/contrib/mhchem/mhchem.js', '/* no recognizable notice */');
      await assert.rejects(
        prepareGeneratedAssets(root),
        invalid === 'defaults' ? /AI配置|基础/ : /mhchem|许可/,
      );
      assert.deepEqual(await tree(join(root, 'public')), before);
    });
});

test('unknown legal notices block the entire update; missing or changed known snapshots can be regenerated', async (t) => {
  const { root, put } = await fixture(t);
  await prepareGeneratedAssets(root);
  await put('public/licenses/Extra-NOTICE.txt', 'May be required by a new dependency');
  await put('public/fonts/stale-file.bin', 'must not be deleted while legal plan is unresolved');
  const before = await tree(join(root, 'public'));
  await assert.rejects(prepareGeneratedAssets(root), /许可.*未知文件|未知文件.*许可/);
  assert.deepEqual(await tree(join(root, 'public')), before);
  await rm(join(root, 'public/licenses/Extra-NOTICE.txt'));
  await rm(join(root, 'public/licenses/KaTeX-MIT.txt'));
  await put('public/licenses/fflate-MIT.txt', 'outdated snapshot');
  await prepareGeneratedAssets(root);
  assert.equal(
    await readFile(join(root, 'public/licenses/KaTeX-MIT.txt'), 'utf8'),
    'License: KaTeX-MIT.txt\n',
  );
  assert.equal(
    await readFile(join(root, 'public/licenses/fflate-MIT.txt'), 'utf8'),
    'License: fflate-MIT.txt\n',
  );
  assert.ok(
    (await inspectGeneratedAssets(await createGeneratedAssetPlan(root))).every(
      (item) => item.matches,
    ),
  );
});

test('all destinations are preflighted before removing any stale file when a later destination contains private data', async (t) => {
  const { root, put } = await fixture(t);
  await prepareGeneratedAssets(root);
  await put('public/fonts/stale-file.bin', 'untouched');
  await put('mobile/assets/data/private.sqlite', 'private database bytes');
  const before = await tree(join(root, 'public'));
  await assert.rejects(prepareGeneratedAssets(root), /用户数据|数据库/);
  assert.deepEqual(await tree(join(root, 'public')), before);
  assert.equal(
    await readFile(join(root, 'mobile/assets/data/private.sqlite'), 'utf8'),
    'private database bytes',
  );
});

test('a mobile destination junction cannot redirect preparation or partially change web output', async (t) => {
  const { root, put, link } = await fixture(t);
  const outside = await fixture(t);
  await prepareGeneratedAssets(root, { target: 'web' });
  await put('public/fonts/stale-file.bin', 'untouched');
  await outside.put('assets/external.txt', 'outside bytes');
  const before = await tree(join(root, 'public'));
  await link('mobile', outside.root);
  await assert.rejects(prepareGeneratedAssets(root), /链接|联接/);
  assert.deepEqual(await tree(join(root, 'public')), before);
  assert.equal(await readFile(join(outside.root, 'assets/external.txt'), 'utf8'), 'outside bytes');
  assert.deepEqual(await readdir(join(outside.root, 'assets')), ['external.txt']);
});

test('individual web or mobile preparation leaves the other target absent and validates target names', async (t) => {
  const web = await fixture(t);
  await rm(join(web.root, 'config/defaults.json'));
  assert.ok(
    (await prepareGeneratedAssets(web.root, { target: 'web' })).every((item) =>
      item.name.startsWith('public/'),
    ),
  );
  await assert.rejects(stat(join(web.root, 'mobile')), { code: 'ENOENT' });
  const mobile = await fixture(t);
  assert.deepEqual(
    (await prepareGeneratedAssets(mobile.root, { target: 'mobile' })).map((item) => item.name),
    ['mobile/assets'],
  );
  await assert.rejects(stat(join(mobile.root, 'public')), { code: 'ENOENT' });
  await assert.rejects(createGeneratedAssetPlan(mobile.root, 'unknown'), /未知.*目标/);
});
