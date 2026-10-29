import { useEffect, useState } from 'react';
import { ChevronUp, Check } from 'lucide-react';
import './paper-mobile-toolbar.css';

/** A single editor owns the selection. The mobile toolbar only opens that
 * editor's basket and submits its existing form; it never keeps a second copy. */
export function PaperMobileToolbar({
  manual,
  selected,
  detail,
  disabled,
  saving,
  editing,
  ready,
  onOpen,
  onComplete,
  keyboardOpen,
}: {
  manual: boolean;
  selected: number;
  detail: string;
  disabled: boolean;
  saving: boolean;
  editing: boolean;
  ready: boolean;
  onOpen: () => void;
  onComplete: () => void;
  keyboardOpen: boolean;
}) {
  return (
    <section
      className={`paper-mobile-toolbar${keyboardOpen ? ' is-keyboard-open' : ''}`}
      aria-label="手机组题操作"
    >
      {manual ? (
        <button
          className="paper-mobile-selection"
          type="button"
          aria-label="管理已选题目"
          disabled={saving || !ready}
          onClick={onOpen}
        >
          <span>
            <strong>已选 {selected.toLocaleString()} 题</strong>
            <small>{detail}</small>
          </span>
          <ChevronUp size={17} />
        </button>
      ) : (
        <div className="paper-mobile-target">
          <strong>随机组题</strong>
          <small>{detail}</small>
        </div>
      )}
      <button className="button primary" type="button" disabled={disabled} onClick={onComplete}>
        <Check size={16} />
        {saving ? '正在保存…' : editing ? '保存题集' : '完成组题'}
      </button>
    </section>
  );
}

/** visualViewport changes when a phone's software keyboard opens. Keep the
 * action bar away from active text input instead of covering its last lines. */
export function usePaperMobileViewport() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width:760px)').matches);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width:760px)'),
      viewport = window.visualViewport;
    let width = window.innerWidth,
      maximumHeight = viewport?.height || window.innerHeight;
    const update = () => {
      const active = document.activeElement;
      const editing =
        active instanceof HTMLElement &&
        !!active.closest(
          'textarea,input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]),[contenteditable="true"]',
        );
      const height = viewport?.height || window.innerHeight;
      if (Math.abs(window.innerWidth - width) > 100) {
        width = window.innerWidth;
        maximumHeight = height;
      }
      if (!editing) maximumHeight = height;
      setMobile(media.matches);
      setKeyboardOpen(
        media.matches &&
          editing &&
          (maximumHeight - height > 120 || window.innerHeight - height > 120),
      );
    };
    media.addEventListener('change', update);
    viewport?.addEventListener('resize', update);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      media.removeEventListener('change', update);
      viewport?.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, []);
  return { mobile, keyboardOpen };
}
