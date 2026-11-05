import type { ExportDocument } from '../../../shared/models/export-types';
import { saveGeneratedFile } from '@platform';
import {
  assetIdFromUrl,
  base64ToBytes,
  embeddedRasterImage,
  type AssetRecord,
} from '../../../shared/assets/assets';
import { request } from '../lib/api';
import type { PdfImageData } from './export-pdf';

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
export async function portableExportMarkdown(markdown: string): Promise<string> {
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
    const image = await localImage(url);
    if (!image) continue;
    result = result.split(url).join(`data:${image.mimeType};base64,${image.dataBase64}`);
  }
  return result;
}

let fontRequest: Promise<Uint8Array> | null = null;
export async function downloadExport(document: ExportDocument, format: 'md' | 'pdf') {
  if (format === 'md')
    return saveGeneratedFile(
      `${document.filename}.md`,
      new Blob([await portableExportMarkdown(document.markdown)], {
        type: 'text/markdown;charset=utf-8',
      }),
      'text/markdown',
    );
  // Lazy loading keeps fontkit and PDF code outside the normal practice bundle.
  const [{ renderExportPdf }, { decodePdfFont }] = await Promise.all([
    import('./export-pdf'),
    import('./pdf-font'),
  ]);
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
  const bytes = await renderExportPdf(
    document,
    fontBytes,
    undefined,
    resolvePdfImage,
    formulaResolver,
  );
  return saveGeneratedFile(`${document.filename}.pdf`, bytes, 'application/pdf');
}
