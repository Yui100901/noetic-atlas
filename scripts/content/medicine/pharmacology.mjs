/** Reproduce original, non-prescriptive pharmacology/chemical-identity cards.
 * Verified public-source identities are pinned in the companion catalogue;
 * no copyrighted clinical monograph text or drug manufacturing process is copied.
 */
import {writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, join} from 'node:path';
import {rows, groups, verified} from './pharmacology-catalog.mjs';

const root=resolve(import.meta.dirname,'../../..'),stamp='2026-10-22T00:00:00Z';
const verifiedByName=new Map(verified.map(v=>[v.en,v]));
if(rows.length!==60||new Set(rows.map(r=>r.en)).size!==rows.length||verified.length!==rows.length)throw new Error('Expected 60 unique verified active ingredients');
const domains=[
  {id:'chemistry',name:'化学',description:'日常、工业、食品与材料中的化学物质、性质、反应和用途。',sortOrder:5},
  {id:'medicine-pharmacy',name:'医学与药学',description:'药理与药品信息学习，区分化学身份、临床用途和用药安全。',sortOrder:6},
];
const categories=[
  {id:'chem-pharma-root',domainId:'chemistry',parentId:null,name:'药用化学物质',sortOrder:2,description:'按化学身份关联药学卡片，共用同一题目而不复制内容。'},
  {id:'med-pharm-root',domainId:'medicine-pharmacy',parentId:null,name:'常见药物活性成分',sortOrder:0,description:'按治疗类别归类，介绍化学身份、基础药理、用途范围与主要用药安全知识；不是个人诊疗依据。'},
  ...groups.map(([key,name],i)=>({id:'med-pharm-'+key,domainId:'medicine-pharmacy',parentId:'med-pharm-root',name,sortOrder:i,description:'同一活性成分只建一题；分子式按所声明本体，不将盐、水合物、酯或复方混为同一身份。'})),
];
const tags=[
  ...groups.map(([key,name])=>({id:'med-pharm-'+key,name,domainId:'medicine-pharmacy',kind:'topic',description:'药物学习类别，并不表示同类别药物可互相替换。',color:'#8d58a6'})),
  ...[['identity','活性成分与化学身份'],['mechanism','基础药理与机制'],['safety','禁忌与相互作用'],['source-review','药物信息需复核']].map(([key,name])=>({id:'med-pharm-'+key,name,domainId:'medicine-pharmacy',kind:'topic',description:key==='source-review'?'来源核验日2026-10-22；标签、警示和地区批准情况可能改变，使用前应查当地最新说明书。':'药学与化学交叉知识；记录概念而非个体用药方案。',color:'#8d58a6'})),
];
const questions=rows.map((r,index)=>{
  const v=verifiedByName.get(r.en);
  if(!v?.cid||!v.formula||!v.clinicalUrl||!v.clinicalSha256||!v.pubchemSha256)throw new Error('Unverified identity: '+r.en);
  const refs=[{label:(v.clinicalUrl.includes('nhs.uk')?'NHS（英国）':'NIH MedlinePlus（美国；AHFS患者药物信息）')+'：'+v.clinicalTitle+'；核验2026-10-22',url:v.clinicalUrl},{label:'NIH PubChem CID '+v.cid+'：分子式、结构与化学身份；核验2026-10-22',url:'https://pubchem.ncbi.nlm.nih.gov/compound/'+v.cid}];
  refs.push({label:'NIH PubChem：作用机制资料汇集（参见章节标注的原始来源）；核验2026-10-22',url:'https://pubchem.ncbi.nlm.nih.gov/compound/'+v.cid+'#section=Mechanism-of-Action'});
  if(v.supplementary)refs.push(...v.supplementary.map(s=>({label:s.label+'；核验2026-10-22',url:s.url})));
  return {
    id:'MED-DRUG-'+String(index+1).padStart(6,'0'),title:r.name+'：'+v.formula,
    type:'short_answer',stemMarkdown:`**名称：${r.name}**（${r.en}）\n\n**化学式：${v.formula}**（${r.identity}）\n\n请介绍它的常用药理类别、基本作用机制、用途范围，以及结构相关性质或反应概念；列举主要安全注意点和相互作用。`,
    answerMarkdown:`**类别**：${r.kind}。\n\n**机制**：${r.mechanism}。\n\n**用途范围**：${r.uses}。`,
    explanationMarkdown:`### 化学性质\n\n${r.chemistry}。\n\n### 主要注意点\n\n${r.warning}。\n\n**相互作用举例**：${r.interactions}。这些是重点提示，并非完整禁忌、不良反应或相互作用清单。\n\n### 来源和时效\n\n本卡为公开信息的原创中文学习概要，未声称经过医学专家逐题审定。来源核验日期 **2026-10-22**；美国/英国资料不等于中国批准适应证，具体适用人群、制剂、禁忌和警示须核对当地最新说明书。这里只提供化学与药理知识；剂量、诊断、妊娠/儿童/肝肾功能情况及用药决定应咨询医生或药师。`,
    difficulty:2,depth:2,frequency:0,frequencyScope:'药学与化学基础学习；非面试频次',frequencyBasis:'未统计考试或临床使用频率，不按个人用药推荐排序。',
    collection:'general',status:'pending',categoryIds:['med-pharm-'+r.group,'chem-pharma-root'],tagIds:['med-pharm-'+r.group,'med-pharm-identity','med-pharm-mechanism','med-pharm-safety','med-pharm-source-review'],
    options:[],correctAnswers:[],sourceRefs:refs,sourceDocument:null,sourceAnchor:null,
    createdAt:stamp,updatedAt:stamp,
  };
});
const pack={schemaVersion:1,generatedAt:stamp,domains,categories,tags,questions,documents:[],papers:[],assets:[],questionBanks:[{id:'bank-pharmacology-common-60',name:'常见药物活性成分学习卡（60种）',description:'独立医学与药学领域；同一卡片同时归属化学的药用化学物质分类，避免复制维护。60种活性成分的原创学习概要，来源核验2026-10-22，所有新增卡片为待审核；不是用药指南。',questionIds:questions.map(q=>q.id),createdAt:stamp,updatedAt:stamp}]};
const output=JSON.stringify(pack,null,2)+'\n',digest=createHash('sha256').update(output).digest('hex');
const manifest={
  id:'pharmacology',title:'常见药物活性成分原创学习卡',verifiedAt:'2026-10-22',generatedAt:stamp,
  counts:{questions:questions.length,activeIngredients:60,shortAnswer:60,chemicalIdentitiesVerified:60,clinicalSourcesVerified:60,clinicalExpertReview:0},
  sha256:digest,bytes:Buffer.byteLength(output),questionStatus:'pending',reproduce:'node scripts/content/medicine/pharmacology.mjs',
  taxonomy:'医学与药学按治疗类别组织；每题另引用化学/药用化学物质分类，同一问题只存一份。相近商品名与盐型不重复建题。',
  coverage:'60种常见单活性成分。无阿片类或管制麻醉药；未覆盖所有药物、所有制剂及全部禁忌、相互作用。未包含剂量、个体诊疗或药物合成/提纯操作。',
  regionAndTime:'临床资料主要为NIH MedlinePlus/AHFS（美国），格列齐特、褪黑素补充NHS（英国）；不表示在中国有相同适应证或监管身份。以2026-10-22核验的页面为依据，后续变更须复核当地标签。',
  rights:'题干与中文说明为原创事实概要，不复制AHFS等受版权保护的原文、图片或完整药品说明书。PubChem分子式、CID和结构标识用于核对化学身份；保留逐条出处。缓存的源页面不进入内容包。',
  sourceHashes:'clinicalSha256及mechanismSha256为下载后缓存UTF-8文本的SHA-256；补充来源sha256为下载响应内容的SHA-256。只发布元数据与摘要，不打包源页面全文。',
  limitations:['未由医学专家逐条审定；用户批量审核不应表述为专业医学审定。','临床用药安全信息仅列举重点，不能作为完整禁忌、相互作用或个体用药指南。','同分子式不代表同一立体异构体、盐型、溶剂化物或制剂；卡片题干逐一声明所列本体。'],
  sources:verified,
};
await mkdir(join(root,'data/content-packs'),{recursive:true});await mkdir(join(root,'data/content-sources'),{recursive:true});
await writeFile(join(root,'data/content-packs/pharmacology.json'),output,'utf8');
await writeFile(join(root,'data/content-sources/pharmacology.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
console.log(JSON.stringify({questions:questions.length,sha256:digest,bytes:Buffer.byteLength(output)},null,2));
