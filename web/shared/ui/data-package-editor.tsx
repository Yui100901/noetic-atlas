import { useEffect, useRef, useState } from 'react';
import { Download, PackagePlus, Upload } from 'lucide-react';
import { saveGeneratedFile } from '@platform';
import { buildDataPackage, readDataPackage, DATA_PACKAGE_LIMITS, type OpenedDataPackage, type DataPackagePayload } from '../../../shared/packages/data-package';
import { ErrorNotice } from './components';

/** Local preparation only. JSON never goes to an import API directly: every
 * edit is rebuilt into a new verified package and then uses normal preview. */
export function DataPackageEditor({ kind, onPrepared }: { kind: 'question-template' | 'question-update'; onPrepared: (file: File) => void }) {
  const [source, setSource] = useState<OpenedDataPackage | null>(null);
  const [text, setText] = useState(''), [index, setIndex] = useState(0);
  const [parts, setParts] = useState<DataPackagePayload[]>([]), [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const commitText = () => {
    const parsed = JSON.parse(text);
    const expected = kind === 'question-template' ? 'learning-new-questions' : 'learning-pending-questions';
    if (!parsed || parsed.format !== expected || parsed.schemaVersion !== 1 || !Array.isArray(parsed.questions))
      throw new Error(`题目JSON应保留 ${expected} 的外层结构、版本与questions数组。`);
    const output = [...parts];
    output[index] = { ...(output[index] || { path: 'data/questions.json' }), data: parsed };
    return output;
  };
  const load = async (file?: File) => {
    if (!file || busy) return;
    const selected = ++generation.current;
    setBusy(true); setError('');
    try {
      if (file.size > DATA_PACKAGE_LIMITS.maxBytes) throw new Error('文件超过数据包容量上限。');
      let next: DataPackagePayload[];
      let packet: OpenedDataPackage | null = null;
      if (file.name.toLowerCase().endsWith('.zip')) {
        packet = await readDataPackage(new Uint8Array(await file.arrayBuffer()));
        if (packet.manifest.kind !== kind) throw new Error('这个包的用途与当前整理工具不一致，请选择对应的新题模板或待审修改包。');
        next = packet.payloads;
      } else {
        if (file.size > DATA_PACKAGE_LIMITS.maxFileBytes) throw new Error('单份JSON超过文件容量上限。');
        next = [{ path: 'data/questions.json', data: JSON.parse(await file.text()) }];
      }
      if (selected !== generation.current) return;
      setSource(packet); setParts(next); setIndex(0); setText(JSON.stringify(next[0].data, null, 2)); setFilename(file.name);
    } catch (reason) { if (selected === generation.current) setError((reason as Error).message); }
    finally { if (selected === generation.current) setBusy(false); }
  };
  const build = async (download: boolean) => {
    if (!text.trim() || busy) return;
    const selected = ++generation.current;
    setBusy(true); setError('');
    try {
      const payloads = commitText();
      const used = new Set(source?.manifest.payloads.map(part => part.path));
      const files = source?.manifest.files.filter(file => !used.has(file.path)).map(file => ({ path: file.path, bytes: source.files.get(file.path)!, mediaType: file.mediaType })) || [];
      const title = source?.manifest.title || (kind === 'question-template' ? '新增题目数据包' : '待审核题目修改包');
      const bytes = await buildDataPackage({ kind, title, payloads, files });
      if (selected !== generation.current) return;
      setParts(payloads);
      const name = `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100)}.zip`;
      if (download) await saveGeneratedFile(name, bytes, 'application/zip');
      else onPrepared(new File([new Uint8Array(bytes).buffer], name, { type: 'application/zip' }));
    } catch (reason) { if (selected === generation.current) setError((reason as Error).message); }
    finally { if (selected === generation.current) setBusy(false); }
  };
  const changePart = (next: number) => {
    try { const edited = commitText(); setParts(edited); setIndex(next); setText(JSON.stringify(edited[next].data, null, 2)); setError(''); }
    catch (reason) { setError((reason as Error).message); }
  };
  return <details className="card data-package-editor"><summary>整理JSON并生成数据包</summary><div className="form-stack">
    <p className="muted">读取原包可保留图片和分类参考，也可直接粘贴JSON。修改后生成数据包，系统会更新清单和摘要，再预览导入。</p>
    <label className="button image-file-picker"><Upload size={16}/>{filename || '选择原数据包或题目JSON'}<input type="file" aria-label="整理题目数据文件" accept=".zip,.json,application/zip,application/json" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void load(file); }}/></label>
    {parts.length > 1 && <label>选择编辑分片<select aria-label="编辑题目分片" disabled={busy} value={index} onChange={event => changePart(Number(event.target.value))}>{parts.map((part, i) => <option key={part.path} value={i}>{part.path}</option>)}</select></label>}
    <label>题目JSON<textarea aria-label="整理题目JSON" rows={12} value={text} disabled={busy} spellCheck={false} onChange={event => { setText(event.target.value); setError(''); }} placeholder={JSON.stringify({ format: kind === 'question-template' ? 'learning-new-questions' : 'learning-pending-questions', schemaVersion: 1, questions: [] }, null, 2)}/></label>
    {error && <ErrorNotice message={error}/>}<div className="action-row"><button className="button" disabled={busy || !text.trim()} onClick={() => void build(true)}><Download size={16}/>下载重新整理的数据包</button><button className="button primary" disabled={busy || !text.trim()} onClick={() => void build(false)}><PackagePlus size={16}/>{busy ? '正在生成数据包…' : '生成数据包并预览导入'}</button></div>
  </div></details>;
}
