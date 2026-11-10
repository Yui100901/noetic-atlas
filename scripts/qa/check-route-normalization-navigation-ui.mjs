/** Passive URL normalization must never undo navigation committed by a user.
 * MutationObserver runs after DOM commit, before React's passive effects; this
 * exercises the narrow window that an ordinary settled-page click can miss. */
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'route-normalization-navigation-ui',
  backgroundTasks: true,
  setup: String.raw`
const { fixtureQuestion, learningSeed } = await import('./tests/fixtures/learning-seed.ts');
const { documentSchema } = await import('./server/core/validation.ts');
const api = async (url, method='GET', payload) => {
  const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});
  assert.ok(response.statusCode<400,url+': '+response.body);return response.json();
};
const seed=learningSeed();
seed.questions=Array.from({length:48},(_,index)=>fixtureQuestion('NAV-'+String(index).padStart(3,'0'),'true_false',{
  title:'导航样例 '+String(index).padStart(3,'0'),status:index<24?'published':'pending',
}));
seed.documents=Array.from({length:24},(_,index)=>documentSchema.parse({
  id:'NAV-D'+index,title:'导航资料 '+String(index).padStart(3,'0'),kind:'学习笔记',
  bodyMarkdown:'# 合成资料\n导航回归专用内容。',domainIds:['fixture-computer'],
  categoryIds:['fixture-basic'],tagIds:[],collection:'general',updatedAt:'2026-10-20T00:00:00.000Z',
}));
await api('/api/import','POST',{mode:'merge',data:seed});
let paperId;
for(let index=0;index<12;index++){
  const paper=await api('/api/papers','POST',{title:'导航题集 '+String(index).padStart(2,'0'),mode:'manual',questionIds:seed.questions.slice(0,24).map(q=>q.id),scoring:{enabled:false}});
  paperId ||= paper.id;
}
for(const question of seed.questions.slice(0,24))await api('/api/study/'+question.id,'PUT',{favorite:true,nextReviewAt:new Date(Date.now()-86400000).toISOString()});
await api('/api/question-feedback','POST',{questionId:seed.questions[0].id,kind:'ambiguous',description:'隔离导航验收反馈，不代表真实内容问题。'});
return {paperId};
`,
});
const { page, origin } = h;
const checks = [];
await page.addInitScript(() => {
  window.__normalizationWrites = [];
  const replace = history.replaceState.bind(history);
  history.replaceState = (state, title, destination) => {
    const to =
      destination == null ? location.hash : new URL(String(destination), location.href).hash;
    window.__normalizationWrites.push({ from: location.hash, to });
    return replace(state, title, destination);
  };
});

async function go(hash) {
  await page.goto(origin + '/' + hash);
}
async function params() {
  return new URLSearchParams((await page.evaluate(() => location.hash)).split('?')[1] || '');
}
async function commitWindowNavigation(name, hash, selector) {
  await go('#/');
  await page.locator('.dashboard-stats').waitFor();
  await page.getByRole('link', { name: '后台任务与通知', exact: true }).waitFor();
  await page.evaluate(
    ({ hash, selector }) => {
      window.__commitNavigation = { clicked: false, source: hash, selector };
      const observer = new MutationObserver(() => {
        if (location.hash.split('?')[0] !== hash.split('?')[0]) return;
        if (!document.querySelector('#main-content ' + selector)) return;
        const target = document.querySelector('.topbar a[aria-label="后台任务与通知"]');
        if (!target) return;
        observer.disconnect();
        window.__commitNavigation = {
          ...window.__commitNavigation,
          clicked: true,
          writeIndex: window.__normalizationWrites.length,
        };
        target.click();
      });
      // The route keys <main>; observe its stable parent, not a detached node.
      observer.observe(document.querySelector('.main-shell'), { childList: true, subtree: true });
      location.hash = hash;
    },
    { hash, selector },
  );
  await page.waitForFunction(() => window.__commitNavigation?.clicked === true);
  await page.getByRole('region', { name: '后台任务列表', exact: true }).waitFor();
  await page.waitForTimeout(200);
  const state = await page.evaluate(() => ({
    hash: location.hash,
    ...window.__commitNavigation,
    writes: window.__normalizationWrites.slice(window.__commitNavigation.writeIndex),
  }));
  assert.equal(state.hash, '#/tasks', name + ': old page stole task navigation');
  assert.ok(
    state.writes.every((write) => write.to.split('?')[0] === '#/tasks'),
    name + ': stale page rewrote a new destination',
  );
  checks.push({ name, passed: true, source: hash, destination: state.hash });
}

try {
  const cases = [
    ['题库', '#/questions?page=2&pageSize=10', '.filters-panel'],
    ['审核管理', '#/questions/review?page=2&pageSize=10', '.review-batch'],
    ['资料库', '#/documents?page=2&pageSize=10', '.library-filters'],
    ['质量管理', '#/content-quality?status=all', '.quality-queue-page'],
    ['题集列表', '#/papers?page=2&pageSize=10', '.paper-list-tools'],
    ['题集学习', '#/papers/' + h.state.paperId + '?tab=favorite', '#set-panel-favorite'],
    ['随机答题学习', '#/quick?tab=favorite', '.context-learning-panel'],
    ['全部错题', '#/learning/wrong', '.global-learning-page'],
    ['全部收藏', '#/learning/favorite', '.global-learning-page'],
    ['自适应复习队列', '#/learning/due?queuePageSize=20', '.adaptive-queue'],
    ['学习统计', '#/analytics', '.analytics-period-controls'],
    ['AI处理记录', '#/analytics?tab=ai', '.ai-history-filters'],
  ];
  for (const [name, hash, selector] of cases) await commitWindowNavigation(name, hash, selector);

  // Prove the shared guard still allows canonicalization on the same route.
  await go('#/questions?domainId=fixture-computer&page=2&pageSize=10');
  await page.locator('.question-row').nth(9).waitFor();
  await page.locator('.filters-panel input[type="search"]').fill('导航样例');
  await page.waitForFunction(() => {
    const p = new URLSearchParams(location.hash.split('?')[1]);
    return p.get('search') === '导航样例' && !p.has('page');
  });
  assert.equal((await params()).get('domainId'), 'fixture-computer');
  const questionPagination = page.getByRole('navigation', { name: '列表分页', exact: true });
  await questionPagination.getByRole('button', { name: '下一页', exact: false }).click();
  await page.waitForFunction(
    () => new URLSearchParams(location.hash.split('?')[1]).get('page') === '2',
  );
  assert.equal((await params()).get('search'), '导航样例');
  checks.push({ name: '题库同页筛选重置页码、翻页保留领域与关键词', passed: true });

  await go('#/documents?domainId=fixture-computer&page=2&pageSize=10');
  await page.locator('.document-card').nth(9).waitFor();
  await page.locator('.filters-panel input[type="search"]').fill('导航资料');
  await page.waitForFunction(() => {
    const p = new URLSearchParams(location.hash.split('?')[1]);
    return p.get('search') === '导航资料' && !p.has('page');
  });
  assert.equal((await params()).get('domainId'), 'fixture-computer');
  await page
    .getByRole('navigation', { name: '资料库分页', exact: true })
    .getByRole('button', { name: '下一页', exact: false })
    .click();
  await page.waitForFunction(
    () => new URLSearchParams(location.hash.split('?')[1]).get('page') === '2',
  );
  assert.equal((await params()).get('search'), '导航资料');
  checks.push({ name: '资料同页搜索重置页码、翻页保留筛选', passed: true });

  await go('#/analytics?tab=ai');
  await page.getByLabel('AI记录状态', { exact: true }).selectOption('failed');
  await page.waitForFunction(
    () => new URLSearchParams(location.hash.split('?')[1]).get('status') === 'failed',
  );
  assert.equal((await params()).get('tab'), 'ai');
  checks.push({ name: 'AI记录同页筛选保留统计页签', passed: true });
  h.assertClean();
  await writeFile(
    resolve(h.folder, 'report.json'),
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        errors: h.errors,
        external: h.external,
        database: ':memory:',
        realModelCalls: 0,
      },
      null,
      2,
    ) + '\n',
  );
  await rm(resolve(h.folder, 'failure.json'), { force: true });
  await rm(resolve(h.folder, 'failure.png'), { force: true });
  console.log(JSON.stringify({ passed: checks.length, report: resolve(h.folder, 'report.json') }));
} catch (error) {
  await h.captureFailure(error, { checks });
  throw error;
} finally {
  await h.close();
}
