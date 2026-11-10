import { Plus, Upload } from 'lucide-react';
import { upgradeGuideHref } from '../shared/lib/feature-destinations';

export function FirstRunGuide() {
  return (
    <section className="card first-run-guide" aria-labelledby="first-run-guide-title">
      <h2 id="first-run-guide-title">开始第一次学习</h2>
      <p>导入已有的认知星图题库 ZIP，或自己写一道题。</p>
      <div className="dashboard-guide-actions">
        <a className="button primary" href="#/sharing">
          <Upload size={16} aria-hidden="true" />
          导入题库包
        </a>
        <a className="button" href="#/questions/new">
          <Plus size={16} aria-hidden="true" />
          自己建题
        </a>
      </div>
      <ol className="first-run-guide-steps">
        <li>
          新增题目进入待审核。<a href="#/questions/review">前往审核</a>
        </li>
        <li>审核通过后，回到知识总览，创建题集并开始练习。</li>
      </ol>
      <p className="first-run-guide-recovery">
        已有学习数据？ <a href={upgradeGuideHref}>备份、升级与恢复</a>
      </p>
    </section>
  );
}
