import { planShareImport, importShare } from '../../server/modules/sharing/service.js';
import type { Store } from '../../server/core/store.js';
/** Existing workflow tests explicitly choose to keep distinct similar prompts.
 * Deduplication tests exercise unresolved/replacement/reuse separately. */
const previewBody = (path: string, payload: any) => {
  if (payload?.confirmed && !payload.dedup && path === '/api/questions/bulk-import')
    return { data: payload.data };
  if (
    !payload?.confirmed ||
    payload.dedup ||
    !/^\/api\/ai\/(?:runs|document-jobs)\/[^/]+\/import$/.test(path)
  )
    return null;
  if (path.includes('/document-jobs/')) return payload;
  const { confirmed: _confirmed, ...body } = payload;
  return body;
};
const choice = (payload: any, plan: any) => ({
  ...payload,
  dedup: {
    expectedFingerprint: plan.fingerprint,
    decisions: plan.items
      .filter((item: any) => item.kind === 'similar')
      .map((item: any) => ({ key: item.key, action: 'both' })),
  },
});
export async function reviewedAiImport(app: any, path: string, payload: any) {
  const body = previewBody(path, payload);
  if (!body) return payload;
  const response = await app.inject({
    method: 'POST',
    url:
      path === '/api/questions/bulk-import' ? '/api/questions/import-preview' : path + '-preview',
    payload: body,
  });
  return response.statusCode === 200 ? choice(payload, response.json()) : payload;
}
export async function reviewedNativeAiImport(runtime: any, path: string, payload: any) {
  const body = previewBody(path, payload);
  if (!body) return payload;
  const response = await runtime.fetch(
    path === '/api/questions/bulk-import' ? '/api/questions/import-preview' : path + '-preview',
    { method: 'POST', body: JSON.stringify(body) },
  );
  return response.ok ? choice(payload, await response.json()) : payload;
}
export function reviewedShareImport(store: Store, raw: unknown, expectedFingerprint?: string) {
  const plan = planShareImport(store, raw);
  return importShare(store, raw, expectedFingerprint, {
    expectedFingerprint: plan.dedup.fingerprint,
    decisions: plan.dedup.items
      .filter((item) => item.kind === 'similar')
      .map((item) => ({ key: item.key, action: 'both' })),
  });
}
