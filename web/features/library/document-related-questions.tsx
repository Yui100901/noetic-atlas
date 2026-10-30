import { useEffect, useState } from 'react';
import type { Paged } from '../../../shared/utils/pagination';
import type { DocumentRelatedQuestion } from '../../../shared/models/document-citations';
import { citationLocation, citationRelations } from '../../../shared/models/document-citations';
import { idPath, qs, useDebounced, useResource } from '../../shared/lib/api';
import { ErrorNotice, Loading, Pagination, SearchBox } from '../../shared/ui/components';
import { libraryQuestionHref } from '../questions/library-navigation';
import { documentSourceHref } from './source-navigation';
import './document-sources.css';

export function DocumentRelatedQuestions({
  documentId,
  versionId,
  pageNumber,
}: {
  documentId: string;
  versionId?: string;
  pageNumber?: number;
}) {
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(10),
    [search, setSearch] = useState(''),
    [currentPage, setCurrentPage] = useState(false);
  useEffect(() => {
    if (currentPage) setPage(1);
  }, [pageNumber, currentPage]);
  const debounced = useDebounced(search),
    waiting = debounced !== search;
  const resource = useResource<Paged<DocumentRelatedQuestion>>(
    waiting
      ? null
      : `/api/documents/${idPath(documentId)}/questions?${qs({ page, pageSize, versionId, search: debounced, pageNumber: currentPage ? pageNumber : undefined })}`,
  );
  return (
    <section className="card form-stack document-related" aria-label="原文关联题目">
      <div className="card-heading">
        <h2>关联题目</h2>
        <span className="muted">
          {resource.data?.total ?? 0} 题{versionId ? ' · 当前资料版本' : ''}
        </span>
      </div>
      <div className="source-related-filters">
        <SearchBox
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          placeholder="搜索关联题目"
        />
        {pageNumber && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={currentPage}
              onChange={(event) => {
                setCurrentPage(event.target.checked);
                setPage(1);
              }}
            />
            仅当前文件页
          </label>
        )}
      </div>
      {waiting || resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <ErrorNotice message={resource.error} retry={resource.refresh} />
      ) : (
        <div className="source-citation-list">
          {resource.data?.items.map((question) => (
            <article className="source-citation" key={question.id}>
              <div className="source-citation-heading">
                <a href={libraryQuestionHref(question.id, window.location.hash)}>
                  <strong>{question.title}</strong>
                </a>
                <span className="badge">
                  {
                    { published: '已发布', pending: '待审核', draft: '草稿', archived: '已归档' }[
                      question.status
                    ]
                  }
                </span>
              </div>
              {question.documentLinks.map((citation, index) => (
                <div className="source-related-location" key={index}>
                  <span className="muted">
                    {citationRelations[citation.relation]} · {citationLocation(citation)}
                  </span>
                  <a
                    className="button compact"
                    href={documentSourceHref(citation, window.location.hash)}
                  >
                    定位原文
                  </a>
                </div>
              ))}
            </article>
          ))}
          {!resource.data?.total && (
            <p className="muted">此范围尚无关联题目，可手动关联或从教材生成题目。</p>
          )}
        </div>
      )}
      {resource.data && !waiting && !resource.loading && (
        <Pagination
          {...resource.data}
          onPage={setPage}
          onPageSize={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          label="原文关联题目"
        />
      )}
    </section>
  );
}
