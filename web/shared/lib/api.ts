import { useCallback, useEffect, useRef, useState } from 'react';
import { isNativeApp, nativeFetch, nativeDownload } from '@platform';

export class ApiError extends Error {
  code: string;
  details: unknown;
  status: number;
  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message); this.code = code; this.status = status; this.details = details;
  }
}

export async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const prepared = { ...options, headers };
  const response = await (isNativeApp() ? nativeFetch(url, prepared) : fetch(url, prepared));
  let data: any;
  try { data = await response.json(); } catch { if (!response.ok) throw new ApiError(`请求失败（${response.status}）`, 'HTTP_ERROR', response.status); }
  if (!response.ok) { const detail = Array.isArray(data?.error?.details) ? data.error.details.map((item: any) => `${item.path ? item.path + '：' : ''}${item.message || ''}`).filter(Boolean).join('；') : ''; throw new ApiError((data?.error?.message || `请求失败（${response.status}）`) + (detail ? `：${detail}` : ''), data?.error?.code || 'HTTP_ERROR', response.status, data?.error?.details); }
  return data as T;
}
export const send = <T,>(url: string, method: string, body?: unknown) => request<T>(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const idPath = (id: string) => encodeURIComponent(id);
export const qs = (values: Record<string, unknown>) => {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '' && value !== false) query.set(key, Array.isArray(value) ? value.join(',') : String(value)); });
  return query.toString();
};
export const href = (section: string, id?: string) => `#/${section}${id ? `/${idPath(id)}` : ''}`;
export const navigate = (section: string, id?: string) => { window.location.hash = href(section, id); };

export function useResource<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [dataUrl,setDataUrl]=useState<string|null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    if (!url) { setData(null); setDataUrl(null); setError(''); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    // StrictMode can dispose an effect before it reaches the next microtask.
    // Do not send its already-cancelled request to the server.
    const active = () => !controller.signal.aborted && current === generation.current;
    void Promise.resolve().then(() => {
      if (!active()) return;
      return request<T>(url, { signal: controller.signal }).then(result => { if (active()) {setData(result);setDataUrl(url);} }).catch(reason => { if (reason.name !== 'AbortError' && active()) { setError(reason.message); setData(null);setDataUrl(null); } }).finally(() => { if (active()) setLoading(false); });
    });
    return () => controller.abort();
  }, [url, revision]);
  return { data, dataUrl, setData, error, loading, refresh };
}
export function useDebounced<T>(value: T, delay = 240) {
  const [result, setResult] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setResult(value), delay); return () => clearTimeout(timer); }, [value, delay]);
  return result;
}
export function download(url: string, filename?: string) {
  if (isNativeApp()) { void nativeDownload(url, filename).catch(error => window.alert(error.message || '导出失败')); return; }
  const link = document.createElement('a'); link.href = url; if (filename) link.download = filename; link.click();
}
export function localDate(value?: string | null) { if (!value) return '尚未记录'; const d = new Date(value); return Number.isNaN(d.valueOf()) ? value : d.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
