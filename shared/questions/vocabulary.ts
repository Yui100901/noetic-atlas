import type { VocabularyData } from '../models/types.js';

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en').trim();
const clean = (value: string) => value.normalize('NFC').trim();
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lossless authoring cleanup. Never infer readings, meanings or synonyms, nor
 * fold compatibility characters/case: objective matching preserves those. */
export function normalizeVocabularyData(value: VocabularyData): VocabularyData {
  const headword = clean(value.headword);
  const trim = value.trim !== false;
  const acceptedAnswers = [
    ...new Set(
      [headword, ...value.acceptedAnswers]
        .map((answer) => (trim ? clean(answer) : answer.normalize('NFC')))
        .filter((answer) => !!answer.trim()),
    ),
  ];
  return {
    ...value,
    headword,
    ...(value.partOfSpeech !== undefined ? { partOfSpeech: clean(value.partOfSpeech) } : {}),
    meaningPrompt: clean(value.meaningPrompt),
    acceptedAnswers,
    reverseEnabled: value.reverseEnabled !== false,
    caseSensitive: value.caseSensitive === true,
    trim,
    pronunciations: value.pronunciations
      .map((item) => ({
        ...item,
        label: clean(item.label),
        ...(item.ipa !== undefined ? { ipa: clean(item.ipa) || undefined } : {}),
        ...(item.kana !== undefined ? { kana: clean(item.kana) || undefined } : {}),
        ...(item.romaji !== undefined ? { romaji: clean(item.romaji) || undefined } : {}),
        sourceLabel: clean(item.sourceLabel),
        sourceUrl: clean(item.sourceUrl),
        license: clean(item.license),
      }))
      .filter((item) =>
        [
          item.label,
          item.ipa,
          item.kana,
          item.romaji,
          item.sourceLabel,
          item.sourceUrl,
          item.license,
        ].some(Boolean),
      ),
  };
}

/** Reject literal answers/readings, links and hidden material. Hints are
 * separately authored glosses, never the original explanation reversed. */
export function vocabularyPromptIsSafe(value: VocabularyData): boolean {
  const prompt = normalize(value.meaningPrompt);
  if (!prompt || /https?:|#\/|!\[|\[[^\]]*\]\s*(?:\(|\[)|<[^>]*>|```|~~~/.test(prompt))
    return false;
  const forbidden = [
    value.headword,
    ...value.acceptedAnswers,
    ...value.pronunciations.flatMap((item) =>
      [item.ipa, item.kana, item.romaji].filter(
        (item): item is string => typeof item === 'string' && !!item,
      ),
    ),
  ];
  return forbidden.every((raw) => {
    const token = normalize(raw).replace(/^\/|\/$/g, '');
    if (!token) return true;
    return /^[a-z0-9' -]+$/i.test(token)
      ? !new RegExp(`(^|[^a-z0-9])${escaped(token)}($|[^a-z0-9])`, 'i').test(prompt)
      : !prompt.includes(token);
  });
}

export interface VocabularyIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export function vocabularySourceUrlIsValid(value: string): boolean {
  if (!value) return true;
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Shared editor/API/quality checks. Missing readings are a helpful authoring
 * reminder, not an invalid question; provenance fields are optional. */
export function vocabularyIssues(value: VocabularyData): VocabularyIssue[] {
  const issues: VocabularyIssue[] = [];
  const error = (code: string, message: string) =>
    issues.push({ code, message, severity: 'error' as const });
  if (!value.headword.trim()) error('headword_empty', '请填写词条。');
  if (!value.acceptedAnswers.some((answer) => answer === value.headword))
    error('headword_missing', '可接受答案须包含精确词条。');
  if (value.acceptedAnswers.some((answer) => !answer.trim()))
    error('answer_empty', '可接受答案不能是空白。');
  if (value.acceptedAnswers.length > 30) error('answers_limit', '可接受答案最多30项。');
  if (value.reverseEnabled !== false && !vocabularyPromptIsSafe(value))
    error(
      'reverse_prompt_unsafe',
      '启用逆向时，独立释义提示必须非空，且不能含词条、已收录答案、读音或链接。',
    );
  if (!value.pronunciations.length)
    issues.push({
      code: 'pronunciation_missing',
      message: '尚未填写读音，可稍后补充。',
      severity: 'warning',
    });
  value.pronunciations.forEach((item, index) => {
    if (!item.label.trim()) error('pronunciation_label', `第${index + 1}条读音需填写名称。`);
    const present = (reading: unknown) => typeof reading === 'string' && !!reading.trim();
    if (value.language === 'en' ? !present(item.ipa) : !present(item.kana) || !present(item.romaji))
      error(
        'pronunciation_incomplete',
        `第${index + 1}条读音：${value.language === 'en' ? '请填写IPA音标' : '请同时填写假名和罗马音'}。`,
      );
    if (!vocabularySourceUrlIsValid(item.sourceUrl))
      error('pronunciation_source', `第${index + 1}条读音来源仅支持HTTP(S)链接，也可以留空。`);
  });
  return issues;
}

export function vocabularyPronunciationMarkdown(value?: VocabularyData): string {
  if (!value?.pronunciations.length) return '';
  return (
    '### 读音\n\n' +
    value.pronunciations
      .map(
        (item) =>
          `- **${item.label}**：${value.language === 'en' ? item.ipa || '' : [item.kana, item.romaji].filter(Boolean).join(' · ')}${item.method === 'expanded' ? '（展开读法）' : item.method === 'manual' ? '（补充核对）' : ''}`,
      )
      .join('\n')
  );
}
