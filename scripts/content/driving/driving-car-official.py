"""Extract the official public historical car training document, pending review.

The official page was uploaded in 2025. Its document contains superseded rules;
the upload date is NOT a statement that the questions are current.
Requires Python 3.10+ and Pillow. See --help for the legacy DOC conversion step.
"""
from pathlib import Path
import argparse, base64, collections, hashlib, io, json, re, shutil, subprocess
import unicodedata, urllib.request, zipfile
import xml.etree.ElementTree as ET
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / '.localtools/content-sources/driving-official'
PAGE = 'https://ga.chengde.gov.cn/art/2025/8/20/art_2935_1079682.html'
DOWNLOAD = 'https://ga.chengde.gov.cn/module/download/downfile.jsp?classid=0&filename=50d80ed5a224443d84f0414846eece0a.rar'
RAR_SHA = 'e4a35c88000b70b324696a7e6d6dd74f01679c992923333b2af49e1c24de2924'
DOC_SHA = '37399ae6a5653ff2f7f4b7fd0e5913a2c77bbd66994c20712ed89e9e3a701b51'
STAMP = '2026-10-22T00:00:00Z'
NS = {'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'a':'http://schemas.openxmlformats.org/drawingml/2006/main', 'v':'urn:schemas-microsoft-com:vml'}
tag = lambda prefix, name: '{'+NS[prefix]+'}'+name
sha = lambda value: hashlib.sha256(value).hexdigest()

def download():
    CACHE.mkdir(parents=True, exist_ok=True)
    archive = CACHE / 'chengde-car-2025.rar'
    if not archive.exists():
        request = urllib.request.Request(DOWNLOAD, headers={'User-Agent':'NoeticAtlasStudy/1.0'})
        with urllib.request.urlopen(request, timeout=90) as response:
            archive.write_bytes(response.read())
    if sha(archive.read_bytes()) != RAR_SHA:
        raise ValueError('Official RAR differs from the recorded snapshot; review before updating')
    document = CACHE / 'chengde-car-2025.doc'
    if not document.exists():
        command = shutil.which('7z') or shutil.which('7zz')
        if not command and Path('C:/Program Files/7-Zip/7z.exe').exists():
            command = 'C:/Program Files/7-Zip/7z.exe'
        if not command:
            raise RuntimeError('Install 7-Zip, then rerun --download to extract the pinned legacy DOC')
        binary = subprocess.run([command, 'x', '-so', str(archive)], check=True, capture_output=True).stdout
        if sha(binary) != DOC_SHA:
            raise ValueError('Extracted DOC does not match the official snapshot')
        document.write_bytes(binary)
    elif sha(document.read_bytes()) != DOC_SHA:
        raise ValueError('Cached DOC differs from the recorded source')

def build(path):
    original = json.loads((ROOT/'data/content-packs/driving.json').read_text(encoding='utf-8'))
    assets = {}
    image_uses = []
    with zipfile.ZipFile(path) as archive:
        document = ET.fromstring(archive.read('word/document.xml'))
        relations = {r.attrib['Id']:r.attrib['Target'] for r in ET.fromstring(archive.read('word/_rels/document.xml.rels')) if r.attrib.get('TargetMode') != 'External'}

        def picture(node):
            rid = node.get(tag('r','id')) or node.get(tag('r','embed'))
            target = relations.get(rid)
            if not target or not target.startswith('media/'):
                raise ValueError('Unresolved document image '+str(rid))
            raw = archive.read('word/'+target)
            with Image.open(io.BytesIO(raw)) as source:
                source.load()
                def fraction(value):
                    return float(value[:-1])/65536 if value.endswith('f') else float(value)
                crop = [fraction(node.get('crop'+side, '0')) for side in ['left','top','right','bottom']]
                if any(crop):
                    if any(v<0 or v>=1 for v in crop) or crop[0]+crop[2]>=1 or crop[1]+crop[3]>=1:
                        raise ValueError('Unsupported picture crop')
                    width,height=source.size
                    source=source.crop((round(width*crop[0]),round(height*crop[1]),round(width*(1-crop[2])),round(height*(1-crop[3]))))
                    buffer=io.BytesIO();source.save(buffer,format='PNG');raw=buffer.getvalue()
                mime='image/png' if raw.startswith(b'\x89PNG') else 'image/jpeg'
                width,height=source.size
            identity='drv-car-img-'+sha(raw)[:20]
            assets[identity]={'id':identity,'filename':identity+('.png' if mime=='image/png' else '.jpg'),'mimeType':mime,'sizeBytes':len(raw),'dataBase64':base64.b64encode(raw).decode('ascii'),'width':width,'height':height,'createdAt':STAMP}
            image_uses.append({'relationship':rid,'source':target,'assetId':identity,'cropped':any(crop)})
            return f'\n![官方历史题库插图](/api/assets/{identity}/content)\n'

        paragraphs=[]
        for paragraph in document.findall('w:body/w:p', NS):
            fragments=[]
            for element in paragraph.iter():
                if element.tag==tag('w','t'):fragments.append(element.text or '')
                elif element.tag==tag('w','tab'):fragments.append('    ')
                elif element.tag==tag('w','br'):fragments.append('\n')
                elif element.tag in [tag('v','imagedata'),tag('a','blip')]:fragments.append(picture(element))
            paragraphs.append(unicodedata.normalize('NFKC',''.join(fragments)))
    text='\n'.join(paragraphs)
    starts=list(re.finditer(r'(?<![\d.])(\d+(?:\.\d+){3})(?![\d.])\s*',text))
    if len(starts)!=1347:raise ValueError(f'Unexpected source question count: {len(starts)}')
    scope_positions=[(0,'common')]+[(text.index(label),scope) for label,scope in [('客车专用试题','bus'),('货车专用试题','truck'),('轮式自行机械车专用试题','machine')]]
    categories=list(original['categories'])
    category_specs=[('law','道路法律与驾驶资格'),('signals','交通信号与标志'),('safety','安全文明驾驶'),('conditions','特殊天气与道路'),('emergency','紧急情况处置'),('mechanics','车辆结构与维护'),('aid','事故与急救'),('bus','客车专项'),('truck','货车专项'),('machine','轮式机械车专项')]
    categories.append({'id':'drv-official-car','domainId':'driving','parentId':'drv-root','name':'汽车公开历史题库（2025上传）','description':'官方公开文件，内容含已废止规定；2025是网页上传日，不是题库有效版本。','sortOrder':30})
    for i,(key,name) in enumerate(category_specs):
        categories.append({'id':'drv-official-car-'+key,'domainId':'driving','parentId':'drv-official-car','name':name,'description':'历史公开训练题，须逐题核对现行法规、标志和处置方法。','sortOrder':i})
    historical={'id':'drv-official-car-history','domainId':'driving','kind':'custom','name':'汽车官方历史资料·待时效核验','color':'#9d5b31','description':'官方公开不表示全国全量或现行有效；原答案尚未按2026法规逐条校订。'}
    attention={'id':'drv-official-car-changing-rule','domainId':'driving','kind':'custom','name':'汽车历史题·变动规则优先核验','color':'#ac413c','description':'年龄、分值、处罚、机构、有效期、救护或被废止法规等需要重点复核。'}
    tags=list(original['tags'])+[historical,attention]
    answer_pattern=re.compile(r'(?:答\s*案\s*[:：]?|答\s*[:：]|案\s*[:：])\s*([ABCD正确错误]+)')
    questions=[];fixes=[];counts=collections.Counter();source_ids=collections.Counter();sensitive_count=0
    for index,start in enumerate(starts):
        number=start.group(1)
        scope=max((row for row in scope_positions if row[0]<start.start()),key=lambda row:row[0])[1]
        body=text[start.end():(starts[index+1].start() if index+1<len(starts) else len(text))]
        matches=list(answer_pattern.finditer(body))
        if len(matches)!=1:raise ValueError('Ambiguous source answer '+number)
        answer=matches[0].group(1);content=body[:matches[0].start()].strip()
        # Answers such as “案:正确” and a fullwidth B are retained semantically;
        # record the original spelling before normalizing the interchange form.
        answer_label=matches[0].group(0)
        if not answer_label.startswith('答案:'):fixes.append({'index':index+1,'sourceNumber':number,'sourceLabel':answer_label,'operation':'只规范答案标签/全角字符，未替换原答案。'})
        image_ids=re.findall(r'/api/assets/([^/]+)/content',content)
        choices=list(re.finditer(r'(?m)(?:(?<![A-Za-z0-9])([ABCD])[.、][ \t]*|^[ \t]*([ABCD])(?=[\u3400-\u9fff]))',content))
        option_key=lambda match:match.group(1) or match.group(2)
        for choice in choices:
            if choice.group(2):fixes.append({'index':index+1,'sourceNumber':number,'sourceLabel':choice.group(0).strip(),'operation':'原选项字母后漏标点，只拆分选项键，未修改原选项或答案。'})
        if answer in ['正确','错误']:
            typ='true_false';stem=content;options=[];correct=['true' if answer=='正确' else 'false']
        else:
            typ='single_choice'
            if [option_key(m) for m in choices]!=['A','B','C','D']:
                raise ValueError(f'Unclear option boundaries at {index+1}/{number}: '+content[:240])
            stem=content[:choices[0].start()].strip()
            options=[{'key':option_key(match),'text':content[match.end():(choices[at+1].start() if at+1<len(choices) else len(content))].strip()} for at,match in enumerate(choices)]
            if any(not option['text'] for option in options):raise ValueError('Empty source option '+number)
            correct=[answer]
        topic={'1':'law','2':'signals','3':'safety','4':'conditions','5':'emergency','6':'mechanics','7':'aid'}[number.split('.')[0]] if scope=='common' else scope
        scope_tags={'common':['drv-common'],'bus':['drv-model-a1','drv-model-a3','drv-model-b1'],'truck':['drv-model-a2','drv-model-b2'],'machine':['drv-model-m']}[scope]
        sensitive=bool(re.search(r'罚款|吊销|拘留|扣留|记分|扣分|酒|醉|年龄|周岁|有效期|暂扣|死亡|骨折|止血|人工呼吸|心肺|伤员|123号|91号|72号',content))
        sensitive_count+=sensitive
        alert='【历史资料，待时效核验】官方网页2025年上传，文档含旧法规；下列为原资料题目和原答案，不能直接视作现行考试依据。'
        if sensitive:alert+=' 本题涉及容易变动的法律数值、资格规则或救护操作，应优先复核。'
        source_ids[(scope,number)]+=1;counts[typ]+=1
        label=re.sub(r'!\[[^]]*\]\([^)]*\)','',stem).strip().replace('\n',' ')
        reference=('原资料答案：'+answer) if typ=='true_false' else ('原资料答案：'+answer+'；'+next(o['text'] for o in options if o['key']==answer))
        explanation=f'### 来源与定位\n承德市公安局公开汽车题库附件；原文车型范围：{scope}；原题号：{number}；文档顺序第{index+1}题。\n\n### 原资料答案与审核边界\n{reference}\n\n原资料没有逐题解析。本次只提取原题、选项、答案与图片，没有据此编造新的法律结论。网页上传日为2025-08-20，文档未提供可据以确认现行有效的版本日期，且可见已废止处罚与驾驶资格规定。审核时应以现行法规、交通标志标准与专业救护指南核对；需要修订选项和答案的，应整体修改后再发布。\n\n### 处理说明\n规范全角字母、空白与答案标签，按原文绑定图片；少量图片按Word原裁剪显示。不同车型重用的原题号不合并；来源编号重复另见全包清单。\n\n### 权利与来源\n[官方发布页]({PAGE})；[原始RAR附件]({DOWNLOAD})。提供者为承德市公安局。官网未明示开放数据再分发许可，本次记录其公开学习资料来源，不另行赋予商业或无限制再分发许可。'
        questions.append({'id':f'DRV-CAR-OFFICIAL-{index+1:06d}','title':f'汽车历史题 {index+1:04d} · '+label[:180],'type':typ,'stemMarkdown':alert+'\n\n'+stem,'answerMarkdown':'【历史原答案，未完成现行核验】\n\n'+reference,'explanationMarkdown':explanation,'options':options,'correctAnswers':correct,'difficulty':2 if topic in ['emergency','aid'] else 1,'depth':1,'frequency':0,'frequencyScope':'官方公开历史训练题；不统计现行考试命中频率','frequencyBasis':'未统计；网页发布日期不等于题目现行有效日期','collection':'general','status':'pending','categoryIds':['drv-official-car-'+topic],'tagIds':['drv-subject1',historical['id']]+scope_tags+([attention['id']] if sensitive else []),'sourceRefs':[{'label':'承德公安公开汽车历史题库','url':PAGE},{'label':'原始附件，题号 '+scope+'/'+number,'url':DOWNLOAD}],'sourceDocument':None,'sourceAnchor':None})
    used_assets={identity for q in questions for identity in re.findall(r'/api/assets/([^/]+)/content',json.dumps(q,ensure_ascii=False))}
    output={'schemaVersion':1,'generatedAt':STAMP,'domains':original['domains'],'categories':categories,'tags':tags,'questions':questions,'questionBanks':[{'id':'bank-driving-car-official-historical','name':'汽车公开历史题库（待时效核验）','description':'官方文档标题1346题，实际按原答案可提取1347条；发布日2025不表示现行版本，全部待审核。','questionIds':[q['id'] for q in questions]}],'assets':[asset for identity,asset in assets.items() if identity in used_assets],'documents':[],'papers':[]}
    path_out=ROOT/'data/content-packs/driving-car-official.json';encoded=(json.dumps(output,ensure_ascii=False,separators=(',',':'))+'\n').encode('utf-8');path_out.write_bytes(encoded)
    manifest={'id':'driving-car-official','title':'承德公安公开汽车历史训练题','generatedAt':STAMP,'pageUrl':PAGE,'downloadUrl':DOWNLOAD,'pagePublishedAt':'2025-08-20','contentVersion':'原文未给出现行有效版本；含明确过时法律内容','rarSha256':RAR_SHA,'docSha256':DOC_SHA,'extractedTextSha256':sha(text.encode()),'questionCountClaimedByDocument':1346,'questionCountActuallyParsed':len(questions),'typeCounts':dict(counts),'assets':len(output['assets']),'imageUses':len(image_uses),'croppedImageUses':sum(x['cropped'] for x in image_uses),'scopeCounts':{scope:sum(1 for key in source_ids.elements() if key[0]==scope) for scope in ['common','bus','truck','machine']},'repeatedSourceNumbers':[{'scope':scope,'number':number,'occurrences':count} for (scope,number),count in source_ids.items() if count>1],'sensitiveQuestionsFlagged':sensitive_count,'normalizations':fixes,'status':'pending','rights':'官方公开下载的历史训练资料，页面未明示开放再分发许可；不声明CC0、MIT或任意商业授权。','limitations':['标题1346题与实际1347个题目/答案段不一致，按可解析原文保存并公开计数差异。','2025为网页上传日期，不能称为2025版、2026有效题库或全国完整题库。','题号在车型之间重复，通用题中也有重复编号；依文档顺序生成唯一ID。','保留原答案而非声称现行正确；包含旧罚款、旧酒驾及资格规定，需审核修改后使用。','原文无逐题解释，不为凑解析而编造理由。'],'output':'data/content-packs/driving-car-official.json','sha256':sha(encoded),'rebuild':'python scripts/content/driving/driving-car-official.py --docx <converted-source.docx>'}
    (ROOT/'data/content-sources/driving-car-official.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({key:manifest[key] for key in ['questionCountActuallyParsed','typeCounts','assets','scopeCounts','sensitiveQuestionsFlagged','sha256']},ensure_ascii=False))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download',action='store_true',help='Download/verify official RAR and extract legacy DOC with 7-Zip; convert DOC to DOCX separately')
    parser.add_argument('--docx',type=Path,default=CACHE/'chengde-car-2025.docx',help='Read-only DOC-to-DOCX conversion of the pinned source; enable no macros/links while converting')
    args=parser.parse_args()
    if args.download:download()
    if not args.docx.exists():
        if args.download:
            print('Pinned source downloaded. Convert DOC to DOCX with scripts/content/driving/convert-driving-document.ps1, then rerun this builder.')
            raise SystemExit(0)
        raise SystemExit('Convert the pinned DOC to DOCX first; see docs/题库内容与来源.md')
    build(args.docx)
