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
import { registerSharingRoutes } from './modules/sharing/routes.js';
import { ensureAiStorage, registerAiRoutes, getPublicAiSettings } from './modules/ai/routes.js';
import { registerPaperDraftRoutes } from './modules/practice/paper-drafts.js';
import { registerApiDocs } from './http/openapi.js';
import { registerVocabularyRoutes } from './modules/questions/vocabulary.js';
import { dashboardStats } from './core/read-models.js';
import { registerHttpSecurity } from './http/security.js';
import { registerQuestionRoutes } from './modules/questions/routes.js';
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

export interface AppOptions { databasePath?: string; seedPath?: string; staticRoot?: string; logger?: boolean; native?: boolean; onDataMigrated?: () => void }
export async function buildApp(options: AppOptions = {}) {
  const dbPath = options.databasePath || process.env.DATABASE_PATH || resolve('data/noetic-atlas.sqlite');
  // Normal installations start empty. A seed is an explicit test/operator input,
  // never an implicit lookup into a working directory containing personal data.
  const seedPath = options.seedPath || process.env.SEED_PATH;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 80 * 1024 * 1024, routerOptions: { maxParamLength: 4096 } });
  await registerApiDocs(app, { native: options.native });
  const store = new Store(dbPath);
  app.addHook('onClose', async () => { store.db.close(); });
  try {
    const initialized = store.database.one(store.database.query.selectFrom('metadata').select('value').where('key','=','seed_initialized'));
    if (!initialized && tablesEmpty(store) && seedPath && existsSync(seedPath)) {
      importData(store, JSON.parse(readFileSync(seedPath, 'utf8')));
      store.database.run(store.database.query.insertInto('metadata').values({key:'seed_initialized',value:now()}).onConflict(c=>c.column('key').doUpdateSet({value:now()})));
    }
    const migrated = store.transaction(() => { store.normalizeLegacyTags(); store.validateTaxonomyReferences(); ensureSettings(store); ensureAiStorage(store); const migrated = migrateLegacyBanks(store); const learning = migrateLearningResults(store),history=migrateQuestionHistory(store); validateAllAssetReferences(store); return migrated || learning > 0 || history>0; });
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
  registerSharingRoutes(app, store);
  registerAiRoutes(app, store, { native: options.native });
  registerPaperDraftRoutes(app, store);
  registerQuestionRoutes(app, store);
  registerQuestionHistoryRoutes(app,store);

  registerTaxonomyRoutes(app, store);

  registerStudyRoutes(app, store);
  registerLearningResetRoutes(app, store);

  registerExportRoutes(app, store);

  registerPracticeRoutes(app, store);
  registerContextLearningRoutes(app, store);
  registerGlobalLearningRoutes(app, store);

  registerTransferRoutes(app, store);

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
