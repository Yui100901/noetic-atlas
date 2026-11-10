/** Avoid Fetch/browser-denied service ports when Windows assigns low dynamic
 * ports. The callback binds to 127.0.0.1 itself; never expose a public listener. */
export async function listenOnLoopback<T>(start: (port: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    try {
      return await start(port);
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Windows reserves some high ranges; choose another unprivileged port.
      if (attempt >= 19 || (code !== 'EADDRINUSE' && code !== 'EACCES')) throw error;
    }
  }
}
