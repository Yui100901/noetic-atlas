import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import './action-dropdown.css';

export interface ActionDropdownItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  href?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

interface ActionDropdownProps {
  label: string;
  icon?: ReactNode;
  items: ActionDropdownItem[];
  primary?: boolean;
  disabled?: boolean;
  /** When present, the label starts this action and the adjacent arrow opens the menu. */
  primaryAction?: () => void;
  triggerLabel?: string;
}

interface MenuPosition { top: number; left: number; width: number; maxHeight: number }

/** A menu owns only its action choices. Dialogs opened by a choice remain with
 * the caller, so closing the menu never tears down their state. */
export function ActionDropdown({ label, icon, items, primary = false, disabled = false, primaryAction, triggerLabel }: ActionDropdownProps) {
  const id = useId(), menuId = `${id}-menu`, triggerId = `${id}-trigger`;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const focusPending = useRef(false);
  const split = !!primaryAction;
  const accessibleLabel = triggerLabel || (split ? `${label}选项` : label);
  const enabledItems = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') || []);
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const show = (last = false) => {
    if (disabled) return;
    focusLast.current = last;
    focusPending.current = true;
    setPosition(null);
    setOpen(true);
  };
  const updatePosition = () => {
    if (!trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect(), gutter = 12, gap = 7;
    if (anchor.bottom < gutter || anchor.top > window.innerHeight - gutter) { close(); return; }
    const width = Math.min(260, Math.max(0, window.innerWidth - gutter * 2));
    const below = window.innerHeight - anchor.bottom - gap - gutter, above = anchor.top - gap - gutter;
    const height = Math.min(menu.current.scrollHeight, window.innerHeight - gutter * 2);
    const useAbove = below < height && above > below;
    const maxHeight = Math.max(0, useAbove ? above : below);
    const visibleHeight = Math.min(height, maxHeight);
    setPosition({
      left: Math.max(gutter, Math.min(anchor.right - width, window.innerWidth - width - gutter)),
      top: Math.max(gutter, useAbove ? anchor.top - gap - visibleHeight : anchor.bottom + gap),
      width, maxHeight,
    });
  };
  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !position || !focusPending.current) return;
    focusPending.current = false;
    const available = enabledItems();
    available[focusLast.current ? available.length - 1 : 0]?.focus({ preventScroll: true });
  }, [open, position]);
  useEffect(() => {
    if (disabled) close();
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && !container.current?.contains(target) && !menu.current?.contains(target)) close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);
  const triggerKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (open) {
        const available = enabledItems();
        available[event.key === 'ArrowUp' ? available.length - 1 : 0]?.focus();
      } else show(event.key === 'ArrowUp');
    } else if (event.key === 'Escape' && open) {
      event.preventDefault(); close(true);
    }
  };
  const menuKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const available = enabledItems(), index = available.indexOf(document.activeElement as HTMLElement);
    let next: number | undefined;
    if (event.key === 'ArrowDown') next = (index + 1) % available.length;
    if (event.key === 'ArrowUp') next = (index - 1 + available.length) % available.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = available.length - 1;
    if (next !== undefined) {
      event.preventDefault(); available[next]?.focus(); available[next]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close(true);
    } else if (event.key === 'Tab') {
      // Return to the trigger before normal Tab navigation leaves this menu.
      close(true);
    } else if (event.key === ' ' && document.activeElement?.tagName === 'A') {
      event.preventDefault(); (document.activeElement as HTMLAnchorElement).click();
    }
  };
  return <div className={`action-dropdown${split ? ' action-dropdown-split' : ''}`} ref={container}>
    {primaryAction && <button type="button" className={`button action-dropdown-main${primary ? ' primary' : ''}`} disabled={disabled} onClick={primaryAction}>{icon && <span aria-hidden="true">{icon}</span>}{label}</button>}
    <button type="button" id={triggerId} ref={trigger} className={`button action-dropdown-trigger${primary ? ' primary' : ''}`} disabled={disabled} aria-label={accessibleLabel} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} title={split ? accessibleLabel : undefined} onClick={() => open ? close() : show()} onKeyDown={triggerKeys}>
      {!split && <>{icon && <span aria-hidden="true">{icon}</span>}<span>{label}</span></>}
      <ChevronDown size={16} aria-hidden="true" className={open ? 'rotated' : undefined} />
    </button>
    {open && createPortal(<div id={menuId} ref={menu} role="menu" aria-labelledby={triggerId} className="action-dropdown-menu" style={position || { visibility: 'hidden' }} onKeyDown={menuKeys}>
      {items.map(item => <Fragment key={item.id}>
        {item.separatorBefore && <div className="action-dropdown-separator" role="separator" />}
        {item.href !== undefined ? <a role="menuitem" className={`action-dropdown-item${item.danger ? ' is-danger' : ''}`} href={item.disabled ? undefined : item.href} aria-disabled={item.disabled || undefined} tabIndex={-1} data-action-id={item.id} onClick={event => {
          if (item.disabled) { event.preventDefault(); return; }
          close(); item.onSelect?.();
        }}>{item.icon && <span aria-hidden="true">{item.icon}</span>}<span>{item.label}</span></a> : <button type="button" role="menuitem" className={`action-dropdown-item${item.danger ? ' is-danger' : ''}`} disabled={item.disabled} aria-disabled={item.disabled || undefined} tabIndex={-1} data-action-id={item.id} onClick={() => { close(true); item.onSelect?.(); }}>
          {item.icon && <span aria-hidden="true">{item.icon}</span>}<span>{item.label}</span>
        </button>}
      </Fragment>)}
    </div>, document.body)}
  </div>;
}
