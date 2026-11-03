import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { Store } from '../../server/core/store.js';
import { questionSchema, vocabularySchema } from '../../server/core/validation.js';
import { buildApp } from '../../server/index.js';
import {
  buildPaper,
  createAttempt,
  attemptView,
  submitAttempt,
} from '../../server/modules/practice/service.js';
import { createFocus } from '../../server/modules/focus-review/service.js';
import { createFocusSchema } from '../../server/modules/focus-review/schema.js';
import {
  recordManualReview,
  reviewQueue,
  reviewCardId,
  reviewCardView,
} from '../../server/modules/review-scheduler/service.js';
import { selectPlanTasks } from '../../server/modules/learning-plans/selection.js';
import { learningGoalSchema } from '../../server/modules/learning-plans/schema.js';
import { inspectQuestionQuality } from '../../server/modules/content-quality/rules.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';
import type { Question, VocabularyData } from '../../shared/models/types.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import {
  normalizeVocabularyData,
  vocabularyIssues,
  vocabularyPronunciationMarkdown,
  vocabularyPromptIsSafe,
} from '../../shared/questions/vocabulary.js';
import { reverseCardGradingRequirements } from '../../shared/questions/directional-grading.js';

const word = (overrides: Partial<VocabularyData> = {}): VocabularyData => ({
  language: 'en',
  headword: 'NASA',
  meaningPrompt: '美国的国家航空航天机构的通用缩写',
  acceptedAnswers: ['NASA'],
  pronunciations: [],
  ...overrides,
});

test('quality scanning reports malformed raw pronunciation fields without crashing the bank scan', () => {
  for (const patch of [{ ipa: 42 }, { kana: {} }, { romaji: [] }, { sourceUrl: 42 }]) {
    const raw = question();
    raw.vocabulary!.pronunciations = [
      {
        label: '损坏读音',
        sourceLabel: '',
        sourceUrl: '',
        license: '',
        method: 'manual',
        ...patch,
      },
    ] as unknown as VocabularyData['pronunciations'];
    assert.ok(inspectQuestionQuality(raw).some((issue) => issue.rule === 'structure'));
  }
});
const question = (vocabulary = word(), id = 'WORD') =>
  questionSchema.parse({
    id,
    type: 'short_answer',
    title: vocabulary.headword,
    stemMarkdown: '解释本词含义',
    answerMarkdown: '美国国家航空航天局',
    vocabulary,
    categoryIds: ['C'],
    status: 'published',
  }) as Question;
function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  store.put('settings', 'system', structuredClone(DEFAULT_SETTINGS));
  store.put('domains', 'D', { id: 'D', name: '语言', description: '', sortOrder: 0 });
  store.put('categories', 'C', {
    id: 'C',
    domainId: 'D',
    name: '词卡',
    description: '',
    sortOrder: 0,
    parentId: null,
  });
  return store;
}

test('normalization is idempotent, preserves spelling distinctions, and never invents meanings or readings', () => {
  const raw = word({
    headword: ' café ',
    acceptedAnswers: ['cafe\u0301', '', ' café ', 'CAFÉ', 'ｃａｆé'],
    meaningPrompt: ' 咖啡馆 ',
    partOfSpeech: ' n. ',
  });
  const before = JSON.stringify(raw),
    normalized = normalizeVocabularyData(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(normalized.acceptedAnswers, ['café', 'CAFÉ', 'ｃａｆé']);
  assert.equal(normalized.partOfSpeech, 'n.');
  assert.equal(normalized.meaningPrompt, '咖啡馆');
  assert.deepEqual(normalized.pronunciations, []);
  assert.deepEqual(normalizeVocabularyData(normalized), normalized);
  assert.deepEqual(
    normalizeVocabularyData(word({ trim: false, acceptedAnswers: [' NASA ', 'NASA'] }))
      .acceptedAnswers,
    ['NASA', ' NASA '],
  );
});

test('authoring, quality and JSON Schema agree on optional readings, provenance and reverse prompts', () => {
  const value = vocabularySchema.parse(
    word({
      pronunciations: [
        {
          label: '美式',
          ipa: '/ˈnæsə/',
          sourceLabel: '',
          sourceUrl: '',
          license: '',
          method: 'manual',
        },
      ],
    }),
  );
  assert.equal(value.pronunciations[0]!.sourceUrl, '');
  assert.equal(vocabularySchema.safeParse(word()).success, true);
  assert.equal(vocabularyPronunciationMarkdown(word()), '');
  assert.equal(inspectQuestionQuality(question()).length, 0);
  assert.ok(
    vocabularyIssues(word()).some(
      (issue) => issue.code === 'pronunciation_missing' && issue.severity === 'warning',
    ),
  );
  assert.equal(vocabularySchema.safeParse(word({ meaningPrompt: 'NASA' })).success, false);
  assert.equal(
    vocabularyPromptIsSafe(
      word({
        headword: 'crate',
        acceptedAnswers: ['crate'],
        meaningPrompt: '大板条箱；篮[箱]的量',
      }),
    ),
    true,
  );
  for (const hint of ['[线索](https://example.test)', '[线索][答案]', '![图](answer.png)'])
    assert.equal(vocabularyPromptIsSafe(word({ meaningPrompt: hint })), false);
  assert.equal(
    vocabularySchema.safeParse(word({ meaningPrompt: 'NASA', reverseEnabled: false })).success,
    true,
  );
  assert.equal(
    vocabularySchema.safeParse(word({ reverseEnabled: false, meaningPrompt: '' })).success,
    true,
  );
  assert.equal(questionSchema.safeParse({ ...question(), type: 'essay' }).success, false);
  const corrupted = { ...question(), vocabulary: word({ meaningPrompt: 'NASA' }) };
  assert.ok(
    inspectQuestionQuality(corrupted).some((issue) => issue.rule === 'vocabulary_prompt_leak'),
  );
  assert.ok(
    !inspectQuestionQuality({
      ...corrupted,
      vocabulary: { ...corrupted.vocabulary, reverseEnabled: false },
    }).some((issue) => issue.rule === 'vocabulary_prompt_leak'),
  );
  assert.equal(z.toJSONSchema(vocabularySchema, { io: 'output' }).type, 'object');
  assert.equal(
    vocabularySchema.safeParse(
      word({
        pronunciations: [
          { label: '英式', ipa: '', sourceLabel: '', sourceUrl: '', license: '', method: 'manual' },
        ],
      }),
    ).success,
    false,
  );
  const malformed = {
    ...question(),
    vocabulary: word({ pronunciations: [{ label: '英式', ipa: 123 } as any] }),
  };
  assert.ok(inspectQuestionQuality(malformed).some((issue) => issue.rule === 'structure'));
  const ja = vocabularySchema.parse({
    language: 'ja',
    headword: '学校',
    meaningPrompt: '教授学业的教育机构',
    pronunciations: [{ label: '读音', kana: 'がっこう', romaji: 'gakkou' }],
  });
  assert.deepEqual(ja.acceptedAnswers, ['学校']);
  assert.match(vocabularyPronunciationMarkdown(ja), /がっこう · gakkou/);
  assert.doesNotMatch(vocabularyPronunciationMarkdown(ja), /undefined/);
});

test('reverse matching flags are frozen, visible after grading and retained through migration', (t) => {
  const store = fixture(t),
    original = question(word({ caseSensitive: true, trim: false }));
  store.put('questions', original.id, original);
  const paper = buildPaper(store, {
    title: '词汇',
    description: '',
    mode: 'manual',
    practiceKind: 'vocabulary',
    questionIds: [original.id],
    scoring: { enabled: true, totalPoints: 3 },
  });
  store.put('papers', paper.id, paper);
  const exact = createAttempt(store, paper, { vocabularyDirection: 'meaning_to_word' });
  assert.deepEqual(exact.questions[0]!.blanks![0], {
    id: 'word',
    label: '词语',
    answers: ['NASA'],
    caseSensitive: true,
    trim: false,
  });
  assert.match(reverseCardGradingRequirements(original), /保留首尾空白，区分大小写/);
  const hidden = JSON.stringify(attemptView(exact));
  assert.doesNotMatch(hidden, /NASA|美国国家航空航天局/);
  store.put('questions', original.id, { ...original, vocabulary: word({ reverseEnabled: false }) });
  submitAttempt(store, exact, { WORD: { value: ['NASA'] } });
  assert.equal(exact.objectiveScore, 3);
  const wrong = createAttempt(store, paper, { vocabularyDirection: 'meaning_to_word' });
  submitAttempt(store, wrong, { WORD: { value: [' nasa '] } });
  assert.equal(wrong.objectiveScore, 0);
  const target = fixture(t);
  importData(target, exportData(store));
  assert.equal(
    target.require<any>('attempts', exact.id).questions[0].vocabulary.caseSensitive,
    true,
  );
  assert.equal(
    target.require<Question>('questions', original.id).vocabulary!.reverseEnabled,
    false,
  );
});

test('disabled reverse cards remain valid forward cards and cannot create a reverse session', (t) => {
  const store = fixture(t),
    original = question(word({ reverseEnabled: false, meaningPrompt: '' }));
  store.put('questions', original.id, original);
  const paper = buildPaper(store, {
    title: '词汇',
    description: '',
    mode: 'manual',
    practiceKind: 'vocabulary',
    questionIds: [original.id],
    scoring: { enabled: false },
  });
  store.put('papers', paper.id, paper);
  assert.equal(
    createAttempt(store, paper, { vocabularyDirection: 'word_to_meaning' }).questions.length,
    1,
  );
  assert.throws(
    () => createAttempt(store, paper, { vocabularyDirection: 'meaning_to_word' }),
    /关闭逆向/,
  );
  assert.throws(
    () =>
      createFocus(
        store,
        createFocusSchema.parse({ paperId: paper.id, scope: 'all', direction: 'meaning_to_word' }),
      ),
    /没有符合方向/,
  );
  assert.equal(
    createFocus(
      store,
      createFocusSchema.parse({ paperId: paper.id, scope: 'all', direction: 'word_to_meaning' }),
    ).items.length,
    1,
  );
});

test('disabling reverse excludes live due tasks without deleting their memory or events', (t) => {
  const store = fixture(t),
    original = question();
  store.put('questions', original.id, original);
  recordManualReview(
    store,
    {
      questionId: original.id,
      direction: 'meaning_to_word',
      rating: 'again',
      requestId: 'before-disable',
    },
    new Date('2026-10-01T00:00:00Z'),
  );
  const cardId = reviewCardId({ questionId: original.id, direction: 'meaning_to_word' }),
    before = JSON.stringify(store.require('review_cards', cardId)),
    events = JSON.stringify(store.all('review_events'));
  assert.equal(
    reviewQueue(
      store,
      { page: 1, pageSize: 20, direction: 'meaning_to_word' },
      new Date('2026-11-01T00:00:00Z'),
    ).total,
    1,
  );
  store.put('questions', original.id, {
    ...original,
    vocabulary: { ...original.vocabulary!, reverseEnabled: false },
  });
  assert.equal(
    reviewQueue(
      store,
      { page: 1, pageSize: 20, direction: 'meaning_to_word' },
      new Date('2026-11-01T00:00:00Z'),
    ).total,
    0,
  );
  assert.equal(JSON.stringify(store.require('review_cards', cardId)), before);
  assert.equal(JSON.stringify(store.all('review_events')), events);
  const historical = reviewCardView(store, {
    questionId: original.id,
    direction: 'meaning_to_word',
  });
  assert.equal(historical.canReview, false);
  assert.equal(historical.eventCount, 1);
  assert.deepEqual(historical.preview, []);
  assert.throws(
    () =>
      recordManualReview(store, {
        questionId: original.id,
        direction: 'meaning_to_word',
        rating: 'good',
        requestId: 'after-disable',
      }),
    /关闭逆向/,
  );
});

test('both-direction learning goals skip disabled reverse cards while still assigning forward work', (t) => {
  const store = fixture(t),
    original = question(word({ reverseEnabled: false, meaningPrompt: '' }));
  store.put('questions', original.id, original);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.dailyPush.goals = [
    learningGoalSchema.parse({
      id: 'WORDS',
      name: '词汇',
      enabled: true,
      domainId: 'D',
      categoryIds: ['C'],
      tagIds: [],
      tagMode: 'all',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      priority: 3,
      weight: 1,
      reviewPoints: 0,
      newPoints: 100,
      mode: 'focus',
      direction: 'both',
    }),
  ];
  const result = selectPlanTasks(
    store,
    settings.dailyPush,
    settings,
    '2026-11-03',
    new Date('2026-11-03T00:00:00Z'),
  );
  assert.deepEqual(
    result.tasks.map((task) => task.direction),
    ['word_to_meaning'],
  );
});

test('prompt ambiguity lookup is scoped, bounded, injection-safe and documented without returning full questions', async (t) => {
  const store = fixture(t),
    app = await buildApp({ databasePath: ':memory:', dailyPushScheduler: false });
  t.after(() => app.close());
  for (let index = 0; index < 8; index++)
    store.put('questions', 'WORD-' + index, {
      ...question(word({ headword: 'term' + index, meaningPrompt: '共同的提示' }), 'WORD-' + index),
      status: index === 7 ? 'archived' : index === 6 ? 'pending' : 'published',
    });
  store.put(
    'questions',
    'JA',
    question(word({ language: 'ja', headword: '共通', meaningPrompt: '共同的提示' }), 'JA'),
  );
  const imported = await app.inject({
    method: 'POST',
    url: '/api/import',
    payload: { mode: 'merge', data: exportData(store) },
  });
  assert.equal(imported.statusCode, 200, imported.body);
  const response = await app.inject({
    method: 'POST',
    url: '/api/vocabulary/prompt-matches',
    payload: { language: 'en', prompt: '共同的提示', excludeId: 'WORD-0' },
  });
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json();
  assert.equal(data.total, 6);
  assert.equal(data.items.length, 5);
  assert.deepEqual(Object.keys(data.items[0]).sort(), ['headword', 'id', 'title']);
  assert.ok(data.items.every((item: any) => !['WORD-0', 'WORD-7', 'JA'].includes(item.id)));
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/vocabulary/prompt-matches',
        payload: { language: 'en', prompt: "' OR 1=1--" },
      })
    ).json().total,
    0,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/vocabulary/prompt-matches',
        payload: { language: 'en', prompt: ' ' },
      })
    ).statusCode,
    400,
  );
  const docs = (await app.inject('/api/openapi.json')).json();
  assert.equal(
    docs.paths['/api/vocabulary/prompt-matches'].post.requestBody.content['application/json'].schema
      .properties.prompt.maxLength,
    8000,
  );
  const db = store.database,
    x = db.expressions;
  const plan = db.explain(
    db.query
      .selectFrom('questions')
      .select('id')
      .where(x.nestedField('data', ['vocabulary', 'language']), '=', 'en')
      .where(x.nestedField('data', ['vocabulary', 'meaningPrompt']), '=', '共同的提示'),
  );
  assert.match(JSON.stringify(plan), /questions_vocabulary_prompt_idx/);
});
