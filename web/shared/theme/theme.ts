import { THEMES, type Theme } from '../../../shared/models/settings';

const CACHE_KEY = 'noetic-atlas-theme';
const validTheme = (value: unknown): value is Theme => THEMES.includes(value as Theme);
let confirmedTheme: Theme | undefined;

/** Cache only the confirmed server preference, so previews cannot replace it. */
export function savedTheme(): Theme {
  if (confirmedTheme) return confirmedTheme;
  try { const value = localStorage.getItem(CACHE_KEY); return validTheme(value) ? value : 'green'; }
  catch { return confirmedTheme || 'green'; }
}

export function applyTheme(theme: Theme, { persist = false }: { persist?: boolean } = {}) {
  const selected = validTheme(theme) ? theme : 'green';
  document.documentElement.dataset.theme = selected;
  document.documentElement.style.colorScheme = selected === 'dark' ? 'dark' : 'light';
  if (persist) {
    confirmedTheme = selected;
    try { localStorage.setItem(CACHE_KEY, selected); } catch { /* SQLite remains authoritative when browser storage is unavailable. */ }
  }
}

export function initializeTheme() { applyTheme(savedTheme()); }
