import { ExamNavigationGuard } from '../features/practice/exam-guard';
import { isNativeApp } from '@platform';
import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, BarChart3, BookOpen, CalendarCheck2, CalendarDays, ChevronRight, CircleHelp, Settings2, ClipboardList, Command, Database, Files, FolderTree, GraduationCap, LayoutDashboard, LibraryBig, Menu, Plus, Sparkles, X } from 'lucide-react';
import type { Bootstrap } from '../../shared/models/types';
import { typeLabels } from '../../shared/models/types';
import { navigate, useResource } from '../shared/lib/api';
import { AppContext, Empty, ErrorNotice, Loading, PageHeader, useApp } from '../shared/ui/components';
import { QuestionDetail, QuestionEditor, QuestionsPage } from '../features/questions/questions';
import { PaperDetailPage, PapersPage } from '../features/papers/papers';
import { PaperQuestionPage } from '../features/papers/paper-question';
import { readPaperContentsContext } from '../features/papers/reader-navigation';
import { allowHashNavigation, markNavigationEntry, replaceHashRoute } from '../shared/lib/navigation-guard';
import { PaperEditor } from '../features/papers/paper-editor';
import { AttemptPage } from '../features/practice/attempt';
import { TaxonomyPage } from '../features/taxonomy/taxonomy';
import { QuickPracticePage } from '../features/practice/quick-practice';
import { QuestionReviewPage } from '../features/questions/question-review';
import { QuestionImportPage } from '../features/questions/question-import';
import { DocumentDetailPage, DocumentEditor, DocumentsPage } from '../features/library/documents';
import { DeletedSetActivityPage } from '../features/practice/context-learning';
import { LearningQuestionPage } from '../features/practice/learning-question-page';
import { GlobalLearningPage } from '../features/practice/global-learning';
import { AiWorkspacePage as AiPage } from '../features/ai/ai-workspace';
import { SettingsPage } from '../features/settings/settings';
import { VocabularyReferencePage } from '../features/questions/vocabulary';
import { QuestionFeedbackPage } from '../features/quality-feedback/question-feedback';
import { ContentQualityPage } from '../features/content-quality/content-quality';
import { SharingPage } from '../features/sharing/sharing';
import { DailyPushProvider, DailyPushQuickLink } from '../features/daily-push/daily-push';
import { AnalyticsPage } from '../features/analytics/analytics';
import { SearchReturnLink, UnifiedSearchBar, UnifiedSearchPage } from '../features/search/search';
import './styles.css';
import '../shared/ui/layout.css';
import './navigation.css';
import '../shared/ui/feature-entry.css';
import { applyTheme, initializeTheme } from '../shared/theme/theme';
import '../shared/theme/themes.css';

initializeTheme();

function Dashboard() {
  const { bootstrap } = useApp(); const stats = bootstrap.stats;
  const due = stats.dueCount; const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Shanghai' }).format(new Date());
  return <><PageHeader eyebrow={date} title="保持好奇，让知识慢慢生长。" description="从一个问题开始，把今天的理解，留给未来的自己。" actions={<><a className="button feature-entry" href="#/analytics"><BarChart3 size={16} />学习统计</a><a className="button feature-entry" href="#/analytics?tab=weekly"><CalendarDays size={16} />本周周报</a><a className="button primary" href="#/papers"><Plus size={17} />打开我的题集</a></>} /><div className="dashboard-stats"><a href="#/questions" className="stat-card"><span className="stat-icon"><LibraryBig size={21} /></span><span>知识题目</span><strong>{stats.totalQuestions.toLocaleString()}<small>题</small></strong><p>通用 {stats.generalQuestions} <span className="dot">·</span> 个人专项 {stats.personalQuestions}</p></a><a href="#/papers" className="stat-card"><span className="stat-icon orange"><ClipboardList size={21} /></span><span>我的题集</span><strong>{stats.totalPapers}<small>份</small></strong><p>手动选题、标签随机与历史复盘</p></a><a href="#/questions?due=true" className="stat-card"><span className="stat-icon purple"><CalendarCheck2 size={21} /></span><span>待复习</span><strong>{stats.dueCount}<small>题</small></strong><p>{due ? '把到期的知识，再回顾一遍' : '按掌握程度，安排下次复习'}</p></a><a href="#/documents" className="stat-card"><span className="stat-icon blue"><Files size={21} /></span><span>学习资料</span><strong>{stats.totalDocuments}<small>份</small></strong><p>阅读材料、学习路线与知识笔记</p></a></div><div className="dashboard-middle"><section className="card learning-next"><div className="section-label"><span className="live-dot" />今日学习建议</div><h2>{due ? `有 ${due} 道知识点，等你再次巩固。` : '从熟悉的领域，走深一点。'}</h2><p>{due ? '先回顾到期知识，再开始新的练习。用自己的话讲清楚，比记住标准答案更重要。' : '挑选一个想掌握的知识点，独立回答，再核对原理、边界和常见误区。'}</p><div><a className="button primary" href={due ? '#/questions?due=true' : '#/questions'}>{due ? '开始到期复习' : '浏览知识题库'}<ArrowRight size={16} /></a><a className="button feature-entry" href="#/papers/new/random"><Sparkles size={16} />按标签生成题集</a><a className="button feature-entry" href="#/ai?tab=paper"><Sparkles size={16} />AI 推荐题集</a><DailyPushQuickLink /></div><span className="learning-decoration" aria-hidden="true"><BookOpen size={108} strokeWidth={0.8} /></span></section><section className="card distribution-card"><div className="card-heading"><h2>知识的不同练法</h2><span className="muted">题型分布</span></div><div className="distribution-bars">{Object.entries(typeLabels).map(([type, label]) => { const value = stats.typeCounts[type] || 0; return <div key={type}><span>{label}</span><div className="distribution-track"><i style={{ width: `${stats.totalQuestions ? Math.max(2, value / stats.totalQuestions * 100) : 0}%` }} /></div><strong>{value}</strong></div>; })}</div><p className="muted">先理解，再判断，最后用场景验证。</p></section></div><section className="dashboard-domains"><div className="section-heading"><div><h2>沿着知识的脉络探索</h2><p>领域组织知识，标签连接不同方向。</p></div><a className="button feature-entry" href="#/taxonomy"><FolderTree size={16} />管理领域与分类</a></div><div className="domain-grid">{bootstrap.domains.map((domain, index) => { const categories = bootstrap.categories.filter(category => category.domainId === domain.id && category.parentId === null); return <a className="domain-card" key={domain.id} href={`#/questions?domainId=${encodeURIComponent(domain.id)}`}><span className={`domain-card-icon tone-${index % 5}`}><GraduationCap size={20} /></span><div><h3>{domain.name}</h3><p>{categories.slice(0, 3).map(category => category.name).join(' · ') || domain.description || '新的知识正在生长'}</p><span className="domain-card-counts">{bootstrap.categories.filter(category => category.domainId === domain.id).length} 个分类 · {(stats.domainQuestionCounts?.[domain.id]?.published ?? 0).toLocaleString()} 题{(stats.domainQuestionCounts?.[domain.id]?.pending ?? 0) > 0 && <> · {stats.domainQuestionCounts![domain.id].pending.toLocaleString()} 题待审</>} <ChevronRight size={12} /></span></div></a>; })}<a className="domain-card add-domain-card" href="#/taxonomy"><span className="domain-card-icon"><Plus size={21} /></span><div><h3>新的学习领域</h3><p>不止计算机，任何知识都可以安放。</p><span>添加领域 <ChevronRight size={12} /></span></div></a></div></section><div className="dashboard-bottom"><section className="card local-first"><div className="data-icon"><Database size={23} /></div><h2>你的积累，有自己的位置。</h2><p>所有题目、笔记与学习记录保存在本地 SQLite。定期备份，把知识带到下一台电脑。</p><a className="button feature-entry" href="#/settings?tab=backup"><Database size={16} />管理数据与备份</a><div className="local-first-footer"><span className="live-dot" />本地优先 <span className="dot">·</span> 自定义领域 <span className="dot">·</span> 开放迁移</div></section></div></>;
}

const nav = [{ key: 'overview', label: '知识总览', icon: LayoutDashboard, path: '#/' }, { key: 'questions', label: '知识题库', icon: LibraryBig, path: '#/questions' }, { key: 'papers', label: '题集与练习', icon: ClipboardList, path: '#/papers' }, { key: 'analytics', label: '学习统计', icon: BarChart3, path: '#/analytics' }, { key: 'documents', label: '资料库', icon: Files, path: '#/documents' }, { key: 'taxonomy', label: '分类与标签', icon: FolderTree, path: '#/taxonomy' }, { key: 'ai', label: 'AI工作台', icon: Sparkles, path: '#/ai' }, { key: 'sharing', label: '分享与导入', icon: ArrowRight, path: '#/sharing' }];
function useHash() { const [hash, setHash] = useState(window.location.hash || '#/'); const index = useRef(0); useEffect(() => { index.current = markNavigationEntry(0); const listener = (event: HashChangeEvent) => { if (!allowHashNavigation(event)) return; index.current = markNavigationEntry(index.current + 1); setHash(window.location.hash || '#/'); window.scrollTo({ top: 0 }); }; window.addEventListener('hashchange', listener); return () => window.removeEventListener('hashchange', listener); }, []); return hash; }
function LegacyBankRedirect() {
  useEffect(() => { replaceHashRoute('#/papers'); }, []);
  return <Loading text="正在打开题集…" />;
}
function LegacyStudyRedirect({ tab }: { tab: string }) {
  useEffect(() => { replaceHashRoute(['due','favorite','wrong'].includes(tab) ? `#/questions?${tab}=true` : '#/papers'); }, [tab]);
  return <Loading text="正在打开学习内容…" />;
}
function Router({ hash }: { hash: string }) {
  const [pathname, query] = hash.replace(/^#\/?/, '').split('?'); const [section, rawId, action] = pathname.split('/'); let id = ''; try { id = decodeURIComponent(rawId || ''); } catch { return <Empty title="链接格式不正确" actions={<a href="#/">返回总览</a>} />; }
  const params = new URLSearchParams(query); const key = hash;
  if (!section) return <Dashboard />;
  if (section === 'question-feedback') return <QuestionFeedbackPage key={key} questionId={params.get('questionId') || ''} feedbackId={params.get('feedbackId') || ''} />;
  if (section === 'content-quality') return <ContentQualityPage key={key} questionId={params.get('questionId')||''} feedbackId={params.get('feedbackId')||''} issueId={params.get('issueId')||''} />;
  if (section === 'search') return <UnifiedSearchPage key={key} hash={hash} />;
  if(section==='vocabulary'&&id)return <VocabularyReferencePage key={key} word={id}/>;
  if (section === 'questions') { if (id === 'import') return <QuestionImportPage key={key} />; if (id === 'review') return <QuestionReviewPage key={key} />; if (id === 'new') return <QuestionEditor key={key} />; if (id && action === 'edit') return <QuestionEditor key={key} id={id} />; if (id) return <QuestionDetail key={key} id={id} showAnswer={params.get('answer') === '1'} />; return <QuestionsPage key={key} initial={{...Object.fromEntries(['search', 'domainId', 'categoryId', 'frequency', 'collection', 'status'].map(name => [name, params.get(name) || ''])),...Object.fromEntries(['due','favorite','wrong'].map(name=>[name,['true','1'].includes(params.get(name)||'')])),tagIds:(params.get('tagIds')||'').split(',').filter(Boolean),tagMode:params.get('tagMode')==='any'?'any':'all'}} />; }
  if (section === 'banks') return <LegacyBankRedirect />;
  if (section === 'analytics') return <AnalyticsPage key={key} initialTab={params.get('tab') || 'analysis'} />;
  if (section === 'papers') { if (id === 'new') return <PaperEditor key={key} mode={action === 'random' ? 'random' : 'manual'} />; if (id && action === 'questions') { let questionId = ''; try { questionId = decodeURIComponent(pathname.split('/')[3] || ''); } catch { return <Empty title="题目链接格式不正确" actions={<a href={`#/papers/${encodeURIComponent(id)}`}>返回题集</a>} />; } return questionId && pathname.split('/').length === 4 ? <PaperQuestionPage key={key} paperId={id} questionId={questionId} context={readPaperContentsContext(params)} /> : <Empty title="请从题集中选择题目" actions={<a href={`#/papers/${encodeURIComponent(id)}`}>返回题集</a>} />; } if (id && action === 'activity') return <DeletedSetActivityPage key={key} paperId={id} initialTab={params.get('tab') || 'history'} />; if (id && action === 'edit') return <PaperEditor key={key} id={id} />; if (id) return <PaperDetailPage key={key} id={id} initialTab={params.get('tab') || 'content'} initialContents={readPaperContentsContext(params)} />; return <PapersPage />; }
  if (section === 'learning-reader') return <LearningQuestionPage key={key} params={params}/>;
  if (section === 'learning' && (id === 'wrong' || id === 'favorite' || id === 'due')) return <GlobalLearningPage key={key} kind={id} />;
  if (section === 'quick') return <QuickPracticePage key={key} initialTab={params.get('tab') || undefined} />;
  if (section === 'attempts' && id) return <AttemptPage key={key} id={id} />;
  if (section === 'documents') { if (id === 'new') return <DocumentEditor key={key} />; if (id && action === 'edit') return <DocumentEditor key={key} id={id} />; if (id) return <DocumentDetailPage key={key} id={id} />; return <DocumentsPage />; }
  if (section === 'study') return <LegacyStudyRedirect tab={params.get('tab') || 'due'} />;
  if (section === 'taxonomy') return <TaxonomyPage />;
  if (section === 'daily-push') return <LegacyBankRedirect />;
  if (section === 'settings' || section === 'data') return <SettingsPage key={key} initialTab={section === 'data' || params.get('tab') === 'backup' ? 'backup' : params.get('tab') === 'assets' ? 'assets' : params.get('tab') === 'ai' ? 'ai' : params.get('tab') === 'daily' ? 'daily' : 'practice'} />;
  if (section === 'sharing') return <SharingPage key={key} />;
  if (section === 'ai') return <AiPage key={key} initialTab={params.get('tab') || 'paper'} />;
  return <Empty title="还没有这个页面" description="从知识总览继续探索。" actions={<a className="button primary" href="#/">返回总览</a>} />;
}
class ErrorBoundary extends React.Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <div className="fatal-error"><ErrorNotice message={`页面遇到异常：${this.state.error}`} /><button className="button" onClick={() => window.location.reload()}>重新加载</button></div> : this.props.children; }
}
function App() {
  const bootstrap = useResource<Bootstrap>('/api/bootstrap'); const hash = useHash(); const [mobile, setMobile] = useState(false); const [notification, setNotification] = useState<{ message: string; error?: boolean } | null>(null);
  useEffect(() => { if (bootstrap.data?.settings) applyTheme(bootstrap.data.settings.theme, { persist: true }); }, [bootstrap.data?.settings?.theme]);
  const section = hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'overview'; const current = nav.find(item => item.key === section || section === 'attempts' && item.key === 'papers' || section === 'quick' && item.key === 'papers' || ['learning','learning-reader'].includes(section) && item.key === 'papers' || section === 'vocabulary' && item.key === 'questions' || ['question-feedback', 'content-quality'].includes(section) && item.key === 'questions');
  const pageLabel = section === 'learning-reader' ? '题集题目详情' : ['content-quality','question-feedback'].includes(section) ? '质量管理' : current?.label || (section === 'search' ? '统一搜索' : (section === 'data' || section === 'settings') ? '系统配置' : '认知星图');
  useEffect(() => { setMobile(false); document.title = `${pageLabel} · 认知星图`; }, [hash]);
  useEffect(() => { if (!notification) return; const timer = setTimeout(() => setNotification(null), 5000); return () => clearTimeout(timer); }, [notification]);
  if (bootstrap.loading && !bootstrap.data) return <ExamNavigationGuard><div className="app-startup"><div className="brand-mark"><Command size={28} /></div><h1>认知星图</h1><Loading text="正在打开你的学习工作台…" /></div></ExamNavigationGuard>;
  if (!bootstrap.data) return <ExamNavigationGuard><div className="app-startup"><h1>认知星图</h1><ErrorNotice message={bootstrap.error || (isNativeApp() ? '无法打开本地学习数据' : '无法连接本地服务')} retry={bootstrap.refresh} /><p className="muted">{isNativeApp() ? '请确认设备存储可用，然后重试。已有学习记录不会被自动清除。' : '请确认本地服务已启动。'}</p></div></ExamNavigationGuard>;
  return <ExamNavigationGuard><AppContext.Provider value={{ bootstrap: bootstrap.data, reload: bootstrap.refresh, toast: (message, error) => setNotification({ message, error }) }}><DailyPushProvider><div className={`app-shell ${mobile ? 'menu-open' : ''}`}><a href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>跳到主内容</a>{mobile && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setMobile(false)} />}<aside className="sidebar"><a className="brand" href="#/" aria-label="认知星图，返回知识总览"><span className="brand-mark"><Command size={24} /></span><span><strong>认知星图</strong><small>NOETIC ATLAS</small></span></a><div className="workspace-label">个人学习空间 <span>LOCAL</span></div><nav aria-label="主导航">{nav.map(({ key, label, icon: Icon, path }) => <a key={key} href={path} className={current?.key === key ? 'active' : ''} aria-current={current?.key === key ? 'page' : undefined}><Icon size={19} /><span>{label}</span>{key === 'questions' && <small>{bootstrap.data!.stats.totalQuestions}</small>}</a>)}</nav><div className="sidebar-note"><span className="sidebar-note-icon"><BookOpen size={20} /></span><p>知识需要连接，<br />理解需要练习。</p><a className="button feature-entry" href="#/papers/new/random">开始新的练习 <ArrowRight size={16} /></a></div><div className="sidebar-bottom"><a href="#/settings" className={section === 'data' || section === 'settings' ? 'active' : ''}><Settings2 size={18} />系统配置</a><div className="local-status"><span className="live-dot" /><span>本地工作台</span><small>v1.0</small></div><div className="profile"><span>我</span><div><strong>我的学习空间</strong><small>循序渐进，日有所得</small></div></div></div></aside><div className="main-shell"><div className="topbar"><button className="icon-button mobile-menu" onClick={() => setMobile(!mobile)} aria-label={mobile ? '关闭菜单' : '打开菜单'}>{mobile ? <X size={21} /> : <Menu size={21} />}</button><div className="breadcrumb"><span>个人学习空间</span><ChevronRight size={13} /><strong>{pageLabel}</strong></div><UnifiedSearchBar hash={hash} /><a className="help-button" href="#/documents" aria-label="查看学习资料"><CircleHelp size={19} /></a><span className="top-avatar" aria-label="个人空间">我</span></div><main id="main-content" tabIndex={-1} key={hash}><ErrorBoundary key={hash}><SearchReturnLink hash={hash} /><Router hash={hash} /></ErrorBoundary><footer className="page-footer"><span>认知星图 · 让每一次理解，都有所积累。</span><span>本地存储 <span className="dot">·</span> 数据归你</span></footer></main></div>{notification && <div className={`toast ${notification.error ? 'toast-error' : ''}`} role={notification.error ? 'alert' : 'status'}><span>{notification.message}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotification(null)}><X size={16} /></button></div>}</div></DailyPushProvider></AppContext.Provider></ExamNavigationGuard>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
