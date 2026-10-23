import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sections, subjectiveFollowups } from './computer-catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const seed = JSON.parse(await fs.readFile(path.join(root, 'data/seed.json'), 'utf8'));
const generatedAt = '2026-10-22T00:00:00.000Z';
const questions = [];
const summaries = [];
const seenTitles = new Set(seed.questions.map(q => q.title.normalize('NFKC').replace(/[\s·？?，,。.!！]/g, '').toLowerCase()));
const sources = new Map();
let focusedFollowupCount = 0;
const focusedFollowupQuestions = new Set();
const stableOrder = (values, salt) => {
  const offset = crypto.createHash('sha256').update(salt).digest()[0] % values.length;
  return values.map((_, i) => values[(i + offset) % values.length]);
};
function common(section, title, difficulty = 2, depth = 2) {
  const normalized = title.normalize('NFKC').replace(/[\s·？?，,。.!！]/g, '').toLowerCase();
  if (seenTitles.has(normalized)) throw new Error(`Duplicate title: ${title}`);
  seenTitles.add(normalized);
  for (const url of section.sources) sources.set(url, { url, kind: 'official-documentation', use: '事实核对和延伸阅读；题干、备选项和中文解析为本项目独立编写，无大段复制。' });
  return { id: `CS-EXT-${String(questions.length + 1).padStart(6, '0')}`, title, difficulty, depth, frequency: section.frequency, frequencyScope: section.name, frequencyBasis: '基于岗位相关性的编辑估计，非统计频率；3=本专题建议优先，2=常规掌握，1=拓展。', collection: 'general', status: 'pending', categoryIds: [section.category], tagIds: [...section.tags], sourceRefs: section.sources.map(url => ({ label: `官方文档：${new URL(url).hostname}`, url })), sourceDocument: null, sourceAnchor: null, createdAt: generatedAt, updatedAt: generatedAt, options: [], correctAnswers: [] };
}
for (const section of sections) {
  const start = questions.length;
  const rows = section.rows.trim().split(/\r?\n/).filter(Boolean).map(line => line.split('|').map(x => x.trim()));
  if (rows.length !== 15 || rows.some(row => row.length !== 5 || row.some(x => !x))) throw new Error(`Invalid authored rows: ${section.name}`);
  const followups = subjectiveFollowups[section.category]?.trim().split(/\r?\n/).filter(Boolean).map(line => line.split('|').map(x => x.trim()));
  if (!followups || followups.length !== 6 || followups.some(row => row.length !== 3 || row.some(x => !x))) throw new Error(`Missing per-question subjective follow-ups: ${section.name}`);
  let subjectiveIndex = 0;
  for (let i = 0; i < rows.length; i++) {
    const [prompt, correct, wrongOne, wrongTwo, why] = rows[i];
    const type = ['short_answer', 'single_choice', 'single_choice', 'multiple_choice', 'short_answer'][i % 5];
    const scenario = /为什么|怎样|如何|风险|故障|热切换|多租户|范围|边界|超时|失败/.test(prompt);
    const q = common(section, prompt, scenario ? 3 : 2, type === 'short_answer' ? 3 : 2);
    q.type = type;
    q.stemMarkdown = type === 'multiple_choice' ? `${prompt}\n\n请选择所有成立的回答或解释（多选）。` : type === 'single_choice' ? `${prompt}\n\n请选择最合适的一项。` : `${prompt}\n\n请说明机制、适用条件与可能的失败情形。`;
    if (type !== 'short_answer') {
      const values = type === 'multiple_choice' ? [{ text: correct, valid: true }, { text: wrongOne, valid: false }, { text: why, valid: true }, { text: wrongTwo, valid: false }] : [{ text: correct, valid: true }, { text: wrongOne, valid: false }, { text: wrongTwo, valid: false }];
      const ordered = stableOrder(values, q.id);
      q.options = ordered.map((item, j) => ({ key: String.fromCharCode(65 + j), text: item.text }));
      q.correctAnswers = ordered.flatMap((item, j) => item.valid ? [String.fromCharCode(65 + j)] : []);
    }
    q.answerMarkdown = `**${type === 'short_answer' ? '参考回答' : `正确选项：${q.correctAnswers.join('、')}`}：** ${correct}。\n\n${why}`;
    let follow = section.follow, followAnswer = section.followAnswer, example = '';
    if (type === 'short_answer') {
      [follow, followAnswer, example] = followups[subjectiveIndex++];
      if (focusedFollowupQuestions.has(follow)) throw new Error(`Duplicate focused follow-up: ${follow}`);
      focusedFollowupQuestions.add(follow); focusedFollowupCount++;
      example = example.replaceAll('\\n', '\n');
      if (example.startsWith('go:')) example = '\n```go\n' + example.slice(3) + '\n```\n';
    }
    q.explanationMarkdown = `### 机制与适用边界\n${why}\n\n### 追问与参考回答\n**${follow}**\n\n${followAnswer}\n\n${example ? `### 最小验证与预期观察\n${example}\n\n` : ''}### 误区辨析\n- 「${wrongOne}」不是正确结论。应以「${correct}」为判断基础，再核对本题中的前提条件。\n- 「${wrongTwo}」混淆了概念或扩大了保证范围；本题所需机制是：${why}\n\n### 自测\n${example ? '按本题给出的具体输入或事件顺序推演结果，再指出改变哪个前提会让结果不同。执行环境不足时可先做纸面推演，不把未运行的例子当作实测结论。' : '请给出一个能区分正确结论与上述误区的最小例子，并说明失败时会观测到什么。'}\n\n### 内容说明\n本题为独立编写的练习题；来源为事实核对与延伸阅读，涉及版本行为时应按实际运行版本复核。`;
    q.tagIds.push(type === 'short_answer' ? 'method-application' : 'method-concept');
    questions.push(q);
  }
  const [statement, truth, judgmentWhy] = section.judgment;
  const jq = common(section, `${section.name}：关键边界判断`, 2, 2);
  Object.assign(jq, { type: 'true_false', stemMarkdown: statement, answerMarkdown: truth ? '正确。' : '错误。', correctAnswers: [String(truth)], explanationMarkdown: `**解析：** ${judgmentWhy}\n\n**追问：${section.follow}**\n\n${section.followAnswer}\n\n**误区：** 不要把某层提供的局部能力扩大为对所有输入、部署与失败路径的无条件保证。判断时应先说出前提，再构造反例。` });
  jq.tagIds.push('method-concept');
  questions.push(jq);
  const [blankStem, blankAnswer, blankWhy] = section.blank;
  const bq = common(section, `${section.name}：核心术语填空`, 1, 1);
  Object.assign(bq, { type: 'fill_blank', stemMarkdown: blankStem, answerMarkdown: blankAnswer, blanks: [{ id: 'blank-1', label: '第1空', answers: [blankAnswer], caseSensitive: false, trim: true }], explanationMarkdown: `**术语与用法：** ${blankWhy}\n\n**追问：${section.follow}**\n\n${section.followAnswer}\n\n**误区：** 记住名称不等于理解机制；应能结合本专题其他题说明它的输入、输出及保证范围。` });
  bq.tagIds.push('method-concept');
  questions.push(bq);
  summaries.push({ name: section.name, category: section.category, questions: questions.length - start, sources: section.sources });
}
if (questions.length !== 340 || focusedFollowupCount !== 120) throw new Error('Computer extension must keep 340 questions and 120 focused subjective follow-ups');
const categoryIds = new Set(questions.flatMap(q => q.categoryIds));
const allCategories = new Map(seed.categories.map(c => [c.id, c]));
for (const id of [...categoryIds]) {
  let current = allCategories.get(id);
  if (!current) throw new Error(`Unknown category: ${id}`);
  while (current.parentId) { categoryIds.add(current.parentId); current = allCategories.get(current.parentId); if (!current) throw new Error(`Missing category ancestor`); }
}
const tagIds = new Set(questions.flatMap(q => q.tagIds));
const tags = seed.tags.filter(t => tagIds.has(t.id));
if (tags.length !== tagIds.size) throw new Error('Unknown tag in computer extension');
const typeCounts = Object.fromEntries([...new Set(questions.map(q => q.type))].map(type => [type, questions.filter(q => q.type === type).length]));
const pack = { schemaVersion: 1, generatedAt, domains: seed.domains.filter(d => d.id === 'computer-science'), categories: seed.categories.filter(c => categoryIds.has(c.id)), tags, questions, questionBanks: [{ id: 'bank-cs-extension-202610', name: '计算机·机制与边界扩展', description: '20 个专题，含简答场景、单选、多选、判断、填空；独立编写，待用户审核。', questionIds: questions.map(q => q.id) }], documents: [], papers: [] };
const manifest = { id: 'computer-extension-202610', name: '计算机机制与边界题库扩展', generatedAt, license: 'Project-authored', redistribution: '题干、备选项和中文答案解析由本项目独立编写；不导入第三方商业题库，不将官方文档本身的许可证据为己有。后续发布可随项目自编内容使用条款分发。', sourceUse: '引用官方规范与维护者文档核对事实并供读者深入阅读；无整页或长段复制。', totalQuestions: questions.length, typeCounts, reviewStatus: 'pending', quality: { subjectiveQuestions: 120, individuallyAuthoredFollowups: focusedFollowupCount, distinctFollowupQuestions: focusedFollowupQuestions.size, specificValidationExamples: focusedFollowupCount, scope: '120道简答全部按该题机制配置独立追问、回答与具体输入/预期观察；不使用专题通用并发排错话术替代。示例为学习验证方案，未宣称全部已在本机执行。' }, duplicatePolicy: '与现有 seed 及本包进行 NFKC+忽略常见标点的标题去重；同领域概念仍可能存在不同题型和视角的重合，需用户审核。', difficultyPolicy: '1=术语/直接识别，2=机制辨析，3=场景及失败边界；depth 独立表示要求的说明深度。', frequencyPolicy: '1-3 是专题内编辑建议优先级，非网络统计或实际招聘发生概率。', topics: summaries, sources: [...sources.values()], rebuild: 'node scripts/content/computer/computer.mjs', output: 'data/content-packs/computer-expansion.json' };
await fs.mkdir(path.join(root, 'data/content-packs'), { recursive: true });
await fs.mkdir(path.join(root, 'data/content-sources'), { recursive: true });
await fs.writeFile(path.join(root, 'data/content-packs/computer-expansion.json'), `${JSON.stringify(pack, null, 2)}\n`);
await fs.writeFile(path.join(root, 'data/content-sources/computer-expansion.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ total: questions.length, typeCounts }, null, 2));
