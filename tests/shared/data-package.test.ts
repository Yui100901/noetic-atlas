import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync } from 'fflate';
import {
  buildDataPackage,
  readDataPackage,
  DATA_PACKAGE_LIMITS,
  DataPackageError,
} from '../../shared/packages/data-package.js';
import { readPackageArchive } from '../../shared/packages/archive-reader.js';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const data = (assets: unknown[] = []) => ({
  format: 'learning-share',
  schemaVersion: 1,
  domains: [],
  categories: [],
  tags: [],
  questions: [],
  papers: [],
  questionBanks: [],
  assets,
});
const asset = {
  id: 'picture',
  filename: '图.png',
  mimeType: 'image/png',
  dataBase64: 'AQIDBA==',
  sizeBytes: 4,
  createdAt: '2026-11-04T00:00:00.000Z',
};
async function sample() {
  return buildDataPackage({
    kind: 'share',
    title: '完整内容包',
    payloads: [
      { path: 'data/part-001.json', data: data([asset]), domainIds: ['computer-science'] },
    ],
  });
}
async function rewrite(fn: (entries: Record<string, Uint8Array>, manifest: any) => void) {
  const entries = unzipSync(await sample()),
    manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
  fn(entries, manifest);
  entries['manifest.json'] = encode(manifest);
  return zipSync(entries);
}

test('manifest organizes portable data and external binary assets, deduplicating partitions', async () => {
  const bytes = await buildDataPackage({
    kind: 'share',
    title: '跨领域',
    payloads: [
      { path: 'data/one.json', data: data([asset]) },
      { path: 'data/two.json', data: data([asset]) },
    ],
    files: [
      {
        path: 'notices/LICENSE.txt',
        bytes: new TextEncoder().encode('Attribution'),
        mediaType: 'text/plain',
      },
    ],
  });
  const opened = await readDataPackage(bytes);
  assert.equal(opened.manifest.format, 'noetic-atlas-package');
  assert.equal(opened.manifest.payloads.length, 2);
  assert.equal(opened.manifest.files.filter((x) => x.path.startsWith('assets/')).length, 1);
  assert.deepEqual((opened.payloads[0]!.data as any).assets, [asset]);
  const serialized = JSON.parse(new TextDecoder().decode(opened.files.get('data/one.json')));
  assert.ok(!Object.hasOwn(serialized.assets[0], 'dataBase64'));
  assert.match(serialized.assets[0].packagePath, /^assets\/[a-f0-9]{64}\.png$/);
  assert.ok(opened.files.has('notices/LICENSE.txt'));
});

test('normal DEFLATE ZIP edited by external tools remains readable with valid manifest', async () => {
  const stored = await sample(),
    compressed = zipSync(unzipSync(stored), { level: 6 });
  const opened = await readDataPackage(compressed);
  assert.equal(opened.manifest.title, '完整内容包');
  assert.deepEqual((opened.payloads[0]!.data as any).assets, [asset]);
});

test('ZIP comments can contain an embedded end-of-directory signature', async () => {
  const bytes = await sample();
  const comment = new Uint8Array(40);
  comment.set([0x50, 0x4b, 0x05, 0x06]);
  const commented = new Uint8Array(bytes.length + comment.length);
  commented.set(bytes);
  commented.set(comment, bytes.length);
  new DataView(commented.buffer).setUint16(bytes.length - 2, comment.length, true);
  assert.equal((await readDataPackage(commented)).manifest.title, '完整内容包');
});

test('streamed ZIP data descriptors are checked with and without signatures', () => {
  // Minimal ZIP32 STORE entry written in streaming mode (general flag bit 3).
  const streamZip = (signed: boolean) => {
    const original = zipSync({ 'one.txt': new Uint8Array([1, 2, 3, 4]) }, { level: 0 });
    const source = new DataView(original.buffer);
    const central = source.getUint32(original.length - 6, true);
    const descriptorLength = signed ? 16 : 12;
    const bytes = new Uint8Array(original.length + descriptorLength);
    bytes.set(original.subarray(0, central));
    bytes.set(original.subarray(central), central + descriptorLength);
    const view = new DataView(bytes.buffer);
    const descriptor = central + (signed ? 4 : 0);
    if (signed) view.setUint32(central, 0x08074b50, true);
    for (const [index, offset] of [14, 18, 22].entries()) {
      view.setUint32(descriptor + index * 4, source.getUint32(offset, true), true);
      view.setUint32(offset, 0, true);
    }
    view.setUint16(6, source.getUint16(6, true) | 8, true);
    view.setUint16(central + descriptorLength + 8, source.getUint16(central + 8, true) | 8, true);
    view.setUint32(bytes.length - 6, central + descriptorLength, true);
    return { bytes, descriptor };
  };
  for (const signed of [false, true]) {
    const { bytes, descriptor } = streamZip(signed);
    assert.deepEqual(
      readPackageArchive(bytes, DATA_PACKAGE_LIMITS).get('one.txt'),
      new Uint8Array([1, 2, 3, 4]),
    );
    bytes[descriptor] ^= 1;
    assert.throws(() => readPackageArchive(bytes, DATA_PACKAGE_LIMITS), /数据描述符/);
  }
  const missing = zipSync({ 'one.txt': new Uint8Array([1, 2, 3, 4]) }, { level: 0 });
  const view = new DataView(missing.buffer);
  view.setUint16(6, view.getUint16(6, true) | 8, true);
  const central = view.getUint32(missing.length - 6, true);
  view.setUint16(central + 8, view.getUint16(central + 8, true) | 8, true);
  assert.throws(() => readPackageArchive(missing, DATA_PACKAGE_LIMITS), /数据描述符/);
});

test('ZIP readers accept compressed empty directory entries and reject invalid local UTF-8 names consistently', async () => {
  const entries = unzipSync(await sample());
  const withDirectory = zipSync({ ...entries, 'data/': new Uint8Array() }, { level: 6 });
  const opened = await readDataPackage(withDirectory);
  assert.equal(opened.manifest.title, '完整内容包');
  assert.equal(opened.files.has('data/'), false);

  const malformed = await sample();
  // Keep the central name valid but corrupt the corresponding local UTF-8 name.
  malformed[30] = 0xff;
  await assert.rejects(readDataPackage(malformed), (error: unknown) => {
    assert.ok(error instanceof DataPackageError);
    assert.equal(error.code, 'INVALID_DATA_PACKAGE');
    assert.match(error.message, /UTF-8/);
    return true;
  });
});

test('a package with valid ZIP CRC but modified data fails its manifest SHA256', async () => {
  const bytes = await rewrite((entries) => {
    entries['data/part-001.json']![0] = 32;
  });
  await assert.rejects(readDataPackage(bytes), /SHA256/);
});

test('unknown versions, wrong purposes, missing files and undeclared files are rejected', async (t) => {
  await t.test('manifest version', async () =>
    assert.rejects(
      readDataPackage(
        await rewrite((_entries, manifest) => {
          manifest.schemaVersion = 999;
        }),
      ),
      /版本/,
    ),
  );
  await t.test('share cannot masquerade as migration', async () =>
    assert.rejects(
      readDataPackage(
        await rewrite((_entries, manifest) => {
          manifest.kind = 'migration';
        }),
      ),
      /迁移包与分片类型/,
    ),
  );
  await t.test('missing dependency', async () =>
    assert.rejects(
      readDataPackage(
        await rewrite((entries) => {
          delete entries[Object.keys(entries).find((x) => x.startsWith('assets/'))!];
        }),
      ),
      /清单不一致/,
    ),
  );
  await t.test('undeclared entry', async () =>
    assert.rejects(
      readDataPackage(
        await rewrite((entries) => {
          entries['secret.txt'] = new Uint8Array([1]);
        }),
      ),
      /清单不一致/,
    ),
  );
  await t.test('duplicate manifest record', async () =>
    assert.rejects(
      readDataPackage(
        await rewrite((_entries, manifest) => {
          manifest.files.push(manifest.files[0]);
        }),
      ),
      /重复/,
    ),
  );
});

test('unsafe archive paths, encryption, links, broken CRC and overlapping records do not import', async (t) => {
  for (const path of [
    '../escape.json',
    '/absolute',
    'a/../b',
    'a\\b',
    'C:/private',
    'name:stream',
  ]) {
    await t.test(path, async () =>
      assert.rejects(readDataPackage(zipSync({ [path]: new Uint8Array([1]) })), /路径/),
    );
  }
  await t.test('case-insensitive collision', async () =>
    assert.rejects(
      readDataPackage(zipSync({ 'data/A': new Uint8Array([1]), 'data/a': new Uint8Array([2]) })),
      /重复/,
    ),
  );
  const mutate = (fn: (bytes: Uint8Array, view: DataView, central: number) => void) => {
    const bytes = zipSync({ 'one.txt': new Uint8Array([1, 2, 3, 4]) }, { level: 0 }),
      view = new DataView(bytes.buffer);
    const central = view.getUint32(bytes.length - 6, true);
    fn(bytes, view, central);
    return bytes;
  };
  await t.test('encryption', async () =>
    assert.rejects(
      readDataPackage(
        mutate((_b, v, c) => {
          v.setUint16(c + 8, v.getUint16(c + 8, true) | 1, true);
        }),
      ),
      /加密/,
    ),
  );
  await t.test('symlink', async () =>
    assert.rejects(
      readDataPackage(
        mutate((_b, v, c) => {
          v.setUint32(c + 38, 0xa1ff0000, true);
        }),
      ),
      /链接/,
    ),
  );
  await t.test('CRC mismatch', async () =>
    assert.rejects(
      readDataPackage(
        mutate((b, v) => {
          const start = 30 + v.getUint16(26, true) + v.getUint16(28, true);
          b[start] ^= 1;
        }),
      ),
      /CRC/,
    ),
  );
  await t.test('central local mismatch', async () =>
    assert.rejects(
      readDataPackage(
        mutate((_b, v, c) => {
          v.setUint16(c + 10, 8, true);
        }),
      ),
      /不一致/,
    ),
  );
});

test('declared bounds and actual DEFLATE expansion are enforced before large allocations', async () => {
  const bytes = zipSync({ 'small.txt': new Uint8Array(1024 * 1024) }, { level: 9 });
  const view = new DataView(bytes.buffer),
    central = view.getUint32(bytes.length - 6, true);
  view.setUint32(22, 1, true);
  view.setUint32(central + 24, 1, true);
  await assert.rejects(readDataPackage(bytes), /实际解压量/);
  await assert.rejects(readDataPackage(await sample(), { maxBytes: 100 }), /大小/);
  await assert.rejects(readDataPackage(await sample(), { maxFileBytes: 10 }), /大小/);
  await assert.rejects(readDataPackage(await sample(), { maxFiles: 1 }), /数量|范围/);
  await assert.rejects(
    buildDataPackage({
      kind: 'share',
      title: 'too large',
      payloads: [{ path: 'data/one.json', data: data() }],
      limits: { maxExpandedBytes: 10 },
    }),
    /总量/,
  );
});

test('configuration, editable question batches and binary database use explicit manifest kinds', async () => {
  for (const [kind, format] of [
    ['configuration', 'noetic-atlas-configuration'],
    ['question-template', 'learning-new-questions'],
    ['question-update', 'learning-pending-questions'],
  ] as const) {
    const opened = await readDataPackage(
      await buildDataPackage({
        kind,
        title: kind,
        payloads: [
          { path: 'data/content.json', data: { format, schemaVersion: 1, questions: [] } },
        ],
      }),
    );
    assert.equal(opened.manifest.kind, kind);
  }
  const opened = await readDataPackage(
    await buildDataPackage({
      kind: 'sqlite-backup',
      title: 'SQLite',
      payloads: [],
      files: [
        {
          path: 'database/backup.sqlite',
          bytes: new TextEncoder().encode('SQLite format 3\0'),
          mediaType: 'application/vnd.sqlite3',
        },
      ],
    }),
  );
  assert.equal(opened.payloads.length, 0);
  assert.equal(opened.manifest.kind, 'sqlite-backup');
  await assert.rejects(
    buildDataPackage({ kind: 'sqlite-backup', title: 'invalid', payloads: [], files: [] }),
    /唯一SQLite/,
  );
  await assert.rejects(
    buildDataPackage({
      kind: 'share',
      title: 'invalid',
      payloads: [{ path: 'data/a.json', data: { schemaVersion: 1, questions: [], domains: [] } }],
    }),
    /用途/,
  );
  assert.equal(DATA_PACKAGE_LIMITS.maxBytes, 128 * 1024 * 1024);
});
