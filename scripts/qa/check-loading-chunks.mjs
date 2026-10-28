/** Inspect startup's static JS graph; lazy chunks are deliberately excluded. */
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,posix} from 'node:path';
import {gzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'../..'),baseline=process.argv.includes('--baseline'),mobile=process.argv.includes('--mobile');
const directory=resolve(root,mobile?'dist/mobile':'dist/web'),html=await readFile(resolve(directory,'index.html'),'utf8');
const entries=[...html.matchAll(/<script\b[^>]*type="module"[^>]*src="([^"]+)"|<link\b[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map(match=>(match[1]||match[2]).replace(/^\/?/,''));
const seen=new Set(),files=[];
async function visit(path){if(seen.has(path))return;seen.add(path);const bytes=await readFile(resolve(directory,path)),source=bytes.toString('utf8');files.push({file:path,bytes:bytes.length,gzipBytes:gzipSync(bytes).length});
 for(const match of source.matchAll(/(?:^|[;}])(?:import\s*(?:[^;]*?\sfrom\s*)?|export\s*[^;]*?\sfrom\s*)["']([^"']+)["']/g)){const target=match[1];if(target.startsWith('.'))await visit(posix.normalize(posix.join(posix.dirname(path),target)));}
}
let manifest;
try{manifest=JSON.parse(await readFile(resolve(directory,'.vite/manifest.json'),'utf8'));}catch{if(!baseline)throw new Error('Build manifest is missing; run the application build first.');}
const staticKeys=new Set();
async function manifestVisit(key){if(staticKeys.has(key))return;staticKeys.add(key);const chunk=manifest[key];assert.ok(chunk,'Missing manifest dependency: '+key);if(!seen.has(chunk.file)){const bytes=await readFile(resolve(directory,chunk.file));seen.add(chunk.file);files.push({file:chunk.file,bytes:bytes.length,gzipBytes:gzipSync(bytes).length});}for(const dependency of chunk.imports||[])await manifestVisit(dependency);}
if(manifest){for(const [key,chunk]of Object.entries(manifest))if(chunk.isEntry)await manifestVisit(key);}
else for(const entry of entries)await visit(entry);
const deferred=['web/features/questions/questions.tsx','web/features/analytics/analytics.tsx','web/features/ai/ai-workspace.tsx','web/features/help/handbook.tsx','web/shared/ui/markdown-renderer.tsx'];
// Rolldown can promote a multiply imported dynamic source (questions also
// exports reusable filters) to an anonymous shared chunk. Resolve that chunk
// through its name and an actual dynamic edge, never count it as eager.
const dynamicTargets=new Set(Object.values(manifest||{}).flatMap(chunk=>chunk.dynamicImports||[]));
const deferredChunks=baseline?[]:deferred.map(source=>{const name=posix.basename(source).replace(/\.[^.]+$/,'');const candidates=manifest[source]?[[source,manifest[source]]]:Object.entries(manifest).filter(([key,chunk])=>chunk.name===name&&dynamicTargets.has(key));assert.equal(candidates.length,1,'Expected a single deferred module: '+source);const [key,chunk]=candidates[0];assert.ok(chunk.isDynamicEntry||dynamicTargets.has(key),'Expected lazy module: '+source);assert.ok(!staticKeys.has(key),'Feature was pulled into startup: '+source);return{source,key,file:chunk.file};});
const result={platform:mobile?'mobile':'web',entries,files,staticKeys:[...staticKeys],deferredVerified:deferredChunks,staticJsBytes:files.reduce((sum,file)=>sum+file.bytes,0),staticJsGzipBytes:files.reduce((sum,file)=>sum+file.gzipBytes,0),note:'Static JavaScript graph only; excludes lazy chunks, API data, CSS and fonts.'};
await mkdir(resolve(root,'test-results'),{recursive:true});await writeFile(resolve(root,'test-results',`loading-scale-${baseline?'baseline':mobile?'mobile':'current'}.json`),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
