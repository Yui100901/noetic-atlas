import type { PdfExtractedPage, PdfTextItem } from '../../../shared/pdf/text';
export type { PdfExtractedPage } from '../../../shared/pdf/text';
export interface PdfExtractionOptions {
  signal?: AbortSignal;
  firstPage?: number;
  lastPage?: number;
  onDocument?: (pages: number) => void | Promise<void>;
}
/** Per-page iterator shared by indexing and AI extraction. It imposes no AI limits. */
export async function* extractPdfPages(
  bytes: Uint8Array,
  options: PdfExtractionOptions = {},
): AsyncGenerator<PdfExtractedPage> {
  const pdfjs = await import('pdfjs-dist'),
    worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const base = new URL(import.meta.env.BASE_URL, document.baseURI),
    task = pdfjs.getDocument({
      data: bytes,
      useSystemFonts: true,
      cMapPacked: true,
      cMapUrl: new URL('pdfjs/cmaps/', base).href,
      standardFontDataUrl: new URL('pdfjs/standard_fonts/', base).href,
    });
  const abort = () => void task.destroy();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    const pdf = await task.promise;
    await options.onDocument?.(pdf.numPages);
    for (
      let pageNumber = Math.max(1, options.firstPage || 1);
      pageNumber <= Math.min(pdf.numPages, options.lastPage || pdf.numPages);
      pageNumber++
    ) {
      options.signal?.throwIfAborted();
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent(),
          viewport = page.getViewport({ scale: 1 }),
          items: PdfTextItem[] = [];
        let text = '';
        for (const raw of content.items) {
          if (!('str' in raw)) continue;
          const start = text.length;
          text += raw.str;
          const [, , , , x, y] = raw.transform;
          items.push({
            text: raw.str,
            start,
            end: text.length,
            x: x || 0,
            y: y || 0,
            width: raw.width,
            height: raw.height || Math.hypot(raw.transform[2]!, raw.transform[3]!),
          });
          text += raw.hasEOL ? '\n' : ' ';
        }
        yield { pageNumber, text, width: viewport.width, height: viewport.height, items };
      } finally {
        page.cleanup();
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await task.destroy();
  }
}
