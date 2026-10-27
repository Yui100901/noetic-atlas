/** Offline verification of generated content using the app's actual schemas. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { questionSchema, categorySchema, domainSchema, tagSchema, id } from '../../../server/core/validation.js';
import { conceptPromptIsSafe } from '../../../shared/questions/concept.js';

const root = resolve(import.meta.dirname, '../../..');
const pack = JSON.parse(await readFile(resolve(root, 'data/content-packs/medical-expansion-20261026.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(root, 'data/content-sources/medical-expansion-20261026.json'), 'utf8'));
for (const domain of pack.domains) domainSchema.extend({ id }).parse(domain);
for (const category of pack.categories) categorySchema.extend({ id }).parse(category);
for (const tag of pack.tags) tagSchema.extend({ id }).parse(tag);
const ids = new Set<string>();
let concepts = 0;
for (const question of pack.questions) {
  questionSchema.parse(question);
  assert.equal(question.status, 'pending');
  assert.ok(!ids.has(question.id), `Repeated ID ${question.id}`); ids.add(question.id);
  assert.ok(question.sourceRefs.length > 0 && question.sourceRefs.every((source: { url: string }) => new URL(source.url).protocol === 'https:'));
  assert.ok(!/臺灣中藥典第四版\d|回上一頁|卫生福利部地址|浏览人数|建议最佳解析度/.test(question.answerMarkdown+' '+question.explanationMarkdown));
  if (question.concept) { assert.ok(conceptPromptIsSafe(question.concept), question.title); concepts++; }
}
const materials = manifest.sourceRecords.filter((record: { kind: string }) => record.kind === 'materia');
assert.equal(new Set(materials.map((record: { name: string }) => record.name)).size, materials.length);
assert.ok(!materials.some((record: { name: string }) => ['虎骨', '犀角', '穿山甲', '关木通', '广防己', '青木香', '羚羊角', '紫河车', '滑石粉'].includes(record.name)));
assert.equal(pack.questions.length, Object.values(manifest.counts).reduce<number>((a, b) => a + Number(b), 0));
assert.equal(concepts, manifest.reverseConcepts);
console.log(JSON.stringify({ questions: ids.size, counts: manifest.counts, reverseConcepts: concepts, status: 'pending', result: 'passed' }, null, 2));
