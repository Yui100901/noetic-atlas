/** Historical official training fragment. Never treats publication date as currency. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceUrl = 'https://ga.chengde.gov.cn/art/2022/11/11/art_2935_896953.html';
const expectedHash = '4ed88f5598bc12c597b1ba6dd912848442558d7148cedfa59a2aa0da3fc0d755';
const cache = path.join(root, '.localtools/content-sources/driving-motorcycle/official.html');
const stamp = '2026-10-22T00:00:00.000Z';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
await fs.mkdir(path.dirname(cache), { recursive: true });
let bytes;
try { bytes = await fs.readFile(cache); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
  if (process.argv.includes('--offline')) throw new Error('Missing cached official motorcycle HTML');
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'NoeticAtlasContentBuilder/1.0 (public training snapshot)' } });
  if (!response.ok) throw new Error(`Official source HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(sha256(bytes), expectedHash, 'Official page changed; review and update source pin explicitly');
  await fs.writeFile(cache, bytes);
}
assert.equal(sha256(bytes), expectedHash, 'Cached official source integrity mismatch');
const html = bytes.toString('utf8');
const start = html.indexOf('<!--ZJEG_RSS.content.begin-->');
const finish = html.indexOf('<!--ZJEG_RSS.content.end-->');
assert.ok(start >= 0 && finish > start, 'Official article content markers missing');
const body = html.slice(start, finish);
const imageUrls = [...body.matchAll(/<img\b[^>]*src=["']([^"']+)["']/gi)].map(match => new URL(match[1], sourceUrl).href);
assert.equal(imageUrls.length, 0, 'This snapshot has no question images; new images require explicit asset extraction');
const text = body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<\/?p\b[^>]*>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/\[SITESERVER_PAGE\]/g, '').replace(/\r/g, '');
const markers = [...text.matchAll(/(?<![\d.])(\d+(?:\.\d+){3})(?![\d.])/g)];
assert.equal(markers.length, 176, 'Pinned snapshot should contain 176 question identifiers, not its advertised 683');
const base = JSON.parse(await fs.readFile(path.join(root, 'data/content-packs/driving.json'), 'utf8'));
const domain = base.domains.find(domain => domain.id === 'driving');
assert.ok(domain, 'Original driving domain metadata must exist');
const inheritedTags = base.tags.filter(tag => ['drv-subject1', 'drv-model-d', 'drv-model-e', 'drv-model-f'].includes(tag.id));
assert.equal(inheritedTags.length, 4);
const category = { id: 'drv-official-motorcycle', domainId: 'driving', parentId: null, name: '官方摩托车公开题库（2022）', description: '承德市公安局2022-11-11发布的历史网页片段；实际仅176题，原题含更早过时规则，不能当作现行完整题库。', sortOrder: 20 };
const tags = [...inheritedTags,
  { id: 'drv-official-public-training', name: '官方公开训练资料', domainId: 'driving', kind: 'custom', color: '#a16207', description: '来源为公安机关公开网页，非当前全国全量考试题库认证。' },
  { id: 'drv-historical-2022', name: '历史网页·2022发布', domainId: 'driving', kind: 'custom', color: '#b45309', description: '2022是网页发布日期；内容本身含更早规则，未证明当时或目前仍有效。' },
  { id: 'drv-current-rule-review', name: '必须核验现行规则', domainId: 'driving', kind: 'custom', color: '#b91c1c', description: '所有历史题逐题核验后才可决定是否发布；旧答案不直接用于当前备考。' },
  { id: 'drv-historical-legal-sensitive', name: '历史处罚与证照重点复核', domainId: 'driving', kind: 'custom', color: '#be123c', description: '旧处罚、记分、酒驾、年龄、证照程序与废止法律等可能与现行规则冲突。' }
];
const clean = value => value.replace(/[\t\n ]+/g, ' ').trim();
const warnings = [];
const skipped = [];
const formatRepairs = [];
const questions = [];
const originalIds = new Set();
const sections = {};
for (let index = 0; index < markers.length; index++) {
  const marker = markers[index];
  const originalId = marker[1];
  assert.ok(!originalIds.has(originalId), `Duplicate source ID ${originalId}`);
  originalIds.add(originalId);
  const block = text.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? text.length);
  const answer = /答案\s*[：:]\s*(正确|错误|[A-D])/.exec(block);
  if (!answer) { skipped.push({ originalId, reason: '没有明确原答案，未猜测补全' }); continue; }
  let prompt = block.slice(0, answer.index).trim();
  if (originalId === '1.2.1.22' && prompt.includes('C从右绕行通过路口')) {
    prompt = prompt.replace('C从右绕行通过路口', 'C.从右绕行通过路口');
    formatRepairs.push({ originalId, before: 'C从右绕行通过路口', after: 'C.从右绕行通过路口', reason: '补齐原C选项标号漏掉的句点，不改变原选项文字或原答案D。' });
  }
  const optionMarkers = [...prompt.matchAll(/(?<![A-Za-z0-9])([A-D])[.．、]\s*/g)];
  const trueFalse = ['正确', '错误'].includes(answer[1]);
  let stem = prompt, options = [], correctAnswers;
  if (trueFalse) {
    if (optionMarkers.length) { skipped.push({ originalId, reason: '原判断答案与选择项结构冲突' }); continue; }
    correctAnswers = [String(answer[1] === '正确')];
  } else {
    if (optionMarkers.length !== 4 || optionMarkers.map(option => option[1]).join('') !== 'ABCD') { skipped.push({ originalId, reason: `选择项结构不完整：${optionMarkers.map(option => option[1]).join('')}` }); continue; }
    stem = prompt.slice(0, optionMarkers[0].index);
    options = optionMarkers.map((option, position) => ({ key: option[1], text: clean(prompt.slice(option.index + option[0].length, optionMarkers[position + 1]?.index ?? prompt.length)) }));
    if (options.some(option => !option.text)) { skipped.push({ originalId, reason: '空选择项' }); continue; }
    correctAnswers = [answer[1]];
  }
  stem = stem.replace(/[ \t\u00a0]{2,}/g, '____');
  stem = clean(stem);
  if (!stem || /如图|图中|图示|下图/.test(stem)) { skipped.push({ originalId, reason: !stem ? '题干为空' : '题目依赖未提供的图片' }); continue; }
  const sensitive = /罚款|记分|酒|醉|吊销|扣留|撤销|年[龄审检]|换证|申[领请]|驾驶证|民法通则|拘留|处罚/.test(prompt);
  const knownOutdated = ['1.1.1.29', '1.1.1.30'].includes(originalId) || originalId.startsWith('1.4.');
  if (knownOutdated) warnings.push({ originalId, reason: originalId.startsWith('1.4.') ? '原章节依据《民法通则》，已不能直接作为现行法律依据；保留为历史材料，必须更新复核。' : '原题沿用明显过时的饮酒/醉酒驾驶处罚描述，不能用于当前规则记忆。' });
  const sourceWarning = '**历史材料，必须核验现行规则。** 本页于2022年11月11日发布，题文含更早的旧规定；下列题干及公布答案作为历史资料保留，不代表2022年或2026年的有效考试答案。';
  const selection = trueFalse ? answer[1] : `${answer[1]}：${options.find(option => option.key === answer[1])?.text}`;
  const q = {
    id: `DRV-HIST-MOTO-${originalId.replace(/\./g, '-')}`,
    title: `历史摩托训练 ${originalId}｜${stem.slice(0, 70)}`,
    type: trueFalse ? 'true_false' : 'single_choice',
    stemMarkdown: `> ${sourceWarning}\n\n${stem}`,
    answerMarkdown: `**历史网页公布答案：${selection}**\n\n${knownOutdated ? '⚠ 本题已识别为含过时处罚或旧法律依据，不能据此答案进行当前驾考记忆。' : '以上为原页面公布答案，尚未对照现行法规逐题复核；不得因“官方网页”而自动通过审核。'}`,
    explanationMarkdown: `### 原网页答案\n${selection}\n\n### 原解析情况\n原网页未提供逐题详细解析。本包不编造解释，也不把旧答案包装成现行法律结论。\n\n### 时效审核\n${knownOutdated ? warnings.at(-1).reason : sensitive ? '本题涉及处罚、证照或相关法律程序，应优先逐项核验最新有效条款、适用车型与地方要求。' : '仍需核验当前规则和上下文，历史安全常识也不自动视为已经人工审定。'}\n\n### 来源与范围\n承德市公安局[《机动车驾驶人科目一考试摩托车类题库（683题）》](${sourceUrl})，网页发布于2022年11月11日，原编号 ${originalId}。页面标题声称683题，实际当前正文只可提取176题，不是完整683题，更不代表当前全国全量题库。来源未明示开放再分发许可证。`,
    options, correctAnswers, difficulty: 1, depth: 1, frequency: 0,
    frequencyScope: '历史驾驶理论公开训练材料，非面试频率', frequencyBasis: '未统计频率；官方网页发布日期不等于规则有效日期。',
    collection: 'general', status: 'pending', categoryIds: [category.id],
    tagIds: ['drv-subject1', 'drv-model-d', 'drv-model-e', 'drv-model-f', 'drv-official-public-training', 'drv-historical-2022', 'drv-current-rule-review', ...(sensitive ? ['drv-historical-legal-sensitive'] : [])],
    sourceRefs: [{ label: '承德市公安局公开历史网页（2022-11-11）', url: sourceUrl }],
    sourceDocument: null, sourceAnchor: null, createdAt: stamp, updatedAt: stamp
  };
  questions.push(q);
  const section = originalId.split('.').slice(0, 2).join('.'); sections[section] = (sections[section] || 0) + 1;
}
assert.ok(questions.length >= 150, 'Unexpected parsing loss in pinned official fragment');
const pack = { schemaVersion: 1, generatedAt: stamp, domains: [domain], categories: [category], tags, questions, assets: [], questionBanks: [{ id: 'bank-driving-official-motorcycle-2022', name: '摩托车·官方历史公开训练片段', description: '实际176题候选，不是完整683题；含过时内容，全部待审核，不直接用于当前备考。', questionIds: questions.map(question => question.id) }], documents: [], papers: [] };
const manifest = {
  id: 'driving-motorcycle-official', title: '承德市公安局摩托车公开历史训练片段', generatedAt: stamp,
  source: { url: sourceUrl, publisher: '承德市公安局', publishedAt: '2022-11-11 09:31', retrievedAt: '2026-10-22', bytes: bytes.length, sha256: expectedHash },
  titleAdvertisedQuestionCount: 683, firstChapterAdvertisedCount: 189, actualNumberedRecords: markers.length,
  importedQuestions: questions.length, typeCounts: { single_choice: questions.filter(question => question.type === 'single_choice').length, true_false: questions.filter(question => question.type === 'true_false').length },
  sections, sourceQuestionImages: 0, assets: 0, skipped, formatRepairs, knownOutdatedQuestions: warnings,
  status: 'pending', currentExamBank: false, contentVersionKnown: false,
  scope: '仅当前公开网页中可读的第1章片段，未获取标题所称完整683题。网页发布于2022，不代表题文规则在2022或当前有效。',
  rights: { license: 'Unspecified-government-public-training-page', notice: '官方公开发布，不等于已经核实可任意再分发。页面未见明确开放许可证；保留来源与原编号，不标注CC0/MIT，不混同法律法规原文的权利属性。正式再分发前应核实相应权利。' },
  transformations: ['从正文元数据边界内解析原编号、判断/单选、原答案', '排除站点页头、打印关闭按钮与无关图片', '保留原题序号中的异常1.8.8.x，不自行冒改为1.8.1.x', '纯版式空白填充为下划线，原题文字缺损不擅自补写', '题干、答案和解析均标记历史时效，所有记录pending/general'],
  limitations: ['原页面题数与标题、章总数不一致，不能承诺全库。', '部分题文有交*路口等文字缺损，应在人工审核中核对。', '酒驾处罚、民法通则与证照流程等旧规则必须逐题核验，不能直接用历史答案备考。', '原网页无详细解析，未借模型捏造解析。'],
  rebuild: 'node scripts/content/driving/driving-motorcycle.mjs [--offline]', output: 'data/content-packs/driving-motorcycle-official.json'
};
await fs.mkdir(path.join(root, 'data/content-packs'), { recursive: true });
await fs.mkdir(path.join(root, 'data/content-sources'), { recursive: true });
await fs.writeFile(path.join(root, 'data/content-packs/driving-motorcycle-official.json'), `${JSON.stringify(pack, null, 2)}\n`);
await fs.writeFile(path.join(root, 'data/content-sources/driving-motorcycle-official.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ parsed: markers.length, imported: questions.length, skipped, typeCounts: manifest.typeCounts, knownOutdated: warnings.length }, null, 2));
