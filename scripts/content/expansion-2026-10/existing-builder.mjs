/** Original practice content; importing and approval remain separate operations. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

export const ROOT = resolve(import.meta.dirname, '../../..');
export const STAMP = '2026-10-24T00:00:00.000Z';
const baseFiles = ['terms-domains', 'computer-expansion', 'chemistry-inorganic', 'pharmacology', 'driving'];
export async function domainRecord(id) {
  for (const name of baseFiles) {
    const pack = JSON.parse(await readFile(join(ROOT, 'data/content-packs', name + '.json'), 'utf8'));
    const domain = pack.domains.find(value => value.id === id);
    if (domain) return domain;
  }
  throw new Error('Unknown existing domain ' + id);
}
export function single(stem, options, correct, explanation, difficulty = 2) {
  return { type: 'single_choice', stem, options, correct: [correct], explanation, difficulty };
}
export function multi(stem, options, correct, explanation, difficulty = 2) {
  return { type: 'multiple_choice', stem, options, correct, explanation, difficulty };
}
export function judge(stem, correct, explanation, difficulty = 1) {
  return { type: 'true_false', stem, correct: [String(correct)], explanation, difficulty };
}
export function blank(stem, answers, explanation, difficulty = 2) {
  return { type: 'fill_blank', stem, blanks: answers.map((value, index) => ({ id: 'b' + (index + 1), label: '第' + (index + 1) + '空', answers: Array.isArray(value) ? value : [value], caseSensitive: false, trim: true })), explanation, difficulty };
}
export function short(stem, answer, explanation, difficulty = 1) {
  return { type: 'short_answer', stem, answer, explanation, difficulty };
}
export async function writeExistingPack({ id, domainId, title, groups, rotateOptions = false }) {
  const domain = await domainRecord(domainId), categories = [], tags = [], questions = [], seen = new Set();
  groups.forEach((group, groupIndex) => {
    const categoryId = id + '-' + group.id;
    categories.push({ id: categoryId, domainId, parentId: null, name: group.name, description: '原创基础与应用练习，按题目条件判定。', sortOrder: 120 + groupIndex });
    tags.push({ id: categoryId + '-topic', name: group.name, domainId, kind: 'topic', color: '#426e93', description: title + '：' + group.name });
    group.questions.forEach((row, index) => {
      if (!row.explanation?.trim() || !group.sources?.length || seen.has(row.stem)) throw new Error('Missing explanation/source or duplicate stem');
      seen.add(row.stem);
      const rawOptions = row.options || [], offset = rotateOptions && rawOptions.length ? index % rawOptions.length : 0;
      const keyMap = Object.fromEntries(rawOptions.map((_, position) => ['ABCD'[position], 'ABCD'[(position + offset) % rawOptions.length]]));
      const options = rawOptions.map((text, position) => ({ key: keyMap['ABCD'[position]], text })).sort((a,b) => a.key.localeCompare(b.key));
      const correct = (row.correct || []).map(key => keyMap[key] || key).sort();
      const explanation = offset ? row.explanation.replace(/(?<![A-Za-z0-9])([ABCD])(?![A-Za-z0-9])/g, (_, key) => keyMap[key]) : row.explanation;
      const answer = row.answer || (row.type === 'fill_blank' ? row.blanks.map(value => value.answers[0]).join('；') : correct.map(key => row.type === 'true_false' ? key === 'true' ? '正确' : '错误' : key + '：' + options.find(value => value.key === key).text).join('；'));
      questions.push({ id: id.toUpperCase() + '-' + group.id.toUpperCase() + '-' + String(index + 1).padStart(3, '0'), title: row.title || row.stem.replace(/[`*\n]/g, ' ').slice(0, 115), type: row.type, stemMarkdown: row.stem, answerMarkdown: answer, explanationMarkdown: explanation, options, correctAnswers: correct, ...(row.blanks ? { blanks: row.blanks } : {}), difficulty: row.difficulty || 1, depth: row.depth || Math.min(row.difficulty || 1, 3), frequency: 0, frequencyScope: '课程基础与技能复习', frequencyBasis: '未作统计频率推断。', collection: 'general', status: 'pending', categoryIds: [categoryId], tagIds: [categoryId + '-topic'], sourceRefs: group.sources.map(([label, url]) => ({ label, url })), sourceDocument: null, sourceAnchor: null, createdAt: STAMP, updatedAt: STAMP });
    });
  });
  const pack = { schemaVersion: 1, generatedAt: STAMP, domains: [domain], categories, tags, questions, documents: [], papers: [], assets: [], questionBanks: [] };
  const text = JSON.stringify(pack, null, 2) + '\n';
  await mkdir(join(ROOT, 'data/content-packs'), { recursive: true });
  await mkdir(join(ROOT, 'data/content-sources'), { recursive: true });
  await writeFile(join(ROOT, 'data/content-packs', id + '.json'), text);
  const report = { id, title, generatedAt: STAMP, questions: questions.length, typeCounts: Object.fromEntries([...new Set(questions.map(q => q.type))].map(type => [type, questions.filter(q => q.type === type).length])), reviewStatus: 'pending', sha256: createHash('sha256').update(text).digest('hex'), license: 'Original factual explanations and original practice scenarios; cited sources retain their own rights. No source question bank or source images copied.', sources: [...new Map(questions.flatMap(q => q.sourceRefs).map(source => [source.url, source])).values()] };
  await writeFile(join(ROOT, 'data/content-sources', id + '.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
