import { useState } from 'react';
import type { AiDocumentSectionInput } from '../../../shared/ai/ai-document';
import { usePagination } from '../../shared/lib/pagination';
import { Pagination } from '../../shared/ui/components';

export function AiDocumentSourcePreview({ sections }: { sections: AiDocumentSectionInput[] }) {
  const [expanded, setExpanded] = useState(-1), paging = usePagination(sections, sections);
  return <details><summary>核对初始分块和提取正文</summary><div className="ai-local-sections">{paging.items.map((section, index) => {
    const position = (paging.page - 1) * paging.pageSize + index;
    return <div key={position}><button className="text-button" aria-expanded={expanded === position} onClick={() => setExpanded(value => value === position ? -1 : position)}>{position + 1}. {section.label} · {section.text.length.toLocaleString()}字符</button>{expanded === position && <pre>{section.text}</pre>}</div>;
  })}</div><Pagination {...paging} label="初始资料分块" /></details>;
}
