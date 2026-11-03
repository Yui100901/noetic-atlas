import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import type { Question } from '../../shared/models/types.js';
import {
  applyVocabularyStandardization,
  extractPartOfSpeech,
  planVocabularyStandardization,
  protectedQuestionDigest,
  standardizeVocabulary,
  tableDigest,
} from '../../scripts/content/vocabulary/standardize.js';

function card(id: string, fields: Partial<Question> = {}): Question {
  return {
    ...questionSchema.parse({
      id,
      title: id,
      type: 'short_answer',
      stemMarkdown: `解释 ${id} 的含义。`,
      answerMarkdown: '**词性**：noun\n\n一种水果',
      explanationMarkdown: '一个水果的例句。',
      gradingRequirements: '人工标准：说明核心义，不要求读音。',
      status: 'published',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    }),
    vocabulary: {
      language: 'en',
      headword: id,
      meaningPrompt: '一种常见水果',
      acceptedAnswers: [id],
      pronunciations: [],
    },
    ...fields,
  } as Question;
}
function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  store.put('questions', 'apple', { ...card('apple'), unknownSourceField: 'PRESERVE_UNKNOWN' });
  store.put('questions', 'pear', card('pear', { status: 'pending' }));
  store.put('questions', 'ordinary', { ...card('ordinary'), vocabulary: undefined });
  store.put('study', 'apple', {
    questionId: 'apple',
    notes: 'PRIVATE_NOTE_CANARY',
    favorite: true,
  });
  store.put('papers', 'frozen', { id: 'frozen', snapshot: [card('apple')] });
  store.put('attempts', 'old', {
    id: 'old',
    questions: [card('apple')],
    answers: { apple: '之前的回答' },
  });
  store.put('settings', 'settings', { private: 'PRIVATE_SETTINGS_CANARY' });
  return store;
}

test('explicit WordNet headings and Japanese labels supply all stated parts of speech, not glossary-derived guesses', () => {
  const source = card('example', {
    answerMarkdown:
      '**noun / 名词 · 12345678-n**\n\nEnglish: meaning\n\n---\n\n**verb / 动词 · 12345679-v**\n\nEnglish: another meaning\n\n**noun / 名词 · 12345670-n**',
    explanationMarkdown: '**词性**：名词（n）；な形容词（adj-na）\n\n其他释义',
  });
  const result = extractPartOfSpeech(source);
  assert.equal(result.value, 'noun / 名词；verb / 动词；名词（n）；な形容词（adj-na）');
  assert.deepEqual(
    new Set(result.sources.map((item) => item.field)),
    new Set(['answerMarkdown', 'explanationMarkdown']),
  );
  assert.equal(
    extractPartOfSpeech(
      card('plain', { answerMarkdown: '这里出现noun，不是词性标签', explanationMarkdown: '' }),
    ).value,
    '',
  );
});

test('safe normalization is explicit and preserves manual standards, source fields and pronunciation evidence', () => {
  const source = card('apple');
  source.vocabulary = {
    ...source.vocabulary!,
    headword: ' apple ',
    acceptedAnswers: [' apple ', '', 'apple'],
    pronunciations: [
      {
        label: ' 英式 ',
        ipa: ' /ˈæpəl/ ',
        sourceLabel: '',
        sourceUrl: '',
        license: '',
        method: 'manual',
      },
    ],
  };
  const result = standardizeVocabulary(source)!;
  assert.equal(result.vocabulary.partOfSpeech, 'noun');
  assert.deepEqual(result.vocabulary.acceptedAnswers, ['apple']);
  assert.equal(result.vocabulary.caseSensitive, false);
  assert.equal(result.vocabulary.trim, true);
  assert.equal(result.vocabulary.reverseEnabled, true);
  assert.equal(result.vocabulary.pronunciations[0]!.ipa, '/ˈæpəl/');
  assert.equal(source.vocabulary.headword, ' apple ');
  assert.equal(source.gradingRequirements, '人工标准：说明核心义，不要求读音。');
  assert.deepEqual(
    result.issues.filter((issue) => issue.severity === 'error'),
    [],
  );
});

test('a literal headword label may be removed but unsafe semantic prompts disable reverse without fabricating a meaning', () => {
  const prefix = card('apple');
  prefix.vocabulary!.meaningPrompt = 'apple：一种常见水果';
  const repaired = standardizeVocabulary(prefix)!;
  assert.equal(repaired.promptRepair, 'removed_literal_label_prefix');
  assert.equal(repaired.vocabulary.meaningPrompt, '一种常见水果');
  assert.equal(repaired.vocabulary.reverseEnabled, true);
  const unsafe = card('apple');
  unsafe.vocabulary!.meaningPrompt = '例如 apple juice 中的第一个词';
  const disabled = standardizeVocabulary(unsafe)!;
  assert.equal(disabled.vocabulary.reverseEnabled, false);
  assert.equal(disabled.vocabulary.meaningPrompt, unsafe.vocabulary.meaningPrompt);
  assert.equal(disabled.promptRepair, 'disabled_unsafe_hint');
});

test('an existing part of speech and exact-match flags are never overridden by copied source labels', () => {
  const source = card('apple');
  source.vocabulary = {
    ...source.vocabulary!,
    partOfSpeech: '人工指定词性',
    caseSensitive: true,
    trim: false,
    acceptedAnswers: ['apple', ' Apple '],
    reverseEnabled: false,
    meaningPrompt: '',
  };
  const result = standardizeVocabulary(source)!;
  assert.equal(result.vocabulary.partOfSpeech, '人工指定词性');
  assert.equal(result.vocabulary.caseSensitive, true);
  assert.equal(result.vocabulary.trim, false);
  assert.deepEqual(result.vocabulary.acceptedAnswers, ['apple', ' Apple ']);
  assert.equal(result.vocabulary.reverseEnabled, false);
  assert.equal(result.vocabulary.meaningPrompt, '');
});

test('same-hint different-headword groups are reported without automatically merging answers or disabling reverse', (t) => {
  const store = fixture(t),
    plan = planVocabularyStandardization(store.database);
  assert.equal(plan.ambiguousHintGroups, 1);
  assert.equal(plan.ambiguousHintCards, 2);
  assert.equal(plan.counts.changedCards, 2);
  assert.deepEqual(plan.blockers, []);
  for (const change of plan.changes) {
    assert.equal(change.vocabulary.reverseEnabled, true);
    assert.deepEqual(change.vocabulary.acceptedAnswers, [change.id]);
  }
  assert.doesNotMatch(JSON.stringify(plan), /PRIVATE_NOTE_CANARY|PRIVATE_SETTINGS_CANARY/);
});

test('ORM apply is transactional and idempotent, retaining statuses, manual criteria, private data and frozen snapshots', (t) => {
  const store = fixture(t),
    db = store.database;
  const protectedBefore = new Map(
    ['study', 'papers', 'attempts', 'settings'].map((table) => [
      table,
      tableDigest(db, table as 'study'),
    ]),
  );
  const questionBefore = store.require<Question>('questions', 'apple');
  const result = applyVocabularyStandardization(db, planVocabularyStandardization(db));
  assert.equal(result.changedCards, 2);
  assert.equal(result.remainingChanges, 0);
  const after = store.require<Question>('questions', 'apple');
  assert.equal(protectedQuestionDigest(after), protectedQuestionDigest(questionBefore));
  assert.equal((after as any).unknownSourceField, 'PRESERVE_UNKNOWN');
  assert.equal(store.require<Question>('questions', 'pear').status, 'pending');
  assert.notEqual(after.updatedAt, questionBefore.updatedAt);
  for (const [table, hash] of protectedBefore)
    assert.equal(tableDigest(db, table as 'study'), hash);
  const fingerprint = tableDigest(db, 'questions');
  applyVocabularyStandardization(db, planVocabularyStandardization(db));
  assert.equal(tableDigest(db, 'questions'), fingerprint);
});

test('any concurrent edit or addition aborts a plan before writing', (t) => {
  const store = fixture(t),
    db = store.database,
    plan = planVocabularyStandardization(db);
  store.put('questions', 'apple', {
    ...store.require<Question>('questions', 'apple'),
    answerMarkdown: '刚刚修改的释义',
  });
  const before = tableDigest(db, 'questions');
  assert.throws(() => applyVocabularyStandardization(db, plan), /changed after planning/);
  assert.equal(tableDigest(db, 'questions'), before);
  const nextPlan = planVocabularyStandardization(db);
  store.put('questions', 'new', card('new'));
  assert.throws(() => applyVocabularyStandardization(db, nextPlan), /changed after planning/);
});

test('tampering with a later plan entry rolls back every earlier update and timestamp', (t) => {
  const store = fixture(t),
    db = store.database,
    plan = planVocabularyStandardization(db);
  const before = tableDigest(db, 'questions');
  assert.equal(plan.changes.length, 2);
  plan.changes[1]!.vocabulary.acceptedAnswers.push('未经确认的同义词');
  assert.throws(() => applyVocabularyStandardization(db, plan), /Plan vocabulary was altered/);
  assert.equal(tableDigest(db, 'questions'), before);
});
