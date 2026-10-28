import {migrateFeedbackQualityIssues} from './modules/content-quality/feedback-links.js';
import {retireMissingSourceIssues,retireMissingExplanationIssues} from './modules/content-quality/maintenance.js';
import {registerContentQualityRoutes} from './modules/content-quality/routes.js';
import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store, now } from './core/store.js';
import { importData } from './modules/transfer/migration.js';
import { registerExportRoutes } from './modules/transfer/exports.js';
import { migrateLegacyBanks } from './modules/banks/legacy-banks.js';
import { registerQuestionBankRoutes } from './modules/banks/routes.js';
import { ensureSettings, getSettings, registerSettingsRoutes } from './modules/settings/routes.js';
import { registerAssetRoutes, validateAllAssetReferences } from './modules/assets/routes.js';
import { registerLibraryRoutes } from './modules/library/routes.js';
import { registerDocumentDraftRoutes } from './modules/library/document-drafts.js';
import { registerSharingRoutes } from './modules/sharing/routes.js';
import { ensureAiStorage, registerAiRoutes, getPublicAiSettings } from './modules/ai/routes.js';
import { registerAiDocumentRoutes } from './modules/ai/document-routes.js';
import { registerAiWorkspaceDraftRoutes } from './modules/ai/workspace-drafts.js';
import { registerQuestionFeedbackRoutes } from './modules/quality-feedback/routes.js';
import { registerPaperDraftRoutes } from './modules/practice/paper-drafts.js';
import { registerApiDocs } from './http/openapi.js';
import { registerVocabularyRoutes } from './modules/questions/vocabulary.js';
import { dashboardStats } from './core/read-models.js';
import { registerHttpSecurity } from './http/security.js';
import { registerQuestionRoutes } from './modules/questions/routes.js';
import { registerSimilarQuestionRoutes } from './modules/questions/similar-routes.js';
import { registerTaxonomyRoutes } from './modules/taxonomy/routes.js';
import { registerStudyRoutes } from './modules/study/routes.js';
import { registerPracticeRoutes } from './modules/practice/routes.js';
import { registerContextLearningRoutes } from './modules/practice/learning.js';
import { registerGlobalLearningRoutes } from './modules/practice/global-learning.js';
import { registerTransferRoutes } from './modules/transfer/routes.js';
import { migrateLearningResults } from './modules/practice/learning-results.js';
import { registerLearningResetRoutes } from './modules/study/reset.js';
import { migrateQuestionHistory } from './modules/questions/history-store.js';
import { registerQuestionHistoryRoutes } from './modules/questions/history.js';
import { registerDailyPushRoutes } from './modules/daily-push/routes.js';
import { registerAnalyticsRoutes } from './modules/analytics/routes.js';
import { registerSearchRoutes } from './modules/search/routes.js';
import { registerReviewSchedulerRoutes } from './modules/review-scheduler/routes.js';
import { checkDailyPush } from './modules/daily-push/service.js';
import { createDailyPushScheduler, dailyPushRefreshesAfter, type DailyPushSchedulerClock } from './scheduling/daily-push.js';

export interface AppOptions { databasePath?: string; seedPath?: string; staticRoot?: string; logger?: boolean; native?: boolean; onDataMigrated?: () => void; dailyPushNow?: () => Date; dailyPushScheduler?: boolean; dailyPushSchedulerClock?: DailyPushSchedulerClock }
export async function buildApp(options: AppOptions = {}) {
  const dbPath = options.databasePath || process.env.DATABASE_PATH || resolve('data/noetic-atlas.sqlite');
  // Normal installations start empty. A seed is an explicit test/operator input,
  // never an implicit lookup into a working directory containing personal data.
  const seedPath = options.seedPath || process.env.SEED_PATH;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 80 * 1024 * 1024, routerOptions: { maxParamLength: 4096 } });
  await registerApiDocs(app, { native: options.native });
  const store = new Store(dbPath);
  const scheduler = !options.native && options.dailyPushScheduler !== false ? createDailyPushScheduler({
    readConfig: () => getSettings(store).dailyPush,
    check: at => checkDailyPush(store, at),
    ...(options.dailyPushSchedulerClock ? { clock: options.dailyPushSchedulerClock } : options.dailyPushNow ? { clock: { now: options.dailyPushNow, setTimeout: (run, delay) => setTimeout(run, delay), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) } } : {}),
    onError: error => app.log.error(error),
  }) : undefined;
  app.addHook('onClose', async () => { scheduler?.stop(); store.db.close(); });
  try {
    const initialized = store.database.one(store.database.query.selectFrom('metadata').select('value').where('key','=','seed_initialized'));
    if (!initialized && tablesEmpty(store) && seedPath && existsSync(seedPath)) {
      importData(store, JSON.parse(readFileSync(seedPath, 'utf8')));
      store.database.run(store.database.query.insertInto('metadata').values({key:'seed_initialized',value:now()}).onConflict(c=>c.column('key').doUpdateSet({value:now()})));
    }
    const migrated = store.transaction(() => { store.normalizeLegacyTags(); store.validateTaxonomyReferences(); ensureSettings(store); ensureAiStorage(store); const migrated = migrateLegacyBanks(store); const learning = migrateLearningResults(store),history=migrateQuestionHistory(store); const retired=retireMissingSourceIssues(store)+retireMissingExplanationIssues(store),quality=migrateFeedbackQualityIssues(store);validateAllAssetReferences(store); return store.database.schemaChanged || migrated || learning > 0 || history>0 || retired>0 || quality>0; });
    if (migrated) options.onDataMigrated?.();
    store.database.projections.refreshAll();
  } catch (error) { store.db.close(); throw error; }

  registerHttpSecurity(app, store);

  registerVocabularyRoutes(app,store);
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/taxonomy', async () => store.taxonomy());
  app.get('/api/bootstrap', async () => {
    const ai = getPublicAiSettings(store);
    return { ...store.taxonomy(), settings: getSettings(store), stats: dashboardStats(store), ai: { available: ai.enabled, message: ai.enabled ? 'AI辅助已开启，操作时将所选资料发送给你配置的模型服务。' : 'AI辅助未开启，可在系统配置中设置模型服务。' } };
  });

  registerQuestionBankRoutes(app, store);
  registerSettingsRoutes(app, store);
  registerAssetRoutes(app, store);
  registerLibraryRoutes(app, store);
  registerDocumentDraftRoutes(app, store);
  registerSharingRoutes(app, store);
  registerAiRoutes(app, store, { native: options.native });
  registerAiDocumentRoutes(app, store, { native: options.native });
  registerAiWorkspaceDraftRoutes(app, store);
  registerQuestionFeedbackRoutes(app, store, { native: options.native });
  registerPaperDraftRoutes(app, store);
  registerQuestionRoutes(app, store);
  registerContentQualityRoutes(app, store);
  registerSimilarQuestionRoutes(app, store, { native: options.native });
  registerQuestionHistoryRoutes(app,store);

  registerTaxonomyRoutes(app, store);

  registerStudyRoutes(app, store);
  registerLearningResetRoutes(app, store);

  registerExportRoutes(app, store);

  registerPracticeRoutes(app, store);
  registerContextLearningRoutes(app, store);
  registerGlobalLearningRoutes(app, store);

  registerTransferRoutes(app, store);
  registerDailyPushRoutes(app, store, { now: options.dailyPushNow || options.dailyPushSchedulerClock?.now.bind(options.dailyPushSchedulerClock) });
  registerAnalyticsRoutes(app, store);
  registerSearchRoutes(app, store);
  registerReviewSchedulerRoutes(app, store);
  if (scheduler) {
    app.addHook('onReady', async () => { scheduler.refresh(); });
    app.addHook('onResponse', async request => { if (dailyPushRefreshesAfter(request.method, request.url.split('?')[0]!)) scheduler.refresh(); });
  }

  const staticRoot = resolve(options.staticRoot || 'dist/web');
  if (existsSync(join(staticRoot, 'index.html'))) {
    await app.register(staticPlugin, { root: staticRoot, index: ['index.html'], dotfiles: 'deny' });
    app.setNotFoundHandler((request, reply) => {
      if (!request.url.startsWith('/api/') && request.method === 'GET' && !request.url.split('?')[0]!.split('/').pop()!.includes('.')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '页面或接口不存在' } });
    });
  } else app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: '页面或接口不存在' } }));
  return app;
}
function tablesEmpty(store: Store) { return ['domains', 'categories', 'tags', 'questions', 'documents', 'papers', 'study', 'attempts'].every(t => store.all(t as any).length === 0); }
