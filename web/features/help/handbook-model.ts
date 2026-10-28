export const handbookSlug=(value:string)=>value.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu,'').replace(/\s+/g,'-');
export function handbookSections(source:string,fallbackTitle='文档内容'){
 const sections:Array<{title:string;id:string;body:string}>=[];let fenced=false,current:{title:string;id:string;body:string}|null=null;
 for(const line of source.split(/\r?\n/)){if(/^\s*(```|~~~)/.test(line))fenced=!fenced;const heading=!fenced?/^## (.+)$/.exec(line):null;
  if(heading){current={title:heading[1],id:handbookSlug(heading[1]),body:line};sections.push(current);}else if(current)current.body+='\n'+line;
 }
 const readable=sections.filter(section=>section.title!=='目录');
 if(readable.length||!source.trim())return readable;
 const firstHeading=/^# (.+)\r?$/m.exec(source),title=firstHeading?.[1]||fallbackTitle;
 const body=firstHeading?source.replace(firstHeading[0],''):source;
 return[{title,id:handbookSlug(title),body:'## '+title+'\n\n'+body.trim()}];
}
export type HandbookLink={kind:'anchor';anchor:string}|{kind:'document';document:string;anchor:string}|{kind:'external';href:string}|{kind:'disabled'};
export function handbookLink(current:string,href:string,available:ReadonlySet<string>):HandbookLink{
 if(/^https?:\/\//i.test(href)){try{const url=new URL(href);if(!url.username&&!url.password)return{kind:'external',href:url.href};}catch{}return{kind:'disabled'};}
 if(href.startsWith('#')&&!href.startsWith('#/')){try{return{kind:'anchor',anchor:decodeURIComponent(href.slice(1))};}catch{return{kind:'disabled'};}}
 if(!href||/^[a-z][a-z0-9+.-]*:/i.test(href)||href.startsWith('/')||href.startsWith('\\')||href.includes('?'))return{kind:'disabled'};
 try{const [path,fragment='']=href.split('#'),parts=current.split('/').slice(0,-1);for(const part of decodeURIComponent(path).split('/')){if(part==='..'){if(!parts.length)return{kind:'disabled'};parts.pop();}else if(part!=='.'&&part)parts.push(part);}
  const document=parts.join('/');return available.has(document)?{kind:'document',document,anchor:decodeURIComponent(fragment)}:{kind:'disabled'};
 }catch{return{kind:'disabled'};}
}
