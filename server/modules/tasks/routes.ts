import type { FastifyInstance } from 'fastify';
import type { BackgroundTaskManager } from './manager.js';
import { readOnlyOperation } from '../../http/operation.js';
import { parse, id } from '../../core/validation.js';
export function registerTaskRoutes(app: FastifyInstance, manager: BackgroundTaskManager) {
  const key = (params: unknown) => parse(id, (params as { id?: unknown })?.id);
  app.get('/api/tasks', () => manager.list());
  app.post(
    '/api/tasks',
    { ...readOnlyOperation, bodyLimit: 192 * 1024 * 1024 },
    async (request, reply) => reply.code(202).send(await manager.start(request.body)),
  );
  app.get('/api/tasks/:id', (request) => manager.detail(key(request.params)));
  app.get('/api/tasks/:id/input', (request) => {
    const taskId = key(request.params);
    manager.get(taskId);
    return manager.storage.input(taskId);
  });
  app.get('/api/tasks/:id/result', (request) => manager.result(key(request.params)));
  app.get('/api/tasks/:id/download', async (request, reply) => {
    const { result, data } = await manager.download(key(request.params));
    const name = result.filename || 'noetic-atlas-download.bin';
    const filename = encodeURIComponent(name).replace(
      /['()*!]/g,
      (char) => '%' + char.charCodeAt(0).toString(16),
    );
    const fallback = name.replace(/[^a-z.\d_-]/gi, '_');
    return reply
      .type(result.contentType)
      .header('Content-Length', result.binaryByteLength!)
      .header(
        'Content-Disposition',
        `attachment; filename="${fallback}"; filename*=UTF-8''${filename}`,
      )
      .send(data);
  });
  app.post('/api/tasks/:id/cancel', readOnlyOperation, (request) =>
    manager.cancel(key(request.params)),
  );
  app.post('/api/tasks/:id/retry', readOnlyOperation, (request) =>
    manager.retry(key(request.params)),
  );
  app.post('/api/tasks/:id/read', readOnlyOperation, (request) =>
    manager.read(key(request.params)),
  );
  app.delete('/api/tasks/:id', readOnlyOperation, async (request) => {
    await manager.remove(key(request.params));
    return { ok: true };
  });
}
