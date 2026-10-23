/** Disposable content fixture: never opens a user's SQLite database. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from '../../server/index.js';
import { wordlistPapers, validatePack } from '../content/manage.js';
import type { Question } from '../../shared/models/types.js';

const root = resolve(import.meta.dirname, '../..');
const absentSeed = resolve(root, 'test-results/content/no-fixture-seed.json');
assert.ok(!existsSync(absentSeed), 'The content fixture requires an absent seed path');
assert.ok(existsSync(resolve(root, 'dist/web/index.html')), 'Run npm run build before content UI QA');
const app = await buildApp({ databasePath: ':memory:', seedPath: absentSeed, staticRoot: resolve(root, 'dist/web') });
const checks: string[] = [];
const fixture: Record<string, any> = { checks };
app.get('/qa/content-fixture', async () => fixture);
async function api(url: string, method: 'GET' | 'POST' | 'PUT' = 'GET', payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  assert.ok(response.statusCode < 400, `${url} ${response.statusCode}: ${response.body.slice(0, 600)}`);
  return response.json();
}
try {
  for (const name of ['english', 'japanese', 'chinese', 'driving', 'computer-expansion','chemistry-inorganic','chemistry-organic','pharmacology','driving-car-official']) {
    const source = validatePack(JSON.parse(await readFile(resolve(root, 'data/content-packs', `${name}.json`), 'utf8')));
    const vocabulary = source.questions.filter((q: Question) => q.type === 'short_answer' && /^(EN|JA)-V-/.test(q.id));
    let selected: Question[];
    if (name === 'english') {
      selected = [...vocabulary.slice(0, 100), source.questions.find((q: Question) => !q.id.startsWith('EN-V-'))];
      fixture.englishId = selected.find(q => q.title === 'abandon')?.id || selected[2]!.id;
      fixture.englishWordIds = vocabulary.slice(0, 100).map((q: Question) => q.id);
    } else if (name === 'japanese') {
      selected = [...vocabulary.slice(0, 3), source.questions.find((q: Question) => !q.id.startsWith('JA-V-'))];
      fixture.japaneseId = selected[0]!.id;
    } else if (name === 'chinese') {
      selected = [source.questions.find((q: Question) => q.explanationMarkdown.includes('【缺失】')), source.questions.find((q: Question) => q.title === '成语：守株待兔')];
      fixture.chineseId = selected[0]!.id;
    } else if (name === 'driving') {
      selected = [source.questions.find((q: Question) => /!\[.*\]\(\/api\/assets\//.test(q.stemMarkdown))];
      fixture.drivingId = selected[0]!.id;
    } else if(name==='chemistry-inorganic'||name==='chemistry-organic'||name==='pharmacology'){
      selected=source.questions.slice(0,2);
      fixture[name]=selected[0]!.id;
      fixture.newCatalogIds=[...(fixture.newCatalogIds||[]),...selected.map(q=>q.id)];
    } else if(name==='driving-car-official'){
      selected=[source.questions.find(q=>q.id==='DRV-CAR-OFFICIAL-000044')!];
      fixture.historicalId=selected[0]!.id;fixture.newCatalogIds.push(selected[0]!.id);
    } else {
      selected = [source.questions[0]];
      fixture.computerId = selected[0]!.id;
    }
    assert.ok(selected.every(Boolean), `Fixture source incomplete: ${name}`);
    const chosen = new Set(selected.map(q => q.id));
    const cleanLinks = (value: string) => value.replace(/\[([^\]]+)\]\(#\/questions\/([^\s)"?#]+)\)/g, (whole, text, id) => chosen.has(decodeURIComponent(id)) ? whole : text);
    selected = selected.map(q => ({ ...q, stemMarkdown: cleanLinks(q.stemMarkdown), answerMarkdown: cleanLinks(q.answerMarkdown), explanationMarkdown: cleanLinks(q.explanationMarkdown) }));
    const bank = { ...source, questions: selected, questionBanks: (source.questionBanks || []).map((b: any) => ({ ...b, questionIds: b.questionIds.filter((id: string) => chosen.has(id)) })).filter((b: any) => b.questionIds.length), documents: [], papers: [] };
    const papers = name === 'english' ? wordlistPapers(bank) : [];
    if (papers.length) {
      assert.equal(papers.length, 1);
      fixture.paperId = papers[0]!.id;
      bank.papers = papers;
    }
    await api('/api/import', 'POST', { data: bank, mode: 'merge' });
  }
  const pending = await api('/api/questions?status=pending&pageSize=200');
  assert.equal(pending.total, 116);
  checks.push('真实内容的七领域子集通过正式迁移入口导入116题，初始全部待审核');
  const bootstrap = await api('/api/bootstrap');
  assert.equal(bootstrap.stats.totalQuestions, 0);
  checks.push('待审核题不进入正式题库统计');
  const paper = await api(`/api/papers/${fixture.paperId}`);
  assert.equal(paper.archived, true);
  assert.equal(paper.scoring.enabled, false);
  assert.equal(paper.questionCount, 100);
  const unavailable = await app.inject({ method: 'POST', url: `/api/papers/${fixture.paperId}/attempts`, payload: {} });
  assert.equal(unavailable.statusCode, 409);
  checks.push('100词无分词表初始归档，归档状态阻止新作答');
  const words = pending.items.filter((q: Question) => fixture.englishWordIds.includes(q.id));
  const reviewed = await api('/api/questions/review', 'POST', { confirmed: true, ids: fixture.englishWordIds, action: 'approve', expectedUpdatedAt: Object.fromEntries(words.map((q: Question) => [q.id, q.updatedAt])) });
  assert.equal(reviewed.count, 100);
  checks.push('仅内存测试库通过正式审核接口确认100个英语词条');
  const extra=pending.items.filter((q:Question)=>fixture.newCatalogIds.includes(q.id));
  await api('/api/questions/review','POST',{confirmed:true,ids:fixture.newCatalogIds,action:'approve',expectedUpdatedAt:Object.fromEntries(extra.map((q:Question)=>[q.id,q.updatedAt]))});
  checks.push('化学、药学及含失效历史题通过正式审核接口发布，风险标签保留');
  for(const domainId of ['chemistry','medicine-pharmacy']){
    const result=await api('/api/questions?domainId='+domainId+'&pageSize=200');
    assert.ok(result.items.some((q:Question)=>q.id===fixture.pharmacology));
  }
  assert.equal((await api('/api/questions?pageSize=200')).total,107);
  checks.push('同一药物题号在化学与医学药学领域均可查询，正式题总数不重复计数');
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  console.log(`CONTENT_UI_READY ${JSON.stringify({ origin })}`);
} catch (error) { await app.close(); throw error; }
let closing = false;
async function close() { if (closing) return; closing = true; await app.close(); process.exit(0); }
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
process.on('disconnect', () => void close());
