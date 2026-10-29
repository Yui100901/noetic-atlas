import { PageHeader,useApp } from '../../shared/ui/components';
import { AiPaperPlanner } from './ai-paper-plan';
import { AiImportWorkspace } from './ai-import-workspace';
import { AiRunHistory } from './ai-run-history';
import { AiDocumentWorkspace } from './ai-document-workspace';
import './ai.css';
import './ai-import-layout.css';
import {AiWorkspaceDraftSession,useAiDraftSession} from './ai-workspace-draft-context';

export function AiWorkspacePage({ initialTab = 'paper' }: { initialTab?: string }) {
  return <AiWorkspaceDraftSession><AiWorkspaceContent initialTab={initialTab}/></AiWorkspaceDraftSession>;
}
function AiWorkspaceContent({ initialTab = 'paper' }: { initialTab?: string }) {
  const session=useAiDraftSession()!;
  const location=(next:string)=>{window.location.hash='#/ai'+(next==='paper'?'':'?tab='+next);};
  const switchTab=(next:'paper'|'import'|'history')=>void session.transition(()=>{location(next==='import'&&importMode==='documents'?'documents':next);});
  const switchMode=(next:'single'|'documents')=>void session.transition(()=>{location(next==='documents'?'documents':'import');});
  const {bootstrap}=useApp();
  const tab = initialTab === 'documents' ? 'import' : initialTab === 'import' || initialTab === 'history' ? initialTab : 'paper';
  const importMode = initialTab === 'documents' ? 'documents' : 'single';
  return <div className={tab==='import'?'ai-workspace-import':'ai-workspace-page'}><PageHeader eyebrow="AI LEARNING ASSISTANT" title={tab==='import'?'把资料，整理成练习。':'先理解，再整理；由你确认成果。'} description={tab==='import'?'上传文件或粘贴正文，核对生成的题目后再导入。':'AI补充解析、评价主观回答、推荐组题、转换题库文件和审核题目，统一保留可复查的处理记录。'} actions={tab==='history'&&!bootstrap.ai.available?<a className="button" href="#/settings?tab=ai">AI服务配置</a>:undefined} />
    {tab!=='import'&&<div className="notice info"><span>题目详情可生成AI解析或评价回答；已提交的题集支持逐题或批量AI评价；待审核页支持AI审核。</span></div>}
    <nav className="section-tabs ai-section-tabs"><button className={tab === 'paper' ? 'selected' : ''} onClick={() => switchTab('paper')}>AI推荐组题</button><button className={tab === 'import' ? 'selected' : ''} onClick={() => switchTab('import')}>文件 / 文本辅助导入</button><button className={tab === 'history' ? 'selected' : ''} onClick={() => switchTab('history')}>AI处理记录</button></nav>
    {tab === 'paper' ? <AiPaperPlanner /> : tab === 'import' ? <><nav className="section-tabs ai-import-mode-switch" aria-label="资料处理方式"><button className={importMode === 'single' ? 'selected' : ''} onClick={() => switchMode('single')}>单次题目整理 / 出题</button><button className={importMode === 'documents' ? 'selected' : ''} onClick={() => switchMode('documents')}>多文件 / 教材分批</button></nav>{importMode === 'single' ? <AiImportWorkspace /> : <AiDocumentWorkspace />}</> : <AiRunHistory />}
  </div>;
}
