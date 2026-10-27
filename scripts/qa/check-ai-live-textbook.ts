/** Optional real-provider acceptance. Only public textbook material and synthetic
 * answers leave this process. The working database is read only for credentials;
 * all application writes use an in-memory database. Never log private settings.
 * Run after npm run build: node --import tsx scripts/qa/check-ai-live-textbook.ts
 * --resume-grading preserves the previous evidence and reruns only the remaining
 * public grading/extraction/planning scenarios in a NEW memory database.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { buildApp } from '../../server/index.js';
import { DatabaseConnection } from '../../server/database/connection.js';
import type { PrivateAiSettings } from '../../server/modules/ai/provider.js';

const root = resolve(import.meta.dirname, '../..'), artifactRoot = resolve(root, 'test-results/ai-live-textbook');
const resumeGrading = process.argv.includes('--resume-grading');
const output = resumeGrading ? resolve(artifactRoot, 'followup-' + new Date().toISOString().replace(/[:.]/g, '-')) : artifactRoot;
const sourceUrl = 'https://greenteapress.com/thinkpython2/thinkpython2.pdf';
const chapterUrl = 'https://greenteapress.com/thinkpython2/html/thinkpython2003.html';
const fullPath = resolve(artifactRoot, 'thinkpython2-source.pdf'), excerptPath = resolve(artifactRoot, 'thinkpython2-chapter2-excerpt.pdf');
await mkdir(output, { recursive: true });
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const privateDatabase = new DatabaseConnection(resolve(root, 'data/noetic-atlas.sqlite'), false);
let privateSettings: PrivateAiSettings, privateFingerprint: string;
try {
  privateSettings = privateDatabase.getRecord<PrivateAiSettings>('ai_settings', 'local')!;
  assert.ok(privateSettings?.baseUrl && privateSettings?.model, 'AI_CONFIGURATION_MISSING');
  privateFingerprint = digest(JSON.stringify(privateSettings));
} finally { privateDatabase.close(); }
const model = privateSettings.model;
const provider = new URL(privateSettings.baseUrl).hostname;
const checks: Array<Record<string, unknown>> = [], errors: string[] = [], externalRequests: string[] = [];
const applicationAiRequests: Array<{ path: string; status: number; durationMs: number }> = [];
const runResults: Record<string, unknown> = {};
let app: Awaited<ReturnType<typeof buildApp>> | undefined, browser: any, page: any;
let origin = '', currentStep = 'setup', streamContentType = '';
const safeError = (error: any) => ({ code: typeof error?.code === 'string' ? error.code : error?.name || 'FAILED', message: String(error?.message || error).replaceAll(privateSettings?.key || '\0', '[redacted]').slice(0, 1800) });
const responseCaptures: Promise<void>[] = [];
const originalFetch = globalThis.fetch;
let providerCallCount = 0;
// Capture only response bodies produced from public textbook/synthetic fixtures.
// Do not retain request headers, credentials or the private settings object.
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]));
  const response = await originalFetch(...args);
  if (url.hostname === provider && url.pathname.endsWith('/chat/completions')) {
    const number = ++providerCallCount, stage = currentStep;
    const request = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : {};
    responseCaptures.push(response.clone().text().then(async raw => {
      const body = raw.replaceAll(privateSettings.key || '\0', '[redacted]');
      await writeFile(resolve(output, `provider-response-${number}.json`), JSON.stringify({ number, stage, status: response.status, contentType: response.headers.get('content-type'), requested: { model: request.model, responseFormat: request.response_format, streaming: request.stream, maxTokens: request.max_tokens }, body }, null, 2));
    }));
  }
  return response;
};

async function prepareTextbook() {
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(fullPath)); }
  catch {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(60_000) });
    assert.equal(response.status, 200, 'TEXTBOOK_DOWNLOAD_FAILED');
    bytes = new Uint8Array(await response.arrayBuffer()); await writeFile(fullPath, bytes);
  }
  const original = await PDFDocument.load(bytes);
  assert.equal(original.getPageCount(), 244, 'TEXTBOOK_SOURCE_CHANGED');
  let excerpt: Uint8Array;
  try { excerpt = new Uint8Array(await readFile(excerptPath)); }
  catch {
    const document = await PDFDocument.create();
    for (const page of await document.copyPages(original, [30, 31, 32, 33, 34])) document.addPage(page);
    excerpt = await document.save(); await writeFile(excerptPath, excerpt);
  }
  assert.equal((await PDFDocument.load(excerpt)).getPageCount(), 5);
  const source = { title: 'Think Python, 2nd edition, version 2.4.1', author: 'Allen B. Downey', sourceUrl, chapterUrl, license: 'CC BY-NC 3.0', sourcePages: 244, sourceFilePages: [31, 32, 33, 34, 35], printedPages: '9–13', excerptPages: 5, sourceSha256: digest(bytes), excerptSha256: digest(excerpt) };
  await writeFile(resolve(output, 'source.json'), JSON.stringify(source, null, 2)); return source;
}

async function api(path: string, method = 'GET', payload?: unknown, expected = 200): Promise<any> {
  const started = performance.now(), response = await app!.inject({ method: method as any, url: path, ...(payload === undefined ? {} : { payload }) });
  if (path.startsWith('/api/ai/') && ['POST', 'PUT'].includes(method) && !path.includes('/runs/')) applicationAiRequests.push({ path, status: response.statusCode, durationMs: Math.round(performance.now() - started) });
  const body = response.json();
  if (response.statusCode !== expected) {
    const error: any = new Error(body.error?.message || `Unexpected HTTP ${response.statusCode}: ${path}`);
    error.code = body.error?.code || 'HTTP_STATUS'; error.status = response.statusCode; throw error;
  }
  return body;
}
async function step(name: string, action: () => Promise<Record<string, unknown> | void>) {
  currentStep = name; const started = performance.now();
  let row: Record<string, unknown>;
  try { const metrics = await action(); row = { name, ok: true, durationMs: Math.round(performance.now() - started), ...metrics }; }
  catch (error) { if (!resumeGrading) throw error; row = { name, ok: false, durationMs: Math.round(performance.now() - started), failure: safeError(error) }; }
  checks.push(row); console.log(JSON.stringify(row));
  await writeFile(resolve(output, 'progress.json'), JSON.stringify({ generatedAt: new Date().toISOString(), model, provider, checks }, null, 2));
  await writeFile(resolve(output, 'public-results.json'), JSON.stringify(runResults, null, 2));
}

try {
  const source = await prepareTextbook();
  app = await buildApp({ databasePath: ':memory:', seedPath: 'no-live-textbook-seed', staticRoot: 'dist/web', dailyPushScheduler: false, logger: false });
  const { key, updatedAt: _sourceVersion, ...configuration } = privateSettings;
  await api('/api/ai/settings', 'PUT', { ...configuration, enabled: true, key, timeoutSeconds: 180, maxTokens: 8192 });
  await api('/api/domains', 'POST', { id: 'live-computer', name: '计算机', description: '隔离教材验收', sortOrder: 0 }, 201);
  await api('/api/categories', 'POST', { id: 'live-python', domainId: 'live-computer', name: 'Python基础', parentId: null, description: '变量、表达式与语句', sortOrder: 0 }, 201);
  const synthetic = [
    { id: 'LIVE-S1', title: 'Python赋值的含义', type: 'short_answer', stemMarkdown: 'Python中的赋值语句有什么作用？变量名与值是什么关系？', answerMarkdown: '赋值语句将一个值绑定到变量名；变量名引用一个值，不需要先声明固定数据类型。', explanationMarkdown: '例如n=17让名称n指向整数值17；赋值本身不负责打印。' },
    { id: 'LIVE-S2', title: '算术表达式的优先级', type: 'short_answer', stemMarkdown: 'Python表达式1+2*3的结果是什么，为什么？怎样先做加法？', answerMarkdown: '结果为7，因为乘法优先于加法；(1+2)*3先计算括号内加法，结果为9。', explanationMarkdown: '括号可改变通常的运算优先级。' },
    { id: 'LIVE-TF', title: '变量名命名判断', type: 'true_false', stemMarkdown: 'Python变量名不能以数字开头。', correctAnswers: ['true'], answerMarkdown: '正确。' },
  ];
  const fixtures = [];
  for (const question of synthetic) fixtures.push(await api('/api/questions', 'POST', { ...question, categoryIds: ['live-python'], tagIds: [], sourceRefs: [{ label: 'Think Python 第2章', url: chapterUrl }], status: 'published' }, 201));
  await api('/api/questions/review', 'POST', { ids: fixtures.map(question => question.id), action: 'approve', confirmed: true, expectedUpdatedAt: Object.fromEntries(fixtures.map(question => [question.id, question.updatedAt])) });
  if (resumeGrading) {
    const previousEvidence: Record<string, unknown> = {};
    for (const filename of ['failure.json', 'progress.json', 'public-results.json']) {
      try { previousEvidence[filename] = JSON.parse(await readFile(resolve(artifactRoot, filename), 'utf8')); }
      catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    }
    await writeFile(resolve(output, 'prior-evidence.json'), JSON.stringify(previousEvidence, null, 2));
    const cached = JSON.parse(await readFile(resolve(artifactRoot, 'generated-preview.json'), 'utf8'));
    const restored = [];
    for (const [index, question] of cached.result.questions.entries()) restored.push(await api('/api/questions', 'POST', { ...question, id: `LIVE-CACHED-${index + 1}`, categoryIds: ['live-python'], tagIds: [], status: 'pending' }, 201));
    await api('/api/questions/review', 'POST', { ids: restored.map(question => question.id), action: 'approve', confirmed: true, expectedUpdatedAt: Object.fromEntries(restored.map(question => [question.id, question.updatedAt])) });
    runResults.continuation = { previousEvidence: 'prior-evidence.json', newMemoryDatabase: true, cachedPublicQuestionsRestored: restored.length, earlierStagesNotRepeated: true };
  }
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
  // Chromium does not always retain an SSE body for CDP getResponseBody. A
  // clone of the public local response records frames without consuming the
  // application's own stream or capturing any provider headers/credentials.
  await context.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await original(...args);
      const target = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), window.location.href);
      if (target.pathname === '/api/ai/import') void response.clone().text().then(text => { (window as any).__qaAiImportStream = text; });
      return response;
    };
  });
  page = await context.newPage(); page.setDefaultTimeout(240_000);
  page.on('pageerror', (error: Error) => errors.push(error.message));
  page.on('dialog', (dialog: any) => void dialog.accept());
  await page.route('**/*', (route: any) => { const url = new URL(route.request().url()); if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue(); externalRequests.push(url.origin); return route.abort(); });
  const capture = async (name: string) => { await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'HORIZONTAL_OVERFLOW'); await page.screenshot({ path: resolve(output, name + '.png'), fullPage: true }); };

  if (!resumeGrading) {
  await step('configured_provider_connection', async () => {
    const result = await api('/api/ai/test', 'POST', {}); assert.equal(result.ok, true); assert.equal(result.model, model);
    const publicSettings = await api('/api/ai/settings'); assert.ok(!Object.hasOwn(publicSettings, 'key'));
    return { model, provider, privateCredentialsNotReturned: true };
  });

  let generatedRun: any, imported: any;
  await step('pdf_local_extract_and_textbook_generation_preview', async () => {
    await page.goto(origin + '/#/ai?tab=import'); await page.waitForLoadState('networkidle');
    const input = page.getByLabel('AI导入原始文件', { exact: true });
    await input.setInputFiles(fullPath);
    await page.getByRole('alert').filter({ hasText: /最多150页/ }).waitFor();
    assert.equal((await api('/api/ai/runs?kind=import')).length, 0, 'oversize PDF must not invoke AI');
    await input.setInputFiles(excerptPath);
    await page.getByText(/已在本机提取5页文字/).waitFor();
    const extracted = await page.locator('.ai-source-text').inputValue();
    assert.match(extracted, /Variables, expressions|Assignment statements|Variable names/);
    assert.ok(extracted.length > 6000 && extracted.length < 40_000);
    await writeFile(resolve(output, 'browser-extracted-text.txt'), extracted);
    await page.getByLabel('处理方式', { exact: true }).selectOption('generate');
    await page.getByLabel('来源名称', { exact: true }).fill('Think Python 2e，第2章正文，原书9–13页（PDF文件页31–35）');
    await page.getByLabel('来源链接（可选）', { exact: true }).fill(chapterUrl);
    await page.getByLabel('出题或整理要求', { exact: true }).fill('请根据这5页教材提炼8道中文基础练习：判断2题、单选2题、填空2题、简答2题。覆盖变量赋值、合法命名、表达式、运算优先级、字符串运算、注释或调试。每题答案唯一或评分要点清晰，解析说明原因，尽量使用自己新编的小例子，不直接复制教材练习；不要依赖未提供的图片，不扩展到循环、函数、类等章节外内容。');
    await page.getByLabel(/本批最多.*题/).first().fill('8');
    await page.getByLabel('题目难度', { exact: true }).selectOption('2');
    const categories = page.locator('.multiselect').filter({ has: page.locator('.field-label').filter({ hasText: /^导入目标分类/ }) });
    await categories.getByRole('checkbox', { name: '计算机 / Python基础', exact: true }).check();
    const types = page.locator('.multiselect').filter({ has: page.locator('.field-label').filter({ hasText: /^题型范围/ }) });
    for (const label of ['判断', '单选', '填空', '简答 / 场景']) await types.getByRole('checkbox', { name: label, exact: true }).check();
    const before = (await api('/api/questions?status=all')).total;
    const responsePromise = page.waitForResponse((response: any) => new URL(response.url()).pathname === '/api/ai/import' && response.request().method() === 'POST');
    const generationStarted = performance.now();
    await page.getByRole('button', { name: /生成.*预览/ }).first().click();
    const response = await responsePromise; streamContentType = response.headers()['content-type'] || '';
    await page.getByRole('button', { name: '确认新增到待审核', exact: true }).waitFor();
    const runs = await api('/api/ai/runs?kind=import'); generatedRun = runs[0];
    assert.ok(generatedRun?.result?.questions?.length >= 6 && generatedRun.result.questions.length <= 8);
    assert.equal((await api('/api/questions?status=all')).total, before, 'preview is not an import');
    const questions = generatedRun.result.questions;
    assert.ok(new Set(questions.map((question: any) => question.type)).size >= 4, 'requested varied types were not produced');
    assert.ok(questions.filter((question: any) => question.type === 'short_answer').length >= 2);
    for (const question of questions) {
      assert.equal(question.status, 'pending'); assert.deepEqual(question.categoryIds, ['live-python']);
      assert.ok(question.sourceRefs.some((ref: any) => ref.url === chapterUrl));
      assert.ok(question.answerMarkdown.trim() && question.explanationMarkdown.trim());
    }
    assert.doesNotMatch(questions.map((question: any) => question.stemMarkdown).join('\n'), /元类|装饰器|metaclass|decorator|async/);
    assert.match(streamContentType, /text\/event-stream/);
    await page.waitForFunction(() => typeof (window as any).__qaAiImportStream === 'string');
    const stream = await page.evaluate(() => (window as any).__qaAiImportStream as string);
    const events = stream.split(/\r?\n/).filter((line: string) => line.startsWith('data: ')).map((line: string) => JSON.parse(line.slice(6)));
    applicationAiRequests.push({ path: '/api/ai/import', status: response.status(), durationMs: Math.round(performance.now() - generationStarted) });
    assert.equal(events.filter((event: any) => event.type === 'result').length, 1);
    assert.ok(events.filter((event: any) => event.type === 'status').length >= 2);
    assert.equal(events.filter((event: any) => event.type === 'error').length, 0);
    runResults.generated = generatedRun; await writeFile(resolve(output, 'generated-preview.json'), JSON.stringify(generatedRun, null, 2));
    await capture('textbook-generated-preview-desktop');
    return { excerptPages: 5, originalPrintedPages: '9–13', extractedCharacters: extracted.length, generatedQuestions: questions.length, types: [...new Set(questions.map((question: any) => question.type))], streaming: true, answerDeltaFrames: events.filter((event: any) => event.type === 'delta').length, noWriteBeforeConfirmation: true };
  });

  await step('editable_preview_explicit_pending_import', async () => {
    await page.getByText('编辑完整题目结构 JSON', { exact: true }).click();
    const jsonInput = page.getByLabel('AI转换题目JSON', { exact: true }), edited = JSON.parse(await jsonInput.inputValue());
    edited[0].title = '教材验收 · ' + edited[0].title; await jsonInput.fill(JSON.stringify(edited, null, 2));
    await api(`/api/ai/runs/${generatedRun.id}/import`, 'POST', { confirmed: false }, 400);
    await page.getByRole('button', { name: '确认新增到待审核', exact: true }).click();
    await page.getByText(/已新增\d+道待审核题/).first().waitFor();
    const run = await api('/api/ai/runs/' + generatedRun.id); assert.equal(run.importedQuestionIds.length, edited.length);
    imported = [];
    for (const id of run.importedQuestionIds) imported.push(await api('/api/questions/' + encodeURIComponent(id)));
    assert.ok(imported.every((question: any) => question.status === 'pending')); assert.ok(imported[0].title.startsWith('教材验收 · '));
    await api(`/api/ai/runs/${generatedRun.id}/import`, 'POST', { confirmed: true }, 409);
    await capture('textbook-import-pending');
    return { added: imported.length, editedTitleRetained: true, allPending: true, unconfirmedAndDuplicateBlocked: true };
  });

  await step('real_ai_review_and_explicit_publication', async () => {
    const bad = await api('/api/questions', 'POST', { id: 'LIVE-BAD', title: '明显错误的审核对照', type: 'true_false', stemMarkdown: '通常整数算术中，2+2=5。', answerMarkdown: '正确。', correctAnswers: ['true'], explanationMarkdown: '两个加两个等于五个。', categoryIds: ['live-python'], tagIds: [] }, 201);
    const questions = [...imported, bad];
    const run = await api('/api/ai/review', 'POST', { questionIds: questions.map(question => question.id), expectedUpdatedAt: Object.fromEntries(questions.map(question => [question.id, question.updatedAt])), autoApprove: false });
    assert.equal(run.result.items.length, questions.length); assert.deepEqual(run.result.approvedIds, []);
    assert.notEqual(run.result.items.find((item: any) => item.questionId === bad.id).verdict, 'valid', 'AI must identify the deliberately false control');
    for (const question of questions) assert.equal((await api('/api/questions/' + question.id)).status, 'pending');
    const valid = run.result.items.filter((item: any) => item.verdict === 'valid').map((item: any) => item.questionId);
    assert.ok(valid.length >= 4, 'too few generated questions passed content review');
    await api('/api/questions/review', 'POST', { ids: valid, action: 'approve', confirmed: true, expectedUpdatedAt: Object.fromEntries(questions.filter(question => valid.includes(question.id)).map(question => [question.id, question.updatedAt])) });
    assert.equal((await api('/api/questions/' + bad.id)).status, 'pending');
    runResults.review = run; await writeFile(resolve(output, 'content-review.json'), JSON.stringify(run, null, 2));
    return { reviewed: questions.length, generatedValid: valid.length, deliberateErrorBlocked: true, publicationRequiresUserAction: true };
  });

  await step('real_ai_explanation_note_application', async () => {
    const run = await api('/api/ai/explain', 'POST', { questionId: 'LIVE-S1' }); assert.ok(run.result.explanationMarkdown.length > 40);
    assert.equal((await api('/api/questions/LIVE-S1')).study.notes, '');
    await api(`/api/ai/runs/${run.id}/apply`, 'POST', { confirmed: true, appendNotes: true });
    const notes = (await api('/api/questions/LIVE-S1')).study.notes; assert.match(notes, /AI 辅助解析/);
    await api(`/api/ai/runs/${run.id}/apply`, 'POST', { confirmed: true, appendNotes: true });
    assert.equal((await api('/api/questions/LIVE-S1')).study.notes, notes);
    runResults.explanation = run;
    return { explanationCharacters: run.result.explanationMarkdown.length, notesExplicitAndIdempotent: true };
  });
  }

  const requirements = '根据提供的参考答案核对知识要点。完整覆盖要点且无错误判正确；只有部分正确要点判部分正确；明确回答不知道且没有有效要点，或与基本概念相反，判错误。计分时满分才正确，零分才错误。';
  await step('real_single_grading_distinguishes_good_and_wrong', async () => {
    const good = await api('/api/ai/grade', 'POST', { questionId: 'LIVE-S1', answer: synthetic[0].answerMarkdown, maxPoints: 5, gradingRequirements: requirements });
    runResults.singleGrades = { good };
    const bad = await api('/api/ai/grade', 'POST', { questionId: 'LIVE-S1', answer: '赋值语句会打印当前变量的值，变量名称必须以数字开头，所有变量必须先声明为固定整数类型。', maxPoints: 5, gradingRequirements: requirements });
    assert.equal(good.result.items[0].verdict, 'correct'); assert.equal(good.result.items[0].score, 5);
    assert.equal(bad.result.items[0].verdict, 'incorrect'); assert.equal(bad.result.items[0].score, 0);
    runResults.singleGrades = { good, bad }; return { correctScore: 5, wrongScore: 0, maxPoints: 5, gradingRequirementsRetained: good.result.gradingRequirements === requirements };
  });

  await step('real_batch_grading_apply_and_fsrs', async () => {
    const paper = await api('/api/papers', 'POST', { title: '真实AI教材计分验收', mode: 'manual', questionIds: ['LIVE-S1', 'LIVE-S2', 'LIVE-TF'], scoring: { enabled: true, totalPoints: 12, questionPoints: { 'LIVE-S1': 5, 'LIVE-S2': 5, 'LIVE-TF': 2 } } }, 201);
    const draft = await api('/api/papers/' + paper.id + '/attempts', 'POST', {}, 201);
    await api('/api/attempts/' + draft.id + '/submit', 'POST', { answers: { 'LIVE-S1': { value: synthetic[0].answerMarkdown }, 'LIVE-S2': { value: '不知道。' }, 'LIVE-TF': { value: 'true' } } });
    const before = await api('/api/review-scheduler/attempts/' + draft.id); assert.equal(before.items.filter((item: any) => item.eventId).length, 1);
    const run = await api('/api/ai/grade', 'POST', { attemptId: draft.id, gradingRequirements: requirements });
    assert.equal(run.result.items.length, 2); assert.equal((await api('/api/attempts/' + draft.id)).pendingSubjectiveCount, 2);
    await api(`/api/ai/runs/${run.id}/apply`, 'POST', { confirmed: false, applyScores: true }, 400);
    const applied = await api(`/api/ai/runs/${run.id}/apply`, 'POST', { confirmed: true, applyScores: true, appendNotes: true });
    assert.equal(applied.attempt.objectiveScore, 2); assert.equal(applied.attempt.subjectiveScore, 5); assert.equal(applied.attempt.totalScore, 7);
    const overview = await api('/api/review-scheduler/attempts/' + draft.id);
    assert.equal(overview.items.find((item: any) => item.leafId === 'LIVE-S1').rating, 'good'); assert.equal(overview.items.find((item: any) => item.leafId === 'LIVE-S2').rating, 'again');
    const repeated = await api(`/api/ai/runs/${run.id}/apply`, 'POST', { confirmed: true, applyScores: true, appendNotes: true }); assert.equal(repeated.appliedVerdicts.length, 0);
    assert.deepEqual(await api('/api/review-scheduler/attempts/' + draft.id), overview);
    runResults.batchGrade = run; return { subjectiveItems: 2, objectiveScorePreserved: 2, totalScore: 7, fsrsGoodAndAgain: true, repeatedApplyNoDuplicate: true };
  });

  await step('real_unscored_grading_preserves_no_score', async () => {
    const paper = await api('/api/papers', 'POST', { title: '真实AI教材无分验收', mode: 'manual', questionIds: ['LIVE-S1', 'LIVE-S2'], scoring: { enabled: false } }, 201);
    const draft = await api('/api/papers/' + paper.id + '/attempts', 'POST', {}, 201);
    await api('/api/attempts/' + draft.id + '/submit', 'POST', { answers: { 'LIVE-S1': { value: synthetic[0].answerMarkdown }, 'LIVE-S2': { value: '不知道。' } } });
    const run = await api('/api/ai/grade', 'POST', { attemptId: draft.id, gradingRequirements: requirements });
    assert.ok(run.result.items.every((item: any) => item.score === null && item.maxPoints === null));
    const applied = await api(`/api/ai/runs/${run.id}/apply`, 'POST', { confirmed: true, applyScores: true });
    assert.equal(applied.attempt.totalScore, null); assert.equal(applied.attempt.answers['LIVE-S1'].verdict, 'correct'); assert.equal(applied.attempt.answers['LIVE-S2'].verdict, 'incorrect');
    for (const answer of Object.values(applied.attempt.answers) as any[]) assert.ok(answer.selfScore == null);
    const overview = await api('/api/review-scheduler/attempts/' + draft.id); assert.equal(overview.items.filter((item: any) => item.eventId).length, 2);
    runResults.unscoredGrade = run; return { noInventedScores: true, explicitVerdicts: ['correct', 'incorrect'], fsrsEvents: 2 };
  });

  await step('existing_question_extraction_stays_available', async () => {
    const run = await api('/api/ai/import', 'POST', { text: '题目：Python变量名不能以数字开头。请判断正误。答案：正确。解析：名称可以包含数字，但第一位不能是数字。仅整理这1道已有判断题，不扩写。', mode: 'extract', sourceName: '合成题库格式整理对照', count: 1, categoryIds: ['live-python'] });
    assert.equal(run.result.questions.length, 1); assert.equal(run.result.questions[0].type, 'true_false'); assert.deepEqual(run.result.questions[0].correctAnswers, ['true']);
    runResults.extraction = run; return { extracted: 1, generationAndExtractionSeparated: true };
  });

  await step('real_recommended_paper_explicit_creation', async () => {
    const before = (await api('/api/papers')).length;
    const run = await api('/api/ai/paper-plan', 'POST', { prompt: '从本机已有Python基础题中推荐4道题，覆盖变量命名、赋值和表达式，从基础到应用安排。只使用已发布题号，不新编题。', count: 4, filters: { categoryId: 'live-python' } });
    assert.equal(run.result.items.length, 4); assert.equal(new Set(run.result.items.map((item: any) => item.questionId)).size, 4);
    assert.equal((await api('/api/papers')).length, before);
    const input = { confirmed: true, title: run.result.title, description: run.result.description, questionIds: run.result.items.map((item: any) => item.questionId), organization: 'domain', domainId: 'live-computer', scoring: { enabled: false } };
    const result = await api(`/api/ai/runs/${run.id}/paper`, 'POST', input, 201); assert.equal(result.paper.questionCount, 4);
    await api(`/api/ai/runs/${run.id}/paper`, 'POST', input, 409);
    runResults.paperPlan = run; return { selectedExistingPublished: 4, explicitCreation: true, duplicateCommitBlocked: true };
  });

  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  const after = new DatabaseConnection(resolve(root, 'data/noetic-atlas.sqlite'), false);
  try { assert.equal(digest(JSON.stringify(after.getRecord('ai_settings', 'local'))), privateFingerprint, 'WORKING_AI_SETTINGS_CHANGED'); } finally { after.close(); }
  await writeFile(resolve(output, 'public-results.json'), JSON.stringify(runResults, null, 2));
  await Promise.all(responseCaptures);
  const ok = checks.every(check => check.ok === true);
  const report = { generatedAt: new Date().toISOString(), ok, resumedGrading: resumeGrading, model, provider, source, checks, passed: checks.filter(check => check.ok === true).length, providerCallCount, applicationAiRequests: applicationAiRequests.filter(item => item.path !== '/api/ai/settings'), browserErrors: errors, externalBrowserRequests: externalRequests, database: ':memory:', workingAiSettingsUnchanged: true, credentialsPersisted: false, pdfOcr: false, modelAnswersNeedHumanReview: true };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ok, passed: report.passed, providerCallCount, model, provider, database: ':memory:', output }));
  if (!ok) process.exitCode = 1;
} catch (error) {
  if (page) await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  const report = { generatedAt: new Date().toISOString(), ok: false, currentStep, model, provider, failure: safeError(error), checks, applicationAiRequests: applicationAiRequests.filter(item => item.path !== '/api/ai/settings'), browserErrors: errors, externalBrowserRequests: externalRequests, database: ':memory:' };
  await writeFile(resolve(output, 'failure.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ok: false, currentStep, failure: safeError(error) })); process.exitCode = 1;
} finally { await Promise.allSettled(responseCaptures); globalThis.fetch = originalFetch; await browser?.close(); await app?.close(); }
