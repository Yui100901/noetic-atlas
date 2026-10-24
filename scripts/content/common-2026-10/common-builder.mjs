/** Source-backed original practice. Approval is a separate explicit operation. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
export { single, multi, judge, blank, short } from '../expansion-2026-10/existing-builder.mjs';
export const ROOT = resolve(import.meta.dirname, '../../..');
export const STAMP = '2026-10-24T14:30:00.000Z';
const domainPacks = ['terms-domains', 'computer-expansion', 'chemistry-inorganic', 'pharmacology', 'driving', 'geography-foundations', 'physics-foundations', 'psychology-foundations', 'economics-foundations'];
export async function domainRecord(id) {
  for (const name of domainPacks) {
    const pack = JSON.parse(await readFile(join(ROOT, 'data/content-packs', name + '.json'), 'utf8'));
    const found = pack.domains.find(domain => domain.id === id);
    if (found) return found;
  }
  throw new Error('Unknown domain ' + id);
}
export async function writeCommonPack({ id, domainId, title, groups, rotateOptions = false }) {
  const domain = await domainRecord(domainId), categories = [], tags = [], questions = [], seen = new Set();
  const methodSource = JSON.parse(await readFile(join(ROOT, 'data/content-packs/geography-foundations.json'), 'utf8'));
  const methods = ['method-concept', 'method-application'].map(id => methodSource.tags.find(tag => tag.id === id));
  if (methods.some(tag => !tag)) throw new Error('Missing shared learning-method taxonomy');
  tags.push(...methods);
  for (const [groupIndex, group] of groups.entries()) {
    const categoryId = `${id}-${group.id}`;
    categories.push({ id: categoryId, domainId, parentId: null, name: group.name, description: '常用基础知识、核心考点与应用辨析；原创练习，保留来源。', sortOrder: 180 + groupIndex });
    tags.push({ id: `${categoryId}-topic`, name: group.name, domainId, kind: 'topic', color: '#426e93', description: `${title}：${group.name}` });
    for (const [index, row] of group.questions.entries()) {
      if (!row.stem?.trim() || !row.explanation?.trim() || !group.sources?.length || seen.has(row.stem)) throw new Error('Incomplete/duplicate question: ' + row.stem);
      seen.add(row.stem);
      const inputOptions = row.options || [], offset = rotateOptions && inputOptions.length ? index % inputOptions.length : 0;
      const keys = Object.fromEntries(inputOptions.map((_, position) => ['ABCD'[position], 'ABCD'[(position + offset) % inputOptions.length]]));
      const options = inputOptions.map((text, position) => ({ key: keys['ABCD'[position]], text })).sort((a, b) => a.key.localeCompare(b.key));
      const correctAnswers = (row.correct || []).map(key => keys[key] || key).sort();
      if (row.type.includes('choice') && (inputOptions.length < 2 || inputOptions.length > 4 || correctAnswers.some(key => !options.some(option => option.key === key)))) throw new Error('Invalid options');
      const explanationMarkdown = offset ? row.explanation.replace(/(?<![A-Za-z0-9])([ABCD])(?![A-Za-z0-9])/g, (_, key) => keys[key]) : row.explanation;
      const answerMarkdown = row.answer || (row.type === 'fill_blank' ? row.blanks.map(blank => blank.answers[0]).join('；') : correctAnswers.map(key => row.type === 'true_false' ? key === 'true' ? '正确' : '错误' : `${key}：${options.find(option => option.key === key).text}`).join('；'));
      questions.push({ id: `${id.toUpperCase()}-${group.id.toUpperCase()}-${String(index + 1).padStart(3, '0')}`, title: row.title || row.stem.replace(/[`*\n]/g, ' ').slice(0, 115), type: row.type, stemMarkdown: row.stem, answerMarkdown, explanationMarkdown, options, correctAnswers, ...(row.blanks ? { blanks: row.blanks } : {}), difficulty: row.difficulty ?? 2, depth: row.depth ?? Math.min(row.difficulty ?? 2, 3), frequency: row.frequency ?? 2, frequencyScope: row.frequencyScope || group.frequencyScope || '本学科基础课程与常用知识复习', frequencyBasis: row.frequencyBasis || '根据公开教材、官方文档及基础考点覆盖进行编辑复习分级；未统计真实考试出现概率。', collection: 'general', status: 'pending', categoryIds: [categoryId], tagIds: [`${categoryId}-topic`, row.method === 'concept' || !row.method && row.type === 'short_answer' ? 'method-concept' : 'method-application'], sourceRefs: (row.sources || group.sources).map(([label, url]) => ({ label, url })), sourceDocument: null, sourceAnchor: null, createdAt: STAMP, updatedAt: STAMP });
    }
  }
  const pack = { schemaVersion: 1, generatedAt: STAMP, domains: [domain], categories, tags, questions, documents: [], papers: [], assets: [], questionBanks: [] };
  const serialized = JSON.stringify(pack, null, 2) + '\n';
  const counts = key => Object.fromEntries([...new Set(questions.map(question => question[key]))].map(value => [value, questions.filter(question => question[key] === value).length]));
  const report = { id, title, generatedAt: STAMP, questions: questions.length, typeCounts: counts('type'), frequencyCounts: counts('frequency'), reviewStatus: 'pending', sha256: createHash('sha256').update(serialized).digest('hex'), authorship: '独立编写题干、选项、情境、答案与中文解析；来源用于核验公开事实和基础考点，不复制来源题库、教材正文或图片。', frequencyPolicy: 'F1/F2/F3为所列基础课程或技能复习范围中的编辑建议，不代表统计考试命中率；不确定可标0。', rights: '新增原创表达可随题库分享；引用来源保留各自权利，不将某一个网站的许可套用于全部题库。', sources: [...new Map(questions.flatMap(question => question.sourceRefs).map(source => [source.url, source])).values()] };
  await mkdir(join(ROOT, 'data/content-packs'), { recursive: true }); await mkdir(join(ROOT, 'data/content-sources'), { recursive: true });
  await writeFile(join(ROOT, 'data/content-packs', id + '.json'), serialized);
  await writeFile(join(ROOT, 'data/content-sources', id + '.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
