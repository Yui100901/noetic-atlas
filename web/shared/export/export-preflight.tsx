import type {
  DataPackageExportInput,
  ExportPreflight,
} from '../../../shared/models/export-preflight';
import { useEffect, useRef, useState } from 'react';
import { request } from '../lib/api';
import { ErrorNotice, Loading } from '../ui/components';
import './export-preflight.css';

const bytes = (value: number) =>
  value < 1024 * 1024
    ? `${Math.ceil(value / 1024)} KiB`
    : `${(value / 1024 / 1024).toFixed(1)} MiB`;
export function ExportPreflightNotice({ value }: { value: ExportPreflight }) {
  return (
    <section
      className={`notice ${value.allowed ? 'info' : 'warning'} export-preflight`}
      aria-label="导出规模预检"
      role="status"
    >
      <strong>{value.allowed ? '导出规模检查通过' : '当前范围不适合一次导出'}</strong>
      <p>
        {value.questionCount.toLocaleString()} 题 · 封包体积保守上界{' '}
        {bytes(value.estimatedZipBytes)} · 附件 {bytes(value.attachmentBytes)}
      </p>
      {!value.allowed && (
        <ul>
          {value.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <small>
        尚未生成文件；这是包含依赖与附件的上界估算，不是压缩后的准确大小。单次最多{' '}
        {value.maxQuestions.toLocaleString()} 题。
      </small>
      {!!value.recommendations.length && (
        <div className="action-row">
          {value.recommendations.map((item) => (
            <a key={item.href} href={item.href} className="button">
              {item.label}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
export function useExportPreflight(input: DataPackageExportInput | null) {
  const signature = input ? JSON.stringify(input) : '';
  const [result, setResult] = useState<{
    key: string;
    value?: ExportPreflight;
    error?: string;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const current = result?.key === signature ? result : null;
  const latest = useRef(signature);
  latest.current = signature;
  useEffect(() => {
    if (!signature) return;
    const controller = new AbortController();
    setResult(null);
    void request<ExportPreflight>('/api/packages/export-preview', {
      method: 'POST',
      body: signature,
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted && latest.current === signature)
          setResult({ key: signature, value });
      })
      .catch((error) => {
        if (!controller.signal.aborted && latest.current === signature)
          setResult({ key: signature, error: error.message });
      });
    return () => controller.abort();
  }, [signature, revision]);
  return {
    allowed: !!current?.value?.allowed,
    value: current?.value,
    view: !signature ? null : current?.error ? (
      <ErrorNotice message={current.error} retry={() => setRevision((n) => n + 1)} />
    ) : current?.value ? (
      <ExportPreflightNotice value={current.value} />
    ) : (
      <Loading text="正在检查导出规模…" />
    ),
  };
}
