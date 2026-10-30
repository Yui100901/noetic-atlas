import katex from 'katex';
import 'katex/contrib/mhchem';
import { MATH_LIMITS, mathExpressions, mathDelimiterErrors } from './markdown.js';

export const mathOptions = {
  trust: false,
  strict: 'ignore' as const,
  maxExpand: MATH_LIMITS.maxExpand,
  maxSize: MATH_LIMITS.maxSize,
  globalGroup: false,
  output: 'htmlAndMathml' as const,
};
export type FormulaResult = { ok: true; html: string } | { ok: false; message: string };
const cache = new Map<string, FormulaResult>();
let cacheCharacters = 0;
/** Fresh macro state for each expression: user definitions never escape to a
 * different question. Both the input and retained output have hard bounds. */
export function renderFormula(source: string, display = false): FormulaResult {
  const key = JSON.stringify([display, source]),
    hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let result: FormulaResult;
  if (!source.trim()) result = { ok: false, message: '公式内容为空' };
  else if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source))
    result = { ok: false, message: '公式包含控制字符；JSON中的LaTeX反斜杠需要双写转义' };
  else if (source.length > MATH_LIMITS.sourceCharacters)
    result = {
      ok: false,
      message: `单个公式最多${MATH_LIMITS.sourceCharacters}字符，请拆分表达式`,
    };
  else if (
    /\\(?:href|url|includegraphics|html\w*|def|gdef|edef|xdef|global|newcommand|renewcommand|let|futurelet|require|input|include)\b/.test(
      source,
    )
  )
    result = { ok: false, message: '公式中不支持外部资源、HTML或自定义宏命令' };
  else
    try {
      result = {
        ok: true,
        html: katex.renderToString(source, {
          ...mathOptions,
          displayMode: display,
          throwOnError: true,
          macros: {},
        }),
      };
    } catch (error) {
      result = {
        ok: false,
        message: ((error as Error).message || '公式语法无效')
          .replace(/^KaTeX parse error:\s*/, '')
          .slice(0, 500),
      };
    }
  const size = source.length + (result.ok ? result.html.length : result.message.length);
  if (size <= MATH_LIMITS.cacheCharacters) {
    cache.set(key, result);
    cacheCharacters += size;
    while (cache.size > MATH_LIMITS.cacheEntries || cacheCharacters > MATH_LIMITS.cacheCharacters) {
      const oldest = cache.entries().next().value!;
      cache.delete(oldest[0]);
      cacheCharacters -=
        JSON.parse(oldest[0])[1].length +
        (oldest[1].ok ? oldest[1].html.length : oldest[1].message.length);
    }
  }
  return result;
}
export function inspectMathMarkdown(
  text: string,
): Array<{ source: string; message: string; offset: number }> {
  const expressions = mathExpressions(text),
    issues = expressions.slice(0, MATH_LIMITS.expressionsPerField).flatMap((item) => {
      if (!item.closed)
        return [{ source: item.source, message: '公式分隔符未闭合', offset: item.start }];
      const result = renderFormula(item.source, item.display);
      return result.ok
        ? []
        : [{ source: item.source, message: result.message, offset: item.start }];
    });
  if (expressions.length > MATH_LIMITS.expressionsPerField)
    issues.push({
      source: '',
      message: `单个字段最多排版${MATH_LIMITS.expressionsPerField}个公式，请拆分内容`,
      offset: expressions[MATH_LIMITS.expressionsPerField]!.start,
    });
  return [
    ...issues,
    ...mathDelimiterErrors(text).map((item) => ({
      source: text.slice(item.start, item.start + 100),
      message: item.message,
      offset: item.start,
    })),
  ].slice(0, 12);
}
