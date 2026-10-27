/** Optional real-provider acceptance using a public textbook fixture only.
 * Run: node --import tsx scripts/qa/check-ai-batch-live.ts
 * Reads the configured credentials without changing the working database.
 * Every application write uses :memory:. Evidence is redacted and each run gets
 * a new directory; expected negative controls are labelled, never hidden.
 * --feedback-only runs one real feedback-review call in a fresh memory DB.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from '../../server/index.js';
import { DatabaseConnection } from '../../server/database/connection.js';
import type { PrivateAiSettings } from '../../server/modules/ai/provider.js';

const root = resolve(import.meta.dirname, '../..');
const feedbackOnly = process.argv.includes('--feedback-only');
const artifactRoot = resolve(root, feedbackOnly ? 'test-results/ai-feedback-live' : 'test-results/ai-batch-live');
const output = resolve(artifactRoot, 'run-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
await mkdir(output, { recursive: true });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const settingsDatabase = new DatabaseConnection(resolve(root, 'data/noetic-atlas.sqlite'), false);
let privateSettings: PrivateAiSettings, settingsFingerprint: string;
try {
  privateSettings = settingsDatabase.getRecord<PrivateAiSettings>('ai_settings', 'local')!;
  assert.ok(privateSettings?.baseUrl && privateSettings.model, 'EXISTING_AI_CONFIGURATION_REQUIRED');
  settingsFingerprint = digest(JSON.stringify(privateSettings));
} finally { settingsDatabase.close(); }
const secret = privateSettings.key || '';
const redact = (value: string) => secret ? value.replaceAll(secret, '[redacted]') : value;
const model = privateSettings.model, provider = new URL(privateSettings.baseUrl).hostname;
const safeError = (reason: any) => ({ code: typeof reason?.code === 'string' ? reason.code : reason?.name || 'FAILED', message: redact(String(reason?.message || reason)).slice(0, 2000) });
const write = async (name: string, data: unknown) => writeFile(resolve(output, name), redact(JSON.stringify(data, null, 2)), 'utf8');
const checks: Array<Record<string, unknown>> = [], operations: Array<Record<string, unknown>> = [];
const captures: Promise<void>[] = [];
let stage = 'setup', providerRequests = 0, currentJob: any, app: Awaited<ReturnType<typeof buildApp>> | undefined;
let ok = false, failure: ReturnType<typeof safeError> | undefined, workingSettingsUnchanged = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  const address = new URL(args[0] instanceof Request ? args[0].url : String(args[0]));
  if (address.hostname !== provider || !address.pathname.endsWith('/chat/completions')) return originalFetch(...args);
  assert.ok(providerRequests < (feedbackOnly ? 1 : 8), 'REAL_PROVIDER_REQUEST_BUDGET_EXHAUSTED');
  const number = ++providerRequests, requestedStage = stage;
  const response = await originalFetch(...args);
  // Never persist provider error bodies, headers, request material or hidden
  // reasoning. Successful assistant content comes solely from the public book.
  captures.push((async () => {
    const evidence: Record<string, unknown> = { number, stage: requestedStage, status: response.status, contentType: response.headers.get('content-type'), negativeControl: requestedStage === 'controlled_invalid_model_failure' };
    if (response.ok) {
      const raw = await response.clone().text();
      try {
        if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
          const frames = raw.split(/\r?\n/).filter(line => line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]').map(line => JSON.parse(line.slice(6)));
          evidence.content = frames.map(frame => frame.choices?.[0]?.delta?.content || '').join('');
          evidence.finishReason = frames.map(frame => frame.choices?.[0]?.finish_reason).filter(Boolean).at(-1);
        } else {
          const envelope = JSON.parse(raw), choice = envelope.choices?.[0];
          evidence.content = typeof choice?.message?.content === 'string' ? choice.message.content : null;
          evidence.finishReason = choice?.finish_reason;
          evidence.usage = { promptTokens: envelope.usage?.prompt_tokens, completionTokens: envelope.usage?.completion_tokens };
        }
      } catch { evidence.envelopeParseFailed = true; evidence.responseCharacters = raw.length; }
    } else evidence.errorBodyPersisted = false;
    await write(`provider-response-${number}.json`, evidence);
  })());
  return response;
};

async function api(path: string, method = 'GET', payload?: unknown, expected = 200): Promise<any> {
  const started = performance.now();
  const response = await app!.inject({ url: path, method: method as any, ...(payload === undefined ? {} : { payload }) });
  const result = response.json();
  operations.push({ path, method, status: response.statusCode, durationMs: Math.round(performance.now() - started), stage });
  if (response.statusCode !== expected) {
    const reason: any = new Error(result.error?.message || `Unexpected HTTP ${response.statusCode}`); reason.code = result.error?.code || 'HTTP_STATUS'; throw reason;
  }
  return result;
}
async function configure(selectedModel = model) {
  const { key, updatedAt: _privateVersion, ...configuration } = privateSettings;
  const result = await api('/api/ai/settings', 'PUT', { ...configuration, key, enabled: true, model: selectedModel, timeoutSeconds: 180, maxTokens: 8192 });
  assert.ok(!Object.hasOwn(result, 'key'), 'PUBLIC_SETTINGS_MUST_NOT_RETURN_KEY');
}
async function step(name: string, action: () => Promise<Record<string, unknown> | void>) {
  stage = name; const started = performance.now();
  try {
    const metrics = await action(); checks.push({ name, ok: true, durationMs: Math.round(performance.now() - started), ...metrics });
    console.log(redact(JSON.stringify(checks.at(-1))));
  } catch (reason) {
    checks.push({ name, ok: false, durationMs: Math.round(performance.now() - started), failure: safeError(reason) }); throw reason;
  } finally { await write('progress.json', { at: new Date().toISOString(), model, provider, providerRequests, checks }); }
}
function assertJobPhase(job: any, name: 'planStatus' | 'generationStatus', blockIndex: number) {
  const block = job.blocks[blockIndex];
  if (block[name] !== 'completed') {
    const detail = block[name === 'planStatus' ? 'planFailure' : 'generationFailure'];
    const reason: any = new Error(detail?.message || `Block ${blockIndex + 1} is ${block[name]}`); reason.code = detail?.code || 'BATCH_NOT_COMPLETED'; throw reason;
  }
}
async function feedbackCase(chapterUrl: string) {
  let source: any, candidate: any, feedback: any, before: any;
  await step('create_public_conflicting_answer_feedback', async () => {
    const common = { type: 'single_choice', title: 'Python运算优先级', stemMarkdown: 'Python表达式 `2 + 3 * 4` 的值是多少？', options: [{ key: 'A', text: '14' }, { key: 'B', text: '20' }], explanationMarkdown: '乘法优先于加法，先计算3*4得到12，再加2得到14。', categoryIds: ['batch-live-python'], tagIds: [], sourceRefs: [{ label: 'Think Python 2e，第2章运算顺序', url: chapterUrl }] };
    source = await api('/api/questions', 'POST', { ...common, id: 'LIVE-FEEDBACK-WRONG', correctAnswers: ['B'], answerMarkdown: 'B，20。' }, 201);
    candidate = await api('/api/questions', 'POST', { ...common, id: 'LIVE-FEEDBACK-CORRECT', correctAnswers: ['A'], answerMarkdown: 'A，14。' }, 201);
    await api('/api/questions/review', 'POST', { ids: [source.id, candidate.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [source.id]: source.updatedAt, [candidate.id]: candidate.updatedAt } });
    source = await api('/api/questions/' + source.id);
    feedback = await api('/api/question-feedback', 'POST', { questionId: source.id, kind: 'answer', description: '标准答案写B（20），但解析计算得到14，对应A。请核查参考答案是否与解析矛盾，并对比本机相同题目的正确版本；仅给出建议，不自动修改题目。', expectedUpdatedAt: source.updatedAt }, 201);
    assert.equal(feedback.status, 'pending'); assert.equal(providerRequests, 0);
    before = await api('/api/questions/' + source.id);
    const candidates = await api('/api/question-feedback/' + feedback.id + '/candidates');
    assert.ok(candidates.items.some((item: any) => item.questionId === candidate.id));
    assert.ok(candidates.items.length <= 8); assert.equal(providerRequests, 0);
    await write('feedback-before.json', feedback); await write('candidates.json', candidates); await write('source-before.json', before);
    return { confirmedAnswerConflict: 'reference B/20 versus explanation A/14', matchingCandidateFound: true, candidateCount: candidates.items.length, feedbackStatus: 'pending', noAiBeforeExplicitReview: true };
  });
  await step('real_ai_review_feedback_and_compare_local_candidate', async () => {
    const result = await api('/api/question-feedback/ai-review', 'POST', { ids: [feedback.id], expectedUpdatedAt: { [feedback.id]: feedback.updatedAt } });
    if (result.status !== 'completed') {
      await write('feedback-review-failed.json', result);
      const reason: any = new Error(result.items[0]?.failure?.message || 'Feedback review did not complete'); reason.code = result.items[0]?.failure?.code || 'FEEDBACK_REVIEW_FAILED'; throw reason;
    }
    assert.equal(result.completed, 1); assert.equal(result.failed, 0); assert.equal(providerRequests, 1);
    const reviewed = result.items[0].feedback;
    assert.equal(reviewed.status, 'pending', 'AI recommendation must not change user handling status');
    assert.equal(reviewed.review.verdict, 'valid', 'The deliberate answer/explanation conflict should be detected');
    assert.ok(reviewed.review.reason.trim()); assert.ok(reviewed.review.comparisons.some((item: any) => item.questionId === candidate.id && item.reason.trim()));
    const after = await api('/api/questions/' + source.id); assert.deepEqual(after, before, 'AI review must not edit question or publication');
    const run = await api('/api/ai/runs/' + result.items[0].runId);
    assert.equal(run.kind, 'feedback_review'); assert.equal(run.status, 'completed'); assert.equal(run.diagnostics.providerCalls, 1); assert.equal(run.diagnostics.httpStatus, 200);
    const reopened = await api('/api/question-feedback/' + feedback.id); assert.deepEqual(reopened.review, reviewed.review);
    await write('feedback-reviewed.json', result); await write('feedback-history.json', run); await write('source-after.json', after);
    return { verdict: reviewed.review.verdict, comparisons: reviewed.review.comparisons.map((item: any) => ({ questionId: item.questionId, relation: item.relation })), handlingStatusPreserved: true, publishedSourceUnchanged: true, historyDiagnostics: true, resultRetainedOnReopen: true };
  });
}

try {
  const sourceText = await readFile(resolve(root, 'test-results/ai-live-textbook/browser-extracted-text.txt'), 'utf8');
  const sourceMetadata = JSON.parse(await readFile(resolve(root, 'test-results/ai-live-textbook/source.json'), 'utf8'));
  const pages = [...sourceText.matchAll(/--- 第(\d+)页 ---\r?\n([\s\S]*?)(?=--- 第\d+页 ---|$)/g)];
  assert.equal(pages.length, 5, 'PUBLIC_TEXTBOOK_FIXTURE_MUST_CONTAIN_FIVE_PAGES');
  assert.equal(sourceMetadata.excerptPages, 5);
  await write('source.json', { ...sourceMetadata, extractedCharacters: sourceText.length, extractedTextSha256: digest(sourceText), sourceFixture: 'test-results/ai-live-textbook/browser-extracted-text.txt' });
  app = await buildApp({ databasePath: ':memory:', seedPath: 'no-batch-live-fixture', dailyPushScheduler: false, logger: false });
  await configure();
  await api('/api/domains', 'POST', { id: 'batch-live-computer', name: '计算机', description: '隔离真实教材验收', sortOrder: 0 }, 201);
  await api('/api/categories', 'POST', { id: 'batch-live-python', name: 'Python基础', domainId: 'batch-live-computer', parentId: null, description: '公开教材第二章', sortOrder: 0 }, 201);

  if (feedbackOnly) {
    await feedbackCase(sourceMetadata.chapterUrl);
  } else {
  await step('configured_provider_connection', async () => {
    const result = await api('/api/ai/test', 'POST', {}); assert.equal(result.ok, true); assert.equal(result.model, model);
    return { provider, model, credentialsNotReturned: true };
  });

  await step('create_confirmed_private_job_from_two_public_textbook_blocks', async () => {
    const before = providerRequests;
    currentJob = await api('/api/ai/document-jobs', 'POST', {
      confirmed: true, sourceName: 'Think Python 2e 第2章正文（原书9—13页）', sourceUrl: sourceMetadata.chapterUrl,
      sections: [
        { label: '教材正文前2页', sourceName: 'Think Python 2e 第2章', text: pages.slice(0, 2).map(page => page[2]).join('\n\n'), pageStart: 31, pageEnd: 32 },
        { label: '教材正文后3页', sourceName: 'Think Python 2e 第2章', text: pages.slice(2).map(page => page[2]).join('\n\n'), pageStart: 33, pageEnd: 35 },
      ], mode: 'generate', requirements: '仅依据本块教材生成最多2道中文基础简答题，一道考概念，一道使用新编小例子考应用。答案要点清楚且解析说明原因，不抄录原文；不依赖教材图片，不扩展到未提供的循环、函数、类等内容。',
      questionTypes: ['short_answer'], difficulty: 2, categoryIds: ['batch-live-python'], tagIds: [], questionsPerBlock: 2, maxQuestions: 4,
    }, 201);
    assert.equal(currentJob.blockCount, 2); assert.equal(providerRequests, before);
    assert.ok(currentJob.blocks.every((block: any) => !Object.hasOwn(block, 'text')));
    assert.equal((await api('/api/questions?status=all')).total, 0);
    const list = await api('/api/ai/document-jobs?page=1&pageSize=10'); assert.equal(list.total, 1); assert.ok(!Object.hasOwn(list.items[0], 'blocks'));
    await write('job-created.json', currentJob);
    return { blocks: 2, noModelCallOnCreate: true, privateTextAbsentFromResponses: true, questions: 0 };
  });

  await step('summarize_selected_first_block', async () => {
    const before = providerRequests;
    currentJob = await api(`/api/ai/document-jobs/${currentJob.id}/plan`, 'POST', { blockIds: [currentJob.blocks[0].id] });
    assertJobPhase(currentJob, 'planStatus', 0); assert.equal(currentJob.blocks[1].planStatus, 'pending');
    assert.equal(providerRequests, before + 1); assert.ok(currentJob.blocks[0].summary.trim() && currentJob.blocks[0].topics.length);
    await write('job-first-plan.json', currentJob);
    return { plannedBlocks: 1, unselectedBlockUntouched: true, title: currentJob.blocks[0].title, topicCount: currentJob.blocks[0].topics.length };
  });

  await step('controlled_invalid_model_failure', async () => {
    const originalSummary = currentJob.blocks[0].summary;
    try {
      await configure('noetic-atlas-acceptance-invalid-model');
      currentJob = await api(`/api/ai/document-jobs/${currentJob.id}/plan`, 'POST', { blockIds: [currentJob.blocks[1].id] });
      assert.equal(currentJob.status, 'partial'); assert.equal(currentJob.blocks[1].planStatus, 'failed');
      assert.equal(currentJob.blocks[0].summary, originalSummary);
      const detail = currentJob.blocks[1].planFailure; assert.ok(detail.auditId); assert.equal(detail.code, 'AI_PROVIDER_ERROR');
      const run = await api('/api/ai/runs/' + detail.auditId);
      assert.equal(run.status, 'failed'); assert.equal(run.jobId, currentJob.id); assert.equal(run.batchId, currentJob.blocks[1].id);
      assert.ok(run.diagnostics.httpStatus >= 400 && run.diagnostics.httpStatus < 500); assert.ok(run.failure.recommendation);
      assert.ok(!Object.hasOwn(run, 'result')); assert.match(detail.message, /HTTP/);
      await write('expected-failure-job.json', currentJob); await write('expected-failure-history.json', run);
      return { negativeControl: true, expectedFailure: detail.code, providerHttpStatus: run.diagnostics.httpStatus, audited: true, successfulSummaryPreserved: true };
    } finally { await configure(); }
  });

  await step('retry_only_failed_summary_and_reopen_task', async () => {
    const before = providerRequests, firstVersion = currentJob.blocks[0].planRunId;
    currentJob = await api(`/api/ai/document-jobs/${currentJob.id}/plan`, 'POST', { blockIds: currentJob.blocks.map((block: any) => block.id), retryFailed: true });
    assertJobPhase(currentJob, 'planStatus', 0); assertJobPhase(currentJob, 'planStatus', 1);
    assert.equal(providerRequests, before + 1); assert.equal(currentJob.blocks[0].planRunId, firstVersion);
    assert.equal(currentJob.blocks[0].planAttempts, 1); assert.equal(currentJob.blocks[1].planAttempts, 2);
    const reopened = await api(`/api/ai/document-jobs/${currentJob.id}`); assert.deepEqual(reopened, currentJob);
    await write('job-planned.json', currentJob);
    return { plannedBlocks: 2, providerCallsForRetry: 1, firstBlockNotRepeated: true, progressRetainedOnReopen: true };
  });

  await step('generate_one_block_then_all_without_repeating_success', async () => {
    const initial = providerRequests;
    currentJob = await api(`/api/ai/document-jobs/${currentJob.id}/generate`, 'POST', { blockIds: [currentJob.blocks[0].id], questionsPerBlock: 2 });
    assertJobPhase(currentJob, 'generationStatus', 0); assert.equal(currentJob.blocks[1].generationStatus, 'pending');
    assert.equal(providerRequests, initial + 1); assert.equal((await api('/api/questions?status=all')).total, 0);
    const firstPreview = JSON.stringify(currentJob.blocks[0].questions), firstRun = currentJob.blocks[0].generationRunId;
    currentJob = await api(`/api/ai/document-jobs/${currentJob.id}/generate`, 'POST', { blockIds: currentJob.blocks.map((block: any) => block.id), questionsPerBlock: 2 });
    assertJobPhase(currentJob, 'generationStatus', 1); assert.equal(providerRequests, initial + 2);
    assert.equal(currentJob.blocks[0].generationRunId, firstRun); assert.equal(JSON.stringify(currentJob.blocks[0].questions), firstPreview);
    assert.ok(currentJob.questionCount >= 2 && currentJob.questionCount <= 4);
    for (const block of currentJob.blocks) for (const question of block.questions) {
      assert.equal(question.type, 'short_answer'); assert.equal(question.status, 'pending'); assert.equal(question.difficulty, 2);
      assert.deepEqual(question.categoryIds, ['batch-live-python']); assert.ok(question.answerMarkdown.trim() && question.explanationMarkdown.trim());
      assert.ok(question.sourceRefs.some((source: any) => source.url === sourceMetadata.chapterUrl));
      assert.match(question.sourceAnchor, new RegExp(`PDF文件页${block.pageStart}`));
    }
    assert.equal((await api('/api/questions?status=all')).total, 0);
    await write('job-generated.json', currentJob);
    return { generatedBlocks: 2, questions: currentJob.questionCount, selectedThenAllCalls: 2, priorPreviewPreserved: true, noUnconfirmedQuestions: true };
  });

  await step('explicit_pending_import_and_duplicate_confirmation_guard', async () => {
    const blockIds = currentJob.blocks.map((block: any) => block.id);
    await api(`/api/ai/document-jobs/${currentJob.id}/import`, 'POST', { confirmed: false, blockIds }, 400);
    assert.equal((await api('/api/questions?status=all')).total, 0);
    const result = await api(`/api/ai/document-jobs/${currentJob.id}/import`, 'POST', { confirmed: true, blockIds });
    assert.equal(result.added, currentJob.questionCount); assert.ok(result.items.every((question: any) => question.status === 'pending'));
    currentJob = result.job; assert.equal(currentJob.status, 'completed');
    await api(`/api/ai/document-jobs/${currentJob.id}/import`, 'POST', { confirmed: true, blockIds }, 409);
    assert.equal((await api('/api/questions?status=all')).total, result.added);
    const reopened = await api(`/api/ai/document-jobs/${currentJob.id}`); assert.deepEqual(reopened, currentJob);
    await write('imported-pending-questions.json', result.items);
    return { added: result.added, allPending: true, duplicateConfirmationBlocked: true, progressRetainedOnReopen: true };
  });

  await step('history_includes_failed_attempt_and_success_diagnostics', async () => {
    const page = await api('/api/ai/runs?page=1&pageSize=20');
    const runs = page.items;
    assert.equal(runs.filter((run: any) => run.status === 'failed').length, 1);
    const completed = runs.filter((run: any) => run.status === 'completed'); assert.equal(completed.length, 4);
    assert.ok(completed.every((run: any) => run.jobId === currentJob.id && run.batchId && run.diagnostics.providerCalls === 1));
    assert.ok(completed.every((run: any) => run.diagnostics.durationMs >= 0 && run.diagnostics.httpStatus === 200));
    await write('history.json', runs);
    return { completedBatchRecords: completed.length, expectedFailedRecords: 1, stageHttpTimingAvailable: true, failedAttemptRetainedAfterRetry: true };
  });
  }
  ok = true;
} catch (reason) {
  failure = safeError(reason); console.log(redact(JSON.stringify({ ok: false, stage, failure }))); process.exitCode = 1;
} finally {
  await Promise.allSettled(captures); globalThis.fetch = originalFetch;
  if (app && currentJob?.id) {
    try { currentJob = await api(`/api/ai/document-jobs/${currentJob.id}`); await write('job-last.json', currentJob); } catch { /* Preserve primary failure. */ }
    try { await write('history-last.json', await api('/api/ai/runs?page=1&pageSize=20')); } catch { /* Preserve primary failure. */ }
  }
  const after = new DatabaseConnection(resolve(root, 'data/noetic-atlas.sqlite'), false);
  try { workingSettingsUnchanged = digest(JSON.stringify(after.getRecord('ai_settings', 'local'))) === settingsFingerprint; }
  finally { after.close(); }
  if (!workingSettingsUnchanged) { ok = false; failure = { code: 'WORKING_SETTINGS_CHANGED', message: '工作AI配置指纹发生变化，需人工核对。' }; process.exitCode = 1; }
  const files = await readdir(output); let credentialMatches = 0;
  for (const file of files) if (secret && (await readFile(resolve(output, file), 'utf8')).includes(secret)) credentialMatches++;
  if (credentialMatches) { ok = false; failure = { code: 'CREDENTIAL_EVIDENCE_CHECK_FAILED', message: '测试证据中的凭据检查未通过。' }; process.exitCode = 1; }
  const report = { generatedAt: new Date().toISOString(), ok, model, provider, database: ':memory:', providerRequests, expectedNegativeControls: feedbackOnly ? 0 : 1, expectedNegativeControlsAreNotAnObservedFailureRate: true, checks, operations, ...(failure ? { failure, failedStage: stage } : {}), workingSettingsUnchanged, privateQuestionDataUsed: false, credentialsPersisted: credentialMatches > 0, evidenceFilesScanned: files.length, credentialMatches, limits: ['Public text-PDF fixture; OCR and physical Android not tested.', 'Reopening is via GET within the process; process restart is covered by separate persistence tests.', 'Only this textbook sample; generated answers still require content review.'] };
  await write('report.json', report);
  await writeFile(resolve(artifactRoot, 'latest.json'), JSON.stringify({ at: report.generatedAt, ok, directory: output, report: resolve(output, 'report.json') }, null, 2));
  console.log(redact(JSON.stringify({ ok, checks: checks.filter(item => item.ok).length, providerRequests, workingSettingsUnchanged, directory: output })));
  await app?.close();
}
