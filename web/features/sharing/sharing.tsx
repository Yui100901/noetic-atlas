import { useEffect, useState, lazy, Suspense } from 'react';
import { Download, Share2, Upload } from 'lucide-react';
import type { ShareSelection } from '../../../shared/models/sharing';
import type { ExportDocument } from '../../../shared/models/export-types';
import { send } from '../../shared/lib/api';
import { ErrorNotice, Modal, PageHeader, Loading, useApp } from '../../shared/ui/components';
import { downloadExport } from '../../shared/export/export-download';
import { isNativeApp } from '@platform';
import { exportPackage } from '../../shared/lib/data-package';
import { DataPackageImport } from '../../shared/ui/data-package-import';
import './sharing.css';
import { useExportPreflight } from '../../shared/export/export-preflight';
import { AiWorkspaceDraftSession, useAiDraftSession } from '../ai/ai-workspace-draft-context';
const AiImportPanel = lazy(() => import('../ai/ai-import-panel').then(module => ({default:module.AiImportPanel})));
const QuestionImportPage = lazy(() => import('../questions/question-import').then(module => ({default:module.QuestionImportPage})));

const DomainExport = lazy(() => import('../settings/domain-export').then(module => ({default:module.DomainExport})));
const importTabs = [
  {id:'package',label:'数据包导入'},
  {id:'export',label:'按领域分享'},
  {id:'template',label:'模板与批量新增'},
  {id:'import',label:'AI整理题目'},
  {id:'documents',label:'教材分批出题'},
] as const;

export function ShareButton({kind,id,ids,filters,label='分享',open:controlledOpen,onOpenChange,hideTrigger=false}:ShareSelection & {label?:string;open?:boolean;onOpenChange?:(open:boolean)=>void;hideTrigger?:boolean}) {
  const [internalOpen,setInternalOpen]=useState(false); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const {toast}=useApp();
  const open=controlledOpen??internalOpen;
  const setOpen=(value:boolean)=>{setInternalOpen(value);onOpenChange?.(value);};
  useEffect(()=>{if(open)setError('');},[open]);
  const selection: ShareSelection = {kind,...(id?{id}:{}),...(ids?.length?{ids}:{}),...(filters?{filters}:{})};
  const preflight=useExportPreflight(open?{kind:'share',selection}:null);
  const exportFile=async(format:'zip'|'pdf')=>{if(!preflight.allowed)return;setBusy(true);setError('');try{ if(format === 'zip'){ await exportPackage({kind:'share',selection}); }else{ const document=await send<ExportDocument>('/api/sharing/export-document','POST',selection); await downloadExport(document,'pdf'); } toast(isNativeApp()?'文件已准备，可在系统分享面板选择QQ、微信等应用':'分享文件已下载'); }catch(reason){setError((reason as Error).message);}finally{setBusy(false);}};
  return <>{!hideTrigger&&<button className="button" onClick={()=>{setError('');setOpen(true);}}><Share2 size={15}/>{label}</button>}{open&&<Modal title="分享内容" onClose={()=>{if(!busy)setOpen(false);}}><p className="muted">ZIP数据包包含题目、领域、祖先分类、标签、独立图片与manifest清单，可直接导入另一套认知星图。PDF含答案与解析，适合发送给朋友。</p>{preflight.view}{error&&<ErrorNotice message={error}/>}<div className="share-export-actions"><button className="button primary" disabled={busy||!preflight.allowed} onClick={()=>void exportFile('zip')}><Download size={16}/>{busy?'正在准备…':'导出完整分享数据包（ZIP）'}</button><button className="button" disabled={busy||!preflight.allowed} onClick={()=>void exportFile('pdf')}><Download size={16}/>导出分享PDF</button></div><div className="notice info">分享不包含学习笔记、练习记录、草稿、系统配置或AI密钥。题目本身如含个人项目或私密信息，请先检查再分享。Android可通过系统文件分享选择QQ或微信。</div><a className="button feature-entry" href="#/sharing" onClick={()=>setOpen(false)}><Upload size={16} />导入朋友的分享包</a></Modal>}</>;
}

export function SharingPage({initialTab = 'package'}: {initialTab?:string}) {
  return <AiWorkspaceDraftSession><SharingContent initialTab={initialTab} /></AiWorkspaceDraftSession>;
}
function SharingContent({initialTab}: {initialTab:string}) {
  const session = useAiDraftSession()!;
  const tab = importTabs.some(item => item.id === initialTab) ? initialTab : 'package';
  const select = (next:string) => void session.transition(() => { window.location.hash = '#/sharing' + (next === 'package' ? '' : '?tab=' + next); });
  return <div className={tab === 'import' || tab === 'documents' ? 'ai-workspace-import' : undefined}>
    <PageHeader eyebrow="SHARE & IMPORT" title="接收内容，整理成自己的知识。" description="数据包直接导入；原始文件可用 AI 整理或按教材分批出题，核对后再入库。" actions={<a className="button" href="#/questions/review">查看待审核题目</a>} />
    <nav className="section-tabs sharing-import-tabs" aria-label="内容导入方式">{importTabs.map(item => <button type="button" key={item.id} className={tab === item.id ? 'selected' : ''} aria-current={tab === item.id ? 'page' : undefined} onClick={() => select(item.id)}>{item.label}</button>)}</nav>
    {tab === 'package' ? <div className="ui-stack"><DataPackageImport purpose="content" title="导入内容数据包" /><details className="card help-disclosure"><summary>选择哪种导入方式？</summary><p>已有认知星图 ZIP：在此整包校验、查重并确认。未经整理的题目文件或教材：切到 AI 整理或教材分批。自己编写的批量题目：使用模板与批量新增。</p><p>新增内容仍需审核；可信备份合并保留原状态。SQLite整体或领域迁移与完整恢复位于系统配置。内容分享不包含学习记录。</p><a className="button" href="#/settings?tab=backup">SQLite 迁移与恢复</a></details></div> : <Suspense fallback={<Loading text="正在加载内容整理工具…" />}>{tab === 'export' ? <DomainExport /> : tab === 'template' ? <QuestionImportPage embedded /> : <AiImportPanel key={tab} mode={tab as 'import'|'documents'} />}</Suspense>}
  </div>;
}
