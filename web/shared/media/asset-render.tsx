import { useEffect, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import type { AssetMetadata } from '../../../shared/assets/assets';
import { assetIdFromUrl, assetUrl } from '../../../shared/assets/assets';
import { decodeAsset, fetchAsset, uploadFile } from './asset-files';
import { isNativeApp, saveGeneratedFile } from '@platform';
import { DEFAULT_SETTINGS } from '../../../shared/models/settings';
import './media.css';

export function useAssetObjectUrl(id?: string | null) {
  const [url, setUrl] = useState(''); const [error, setError] = useState(''); const [asset, setAsset] = useState<AssetMetadata | null>(null);
  useEffect(() => {
    let active = true, objectUrl = ''; setUrl(''); setError(''); setAsset(null);
    if (id) void fetchAsset(id).then(data => { const { dataBase64: _, ...metadata } = data; const bytes = decodeAsset(data); objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: data.mimeType })); if (active) { setUrl(objectUrl); setAsset(metadata); } else URL.revokeObjectURL(objectUrl); }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id]);
  return { url, error, asset, loading: !!id && !url && !error };
}
export const safeEmbeddedImage = (url: string) => /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url);
export function AssetImage({ src = '', alt = '' }: { src?: string; alt?: string }) {
  const id = assetIdFromUrl(src); const file = useAssetObjectUrl(id); const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const url = id ? file.url : safeEmbeddedImage(src) ? src : '';
  if (!id && !url) return <span className="media-placeholder">[图片：{alt || '未显示'}]{/^https?:\/\//i.test(src) && <> · <a href={src} target="_blank" rel="noopener noreferrer">打开外部图片</a></>}</span>;
  if (file.error || failed) return <span role="alert" className="media-placeholder">图片加载失败：{alt || file.error || '文件无法解码'}</span>;
  if (!url) return <span className="media-placeholder" role="status">正在读取图片…</span>;
  return <span className="managed-image"><a href={url} target="_blank" rel="noopener noreferrer" aria-label={`查看原图：${alt || '题目图片'}`}><img src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} /></a>{alt && <span className="image-caption">{alt}</span>}</span>;
}
export function ImageUploadButton({ onInsert, maxMiB = DEFAULT_SETTINGS.maxImageMiB, label = '上传并插入图片', disabled = false }: { onInsert: (markdown: string) => void; maxMiB?: number; label?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const upload = async (file?: File) => {
    if (!file) return; setError('');
    if (file.size > maxMiB * 1024 * 1024) { setError(`图片超过${maxMiB} MiB，请压缩后上传或调整系统配置。`); return; }
    setBusy(true);
    try { const asset = await uploadFile(file); const alt = asset.filename.replace(/[\[\]\\\r\n]/g, '_'); onInsert(`\n\n![${alt}](${assetUrl(asset.id)})\n`); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return <span className="image-upload-control"><label className={`button image-file-picker ${busy || disabled ? 'disabled' : ''}`}><Upload size={14} />{busy ? '正在保存图片…' : label}<input type="file" accept="image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp" aria-label={label} disabled={busy || disabled} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; void upload(file); }} /></label>{error && <span className="media-error" role="alert">{error}</span>}</span>;
}
export function PdfAttachment({ assetId, title, showDownload = true }: { assetId: string; title: string; showDownload?: boolean }) {
  const file = useAssetObjectUrl(assetId); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const download = async () => { setBusy(true); setError(''); try { const data = await fetchAsset(assetId); await saveGeneratedFile(data.filename, decodeAsset(data), 'application/pdf'); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  return <section className="pdf-attachment"><div className="attachment-toolbar"><strong>{file.asset?.filename || title}</strong>{file.asset && <span className="muted">{(file.asset.sizeBytes / 1024 / 1024).toFixed(2)} MiB</span>}{showDownload && <button className="button" type="button" disabled={busy || file.loading} onClick={() => void download()}><Download size={15} />{isNativeApp() ? '保存 / 用PDF阅读器打开' : '下载 PDF'}</button>}</div>{(error || file.error) && <p role="alert" className="media-error">{error || file.error}</p>}{file.loading ? <p role="status">正在读取PDF…</p> : isNativeApp() ? <p className="muted">文件保存在本机。点击页面上方保存按钮，可选择手机上的PDF阅读器打开。</p> : file.url && <iframe title={`PDF预览：${title}`} src={file.url} className="pdf-frame" />}</section>;
}
