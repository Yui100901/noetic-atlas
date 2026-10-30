import { useState } from 'react';
import { BookOpen, X } from 'lucide-react';
import type { DocumentRecord } from '../../../shared/models/types';
import type { DocumentListItem } from '../../../shared/models/library';
import type { Paged } from '../../../shared/utils/pagination';
import { idPath, qs, request, useDebounced, useResource } from '../../shared/lib/api';
import { ErrorNotice, Loading, Pagination, SearchBox } from '../../shared/ui/components';
import './document-sources.css';

export type SelectedDocument = Omit<DocumentRecord, 'format'> & {
  format: 'markdown' | 'pdf';
  contentVersion: string;
};
/** Paged metadata first; load one book body only after a deliberate selection. */
export function DocumentPicker({
  onSelect,
  disabled = false,
  label = '选择资料库原文',
}: {
  onSelect: (document: SelectedDocument) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(10),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const debounced = useDebounced(search),
    waiting = search !== debounced;
  const resource = useResource<Paged<DocumentListItem>>(
    open && !waiting ? `/api/documents/page?${qs({ search: debounced, page, pageSize })}` : null,
  );
  const select = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      const document = await request<SelectedDocument>(`/api/documents/${idPath(id)}`);
      onSelect(document);
      setOpen(false);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="document-picker">
      <button
        type="button"
        className="button"
        disabled={disabled || busy}
        onClick={() => setOpen((value) => !value)}
      >
        <BookOpen size={16} />
        {busy ? '正在读取资料…' : label}
      </button>
      {open && (
        <section className="source-picker-panel form-stack" aria-label="选择原文资料">
          <div className="list-toolbar">
            <SearchBox
              value={search}
              onChange={(value) => {
                setSearch(value);
                setPage(1);
              }}
              placeholder="搜索书名、作者或正文"
            />
            <button
              className="icon-button"
              type="button"
              aria-label="关闭资料选择"
              onClick={() => setOpen(false)}
            >
              <X size={16} />
            </button>
          </div>
          {error && <ErrorNotice message={error} />}
          <fieldset disabled={disabled || busy} className="source-picker-results">
            {waiting || resource.loading ? (
              <Loading />
            ) : resource.error ? (
              <ErrorNotice message={resource.error} retry={resource.refresh} />
            ) : (
              resource.data?.items.map((document) => (
                <button
                  key={document.id}
                  type="button"
                  className="source-picker-item"
                  onClick={() => void select(document.id)}
                >
                  <strong>{document.title}</strong>
                  <span className="muted">
                    {document.format === 'pdf' ? 'PDF' : 'Markdown'} · {document.kind}
                    {document.author ? ` · ${document.author}` : ''}
                  </span>
                </button>
              ))
            )}
          </fieldset>
          {resource.data && !waiting && !resource.loading && (
            <>
              <Pagination
                {...resource.data}
                onPage={setPage}
                onPageSize={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
                label="可关联资料"
              />
              {!resource.data.total && (
                <p className="muted">没有匹配资料，可先在资料库上传教材。</p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
