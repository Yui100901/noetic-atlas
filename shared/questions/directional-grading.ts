/** A reverse card is an objective blank, not a semantic explanation question.
 * Derive its displayed rule from the same immutable aliases and normalization
 * flags used by the scorer instead of maintaining another editable policy. */
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : [];

function card(value: unknown) {
  const question = object(value);
  if (question.type === 'group') return null;
  const vocabulary = object(question.vocabulary),
    concept = object(question.concept);
  if (text(vocabulary.headword))
    return {
      question,
      kind: 'vocabulary' as const,
      target: text(vocabulary.headword),
      answers: strings(vocabulary.acceptedAnswers),
      reverseEnabled: vocabulary.reverseEnabled !== false,
      trim: vocabulary.trim !== false,
      caseSensitive: vocabulary.caseSensitive === true,
    };
  if (text(concept.term))
    return {
      question,
      kind: 'concept' as const,
      target: text(concept.term),
      answers: strings(concept.acceptedAnswers),
      reverseEnabled: true,
      trim: true,
      caseSensitive: false,
    };
  return null;
}

/** Escape control characters visibly without adding quote characters to the
 * answer. Variable backtick fences and padding preserve literal Markdown names. */
function literal(value: string): string {
  const visible = value.replace(/[\u0000-\u001f\u007f]/g, (character) =>
    character.charCodeAt(0) === 127 ? '\\u007f' : JSON.stringify(character).slice(1, -1),
  );
  const runs = visible.match(/`+/g) || [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  const padding = /^[ `]|[ `]$/.test(visible) ? ' ' : '';
  return `${fence}${padding}${visible}${padding}${fence}`;
}

export function isDirectionalCard(value: unknown): boolean {
  return !!card(value);
}
export function forwardCardGradingTitle(value: unknown): string {
  const data = card(value);
  return data
    ? `正向判题标准：看${data.kind === 'concept' ? '概念' : '词语'}写释义`
    : '本题判题要求';
}
export function reverseCardGradingTitle(value: unknown): string {
  const data = card(value);
  return `逆向判题规则：看${data?.kind === 'concept' ? '描述写概念' : '释义写词语'}`;
}

export function reverseCardGradingRequirements(value: unknown): string {
  const data = card(value);
  if (!data) return '';
  if (data.question.type !== 'fill_blank' && !data.reverseEnabled) return '本词卡已关闭逆向练习。';
  const { question, target, answers, kind } = data;
  const blanks =
    question.type === 'fill_blank' && Array.isArray(question.blanks)
      ? question.blanks.map(object).map((blank) => ({
          answers: strings(blank.answers),
          trim: blank.trim === true,
          caseSensitive: blank.caseSensitive === true,
        }))
      : [{ answers, trim: data.trim, caseSensitive: data.caseSensitive }];
  // Before submission, public blank snapshots omit aliases. Do not substitute
  // live-source rules for a hidden or incomplete answer snapshot.
  if (!blanks.length || blanks.some((blank) => !blank.answers.length)) return '';
  const lines = [`- 目标${kind === 'concept' ? '概念' : '词语'}：${literal(target)}。`];
  blanks.forEach((blank, index) => {
    const label = blanks.length > 1 ? `第 ${index + 1} 空` : '';
    lines.push(`- ${label}可接受答案：${blank.answers.map(literal).join('、')}。`);
    lines.push(
      `- ${label}匹配规则：${blank.trim ? '去掉首尾空白' : '保留首尾空白'}，${blank.caseSensitive ? '区分大小写' : '字母转小写后比较'}；其余字符须完全一致，词内空白不合并，不转换全角／半角。`,
    );
  });
  lines.push(
    `- 未列出的${kind === 'concept' ? '别称或近义概念' : '同义词、其他词形'}不自动判对；逆向按客观填空核对，不采用释义相近或部分正确判定。`,
  );
  return lines.join('\n');
}

export const buildReverseRubric = reverseCardGradingRequirements;
