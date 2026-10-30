/** Clipboard writes stay behind an explicit user gesture. Older local WebViews
 * may lack the modern API; a denied modern permission is reported to the user. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const previous = document.activeElement as HTMLElement | null,
    node = document.createElement('textarea');
  node.value = text;
  node.readOnly = true;
  node.dataset.copyFallback = 'true';
  node.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0;';
  document.body.append(node);
  try {
    node.focus({ preventScroll: true });
    node.select();
    if (!document.execCommand('copy')) throw new Error('当前浏览器无法复制');
  } finally {
    node.remove();
    previous?.focus({ preventScroll: true });
  }
}
