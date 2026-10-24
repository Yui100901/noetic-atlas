import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import initSqlJs from 'sql.js';
import { build } from 'vite';
import { nativeAliases } from '../../mobile/vite-aliases.ts';
import { learningSeed } from '../fixtures/learning-seed.js';

// Bundle the exact Android API runtime with exactly the production aliases.
// Only the file persistence adapter is substituted so crash/failure cases can
// be exercised without touching a user's device or installed application.
test('offline Android SQLite runtime: scoring, persistence rollback, imports and desktop compatibility', async t => {
  const folder = resolve('test-results/native-runtime'); await mkdir(folder, { recursive: true });
  await build({ configFile: false, logLevel: 'error', define: { 'process.env': '{}' }, resolve: { alias: nativeAliases }, build: { outDir: folder, emptyOutDir: false, minify: false, lib: { entry: resolve('mobile/runtime.ts'), formats: ['es'], fileName: () => 'runtime.mjs' } } });
  const { createLocalRuntime } = await import(pathToFileURL(resolve(folder, 'runtime.mjs')).href);
  const sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const fullSeed = learningSeed({ includeNonPublic: true });
  const publishedCount = fullSeed.questions.filter((q: any) => q.status === 'published').length;
  let durable: Uint8Array | undefined; let failSave = false; let saveCount = 0;
  const storage = { async load() { return durable?.slice(); }, async save(bytes: Uint8Array) { if (failSave) throw new Error('simulated disk full'); durable = bytes.slice(); saveCount++; } };
  let runtime = await createLocalRuntime(sql, fullSeed, storage);
  t.after(async () => { if (runtime) await runtime.close(); });
  async function call(url: string, method = 'GET', body?: unknown, status = 200): Promise<any> {
    const response = await runtime.fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  }
  const boot = await call('/api/bootstrap'); assert.equal(boot.stats.totalQuestions, publishedCount);
  assert.equal(boot.stats.favoriteCount, 0);
  assert.deepEqual((await call('/api/vocabulary?word=dependency')).matches,[],'portable word references resolve gracefully without an English pack in WASM SQLite');
  await call('https://attacker.invalid/api/questions', 'GET', undefined, 400);
  const rejectedOrigin = await runtime.fetch('/api/domains', { method: 'POST', headers: { Origin: 'https://attacker.invalid' }, body: JSON.stringify({ name: '不应写入' }) });
  assert.equal(rejectedOrigin.status, 403);
  const objective = fullSeed.questions.find((q: any) => q.type === 'single_choice');
  const subjective = fullSeed.questions.find((q: any) => q.type === 'short_answer');
  const savesBeforeMetadata=saveCount;failSave=true;
  const metadata=await call('/api/questions/metadata','POST',{ids:[subjective.id,'MOBILE-ABSENT-QUESTION',objective.id]});
  assert.deepEqual(metadata.items.map((question:any)=>question.id),[subjective.id,objective.id]);
  assert.deepEqual(metadata.missingIds,['MOBILE-ABSENT-QUESTION']);
  assert.equal(saveCount,savesBeforeMetadata,'question metadata is a pure read even when durable storage is unavailable');
  failSave=false;
  const questionSet = await call('/api/papers', 'POST', { title: '手机离线自定义题集', description: '统一学习、练习与考试', mode: 'manual', questionIds: [objective.id], scoring: { enabled: false } }, 201);
  const template = await call('/api/questions/import-template');
  assert.equal(template.format, 'learning-new-questions'); assert.equal(template.schemaVersion, 1);
  assert.deepEqual(new Set(template.questions.map((q: any) => q.type)), new Set(['short_answer', 'true_false', 'single_choice', 'multiple_choice', 'fill_blank', 'essay', 'group']));
  // New governance routes run unchanged inside the mobile WASM database.
  const domain = await call('/api/domains', 'POST', { id: 'mobile-review-domain', name: '移动审核验证' }, 201);
  const category = await call('/api/categories', 'POST', { id: 'mobile-review-category', name: '离线题目', domainId: domain.id }, 201);
  const tag = await call('/api/tags', 'POST', { id: 'mobile-review-topic', name: '领域主题', domainId: domain.id, kind: 'topic' }, 201);
  assert.equal(tag.domainId, domain.id);
  assert.equal((await call('/api/tags', 'POST', { name: '非法领域方法标签', domainId: domain.id, kind: 'method' }, 400)).error.code, 'METHOD_TAG_GLOBAL');
  const questionInput = { title: '手机自建题', type: 'short_answer', stemMarkdown: '解释离线持久化边界', answerMarkdown: '修改须落盘成功才可确认', status: 'published', categoryIds: [category.id], tagIds: [tag.id] };
  assert.equal((await call('/api/questions', 'POST', { ...questionInput, id: 'import-template' }, 400)).error.code, 'QUESTION_ID_RESERVED');
  assert.equal((await call('/api/questions', 'POST', { ...questionInput, categoryIds: [] }, 400)).error.code, 'TAG_DOMAIN_MISMATCH');
  const pending = await call('/api/questions', 'POST', { ...questionInput, id: 'MOBILE-REVIEW-ONE' }, 201);
  const pendingTwo = await call('/api/questions', 'POST', { ...questionInput, id: 'MOBILE-REVIEW-TWO' }, 201);
  assert.equal(pending.status, 'pending', 'a supplied published status cannot bypass user review');
  assert.equal((await call('/api/bootstrap')).stats.totalQuestions, publishedCount);
  assert.equal((await call('/api/questions?status=pending&search=MOBILE-REVIEW')).total, 2);
  const batch = await call('/api/questions/pending/export', 'POST', { ids: [pending.id, pendingTwo.id] });
  assert.equal(batch.format, 'learning-pending-questions'); assert.equal(batch.questions.length, 2); assert.equal(batch.questions[0].study, undefined);
  batch.questions[0].stemMarkdown = '批量修改后的离线题目';
  const changed = await call('/api/questions/pending/import', 'POST', { data: batch, confirmed: true });
  assert.equal(changed.updated, 2); assert.equal(changed.items[0].status, 'pending');
  assert.equal((await call('/api/questions/pending/import', 'POST', { data: batch, confirmed: true }, 409)).error.code, 'QUESTION_VERSION_CONFLICT');
  const versions = Object.fromEntries(changed.items.map((q: any) => [q.id, q.updatedAt]));
  const approved = await call('/api/questions/review', 'POST', { ids: [pending.id, pendingTwo.id], action: 'approve', confirmed: true, expectedUpdatedAt: versions });
  assert.equal(approved.count, 2); assert.ok(approved.items.every((q: any) => q.status === 'published'));
  assert.equal((await call('/api/bootstrap')).stats.totalQuestions, publishedCount + 2);
  await call(`/api/questions/${pending.id}`, 'DELETE'); await call(`/api/questions/${pendingTwo.id}`, 'DELETE');
  const bulkData = { format: 'learning-new-questions', schemaVersion: 1, questions: [
    { ...questionInput, id: 'MOBILE-BULK-ONE', title: '离线批量新增一' },
    { ...questionInput, id: 'MOBILE-BULK-TWO', title: '离线批量新增二' },
  ] };
  const reservedBulk = structuredClone(bulkData); reservedBulk.questions[0].id = 'MOBILE-RESERVED-ROLLBACK'; reservedBulk.questions[1].id = 'review';
  assert.equal((await call('/api/questions/bulk-import', 'POST', { data: reservedBulk, confirmed: true }, 400)).error.code, 'QUESTION_ID_RESERVED');
  assert.equal((await call('/api/questions?search=MOBILE-RESERVED-ROLLBACK&status=all')).total, 0);
  const bulk = await call('/api/questions/bulk-import', 'POST', { data: bulkData, confirmed: true }, 201);
  assert.equal(bulk.added, 2); assert.ok(bulk.items.every((q: any) => q.status === 'pending'));
  assert.equal((await call(`/api/questions?paperId=${questionSet.id}`)).total, 1, 'pending imports do not silently join a published question set');
  assert.equal((await call('/api/questions?search=MOBILE-BULK&status=pending')).total, 2);
  const collision = structuredClone(bulkData); collision.questions[0].id = 'MOBILE-BULK-ROLLBACK';
  await call('/api/questions/bulk-import', 'POST', { data: collision, confirmed: true }, 409);
  assert.equal((await call('/api/questions?search=MOBILE-BULK-ROLLBACK&status=all')).total, 0, 'bulk ID conflicts must roll back every item');
  const bulkBackup = await call('/api/export');
  assert.deepEqual(bulkBackup.questionBanks, [], 'new backups have no second question collection model');
  assert.ok(bulkBackup.papers.some((entry: any) => entry.id === questionSet.id && entry.questionIds.includes(objective.id)));
  assert.equal(bulkBackup.questions.find((q: any) => q.id === 'MOBILE-BULK-ONE').status, 'pending');
  await call('/api/questions/review', 'POST', { ids: bulk.items.map((q: any) => q.id), action: 'approve', confirmed: true, expectedUpdatedAt: Object.fromEntries(bulk.items.map((q: any) => [q.id, q.updatedAt])) });
  await call(`/api/papers/${questionSet.id}`, 'PUT', { title: questionSet.title, mode: 'manual', questionIds: [objective.id, ...bulk.items.map((q: any) => q.id)], scoring: { enabled: false } });
  assert.equal((await call(`/api/questions?paperId=${questionSet.id}`)).total, 3, 'approved questions join only after explicit set membership update');
  const setPreview = await call('/api/papers/preview', 'POST', { title: '手机题集内随机选题', mode: 'random', count: 3, filters: { paperId: questionSet.id }, scoring: { enabled: false } });
  assert.deepEqual(new Set(setPreview.questionIds), new Set([objective.id, 'MOBILE-BULK-ONE', 'MOBILE-BULK-TWO']));
  const bulkPractice = await call('/api/quick-practice', 'POST', { questionId: 'MOBILE-BULK-ONE' }, 201);
  await call(`/api/attempts/${bulkPractice.id}/submit`, 'POST', { answers: { 'MOBILE-BULK-ONE': { value: '先保存历史快照' } } });
  assert.equal((await call('/api/questions/MOBILE-BULK-ONE', 'DELETE', undefined, 409)).error.code, 'QUESTION_IN_PAPER');
  await call(`/api/papers/${questionSet.id}`, 'PUT', { title: questionSet.title, mode: 'manual', questionIds: [objective.id], scoring: { enabled: false } });
  await call('/api/questions/MOBILE-BULK-ONE', 'DELETE'); await call('/api/questions/MOBILE-BULK-TWO', 'DELETE');
  assert.deepEqual((await call(`/api/papers/${questionSet.id}`)).questionIds, [objective.id]);
  assert.equal((await call(`/api/attempts/${bulkPractice.id}`)).questions[0].title, '离线批量新增一', 'removing original questions preserves submitted attempt content');
  await call(`/api/tags/${tag.id}`, 'DELETE'); await call(`/api/categories/${category.id}`, 'DELETE'); await call(`/api/domains/${domain.id}`, 'DELETE');
  assert.equal((await call('/api/bootstrap')).stats.totalQuestions, publishedCount);
  const paper = await call('/api/papers', 'POST', { title: '手机离线计分验证', mode: 'manual', questionIds: [objective.id, subjective.id], scoring: { enabled: true, totalPoints: 7.5, questionPoints: { [objective.id]: 2.5, [subjective.id]: 5 } } }, 201);
  assert.equal(paper.scoring.totalPoints, 7.5);
  assert.ok(paper.questions.every((q: any) => q.correctAnswers === undefined));
  const attempt = await call(`/api/papers/${paper.id}/attempts`, 'POST', undefined, 201);
  await call(`/api/attempts/${attempt.id}`, 'PUT', { answers: { [objective.id]: { value: objective.correctAnswers[0] }, [subjective.id]: { value: '离线主观题作答' } } });
  const submitted = await call(`/api/attempts/${attempt.id}/submit`, 'POST', {});
  assert.equal(submitted.objectiveScore, 2.5); assert.equal(submitted.totalScore, null); assert.equal(submitted.pendingSubjectiveCount, 1);
  await call(`/api/attempts/${attempt.id}/ai-review`, 'POST', {}, 501);
  const reviewed = await call(`/api/attempts/${attempt.id}/review`, 'PUT', { scores: { [subjective.id]: 4 } });
  assert.equal(reviewed.totalScore, 6.5);
  const random = await call('/api/papers', 'POST', { title: '离线随机100分', mode: 'random', scoring: { enabled: true, totalPoints: 100, pointsByType: { single_choice: 20, true_false: 20, multiple_choice: 20, short_answer: 20 } } }, 201);
  assert.equal(random.scoring.totalPoints, 100); assert.equal(random.scoring.objectivePercent, 60);
  await call(`/api/study/${objective.id}`, 'PUT', { favorite: true, notes: '进程重启后仍保留' });
  const before = durable!.slice(); failSave = true;
  const failed = await call('/api/domains', 'POST', { id: 'should-rollback', name: '磁盘满时的写入' }, 507);
  assert.equal(failed.error.code, 'LOCAL_STORAGE_FAILED'); assert.deepEqual(durable, before);
  assert.ok(!(await call('/api/taxonomy')).domains.some((d: any) => d.id === 'should-rollback'));
  failSave = false;
  const exported = await call('/api/export');
  const invalid = structuredClone(exported); invalid.domains.push({ id: 'import-rollback', name: '导入应撤销', description: '', sortOrder: 0 });
  invalid.questions.push({ ...subjective, id: 'BROKEN-IMPORT', tagIds: ['missing-tag'] });
  await call('/api/import', 'POST', { data: invalid, mode: 'merge' }, 400);
  assert.ok(!(await call('/api/taxonomy')).domains.some((d: any) => d.id === 'import-rollback'));
  assert.deepEqual(durable, before);
  const merge = await call('/api/import', 'POST', { data: exported, mode: 'merge' }); assert.ok(merge);
  const backup = await runtime.fetch('/api/backup.sqlite'); assert.equal(backup.status, 200);
  const backupBytes = new Uint8Array(await backup.arrayBuffer());
  const backupPath = resolve(folder, 'android-backup.sqlite'); await writeFile(backupPath, backupBytes);
  // A native Node SQLite reader must accept the WASM database unchanged.
  const desktop = new DatabaseSync(backupPath);
  assert.equal(desktop.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  assert.equal(desktop.prepare('SELECT count(*) AS count FROM questions').get()!.count, fullSeed.questions.length);
  assert.equal(desktop.prepare('SELECT count(*) AS count FROM question_banks').get()!.count, 0, 'desktop backups do not retain obsolete bank collections');
  const desktopTag = { id: 'desktop-roundtrip', name: '桌面SQLite写入', description: '', color: '#334455' };
  desktop.prepare('INSERT INTO tags(id,data) VALUES (?,?)').run(desktopTag.id, JSON.stringify(desktopTag)); desktop.close();
  await runtime.close(); durable = new Uint8Array(await readFile(backupPath));
  runtime = await createLocalRuntime(sql, fullSeed, storage);
  assert.equal((await call(`/api/questions/${objective.id}`)).study.notes, '进程重启后仍保留');
  assert.equal((await call(`/api/attempts/${attempt.id}`)).totalScore, 6.5);
  assert.deepEqual((await call(`/api/papers/${questionSet.id}`)).questionIds, [objective.id]);
  await call(`/api/papers/${questionSet.id}?permanent=true`, 'DELETE');
  assert.equal((await call(`/api/questions/${objective.id}`)).id, objective.id, 'deleting a question set leaves the canonical question intact');
  assert.ok((await call('/api/taxonomy')).tags.some((tag: any) => tag.id === desktopTag.id));
  assert.equal((await call('/api/bootstrap')).stats.totalQuestions, publishedCount);
  // Simulate an installed v1.0 phone database, which predates question_banks.
  // Opening it with the current runtime must add the table without reseeding or
  // discarding the existing study state and completed-attempt snapshot.
  const upgradePath = resolve(folder, 'installed-v1-database.sqlite');
  await writeFile(upgradePath, new Uint8Array(await (await runtime.fetch('/api/backup.sqlite')).arrayBuffer()));
  const oldDatabase = new DatabaseSync(upgradePath); oldDatabase.exec('DROP TABLE question_banks'); oldDatabase.close();
  await runtime.close(); durable = new Uint8Array(await readFile(upgradePath));
  runtime = await createLocalRuntime(sql, fullSeed, storage);
  await call('/api/question-banks', 'GET', undefined, 404);
  assert.equal((await call(`/api/questions/${objective.id}`)).study.notes, '进程重启后仍保留');
  assert.equal((await call(`/api/attempts/${attempt.id}`)).totalScore, 6.5);
  assert.equal((await call('/api/bootstrap')).stats.totalQuestions, publishedCount);
  // An installed legacy collection is converted before the first read and
  // committed to the same durable file. A failed startup commit must preserve
  // the old bytes, so retrying the upgrade neither duplicates nor loses it.
  const legacyPath = resolve(folder, 'legacy-collection-upgrade.sqlite');
  await writeFile(legacyPath, new Uint8Array(await (await runtime.fetch('/api/backup.sqlite')).arrayBuffer()));
  const legacyDb = new DatabaseSync(legacyPath);
  const legacyBank = { id: 'MOBILE-LEGACY-SET', name: '旧版离线集合', description: '升级后成为题集', questionIds: [subjective.id, objective.id], createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' };
  legacyDb.prepare('INSERT INTO question_banks(id,data) VALUES (?,?)').run(legacyBank.id, JSON.stringify(legacyBank)); legacyDb.close();
  await runtime.close(); durable = new Uint8Array(await readFile(legacyPath));
  const oldBytes = durable.slice(); failSave = true;
  await assert.rejects(createLocalRuntime(sql, fullSeed, storage), /simulated disk full/);
  assert.deepEqual(durable, oldBytes, 'failed migration persistence leaves recoverable legacy bytes unchanged');
  failSave = false; const savesBeforeMigration = saveCount;
  runtime = await createLocalRuntime(sql, fullSeed, storage);
  assert.equal(saveCount, savesBeforeMigration + 1, 'startup migration commits without needing an unrelated mutation');
  const legacySet = await call(`/api/papers/${legacyBank.id}`);
  assert.equal(legacySet.title, legacyBank.name); assert.equal(legacySet.id, legacyBank.id);
  assert.deepEqual(legacySet.questionIds, legacyBank.questionIds, 'legacy order is preserved');
  assert.equal(legacySet.scoring.enabled, false); assert.equal(legacySet.createdAt, legacyBank.createdAt);
  const durableDb = new sql.Database(durable);
  assert.equal(durableDb.exec('SELECT count(*) AS count FROM question_banks')[0].values[0][0], 0);
  assert.equal(durableDb.exec(`SELECT count(*) AS count FROM papers WHERE id = '${legacyBank.id}'`)[0].values[0][0], 1);
  durableDb.close();
  await call('/api/question-banks', 'GET', undefined, 404);
  assert.equal((await call(`/api/questions/${objective.id}`)).study.notes, '进程重启后仍保留');
  assert.equal((await call(`/api/attempts/${attempt.id}`)).totalScore, 6.5);
  assert.ok((await call('/api/taxonomy')).tags.some((entry: any) => entry.id === desktopTag.id));
  await runtime.close(); const savesBeforeReopen = saveCount;
  runtime = await createLocalRuntime(sql, fullSeed, storage);
  assert.equal(saveCount, savesBeforeReopen, 'a second startup needs no migration rewrite');
  assert.equal((await call('/api/papers?archived=true')).filter((entry: any) => entry.id === legacyBank.id).length, 1);
  assert.deepEqual((await call(`/api/papers/${legacyBank.id}`)).questionIds, legacyBank.questionIds);
  assert.equal((await call(`/api/questions/${objective.id}`)).study.notes, '进程重启后仍保留');
  assert.equal((await call(`/api/attempts/${attempt.id}`)).totalScore, 6.5);
  assert.equal((await call('/api/bootstrap')).stats.totalQuestions, publishedCount);
  // The new practice contract is exercised on the exact production WASM API.
  const newInput = { title: '手机新题型', stemMarkdown: '请按要求完成作答。', answerMarkdown: '参考答案', explanationMarkdown: '解析应随历史快照保留。', categoryIds: [fullSeed.categories[0].id], tagIds: [], status: 'published' };
  const blankSpec = [{ id: 'tcp', label: '可靠协议', answers: ['TCP'], caseSensitive: false, trim: true }, { id: 'port', label: 'HTTPS 端口', answers: ['443'], caseSensitive: false, trim: true }];
  const fill = await call('/api/questions', 'POST', { ...newInput, id: 'MOBILE-V3-FILL', type: 'fill_blank', blanks: blankSpec }, 201);
  const essay = await call('/api/questions', 'POST', { ...newInput, id: 'MOBILE-V3-ESSAY', type: 'essay', title: '手机长文作答' }, 201);
  const group = await call('/api/questions', 'POST', { ...newInput, id: 'MOBILE-V3-GROUP', type: 'group', title: '手机程序材料', stemMarkdown: '共享材料：const values = [1, 2, 3]。', parts: [
    { id: 'sum', type: 'fill_blank', title: '数组求和', stemMarkdown: '数组之和为？', answerMarkdown: '6', explanationMarkdown: '1 + 2 + 3 = 6。', blanks: [{ id: 'sum', label: '求和', answers: ['6'], caseSensitive: false, trim: true }], weight: 1 },
    { id: 'mutate', type: 'true_false', title: '可变性', stemMarkdown: 'const 数组不可改变元素。', answerMarkdown: '错', explanationMarkdown: 'const 约束变量绑定。', correctAnswers: ['false'], weight: 1 },
    { id: 'discuss', type: 'essay', title: '边界论述', stemMarkdown: '论述函数测试边界。', answerMarkdown: '覆盖正常输入和边界输入。', explanationMarkdown: '包括空数组、负数和非法输入。', weight: 2 },
  ] }, 201);
  assert.ok([fill, essay, group].every(question => question.status === 'pending'));
  await call('/api/questions/review', 'POST', { ids: [fill.id, essay.id, group.id], action: 'approve', confirmed: true, expectedUpdatedAt: Object.fromEntries([fill, essay, group].map(q => [q.id, q.updatedAt])) });
  const draftPaper = await call('/api/papers', 'POST', { title: '手机三草稿验证', mode: 'manual', questionIds: [essay.id], scoring: { enabled: false } }, 201);
  const draftIds: string[] = [];
  for (let index = 0; index < 4; index++) { const draft = await call(`/api/papers/${draftPaper.id}/attempts`, 'POST', undefined, 201); draftIds.push(draft.id); await call(`/api/attempts/${draft.id}`, 'PUT', { answers: { [essay.id]: { value: `正文 ${index}` } } }); }
  let drafts = await call(`/api/papers/${draftPaper.id}/drafts`); assert.equal(drafts.length, 3); assert.equal(drafts[0].id, draftIds[3]);
  await call(`/api/attempts/${draftIds[0]}`, 'GET', undefined, 404);
  await call(`/api/attempts/${draftIds[1]}`, 'PUT', { answers: { [essay.id]: { value: '继续保存原草稿' } } });
  drafts = await call(`/api/papers/${draftPaper.id}/drafts`); assert.equal(drafts.length, 3); assert.equal(drafts[0].id, draftIds[1]); assert.equal(drafts[0].answers[essay.id].value, '继续保存原草稿');
  const quick = await call('/api/quick-practice', 'POST', { questionId: fill.id }, 201);
  assert.equal(quick.source, 'quick'); assert.equal(quick.questions[0].blanks[0].answers, undefined);
  await call(`/api/attempts/${quick.id}`, 'PUT', { answers: { [fill.id]: { value: ['TCP'] } } }, 400);
  await call(`/api/attempts/${quick.id}`, 'PUT', { answers: { [fill.id]: { value: [' tcp ', '443'] } } });
  const studyBeforeReveal = await call('/api/study');
  const revealed = await call(`/api/attempts/${quick.id}/reveal`, 'POST'); assert.equal(revealed.status, 'in_progress'); assert.ok(revealed.referenceViewedAt); assert.deepEqual(revealed.questions[0].blanks[0].answers, ['TCP']);
  assert.deepEqual((await call('/api/study')).items, studyBeforeReveal.items, 'revealing a quick answer must not grade or alter study state');
  const quickSubmitted = await call(`/api/attempts/${quick.id}/submit`, 'POST', {}); assert.equal(quickSubmitted.status, 'submitted'); assert.ok(quickSubmitted.referenceViewedAt);
  const groupPaper = await call('/api/papers', 'POST', { title: '手机材料分值验证', mode: 'manual', questionIds: [group.id], scoring: { enabled: true, totalPoints: 12, questionPoints: { [group.id]: 12 } } }, 201);
  assert.equal(groupPaper.questionCount, 1); assert.equal(groupPaper.answerCount, 3);
  const groupAttempt = await call(`/api/papers/${groupPaper.id}/attempts`, 'POST', undefined, 201);
  assert.deepEqual(groupAttempt.questions.map((q: any) => q.points), [3, 3, 6]); assert.ok(groupAttempt.questions.every((q: any) => q.sourceQuestionId === group.id && q.groupId === group.id));
  await call(`/api/attempts/${groupAttempt.id}/reveal`, 'POST', {}, 409);
  const groupAnswers = { [`${group.id}::sum`]: { value: ['6'] }, [`${group.id}::mutate`]: { value: 'false' }, [`${group.id}::discuss`]: { value: '正常数据、空数组、负数与非法类型均需覆盖。' } };
  const groupSubmitted = await call(`/api/attempts/${groupAttempt.id}/submit`, 'POST', { answers: groupAnswers }); assert.equal(groupSubmitted.objectiveScore, 6); assert.equal(groupSubmitted.pendingSubjectiveCount, 1);
  const groupReviewed = await call(`/api/attempts/${groupAttempt.id}/review`, 'PUT', { scores: { [`${group.id}::discuss`]: 4 } }); assert.equal(groupReviewed.totalScore, 10);
  assert.ok((await call('/api/attempts?source=quick&status=submitted')).some((a: any) => a.id === quick.id));
  assert.ok((await call(`/api/attempts?source=paper&paperId=${groupPaper.id}`)).some((a: any) => a.id === groupAttempt.id));
  const migration = await call('/api/export');
  await runtime.close(); durable = undefined;
  runtime = await createLocalRuntime(sql, fullSeed, storage);
  await call('/api/import', 'POST', { data: migration, mode: 'merge' });
  assert.equal((await call(`/api/questions/${fill.id}`)).status, 'published', 'backup migration retains prior user approval');
  assert.equal((await call(`/api/questions/${group.id}`)).parts.length, 3);
  assert.equal((await call(`/api/attempts/${groupAttempt.id}`)).totalScore, 10); assert.deepEqual((await call(`/api/attempts/${groupAttempt.id}`)).answers, groupReviewed.answers);
  assert.equal((await call(`/api/papers/${draftPaper.id}/drafts`)).length, 3); assert.ok((await call(`/api/attempts/${quick.id}`)).referenceViewedAt);
  const pendingSeed = fullSeed.questions.find((q: any) => q.status === 'pending'); if (pendingSeed) assert.equal((await call(`/api/questions/${pendingSeed.id}`)).status, 'pending');
  const englishDomain=await call('/api/domains','POST',{id:'english',name:'英语'},201);
  const englishCategory=await call('/api/categories','POST',{id:'native-word-heads',name:'词头',domainId:englishDomain.id},201);
  const nativeWord=await call('/api/questions','POST',{id:'NATIVE-LEX',title:'CAFÉ',type:'short_answer',stemMarkdown:'Recall this word.',answerMarkdown:'A place serving drinks.',categoryIds:[englishCategory.id],tagIds:[]},201);
  const lexical=await call('/api/vocabulary?word='+encodeURIComponent('cafe\u0301'));
  assert.equal(lexical.matches[0].id,nativeWord.id,'WASM SQLite lexical metadata query uses the same Unicode head normalization');assert.equal(lexical.matches[0].status,'pending');
  // Exercise the production JSON judging expression in sql.js: grouped IDs,
  // array-valued blanks, absent answers and scored subjective answers all take
  // different paths. The same original question must retain separate outcomes
  // in its paper and quick-practice contexts.
  const wrongQuick = await call('/api/quick-practice', 'POST', { questionId: group.id }, 201);
  await call(`/api/attempts/${wrongQuick.id}/submit`, 'POST', { answers: { [`${group.id}::sum`]: { value: ['5'] }, [`${group.id}::discuss`]: { value: '未计分主观作答不应被记错' } } });
  await call(`/api/study/${group.id}`, 'PUT', { favorite: true, nextReviewAt: '2020-01-01T00:00:00.000Z' });
  for(const partId of ['sum','mutate','discuss'])await call(`/api/study/${group.id}`, 'PUT', { partId, nextReviewAt: '2020-01-01T00:00:00.000Z' });
  await call(`/api/papers/${groupPaper.id}?permanent=true`, 'DELETE');
  await call(`/api/papers/${draftPaper.id}?permanent=true`, 'DELETE');
  const groupScope = `source=paper&paperId=${groupPaper.id}`;
  const draftScope = `source=paper&paperId=${draftPaper.id}`;
  const savesBeforeLearning = saveCount, bytesBeforeLearning = durable!.slice(); failSave = true;
  try {
    const paperLearning = await call(`/api/learning/summary?${groupScope}`);
    assert.equal(paperLearning.deleted, true); assert.equal(paperLearning.title, groupPaper.title);
    assert.deepEqual(paperLearning.counts, { drafts: 0, submitted: 1, wrong: 1, due: 3, favorite: 3 });
    const wrongPaper = await call(`/api/learning/questions?${groupScope}&kind=wrong&page=1&pageSize=10`);
    assert.equal(wrongPaper.total, 1); assert.equal(wrongPaper.items[0].question.id, `${group.id}::discuss`);
    assert.equal(wrongPaper.items[0].attemptId, groupAttempt.id); assert.equal(wrongPaper.items[0].wrongCount, 1);
    assert.equal(wrongPaper.items[0].answerState, 'incorrect', 'the WASM expression reads the grouped leaf score and its own maximum');
    const quickLearning = await call('/api/learning/summary?source=quick');
    assert.equal(quickLearning.counts.wrong, 2, 'ungraded quick essay and paper-only subjective error do not enter quick wrong questions');
    const quickWrongPage = await call('/api/learning/questions?source=quick&kind=wrong&page=1&pageSize=10');
    assert.equal(quickWrongPage.total, 2);
    const quickWrong = quickWrongPage.items;
    assert.deepEqual(new Set(quickWrong.map((item: any) => item.question.id)), new Set([`${group.id}::sum`, `${group.id}::mutate`]));
    assert.equal(quickWrong.find((item: any) => item.question.partId === 'sum').answerState, 'incorrect');
    assert.equal(quickWrong.find((item: any) => item.question.partId === 'mutate').answerState, 'unanswered');
    assert.ok(quickWrong.every((item: any) => item.attemptId === wrongQuick.id && item.wrongCount === 1));
    for (const kind of ['due', 'favorite']) {
      const associated = await call(`/api/learning/questions?${groupScope}&kind=${kind}&page=1&pageSize=10`);
      assert.equal(associated.total, 3); assert.equal(associated.items.length, 3);
      assert.ok(associated.items.every((item: any) => item.question.sourceQuestionId === group.id));
    }
    const history = await call(`/api/learning/attempts?${groupScope}&status=submitted&page=1&pageSize=10`);
    assert.equal(history.total, 1); assert.equal(history.items[0].id, groupAttempt.id); assert.equal(history.items[0].totalScore, 10);
    assert.equal(history.items[0].questionCount, 3); assert.equal(history.items[0].answeredCount, 3);
    assert.ok(!('questions' in history.items[0]) && !('answers' in history.items[0]), 'history lists carry no question material or answer bodies');
    const draftHistory = await call(`/api/learning/attempts?${draftScope}&status=in_progress&page=1&pageSize=10`);
    assert.equal(draftHistory.total, 3); assert.equal(draftHistory.items.length, 3);
    assert.ok(draftHistory.items.every((item: any) => !('questions' in item) && !('answers' in item)));
    const emptyDraftPage = await call(`/api/learning/attempts?${draftScope}&status=in_progress&page=2&pageSize=10`);
    assert.equal(emptyDraftPage.total, 3); assert.deepEqual(emptyDraftPage.items, []);
    assert.equal((await call(`/api/learning/summary?${draftScope}`)).counts.drafts, 3);
    assert.equal((await call(`/api/attempts/${draftIds[1]}`)).answers[essay.id].value, '继续保存原草稿', 'deleting the source set preserves an accessible draft');
    const deletedContexts = await call('/api/learning/contexts?page=1&pageSize=10');
    assert.equal(deletedContexts.total, 2); assert.ok(deletedContexts.items.every((item: any) => item.deleted));
    assert.deepEqual(new Set(deletedContexts.items.map((item: any) => item.paperId)), new Set([groupPaper.id, draftPaper.id]));
    const emptyContextPage = await call('/api/learning/contexts?page=2&pageSize=10');
    assert.equal(emptyContextPage.total, 2); assert.deepEqual(emptyContextPage.items, []);
    assert.equal(saveCount, savesBeforeLearning, 'all context-learning GETs remain readable with unavailable storage');
    assert.deepEqual(durable, bytesBeforeLearning, 'learning reads do not rewrite durable SQLite bytes');
  } finally { failSave = false; }
  // Global views merge provenance rather than treating a correct answer from
  // one source as a correction of another source's retained mistake.
  const crossPaper = await call('/api/papers', 'POST', { title: '手机全局来源验证', mode: 'manual', questionIds: [group.id], scoring: { enabled: false } }, 201);
  const crossWrong = await call(`/api/papers/${crossPaper.id}/attempts`, 'POST', undefined, 201);
  await call(`/api/attempts/${crossWrong.id}/submit`, 'POST', { answers: { [`${group.id}::sum`]: { value: ['5'] }, [`${group.id}::mutate`]: { value: 'true' } } });
  const mergedWrong = await call('/api/learning/global/questions?kind=wrong&page=1&pageSize=100');
  const sharedMistake = mergedWrong.items.filter((item: any) => item.question.id === `${group.id}::mutate`);
  assert.equal(sharedMistake.length, 1, 'a leaf wrong in two contexts occupies one global row');
  assert.equal(sharedMistake[0].key, JSON.stringify([group.id, `${group.id}::mutate`]));
  assert.equal(sharedMistake[0].snapshotSource, 'attempt');
  assert.deepEqual(new Set(sharedMistake[0].origins.map((origin: any) => origin.attemptId)), new Set([wrongQuick.id, crossWrong.id]));
  assert.equal(sharedMistake[0].origins.find((origin: any) => origin.source === 'quick').answerState, 'unanswered');
  assert.equal(sharedMistake[0].origins.find((origin: any) => origin.paperId === crossPaper.id).answerState, 'incorrect');
  const crossCorrect = await call(`/api/papers/${crossPaper.id}/attempts`, 'POST', undefined, 201);
  await call(`/api/attempts/${crossCorrect.id}/submit`, 'POST', { answers: groupAnswers });
  await call('/api/questions/review', 'POST', { ids: [nativeWord.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [nativeWord.id]: nativeWord.updatedAt } });
  await call(`/api/study/${nativeWord.id}`, 'PUT', { favorite: true, nextReviewAt: '2020-01-01T00:00:00.000Z', notes: '全局只读查询后保留此写入' });
  const savesBeforeGlobal = saveCount, bytesBeforeGlobal = durable!.slice(); failSave = true;
  try {
    const globalSummary = await call('/api/learning/global/summary');
    const globalWrong = await call('/api/learning/global/questions?kind=wrong&page=1&pageSize=100');
    assert.equal(globalWrong.total, globalSummary.counts.wrong);
    const retained = globalWrong.items.find((item: any) => item.question.id === `${group.id}::mutate`);
    assert.equal(retained.attemptId, wrongQuick.id);
    assert.equal(retained.origins.length, 1); assert.equal(retained.origins[0].source, 'quick');
    assert.equal(retained.origins[0].attemptId, wrongQuick.id, 'correcting the paper leaves the other source mistake and its tracing intact');
    const deletedOrigin = globalWrong.items.find((item: any) => item.question.id === `${group.id}::discuss`).origins[0];
    assert.equal(deletedOrigin.paperId, groupPaper.id); assert.equal(deletedOrigin.deleted, true); assert.equal(deletedOrigin.attemptId, groupAttempt.id);
    for (const kind of ['favorite', 'due']) {
      const globalQuestions = await call(`/api/learning/global/questions?kind=${kind}&page=1&pageSize=100`);
      assert.equal(globalQuestions.total, globalSummary.counts[kind]);
      const direct = globalQuestions.items.find((item: any) => item.question.id === nativeWord.id);
      assert.equal(direct.snapshotSource, 'library'); assert.equal(direct.attemptId, undefined);
      assert.equal(direct.origins.length, 1); assert.equal(direct.origins[0].source, 'library'); assert.equal(direct.origins[0].questionId, nativeWord.id);
      const grouped = globalQuestions.items.filter((item: any) => item.question.id === `${group.id}::mutate`);
      assert.equal(grouped.length, 1);
      assert.ok(grouped[0].origins.some((origin: any) => origin.paperId === crossPaper.id && !origin.attemptId), 'current paper membership remains an origin alongside its latest attempt');
      assert.ok(grouped[0].origins.some((origin: any) => origin.attemptId === crossCorrect.id));
      assert.ok(grouped[0].origins.some((origin: any) => origin.attemptId === wrongQuick.id));
    }
    const cards = await call('/api/learning/card-summaries', 'POST', { paperIds: [crossPaper.id, groupPaper.id, draftPaper.id] });
    assert.deepEqual(cards.items.map((item: any) => item.paperId), [crossPaper.id, groupPaper.id, draftPaper.id]);
    assert.deepEqual(cards.items[0].counts, { drafts: 0, submitted: 2, wrong: 0, due: 3, favorite: 3 });
    assert.deepEqual(cards.items[1].counts, { drafts: 0, submitted: 1, wrong: 1, due: 3, favorite: 3 });
    assert.deepEqual(cards.items[2].counts, { drafts: 3, submitted: 0, wrong: 0, due: 0, favorite: 0 });
    assert.equal((await call(`/api/questions/${nativeWord.id}`)).study.notes, '全局只读查询后保留此写入');
    assert.equal(saveCount, savesBeforeGlobal, 'global GETs and the read-only batch POST work while saving is unavailable');
    assert.deepEqual(durable, bytesBeforeGlobal, 'global reads preserve the preceding committed writes');
  } finally { failSave = false; }
  await call(`/api/papers/${crossPaper.id}?permanent=true`, 'DELETE');
  await call(`/api/questions/${group.id}`, 'DELETE');
  const savesBeforeSnapshotRead = saveCount; failSave = true;
  try {
    const frozen = await call('/api/learning/questions?source=quick&kind=wrong&page=1&pageSize=10');
    const frozenSum = frozen.items.find((item: any) => item.question.id === `${group.id}::sum`);
    assert.equal(frozenSum.question.groupStemMarkdown, '共享材料：const values = [1, 2, 3]。');
    assert.deepEqual(frozenSum.question.blanks[0].answers, ['6']);
    assert.equal(frozenSum.question.explanationMarkdown, '1 + 2 + 3 = 6。', 'wrong-question content survives deletion of both source set and original question');
    assert.equal((await call(`/api/learning/questions?${groupScope}&kind=wrong`)).items[0].question.id, `${group.id}::discuss`);
    const globalFrozen = await call('/api/learning/global/questions?kind=wrong&page=1&pageSize=100');
    const globalFrozenSum = globalFrozen.items.find((item: any) => item.question.id === `${group.id}::sum`);
    assert.deepEqual(globalFrozenSum.question.blanks[0].answers, ['6']); assert.equal(globalFrozenSum.origins[0].attemptId, wrongQuick.id);
    assert.equal(saveCount, savesBeforeSnapshotRead);
  } finally { failSave = false; }
});
