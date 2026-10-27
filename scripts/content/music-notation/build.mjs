import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import {makeMusicDiagrams} from './diagrams.mjs';
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'data/content-sources/music-notation');
const manifest=JSON.parse(await readFile(join(import.meta.dirname,'font-source.json'),'utf8'));
const sha=body=>createHash('sha256').update(body).digest('hex');
await mkdir(out,{recursive:true});
let fontBytes;
for(const file of manifest.files){
 const path=join(root,'data/content-sources/music-notation-font',file.file);let bytes;
 try{bytes=await readFile(path);}catch{const response=await fetch(`https://raw.githubusercontent.com/steinbergmedia/bravura/${manifest.revision}/${file.path}`,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('Cannot fetch pinned notation source: '+response.status);bytes=Buffer.from(await response.arrayBuffer());await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,bytes);}
 if(sha(bytes)!==file.sha256)throw Error('Notation font checksum mismatch: '+file.file);
 if(file.file==='Bravura.otf')fontBytes=bytes;
}
const font=fontkit.create(fontBytes),labels=fontkit.create(await readFile(join(root,'web/assets/fonts/NotoSansSC-Regular.ttf')));
const diagrams=makeMusicDiagrams(font,labels);
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true});
const assets=[],entries=[];
try{
 const page=await browser.newPage({deviceScaleFactor:2});
 for(const diagram of diagrams){
  await writeFile(join(out,diagram.key+'.svg'),diagram.svg);
  await page.setViewportSize({width:diagram.width,height:diagram.height});await page.setContent(`<html><body style="margin:0">${diagram.svg}</body></html>`);
  const bytes=await page.locator('svg').screenshot({type:'png'});await writeFile(join(out,diagram.key+'.png'),bytes);
  const id='music-notation-'+diagram.key+'-'+sha(bytes).slice(0,12),asset={id,filename:diagram.key+'.png',mimeType:'image/png',sizeBytes:bytes.length,dataBase64:bytes.toString('base64'),width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),createdAt:'2026-10-27T00:00:00.000Z'};
  assets.push(asset);entries.push({key:diagram.key,alt:diagram.alt,assetId:id,sha256:sha(bytes)});
 }
 await page.setViewportSize({width:1440,height:1000});await page.setContent(`<body style="margin:0;display:grid;grid-template-columns:repeat(3,480px)">${diagrams.map(d=>d.svg).join('')}</body>`);await page.screenshot({path:join(out,'contact-sheet.png'),fullPage:true});
}finally{await browser.close();}
await writeFile(join(out,'diagrams.json'),JSON.stringify({format:'noetic-atlas-music-diagrams',schemaVersion:1,generatedAt:new Date().toISOString(),fontSource:manifest,notationSpecification:'https://www.w3.org/2021/03/smufl14/',license:'Bravura: SIL OFL 1.1; original teaching layouts; labels rendered from bundled Noto Sans SC.',entries,assets},null,2)+'\n');
console.log(JSON.stringify({diagrams:entries.length,bytes:assets.reduce((n,a)=>n+a.sizeBytes,0),directory:out}));
