import { request, send } from '../lib/api';
import type { AssetMetadata, AssetRecord } from '../../../shared/assets/assets';
export function decodeAsset(data: AssetRecord): Uint8Array {
  const binary = atob(data.dataBase64); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
export const fetchAsset = (id: string) => request<AssetRecord>(`/api/assets/${encodeURIComponent(id)}/data`);
export async function uploadFile(file: File): Promise<AssetMetadata> {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(new Error('文件读取失败，请重新选择。'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.readAsDataURL(file);
  });
  const extension = file.name.split('.').pop()?.toLowerCase();
  const mime = ({ pdf: 'application/pdf', md: 'text/markdown', markdown: 'text/markdown', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as Record<string, string>)[extension || ''];
  return send<AssetMetadata>('/api/assets', 'POST', { filename: file.name, mimeType: mime || file.type, dataBase64 });
}
