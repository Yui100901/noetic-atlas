import type {Question} from '../../shared/models/types.js';
import {normalizeQuestionBlankStems} from '../../shared/questions/blank-markers.js';
import {unified} from 'unified';
import remarkParse from 'remark-parse';
const parser=unified().use(remarkParse);

/** Conservative, lossless field organization for the older Markdown import.
 * Original prose stays verbatim. Never invent explanations or factual answers. */
export function separateEmbeddedExplanation(question:Question):Question {
  if(question.explanationMarkdown.trim()||!question.answerMarkdown.trim())return question;
  const match=question.answerMarkdown.match(/\n\n(?=\*\*(?:机制|原理|展开说明|追问|误区|常见误区|分析与|验证|权衡|设计权衡|核对|补充核对|自测|参考依据|参考：|参考\*\*|例子)[^\n*]{0,80}\*\*)/);
  if(!match||match.index===undefined)return question;
  // Only a real top-level paragraph boundary is safe. Text inside fenced code,
  // blockquotes, lists or HTML samples is not an imported section delimiter.
  const tree=parser.parse(question.answerMarkdown);
  if(!tree.children.some(node=>node.type==='paragraph'&&node.position?.start.offset===match.index!+2))return question;
  const answer=question.answerMarkdown.slice(0,match.index),explanation=question.answerMarkdown.slice(match.index+2);
  if(answer.trim().length<8||explanation.trim().length<12)return question;
  return{...question,answerMarkdown:answer,explanationMarkdown:explanation};
}
export function normalizeBankEditorial(question:Question) {
  return separateEmbeddedExplanation(normalizeQuestionBlankStems(question));
}
