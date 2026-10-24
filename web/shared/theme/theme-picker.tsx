import { Check, Moon, Palette } from 'lucide-react';
import { THEMES, THEME_LABELS, type Theme } from '../../../shared/models/settings';

const descriptions: Record<Theme, string> = { green: '自然明亮', dark: '低亮度深色', pink: '柔和暖粉', sky: '清爽浅蓝', mint: '轻盈清新' };

export function ThemePicker({ value, onChange }: { value: Theme; onChange: (theme: Theme) => void }) {
  return <fieldset className="theme-picker">
    <legend className="field-label"><Palette size={16} />界面主题</legend>
    <div className="theme-options">
      {THEMES.map(theme => <label className={`theme-option theme-option-${theme}${value === theme ? ' selected' : ''}`} key={theme}>
        <input type="radio" name="interface-theme" value={theme} checked={value === theme} onChange={() => onChange(theme)} />
        <span className="theme-swatch" aria-hidden="true"><i /><i /><i />{theme === 'dark' && <Moon size={13} />}</span>
        <span className="theme-option-copy"><strong>{THEME_LABELS[theme]}</strong><small>{descriptions[theme]}</small></span>
        {value === theme && <Check size={16} className="theme-option-check" aria-hidden="true" />}
      </label>)}
    </div>
    <p className="muted">选择后可预览；点击“保存系统配置”后保留。离开未保存的页面会恢复原主题。</p>
  </fieldset>;
}
