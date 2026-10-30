import { hasMath } from '../math/markdown.js';
import type { QuestionInput } from '../models/types.js';

export const AI_MATH_INSTRUCTIONS =
  '专业表达使用标准LaTeX：行内 $...$，独立公式 $$ 换行 ... 换行 $$，化学式与反应使用 \\ce{...}，单位使用 \\mathrm{...}。不要使用HTML、图片替代公式或自定义宏。数学符号保留变量含义、单位和适用条件，不擅自改写源文事实。JSON中的每个反斜杠必须转义为两个反斜杠，不输出非法JSON转义。普通金额的美元符号使用Markdown转义。生成或修改题目使用公式时须设置mathEnabled:true；没有公式时可省略此字段。只有输出约定支持题目对象时才输出该字段，其它任务严格遵守各自字段约定。';
/** Only newly generated AI content is detected. Saved/legacy human content
 * requires an explicit opt-in; currency and code are never bulk converted. */
export function containsAiMath(value: unknown): boolean {
  if (typeof value === 'string') return hasMath(value);
  if (Array.isArray(value)) return value.some(containsAiMath);
  return !!value && typeof value === 'object' && Object.values(value).some(containsAiMath);
}
export function prepareAiQuestionMath<T extends QuestionInput>(question: T): T {
  const fields = [
    question.stemMarkdown,
    question.answerMarkdown,
    question.explanationMarkdown,
    ...question.options.map((option) => option.text),
  ];
  return {
    ...question,
    ...(question.mathEnabled === undefined && fields.some(hasMath) ? { mathEnabled: true } : {}),
    ...(question.parts
      ? {
          parts: question.parts.map((part) => ({
            ...part,
            ...(part.mathEnabled === undefined &&
            [
              part.stemMarkdown,
              part.answerMarkdown,
              part.explanationMarkdown,
              ...part.options.map((option) => option.text),
            ].some(hasMath)
              ? { mathEnabled: true }
              : {}),
          })),
        }
      : {}),
  };
}
