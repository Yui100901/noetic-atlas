import { useEffect, useState } from 'react';
import { Download, Share2, Upload } from 'lucide-react';
import type { ShareSelection } from '../../../shared/models/sharing';
import type { ExportDocument } from '../../../shared/models/export-types';
import { send } from '../../shared/lib/api';
import { ErrorNotice, Modal, PageHeader, useApp } from '../../shared/ui/components';
import { downloadExport } from '../../shared/export/export-download';
import { isNativeApp } from '@platform';
import { exportPackage } from '../../shared/lib/data-package';
import { DataPackageImport } from '../../shared/ui/data-package-import';
import './sharing.css';

export function ShareButton({kind,id,ids,filters,label='分享',open:controlledOpen,onOpenChange,hideTrigger=false}:ShareSelection & {label?:string;open?:boolean;onOpenChange?:(open:boolean)=>void;hideTrigger?:boolean}) {
  const [internalOpen,setInternalOpen]=useState(false); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const {toast}=useApp();
  const open=controlledOpen??internalOpen;
  const setOpen=(value:boolean)=>{setInternalOpen(value);onOpenChange?.(value);};
  useEffect(()=>{if(open)setError('');},[open]);
  const exportFile=async(format:'zip'|'pdf')=>{setBusy(true);setError('');try{const selection={kind,...(id?{id}:{}),...(ids?.length?{ids}:{}),...(filters?{filters}: {})}; if(format === 'zip'){ await exportPackage({kind:'share',selection}); }else{ const document=await send<ExportDocument>('/api/sharing/export-document','POST',selection); await downloadExport(document,'pdf'); } toast(isNativeApp()?'文件已准备，可在系统分享面板选择QQ、微信等应用':'分享文件已下载'); }catch(reason){setError((reason as Error).message);}finally{setBusy(false);}};
  return <>{!hideTrigger&&<button className="button" onClick={()=>{setError('');setOpen(true);}}><Share2 size={15}/>{label}</button>}{open&&<Modal title="分享内容" onClose={()=>{if(!busy)setOpen(false);}}><p className="muted">ZIP数据包包含题目、领域、祖先分类、标签、独立图片与manifest清单，可直接导入另一套认知星图。PDF含答案与解析，适合发送给朋友。</p>{error&&<ErrorNotice message={error}/>}<div className="share-export-actions"><button className="button primary" disabled={busy} onClick={()=>void exportFile('zip')}><Download size={16}/>{busy?'正在准备…':'导出完整分享数据包（ZIP）'}</button><button className="button" disabled={busy} onClick={()=>void exportFile('pdf')}><Download size={16}/>导出分享PDF</button></div><div className="notice info">分享不包含学习笔记、练习记录、草稿、系统配置或AI密钥。题目本身如含个人项目或私密信息，请先检查再分享。Android可通过系统文件分享选择QQ或微信。</div><a className="button feature-entry" href="#/sharing" onClick={()=>setOpen(false)}><Upload size={16} />导入朋友的分享包</a></Modal>}</>;
}

export function SharingPage() {
  return <><PageHeader eyebrow="SHARE & LEARN" title="把知识连同组织方式一起分享。" description="直接导入完整ZIP数据包，清单描述用途、领域、分片与附件；新增分享题目仍需审核。" actions={<a className="button" href="#/questions/review">查看待审核题目</a>} />
    <div className="ui-stack"><DataPackageImport title="导入分享或迁移数据包" />
    <section className="card ui-stack"><h2>一个包，完整带走。</h2><p>从单题、筛选列表、题集或领域导出均得到ZIP数据包。导入时读取manifest，整包校验后一次确认，无需解压或逐个JSON导入。</p><p>题目、分类、标签与图片一起保留。PDF用于阅读分享；题目和题集再次导入请使用数据包。完整数据库恢复请前往系统配置的数据与迁移。</p></section></div></>;
}
