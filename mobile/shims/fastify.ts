import type { StorageEffect } from '../../server/http/operation';

type Handler = (request: any, reply: LocalReply) => unknown;
type RouteOptions = { bodyLimit?: number; schema?: Record<string, unknown>; config?: { storageEffect?: StorageEffect } };
class LocalReply {
  statusCode = 200; headers = new Headers(); payload: unknown; sent = false;
  code(status: number) { this.statusCode = status; return this; }
  status(status: number) { return this.code(status); }
  header(name: string, value: string) { this.headers.set(name, value); return this; }
  type(value: string) { return this.header('Content-Type', value); }
  send(value: unknown) { this.payload = value; this.sent = true; return this; }
}
export class LocalApp {
  private routes: { method: string; path: string; handle: Handler; bodyLimit: number; storageEffect?: StorageEffect }[] = [];
  constructor(private options: {bodyLimit?:number} = {}) {}
  private hooks: Record<string, Handler[]> = {};
  private errorHandler: (error: unknown, request: any, reply: LocalReply) => unknown = (error, _request, reply) => reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: String(error) } });
  private missing: Handler = (_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
  log = { error: (error: unknown) => console.error('[local-api]', error) };
  private route(method: string, path: string, optionsOrHandler: RouteOptions | Handler, handler?: Handler) {
    const options=typeof optionsOrHandler==='function'?{}:optionsOrHandler;
    const handle=typeof optionsOrHandler==='function'?optionsOrHandler:handler;
    if(typeof handle!=='function')throw new TypeError('离线路由缺少处理函数');
    const bodyLimit=options.bodyLimit??this.options.bodyLimit??80*1024*1024;
    if(!Number.isSafeInteger(bodyLimit)||bodyLimit<1)throw new TypeError('离线路由bodyLimit无效');
    const entry={method,url:path,schema:options.schema||{},config:options.config||{}};
    for(const hook of this.hooks.onRoute||[])hook(entry,new LocalReply());
    this.routes.push({method,path,handle,bodyLimit,storageEffect:options.config?.storageEffect});
  }
  get(path: string, options: RouteOptions | Handler, handler?: Handler) { this.route('GET', path, options, handler); }
  post(path: string, options: RouteOptions | Handler, handler?: Handler) { this.route('POST', path, options, handler); }
  put(path: string, options: RouteOptions | Handler, handler?: Handler) { this.route('PUT', path, options, handler); }
  patch(path: string, options: RouteOptions | Handler, handler?: Handler) { this.route('PATCH', path, options, handler); }
  delete(path: string, options: RouteOptions | Handler, handler?: Handler) { this.route('DELETE', path, options, handler); }
  addHook(name: string, handle: Handler) { (this.hooks[name] ||= []).push(handle); }
  setErrorHandler(handle: typeof this.errorHandler) { this.errorHandler = handle; }
  setNotFoundHandler(handle: Handler) { this.missing = handle; }
  async register(_plugin: unknown, _options?: unknown) { }
  async close() { for (const hook of this.hooks.onClose || []) await hook(undefined, new LocalReply()); }
  private matchRoute(method: string, pathname: string) {
    const parts = pathname.split('/');
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const pattern = route.path.split('/'); if (pattern.length !== parts.length) continue;
      const params: Record<string, string> = {}; let matches = true;
      for (let index = 0; index < pattern.length; index++) {
        if (pattern[index]!.startsWith(':')) params[pattern[index]!.slice(1)] = decodeURIComponent(parts[index]!);
        else if (pattern[index] !== parts[index]) { matches = false; break; }
      }
      if (matches) return { route, params };
    }
    return undefined;
  }
  /** Uses the same matched route as inject, so aliases and query strings
   * cannot accidentally borrow another operation's read-only declaration. */
  storageEffect(method: string, url: string): StorageEffect | undefined {
    try {
      const parsed = new URL(url, 'https://localhost');
      if (parsed.origin !== 'https://localhost' || !parsed.pathname.startsWith('/api/')) return undefined;
      return this.matchRoute(method.toUpperCase(), parsed.pathname)?.route.storageEffect;
    } catch { return undefined; }
  }
  async inject(url: string, options: RequestInit = {}): Promise<Response> {
    const parsed = new URL(url, 'https://localhost'); const method = (options.method || 'GET').toUpperCase(); const reply = new LocalReply();
    const request: any = { method, url: parsed.pathname + parsed.search, protocol: 'https', headers: { ...Object.fromEntries(new Headers(options.headers)), host: 'localhost' }, query: Object.fromEntries(parsed.searchParams), params: {}, body: undefined };
    try {
      if (!parsed.pathname.startsWith('/api/') || parsed.origin !== 'https://localhost') throw Object.assign(new Error('离线接口只接受本地 API 路径'), { statusCode: 400, code: 'INVALID_LOCAL_URL' });
      for (const hook of this.hooks.onRequest || []) { await hook(request, reply); if (reply.sent) return this.response(reply); }
      const matched = this.matchRoute(method, parsed.pathname), route = matched?.route;
      request.params = matched?.params || {};
      if (typeof options.body === 'string') {
        const limit=route?.bodyLimit??this.options.bodyLimit??80*1024*1024;
        if(new TextEncoder().encode(options.body).byteLength>limit)return this.response(reply.code(413).send({error:{code:'BODY_TOO_LARGE',message:'数据超过允许大小'}}));
        try{request.body=JSON.parse(options.body);}catch{throw Object.assign(new Error('请求 JSON 格式无效'),{statusCode:400,code:'INVALID_JSON'});}
      }
      const value = await (route?.handle || this.missing)(request, reply); if (!reply.sent && value !== reply) reply.send(value);
    } catch (error) {
      const value = await this.errorHandler(error, request, reply); if (!reply.sent && value !== reply) reply.send(value);
    }
    return this.response(reply);
  }
  private response(reply: LocalReply): Response {
    let body: BodyInit;
    if (reply.payload instanceof Uint8Array) body = reply.payload as unknown as BodyInit;
    else if (typeof reply.payload === 'string') body = reply.payload;
    else { body = JSON.stringify(reply.payload ?? null); if (!reply.headers.has('Content-Type')) reply.headers.set('Content-Type', 'application/json; charset=utf-8'); }
    return new Response(body, { status: reply.statusCode, headers: reply.headers });
  }
}
export default function Fastify(options?: {bodyLimit?:number;[key:string]:unknown}) { return new LocalApp(options); }
