import { AI_DOCUMENT_LIMITS, type AiDocumentSectionInput } from '../../../shared/ai/ai-document';

const encoder = new TextEncoder();
export const AI_DOCUMENT_FILE_LIMITS = { files: 20, fileBytes: 30 * 1024 * 1024, pdfPages: 2000 } as const;
export interface DocumentExtractProgress { filename: string; file: number; totalFiles: number; page?: number; totalPages?: number }
export interface DocumentFileOptions {
  firstPage?: number; lastPage?: number; signal?: AbortSignal;
  onProgress?: (value: DocumentExtractProgress) => void;
}
export interface DocumentFilesResult { sections: AiDocumentSectionInput[]; sourceName: string; characters: number; bytes: number; files: number; pages: number; warnings: string[] }

function active(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('已取消本机文件提取', 'AbortError'); }
/** Bound model-sized chunks while preserving all source text and code spaces. */
export function splitDocumentText(text: string): string[] {
  const parts: string[] = []; let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + AI_DOCUMENT_LIMITS.blockCharacters);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end);
      if (newline > cursor + AI_DOCUMENT_LIMITS.blockCharacters / 2) end = newline + 1;
    }
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    while (encoder.encode(text.slice(cursor, end)).byteLength > AI_DOCUMENT_LIMITS.blockBytes) {
      end -= Math.max(1, Math.floor((end - cursor) / 12));
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    parts.push(text.slice(cursor, end)); cursor = end;
  }
  return parts;
}
export function documentPageRange(total: number, first = 1, last = total) {
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || first > last || last > total) throw new Error(`PDF页码范围无效：该文件共有${total}页，请填写1至${total}之间的起止页。`);
  return { first, last };
}

export async function extractDocumentFiles(files: File[], options: DocumentFileOptions = {}): Promise<DocumentFilesResult> {
  if (!files.length || files.length > AI_DOCUMENT_FILE_LIMITS.files) throw new Error(`每次请选择1至${AI_DOCUMENT_FILE_LIMITS.files}个文件。`);
  const sections: AiDocumentSectionInput[] = [], warnings: string[] = [];
  let characters = 0, bytes = 0, pages = 0, fileSectionStart = 0;
  const append = (text: string, sourceName: string, label: string, page?: number) => {
    if (!text.trim()) return;
    characters += text.length; bytes += encoder.encode(text).byteLength;
    if (characters > AI_DOCUMENT_LIMITS.maxSourceCharacters || bytes > AI_DOCUMENT_LIMITS.maxSourceBytes) throw new Error('本次提取内容超过400万字符或12MB，请缩小页码范围或减少文件。已停止提取，没有发送模型。');
    const chunks = splitDocumentText(text);
    chunks.forEach((chunk, index) => {
      const previous = sections.at(-1), combined = previous ? `${previous.text}\n\n${chunk}` : '';
      if (page && sections.length > fileSectionStart && previous?.pageStart && previous.sourceName === sourceName && previous.pageEnd !== undefined && previous.pageEnd >= page - 1 && combined.length <= AI_DOCUMENT_LIMITS.blockCharacters && encoder.encode(combined).byteLength <= AI_DOCUMENT_LIMITS.blockBytes) {
        previous.text = combined; previous.pageEnd = page; previous.label = `${sourceName} · 第${previous.pageStart}${previous.pageStart === page ? '' : `–${page}`}页`; characters += 2; bytes += 2;
      } else sections.push({ text: chunk, sourceName, label: chunks.length > 1 ? `${label} · ${index + 1}/${chunks.length}` : label, ...(page ? { pageStart: page, pageEnd: page } : {}) });
      if (sections.length > AI_DOCUMENT_LIMITS.maxBlocks || characters > AI_DOCUMENT_LIMITS.maxSourceCharacters || bytes > AI_DOCUMENT_LIMITS.maxSourceBytes) throw new Error(`本次资料超过${AI_DOCUMENT_LIMITS.maxBlocks}个分块或正文容量上限，请缩小范围后分任务处理。`);
    });
  };
  for (const [index, file] of files.entries()) {
    active(options.signal);
    fileSectionStart = sections.length;
    if (file.size > AI_DOCUMENT_FILE_LIMITS.fileBytes) throw new Error(`${file.name}超过30MiB，请压缩文件或另存所需章节后处理。`);
    const update = (page?: number, totalPages?: number) => options.onProgress?.({ filename: file.name, file: index + 1, totalFiles: files.length, ...(page ? { page } : {}), ...(totalPages ? { totalPages } : {}) });
    update();
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      const pdfjs = await import('pdfjs-dist'), worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const base = new URL(import.meta.env.BASE_URL, document.baseURI);
      const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), useSystemFonts: true, cMapPacked: true, cMapUrl: new URL('pdfjs/cmaps/', base).href, standardFontDataUrl: new URL('pdfjs/standard_fonts/', base).href });
      const abort = () => { void task.destroy(); }; options.signal?.addEventListener('abort', abort, { once: true });
      try {
        const pdf = await task.promise; active(options.signal);
        if (pdf.numPages > AI_DOCUMENT_FILE_LIMITS.pdfPages) throw new Error(`${file.name}共有${pdf.numPages}页，单文件最多${AI_DOCUMENT_FILE_LIMITS.pdfPages}页，请另存章节后处理。`);
        const range = documentPageRange(pdf.numPages, options.firstPage, options.lastPage);
        let readable = 0, empty = 0;
        for (let pageNumber = range.first; pageNumber <= range.last; pageNumber++) {
          active(options.signal); update(pageNumber, pdf.numPages);
          const page = await pdf.getPage(pageNumber);
          try {
            const content = await page.getTextContent(); active(options.signal);
            const text = content.items.map(item => 'str' in item ? item.str + ('hasEOL' in item && item.hasEOL ? '\n' : ' ') : '').join('');
            if (text.trim()) { append(text, file.name, `${file.name} · 第${pageNumber}页`, pageNumber); readable++; } else empty++;
            pages++;
          } finally { page.cleanup(); }
        }
        if (!readable) throw new Error(`${file.name}所选页未提取到文字，可能是扫描PDF。当前不含OCR，请先识别文字后再处理。`);
        if (empty) warnings.push(`${file.name}有${empty}个所选页未提取到文字，可能为空白或扫描图片；这些页未用于出题。`);
      } finally { options.signal?.removeEventListener('abort', abort); await task.destroy(); }
    } else {
      if (!/\.(txt|md|markdown|json|csv)$/i.test(file.name)) throw new Error(`${file.name}不支持。请选择PDF、TXT、Markdown、JSON或CSV。`);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
      catch { throw new Error(`${file.name}不是有效UTF-8文本，请转换编码后处理。`); }
      active(options.signal);
      if (text.includes('\0')) throw new Error(`${file.name}不是有效文本，请转为UTF-8后处理。`);
      append(text, file.name, file.name);
    }
  }
  active(options.signal);
  if (!sections.length) throw new Error('所选文件没有可提取正文，没有创建任务或发送模型。');
  return { sections, sourceName: files.length === 1 ? files[0].name : `${files[0].name} 等${files.length}份资料`, characters, bytes, files: files.length, pages, warnings };
}
