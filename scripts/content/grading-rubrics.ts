import type { Question, QuestionPart } from '../../shared/models/types.js';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

/** A rubric contains evidence from this question, not a reusable grading lecture.
 * The AST keeps source code, tables and equations out of prose/list rewrites. */
export const RUBRIC_GENERATOR_VERSION = '2026-11-03.4';
export type RubricProfile =
  | 'vocabulary'
  | 'concept'
  | 'idiom'
  | 'chemical'
  | 'medical'
  | 'traditional_medicine'
  | 'legal'
  | 'essay'
  | 'general';
type Subject = Question | QuestionPart;
type Node = {
  type: string;
  value?: string;
  lang?: string | null;
  meta?: string | null;
  children?: Node[];
  ordered?: boolean | null;
  start?: number | null;
  depth?: number;
  position?: { start: { offset?: number; column: number }; end: { offset?: number } };
};
type Block = {
  heading: string;
  markdown: string;
  text: string;
  kind: string;
  partOfSpeech?: string;
};
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const subjective = (value: Subject) => value.type === 'short_answer' || value.type === 'essay';
const metadataHeading =
  /^(?:来源|参考资料|书证|版权|许可|学习|数据许可|数据说明|名称与缩写|读音来源|相关|关联|同音|其他词形|追问|扩展阅读|核验日期|审核|自测|练习|理解与追问)/;
const boundaryHeading =
  /辨析|边界|误区|禁忌|注意|安全|不良反应|相互作用|禁混|风险|合用|配伍|限制|条件/;
const scoreHeading = /评分量规|评分标准|评分要点|得分点/;
const standaloneHeading =
  /^(?:回答|答案|参考答案|机制与例子|误区辨析|原理|定义|性质|用途|作用|机制|风险|关键风险与禁混边界|物质身份与实际产品|常见误区|解析|词性|读音|English definition.*|English meaning.*|英文.*(?:释义|含义).*|中文.*(?:释义|含义).*|使用方式.*|传统.*|注意.*|主要.*|功效.*|药用.*|性味.*|归经.*|组成.*|典故.*|出处.*|评分.*|来源.*|关联.*|相关.*|同音.*|其他词形.*|学习.*|数据.*|审核.*|自测.*)$/;
const vagueSource =
  /^(?:围绕.+及题干明确要求评价|核对必要点中的|必须保留定义中区分相近概念的|按题干所问区分物质身份|按题干要求分别核对类别|正确：覆盖题干要求的核心要点|若题集启用计分|解释上述反应时|不要把纯物质化学式当作商品完整配方|用途是知识性示例|本卡中文由项目原创整理)/;
const emptyText =
  /^(?:无|暂无|无资料|待补充|未列明|所核对条目未列明|来源未提供(?:相关信息)?|未提供|未知|不详|待考证|【缺失】来源未提供)[。.!！]*$/;
const answerLabels = /^(?:回答|参考答案|答案说明|答案)[：:]?$/;

function text(node: Node): string {
  if (node.type === 'image' || node.type === 'imageReference') return '';
  return node.value ?? (node.children || []).map(text).join('');
}
function label(value: string) {
  return value.trim().replace(/[：:]\s*$/, '');
}
function raw(node: Node, source: string) {
  const start = node.position?.start.offset,
    end = node.position?.end.offset;
  if (start === undefined || end === undefined) return node.value || '';
  const value = source.slice(start, end),
    indent = (node.position?.start.column || 1) - 1;
  if (!indent) return value;
  return value
    .split('\n')
    .map((line, index) => (index ? line.replace(new RegExp(`^ {0,${indent}}`), '') : line))
    .join('\n');
}
function fence(value: string, language = '') {
  const longest = Math.max(2, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const marker = '`'.repeat(longest + 1);
  return `${marker}${language}\n${value}\n${marker}`;
}
function inline(node: Node, source: string): string {
  if (node.type === 'image' || node.type === 'imageReference') return '';
  if (node.type === 'html') {
    const value = node.value || raw(node, source);
    const marker = '`'.repeat(
      Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length)) + 1,
    );
    return marker + value + marker;
  }
  if (node.type === 'link' || node.type === 'linkReference')
    return (node.children || []).map((child) => inline(child, source)).join('');
  return raw(node, source);
}
function render(node: Node, source: string): string {
  if (node.type === 'list') return renderList(node, source);
  if (node.type === 'code')
    return fence(node.value || '', [node.lang, node.meta].filter(Boolean).join(' '));
  if (node.type === 'math') return `$$\n${node.value || ''}\n$$`;
  if (node.type === 'html') return fence(node.value || '', 'html');
  if (node.type === 'blockquote')
    return (node.children || [])
      .map((child) => render(child, source))
      .filter(Boolean)
      .join('\n\n')
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
  if (node.type === 'paragraph')
    return (node.children || [])
      .map((child) => inline(child, source))
      .join('')
      .trim();
  return raw(node, source).trim();
}
function renderList(node: Node, source: string): string {
  const items: Node[] = [];
  const add = (item: Node) => {
    const children = (item.children || []).filter(
      (child) => text(child).trim() || ['code', 'table', 'math', 'list'].includes(child.type),
    );
    // An empty numbered parent wrapping only another list is not a new point.
    if (children.length === 1 && children[0]!.type === 'list') {
      for (const child of children[0]!.children || []) add(child);
      return;
    }
    items.push({ ...item, children });
  };
  for (const item of node.children || []) add(item);
  return items
    .flatMap((item) => {
      const parts = (item.children || [])
        .map((child) => render(child, source))
        .filter((value) => substantive(value));
      if (!parts.length) return [];
      const value = parts.join('\n\n');
      return ['- ' + value.replace(/\n/g, '\n  ')];
    })
    .join('\n');
}
function substantive(value: string) {
  return !!value.trim() && !/^[\s.。…，,；;：:、]+$/.test(value);
}
function bodyEmpty(value: string, heading = '') {
  let body = value.trim();
  if (heading && body.startsWith(heading))
    body = body.slice(heading.length).replace(/^[：:]\s*/, '');
  return !substantive(body) || emptyText.test(body);
}
function splitInlineHeading(
  node: Node,
  source: string,
): { heading: string; markdown: string } | null {
  const first = node.children?.[0];
  if (first?.type !== 'strong') return null;
  const name = text(first).trim(),
    after = node.children?.slice(1) || [];
  const following = after.map(text).join('');
  const hasColon = /[：:]$/.test(name) || /^\s*[：:]/.test(following);
  if (!hasColon) return null;
  return {
    heading: label(name),
    markdown: after
      .map((child) => inline(child, source))
      .join('')
      .replace(/^\s*[：:]\s*/, '')
      .trim(),
  };
}
function contentBlocks(markdown: string): Block[] {
  const tree = parser.parse(markdown) as Node,
    blocks: Block[] = [];
  let heading = '',
    partOfSpeech = '';
  for (const node of tree.children || []) {
    if (node.type === 'heading') {
      heading = label(text(node));
      continue;
    }
    if (
      node.type === 'paragraph' &&
      node.children?.length === 1 &&
      node.children[0]!.type === 'strong'
    ) {
      const lexical =
        /^((?:noun|verb|adjective(?: satellite)?|adverb|adj\.?|adv\.?|n\.?|v\.?)\s*\/\s*[^·\n]+)\s*·\s*\d{8}-[nvars]$/i.exec(
          text(node).trim(),
        );
      if (lexical) {
        partOfSpeech = lexical[1]!.trim();
        heading = '';
        continue;
      }
    }
    if (node.type === 'definition' || node.type === 'thematicBreak') continue;
    if (
      node.type === 'paragraph' &&
      node.children?.length === 1 &&
      node.children[0]!.type === 'strong' &&
      (standaloneHeading.test(label(text(node))) ||
        metadataHeading.test(label(text(node))) ||
        boundaryHeading.test(label(text(node))) ||
        scoreHeading.test(label(text(node))))
    ) {
      heading = label(text(node));
      continue;
    }
    const strongNamed = node.type === 'paragraph' ? splitInlineHeading(node, markdown) : null;
    const rendered = render(node, markdown);
    const plainNamed =
      node.type === 'paragraph'
        ? /^(English(?: definition| meaning)?|中文(?:主要)?(?:释义|含义|义项)|英文(?:主要)?(?:释义|含义)|词性|读音)\s*[:：]\s*([\s\S]*)$/i.exec(
            rendered,
          )
        : null;
    const named =
      strongNamed ||
      (plainNamed ? { heading: plainNamed[1]!, markdown: plainNamed[2]!.trim() } : null);
    const current = named?.heading || heading;
    let value = named?.markdown ?? rendered;
    if (/^(?:词性|POS|part of speech)$/i.test(current) && value) partOfSpeech = value;
    // Drop only a duplicated known field label, not arbitrary punctuation.
    if (current && value.startsWith(current + '：')) value = value.slice(current.length + 1).trim();
    if (current && value.startsWith(current + ':')) value = value.slice(current.length + 1).trim();
    if (metadataHeading.test(current)) continue;
    if (!value || bodyEmpty(value, current) || vagueSource.test(value) || /^【缺失】/.test(value))
      continue;
    blocks.push({
      heading: current,
      markdown: value,
      text: named ? value : text(node),
      kind: node.type,
      ...(partOfSpeech ? { partOfSpeech } : {}),
    });
  }
  return blocks;
}
function withLabel(block: Block): Block {
  if (!block.heading || answerLabels.test(block.heading)) return block;
  if (['list', 'code', 'table', 'math', 'blockquote'].includes(block.kind))
    return { ...block, markdown: `**${block.heading}**\n\n${block.markdown}` };
  return { ...block, markdown: `${block.heading}：${block.markdown}` };
}
function renderBlocks(blocks: Block[]): string {
  return blocks
    .map((block) =>
      ['list', 'code', 'table', 'math', 'html', 'blockquote'].includes(block.kind) ||
      (block.markdown.startsWith('**') && block.markdown.includes('\n\n'))
        ? block.markdown
        : `- ${block.markdown.replace(/\n/g, '\n  ')}`,
    )
    .join('\n\n');
}
function profile(question: Question, subject: Subject, domains: string[]): RubricProfile {
  if (subject.type === 'essay') return 'essay';
  if (question.vocabulary) return 'vocabulary';
  if (
    domains.some((name) => /化学/.test(name)) &&
    (/^CHEM-(?:ORG|INORG|IND|FOOD)-/.test(question.id) ||
      /(?:性质|反应).*(?:用途|使用)/.test(subject.stemMarkdown))
  )
    return 'chemical';
  if (
    question.concept ||
    /(?:概念定义|具体含义|解释该术语|使用边界)/.test(subject.answerMarkdown + subject.stemMarkdown)
  )
    return 'concept';
  if (
    /^ZH-I-|^成语[：:]/.test(question.id + ' ' + subject.title) ||
    /解释成语/.test(subject.stemMarkdown)
  )
    return 'idiom';
  if (
    domains.some((name) => /医学|药学/.test(name)) &&
    (/传统药性|传统效能|中草药|中药|药材|饮片|中成药|方剂/.test(
      subject.stemMarkdown + subject.title,
    ) ||
      /^MED26-(?:HERB|FORM)-/.test(question.id))
  )
    return 'traditional_medicine';
  if (
    domains.some((name) => /医学|药学/.test(name)) &&
    /机制|药理|作用|药物|禁忌|毒/.test(subject.stemMarkdown)
  )
    return 'medical';
  if (
    /物质名称|代表反应|常见反应|化学式/.test(subject.stemMarkdown) &&
    domains.some((name) => /化学/.test(name))
  )
    return 'chemical';
  if (
    domains.some((name) => /驾驶|法学/.test(name)) &&
    /本条|规定|法规|法律|第.+条/.test(subject.stemMarkdown)
  )
    return 'legal';
  return 'general';
}
function vocabularyMetadata(block: Block) {
  return /WordNet\s*(?:框架|frame)|义项\s*\d{6,}|(?:某人|sb\.?|somebody)\s*[+＋]\s*(?:动词|v\.?|verb)/i.test(
    block.markdown,
  );
}
function vocabularyEvidence(
  question: Question,
  subject: Subject,
  answer: Block[],
  explanation: Block[],
) {
  const available = [...answer, ...explanation].filter((block) => !vocabularyMetadata(block));
  const english = available.filter((block) =>
    /^English(?:\s+(?:definition|meaning))?$|英文.*(?:释义|含义)|英语.*释义/i.test(block.heading),
  );
  const chinese = available.filter((block) => /中文.*(?:释义|含义|义项)/.test(block.heading));
  let meaning = english.length ? english : chinese;
  if (!meaning.length && question.vocabulary?.meaningPrompt)
    meaning = [
      {
        heading: '',
        markdown: question.vocabulary.meaningPrompt,
        text: question.vocabulary.meaningPrompt,
        kind: 'paragraph',
      },
    ];
  if (!meaning.length)
    meaning = answer.filter((block) => !/(?:词性|读音|发音)/.test(block.heading));
  const stem = subject.stemMarkdown;
  const asksPartOfSpeech = /词性|part of speech/i.test(stem);
  const selected = meaning.map((block) =>
    asksPartOfSpeech && block.partOfSpeech
      ? withLabel({ ...block, heading: block.partOfSpeech })
      : { ...block, heading: '' },
  );
  if (asksPartOfSpeech && !meaning.some((block) => block.partOfSpeech))
    selected.push(
      ...available
        .filter((block) => /^(?:词性|POS|part of speech)$/i.test(block.heading))
        .map(withLabel),
    );
  if (/读音|音标|发音|假名|罗马音/.test(stem))
    selected.push(
      ...available
        .filter((block) => /^(?:读音|音标|发音|假名|罗马音)/.test(block.heading))
        .map(withLabel),
    );
  if (/使用方式|搭配|用法/.test(stem))
    selected.push(
      ...available
        .filter((block) => /^(?:使用方式|常用搭配|用法)/.test(block.heading))
        .map(withLabel),
    );
  return selected;
}
function evidence(question: Question, subject: Subject) {
  const answer = contentBlocks(subject.answerMarkdown || ''),
    explanation = contentBlocks(subject.explanationMarkdown || '');
  let points = question.vocabulary
    ? vocabularyEvidence(question, subject, answer, explanation)
    : answer.map(withLabel);
  const idiom =
    /^ZH-I-|^成语[：:]/.test(question.id + ' ' + subject.title) ||
    /解释成语/.test(subject.stemMarkdown);
  if (idiom)
    points = points
      .filter((block) => !/拼音|读音/.test(block.heading) || /拼音|读音/.test(subject.stemMarkdown))
      .filter(
        (block) => !/字形|词形/.test(block.heading) || /字形|词形/.test(subject.stemMarkdown),
      );
  const requested: Array<[RegExp, RegExp]> = [
    [/传统适用|适用线索|适应证|主治|主证/, /传统适应证|适用|适应证|主治|主证/],
    [/药性|性味|归经/, /性味|归经/],
    [/药用部位/, /药用部位/],
    [/组成|成分/, /组成|成分/],
    [/纯物质|实际产品|商品|纯度/, /物质身份|实际产品|纯度|质量要求/],
    [/典故|出处|词源/, /典故|出处|词源/],
  ];
  if (!question.vocabulary)
    for (const [ask, field] of requested)
      if (ask.test(subject.stemMarkdown))
        points.push(...explanation.filter((block) => field.test(block.heading)).map(withLabel));
  if (!points.length && !question.vocabulary)
    points = explanation
      .filter(
        (block) =>
          !boundaryHeading.test(block.heading) &&
          !scoreHeading.test(block.heading) &&
          (!idiom || /寓意|释义|含义|使用语境/.test(block.heading)),
      )
      .slice(0, 4)
      .map(withLabel);
  const formulaQuestion =
    /分子式/.test(subject.title) || /(?:解释|什么是|何为).{0,10}分子式/.test(subject.stemMarkdown);
  const formulaBoilerplate = (value: string) =>
    /分子式(?:仅|只|给出|表示).{0,45}(?:元素|计数|组成)|(?:化学式|分子式).{0,40}(?:不一定|不能|不唯一).{0,12}结构/.test(
      value,
    );
  let boundaries = question.vocabulary
    ? []
    : explanation
        .filter(
          (block) =>
            boundaryHeading.test(block.heading) &&
            !scoreHeading.test(block.heading) &&
            (formulaQuestion || !formulaBoilerplate(block.markdown)),
        )
        .map(withLabel);
  if (
    !question.vocabulary &&
    !boundaries.length &&
    explanation.length === 1 &&
    !explanation[0]!.heading &&
    explanation[0]!.markdown.length <= 650
  )
    boundaries = [explanation[0]!];
  const dedupe = (values: Block[]) =>
    values.filter(
      (block, index) => values.findIndex((value) => value.markdown === block.markdown) === index,
    );
  points = dedupe(points);
  boundaries = dedupe(boundaries).filter(
    (block) => !points.some((point) => point.markdown === block.markdown),
  );
  const scales = explanation
    .filter(
      (block) =>
        scoreHeading.test(block.heading) || /^(?:评分量规|评分标准)[：:]/.test(block.markdown),
    )
    .map(withLabel);
  const missingMeaning =
    idiom &&
    /含义|寓意|意思|释义|解释成语/.test(subject.stemMarkdown) &&
    !points.some((block) => !/拼音|读音|字形|词形|典故|出处|词源/.test(block.heading));
  return {
    points,
    boundaries,
    scales: dedupe(scales),
    missingMeaning,
    noEvidence: !points.length || missingMeaning,
  };
}

export function buildSubjectiveRubric(
  question: Question,
  subject: Subject = question,
  domains: string[] = [],
) {
  if (!subjective(subject)) throw new Error('Only subjective questions have generated rubrics');
  const source = evidence(question, subject),
    sections: string[] = [];
  if (source.noEvidence)
    sections.push(
      source.missingMeaning
        ? '### 参考依据不足\n\n本题未提供可核对的成语释义；拼音、字形或省略号不能作为含义答案。须先补齐释义参考，暂不判定释义回答的正确性。'
        : '### 参考依据不足\n\n本题没有可用的参考解答；须先由人工补齐答案，暂不生成正确或部分正确的判定标准。',
    );
  else {
    if (question.vocabulary) {
      const allSenses = /(?:全部|所有).{0,6}(?:义项|含义)|(?:义项|含义).{0,6}(?:全部|逐一)/.test(
        subject.stemMarkdown,
      );
      const scope = allSenses ? '本题要求下列全部义项。' : '下列义项任选一项即可。';
      const pos = /词性|part of speech/i.test(subject.stemMarkdown)
        ? '同时注明所选义项对应的词性。'
        : '';
      sections.push(
        '### 正向释义核对依据\n\n' +
          scope +
          '用中文或英文表达同一含义，不要求逐字复述或中英重复。' +
          pos +
          '\n\n' +
          renderBlocks(source.points),
      );
    } else sections.push('### 必要核对点\n\n' + renderBlocks(source.points));
    if (source.boundaries.length)
      sections.push('### 条件与易错结论\n\n' + renderBlocks(source.boundaries));
    if (source.scales.length) sections.push('### 原文评分量规\n\n' + renderBlocks(source.scales));
  }
  const gradingRequirements = sections.join('\n\n');
  if (gradingRequirements.length > 10000)
    throw new Error(`Rubric exceeds 10000 characters: ${question.id}/${subject.id}`);
  return {
    gradingRequirements,
    profile: profile(question, subject, domains),
    noEvidence: source.noEvidence,
    evidencePoints: source.points.length,
    boundaryPoints: source.boundaries.length,
  };
}

export function supplementQuestionRubrics(
  question: Question,
  domains: string[] = [],
  shouldRefresh?: (subject: Subject, partId?: string) => boolean,
) {
  const generated: {
    partId?: string;
    gradingRequirements: string;
    profile: RubricProfile;
    noEvidence: boolean;
    evidencePoints: number;
    boundaryPoints: number;
  }[] = [];
  let result = question;
  if (
    subjective(question) &&
    (!question.gradingRequirements?.trim() || shouldRefresh?.(question))
  ) {
    const rubric = buildSubjectiveRubric(question, question, domains);
    if (rubric.gradingRequirements !== question.gradingRequirements) {
      result = { ...question, gradingRequirements: rubric.gradingRequirements };
      generated.push(rubric);
    }
  }
  if (question.type === 'group') {
    const parts = question.parts?.map((part) => {
      if (
        !subjective(part) ||
        (part.gradingRequirements?.trim() && !shouldRefresh?.(part, part.id))
      )
        return part;
      const rubric = buildSubjectiveRubric(question, part, domains);
      if (rubric.gradingRequirements === part.gradingRequirements) return part;
      generated.push({ partId: part.id, ...rubric });
      return { ...part, gradingRequirements: rubric.gradingRequirements };
    });
    if (generated.length) result = { ...question, parts };
  }
  return { question: result, generated };
}
