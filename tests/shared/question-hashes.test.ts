import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, unzipSync } from 'fflate';
import type { QuestionInput } from '../../shared/models/types.js';
import { importDigest, importQuestionContent } from '../../shared/questions/import-dedup.js';
import {
  buildDataPackage,
  readDataPackage,
  packageSha256,
} from '../../shared/packages/data-package.js';
import {
  QUESTION_HASH_ALGORITHM,
  QUESTION_HASHES_PATH,
  estimatedQuestionHashesBytes,
  packageQuestionHashSources,
  reusePackageQuestionHash,
} from '../../shared/packages/question-hashes.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encode = (value: unknown) => encoder.encode(JSON.stringify(value));
const question: QuestionInput = {
  id: 'one',
  title: '事务',
  type: 'short_answer',
  stemMarkdown: '为什么必须整体提交？',
  answerMarkdown: '避免部分成功。',
  explanationMarkdown: '',
  options: [],
  correctAnswers: [],
  difficulty: 1,
  depth: 1,
  frequency: 0,
  frequencyScope: '',
  frequencyBasis: '',
  collection: 'general',
  status: 'published',
  categoryIds: [],
  tagIds: [],
  sourceRefs: [],
  sourceDocument: null,
  sourceAnchor: null,
};
const envelope = (questions: QuestionInput[] = [question], assets: unknown[] = []) => ({
  schemaVersion: 1,
  format: 'learning-share',
  title: '测试',
  exportedAt: '2026-11-06T00:00:00.000Z',
  questions,
  assets,
  domains: [],
  categories: [],
  tags: [],
  papers: [],
  questionBanks: [],
});
const sample = () =>
  buildDataPackage({
    kind: 'share',
    title: '指纹测试',
    payloads: [{ path: 'data/content.json', data: envelope() }],
  });
async function edit(
  fn: (entries: Record<string, Uint8Array>, manifest: any) => void | Promise<void>,
) {
  const entries = unzipSync(await sample());
  const manifest = JSON.parse(decoder.decode(entries['manifest.json']));
  await fn(entries, manifest);
  entries['manifest.json'] = encode(manifest);
  return zipSync(entries);
}
async function replaceFile(
  entries: Record<string, Uint8Array>,
  manifest: any,
  path: string,
  bytes: Uint8Array,
) {
  entries[path] = bytes;
  Object.assign(
    manifest.files.find((file: any) => file.path === path),
    { byteLength: bytes.length, sha256: await packageSha256(bytes) },
  );
}

test('question hash sidecar is compact, versioned, manifested and bound to payload position', async () => {
  const opened = await readDataPackage(await sample());
  assert.ok(opened.manifest.files.some((file) => file.path === QUESTION_HASHES_PATH));
  const hints = packageQuestionHashSources(opened);
  assert.equal(hints.length, 1);
  assert.equal(hints[0]!.hint?.algorithm, QUESTION_HASH_ALGORITHM);
  assert.equal(hints[0]!.hint?.contentHash, importDigest(importQuestionContent(question)));
  assert.ok(opened.files.get(QUESTION_HASHES_PATH)!.length < estimatedQuestionHashesBytes(1));
  assert.equal(Object.hasOwn((opened.payloads[0]!.data as any).questions[0], 'contentHash'), false);
});

test('binary digests already verified by the manifest support cross-part question assets', async () => {
  const asset = {
    id: 'remote',
    filename: 'a.png',
    mimeType: 'image/png',
    sizeBytes: 4,
    dataBase64: 'AQIDBA==',
    createdAt: '2026-11-06T00:00:00.000Z',
  };
  const q = { ...question, stemMarkdown: '看图 ![图](/api/assets/remote/content)' };
  const bytes = await buildDataPackage({
    kind: 'share',
    title: '跨片',
    payloads: [
      { path: 'data/questions.json', data: envelope([q]) },
      { path: 'data/assets.json', data: envelope([], [asset]) },
    ],
  });
  const opened = await readDataPackage(bytes),
    source = packageQuestionHashSources(opened)[0]!;
  assert.match(source.assetKey('remote'), /^image\/png:[a-f0-9]{64}$/);
  assert.equal(source.hint!.contentHash, importDigest(importQuestionContent(q, source.assetKey)));
  const local = {
    ...q,
    id: 'local-question',
    categoryIds: ['mapped-category'],
    stemMarkdown: '看图 ![图](/api/assets/local-image/content)',
  };
  const hint = reusePackageQuestionHash(q, local, source.hint, source.assetKey, (id) =>
    id === 'local-image' ? source.assetKey('remote') : `missing:${id}`,
  );
  assert.equal(hint!.contentHash, source.hint!.contentHash);
  assert.equal(
    hint!.promptHash,
    undefined,
    'literal image IDs change the legacy prompt fingerprint',
  );
  assert.equal(
    reusePackageQuestionHash(q, local, source.hint, source.assetKey, () => 'image/png:changed'),
    undefined,
  );
});

test('ordinary metadata changes retain hints while answer, rubric and source-link changes invalidate them', async () => {
  const source = packageQuestionHashSources(await readDataPackage(await sample()))[0]!;
  assert.equal(
    reusePackageQuestionHash(
      source.question,
      {
        ...source.question,
        id: 'other',
        categoryIds: ['biology'],
        tagIds: ['mapped'],
        difficulty: 4,
      },
      source.hint,
      source.assetKey,
      source.assetKey,
    ),
    source.hint,
  );
  for (const patch of [
    { answerMarkdown: '新的答案' },
    { gradingRequirements: '需要逐项说明' },
    { stemMarkdown: '另一种问题' },
  ])
    assert.equal(
      reusePackageQuestionHash(
        source.question,
        { ...source.question, ...patch },
        source.hint,
        source.assetKey,
        source.assetKey,
      ),
      undefined,
    );
});

test('old packages without optional cache continue to expose content with no reusable hints', async () => {
  const opened = await readDataPackage(
    await edit((entries, manifest) => {
      delete entries[QUESTION_HASHES_PATH];
      manifest.files = manifest.files.filter((file: any) => file.path !== QUESTION_HASHES_PATH);
    }),
  );
  assert.equal(opened.questionHashes, undefined);
  assert.equal(packageQuestionHashSources(opened)[0]!.hint, undefined);
});

test('editing a payload and updating its manifest invalidates the stale sidecar binding', async () => {
  const opened = await readDataPackage(
    await edit(async (entries, manifest) => {
      const content = JSON.parse(decoder.decode(entries['data/content.json']));
      content.questions[0].answerMarkdown = '用户在外部修改了答案';
      await replaceFile(entries, manifest, 'data/content.json', encode(content));
    }),
  );
  assert.equal(opened.questionHashes, undefined);
  assert.equal(
    packageQuestionHashSources(opened)[0]!.question.answerMarkdown,
    '用户在外部修改了答案',
  );
});

test('unknown algorithms and malformed optional caches fall back without accepting invalid file checksums', async () => {
  for (const value of [
    'invalid JSON',
    {
      format: 'noetic-atlas-question-hashes',
      schemaVersion: 1,
      algorithm: 'future-version',
      payloads: [],
    },
  ]) {
    const bytes = await edit((entries, manifest) =>
      replaceFile(
        entries,
        manifest,
        QUESTION_HASHES_PATH,
        typeof value === 'string' ? encoder.encode(value) : encode(value),
      ),
    );
    assert.equal((await readDataPackage(bytes)).questionHashes, undefined);
  }
  await assert.rejects(
    readDataPackage(
      await edit((entries) => {
        entries[QUESTION_HASHES_PATH]![0] = 32;
      }),
    ),
    /SHA256/,
  );
});

test('repacking derives new metadata rather than copying a caller-supplied stale sidecar', async () => {
  const opened = await readDataPackage(
    await buildDataPackage({
      kind: 'share',
      title: '重新封包',
      payloads: [
        {
          path: 'data/content.json',
          data: envelope([{ ...question, answerMarkdown: '新版答案' }]),
        },
      ],
      files: [
        {
          path: QUESTION_HASHES_PATH,
          bytes: encoder.encode('stale'),
          mediaType: 'application/json',
        },
      ],
    }),
  );
  const source = packageQuestionHashSources(opened)[0]!;
  assert.equal(
    source.hint!.contentHash,
    importDigest(importQuestionContent({ ...question, answerMarkdown: '新版答案' })),
  );
});
