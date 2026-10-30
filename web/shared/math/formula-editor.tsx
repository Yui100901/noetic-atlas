import { useState } from 'react';
import { Formula } from './formula';
import { renderFormula } from '../../../shared/math/engine';
export const FORMULA_TEMPLATES = [
  ['分数', String.raw`\frac{a}{b}`],
  ['上下标', String.raw`x_i^2`],
  ['根式', String.raw`\sqrt{x}`],
  ['求和', String.raw`\sum_{i=1}^{n} i`],
  ['积分', String.raw`\int_a^b f(x)\,\mathrm{d}x`],
  ['矩阵', String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`],
  ['方程组', String.raw`\begin{cases}x+y=3\\x-y=1\end{cases}`],
  ['单位', String.raw`9.8\,\mathrm{m/s^2}`],
  ['化学式', String.raw`\ce{H2SO4}`],
  ['化学反应', String.raw`\ce{2H2 + O2 -> 2H2O}`],
  ['离子', String.raw`\ce{SO4^2-}`],
] as const;
export default function FormulaEditor({
  initial,
  onInsert,
  onClose,
}: {
  initial: string;
  onInsert: (source: string, display: boolean) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState(initial || FORMULA_TEMPLATES[0][1]),
    [display, setDisplay] = useState(true);
  const result = renderFormula(source, display);
  return (
    <section className="math-insert-panel" aria-label="插入公式">
      <div className="math-template-list">
        {FORMULA_TEMPLATES.map(([label, tex]) => (
          <button type="button" className="button small" key={label} onClick={() => setSource(tex)}>
            {label}
          </button>
        ))}
      </div>
      <label>
        LaTeX源码
        <textarea
          aria-label="公式源码"
          rows={3}
          value={source}
          maxLength={8000}
          onChange={(event) => setSource(event.target.value)}
        />
      </label>
      <div className="math-format-control">
        <label className="math-mode-label">
          <input
            type="checkbox"
            checked={display}
            onChange={(event) => setDisplay(event.target.checked)}
          />
          独立公式块
        </label>
        <span className="muted">
          行内使用 $…$，公式块使用 $$…$$；化学表达使用 \ce&#123;…&#125;。
        </span>
      </div>
      <Formula source={source} display={display} />
      <div className="button-row">
        <button
          type="button"
          className="button primary"
          disabled={!result.ok || !source.trim()}
          onClick={() => onInsert(source.trim(), display)}
        >
          插入公式
        </button>
        <button type="button" className="button" onClick={onClose}>
          取消
        </button>
      </div>
    </section>
  );
}
