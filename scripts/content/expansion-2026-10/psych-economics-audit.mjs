/** Read-only cross-review: generated choice mappings and exact-stem duplicates. */
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {groups} from './computer-deepening.mjs';
const root=resolve(import.meta.dirname,'../../..');
const directory=resolve(root,'data/content-packs');
const pack=JSON.parse(await readFile(resolve(directory,'computer-foundations-202610.json'),'utf8'));
const byId=new Map(pack.questions.map(question=>[question.id,question]));
const errors=[],labelContexts=[];
for(const group of groups)group.questions.forEach((row,index)=>{
  const id=`COMPUTER-FOUNDATIONS-202610-${group.id.toUpperCase()}-${String(index+1).padStart(3,'0')}`;
  const generated=byId.get(id);
  if(!generated){errors.push({id,error:'missing generated question'});return;}
  if(row.options?.length){
    const offset=index%row.options.length;
    const map=Object.fromEntries(row.options.map((_,position)=>['ABCD'[position],'ABCD'[(position+offset)%row.options.length]]));
    for(let position=0;position<row.options.length;position++)if(generated.options.find(option=>option.key===map['ABCD'[position]])?.text!==row.options[position])errors.push({id,error:'option text mapping'});
    const expected=row.correct.map(key=>map[key]).sort();
    if(JSON.stringify(expected)!==JSON.stringify(generated.correctAnswers))errors.push({id,error:'correct answer mapping'});
    for(const match of row.explanation.matchAll(/(?<![A-Za-z0-9])([ABCD])(?![A-Za-z0-9])/g))labelContexts.push({id,offset,original:match[1],generated:map[match[1]],context:row.explanation.slice(Math.max(0,match.index-12),match.index+24)});
  }
});
const old=new Map();
for(const name of await readdir(directory))if(name.endsWith('.json')&&name!=='computer-foundations-202610.json'){
  const current=JSON.parse(await readFile(resolve(directory,name),'utf8'));
  for(const question of current.questions||[]){const stem=question.stemMarkdown.trim();if(!old.has(stem))old.set(stem,[]);old.get(stem).push({pack:name,id:question.id});}
}
const duplicates=pack.questions.flatMap(question=>old.has(question.stemMarkdown.trim())?[{id:question.id,stem:question.stemMarkdown,existing:old.get(question.stemMarkdown.trim())}]:[]);
console.log(JSON.stringify({questions:pack.questions.length,choiceMappingErrors:errors,duplicateStemsAgainstOtherPacks:duplicates,labelContexts},null,2));
