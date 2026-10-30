/** A citation identifies immutable source content, independently of its title. */
export interface DocumentCitation {
  documentId: string | null;
  versionId: string | null;
  title: string;
  relation: 'extracted' | 'summarized' | 'reference';
  label: string;
  pageStart?: number;
  pageEnd?: number;
  startOffset?: number;
  endOffset?: number;
  excerpt: string;
}
export interface DocumentVersion {
  id: string;
  documentId: string;
  versionId: string;
  title: string;
  format: 'markdown' | 'pdf';
  bodyMarkdown: string;
  assetId: string | null;
  fileName: string | null;
  createdAt: string;
}
export interface DocumentSourceView extends DocumentVersion {
  currentVersionId: string | null;
  currentTitle: string | null;
  archived: boolean;
}
export interface DocumentRelatedQuestion {
  id: string;
  title: string;
  type: string;
  status: string;
  documentLinks: DocumentCitation[];
}
export const citationRelations = {
  extracted: '原文摘题',
  summarized: '依据原文总结',
  reference: '参考引用',
} as const;
export function citationLocation(
  citation: Pick<DocumentCitation, 'label' | 'pageStart' | 'pageEnd' | 'startOffset' | 'endOffset'>,
): string {
  return [
    citation.label,
    citation.pageStart
      ? `PDF文件第${citation.pageStart}${citation.pageEnd && citation.pageEnd !== citation.pageStart ? `–${citation.pageEnd}` : ''}页`
      : citation.startOffset !== undefined
        ? '原文段落'
        : '整份资料',
  ]
    .filter(Boolean)
    .join(' · ');
}
