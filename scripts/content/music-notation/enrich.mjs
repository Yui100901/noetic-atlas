import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {unified} from 'unified';
import remarkParse from 'remark-parse';
import {musicConceptDiagrams,stemMusicDiagrams,objectiveMusicFigures} from './diagrams.mjs';
const parser=unified().use(remarkParse);
/** Update prior generated image versions without touching code examples. */
function replaceImageVersion(markdown,key,item){
 const changes=[];let found=false;const walk=node=>{if(node.type==='image'&&node.url.startsWith(`/api/assets/music-notation-${key}-`)&&node.url.endsWith('/content')&&node.position?.start.offset!==undefined){found=true;changes.push({start:node.position.start.offset,end:node.position.end.offset,text:`![${item.alt}](/api/assets/${item.assetId}/content)`});}for(const child of node.children||[])walk(child);};walk(parser.parse(markdown));
 let result=markdown;for(const change of changes.reverse())result=result.slice(0,change.start)+change.text+result.slice(change.end);return {markdown:result,found};
}
export function illustrateMusicQuestion(question,illustrations){
 const keys=question.concept?(musicConceptDiagrams[question.concept.term]||[]):objectiveMusicFigures.filter(([pattern])=>pattern.test(question.stemMarkdown)).map(([,key])=>key);
 let result=question;
 for(const key of new Set(keys)){
  const item=illustrations.entries.find(entry=>entry.key===key);if(!item)throw Error('Missing music illustration: '+key);
  const url=`/api/assets/${item.assetId}/content`;
  const stem=replaceImageVersion(result.stemMarkdown,key,item),explanation=replaceImageVersion(result.explanationMarkdown,key,item);
  if(stem.markdown!==result.stemMarkdown||explanation.markdown!==result.explanationMarkdown)result={...result,stemMarkdown:stem.markdown,explanationMarkdown:explanation.markdown};
  if(stem.found||explanation.found)continue;
  const field=question.concept&&stemMusicDiagrams.has(key)?'stemMarkdown':'explanationMarkdown';
  result={...result,[field]:result[field]+`\n\n![${item.alt}](${url})`};
 }
 return result;
}
export async function enrichMusicPack(pack){
 const root=resolve(import.meta.dirname,'../../..'),path=join(root,'data/content-sources/music-notation/diagrams.json');let diagrams;
 try{diagrams=JSON.parse(await readFile(path,'utf8'));}catch{throw Error('先运行 scripts/content/music-notation/build.mjs 生成可离线分享的音乐图例。');}
 const questions=pack.questions.map(question=>illustrateMusicQuestion(question,diagrams));
 const used=new Set(questions.flatMap(q=>[q.stemMarkdown,q.explanationMarkdown]).join('\n').match(/music-notation-[\w-]+/g)||[]);
 const assets=[...new Map([...(pack.assets||[]).filter(a=>!a.id.startsWith('music-notation-')||used.has(a.id)),...diagrams.assets.filter(asset=>used.has(asset.id))].map(asset=>[asset.id,asset])).values()];
 Object.assign(pack,{questions,assets});return pack;
}
export async function updateMusicAuthorPack(){
 const root=resolve(import.meta.dirname,'../../..'),name='knowledge-expansion-20261026-music',path=join(root,'data/content-packs',name+'.json');
 const pack=await enrichMusicPack(JSON.parse(await readFile(path,'utf8'))),output=JSON.stringify(pack,null,2)+'\n';
 await writeFile(path,output);const sourcePath=join(root,'data/content-sources',name+'.json'),source=JSON.parse(await readFile(sourcePath,'utf8'));
 source.sha256=createHash('sha256').update(output).digest('hex');source.illustrations={assets:pack.assets.length,questions:pack.questions.filter(q=>q.stemMarkdown.includes('/api/assets/music-notation-')||q.explanationMarkdown.includes('/api/assets/music-notation-')).length,policy:'Original layout; Bravura SMuFL glyph paths under SIL OFL 1.1; packaged PNG assets, no client font/CDN dependency.',licenseFile:'scripts/content/music-notation/LICENSE-Bravura.txt'};
 await writeFile(sourcePath,JSON.stringify(source,null,2)+'\n');return source.illustrations;
}
