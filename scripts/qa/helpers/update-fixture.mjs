/** Synthetic retained data, shared by program-replacement acceptance checks. */
import assert from 'node:assert/strict';
import { seedAndroidLayout } from '../../testing/android/layout-fixture.mjs';
import { questionRevisionContent } from '../../../shared/questions/question-revisions.ts';

export async function seedUpdateData(api) {
  const state = await seedAndroidLayout(api);
  const question = await api('/api/questions/ANDROID-LAYOUT-0');
  const image = await api('/api/assets', 'POST', {
    filename: 'update-fixture.png',
    mimeType: 'image/png',
    dataBase64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  });
  const document = await api('/api/documents/' + state.documentId);
  const savedDocument = await api('/api/documents/' + state.documentId, 'PUT', {
    ...document,
    bodyMarkdown: document.bodyMarkdown + `\n\n![示意](/api/assets/${image.id}/content)`,
  });
  const source = await api('/api/documents/' + state.documentId);
  const updatedQuestion = await api('/api/questions/' + question.id, 'PUT', {
    ...question,
    documentLinks: [
      {
        documentId: source.id,
        versionId: source.contentVersion,
        title: source.title,
        relation: 'reference',
        label: '资料原文',
        excerpt: '事务',
      },
    ],
  });
  await api('/api/question-drafts', 'POST', {
    questionId: updatedQuestion.id,
    baseUpdatedAt: updatedQuestion.updatedAt,
    state: {
      form: { ...questionRevisionContent(updatedQuestion), status: updatedQuestion.status },
      sources: '',
      reason: '尚未完成的编辑',
    },
  });
  await api('/api/document-drafts', 'POST', {
    documentId: savedDocument.id,
    baseDocumentUpdatedAt: savedDocument.updatedAt,
    state: {
      title: savedDocument.title,
      kind: '学习笔记',
      bodyMarkdown: '尚未完成的资料正文',
      format: 'markdown',
      assetId: null,
      fileName: null,
      sourcePath: null,
      author: '',
      publisher: '',
      publishedYear: '',
      description: '',
      collection: 'general',
      domainIds: ['android-layout'],
      categoryIds: ['android-layout-category'],
      tagIds: [],
    },
  });
  await api('/api/review-scheduler/review', 'POST', {
    questionId: question.id,
    rating: 'good',
    requestId: 'data-update-review',
  });
  const settings = await api('/api/settings');
  await api('/api/settings', 'PUT', {
    settings: {
      ...settings,
      theme: 'dark',
      dailyPush: {
        ...settings.dailyPush,
        enabled: true,
        goals: [
          {
            id: 'update-goal',
            name: '保数据更新目标',
            enabled: true,
            domainId: 'android-layout',
            categoryIds: ['android-layout-category'],
            tagIds: [],
            tagMode: 'all',
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            priority: 3,
            weight: 1,
            reviewPoints: 2,
            newPoints: 2,
            mode: 'focus',
            direction: 'default',
          },
        ],
      },
    },
  });
  await api('/api/daily-push/check', 'POST', {});
  const configured = await api('/api/settings');
  await api('/api/settings', 'PUT', {
    settings: { ...configured, dailyPush: { ...configured.dailyPush, enabled: false } },
  });
  await api('/api/ai/settings', 'PUT', {
    enabled: false,
    baseUrl: 'https://example.test/v1',
    model: 'retained-fixture',
    key: 'synthetic-update-key',
    supportsImages: false,
    sendImages: false,
    timeoutSeconds: 60,
    maxTokens: 8192,
  });
  const note = '更新后必须保留的笔记。';
  await api('/api/study/' + question.id, 'PUT', { favorite: true, notes: note });
  return { ...state, questionId: question.id, assetId: image.id, note };
}

export async function assertUpdateData(api, state) {
  assert.equal((await api('/api/bootstrap')).stats.totalQuestions, 17);
  assert.equal((await api('/api/questions/' + state.questionId)).study.notes, state.note);
  assert.equal((await api('/api/attempts/' + state.submittedId)).status, 'submitted');
  assert.equal((await api('/api/attempts/' + state.draftId)).status, 'in_progress');
  assert.equal((await api('/api/settings')).theme, 'dark');
  const ai = await api('/api/ai/settings');
  assert.equal(ai.hasKey, true);
  assert.equal(ai.model, 'retained-fixture');
  assert.ok(
    (await api('/api/review-scheduler/card?questionId=' + state.questionId)).eventCount > 0,
  );
  assert.ok((await api('/api/questions/' + state.questionId)).documentLinks.length > 0);
  assert.equal((await api('/api/assets/' + state.assetId)).filename, 'update-fixture.png');
}
