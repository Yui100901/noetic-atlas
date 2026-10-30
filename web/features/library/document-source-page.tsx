import { useCallback, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { DocumentSourceView } from '../../../shared/models/document-citations';
import { idPath, useResource } from '../../shared/lib/api';
import { ErrorNotice, Loading, PageHeader } from '../../shared/ui/components';
import MarkdownRenderer from '../../shared/ui/markdown-renderer';
import { PdfSourceReader } from '../../shared/media/pdf-source-reader';
import { contentReturn } from '../../shared/lib/content-navigation';
import { sourceLocation } from './source-navigation';
import { DocumentRelatedQuestions } from './document-related-questions';
import './document-sources.css';

export function DocumentSourcePage({ id }: { id: string }) {
  const params = new URLSearchParams(window.location.hash.split('?')[1] || ''),
    version = params.get('version') || '',
    [location] = useState(() => sourceLocation(params));
  const resource = useResource<DocumentSourceView>(
    /^[a-f0-9]{64}$/.test(version) ? `/api/documents/${idPath(id)}/versions/${version}` : null,
  );
  const [page, setPage] = useState(location.page),
    back = contentReturn(params.get('returnTo'));
  const changePage = useCallback((value: number) => {
    setPage(value);
    const hash = window.location.hash,
      [path, query] = hash.split('?');
    const next = new URLSearchParams(query || '');
    next.set('page', String(value));
    history.replaceState(history.state, '', path + '?' + next);
  }, []);
  if (resource.loading) return <Loading />;
  if (!resource.data || resource.error)
    return (
      <>
        <a className="back-link" href={back}>
          <ArrowLeft size={15} />
          返回来源页面
        </a>
        <ErrorNotice
          message={resource.error || '原文版本链接无效，请从题目的原文出处重新打开'}
          retry={resource.refresh}
        />
      </>
    );
  const source = resource.data,
    changed = source.currentVersionId !== source.versionId;
  return (
    <div className="source-reader">
      <a className="back-link" href={back}>
        <ArrowLeft size={15} />
        返回来源页面
      </a>
      <PageHeader
        eyebrow="SOURCE READER · 原文核对"
        title={source.title}
        description={`${source.format === 'pdf' ? 'PDF文件页码' : 'Markdown原文段落'} · 引用版本 ${source.versionId.slice(0, 8)}`}
      />
      {(changed || source.archived) && (
        <div className="notice info source-version-note">
          {source.archived
            ? '原资料已归档或移除，正在显示保存的引用版本。'
            : '教材正文已有更新，正在显示题目引用时的版本，未替换为新版。'}
        </div>
      )}
      <div className="source-reader-actions">
        {!source.archived && (
          <a className="button" href={`#/documents/${idPath(id)}`}>
            查看当前资料与全部关联题
          </a>
        )}
      </div>
      <article className="card reading-card">
        {source.format === 'pdf' && source.assetId ? (
          <PdfSourceReader
            assetId={source.assetId}
            initialPage={location.page}
            onPage={changePage}
          />
        ) : (
          <MarkdownRenderer mathEnabled={source.mathEnabled} sourceRange={location.range}>
            {source.bodyMarkdown}
          </MarkdownRenderer>
        )}
      </article>
      <DocumentRelatedQuestions
        key={`${id}:${version}`}
        documentId={id}
        versionId={version}
        pageNumber={source.format === 'pdf' ? page : undefined}
      />
    </div>
  );
}
