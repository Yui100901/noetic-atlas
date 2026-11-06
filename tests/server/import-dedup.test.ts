import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { parse, questionSchema } from '../../server/core/validation.js';
import {
  applyQuestionImport,
  previewQuestionImport,
} from '../../server/modules/question-imports/service.js';
import { importQuestionContent } from '../../shared/questions/import-dedup.js';
import { buildDataPackage } from '../../shared/packages/data-package.js';
import { bytesToBase64 } from '../../shared/assets/assets.js';
import {
  previewDataPackage,
  importDataPackage,
  packageImportQuestion,
} from '../../server/modules/transfer/packages.js';
import { exportShare, importShare, planShareImport } from '../../server/modules/sharing/service.js';
import type { Question, QuestionInput } from '../../shared/models/types.js';

const stamp = '2026-11-06T00:00:00.000Z';
const question = (id: string, patch: Partial<QuestionInput> = {}) =>
  parse(questionSchema, {
    id,
    title: '事务的原子性',
    type: 'short_answer',
    stemMarkdown: '解释事务的原子性与失败回滚。',
    answerMarkdown: '所有操作全部成功或者全部回滚。',
    ...patch,
  }) as QuestionInput;
function fixture(t: test.TestContext) {
  const s = new Store(':memory:');
  t.after(() => s.database.close());
  return s;
}
function put(s: Store, q: QuestionInput) {
  const saved = {
    ...q,
    id: q.id!,
    status: q.status || 'published',
    createdAt: stamp,
    updatedAt: stamp,
  } as Question;
  s.put('questions', saved.id, saved);
  return saved;
}
const count = (s: Store) => s.database.records('questions').length;

test('strict identity ignores record metadata and local part IDs but preserves case, title, answers and grading criteria', () => {
  const a = question('a'),
    b = question('b', {
      difficulty: 4,
      sourceRefs: [{ label: 'source', url: 'https://example.org/source' }],
    });
  assert.equal(importQuestionContent(a), importQuestionContent(b));
  for (const patch of [
    { title: '另一概念' },
    { answerMarkdown: '只能部分回滚' },
    { gradingRequirements: '必须指出全部操作' },
    { stemMarkdown: a.stemMarkdown + '\nconst A = 1;' },
  ])
    assert.notEqual(importQuestionContent(a), importQuestionContent({ ...b, ...patch }));
  assert.notEqual(
    importQuestionContent({ ...a, stemMarkdown: 'const A = 1;' }),
    importQuestionContent({ ...b, stemMarkdown: 'const a = 1;' }),
  );
});
test('exact matches in the bank and the incoming batch reuse one identity and preserve local admission, study and provenance', (t) => {
  const s = fixture(t),
    base = put(s, question('original', { status: 'published' }));
  s.put('study', base.id, { questionId: base.id, notes: '保留笔记', favorite: true, mastery: 2 });
  const incoming = [
    question('x', { sourceRefs: [{ label: '来源A', url: 'https://example.org/a' }] }),
    question('y', { sourceRefs: [{ label: '来源B', url: 'https://example.org/b' }] }),
  ];
  const preview = previewQuestionImport(s, incoming);
  assert.deepEqual(preview.counts, { new: 0, exact: 2, similar: 0 });
  const result = applyQuestionImport(s, incoming, { expectedFingerprint: preview.fingerprint });
  assert.equal(result.added, 0);
  assert.equal(count(s), 1);
  assert.deepEqual(
    result.items.map((q) => q.id),
    ['original', 'original'],
  );
  assert.equal(s.get<Question>('questions', 'original')!.status, 'published');
  assert.equal(s.get<any>('study', 'original')!.notes, '保留笔记');
  assert.equal(s.get<Question>('questions', 'original')!.sourceRefs.length, 2);
});
test('same prompt with changed answer requires a decision and supports all three user actions', async (t) => {
  for (const action of ['keep', 'both', 'replace'] as const)
    await t.test(action, (t) => {
      const s = fixture(t),
        base = put(s, question('original', { status: 'published' })),
        incoming = [question('remote', { answerMarkdown: '全部操作作为一个不可分割的整体。' })];
      s.put('study', base.id, { questionId: base.id, notes: '学习状态保留' });
      const p = previewQuestionImport(s, incoming);
      assert.equal(p.counts.similar, 1);
      assert.throws(
        () => applyQuestionImport(s, incoming, { expectedFingerprint: p.fingerprint }),
        /选择处理方式/,
      );
      assert.equal(count(s), 1);
      const result = applyQuestionImport(s, incoming, {
        expectedFingerprint: p.fingerprint,
        decisions: [{ key: 'i-0', action, targetId: base.id }],
      });
      assert.equal(count(s), action === 'both' ? 2 : 1);
      assert.equal(result.updated, action === 'replace' ? 1 : 0);
      assert.equal(result.items[0]!.id === base.id, action !== 'both');
      assert.equal(s.get<any>('study', base.id)!.notes, '学习状态保留');
      assert.equal(
        s.get<Question>('questions', base.id)!.answerMarkdown,
        action === 'replace' ? incoming[0]!.answerMarkdown : base.answerMarkdown,
      );
      if (action === 'replace') assert.ok(s.database.records('question_revisions').length >= 2);
    });
});
test('same ID is a conflict candidate even when its title and prompt were rewritten, and stale previews reject atomically', (t) => {
  const s = fixture(t),
    base = put(s, question('same', { status: 'published' })),
    incoming = [question('same', { title: '完全改写', stemMarkdown: '一个不同的测试问题' })],
    p = previewQuestionImport(s, incoming);
  assert.equal(p.counts.similar, 1);
  assert.equal(p.items[0]!.candidates[0]!.id, base.id);
  s.put('questions', base.id, {
    ...base,
    answerMarkdown: '本地刚修改',
    updatedAt: '2026-11-06T00:01:00.000Z',
  });
  assert.throws(
    () =>
      applyQuestionImport(s, incoming, {
        expectedFingerprint: p.fingerprint,
        decisions: [{ key: 'i-0', action: 'replace', targetId: base.id }],
      }),
    /预览后发生变化/,
  );
  assert.equal(s.get<Question>('questions', base.id)!.answerMarkdown, '本地刚修改');
  assert.equal(count(s), 1);
});
test('batch duplicates and keep choices map links to the retained identity; repeated replacements of one target fail before writing', (t) => {
  const s = fixture(t),
    base = put(s, question('base', { status: 'published' })),
    incoming = [
      question('a', { answerMarkdown: '修订一' }),
      question('b', { answerMarkdown: '修订二' }),
    ],
    p = previewQuestionImport(s, incoming);
  assert.throws(
    () =>
      applyQuestionImport(s, incoming, {
        expectedFingerprint: p.fingerprint,
        decisions: [
          { key: 'i-0', action: 'replace', targetId: base.id },
          { key: 'i-1', action: 'replace', targetId: base.id },
        ],
      }),
    /多道导入题/,
  );
  assert.equal(s.get<Question>('questions', base.id)!.answerMarkdown, base.answerMarkdown);
  const fresh = [
    question('new-a', { title: '独立题', stemMarkdown: '这是一道新题' }),
    question('new-b', { title: '独立题', stemMarkdown: '这是一道新题' }),
    question('link', {
      title: '关联入口',
      stemMarkdown: '参考 [原题](#/questions/new-b)',
      answerMarkdown: '关联知识',
    }),
  ];
  const result = applyQuestionImport(s, fresh);
  assert.equal(result.added, 2);
  assert.equal(result.items[0]!.id, result.items[1]!.id);
  assert.ok(result.items[2]!.stemMarkdown.includes(`#/questions/${result.items[0]!.id}`));
  assert.ok(!result.items[2]!.stemMarkdown.includes('#/questions/new-b'));
});
test('derived hashes refresh after edits, status changes and deletes, without requiring a quality scan', (t) => {
  const s = fixture(t),
    base = put(s, question('base', { status: 'pending' })),
    incoming = [question('remote')];
  assert.equal(previewQuestionImport(s, incoming).counts.exact, 1);
  s.put('questions', base.id, {
    ...base,
    answerMarkdown: '新答案',
    updatedAt: '2026-11-06T01:00:00.000Z',
    status: 'archived',
  });
  const changed = previewQuestionImport(s, incoming);
  assert.equal(changed.counts.exact, 0);
  assert.equal(changed.items[0]!.candidates[0]!.status, 'archived');
  s.remove('questions', base.id);
  assert.deepEqual(previewQuestionImport(s, incoming).counts, { new: 1, exact: 0, similar: 0 });
});
test('equal image bytes under different asset IDs are exact matches and group reordering retains matching child identities', (t) => {
  const s = fixture(t),
    png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=';
  for (const id of ['image-a', 'image-b'])
    s.put('assets', id, {
      id,
      filename: 'diagram.png',
      mimeType: 'image/png',
      dataBase64: png,
      sizeBytes: Buffer.from(png, 'base64').length,
      width: 1,
      height: 1,
      createdAt: stamp,
    });
  put(
    s,
    question('image-question', {
      stemMarkdown: '![示意](/api/assets/image-a/content)',
      status: 'published',
    }),
  );
  assert.equal(
    previewQuestionImport(s, [
      question('remote', { stemMarkdown: '![示意](/api/assets/image-b/content)' }),
    ]).counts.exact,
    1,
  );
  const first = {
      id: 'part-a',
      type: 'short_answer' as const,
      title: 'A',
      stemMarkdown: '子问题A',
      answerMarkdown: '答案A',
      explanationMarkdown: '',
      options: [],
      correctAnswers: [],
      weight: 1,
    },
    second = {
      ...first,
      id: 'part-b',
      title: 'B',
      stemMarkdown: '子问题B',
      answerMarkdown: '答案B',
    };
  const group = put(
      s,
      question('group', {
        type: 'group',
        title: '阅读材料',
        stemMarkdown: '公共材料',
        answerMarkdown: '',
        parts: [first, second],
        status: 'published',
      }),
    ),
    incoming = [
      question('remote-group', {
        ...group,
        id: 'remote-group',
        parts: [
          { ...second, id: 'source-b' },
          { ...first, id: 'source-a' },
        ],
      }),
    ];
  const preview = previewQuestionImport(s, incoming);
  assert.equal(preview.counts.similar, 1);
  applyQuestionImport(s, incoming, {
    expectedFingerprint: preview.fingerprint,
    decisions: [{ key: 'i-0', action: 'replace', targetId: group.id }],
  });
  assert.deepEqual(
    s.get<Question>('questions', group.id)!.parts!.map((part) => part.id),
    ['part-b', 'part-a'],
  );
});
test('package preview exposes lazy details, exact reuse and explicit similarity confirmation', async (t) => {
  const s = fixture(t),
    base = put(s, question('base', { status: 'published' }));
  const incoming = [question('remote', { answerMarkdown: '新版参考答案' })];
  const bytes = await buildDataPackage({
    kind: 'question-template',
    title: '查重测试',
    payloads: [
      {
        path: 'data/questions.json',
        data: { format: 'learning-new-questions', schemaVersion: 1, questions: incoming },
      },
    ],
  });
  const dataBase64 = bytesToBase64(bytes),
    preview = await previewDataPackage(s, { dataBase64 });
  assert.equal(preview.dedup!.counts.similar, 1);
  assert.equal(
    packageImportQuestion(s, { fingerprint: preview.fingerprint, index: 0 }).title,
    incoming[0]!.title,
  );
  await assert.rejects(
    importDataPackage(s, { dataBase64, confirmed: true, expectedFingerprint: preview.fingerprint }),
    /选择处理方式/,
  );
  assert.equal(count(s), 1);
  await importDataPackage(s, {
    dataBase64,
    confirmed: true,
    expectedFingerprint: preview.fingerprint,
    decisions: [{ key: 'i-0', action: 'replace', targetId: base.id }],
  });
  assert.equal(s.get<Question>('questions', base.id)!.answerMarkdown, incoming[0]!.answerMarkdown);
  assert.throws(
    () => packageImportQuestion(s, { fingerprint: 'a'.repeat(64), index: 0 }),
    /预览已过期/,
  );
});
test('sharing exact identity is independent of taxonomy and source record IDs, including in-batch copies', (t) => {
  const source = fixture(t),
    target = fixture(t);
  const q = put(source, question('source', { status: 'published' }));
  put(target, question('local', { status: 'published', difficulty: 4 }));
  const pack = exportShare(source, { kind: 'questions', ids: [q.id] });
  pack.questions.push({ ...pack.questions[0]!, id: 'another-source' });
  const p = planShareImport(target, pack);
  assert.equal(p.dedup.counts.exact, 2);
  importShare(target, pack);
  assert.equal(count(target), 1);
});

test('share imports remap reserved source IDs before saving new questions', (t) => {
  const source = fixture(t),
    target = fixture(t);
  const q = put(source, question('remote', { status: 'published' }));
  const data = exportShare(source, { kind: 'questions', ids: [q.id] });
  data.questions[0]!.id = 'new';
  importShare(target, data);
  const imported = target.all<Question>('questions');
  assert.equal(imported.length, 1);
  assert.notEqual(imported[0]!.id, 'new');
  assert.equal(imported[0]!.status, 'pending');
});

test('keeping an original skips differing incoming citations and their duplicate copies', (t) => {
  const s = fixture(t),
    base = put(s, question('base', { status: 'published' }));
  const incoming = question('remote', {
    answerMarkdown: '另一份待核对的答案',
    sourceRefs: [{ label: '导入版本来源', url: 'https://example.invalid/incoming' }],
  });
  const entries = [incoming, { ...incoming, id: 'remote-copy' }];
  const plan = previewQuestionImport(s, entries);
  assert.equal(plan.items[1]!.duplicateOf, 'i-0');
  const result = applyQuestionImport(s, entries, {
    expectedFingerprint: plan.fingerprint,
    decisions: [{ key: 'i-0', action: 'keep', targetId: base.id }],
  });
  assert.equal(result.added, 0);
  assert.deepEqual(s.get<Question>('questions', base.id), base);
});
test('bounded candidate comparison does not perform an all-pairs bank scan for a large duplicate import', (t) => {
  const s = fixture(t);
  s.transaction(() => {
    for (let i = 0; i < 3000; i++)
      put(
        s,
        question(`local-${i}`, {
          title: `Concept ${i}`,
          stemMarkdown: `UniqueToken${i} 独立编号概念 ${i}`,
        }),
      );
  });
  const input = Array.from({ length: 1000 }, (_, i) =>
    question(`remote-${i}`, {
      title: `Concept ${i}`,
      stemMarkdown: `UniqueToken${i} 独立编号概念 ${i}`,
    }),
  );
  const plan = previewQuestionImport(s, input);
  assert.equal(plan.counts.exact, 1000);
  assert.equal(plan.metrics.compared, 0);
  assert.equal(plan.metrics.indexed, 3000);
  assert.equal(applyQuestionImport(s, input, { expectedFingerprint: plan.fingerprint }).added, 0);
  assert.equal(count(s), 3000);
});

test('package image preview is readable before import and does not save preview-only URLs', async (t) => {
  const source = fixture(t),
    target = fixture(t);
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=';
  source.put('assets', 'remote-image', {
    id: 'remote-image',
    filename: 'diagram.png',
    mimeType: 'image/png',
    dataBase64: png,
    sizeBytes: Buffer.from(png, 'base64').length,
    width: 1,
    height: 1,
    createdAt: stamp,
  });
  const original = put(
    source,
    question('image-source', {
      status: 'published',
      stemMarkdown: '观察插图。\n![图](/api/assets/remote-image/content)',
    }),
  );
  const data = exportShare(source, { kind: 'questions', ids: [original.id] });
  const bytes = await buildDataPackage({
    kind: 'share',
    title: '含图题',
    payloads: [{ path: 'data/content.json', data }],
  });
  const dataBase64 = bytesToBase64(bytes),
    preview = await previewDataPackage(target, { dataBase64 });
  assert.match(
    packageImportQuestion(target, { fingerprint: preview.fingerprint, index: 0 }).stemMarkdown,
    /data:image\/png;base64,/,
  );
  assert.equal(target.all('questions').length, 0);
  assert.equal(target.all('assets').length, 0);
  await importDataPackage(target, {
    dataBase64,
    expectedFingerprint: preview.fingerprint,
    confirmed: true,
    decisions: [],
  });
  assert.match(target.all<Question>('questions')[0]!.stemMarkdown, /\/api\/assets\//);
  assert.doesNotMatch(target.all<Question>('questions')[0]!.stemMarkdown, /data:image/);
});

test('new-question packages can contain more than one small API batch while confirming similarities once', async (t) => {
  const store = fixture(t);
  const questions = Array.from({ length: 510 }, (_, index) =>
    question(`batch-${index}`, {
      title: `数量${index}`,
      stemMarkdown: `解释数值 ${index} 的意义。`,
    }),
  );
  const bytes = await buildDataPackage({
    kind: 'question-template',
    title: '多分片批量',
    payloads: [
      {
        path: 'data/a.json',
        data: {
          format: 'learning-new-questions',
          schemaVersion: 1,
          questions: questions.slice(0, 300),
        },
      },
      {
        path: 'data/b.json',
        data: {
          format: 'learning-new-questions',
          schemaVersion: 1,
          questions: questions.slice(300),
        },
      },
    ],
  });
  const dataBase64 = bytesToBase64(bytes),
    preview = await previewDataPackage(store, { dataBase64 });
  assert.equal(preview.dedup!.total, 510);
  const result = await importDataPackage(store, {
    dataBase64,
    expectedFingerprint: preview.fingerprint,
    confirmed: true,
    decisions: preview
      .dedup!.items.filter((item) => item.kind === 'similar')
      .map((item) => ({ key: item.key, action: 'both' })),
  });
  assert.equal((result.result as { added: number }).added, 510);
  assert.equal(count(store), 510);
});
