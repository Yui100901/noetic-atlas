/** Keep generated files portable and prevent caller-supplied names becoming paths. */
export function generatedFileName(filename: string, mimeType: string) {
  const mime = mimeType.split(';', 1)[0].trim().toLowerCase();
  const extensions: Record<string, string> = { 'application/pdf': '.pdf', 'application/json': '.json', 'text/markdown': '.md', 'text/plain': '.txt', 'application/vnd.sqlite3': '.sqlite', 'application/x-sqlite3': '.sqlite' };
  const extension = extensions[mime];
  let safe = filename.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);
  if (!safe) safe = '认知星图-导出';
  if (extension && !safe.toLowerCase().endsWith(extension)) safe += extension;
  return { filename: safe, mimeType: mime || 'application/octet-stream' };
}
export async function generatedFileBytes(value: Uint8Array | Blob): Promise<Uint8Array> {
  return value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
}
