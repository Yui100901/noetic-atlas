export const assetMimeTypes = ['text/markdown', 'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type AssetMimeType = typeof assetMimeTypes[number];
export interface AssetRecord {
  id: string; filename: string; mimeType: AssetMimeType; dataBase64: string;
  sizeBytes: number; createdAt: string; width?: number; height?: number;
}
export type AssetMetadata = Omit<AssetRecord, 'dataBase64'>;
export const assetUrl = (id: string) => `/api/assets/${encodeURIComponent(id)}/content`;
/** Only managed, same-origin paths are asset references; remote URLs are never fetched. */
export function assetIdFromUrl(url: string): string | null {
  const match = /^\/api\/assets\/([^/?#]+)\/(?:content|data)(?:[?#].*)?$/.exec(url);
  if (!match) return null;
  try { const id = decodeURIComponent(match[1]!); return /^[\p{L}\p{N}_.:-]+$/u.test(id) ? id : null; } catch { return null; }
}
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''; for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value); return Uint8Array.from(binary, char => char.charCodeAt(0));
}
export function embeddedRasterImage(url: string): { mimeType: AssetMimeType; dataBase64: string } | null {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  return match ? { mimeType: match[1] as AssetMimeType, dataBase64: match[2]! } : null;
}
