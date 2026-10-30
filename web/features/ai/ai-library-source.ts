import { AI_DOCUMENT_LIMITS } from '../../../shared/ai/ai-document';
import type { SelectedDocument } from '../library/document-picker';
import { decodeAsset, fetchAsset } from '../../shared/media/asset-files';
import {
  extractDocumentFiles,
  splitDocumentText,
  type DocumentFileOptions,
  type DocumentFilesResult,
} from './ai-document-files';

/** Locators originate in local extraction, never in model-generated prose. */
export async function extractLibrarySource(
  document: SelectedDocument,
  options: DocumentFileOptions = {},
): Promise<DocumentFilesResult> {
  if (document.format === 'pdf' && document.assetId) {
    const asset = await fetchAsset(document.assetId);
    if (options.signal?.aborted) throw new DOMException('已取消', 'AbortError');
    const result = await extractDocumentFiles(
      [
        new File(
          [new Uint8Array(decodeAsset(asset)).buffer],
          document.fileName || `${document.title}.pdf`,
          { type: 'application/pdf' },
        ),
      ],
      options,
    );
    result.sourceName = document.title;
    result.sections = result.sections.map((section) => ({
      ...section,
      sourceName: document.title,
      sourceCitation: {
        documentId: document.id,
        versionId: document.contentVersion,
        title: document.title,
        relation: 'summarized',
        label: section.label || '',
        pageStart: section.pageStart,
        pageEnd: section.pageEnd,
        excerpt: section.text.slice(0, 500),
      },
    }));
    return result;
  }
  const text = document.bodyMarkdown,
    bytes = new TextEncoder().encode(text).byteLength;
  if (!text.trim()) throw new Error('资料没有可用于出题的正文。');
  if (
    text.length > AI_DOCUMENT_LIMITS.maxSourceCharacters ||
    bytes > AI_DOCUMENT_LIMITS.maxSourceBytes
  )
    throw new Error('资料正文超过400万字符或12MB，请先保存所需章节后处理。');
  let offset = 0;
  const sections = splitDocumentText(text).map((part, index) => {
    const start = offset;
    offset += part.length;
    return {
      text: part,
      sourceName: document.title,
      label: `${document.title} · 段落块${index + 1}`,
      sourceCitation: {
        documentId: document.id,
        versionId: document.contentVersion,
        title: document.title,
        relation: 'summarized' as const,
        label: `段落块${index + 1}`,
        startOffset: start,
        endOffset: offset,
        excerpt: part.slice(0, 500),
      },
    };
  });
  return {
    sections,
    sourceName: document.title,
    characters: text.length,
    bytes,
    files: 1,
    pages: 0,
    warnings: [],
  };
}
