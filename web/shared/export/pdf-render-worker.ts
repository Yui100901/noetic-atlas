import type { ExportDocument } from '../../../shared/models/export-types';
import { renderExportPdf } from './export-pdf';
import type { PdfFormulaImage, PdfImageData } from './pdf-types';

export type PdfResourceRequest =
  | { type: 'image'; id: number; url: string }
  | { type: 'formula'; id: number; source: string; display: boolean; size: number };
export type PdfWorkerRequest =
  | { type: 'start'; document: ExportDocument; font: Uint8Array; formulas: boolean }
  | { type: 'resource'; id: number; value?: PdfImageData | PdfFormulaImage | null; error?: string };
export type PdfWorkerResponse =
  PdfResourceRequest | { type: 'result'; bytes: Uint8Array } | { type: 'failure'; message: string };

let sequence = 0;
const resources = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
function resource<T>(
  request:
    | { type: 'image'; url: string }
    | { type: 'formula'; source: string; display: boolean; size: number },
) {
  const id = ++sequence;
  return new Promise<T>((resolve, reject) => {
    resources.set(id, { resolve, reject });
    self.postMessage({ ...request, id } satisfies PdfResourceRequest);
  });
}
self.onmessage = async ({ data }: MessageEvent<PdfWorkerRequest>) => {
  if (data.type === 'resource') {
    const pending = resources.get(data.id);
    resources.delete(data.id);
    if (data.error) pending?.reject(new Error(data.error));
    else pending?.resolve(data.value);
    return;
  }
  try {
    const bytes = await renderExportPdf(
      data.document,
      data.font,
      undefined,
      (url) => resource<PdfImageData | null>({ type: 'image', url }),
      data.formulas
        ? (source, display, size) =>
            resource<PdfFormulaImage>({ type: 'formula', source, display, size })
        : undefined,
    );
    self.postMessage({ type: 'result', bytes } satisfies PdfWorkerResponse, {
      transfer: [bytes.buffer as ArrayBuffer],
    });
  } catch (error) {
    self.postMessage({
      type: 'failure',
      message: error instanceof Error ? error.message : 'PDF生成失败',
    } satisfies PdfWorkerResponse);
  }
};
