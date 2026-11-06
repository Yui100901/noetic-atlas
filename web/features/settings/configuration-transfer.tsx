import { useState } from 'react';
import { Download } from 'lucide-react';
import { ErrorNotice, useApp } from '../../shared/ui/components';
import { exportPackage } from '../../shared/lib/data-package';
import { DataPackageImport } from '../../shared/ui/data-package-import';
import './configuration-transfer.css';

export function ConfigurationTransfer() {
  const { toast } = useApp();
  const [includeAi, setIncludeAi] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const exportConfiguration = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await exportPackage({ kind: 'configuration', includeAi });
      toast('配置数据包已导出，不含API密钥');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ui-stack">
      <section className="card configuration-transfer ui-stack" aria-label="配置迁移">
        <div className="configuration-heading">
          <div>
            <h2>配置迁移</h2>
            <p className="muted">迁移偏好和默认规则，API密钥不会导出。</p>
          </div>
          <button className="button" disabled={busy} onClick={() => void exportConfiguration()}>
            <Download size={16} />
            {busy ? '正在准备…' : '导出配置数据包'}
          </button>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            disabled={busy}
            checked={includeAi}
            onChange={(event) => setIncludeAi(event.target.checked)}
          />
          导出时包含AI端点、模型和请求参数
        </label>
        <details className="help-disclosure">
          <summary>配置迁移规则</summary>
          <p className="muted">
            导入前展示配置差异，确认后覆盖偏好。降低保留上限时会列出待清理记录并要求单独确认。AI接口改变时清除目标设备旧密钥。
          </p>
        </details>
        {error && <ErrorNotice message={error} />}
      </section>
      <DataPackageImport purpose="configuration" title="导入配置数据包" description="选择配置 ZIP，核对差异后确认应用。" />
    </div>
  );
}
