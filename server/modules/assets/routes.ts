import type { FastifyInstance } from 'fastify';
import type { AssetRecord } from '../../../shared/assets/assets.js';
import type { Store } from '../../core/store.js';
import { parse } from '../../core/validation.js';
import { getId } from '../../http/request.js';
import { assetListQuerySchema, decodeAssetBase64 } from './schema.js';
import { assetMetadata, createAsset, deleteAsset, listAssets } from './service.js';

export function registerAssetRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/assets', async request => listAssets(store, parse(assetListQuerySchema, request.query)));
  app.post('/api/assets', async (request, reply) => reply.code(201).send(createAsset(store, request.body)));
  app.get('/api/assets/:id/data', async request => store.require<AssetRecord>('assets', getId(request)));
  app.get('/api/assets/:id/content', async (request, reply) => {
    const record = store.require<AssetRecord>('assets', getId(request));
    return reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(record.filename)}`).type(record.mimeType).send(decodeAssetBase64(record.dataBase64));
  });
  app.get('/api/assets/:id', async request => assetMetadata(store.require<AssetRecord>('assets', getId(request))));
  app.delete('/api/assets/:id', async request => deleteAsset(store, getId(request)));
}
