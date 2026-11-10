import type { ExportDocument } from '../../../shared/models/export-types';
import { saveGeneratedFile } from '@platform';
import {
  assetIdFromUrl,
  base64ToBytes,
  embeddedRasterImage,
  type AssetRecord,
} from '../../../shared/assets/assets';
import { request } from '../lib/api';
import type { PdfFormulaResolver, PdfImageData } from './pdf-types';
import type { PdfWorkerRequest, PdfWorkerResponse } from './pdf-render-worker';

async function localImage(url: string): Promise<{ dataBase64: string; mimeType: string } | null> {
  const embedded = embeddedRasterImage(url);
  if (embedded) return embedded;
  const id = assetIdFromUrl(url);
  if (!id) return null;
  const record = await request<AssetRecord>(`/api/assets/${encodeURIComponent(id)}/data`);
  return record.mimeType.startsWith('image/') ? record : null;
}
async function resolvePdfImage(url: string): Promise<PdfImageData | null> {
  const source = await localImage(url);
  if (!source) return null;
  const data = base64ToBytes(source.dataBase64);
  if (source.mimeType === 'image/png' || source.mimeType === 'image/jpeg')
    return { data, mimeType: source.mimeType };
  // GIF and WebP use the first decoded frame, locally. No network or external converter.
  const objectUrl = URL.createObjectURL(new Blob([data as BlobPart], { type: source.mimeType }));
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 40_000_000
    )
      throw new Error('图片尺寸无效');
    const canvas = window.document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('图片转换不可用');
    context.drawImage(image, 0, 0);
    const converted = embeddedRasterImage(canvas.toDataURL('image/png'));
    if (!converted) throw new Error('图片转换失败');
    return { data: base64ToBytes(converted.dataBase64), mimeType: 'image/png' };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
/** Inline local managed image bytes so a downloaded Markdown file remains portable by itself. */
export async function portableExportMarkdown(
  markdown: string,
  signal?: AbortSignal,
): Promise<string> {
  // Also covers reference-style Markdown images: ![alt][diagram] + [diagram]: URL.
  const urls = [
    ...new Set(
      [
        ...markdown.matchAll(
          /\/api\/assets\/[^/\s?#"'()<>\]]+\/(?:content|data)(?:[?#][^\s"'()<>\]]*)?/g,
        ),
      ].map((match) => match[0]),
    ),
  ];
  let result = markdown;
  for (const url of urls) {
    signal?.throwIfAborted();
    const image = await localImage(url);
    if (!image) continue;
    result = result.split(url).join(`data:${image.mimeType};base64,${image.dataBase64}`);
  }
  signal?.throwIfAborted();
  return result;
}

let fontRequest: Promise<Uint8Array> | null = null;
function renderInWorker(
  document: ExportDocument,
  font: Uint8Array,
  formula?: PdfFormulaResolver,
  signal?: AbortSignal,
) {
  return new Promise<Uint8Array>((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(new URL('./pdf-render-worker.ts', import.meta.url), {
      type: 'module',
    });
    const close = () => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      close();
      reject(new DOMException('已取消导出', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = () => {
      close();
      reject(new Error('PDF生成线程未能启动，请重新导出'));
    };
    worker.onmessage = async ({ data }: MessageEvent<PdfWorkerResponse>) => {
      if (data.type === 'result') {
        close();
        resolve(data.bytes);
        return;
      }
      if (data.type === 'failure') {
        close();
        reject(new Error(data.message));
        return;
      }
      try {
        // Image decoding and equation typesetting can use the DOM. PDF layout,
        // embedding and serialization stay on the isolated worker thread.
        const value =
          data.type === 'image'
            ? await resolvePdfImage(data.url)
            : await formula!(data.source, data.display, data.size);
        worker.postMessage({ type: 'resource', id: data.id, value } satisfies PdfWorkerRequest);
      } catch (error) {
        worker.postMessage({
          type: 'resource',
          id: data.id,
          error: error instanceof Error ? error.message : '无法读取素材',
        } satisfies PdfWorkerRequest);
      }
    };
    worker.postMessage({
      type: 'start',
      document,
      font,
      formulas: !!formula,
    } satisfies PdfWorkerRequest);
  });
}
export async function downloadExport(
  document: ExportDocument,
  format: 'md' | 'pdf',
  signal?: AbortSignal,
) {
  if (format === 'md')
    return saveGeneratedFile(
      `${document.filename}.md`,
      new Blob([await portableExportMarkdown(document.markdown, signal)], {
        type: 'text/markdown;charset=utf-8',
      }),
      'text/markdown',
    );
  // Lazy loading keeps fontkit and PDF code outside the normal practice bundle.
  const { decodePdfFont } = await import('./pdf-font');
  const base = new URL(import.meta.env.BASE_URL, window.document.baseURI);
  const fontPromise = (fontRequest ||= fetch(new URL('fonts/NotoSansSC-Regular.ttf.bin', base))
    .then(async (response) => {
      if (!response.ok) throw new Error('本地 PDF 字体加载失败，请刷新或重新打开应用后重试。');
      return decodePdfFont(new Uint8Array(await response.arrayBuffer()));
    })
    .catch((error) => {
      fontRequest = null;
      throw error;
    }));
  const formulaResolverPromise = document.mathEnabled
    ? import('./formula-image').then(({ createPdfFormulaResolver }) => createPdfFormulaResolver())
    : Promise.resolve(undefined);
  // The failed font request clears the shared cache for retry. Keep this
  // operation's promise and observe both lazy loads before either can reject.
  const [fontBytes, formulaResolver] = await Promise.all([fontPromise, formulaResolverPromise]);
  const bytes = await renderInWorker(document, fontBytes, formulaResolver, signal);
  signal?.throwIfAborted();
  return saveGeneratedFile(`${document.filename}.pdf`, bytes, 'application/pdf');
}
