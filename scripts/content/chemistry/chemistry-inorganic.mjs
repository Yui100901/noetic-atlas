/** Rebuild 120 original inorganic substance learning cards from the reviewed catalog. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import rows from './chemistry-inorganic-catalog.mjs';

const root=resolve(import.meta.dirname,'../../..');
const out=resolve(root,'data/content-packs/chemistry-inorganic.json');
const facts=JSON.parse(await readFile(resolve(root,'data/content-sources/chemistry-inorganic-identities.json'),'utf8'));
const identities=new Map(facts.records.map(row=>[row.name,row]));
if(rows.length!==120||new Set(rows.map(r=>r.name)).size!==120)throw Error('Expected 120 distinct inorganic material identities');
const domain={id:'chemistry',name:'化学',description:'日常、工业、食品与材料中的化学物质、性质、反应和用途。',sortOrder:5};
const categoryNames=[...new Set(rows.map(r=>r.category))];
const categoryByName=new Map(categoryNames.map((name,i)=>[name,'chem-inorg-category-'+String(i+1).padStart(2,'0')]));
const categories=[{id:'chem-inorg-root',domainId:'chemistry',name:'无机与日常化学',parentId:null,sortOrder:0,description:'常见无机物、矿物盐与生活工业化学品。'},...categoryNames.map((name,i)=>({id:categoryByName.get(name),domainId:'chemistry',name,parentId:'chem-inorg-root',sortOrder:i,description:'物质身份、性质、代表反应、用途与实际产品边界。'}))];
const tags=['无机物','物质知识卡','化学反应','安全边界',...new Set(rows.flatMap(row=>row.tags))].map((name,i)=>({id:'chem-inorg-tag-'+String(i+1).padStart(2,'0'),name,domainId:'chemistry',kind:'topic',color:'#36867c',description:name==='食品相关'?'说明部分等级产品在特定规范下有食品相关用途，不代表所有用途合法或试剂可食。':name==='安全边界'?'区分物态、浓度、配方与纯度，以及关键暴露或不相容性。':'化学学习主题：'+name}));
const tagByName=new Map(tags.map(row=>[row.name,row.id]));
// Compare atom inventory, allowing standard Hill order and dot-hydrate notation.
function atoms(formula){
 const result={};
 for(let section of formula.split(/[.·]/).filter(Boolean)){
  let factor=1;const leading=section.match(/^(\d+)(?=[A-Z(])/);if(leading){factor=Number(leading[1]);section=section.slice(leading[1].length);}
  const stack=[{}],tokens=section.match(/[A-Z][a-z]?|\d+|[()]/g)||[];
  for(let i=0;i<tokens.length;i++){
   const tok=tokens[i];if(tok==='('){stack.push({});continue;}
   if(tok===')'){const item=stack.pop();const multi=/^\d+$/.test(tokens[i+1]||'')?Number(tokens[++i]):1;for(const[e,n]of Object.entries(item))stack.at(-1)[e]=(stack.at(-1)[e]||0)+n*multi;continue;}
   if(/^\d+$/.test(tok))throw Error('Invalid formula '+formula);
   const count=/^\d+$/.test(tokens[i+1]||'')?Number(tokens[++i]):1;stack.at(-1)[tok]=(stack.at(-1)[tok]||0)+count;
  }
  if(stack.length!==1)throw Error('Unbalanced formula '+formula);
  for(const[e,n]of Object.entries(stack[0]))result[e]=(result[e]||0)+n*factor;
 }
 return JSON.stringify(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)));
}
const equivalent=(a,b)=>atoms(a)===atoms(b);
const nioshSilica={label:'CDC/NIOSH：Silica, amorphous（无定形二氧化硅）',url:'https://www.cdc.gov/niosh/npg/npgd0552.html'};
const food={label:'FDA：食品添加剂的许可、技术用途与受限使用原则（非中国许可清单）',url:'https://www.fda.gov/food/food-additives-and-gras-ingredients-information-consumers/understanding-how-fda-regulates-food-additives-and-gras-ingredients'};
const issues=[];
const questions=rows.map((r,index)=>{
 const fact=identities.get(r.name);
 if(!fact?.pubchemCid||fact.error)throw Error('Missing identity '+r.name);
 // PubChem uses a full hydrate formula for hemihydrate; the card explicitly uses a half formula unit.
 if(r.formula!=='CaSO4·0.5H2O'&&!equivalent(r.formula,fact.pubchemFormula))throw Error('Formula mismatch '+r.name+' '+r.formula+' versus '+fact.pubchemFormula);
 if(r.formula==='CaSO4·0.5H2O'&&atoms(fact.pubchemFormula)!==atoms('2CaSO4·H2O'))throw Error('Hemihydrate identity not two half units: '+fact.pubchemFormula);
 const sources=[{label:`PubChem CID ${fact.pubchemCid}：${fact.english}（物质身份；无机盐采用常用化学式）`,url:`https://pubchem.ncbi.nlm.nih.gov/compound/${fact.pubchemCid}`},...fact.icsc.map(c=>({label:`ILO/WHO ICSC ${c.id}：${c.title}（具体浓度、形态与水合物须以该页适用对象为准）`,url:c.url}))];
 if(r.english==='Silicon dioxide')sources.push(nioshSilica);
 if(r.tags.includes('食品相关'))sources.push(food);
 if(!fact.icsc.length&&r.english!=='Silicon dioxide')issues.push({name:r.name,scope:'无独立匹配ICSC；来源以PubChem物质页为主，未将其他物质的安全卡错配。'});
 const advanced=/平衡|两性|络合|半反应|晶型|晶相/.test(r.reaction+r.properties);
 return {
  id:'CHEM-INORG-'+String(index+1).padStart(6,'0'),title:`${r.name}｜${r.formula}`,type:'short_answer',
  stemMarkdown:`**物质名称**：${r.name}\n\n**化学式**：\`${r.formula}\`\n\n请说明它的主要性质、常见反应或稳定性、日常/工业/食品等实际用途，并辨别纯物质、实际产品和关键安全边界。`,
  answerMarkdown:`**性质**：${r.properties}\n\n**代表反应/稳定性**：${r.reaction}\n\n**用途**：${r.uses}`,
  explanationMarkdown:`**物质身份与实际产品**\n\n${r.boundary||'以明示化学组成讨论性质；商品产品的成分、浓度和等级应以标签及安全数据表为准。'}\n\n**关键风险与禁混边界**\n\n${r.risk}\n\n**理解与追问**\n\n解释上述反应时，应辨认酸碱、沉淀、氧化还原、配位或物理变化，并说明介质、物态、纯度或浓度为何影响结果。方程式只表达所说明的反应关系；不表示任意混合均可安全、快速或定量发生。\n\n**常见误区**\n\n不要把纯物质化学式当作商品完整配方；食品级、药用级、试剂级和工业级不因主成分相同就能互换。用途是知识性示例，涉及食品、农用、消毒或医疗的具体许可应核对所在地现行规定。${r.tags.includes('食品相关')?' 本条“食品相关”仅说明有受规范约束的应用，不是中国现行食品添加剂许可或限量结论。':''}\n\n本卡中文由项目原创整理；PubChem提供身份定位，有对应ICSC/NIOSH条目时另列用于核对其适用形态的性质与危害。不是操作规程、SDS替代品或医疗处方。核验日期：2026-10-22。`,
  options:[],correctAnswers:[],difficulty:advanced?2:1,depth:advanced?3:2,frequency:0,
  frequencyScope:'日常化学与材料知识学习；非面试或考试频率',frequencyBasis:'未统计考频；F0表示未评估，不代表学习价值低',collection:'general',status:'pending',categoryIds:[categoryByName.get(r.category)],tagIds:[...new Set(['无机物','物质知识卡','化学反应','安全边界',...r.tags])].map(name=>tagByName.get(name)),sourceRefs:sources,sourceDocument:null,sourceAnchor:null,
 };
});
const pack={schemaVersion:1,generatedAt:'2026-10-22T00:00:00Z',domains:[domain],categories,tags,questions,assets:[],questionBanks:[{id:'chem-inorg-bank',name:'日常与工业无机化学品120卡',description:'原创物质学习卡，区分物态、水合物、配方和等级；不作为食品许可清单或危险实验操作说明。',questionIds:questions.map(q=>q.id)}]};
await mkdir(resolve(root,'data/content-packs'),{recursive:true});
const serialized=JSON.stringify(pack,null,2)+'\n';await writeFile(out,serialized);
const provenance={schemaVersion:1,pack:'chemistry-inorganic',generatedAt:pack.generatedAt,checkedAt:'2026-10-22',questions:questions.length,status:'pending',domain:'chemistry',counts:{categories:categories.length,tags:tags.length,withPubChemIdentity:questions.length,withSpecificICSC:questions.filter(q=>q.sourceRefs.some(s=>s.label.startsWith('ILO/WHO'))).length,foodRelated:rows.filter(r=>r.tags.includes('食品相关')).length},coverage:categoryNames.map(name=>({category:name,count:rows.filter(r=>r.category===name).length})),sourcePolicy:'中文性质、反应解释、用途和边界均原创整理；只保留身份事实、来源URL与抓取哈希，不转载PubChem贡献者长篇正文或ICSC完整安全卡。',formulaPolicy:'无机物按常用化学计量式表示，水合物单独注明；石英与无定形SiO2同式但相态与粉尘风险分开。氢卤酸、氨水、漂白液等明确区分纯成分和溶液/配方。',limitations:['未提供任何危险制备、强氧化剂混配、制气、点火、药物剂量或食品添加用量配方。','不构成全球或中国现行许可物料清单；食品用途仅是受规范约束的用途举例。','核对来源不等于对每个反应进行实验验证；反应速率、物态和条件限制在正文说明。','含药用交叉用途的无机物以化学性质为主，不复制医学剂量、疗效或处方内容。'],unmatchedIndividualICSC:issues,identityManifest:'data/content-sources/chemistry-inorganic-identities.json',generator:'scripts/content/chemistry/chemistry-inorganic.mjs',catalog:'scripts/content/chemistry/chemistry-inorganic-catalog.mjs',sourceFetcher:'scripts/content/chemistry/chemistry-inorganic-sources.py',packBytes:Buffer.byteLength(serialized),packSha256:createHash('sha256').update(serialized).digest('hex')};
await writeFile(resolve(root,'data/content-sources/chemistry-inorganic.json'),JSON.stringify(provenance,null,2)+'\n');
console.log(JSON.stringify({file:out,...provenance.counts,questions:questions.length,bytes:provenance.packBytes,sha256:provenance.packSha256}));
