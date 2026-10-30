import { useState } from 'react';
import type { LearningDayOverview } from '../../../shared/models/learning-plan';
import type { Paged } from '../../../shared/utils/pagination';
import { qs, useResource } from '../../shared/lib/api';
import { Loading, ErrorNotice, Pagination } from '../../shared/ui/components';
import { planHref } from './learning-plan-card';
import './learning-plan.css';
export function LearningPlanHistory() {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(10),
    resource = useResource<Paged<LearningDayOverview>>(
      open ? `/api/learning-plans?${qs({ page, pageSize })}` : null,
    );
  return (
    <details className="card learning-plan-history" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>每日学习计划历史</summary>
      {open &&
        (resource.loading ? (
          <Loading />
        ) : resource.error ? (
          <ErrorNotice message={resource.error} retry={resource.refresh} />
        ) : (
          <div className="learning-plan-history-body">
            {resource.data?.items.map((day) => (
              <a className="learning-plan-history-row" key={day.id} href={planHref(day.id)}>
                <strong>{day.title}</strong>
                <span>
                  {day.progress.completed}/{day.progress.total} 项 · {day.progress.percent}%
                </span>
              </a>
            ))}
            {!resource.data?.total && (
              <p className="muted">启用多目标学习后，生成的每日安排保存在这里。</p>
            )}
            <Pagination
              page={page}
              pageSize={pageSize}
              total={resource.data?.total || 0}
              onPage={setPage}
              onPageSize={(n) => {
                setPageSize(n);
                setPage(1);
              }}
              label="学习计划历史"
            />
          </div>
        ))}
    </details>
  );
}
