import { THEME_LABELS, type Theme } from '../../../shared/models/settings';
import { typeLabels, type QuestionType } from '../../../shared/models/types';
export const configurationLabels: Record<string, string> = {
  theme:'外观主题',
  maxDraftsPerPaper:'每卷草稿上限', maxQuickDrafts:'随机自测草稿上限', maxPaperDrafts:'组题草稿上限', maxDocumentDrafts:'资料编辑草稿上限', maxQuestionDrafts:'题目编辑草稿上限', maxQuestionRevisions:'题目修订版本上限',
  examDurationMinutes:'默认考试时长（分钟）', maxHistoryPerPaper:'每卷历史上限', maxQuickHistory:'随机自测历史上限', maxQuestionHistory:'每题完整作答历史上限',
  randomQuestionCount:'默认随机题量', scoringEnabledByDefault:'默认计分', randomTotalPoints:'默认总分',
  objectivePercent:'客观题比例（%）', pointsByType:'题型分值', reviewIntervalsDays:'复习间隔（天）',
  autosaveDebounceMs:'自动保存等待（毫秒）', maxDocumentMiB:'资料上限（MiB）', maxImageMiB:'图片上限（MiB）',
  enabled:'启用AI', baseUrl:'AI接口地址', model:'模型', supportsImages:'模型支持图片', sendImages:'发送图片',
  timeoutSeconds:'请求超时（秒）', maxTokens:'最大输出Token数',
};
export function displayConfigurationValue(value: unknown, key?: string): string {
  if (key === 'theme' && typeof value === 'string' && Object.hasOwn(THEME_LABELS, value)) return THEME_LABELS[value as Theme];
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (value === '') return '未设置';
  if (Array.isArray(value)) return value.map(item => displayConfigurationValue(item)).join('、');
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${typeLabels[key as QuestionType] || key} ${displayConfigurationValue(item)}`).join('；');
  return String(value ?? '无');
}
