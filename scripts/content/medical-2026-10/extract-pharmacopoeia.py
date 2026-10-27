"""Extract only identity, traditional function and cautions from an openly
published government pharmacopoeia. Laboratory/dose/process text is not output.
The source edition is recorded explicitly; it is not a live prescribing label.
"""
from pathlib import Path
import hashlib, json, re

ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / 'data/content-cache/medical-2026-10'
URL = 'https://www.mohw.gov.tw/dl-71936-0a89f40d-7558-4ab2-8f4b-55e58de6552b.html'
pdf = CACHE / 'taiwan-pharmacopeia-4.pdf'
pages_file = CACHE / 'pharmacopoeia-pages.json'
if not pages_file.exists():
    import pypdf
    pages_file.write_text(json.dumps([page.extract_text() for page in pypdf.PdfReader(pdf).pages], ensure_ascii=False), encoding='utf-8')
pages = json.loads(pages_file.read_text(encoding='utf-8'))
text = '\n'.join(pages)
heads = list(re.finditer(r'(?:^|\n)([\u4e00-\u9fff]{1,9})[ \t]*\n([A-Z][A-Z \t\n]{5,100})(?=\n[a-zA-Z])', text))
offsets = []; offset = 0
for index, page in enumerate(pages): offsets.append((offset, index+1)); offset += len(page)+1

labels = ['貯藏法', '用途分類', '性味與歸經', '功能', '用法與用量', '注意事項']
def field(body, name):
    match = re.search(name + r'\s*[：:][ \t]*(.*?)(?=(?:' + '|'.join(labels) + r')\s*[：:]|【|\Z)', body, re.S)
    if not match: return ''
    value = re.sub(r'臺灣中藥典第四版\s*\d*', '', match.group(1))
    value = re.sub(r'\s+', '', value)
    return re.sub(r'臺灣中藥典第四版\d*', '', value).strip('。； ')

records = []
def page_at(position): return next(page for offset,page in reversed(offsets) if offset<=position)
for index, match in enumerate(heads):
    end = heads[index+1].start() if index+1<len(heads) else len(text)
    body = text[match.end():end]
    function = field(body, '功能'); group = field(body, '用途分類')
    if not function or not group: continue
    # A field crossing into another material or analysis section is rejected.
    if len(function) > 140 or len(group) > 50: continue
    caution = field(body, '注意事項')
    if len(caution)>200: caution = ''
    start_page = page_at(match.start(1))
    function_match = re.search(r'功能\s*[：:]', body)
    caution_match = re.search(r'注意事項\s*[：:]', body)
    records.append({'name': match.group(1), 'latinHeader': re.sub(r'\s+', ' ', match.group(2)).strip(), 'url': URL, 'pdfPage': start_page,
        'functionPage': page_at(match.end()+function_match.start()) if function_match else start_page,
        'cautionPage': page_at(match.end()+caution_match.start()) if caution_match else None,
        'edition': '台湾中药典第四版（2021公告，2022生效）',
        'fields': {'藥性分類': group, '性味': field(body,'性味與歸經'), '功效': function, '注意事項': caution}})
report = {'records': records, 'source': {'url': URL, 'sha256': hashlib.sha256(pdf.read_bytes()).hexdigest(), 'pages': len(pages)},
          'limitations': '仅抽取传统用途分类、性味归经、功能、注意；没有剂量、制备或实验操作。后续公告修订及地区用途需另核对。'}
(CACHE/'pharmacopoeia-records.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'records':len(records),'cautions':sum(bool(row['fields']['注意事項']) for row in records),'sourcePages':len(pages)},ensure_ascii=False))
