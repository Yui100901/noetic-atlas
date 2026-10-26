import type { AnalyticsMetrics, WeeklyReport } from '../../../shared/models/analytics';

export const analyticsNumber = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
export const analyticsPercent = (value: number | null) => value == null ? '—' : `${analyticsNumber(value)}%`;
export function analyticsDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total >= 3600) return `${Math.floor(total / 3600)}小时${Math.floor(total % 3600 / 60)}分`;
  if (total >= 60) return `${Math.floor(total / 60)}分${total % 60}秒`;
  return `${total}秒`;
}
export const analyticsMeasuredDuration = (summary: AnalyticsMetrics) => !summary.timedSessions && summary.missingTimeSessions ? '未记录' : analyticsDuration(summary.elapsedSeconds);
export function analyticsDateKey(value: Date | string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = (key: string) => parts.find(item => item.type === key)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
const cell = (value: string | number) => String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const metricRows = (summary: AnalyticsMetrics) => [
  ['实际作答次数', summary.answers], ['去重作答项', summary.uniqueItems], ['去重原题', summary.uniqueQuestions],
  ['提交次数', summary.sessions], ['有实际回答的提交', summary.answeredSessions],
  ['题集提交', summary.paperSessions], ['随机／单题提交', summary.quickSessions],
  ['完全正确', summary.correct], ['部分正确', summary.partial], ['错误', summary.incorrect], ['未判定', summary.ungraded],
  ['漏答', summary.omitted], ['旧记录作答状态未知', summary.unknown], ['严格正确率', analyticsPercent(summary.accuracy)],
  ['已知作答计时', analyticsMeasuredDuration(summary)], ['有计时的提交', summary.timedSessions], ['缺少计时的提交', summary.missingTimeSessions],
  ['活跃天数', summary.activeDays], ['复习记录', summary.reviewEvents],
];
function adaptiveMarkdown(report: WeeklyReport): string[] {
  const adaptive = report.current.adaptive, previous = report.comparison.adaptive;
  if (!adaptive) return [];
  const ratings = [['again', '重学 Again'], ['hard', '困难 Hard'], ['good', '良好 Good'], ['easy', '轻松 Easy']] as const;
  const timing = [['new', '首次反馈'], ['due', '已到期'], ['early', '提前复习'], ['overdue', '逾期复习'], ['unknown', '计划未知']] as const;
  return ['## FSRS 自适应复习', '',
    `统计截止：${cell(report.current.range.asOf)}。反馈按原始发生时刻归属；更正判分或反馈不增加次数。`, '',
    `| 指标 | 本周 | ${cell(report.comparison.label)} |`, '| --- | ---: | ---: |',
    `| FSRS 反馈次数 | ${adaptive.feedbackEvents} | ${previous?.feedbackEvents ?? '—'} |`,
    `| 去重复习卡 | ${adaptive.uniqueCards} | ${previous?.uniqueCards ?? '—'} |`,
    `| 回忆成功次数 | ${adaptive.recallSuccesses} | ${previous?.recallSuccesses ?? '—'} |`,
    `| 回忆成功率 | ${analyticsPercent(adaptive.recallSuccessRate)} | ${analyticsPercent(previous?.recallSuccessRate ?? null)} |`,
    ...ratings.map(([key, label]) => `| ${label} | ${adaptive.ratings[key]} | ${previous?.ratings[key] ?? '—'} |`), '',
    '回忆成功率＝（Hard＋Good＋Easy）÷全部反馈；Again 计回忆失败。该指标与答题严格正确率分别统计。小题与词汇方向各自作为复习卡，重复复习分别计次。', '',
    '| 复习时机 | 反馈次数 | 回忆成功 | 回忆成功率 |', '| --- | ---: | ---: | ---: |',
    ...timing.map(([key, label]) => `| ${label} | ${adaptive.timing[key].feedbackEvents} | ${adaptive.timing[key].recallSuccesses} | ${analyticsPercent(adaptive.timing[key].recallSuccessRate)} |`), '',
    '时机按事件前的 FSRS 记忆计划判定：计划时刻前为提前，到期后同一统计时区日期为已到期，跨日期为逾期。首次反馈尚无 FSRS 复习周期；历史手工改期与旧固定计划未保留在事件记忆中，不据此推断准时率。', '',
    `本时段到期处理比例：${analyticsPercent(adaptive.dueProcessing.rate)}；已完成到期周期 ${adaptive.dueProcessing.completedDueCycles} 个。`, '',
    adaptive.queue
      ? `当前队列（${cell(adaptive.queue.asOf)}）：到期 ${adaptive.queue.due} 项，其中今日到期 ${adaptive.queue.today} 项、逾期 ${adaptive.queue.overdue} 项；短期重学 ${adaptive.queue.relearning} 项，暂停 ${adaptive.queue.suspended} 项。短期重学为已到期的学习／重学状态，可能同时属于逾期。`
      : '截止时刻队列：—；缺少可靠快照，未展示积压。', '',
    cell(adaptive.dueProcessing.reason), '',
  ];
}
export function weeklyReportMarkdown(report: WeeklyReport): string {
  const current = report.current, summary = current.summary, comparison = report.comparison;
  const asOfDay = analyticsDateKey(current.range.asOf, report.timeZone);
  const lines = [
    `# 学习周报 · ${report.weekStart} — ${report.weekEnd}`, '',
    `统计时区：${cell(report.timeZone)}。生成时间：${cell(report.generatedAt)}。`, '',
    report.isCurrentWeek ? `本周进行中；以${cell(comparison.label)}作为对比期。` : `对比口径：${cell(comparison.label)}。`, '',
    '## 学习概览', '', '| 指标 | 本周 |', '| --- | ---: |',
    ...metricRows(summary).map(([label, value]) => `| ${cell(label!)} | ${cell(value!)} |`), '',
    `## 与${cell(comparison.label)}对比`, '',
    `对比日期：${comparison.from} — ${comparison.to}。`, '',
    '| 指标 | 本周 | 对比期 | 变化 |', '| --- | ---: | ---: | ---: |',
    `| 实际作答次数 | ${summary.answers} | ${comparison.summary.answers} | ${comparison.deltas.answers > 0 ? '+' : ''}${comparison.deltas.answers} |`,
    `| 提交次数 | ${summary.sessions} | ${comparison.summary.sessions} | ${comparison.deltas.sessions > 0 ? '+' : ''}${comparison.deltas.sessions} |`,
    `| 活跃天数 | ${summary.activeDays} | ${comparison.summary.activeDays} | ${comparison.deltas.activeDays > 0 ? '+' : ''}${comparison.deltas.activeDays} |`,
    `| 已知作答计时 | ${analyticsMeasuredDuration(summary)} | ${analyticsMeasuredDuration(comparison.summary)} | ${summary.missingTimeSessions || comparison.summary.missingTimeSessions ? '计时记录不全' : `${comparison.deltas.elapsedSeconds >= 0 ? '+' : '-'}${analyticsDuration(Math.abs(comparison.deltas.elapsedSeconds))}`} |`,
    `| 严格正确率 | ${analyticsPercent(summary.accuracy)} | ${analyticsPercent(comparison.summary.accuracy)} | ${comparison.deltas.accuracyPoints == null ? '不可比较' : `${comparison.deltas.accuracyPoints > 0 ? '+' : ''}${analyticsNumber(comparison.deltas.accuracyPoints)}个百分点`} |`, '',
    ...adaptiveMarkdown(report),
    '## 每日学习', '', '| 日期 | 实际作答 | 去重作答项 | 正确 | 部分正确 | 错误 | 未判 | 复习 | 已知计时 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...current.daily.map(({ date, metrics: day }) => date > asOfDay ? `| ${date}（未到日期） | — | — | — | — | — | — | — | — |` : `| ${date} | ${day.answers} | ${day.uniqueItems} | ${day.correct} | ${day.partial} | ${day.incorrect} | ${day.ungraded} | ${day.reviewEvents} | ${analyticsMeasuredDuration(day)} |`), '',
  ];
  for (const [title, breakdown] of [['领域分布', current.domains], ['题型分布', current.types]] as const) {
    lines.push(`## ${title}`, '', '| 项目 | 实际作答 | 去重作答项 | 严格正确率 | 待判 |', '| --- | ---: | ---: | ---: | ---: |', ...breakdown.map(item => `| ${cell(item.label)} | ${item.answers} | ${item.uniqueItems} | ${analyticsPercent(item.accuracy)} | ${item.ungraded} |`), '');
  }
  lines.push('## 学习建议', '', ...current.recommendations.map(item => `- **${cell(item.title)}**：${cell(item.description)}`), '', '## 统计口径', '',
    '- 仅已提交的实际非空回答计入作答次数；草稿、漏答与旧数据无法确认的项不计入实际作答。组合题按小题统计。',
    '- 重复练习计入作答次数，去重作答项按原题及小题身份去重。领域可能有多重归属，领域数值不能直接相加。',
    '- 严格正确率 = 完全正确 ÷（完全正确 + 部分正确 + 错误）；未判定、漏答和未知项不进入分母。无已判题时不显示正确率。',
    '- 作答计时按提交日期归属，可能包含停留时间，不能等同专注学习时长；缺少的历史计时不补零。',
    '- 周报依据当前保留记录实时计算；后续判分会更新旧周报。清理卷面仍可保留学习摘要，主动重置学习进度会影响统计。',
    ...current.quality.warnings.map(warning => `- ${cell(warning)}`), '',
  );
  return lines.join('\n');
}
export async function downloadWeeklyReport(report: WeeklyReport): Promise<void> {
  const { saveGeneratedFile } = await import('@platform');
  await saveGeneratedFile(`认知星图-学习周报-${report.weekStart}.md`, new Blob([weeklyReportMarkdown(report)], { type: 'text/markdown;charset=utf-8' }), 'text/markdown');
}
