import test from 'node:test';
import assert from 'node:assert/strict';
import type { QuestionInput, VocabularyData } from '../../shared/models/types.js';
import { questionSchema } from '../../server/core/validation.js';
import {
  newVocabularyData,
  prepareVocabularyEditorInput,
  previewVocabularyMatch,
  renameVocabularyHeadword,
  vocabularyTextPatch,
} from '../../web/features/questions/vocabulary-editor-state.js';

const card = (patch: Partial<VocabularyData> = {}): VocabularyData => ({
  language: 'en',
  headword: 'abandon',
  partOfSpeech: 'v.',
  meaningPrompt: '放弃原有计划或尝试',
  acceptedAnswers: ['abandon'],
  pronunciations: [],
  ...patch,
});
const question = (vocabulary = card()) =>
  ({
    ...questionSchema.parse({
      title: '自定义题目标题',
      type: 'short_answer',
      stemMarkdown: '自定义题干',
      answerMarkdown: '放弃；遗弃',
      explanationMarkdown: '例句及搭配',
      gradingRequirements: '正确解释指定动词义项。',
    }),
    vocabulary,
  }) as QuestionInput;

test('new vocabulary metadata never invents meanings or pronunciations', () => {
  const empty = newVocabularyData('');
  assert.equal(empty.headword, '');
  assert.deepEqual(empty.acceptedAnswers, []);
  assert.equal(empty.meaningPrompt, '');
  assert.deepEqual(empty.pronunciations, []);
  assert.equal(newVocabularyData('あいさつ').language, 'ja');
  assert.equal(newVocabularyData('abandon').language, 'en');
});

test('explicit generation edits only title and stem and preserves literal word/part of speech', () => {
  const value = card({ headword: ' abandon ', partOfSpeech: ' v. ' });
  assert.deepEqual(vocabularyTextPatch(value), {
    title: 'abandon',
    stemMarkdown: '请解释英语词语「abandon」（v.）的常见含义。',
  });
  assert.equal(
    vocabularyTextPatch(card({ language: 'ja', headword: '学校', partOfSpeech: '' })).stemMarkdown,
    '请解释日语词语「学校」的常见含义。',
  );
  assert.equal(Object.hasOwn(vocabularyTextPatch(value), 'answerMarkdown'), false);
  assert.equal(Object.hasOwn(vocabularyTextPatch(value), 'gradingRequirements'), false);
});

test('save preparation cleans aliases without mutating multiline drafts or rewriting meanings', () => {
  const form = question(
    card({ acceptedAnswers: ['', 'abandon', 'abandon', ' abandon ', 'give up'] }),
  );
  const before = structuredClone(form);
  const prepared = prepareVocabularyEditorInput(form);
  assert.deepEqual(form, before);
  assert.deepEqual(prepared.errors, []);
  assert.deepEqual(prepared.value.vocabulary!.acceptedAnswers, ['abandon', 'give up']);
  for (const field of [
    'title',
    'stemMarkdown',
    'answerMarkdown',
    'explanationMarkdown',
    'gradingRequirements',
  ] as const)
    assert.equal(prepared.value[field], form[field], field);
  assert.equal(prepared.value.vocabulary!.reverseEnabled, true);
  assert.equal(prepared.value.vocabulary!.caseSensitive, false);
  assert.equal(prepared.value.vocabulary!.trim, true);
});

test('save preparation safely includes renamed headword and removes mutually exclusive concept metadata', () => {
  const form = question(card({ headword: 'abandoned', acceptedAnswers: ['abandon'] }));
  form.concept = { term: '概念', meaningPrompt: '独立定义', acceptedAnswers: ['概念'] };
  const prepared = prepareVocabularyEditorInput(form);
  assert.deepEqual(prepared.value.vocabulary!.acceptedAnswers, ['abandoned', 'abandon']);
  assert.equal(prepared.value.concept, undefined);
});

test('manual rename replaces only the old primary answer and leaves explicit variants intact', () => {
  const source = card({ acceptedAnswers: ['abandon', 'ABANDON', 'give up', ''] });
  const renamed = renameVocabularyHeadword(source, 'abandoned');
  assert.deepEqual(renamed.acceptedAnswers, ['abandoned', 'ABANDON', 'give up', '']);
  assert.equal(source.headword, 'abandon');
  assert.equal(renamed.headword, 'abandoned');
  assert.equal(renamed.meaningPrompt, source.meaningPrompt);
});

test('reverse leakage blocks save while an explicitly disabled reverse accepts blank hints', () => {
  const leaking = prepareVocabularyEditorInput(
    question(card({ meaningPrompt: 'abandon 表示放弃' })),
  );
  assert.ok(leaking.errors.length > 0);
  const disabled = prepareVocabularyEditorInput(
    question(card({ reverseEnabled: false, meaningPrompt: '' })),
  );
  assert.deepEqual(disabled.errors, []);
  assert.equal(disabled.value.vocabulary!.reverseEnabled, false);
  assert.ok(questionSchema.safeParse(disabled.value).success);
});

test('preview matches actual blank grading flags and never accepts unlisted semantic alternatives', () => {
  assert.equal(previewVocabularyMatch(card(), '  ABANDON  '), true);
  assert.equal(previewVocabularyMatch(card({ caseSensitive: true }), 'ABANDON'), false);
  assert.equal(previewVocabularyMatch(card({ trim: false }), ' abandon '), false);
  assert.equal(previewVocabularyMatch(card(), 'give up'), false);
  assert.equal(previewVocabularyMatch(card({ acceptedAnswers: ['give up'] }), 'give up'), true);
  assert.equal(previewVocabularyMatch(card(), 'ａｂａｎｄｏｎ'), false);
  assert.equal(previewVocabularyMatch(card({ acceptedAnswers: ['give up'] }), 'give  up'), false);
});

test('ordinary questions bypass vocabulary preparation untouched', () => {
  const form = question();
  delete form.vocabulary;
  const prepared = prepareVocabularyEditorInput(form);
  assert.equal(prepared.value, form);
  assert.deepEqual(prepared.errors, []);
});
