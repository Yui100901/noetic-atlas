import { useState, useEffect, useRef } from 'react';
import { copyText } from '../lib/clipboard';
import { Copy, Check } from 'lucide-react';
import { renderFormula } from '../../../shared/math/engine';
import 'katex/dist/katex.min.css';
import './math.css';
export function Formula({ source, display = false }: { source: string; display?: boolean }) {
  const result = renderFormula(source, display),
    [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState(false);
  const current = useRef(source);
  current.current = source;
  useEffect(() => {
    setCopied(false);
    setCopyError(false);
  }, [source]);
  const copy = async () => {
    try {
      await copyText(source);
      if (current.current !== source) return;
      setCopied(true);
      setCopyError(false);
    } catch {
      if (current.current === source) setCopyError(true);
    }
  };
  const contents = (
    <>
      <span className="formula-content">
        {result.ok ? (
          <span dangerouslySetInnerHTML={{ __html: result.html }} />
        ) : (
          <span className="formula-error" role="note">
            <code>{source}</code>
            <span>公式未能排版：{result.message}</span>
          </span>
        )}
      </span>
      <button
        type="button"
        className="formula-copy"
        title="复制LaTeX源码"
        aria-label="复制公式源码"
        onClick={() => void copy()}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      {copyError && (
        <span className="formula-copy-error" role="status">
          复制不可用，可从编辑模式复制源码
        </span>
      )}
    </>
  );
  return display ? (
    <div className="formula formula-display" data-formula-source={source}>
      {contents}
    </div>
  ) : (
    <span className="formula formula-inline" data-formula-source={source}>
      {contents}
    </span>
  );
}
