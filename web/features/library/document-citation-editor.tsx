import { useEffect, useRef, useState } from 'react';
import { Edit3, Trash2 } from 'lucide-react';
import type {
  DocumentCitation,
  DocumentSourceView,
} from '../../../shared/models/document-citations';
import { citationLocation, citationRelations } from '../../../shared/models/document-citations';
import { documentTextBlocks } from '../../../shared/questions/document-blocks';
import { idPath, request } from '../../shared/lib/api';
import { ErrorNotice, Field } from '../../shared/ui/components';
import { DocumentPicker, type SelectedDocument } from './document-picker';
import { documentSourceHref } from './source-navigation';

export function DocumentCitationEditor({
  value,
  onChange,
  disabled = false,
  initialDocumentId,
}: {
  value: DocumentCitation[];
  onChange: (value: DocumentCitation[]) => void;
  disabled?: boolean;
  initialDocumentId?: string;
}) {
  const [editing, setEditing] = useState(-1),
    [source, setSource] = useState<Pick<DocumentSourceView, 'format' | 'bodyMarkdown'> | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const initial = useRef(false),
    epoch = useRef(0),
    latest = useRef(value),
    change = useRef(onChange);
  latest.current = value;
  change.current = onChange;
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  const add = (document: SelectedDocument) => {
    const links = latest.current;
    const citation: DocumentCitation = {
      documentId: document.id,
      versionId: document.contentVersion,
      title: document.title,
      relation: 'reference',
      label: '',
      excerpt: '',
    };
    change.current([...links, citation]);
    setEditing(links.length);
    setSource(document);
    setError('');
  };
  useEffect(() => {
    if (!initialDocumentId || initial.current) return;
    initial.current = true;
    const stamp = ++epoch.current;
    setBusy(true);
    void request<SelectedDocument>(`/api/documents/${idPath(initialDocumentId)}`)
      .then((document) => {
        if (epoch.current === stamp && !latest.current.length) add(document);
      })
      .catch((reason) => {
        if (epoch.current === stamp) setError((reason as Error).message);
      })
      .finally(() => {
        if (epoch.current === stamp) setBusy(false);
      });
  }, [initialDocumentId]);
  const edit = async (index: number) => {
    const stamp = ++epoch.current;
    const citation = value[index];
    setEditing(index);
    setSource(null);
    if (!citation.documentId || !citation.versionId) return;
    setBusy(true);
    setError('');
    try {
      const version = await request<DocumentSourceView>(
        `/api/documents/${idPath(citation.documentId)}/versions/${citation.versionId}`,
      );
      if (epoch.current === stamp) setSource(version);
    } catch (reason) {
      if (epoch.current === stamp) setError((reason as Error).message);
    } finally {
      if (epoch.current === stamp) setBusy(false);
    }
  };
  const patch = (index: number, update: Partial<DocumentCitation>) =>
    onChange(value.map((citation, i) => (i === index ? { ...citation, ...update } : citation)));
  const paragraphs = source?.format === 'markdown' ? documentTextBlocks(source.bodyMarkdown) : [];
  return (
    <section className="card form-stack" aria-label="题目原文关联编辑">
      <h2 className="card-title">原文关联</h2>
      <p className="muted">
        可关联多份教材，区分原文摘题、总结出题和参考引用。没有原文的题目可留空。
      </p>
      {error && <ErrorNotice message={error} />}
      <fieldset disabled={disabled || busy} className="source-picker-results">
        <DocumentPicker disabled={value.length >= 30} onSelect={add} />
        {value.map((citation, index) => (
          <article className="source-citation" key={index}>
            <div className="source-citation-heading">
              <div>
                <strong>{citation.title}</strong>
                <p className="muted">
                  {citationRelations[citation.relation]} · {citationLocation(citation)}
                </p>
              </div>
              <div className="form-actions">
                <button className="button compact" type="button" onClick={() => void edit(index)}>
                  <Edit3 size={14} />
                  调整引用
                </button>
                <button
                  className="button compact danger-text"
                  type="button"
                  aria-label={`移除原文引用 ${index + 1}`}
                  onClick={() => {
                    epoch.current++;
                    onChange(value.filter((_, i) => i !== index));
                    setEditing(-1);
                    setSource(null);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            {editing === index && (
              <div className="source-edit-form form-stack">
                <div className="form-grid">
                  <Field label="引用关系">
                    <select
                      value={citation.relation}
                      onChange={(event) =>
                        patch(index, {
                          relation: event.target.value as DocumentCitation['relation'],
                        })
                      }
                    >
                      {Object.entries(citationRelations).map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="章节 / 位置说明（可选）">
                    <input
                      maxLength={300}
                      value={citation.label}
                      onChange={(event) => patch(index, { label: event.target.value })}
                    />
                  </Field>
                </div>
                {source?.format === 'markdown' && (
                  <Field label="原文段落">
                    <select
                      value={citation.startOffset === undefined ? '' : String(citation.startOffset)}
                      onChange={(event) => {
                        const block = paragraphs.find(
                          (item) => String(item.start) === event.target.value,
                        );
                        patch(
                          index,
                          block
                            ? {
                                startOffset: block.start,
                                endOffset: block.end,
                                excerpt: source.bodyMarkdown
                                  .slice(block.start, block.end)
                                  .slice(0, 500),
                              }
                            : { startOffset: undefined, endOffset: undefined, excerpt: '' },
                        );
                      }}
                    >
                      <option value="">整份资料</option>
                      {citation.startOffset !== undefined &&
                        !paragraphs.some((block) => block.start === citation.startOffset) && (
                          <option value={citation.startOffset}>已保存的原文片段</option>
                        )}
                      {paragraphs.map((block, i) => (
                        <option key={block.start} value={block.start}>
                          {i + 1}. {block.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {source?.format === 'pdf' && (
                  <div className="form-grid">
                    <Field label="PDF文件起始页">
                      <input
                        type="number"
                        min={1}
                        max={100000}
                        value={citation.pageStart ?? ''}
                        onChange={(event) =>
                          patch(index, {
                            pageStart: event.target.value ? Number(event.target.value) : undefined,
                            ...(!event.target.value ? { pageEnd: undefined } : {}),
                          })
                        }
                      />
                    </Field>
                    <Field label="PDF文件结束页（可选）">
                      <input
                        type="number"
                        min={citation.pageStart || 1}
                        max={100000}
                        value={citation.pageEnd ?? ''}
                        onChange={(event) =>
                          patch(index, {
                            pageEnd: event.target.value ? Number(event.target.value) : undefined,
                          })
                        }
                      />
                    </Field>
                  </div>
                )}
                <Field
                  label="依据摘录（可选）"
                  hint="最多2000字符；Markdown摘录必须实际存在于所选原文范围，PDF摘录请核对原件。"
                >
                  <textarea
                    rows={3}
                    maxLength={2000}
                    value={citation.excerpt}
                    onChange={(event) => patch(index, { excerpt: event.target.value })}
                  />
                </Field>
                {citation.documentId && citation.versionId && (
                  <a
                    className="button"
                    href={documentSourceHref(citation)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    在新窗口核对原文
                  </a>
                )}
                {!citation.documentId && (
                  <p className="muted">
                    此引用未附本机原文。可移除此项，再选择资料库中对应的教材。
                  </p>
                )}
              </div>
            )}
          </article>
        ))}
      </fieldset>
    </section>
  );
}
