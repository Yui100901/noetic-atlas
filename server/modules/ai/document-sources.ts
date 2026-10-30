import type { DocumentVersion } from '../../../shared/models/document-citations.js';
import type { AiDocumentSectionInput } from '../../../shared/ai/ai-document.js';
import type { Store } from '../../core/store.js';
import { fail } from '../../core/validation.js';
import { createDocument } from '../library/service.js';
import {
  captureDocumentVersion,
  documentVersionKey,
  validateDocumentCitations,
} from '../library/sources.js';

/** Explicit opt-in archives extracted text, not a hidden copy of an entire PDF.
 * A library PDF keeps its actual file and file-page locators instead. */
export function prepareJobSources(
  store: Store,
  input: {
    sections: AiDocumentSectionInput[];
    saveSources: boolean;
    sourceName: string;
    categoryIds: string[];
    tagIds: string[];
    mode: string;
  },
): AiDocumentSectionInput[] {
  const sections = structuredClone(input.sections);
  const sourceCache = new Map<string, DocumentVersion>();
  if (input.saveSources) {
    const groups = new Map<string, AiDocumentSectionInput[]>();
    for (const section of sections)
      if (!section.sourceCitation) {
        const key = section.sourceName || input.sourceName;
        const group = groups.get(key) || [];
        group.push(section);
        groups.set(key, group);
      }
    for (const [title, group] of groups) {
      const document = createDocument(store, {
        title,
        kind: '教材摘录',
        bodyMarkdown: group.map((section) => section.text).join('\n\n'),
        categoryIds: input.categoryIds,
        tagIds: input.tagIds,
        description:
          'AI教材任务经用户确认保存的提取正文；PDF页码标注保留于引用位置，原PDF不随文字摘录保存。',
      });
      const version = captureDocumentVersion(store, document);
      let offset = 0;
      for (const section of group) {
        section.sourceCitation = {
          documentId: document.id,
          versionId: version.versionId,
          title,
          relation: input.mode === 'extract' ? 'extracted' : 'summarized',
          label: section.label || '',
          startOffset: offset,
          endOffset: offset + section.text.length,
          excerpt: section.text.slice(0, 500),
        };
        offset += section.text.length + 2;
      }
    }
  }
  for (const section of sections)
    if (section.sourceCitation) {
      const citation = section.sourceCitation;
      if (!citation.documentId || !citation.versionId)
        fail(400, 'AI_DOCUMENT_SOURCE_REQUIRED', '教材任务须关联本机可读取的资料版本');
      validateDocumentCitations(store, { documentLinks: [citation] }, true, sourceCache);
      const source = sourceCache.get(
        documentVersionKey(citation.documentId!, citation.versionId!),
      )!;
      if (source.format === 'markdown') {
        const expected =
          citation.startOffset === undefined
            ? source.bodyMarkdown
            : source.bodyMarkdown.slice(citation.startOffset, citation.endOffset);
        if (!expected.includes(section.text))
          fail(
            400,
            'AI_DOCUMENT_SOURCE_MISMATCH',
            '待处理正文与关联的原文段落不一致，请重新从资料库读取',
          );
      } else if (
        citation.pageStart !== section.pageStart ||
        citation.pageEnd !== (section.pageEnd ?? section.pageStart)
      )
        fail(400, 'AI_DOCUMENT_SOURCE_MISMATCH', 'PDF提取页码与原文定位不一致');
      citation.title = source.title;
      citation.relation = input.mode === 'extract' ? 'extracted' : 'summarized';
    }
  return sections;
}
