/** Incremental SSE decoding shared by provider and browser transports. UTF-8
 * codepoints and CRLF delimiters may both span arbitrary network chunks. */
export interface SseEvent { event: string; data: string; id?: string }
export function createSseParser(onEvent: (event: SseEvent) => void) {
  const decoder = new TextDecoder();
  let buffer = '', scan = 0, data: string[] = [], event = '', id: string | undefined;
  const dispatch = () => {
    if (data.length) onEvent({ event: event || 'message', data: data.join('\n'), ...(id === undefined ? {} : { id }) });
    data = []; event = '';
  };
  const line = (value: string) => {
    if (!value) { dispatch(); return; }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    const raw = colon < 0 ? '' : value.slice(colon + 1);
    const text = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'data') data.push(text);
    else if (field === 'event') event = text;
    else if (field === 'id' && !text.includes('\0')) id = text;
  };
  const consume = (flush: boolean) => {
    let start = 0;
    // Resume from the previous scan position: rescanning an unfinished large
    // JSON data line on every network chunk would make decoding quadratic.
    for (; scan < buffer.length; scan++) {
      const char = buffer[scan]; if (char !== '\r' && char !== '\n') continue;
      if (char === '\r' && scan === buffer.length - 1 && !flush) break;
      line(buffer.slice(start, scan));
      if (char === '\r' && buffer[scan + 1] === '\n') scan++;
      start = scan + 1;
    }
    if (start) { buffer = buffer.slice(start); scan -= start; }
    if (flush) { if (buffer) line(buffer); buffer = ''; scan = 0; dispatch(); }
  };
  return {
    push(chunk: Uint8Array) { buffer += decoder.decode(chunk, { stream: true }); consume(false); },
    finish() { buffer += decoder.decode(); consume(true); },
  };
}
