import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, CalendarDays, Save } from 'lucide-react';
import { DEFAULT_SETTINGS, type SystemSettings } from '../../../shared/models/settings';
import type { DailyPushSettings } from '../../../shared/models/daily-push';
import { localDate, send, useResource } from '../../shared/lib/api';
import { ErrorNotice, Field, Loading, MultiSelect, useApp } from '../../shared/ui/components';
import { useDailyPush } from './daily-push';
import './daily-push.css';

export function DailyPushSettingsForm() {
  const resource = useResource<SystemSettings>('/api/settings'), { bootstrap, reload, toast } = useApp(), daily = useDailyPush();
  const [form, setForm] = useState<DailyPushSettings>(structuredClone(DEFAULT_SETTINGS.dailyPush)), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { if (resource.data) setForm(structuredClone(resource.data.dailyPush)); }, [resource.data]);
  const set = <K extends keyof DailyPushSettings>(key: K, value: DailyPushSettings[K]) => setForm(old => ({ ...old, [key]: value }));
  const categories = bootstrap.categories.filter(category => category.domainId === form.domainId), categoryMap = new Map(categories.map(category => [category.id, category]));
  const options = categories.map(category => {
    const names = [category.name], seen = new Set([category.id]); let parent = category.parentId;
    while (parent && !seen.has(parent)) { seen.add(parent); const item = categoryMap.get(parent); if (!item) break; names.unshift(item.name); parent = item.parentId; }
    return { id: category.id, name: names.join(' / ') };
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (form.enabled && (!form.domainId || !form.categoryIds.length)) { setError('开启每日推题前，请选择领域和至少一个分类。'); return; }
    if (form.enabled && (!Number.isFinite(form.reviewPoints) || !Number.isFinite(form.newPoints) || form.reviewPoints < 0 || form.newPoints < 0 || form.reviewPoints + form.newPoints < 50 || form.reviewPoints + form.newPoints > 10000)) { setError('复习与新题分值须为非负数，目标合计须在50至10000分之间。'); return; }
    setBusy(true);
    try {
      const result = await send<{ settings: SystemSettings }>('/api/settings', 'PUT', { settings: { ...resource.data!, dailyPush: form } });
      resource.setData(result.settings); reload(); await daily.refresh(true); toast('每日推题配置已保存');
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  if (resource.loading) return <Loading />; if (resource.error) return <ErrorNotice message={resource.error} retry={resource.refresh} />;
  return <form className="daily-settings-form ui-stack" onSubmit={submit}><div className="settings-footer"><span className="muted">最近保存 {localDate(resource.data?.updatedAt)}</span><div className="action-row"><a className="button" href="#/papers"><CalendarDays size={16} />查看题集</a><button className="button primary" disabled={busy} type="submit"><Save size={16} />{busy ? '正在保存…' : '保存推题配置'}</button></div></div>{error && <ErrorNotice message={error} retry={resource.refresh} />}<section className="card settings-section daily-settings-section"><div className="daily-settings-heading"><div><h2>每日推题</h2><p className="muted">固定一点练习量，复习旧知识，再接触新题。</p></div><label className="daily-settings-switch"><input type="checkbox" checked={form.enabled} onChange={event => set('enabled', event.target.checked)} />开启每日推题</label></div><div className="daily-settings-grid"><Field label="推题领域" hint="开启时必选一个领域。"><select required={form.enabled} value={form.domainId || ''} onChange={event => setForm(old => ({ ...old, domainId: event.target.value || null, categoryIds: [] }))}><option value="">选择学习领域</option>{bootstrap.domains.map(domain => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></Field><div className="daily-settings-summary"><span>每日目标</span><strong>{Number((form.reviewPoints + form.newPoints).toFixed(2))} <small>分以上</small></strong><p>按系统每题型默认分值计算，不要求精确凑整。</p></div></div><MultiSelect label="推题分类" options={options} values={form.categoryIds} onChange={value => set('categoryIds', value)} placeholder="查找分类，包含所选分类的下级分类" /><p className="muted">开启时至少选择一个分类；勾选父分类会包含其下级。更换领域会清空原分类选择。</p><div className="daily-settings-grid daily-settings-points"><Field label="复习题目标分值" hint="默认30分；优先已学、到期或答错的题。"><input required type="number" min="0" max="10000" step="0.01" value={form.reviewPoints} onChange={event => set('reviewPoints', Number(event.target.value))} /></Field><Field label="新题目标分值" hint="默认20分；从尚未作答或标记学习的题中选择。"><input required type="number" min="0" max="10000" step="0.01" value={form.newPoints} onChange={event => set('newPoints', Number(event.target.value))} /></Field></div><div className="notice info daily-settings-rule"><ArrowRight size={17} /><span>复习题不足时，缺少的分值补给新题。例如只有18分复习题，则新题至少32分。末题超额可以保留；题库不足时明确显示缺口。</span></div><details className="daily-settings-time"><summary>推题时间与时区</summary><div className="daily-settings-grid"><Field label="每日推题时间"><input required type="time" value={form.scheduleTime} onChange={event => set('scheduleTime', event.target.value)} /></Field><Field label="推题时区" hint="使用IANA时区名称；默认Asia/Shanghai。"><input required value={form.timeZone} onChange={event => set('timeZone', event.target.value)} placeholder="Asia/Shanghai" /></Field></div><p className="muted">默认每天零点。程序运行时定时生成；关闭程序后再次打开，会检查当天是否需要补发。</p></details><p className="muted">每天仅生成一份；修改范围和分值不会重写已生成题集。关闭只停止后续自动推题，已有题集、草稿与历史继续保留。</p></section></form>;
}
