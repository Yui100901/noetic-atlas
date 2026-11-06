import { Check, Shuffle, Sparkles } from 'lucide-react';
import './paper-creation-modes.css';

export type PaperCreationMode = 'manual' | 'random' | 'ai';

/** Shared creation choices. Ordinary manual/random work keeps its current
 * draft; leaving for AI uses the editor's existing save-before-leave guard. */
export function PaperCreationModes({
  mode,
  onModeChange,
  disabled = false,
}: {
  mode: PaperCreationMode;
  onModeChange?: (mode: 'manual' | 'random') => void;
  disabled?: boolean;
}) {
  const choices = [
    { id: 'manual', label: '手动选题', icon: <Check size={15} /> },
    { id: 'random', label: '标签随机', icon: <Shuffle size={15} /> },
    { id: 'ai', label: 'AI推荐', icon: <Sparkles size={15} /> },
  ] as const;
  return (
    <nav className="section-tabs paper-creation-modes" aria-label="创建题集方式">
      {choices.map((choice) =>
        choice.id !== 'ai' && onModeChange ? (
          <button
            key={choice.id}
            type="button"
            disabled={disabled}
            className={mode === choice.id ? 'selected' : ''}
            onClick={() => onModeChange(choice.id as 'manual' | 'random')}
          >
            {choice.icon}
            {choice.label}
          </button>
        ) : (
          <a
            key={choice.id}
            href={`#/papers/new/${choice.id}`}
            className={mode === choice.id ? 'selected' : ''}
            aria-current={mode === choice.id ? 'page' : undefined}
            aria-disabled={disabled || undefined}
            onClick={(event) => {
              if (disabled) event.preventDefault();
            }}
          >
            {choice.icon}
            {choice.label}
          </a>
        ),
      )}
    </nav>
  );
}
