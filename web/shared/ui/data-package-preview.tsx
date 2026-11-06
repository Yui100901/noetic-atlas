import type {
  ConfigurationChange,
  ConfigurationPreview,
} from '../../../shared/models/configuration';
import type { DataPackagePreview } from '../../../shared/models/data-packages';
import { configurationLabels, displayConfigurationValue } from '../lib/configuration-values';

const kinds: Record<string, string> = {
  share: '内容分享',
  migration: '可信数据迁移',
  configuration: '配置迁移',
  'question-template': '新增题目',
  'question-update': '修改待审核题目',
};
const labels: Record<string, string> = {
  domains: '领域',
  categories: '分类',
  tags: '标签',
  assets: '附件',
  questions: '题目',
  papers: '题集',
  documents: '资料',
  attempts: '作答记录',
  study: '学习状态',
  questionDrafts: '编辑草稿',
  questionRevisions: '修订历史',
  settings: '系统配置',
  questionBanks: '历史引用集合',
  studyParts: '小题学习状态',
  learningResults: '学习结果',
  reviews: '复习记录',
  focusSessions: '专注复习会话',
  documentVersions: '资料版本',
  learningDays: '每日学习计划',
  learningTaskResults: '计划任务结果',
  paperDrafts: '组题草稿',
  documentDrafts: '资料草稿',
  aiWorkspaceDrafts: 'AI 工作台草稿',
  questionHistory: '单题作答历史',
  dailyPushes: '每日推荐',
  reviewCards: '复习卡片',
  reviewEvents: '复习调度记录',
  questionFeedback: '题目反馈',
  qualityScans: '质量扫描记录',
  qualityIssues: '质量问题',
};

function PackageCounts({
  counts,
  omitQuestions = false,
}: {
  counts: DataPackagePreview['counts'];
  omitQuestions?: boolean;
}) {
  const entries = Object.entries(counts).filter(([key]) => !omitQuestions || key !== 'questions');
  const active = entries.filter(([, value]) => Object.values(value).some((count) => count > 0));
  const empty = entries.length - active.length;
  if (!entries.length) return null;
  return (
    <>
      {active.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>内容</th>
                <th>新增</th>
                <th>复用</th>
                <th>另存</th>
                <th>保留本机</th>
              </tr>
            </thead>
            <tbody>
              {active.map(([key, count]) => (
                <tr key={key}>
                  <th>{labels[key] || key}</th>
                  {(['added', 'reused', 'remapped', 'skipped'] as const).map((field) => (
                    <td key={field}>{count[field]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">本包没有需要合并的记录。</p>
      )}
      {empty > 0 && <p className="muted">其余 {empty} 类数据为空。</p>}
    </>
  );
}

function ConfigurationChanges({
  title,
  changes,
}: {
  title: string;
  changes: ConfigurationChange[];
}) {
  return (
    <section className="data-package-config-section">
      <h4>{title}</h4>
      {changes.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>配置项</th>
                <th>当前值</th>
                <th>导入值</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.key}>
                  <th>{configurationLabels[change.key] || change.key}</th>
                  <td>{displayConfigurationValue(change.before, change.key)}</td>
                  <td>{displayConfigurationValue(change.after, change.key)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">没有差异。</p>
      )}
    </section>
  );
}

function ConfigurationPreviewBody({ details }: { details: ConfigurationPreview }) {
  return (
    <>
      <ConfigurationChanges title="常规配置" changes={details.systemChanges} />
      <ConfigurationChanges title="AI配置" changes={details.aiChanges} />
      <p>{details.aiKey.message}</p>
    </>
  );
}

/** Important admission and destructive-operation confirmations stay visible.
 * Longer explanatory text is optional reading after the relevant summary. */
export function DataPackagePreviewBody({
  preview,
  busy,
  trusted,
  onTrusted,
  retention,
  onRetention,
}: {
  preview: DataPackagePreview;
  busy: boolean;
  trusted: boolean;
  onTrusted: (value: boolean) => void;
  retention: boolean;
  onRetention: (value: boolean) => void;
}) {
  return (
    <>
      <h3>{preview.title}</h3>
      <p>
        已识别用途：<strong>{kinds[preview.kind] || preview.kind}</strong>
      </p>
      <PackageCounts counts={preview.counts} omitQuestions={!!preview.dedup} />
      {preview.kind === 'share' && (
        <p className="notice info">
          分享新增题目进入待审核，完全重复复用原题；相似内容可核对差异后覆盖、保留原题或保留两者。含新题的题集先归档，审核后可恢复。
        </p>
      )}
      {preview.kind === 'question-template' && (
        <p className="notice info">所有新增题目进入待审核，文件中的原审核状态不会直接生效。</p>
      )}
      {preview.kind === 'question-update' && (
        <p className="notice info">只修订现有待审核题目，保留原题号并核对版本。</p>
      )}
      {preview.kind === 'migration' && (
        <div className="notice warning">
          <div>
            <p>迁移保留原审核状态及包中包含的学习记录。同ID已有内容保留本机版本。</p>
            <label className="check-row">
              <input
                type="checkbox"
                checked={trusted}
                disabled={busy}
                onChange={(event) => onTrusted(event.target.checked)}
              />
              我确认这是自己的备份或可信来源的迁移包。
            </label>
          </div>
        </div>
      )}
      {preview.details && <ConfigurationPreviewBody details={preview.details} />}
      {preview.details && preview.details.retention.total > 0 && (
        <div className="notice warning">
          <div>
            <p>
              应用配置将清理超限草稿／历史等 {preview.details.retention.total}{' '}
              份记录。累计学习状态按原保留规则处理。
            </p>
            <label className="check-row">
              <input
                type="checkbox"
                checked={retention}
                disabled={busy}
                onChange={(event) => onRetention(event.target.checked)}
              />
              我确认应用配置并清理上述超限记录。
            </label>
          </div>
        </div>
      )}
      {preview.warnings.length > 0 && (
        <details className="help-disclosure">
          <summary>查看完整导入说明（{preview.warnings.length}项）</summary>
          <ul>
            {preview.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      {preview.questions && (
        <details className="help-disclosure">
          <summary>题目明细（{preview.questions.length}）</summary>
          <ul>
            {preview.questions.slice(0, 100).map((question) => (
              <li key={question.id}>
                {question.id} · {question.title}
              </li>
            ))}
          </ul>
          {preview.questions.length > 100 && <p className="muted">其余题目按清单一并导入。</p>}
        </details>
      )}
    </>
  );
}
