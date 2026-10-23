"""Fetch identity facts / ICSC source snapshots for the original inorganic cards.

Read-only source snapshots stay in ignored .localtools. Public provenance retains
identity facts, URLs and hashes, not copyrighted safety-card prose. Requires
Python 3.10+, requests and beautifulsoup4; run the .mjs generator afterwards.
"""
from pathlib import Path
import concurrent.futures, hashlib, json, re, subprocess, time
from urllib.parse import quote, urljoin
import requests
from bs4 import BeautifulSoup

ROOT=Path(__file__).resolve().parents[3]
CACHE=ROOT/'.localtools/content-sources/chemistry-inorganic'
CACHE.mkdir(parents=True, exist_ok=True)
CATALOG=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import r from './scripts/content/chemistry/chemistry-inorganic-catalog.mjs'; console.log(JSON.stringify(r));"],cwd=ROOT,text=True,encoding='utf8'))

def request(url,path):
    if path.exists(): return path.read_bytes()
    for attempt in range(4):
        try:
            r=requests.get(url,timeout=60,headers={'User-Agent':'NoeticAtlasLearningSources/1.0 (+local educational content review)'})
            r.raise_for_status()
            path.write_bytes(r.content)
            time.sleep(.7)
            return r.content
        except requests.RequestException:
            if attempt==3: raise
            time.sleep(2+attempt*3)

index_url='https://chemicalsafety.ilo.org/dyn/icsc/showcard.listCards?p_lang=en'
index=request(index_url,CACHE/'icsc-index.html')
soup=BeautifulSoup(index,'html.parser')
cards=[]
for tr in soup.select('tr'):
    a=tr.select_one('a[href*="p_card_id"]')
    if not a: continue
    tds=tr.find_all('td')
    if len(tds)<2: continue
    cards.append({'id':a.get_text(strip=True),'title':tds[1].get_text(' ',strip=True).split(' - ')[0],'url':urljoin(index_url,a['href'])})

def norm(s):
    return re.sub('[^a-z0-9]','',s.casefold().replace('sulph','sulf').replace('aluminium','aluminum'))

manual={
  'Water':[], 'Hydrogen peroxide':['0164'], 'Hydrogen chloride':['0163'],
  'Sulfuric acid':['0362'], 'Nitric acid':['0183'], 'Phosphoric acid':['1008'],
  'Boric acid':['0991'], 'Carbonic acid':[], 'Hydrogen fluoride':['0283'],
  'Sodium hydroxide':['0360'], 'Potassium hydroxide':['0357'], 'Calcium hydroxide':['0408'],
  'Ammonia':['0414'], 'Aluminium chloride':['1125'],
  'Sodium bicarbonate':['1044'], 'Sodium hypochlorite':['0482','1119'],
  'Calcium hypochlorite':['0638'], 'Sodium chlorite':['1045'],
  'Silicon dioxide':[], 'Quartz':['0808'],
  'Calcium sulfate dihydrate':['1734','1215'], 'Calcium sulfate hemihydrate':['1217'],
  'Sodium bisulfite':['1134'], 'Sodium metasilicate':['0359'],
  'Iron sulfate heptahydrate':[],
  'Iron trichloride':['1499'], 'Iron dichloride':['1715'],
  'Sodium sulfate decahydrate':['0952'], 'Magnesium sulfate heptahydrate':['1197'],
  'Copper sulfate pentahydrate':['1416'], 'Sodium carbonate':['1135'],
  'Potassium alum':[], 'Ammonium bicarbonate':['1333'],
  'Sodium thiosulfate pentahydrate':['1138'], 'Borax decahydrate':['0567'],
  'Sodium tripolyphosphate':['1469'], 'Sulfur':['1166'],
  'Trisodium phosphate':['1178'], 'Zinc sulfate heptahydrate':['0349'],
  'Graphite':['0893'],
}
by_id={c['id']:c for c in cards}
aliases={'Iron sulfate heptahydrate':'Iron(II) sulfate heptahydrate', 'Sulfur':'octasulfur', 'Tin':'tin', 'Monocalcium phosphate monohydrate':'calcium dihydrogen phosphate monohydrate','Sodium tripolyphosphate':'7758-29-4','Iron(III) oxide':'1309-37-1','Iron(II,III) oxide':'1317-61-9','Potassium alum':'7784-24-9','Sodium sulfide':'sodium sulfide anhydrous'}

def identity(irow):
    i,row=irow
    name=aliases.get(row['english'],row['english'])
    url='https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/'+quote(name,safe='')+'/property/MolecularFormula/JSON'
    # These names initially resolved to anhydrous alum / a hydrated sulfide
    # registration. Keep the source cache, and store the precise new query apart.
    path=CACHE/(f'pubchem-{i+1:03}-precise.json' if row['english'] in ['Potassium alum','Sodium sulfide'] else f'pubchem-{i+1:03}.json')
    try:
        raw=request(url,path)
        prop=json.loads(raw)['PropertyTable']['Properties'][0]
        out={'name':row['name'],'english':row['english'],'query':name,'formula':row['formula'],'pubchemCid':prop['CID'],'pubchemFormula':prop['MolecularFormula'],'identityUrl':url,'identitySha256':hashlib.sha256(raw).hexdigest()}
    except Exception as exc:
        return {'name':row['name'],'english':row['english'],'formula':row['formula'],'error':str(exc)}
    if row['english'] in manual:
        candidates=[by_id[c] for c in manual[row['english']] if c in by_id]
    else:
        n=norm(row['english'])
        exact=[c for c in cards if norm(c['title'])==n]
        candidates=exact or [c for c in cards if norm(c['title']).startswith(n+'anhydrous') or norm(c['title']).startswith(n+'compressedgas') or norm(c['title']).startswith(n+'powder')]
    out['icsc']=candidates[:3]
    print(i+1,row['name'],'CID',out['pubchemCid'],'ICSC',','.join(c['id'] for c in out['icsc']),flush=True)
    return out

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    records=list(pool.map(identity,enumerate(CATALOG)))
unique={c['id']:c for r in records for c in r.get('icsc',[])}

def card(c):
    try:
        raw=request(c['url'],CACHE/('icsc-'+c['id']+'.html'))
        plain=BeautifulSoup(raw,'html.parser').get_text(' ',strip=True)
        c['sha256']=hashlib.sha256(raw).hexdigest()
        c['characters']=len(plain)
        (CACHE/('icsc-'+c['id']+'.txt')).write_text(plain,encoding='utf8')
        return c
    except Exception as exc: return {**c,'error':str(exc)}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool: checked={c['id']:c for c in pool.map(card,unique.values())}
for r in records: r['icsc']=[checked[c['id']] for c in r.get('icsc',[])]
out={'checkedAt':'2026-10-22','sourceIndex':{'url':index_url,'sha256':hashlib.sha256(index).hexdigest()},'records':records}
(ROOT/'data/content-sources/chemistry-inorganic-identities.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print('COMPLETE',len(records),'identities',len(checked),'ICSC snapshots','errors',sum(bool(r.get('error')) for r in records),flush=True)
