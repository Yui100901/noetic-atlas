/** Audit original common-topic packs; optional workspace database is read-only. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { auditFoundations } from './audit-foundations.js';
import { COMMON_PACK_NAMES, loadCommonPacks } from '../content/common-2026-10/apply-common.js';
import { DatabaseConnection } from '../../server/database/connection.js';

const root = resolve(import.meta.dirname, '../..');
const raw = await auditFoundations(COMMON_PACK_NAMES);
// The older auditor includes its historical manual-review narrative. Reuse
// structural checks without attributing that older review to this new batch.
const { computerReview: _oldCs, geographyReview: _oldGeo, physicsReview: _oldPhysics, manualReview: _oldManual, ...structural } = raw;
const packs = await loadCommonPacks(COMMON_PACK_NAMES), questions = packs.flatMap(pack => pack.questions);
const normalize = (value: string) => value.normalize('NFKC').trim();
const sourceIds = new Set(questions.map(question => question.id!));
const newStems = new Map(questions.map(question => [normalize(question.stemMarkdown), question.id!]));
const errors = [...structural.errors];
const seedPath = join(root, 'data/seed.json'); let seedCount = 0;
if (existsSync(seedPath)) {
  const seed = JSON.parse(await readFile(seedPath, 'utf8'));
  for (const question of seed.questions || []) {
    seedCount++; const duplicate = newStems.get(normalize(question.stemMarkdown));
    if (duplicate && question.id !== duplicate) errors.push({ id: duplicate, check: 'seedDuplicate', detail: 'Duplicates a base-seed stem: ' + question.id });
  }
}
const args = process.argv.slice(2), at = args.indexOf('--database'); let workspaceCount: number | undefined;
if (at >= 0) {
  const filename = resolve(args[at + 1] || ''); if (!existsSync(filename)) throw new Error('Existing --database required');
  const database = new DatabaseConnection(filename, false);
  try {
    const rows = database.all(database.query.selectFrom('questions').select(['id', database.expressions.field<string>('data', 'stemMarkdown').as('stem')])); workspaceCount = rows.length;
    for (const row of rows) { const duplicate = newStems.get(normalize(row.stem)); if (duplicate && !sourceIds.has(row.id)) errors.push({ id: duplicate, check: 'workspaceDuplicate', detail: 'Duplicates a workspace stem: ' + row.id }); }
  } finally { database.close(); }
}
const { groups } = await import('../content/common-2026-10/computer-common.mjs');
const generated = new Map(questions.map(question => [question.id!, question])); let optionMappings = 0;
for (const group of groups) for (const [index, row] of group.questions.entries()) {
  if (!row.options?.length) continue;
  const id = `COMPUTER-COMMON-202610-${group.id.toUpperCase()}-${String(index + 1).padStart(3, '0')}`, current = generated.get(id)!;
  const offset = index % row.options.length, mapping = Object.fromEntries(row.options.map((_: string, position: number) => ['ABCD'[position], 'ABCD'[(position + offset) % row.options.length]]));
  for (const [position, text] of row.options.entries()) if (current.options.find(option => option.key === mapping['ABCD'[position]])?.text !== text) errors.push({ id, check: 'csOptions', detail: 'Choice layout differs from authored catalog' });
  if (JSON.stringify((row.correct || []).map((key: string) => mapping[key]).sort()) !== JSON.stringify(current.correctAnswers)) errors.push({ id, check: 'csAnswer', detail: 'Answer mapping differs from authored catalog' });
  optionMappings++;
}
const tally = (field: 'type' | 'frequency') => Object.fromEntries([...new Set(questions.map(q => q[field]))].map(value => [value, questions.filter(q => q[field] === value).length]));
const report = { ...structural, generatedAt: new Date().toISOString(), scope: '本轮11领域常用知识与核心考点；结构校验、精确/NFKC题干去重、源目录答案映射。', status: errors.length ? 'failed' : 'passed', errors, seedQuestionsCompared: seedCount, workspaceQuestionsCompared: workspaceCount, typeCounts: tally('type'), frequencyCounts: tally('frequency'), computerChoiceMappings: optionMappings, reviewEvidence: ['test-results/common-content-peer-review.json', '各领域作者的来源核验、数值/公式、歧义和权利边界检查'], limits: '常见度为课程/技能复习编辑建议，未统计实际考试命中率；精确题干去重不排除同知识点的不同应用题。结构校验与交叉复核不等于逐题专业学术认证。' };
await mkdir(join(root, 'test-results'), { recursive: true }); await writeFile(join(root, 'test-results/common-content-audit.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, total: report.totalQuestions, packs: report.packCount, typeCounts: report.typeCounts, frequencyCounts: report.frequencyCounts, seedCount, workspaceCount, errors, warnings: report.warnings }, null, 2));
if (errors.length) process.exitCode = 1;
