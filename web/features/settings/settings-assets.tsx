import { useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import type { AssetMetadata } from '../../../shared/assets/assets';
import { idPath, send, useResource } from '../../shared/lib/api';
import { usePagination } from '../../shared/lib/pagination';
import { ErrorNotice, Loading, Pagination, SearchBox, useApp } from '../../shared/ui/components';
import { decodeAsset, fetchAsset } from '../../shared/media/asset-files';
import { saveGeneratedFile } from '@platform';
import '../../shared/media/media.css';

export function AssetsManager() {
  const resource = useResource<Array<AssetMetadata & { referenced: boolean }>>('/api/assets');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { toast } = useApp();
  const [search, setSearch] = useState('');
  const paging = usePagination(
    (resource.data || []).filter((asset) =>
      `${asset.filename} ${asset.mimeType}`.toLowerCase().includes(search.toLowerCase()),
    ),
    search,
  );
  const download = async (asset: AssetMetadata) => {
    setBusy(true);
    setError('');
    try {
      const data = await fetchAsset(asset.id);
      await saveGeneratedFile(data.filename, decodeAsset(data), data.mimeType);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (asset: AssetMetadata) => {
    if (!confirm(`永久删除未引用文件「${asset.filename}」？`)) return;
    setBusy(true);
    setError('');
    try {
      await send(`/api/assets/${idPath(asset.id)}`, 'DELETE');
      toast('未引用文件已删除');
      resource.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card settings-section settings-assets ui-stack">
      <h2>本地文件资源</h2>
      <p className="muted">
        上传图片与PDF保存在SQLite中。题目、资料及历史快照仍引用的文件受到删除保护；未引用上传可在此清理。
      </p>
      <SearchBox value={search} onChange={setSearch} placeholder="搜索文件名称或格式" />
      {error && <ErrorNotice message={error} />}
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <ErrorNotice message={resource.error} retry={resource.refresh} />
      ) : paging.total ? (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>文件</th>
                  <th>大小 / 状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {paging.items.map((asset) => (
                  <tr key={asset.id}>
                    <td>
                      <strong>{asset.filename}</strong>
                      <br />
                      <small>{asset.mimeType}</small>
                    </td>
                    <td>
                      {(asset.sizeBytes / 1024 / 1024).toFixed(2)} MiB
                      <br />
                      {asset.referenced ? '已引用，保留' : '未引用'}
                    </td>
                    <td>
                      <div className="action-row">
                        <button
                          className="button"
                          disabled={busy}
                          onClick={() => void download(asset)}
                        >
                          <Download size={14} />
                          保存文件
                        </button>
                        <button
                          className="button danger-text"
                          disabled={busy || asset.referenced}
                          onClick={() => void remove(asset)}
                        >
                          <Trash2 size={14} />
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination {...paging} label="文件资源" />
        </>
      ) : (
        <p>暂无上传文件。可从资料库上传PDF，或在题目与资料编辑中插入图片。</p>
      )}
    </section>
  );
}
