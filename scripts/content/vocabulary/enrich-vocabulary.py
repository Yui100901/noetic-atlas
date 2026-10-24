"""Rebuild structured pronunciation/gloss supplements without opening the database.

Run from the project root. Downloads are pinned/cached; the output patch updates
only vocabulary/sourceRefs, so application by the release maintainer cannot
restore old question text or change a question's review status.
"""
from __future__ import annotations
import argparse, hashlib, json, pathlib, re, shutil, unicodedata, urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[3]
CACHE = ROOT / '.localtools/content-sources/pronunciation'
OUT = ROOT / 'data/content-sources/vocabulary'
REV = '972cd67dd5f96bc5660e28070cde26e3928abcd7'
IPA = f'https://raw.githubusercontent.com/open-dict-data/ipa-dict/{REV}'
LOC = 'https://www.loc.gov/catdir/cpso/romanization/japanese.pdf'
GLOSS_OVERRIDES = {
    'EN-V-009528': '表示过去的习惯或已经结束的状态；亦可在固定搭配中表示习惯于。',
    'JA-V-001087': '以连续或单幅图画叙事或表达讽刺的作品。',
    'JA-V-001867': '含乙醇的饮料；亦指日本米酿饮品。',
    'JA-V-003368': '由私人或民间团体设立和经营，常用于学校或机构。',
    'JA-V-003874': '日本的一种短诗体，通常以五、七、五拍组成十七拍，并常含季节用语。',
    'JA-V-004183': '夏季或沐浴后穿着的轻薄棉质日式衣服。',
    'JA-V-008160': '位于非洲北部、横跨大西洋沿岸至红海附近的广大热带沙漠地区。',
}

def fetch(url: str, target: pathlib.Path):
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(url, headers={'User-Agent': 'NoeticAtlas-vocabulary-enrichment/1.0'})
        with urllib.request.urlopen(req, timeout=90) as r: target.write_bytes(r.read())
    return target

def ipa_map(region):
    path = fetch(f'{IPA}/data/{region}.txt', CACHE / f'{region}.txt')
    return dict(row.split('\t', 1) for row in path.read_text(encoding='utf-8').splitlines() if '\t' in row)

# Roman numerals and units use a declared expansion, never an invented lexical
# IPA. Spelling variants cite the exact source spelling actually looked up.
EXPANSIONS = {
    'cigaret': ('cigarette', '异体拼写'), 'cm': ('centimetre', '单位展开'),
    'ft': ('feet', '单位展开'), 'ii': ('two', '罗马数字数值读法'),
    'iii': ('three', '罗马数字数值读法'), 'iv': ('four', '罗马数字数值读法'),
    'ix': ('nine', '罗马数字数值读法'), 'kg': ('kilogram', '单位展开'),
    'km': ('kilometre', '单位展开'), 'ml': ('millilitre', '单位展开'),
    'living-room': ('livingroom', '拼写变体'), 'offence': ('offense', '拼写变体'),
    'vii': ('seven', '罗马数字数值读法'), 'viii': ('eight', '罗马数字数值读法'),
    'waggon': ('wagon', '异体拼写'), 'world-wide': ('worldwide', '拼写变体'),
    'xv': ('fifteen', '罗马数字数值读法'),
}

def source_reading(ipa, region, label=None, method='source'):
    return dict(label=label or ('英式（RP）' if region == 'en_UK' else '美式（GA）'), ipa=ipa,
                sourceLabel=f'ipa-dict {REV[:12]} / {region}（上游含自动转录）',
                sourceUrl=f'https://github.com/open-dict-data/ipa-dict/blob/{REV}/data/{region}.txt',
                license='GPL-3.0' if region == 'en_UK' else 'MIT', method=method)

def english_readings(word, us, uk):
    direct = [source_reading(mapping[word], region) for region, mapping in [('en_UK', uk), ('en_US', us)] if word in mapping]
    if direct: return direct, None
    # A tiny supplement from Wiktionary via Kaikki; no dictionary definitions are
    # copied here. Only IPA facts and dialect tags are retained, with attribution.
    url = f'https://kaikki.org/dictionary/English/meaning/{word[0]}/{word[:2]}/{word}.jsonl'
    path = CACHE / f'kaikki-{word}.jsonl'
    try: fetch(url, path)
    except Exception:
        if not path.exists(): path = None
    sounds = []
    if path:
        for row in path.read_text(encoding='utf-8').splitlines():
            item = json.loads(row)
            if item.get('lang_code') != 'en': continue
            for sound in item.get('sounds', []):
                phon = sound.get('ipa', '')
                tags = sound.get('tags', [])
                if not phon.startswith('/') or any(tag in tags for tag in ['South-Asia', 'Malaysia', 'Singapore', 'Nigeria']): continue
                # pram's /pra:m/ is a different sense (flat-bottomed boat); our
                # card is the baby carriage, so keep the first relevant reading.
                if word == 'pram' and phon != '/pɹæm/': continue
                label = '英式（RP）' if 'Received-Pronunciation' in tags else '英式' if 'UK' in tags else '美式（GA）' if 'General-American' in tags else '通用读音（来源未分英美）'
                reading = dict(label=label, ipa=phon, sourceLabel=f'Wiktionary contributors / Kaikki: {word}', sourceUrl=url.removesuffix('.jsonl')+'.html', license='CC-BY-SA-4.0', method='source')
                if reading not in sounds: sounds.append(reading)
    if sounds: return sounds, dict(word=word, method='Wiktionary source', url=url, readings=sounds)
    spelling, reason = EXPANSIONS[word]
    readings = [source_reading(mapping[spelling], region,
                f'{"英式（RP）" if region=="en_UK" else "美式（GA）"} · {reason} {spelling}', 'expanded')
                for region, mapping in [('en_UK', uk), ('en_US', us)] if spelling in mapping]
    assert readings, (word, spelling)
    return readings, dict(word=word, method=reason, sourceSpelling=spelling, readings=readings)

BASE = dict(zip('あいうえおかきくけこがぎぐげござじずぜぞさしすせそただぢづでどちつてとなにぬねのはひふへほばびぶべぼぱぴぷぺぽまみむめもやゆよらりるれろわゐゑをんゔぁぃぅぇぉゃゅょゎゕゖ',
                'a i u e o ka ki ku ke ko ga gi gu ge go za ji zu ze zo sa shi su se so ta da ji zu de do chi tsu te to na ni nu ne no ha hi fu he ho ba bi bu be bo pa pi pu pe po ma mi mu me mo ya yu yo ra ri ru re ro wa wi we o n vu a i u e o ya yu yo wa ka ke'.split()))
DIGRAPHS = {}
for lead, prefix in [('き','ky'),('ぎ','gy'),('し','sh'),('じ','j'),('ち','ch'),('ぢ','j'),('に','ny'),('ひ','hy'),('び','by'),('ぴ','py'),('み','my'),('り','ry')]:
    for tail, vowel in [('ゃ','a'),('ゅ','u'),('ょ','o')]: DIGRAPHS[lead+tail] = prefix+vowel
DIGRAPHS.update(dict(zip('いぇ うぃ うぇ うぉ きぇ ぎぇ しぇ じぇ ちぇ てぃ でぃ とぅ どぅ てゅ でゅ つぁ つぃ つぇ つぉ ふぁ ふぃ ふぇ ふぉ ふゅ ゔぁ ゔぃ ゔぇ ゔぉ ゔゅ くぁ くぃ くぇ くぉ ぐぁ'.split(),
                          'ye wi we wo kye gye she je che ti di tu du tyu dyu tsa tsi tse tso fa fi fe fo fyu va vi ve vo vyu kwa kwi kwe kwo gwa'.split())))

def romanize(kana):
    text = ''.join(chr(ord(c)-0x60) if 'ァ' <= c <= 'ヶ' else c for c in unicodedata.normalize('NFKC', kana))
    parts=[]; i=0; geminate=False
    while i < len(text):
        c=text[i]
        if c=='っ': geminate=True; i+=1; continue
        if c=='ー':
            if parts:
                parts[-1]=re.sub(r'[aeiou]$', lambda m: dict(a='ā',e='ē',i='ī',o='ō',u='ū')[m[0]], parts[-1])
            i+=1; continue
        pair=text[i:i+2]
        if pair in DIGRAPHS: token=DIGRAPHS[pair]; i+=2
        else: token=BASE.get(c, '-' if c=='・' else c); i+=1
        if geminate:
            token=('t' if token.startswith('ch') else token[0] if token[0] not in 'aeioun' else '')+token
            geminate=False
        if parts and parts[-1]=='n' and token[0] in 'aeiouy': parts[-1]="n'"
        parts.append(token)
    result=''.join(parts)
    if re.search("[^a-zāēīōū'-]",result): raise ValueError(f'非假名读音无法规则转写: {kana} => {result}')
    return result

def norm(value): return unicodedata.normalize('NFKC',value).lower().strip()
def contains(prompt, word):
    token=norm(word).strip('/')
    return bool(re.search(r'(?<![a-z0-9])'+re.escape(token)+r'(?![a-z0-9])', norm(prompt))) if re.fullmatch(r"[a-z0-9' -]+",token) else token in norm(prompt)

def safe_hint(q, v):
    answer=q['answerMarkdown']; candidates=[]
    if v['language']=='en':
        for pattern in [r'中文义项[：:]([^\n]+)',r'\*\*中文释义\*\*[：:]([^\n]+)']:
            candidates += re.findall(pattern,answer)
    else:
        candidates += re.findall(r'\*\*中文主要释义[^\n]*?\*\*[：:]([^\n]+)',answer)
    forbidden=[v['headword']]+v['acceptedAnswers']+[r[k] for r in v['pronunciations'] for k in ['ipa','kana','romaji'] if k in r]
    clean=[]
    for candidate in candidates:
        for clause in re.split('[；;\n]|[。](?!$)',candidate):
            clause=re.sub(r'[*`#]|https?://\S+', '',clause).strip()
            if clause and not any(contains(clause,t) for t in forbidden) and clause not in clean: clean.append(clause)
    if not clean:
        english=re.findall(r'(?:English:|\*\*English definition\*\*[：:])\s*([^\n]+)',answer)
        if v['language']=='ja':
            m=re.search(r'\*\*英文释义[^\n]*\*\*\s+(.+?)(?:\n\n\*\*|$)',q['explanationMarkdown'],re.S)
            if m: english += [re.sub(r'^\d+\.\s*','',line) for line in m[1].splitlines() if line.strip()]
        clean=[c for c in english if not any(contains(c,t) for t in forbidden)][:3]
    # Empty disables reverse practice, rather than manufacturing an answer hint.
    return GLOSS_OVERRIDES.get(q['id'],'；'.join(clean)[:7800])

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--no-write-packs',action='store_true');args=parser.parse_args()
    CACHE.mkdir(parents=True,exist_ok=True); OUT.mkdir(parents=True,exist_ok=True)
    us,uk=ipa_map('en_US'),ipa_map('en_UK')
    fetch(f'{IPA}/LICENSE',CACHE/'LICENSE')
    fetch(f'{IPA}/README.md',CACHE/'README.md')
    fetch('https://raw.githubusercontent.com/lingz/cmudict-ipa/master/LICENSE',CACHE/'cmudict-ipa-MIT.txt')
    fetch('https://raw.githubusercontent.com/leoboiko/ipacards/master/CREDITS',CACHE/'ipacards-CREDITS.txt')
    fetch('https://raw.githubusercontent.com/leoboiko/ipacards/master/LICENSE',CACHE/'GPL-3.0.txt')
    fetch('https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt',CACHE/'CC-BY-SA-4.0.txt')
    patch=[]; report={'generatedAt':datetime.now(timezone.utc).isoformat(),'ipaDictRevision':REV,'domains':{},'missingDirectIPA':[]}
    for language,prefix in [('english','EN-V-'),('japanese','JA-V-')]:
        path=ROOT/f'data/content-packs/{language}.json';pack=json.loads(path.read_text(encoding='utf-8-sig')); count=0; nohint=[];sourcecounts={}
        for q in pack['questions']:
            if not q['id'].startswith(prefix):continue
            head=q['title'].split('｜')[0]
            if language=='english':
                readings,note=english_readings(head.lower(),us,uk)
                if note:report['missingDirectIPA'].append(note)
                v=dict(language='en',headword=head,meaningPrompt='',acceptedAnswers=[head],pronunciations=readings)
            else:
                kana=re.search(r'\*\*读音\*\*：([^\n]+)',q['answerMarkdown'])[1].split(' ／ ')
                readings=[dict(label='假名 / 罗马音',kana=k,romaji=romanize(k),sourceLabel='JMdict 词条假名；赫本式规则自动转写（长音 ou/oo 保留假名，ー 用长音符；非音高标注）',sourceUrl='https://www.edrdg.org/jmdict/j_jmdict.html',license='CC-BY-SA-4.0（JMdict 假名）；罗马音为规则转换',method='transliteration') for k in kana]
                v=dict(language='ja',headword=head,meaningPrompt='',acceptedAnswers=list(dict.fromkeys([head]+kana)),pronunciations=readings)
            v['meaningPrompt']=safe_hint(q,v)
            if not v['meaningPrompt']:nohint.append(q['id'])
            refs=[dict(label='读音来源：'+r['sourceLabel'],url=r['sourceUrl']) for r in readings]
            refs=list({r['url']:r for r in refs}.values())
            patch.append(dict(id=q['id'],vocabulary=v,sourceRefsAdded=refs))
            q['vocabulary']=v
            existing={r['url'] for r in q['sourceRefs']}
            q['sourceRefs'] += [r for r in refs if r['url'] not in existing]
            count+=1
            for r in readings:sourcecounts[r['label']]=sourcecounts.get(r['label'],0)+1
        if not args.no_write_packs:path.write_text(json.dumps(pack,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        report['domains'][language]=dict(cards=count,reverseEligible=count-len(nohint),reverseUnavailable=nohint,pronunciationLabels=sourcecounts)
    (ROOT/'.localtools/vocabulary-enrichment.json').write_text(json.dumps(dict(format='noetic-atlas-vocabulary-supplement',schemaVersion=1,generatedAt=report['generatedAt'],questions=patch),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    # Redistribution includes editable source tables and complete license texts.
    # The supplement is data under the applicable source terms, not a change to
    # the application's own license. Packagers already include content-sources.
    source_out=OUT/'source-data'; source_out.mkdir(exist_ok=True)
    for p in CACHE.iterdir():
        if p.is_file() and (p.name in ['en_US.txt','en_UK.txt','LICENSE','README.md','GPL-3.0.txt','CC-BY-SA-4.0.txt','cmudict-ipa-MIT.txt','ipacards-CREDITS.txt'] or p.name.startswith('kaikki-')): shutil.copy2(p,source_out/p.name)
    shutil.copy2(pathlib.Path(__file__),source_out/'rebuild-enrichment.py.txt')
    (OUT/'NOTICE.md').write_text(pathlib.Path(__file__).with_name('README.md').read_text(encoding='utf-8')+'\n\n本补充生成日期：'+report['generatedAt']+'。IPA 原始表未改写；仅按词头选择、归入方言标签并关联原题。Wiktionary 仅抽取标注方言的 IPA 与来源；另附原条目供追溯。英式 IPA 衍生字段继续按 GPL-3.0 提供，美式 IPA 按 MIT，Wiktionary 与原 JMdict 衍生字段按 CC BY-SA 4.0；这是不同来源的汇编，不将其中一种许可宣称为全部数据或应用代码的许可。source-data/rebuild-enrichment.py.txt 是本次转换脚本的可编辑原文；在项目 scripts/content/vocabulary/ 下使用 .py 文件名运行。\n',encoding='utf-8')
    report['originalGlossParaphrases']=GLOSS_OVERRIDES
    report['sourceFiles']=[dict(path=str(p.relative_to(ROOT)).replace('\\','/'),sha256=hashlib.sha256(p.read_bytes()).hexdigest(),bytes=p.stat().st_size) for p in CACHE.iterdir() if p.is_file()]
    (OUT/'enrichment-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k not in ['sourceFiles','missingDirectIPA']},ensure_ascii=False,indent=2))

if __name__=='__main__':main()
