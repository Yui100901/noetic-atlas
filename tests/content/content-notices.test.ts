import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectContentNotices, extractContentNotices } from '../../shared/questions/content-notices.js';

const wrapper = '以下声明随单题一并保留。全包来源与变更记录另见随包 english-NOTICE.md。';
const princeton = 'Princeton WordNet 3.0\nWordNet Release 3.0\n\nPermission to use, copy, modify and distribute.\nThe copyright notice must appear on ALL copies.\nPrinceton may not be used in advertising.\nLICENSEE agrees to preserve same.';
const chinese = 'Chinese Open WordNet\nCopyright: 2013, 2014 Francis Bond, Shan Wang\n\nChinese Open WordNet\n\nPermission to use, copy, modify and distribute.\nPreserve the copyright notice and disclaimer.\nLICENSEE agrees to preserve same.';
const ecdict = 'ECDICT metadata only\nMIT License\n\nCopyright (c) 2025 Linwei\n\nPermission is hereby granted.\nThe above copyright notice shall be included in all copies.\nTHE SOFTWARE IS PROVIDED "AS IS".';
const english = (...licenses: string[]) => `### 数据许可与完整署名声明\n${wrapper}\n\n\`\`\`text\n${licenses.join('\n\n')}\n\`\`\``;
const fenced = (body: string) => `\`\`\`text\n${body}\n\`\`\``;
const japanese = '**来源与许可**：JMdict（日英词形、读音、词性和英文释义，© EDRDG / James William Breen）；jmdict-cn（中文释义与LLM例句）。本词卡为选择、重排、去重和添加学习提示后的衍生数据，按CC BY-SA 4.0共享。上游修订 `e9eb4ab0ddb5`；JMdict源条目ID：1000430。';

test('English exact wrapper splits independent licenses without dropping grants, limitations or repeated Chinese headings', () => {
  const source = `### 使用方式\n完整学习知识。\n\n${english(princeton, chinese, ecdict)}`;
  const extracted = extractContentNotices(source);
  assert.equal(extracted.markdown, '### 使用方式\n完整学习知识。\n\n');
  assert.deepEqual(extracted.notices, [
    { title: 'Princeton WordNet 3.0', markdown: fenced(princeton) },
    { title: 'Chinese Open WordNet', markdown: fenced(chinese) },
    { title: 'ECDICT metadata only', markdown: fenced(ecdict) },
  ]);
  assert.equal(extracted.notices[1]!.markdown.split('Chinese Open WordNet').length - 1, 2);
});

test('WordNet combinations share exact notices, while distinct attribution, license bytes and line endings remain separate', () => {
  const combined = english(princeton, chinese, ecdict);
  const notices = collectContentNotices([combined, english(ecdict), english(princeton, chinese), combined]);
  assert.deepEqual(notices.map(item => item.title), ['Princeton WordNet 3.0', 'Chinese Open WordNet', 'ECDICT metadata only']);
  assert.equal(notices[0]!.markdown, fenced(princeton));
  assert.equal(collectContentNotices([english(ecdict), english(ecdict.replace('2025', '2024'))]).length, 2);
  const crlf = english(ecdict).replace(/\n/g, '\r\n');
  assert.equal(extractContentNotices(crlf).notices[0]!.markdown, fenced(ecdict).replace(/\n/g, '\r\n'));
  assert.equal(collectContentNotices([english(ecdict), crlf]).length, 2);
});

test('unknown English wrapper or extra prose stays intact in a complete notice', () => {
  for (const source of [
    english(princeton, chinese).replace(wrapper, `${wrapper} 新增的授权限制必须保留。`),
    `${english(princeton, chinese)}\n\n附加限制：保留全部贡献者署名。`,
    english(princeton, chinese).replace('```text', '```license'),
    english(princeton, chinese).replace('### 数据许可与完整署名声明', '### **数据许可与完整署名声明**'),
  ]) {
    const extracted = extractContentNotices(source);
    assert.equal(extracted.markdown, ''); assert.deepEqual(extracted.notices, [{ title: '数据许可与完整署名声明', markdown: source }]);
  }
});

test('Chinese provenance preserves each word URL, revision history and modifications as exact original Markdown', () => {
  const first = '### 来源与授权\n改编自[一不拗众](https://example.com/一不拗众)及其[修订历史](https://example.com/一不拗众?action=history)。作者为该页贡献者，按CC BY-SA 4.0分享。改动：转为练习问答。';
  const second = first.replaceAll('一不拗众', '一举两得');
  const notices = collectContentNotices([first, second, first]);
  assert.deepEqual(notices, [{ title: '来源与授权', markdown: first }, { title: '来源与授权', markdown: second }]);
});

test('Japanese fixed provenance removes one paragraph only, preserving source IDs, revision and following grade disclaimer', () => {
  const grade = '参考等级由上游第三方JLPT词汇资源标注，不表示官方推荐、官方大纲或考试命中率。未复制Tatoeba句对及商业词典释义。';
  const before = '**审核重点**：中文释义和例句来自上游LLM，可能有义项错配。';
  const extracted = extractContentNotices(`${before}\n\n${japanese}\n\n${grade}`);
  assert.equal(extracted.markdown, `${before}\n\n\n\n${grade}`);
  assert.deepEqual(extracted.notices, [{ title: '来源与许可', markdown: japanese }]);
  assert.equal(collectContentNotices([japanese, japanese.replace('1000430', '1000431')]).length, 2);
});

test('notice section ends at next same or higher heading, retaining deeper subsection in its notice', () => {
  const source = '前置知识。\n\n### 来源与许可\n授权说明。\n\n#### 使用限制\n必须保留此限制。\n\n### 例题\n保留例题。\n\n## 总结\n保留总结。';
  const extracted = extractContentNotices(source);
  assert.equal(extracted.markdown, '前置知识。\n\n### 例题\n保留例题。\n\n## 总结\n保留总结。');
  assert.equal(extracted.notices[0]!.markdown, '### 来源与许可\n授权说明。\n\n#### 使用限制\n必须保留此限制。\n\n');
});

test('fenced code, inline references, quoted material and normal license knowledge questions remain untouched', () => {
  const examples = [
    '```markdown\n### 来源与许可\nMIT许可说明\n```',
    `\`\`\`markdown\n${japanese}\n\`\`\``,
    '本文提到“来源与许可”，请解释MIT和GPL许可证的区别。',
    '### 许可证\n请解释开源许可证和专有许可证的区别。',
    '## 来源与许可\n这是普通知识内容，不是指定的三级来源栏。',
    '> ### 来源与许可\n> 这是一段引用的题目材料。',
    '**来源与许可**：请比较MIT和Apache 2.0的授权义务。',
    '题目：`### 来源与许可`是不是Markdown三级标题？',
  ];
  for (const markdown of examples) assert.deepEqual(extractContentNotices(markdown), { markdown, notices: [] });
});

test('audited learning boilerplate moves to complete details while task and quoted code remain', () => {
  const instruction = '请回忆其英文含义、中文释义、主要词性及使用方式；可尝试先口头或书面造句，再查看释义与来源用例。';
  const japaneseInstruction = '可先回忆再查看答案；参考释义和例句需经人工审核。';
  const task = '请写出日语词语 **あの** 的读音与主要含义，并尝试写一个符合语境的日语句子。';
  const boundary = '先看搭配的语法角色，再用例句判断词义；同义项词通常只在特定语境可互换。例句、搭配、考试归属均仍需用户审核。';
  const extracted = extractContentNotices(`${task}\n\n${instruction}\n\n${japaneseInstruction}\n\n### 学习与审核说明\n${boundary}`);
  assert.deepEqual(extracted.notices, [{ title: '学习说明', markdown: instruction, kind: 'learning' }, { title: '学习说明', markdown: japaneseInstruction, kind: 'learning' }, { title: '学习与审核说明', markdown: `### 学习与审核说明\n${boundary}`, kind: 'learning' }]);
  assert.ok(extracted.markdown.includes(task)); assert.ok(!extracted.markdown.includes(boundary));
  assert.ok(extracted.notices.some(notice => notice.markdown.includes(boundary)));
  for (const markdown of [`引用：${instruction}`, `\`\`\`text\n${instruction}\n\`\`\``, '请解释事务概念，举例说明并介绍常见误区。', '请写出化学式、常见反应和用途。']) assert.deepEqual(extractContentNotices(markdown), { markdown, notices: [] });
});

function samples(name: string) {
  const path = resolve(`data/content-packs/${name}.json`);
  if (!existsSync(path)) return undefined;
  const questions = JSON.parse(readFileSync(path, 'utf8')).questions as { id: string; title: string; stemMarkdown: string; answerMarkdown: string; explanationMarkdown: string }[];
  return name === 'english'
    ? [questions[0]!, questions.find(question => question.explanationMarkdown.includes('Princeton WordNet 3.0'))!, questions.find(question => question.title === 'abandon')!]
    : questions.slice(0, 2);
}
const actualEnglish = samples('english'), actualChinese = samples('chinese'), actualJapanese = samples('japanese');

test('actual English content pack produces three complete reusable notices and retains learning content', { skip: !actualEnglish }, () => {
  const [original, wordnet] = actualEnglish!;
  const result = extractContentNotices(wordnet!.explanationMarkdown);
  const licenses = result.notices.filter(notice => ['Princeton WordNet 3.0', 'Chinese Open WordNet', 'ECDICT metadata only'].includes(notice.title));
  assert.deepEqual(licenses.map(notice => notice.title), ['Princeton WordNet 3.0', 'Chinese Open WordNet', 'ECDICT metadata only']);
  assert.ok(licenses[0]!.markdown.includes('advertising or publicity'));
  assert.ok(licenses[1]!.markdown.includes('Copyright: 2013, 2014 Francis Bond, Shan Wang'));
  assert.ok(licenses[1]!.markdown.includes('INFRINGE\nANY THIRD PARTY PATENTS'));
  assert.ok(licenses[2]!.markdown.includes('Copyright (c) 2025 Linwei'));
  assert.ok(!result.markdown.includes('### 学习与审核说明'));
  assert.ok(result.notices.some(notice => notice.title === '学习与审核说明' && notice.kind === 'learning'));
  assert.equal(collectContentNotices([wordnet!.explanationMarkdown, original!.explanationMarkdown]).filter(notice => licenses.some(license => license.title === notice.title)).length, 3);
  assert.equal(extractContentNotices(original!.stemMarkdown).notices[0]!.kind, 'learning');
});

test('WordNet frame and POS identifiers move to exact traceability details and English grammatical abbreviations are idempotent', () => {
  const frame = '- abandon：某人 + 动词 + 某物（WordNet 框架 8；义项 02228031-v）';
  const source = `**verb / 动词 · 02228031-v**\n\n${frame}\n\nWe abandoned the car.\n\n（Princeton WordNet 3.0；义项 02228031-v 原例句）`;
  const extracted = extractContentNotices(source);
  assert.ok(extracted.markdown.includes('**verb / 动词**'));
  assert.ok(extracted.markdown.includes('- abandon：某人（sb.） + 动词（v.） + 某物（sth.）'));
  assert.ok(extracted.markdown.includes('We abandoned the car.'));
  assert.ok(!extracted.markdown.includes('02228031-v'));
  assert.deepEqual(extracted.notices.map(notice => notice.markdown), ['**verb / 动词 · 02228031-v**', frame, '（Princeton WordNet 3.0；义项 02228031-v 原例句）']);
  assert.ok(extracted.notices.every(notice => notice.title === '词典数据索引'));
  assert.deepEqual(extractContentNotices(extracted.markdown), { markdown: extracted.markdown, notices: [] });
  const other = extractContentNotices('apply：某人（sb.） + 动词 + 形容词 + 名词 + 介词短语 + 不定式（WordNet 框架9；义项12345678-v）');
  assert.equal(other.markdown, 'apply：某人（sb.） + 动词（v.） + 形容词（adj.） + 名词（n.） + 介词短语（prep. phrase） + 不定式（inf.）');
});

test('WordNet formatting does not change code or ordinary knowledge questions', () => {
  for (const markdown of [
    '```text\nabandon：某人 + 动词 + 某物（WordNet 框架8；义项02228031-v）\n```',
    '`abandon：某人 + 动词 + 某物（WordNet 框架8；义项02228031-v）`',
    '题目：某人 + 动词 + 某物（WordNet 框架8；义项02228031-v）',
    '解释某人、动词、某物和WordNet框架8的含义。',
    '**词性概念：verb / 动词 · 02228031-v**',
    '- abandon：`某人` + 动词 + 某物（WordNet 框架8；义项02228031-v）',
  ]) assert.deepEqual(extractContentNotices(markdown), { markdown, notices: [] });
});

test('complete Tatoeba attribution moves without losing author, source URL, license or alignment disclaimer', () => {
  const attribution = '（Tatoeba 句子 #12396509，贡献者 ddnktr；[原句](https://tatoeba.org/en/sentences/show/12396509)；[CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/)；原文未改写。同词用例尚未人工逐义对齐。）';
  const warning = '（认知星图原创学习例句；CC0；不是引文；保留历史拼写，请注意核对。）';
  const sentence = 'Do we have any AA batteries? My mouse died.';
  const source = `${sentence}\n\n${attribution}\n\n${warning}`;
  const extracted = extractContentNotices(source);
  assert.deepEqual(extracted.notices, [{ title: '例句来源与许可', markdown: attribution }]);
  assert.equal(extracted.markdown, `${sentence}\n\n\n\n${warning}`);
  const incomplete = attribution.replace('[CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/)', '授权待查');
  assert.deepEqual(extractContentNotices(incomplete), { markdown: incomplete, notices: [] });
});

test('actual abandon frames and answer retain all semantic content while index details leave the study text', { skip: !actualEnglish }, () => {
  const abandon = actualEnglish![2]!;
  const answer = extractContentNotices(abandon.answerMarkdown), explanation = extractContentNotices(abandon.explanationMarkdown);
  assert.ok(answer.markdown.includes('**verb / 动词**'));
  assert.ok(answer.markdown.includes('forsake, leave behind'));
  assert.ok(!answer.markdown.includes('02228031-v'));
  assert.ok(explanation.markdown.includes('abandon：某人（sb.） + 动词（v.） + 某物（sth.）'));
  assert.ok(explanation.markdown.includes('We abandoned the old car in the empty parking lot'));
  assert.ok(!explanation.markdown.includes('02228031-v'));
  assert.ok(explanation.notices.some(notice => notice.markdown.includes('框架 8；义项 02228031-v')));
  assert.equal(explanation.markdown.split('\n').filter(line => line.startsWith('- abandon：')).length, 2);
  assert.equal(explanation.notices.filter(notice => notice.markdown.startsWith('- abandon：')).length, 4);
  assert.ok(explanation.markdown.includes('### 词形变化\n'));
  assert.ok(!explanation.markdown.includes('ECDICT 元数据'));
  assert.deepEqual(extractContentNotices(explanation.markdown), { markdown: explanation.markdown, notices: [] });
});

test('only duplicate recognized WordNet frames in one list merge while all source indices remain', () => {
  const first = '- abandon：某人 + 动词 + 某物（WordNet 框架 8；义项 02228031-v）';
  const duplicate = '- abandon：某人 + 动词 + 某物（WordNet 框架 8；义项 02227741-v）';
  const distinct = '- abandon：某人 + 动词 + 某人（WordNet 框架 9；义项 02228031-v）';
  const source = `${first}\n${duplicate}\n${distinct}\n\n### 第二组\n${duplicate}\n\n- 普通重复例句。\n- 普通重复例句。`;
  const extracted = extractContentNotices(source);
  assert.equal(extracted.markdown.split('\n').filter(line => line === '- abandon：某人（sb.） + 动词（v.） + 某物（sth.）').length, 2);
  assert.equal(extracted.markdown.split('\n').filter(line => line === '- 普通重复例句。').length, 2);
  assert.equal(extracted.notices.length, 4);
  assert.deepEqual(extracted.notices.map(notice => notice.markdown), [first, duplicate, distinct, duplicate]);
  assert.deepEqual(extractContentNotices(extracted.markdown), { markdown: extracted.markdown, notices: [] });
});

test('exact learning section and ECDICT display heading retain full original provenance in details', () => {
  const source = '### 词形变化（ECDICT 元数据）\n过去式：abandoned\n\n### 学习与审核说明\n未核验现行考纲。中文为对应义项，例句仍需人工审核。\n\n### 例题\n保留这一题。';
  const extracted = extractContentNotices(source);
  assert.equal(extracted.markdown, '### 词形变化\n过去式：abandoned\n\n### 例题\n保留这一题。');
  assert.deepEqual(extracted.notices, [
    { title: '词典数据索引', markdown: '### 词形变化（ECDICT 元数据）', kind: 'learning' },
    { title: '学习与审核说明', markdown: '### 学习与审核说明\n未核验现行考纲。中文为对应义项，例句仍需人工审核。\n\n', kind: 'learning' },
  ]);
  for (const markdown of ['### 学习方法\n这是一道学习方法知识题。', '```markdown\n### 学习与审核说明\n原文知识材料。\n```']) assert.deepEqual(extractContentNotices(markdown), { markdown, notices: [] });
});

test('actual Chinese content preserves full independent term attribution', { skip: !actualChinese }, () => {
  const notices = collectContentNotices(actualChinese!.map(question => question.explanationMarkdown));
  assert.equal(notices.length, 2);
  for (let i = 0; i < notices.length; i++) {
    const original = actualChinese![i]!.explanationMarkdown;
    assert.equal(notices[i]!.markdown, original.slice(original.indexOf('### 来源与授权')));
    assert.ok(notices[i]!.markdown.includes('action=history'));
    assert.ok(notices[i]!.markdown.includes('改动：'));
  }
});

test('actual Japanese content retains following grade notice and per-entry attribution', { skip: !actualJapanese }, () => {
  const notices = collectContentNotices(actualJapanese!.map(question => question.explanationMarkdown));
  assert.equal(notices.length, 2);
  for (const question of actualJapanese!) {
    const extracted = extractContentNotices(question.explanationMarkdown);
    assert.equal(extracted.notices.length, 1);
    assert.ok(extracted.notices[0]!.markdown.includes('JMdict源条目ID：'));
    assert.ok(extracted.notices[0]!.markdown.includes('上游修订'));
    assert.ok(extracted.markdown.includes('不表示官方推荐、官方大纲或考试命中率'));
    assert.ok(extracted.markdown.includes('**审核重点**'));
    assert.equal(extractContentNotices(question.stemMarkdown).notices[0]!.kind, 'learning');
  }
});
