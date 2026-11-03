import type { QuestionInput, VocabularyData } from '../../../shared/models/types';
import { normalizeVocabularyData, vocabularyIssues } from '../../../shared/questions/vocabulary';
import { getObjectiveCorrect } from '../../../shared/questions/question-utils';

/** A blank editor value deliberately invents no pronunciations or meanings. */
export function newVocabularyData(title: string): VocabularyData {
  const headword = title.trim();
  return {
    language: /[\u3040-\u30ff]/u.test(headword) ? 'ja' : 'en',
    headword,
    partOfSpeech: '',
    meaningPrompt: '',
    acceptedAnswers: headword ? [headword] : [],
    pronunciations: [],
    reverseEnabled: true,
    caseSensitive: false,
    trim: true,
  };
}

/** Users explicitly apply this patch; ordinary field edits never rewrite prose. */
export function vocabularyTextPatch(
  value: VocabularyData,
): Pick<QuestionInput, 'title' | 'stemMarkdown'> {
  const headword = value.headword.trim();
  const language = value.language === 'ja' ? '日语' : '英语';
  const part = value.partOfSpeech?.trim() ? `（${value.partOfSpeech.trim()}）` : '';
  return {
    title: headword,
    stemMarkdown: `请解释${language}词语「${headword}」${part}的常见含义。`,
  };
}

/** Renaming replaces only the old primary spelling, keeping authored variants.
 * This prevents an unrelated former headword remaining a correct answer. */
export function renameVocabularyHeadword(value: VocabularyData, headword: string): VocabularyData {
  return {
    ...value,
    headword,
    acceptedAnswers: [
      headword,
      ...value.acceptedAnswers.filter((answer) => answer !== value.headword),
    ],
  };
}

/** Keep the multiline draft untouched while typing; normalize only on save. */
export function prepareVocabularyEditorInput(form: QuestionInput): {
  value: QuestionInput;
  errors: string[];
} {
  if (!form.vocabulary) return { value: form, errors: [] };
  const vocabulary = normalizeVocabularyData(form.vocabulary);
  const errors = vocabularyIssues(vocabulary)
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.message);
  return { value: { ...form, vocabulary, concept: undefined }, errors };
}

/** The authoring preview uses the same literal blank scorer as real attempts. */
export function previewVocabularyMatch(value: VocabularyData, answer: string): boolean {
  const vocabulary = normalizeVocabularyData(value);
  return getObjectiveCorrect(
    {
      type: 'fill_blank',
      blanks: [
        {
          id: 'word',
          label: '词语',
          answers: vocabulary.acceptedAnswers,
          caseSensitive: vocabulary.caseSensitive === true,
          trim: vocabulary.trim !== false,
        },
      ],
    },
    { value: [answer] },
  );
}
