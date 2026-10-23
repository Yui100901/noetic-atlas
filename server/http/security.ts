import type { FastifyInstance } from 'fastify';
import type { Store } from '../core/store.js';
import { ApiError, fail } from '../core/validation.js';
import { getActiveExamId } from '../modules/practice/service.js';

export function registerHttpSecurity(app: FastifyInstance, store: Store) {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'no-referrer');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    // An exam is an application-wide session. Keep API reads side-effect free:
    // expiry is committed only through the allowed explicit sync/submit writes.
    if (request.url.startsWith('/api/')) {
      const activeId = getActiveExamId(store);
      if (activeId) {
        let path: string; try { path = decodeURIComponent(request.url.split('?')[0]!); } catch { return fail(400, 'INVALID_URL', '接口路径编码无效'); }
        const read = request.method === 'GET' || request.method === 'HEAD';
        const current = `/api/attempts/${activeId}`;
        const allowed = read && ['/api/health', '/api/bootstrap', '/api/exams/active'].includes(path)
          || request.method === 'POST' && path === '/api/exams/sync'
          || (read || request.method === 'PUT') && path === current
          || request.method === 'POST' && [current + '/submit', current + '/sync'].includes(path)
          || read && /^\/api\/assets\/[^/]+(?:\/(?:content|data))?$/.test(path);
        if (!allowed) return reply.code(409).send({ error: { code: 'EXAM_ACTIVE', message: '考试进行中，请先交卷，完成后再使用其他功能', details: { attemptId: activeId } } });
      }
    }

    const origin = request.headers.origin;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin) {
      const expected = `${request.protocol}://${request.headers.host}`;
      if (origin !== expected) fail(403, 'CROSS_ORIGIN_REJECTED', '拒绝来自其他站点的写入请求');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['sec-fetch-site'] === 'cross-site') fail(403, 'CROSS_ORIGIN_REJECTED', '拒绝跨站写入请求');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.status(error.status).send({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    const known = error as { statusCode?: number; code?: string; message?: string };
    if (known.statusCode && known.statusCode < 500) return reply.status(known.statusCode).send({ error: { code: known.code || 'BAD_REQUEST', message: known.statusCode === 413 ? '数据超过允许大小' : '请求格式无效' } });
    app.log.error(error);
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: '操作未完成，请检查本地服务日志' } });
  });
}
