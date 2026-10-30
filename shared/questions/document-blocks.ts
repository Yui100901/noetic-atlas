/** UTF-16 ranges in the exact saved Markdown, without rewriting its whitespace.
 * Blank lines inside fenced code stay in the same selectable block. */
export function documentTextBlocks(
  text: string,
): Array<{ start: number; end: number; label: string }> {
  const blocks: Array<{ start: number; end: number; label: string }> = [];
  let start = 0,
    offset = 0,
    fence = '';
  const append = (end: number) => {
    const part = text.slice(start, end);
    if (part.trim())
      blocks.push({
        start,
        end,
        label: part
          .replace(/[#*`>_]/g, '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 80),
      });
    start = end;
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
    }
    offset += line.length;
    if (!fence && !line.trim()) append(offset);
  }
  append(text.length);
  return blocks;
}
