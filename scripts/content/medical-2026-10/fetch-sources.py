"""Cache public primary references. No application database is opened.
Only factual fields are used by the question builder; images and source HTML
remain in ignored data/content-cache and are never put in content packages.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin
import hashlib, json, re, time, requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / 'data/content-cache/medical-2026-10'
CACHE.mkdir(parents=True, exist_ok=True)

def fetch(url, name):
    path = CACHE / name
    if path.exists() and path.stat().st_size > 100:
        return path.read_text(encoding='utf-8')
    for attempt in range(3):
        try:
            response = requests.get(url, timeout=(15, 45))
            response.raise_for_status()
            response.encoding = 'utf-8'
            text = response.text
            path.write_text(text, encoding='utf-8')
            time.sleep(.25)
            return text
        except Exception:
            if attempt == 2: raise
            time.sleep(2 + attempt)

def clean(value):
    return re.sub(r'\s+', ' ', value).strip()

def poly_links():
    links = set()
    for page in range(1, 10):
        url = f'https://herbaltcm.sn.polyu.edu.hk/tc/herbal/search?type=-1&keyword=&page={page}&item=50'
        soup = BeautifulSoup(fetch(url, f'poly-list-{page}.html'), 'html.parser')
        found = {a['href'] for a in soup.select('a[href]') if re.fullmatch(r'https://herbaltcm.sn.polyu.edu.hk/tc/herbal/[a-z0-9-]+', a['href']) and not a['href'].endswith('/search')}
        previous = len(links); links |= found
        print('poly page', page, 'unique', len(links), flush=True)
        if len(links) == previous: break
    return sorted(links)

def poly_record(url):
    slug = url.rsplit('/', 1)[1]
    html = fetch(url, f'poly-{slug}.html')
    soup = BeautifulSoup(html, 'html.parser')
    name = clean(soup.title.get_text()).split('-')[0].strip()
    fields = {}
    for row in soup.select('tr'):
        th, td = row.find('th'), row.find('td')
        if th and td: fields[clean(th.get_text())] = clean(td.get_text(' ', strip=True))
    for accordion in soup.select('.accordion'):
        heading, content = accordion.find('h2'), accordion.select_one('.cke_editable')
        if heading and content:
            fields[clean(heading.get_text())] = clean(content.get_text(' ', strip=True))
    return {'name': name, 'url': url, 'sha256': hashlib.sha256(html.encode()).hexdigest(), 'fields': fields}

def formula_links():
    links = set()
    for page in range(1, 13):
        url = 'https://dep.mohw.gov.tw/DOCMAP/lp-866-108.html' if page == 1 else f'https://dep.mohw.gov.tw/DOCMAP/lp-866-108-{page}-20.html'
        soup = BeautifulSoup(fetch(url, f'formula-list-{page}.html'), 'html.parser')
        found = {urljoin(url, a['href']) for a in soup.select('a[href]') if re.search(r'cp-866-\d+-108\.html', a['href'])}
        previous = len(links); links |= found
        print('formula page', page, 'unique', len(links), flush=True)
        if len(links) == previous: break
    return sorted(links)

def parse_formula_html(html):
    soup = BeautifulSoup(html, 'html.parser')
    # Scope to the article, not footer/navigation. Empty fields must stay empty.
    # Strike-through ingredients in officially revised formulas are withdrawn,
    # not current ingredients (e.g. removed pangolin in Fuyuan Huoxue Tang).
    article = soup.select_one('section.cp article')
    if not article: raise ValueError('Missing formula article')
    for node in article.select('script,style,s,strike,del'): node.decompose()
    labels = ['項次', '方名', '出典', '效能', '適應症', '處方', '注意事項']
    fields = {}
    text = article.get_text('\n', strip=True)
    pattern = r'(?:^|\n)(' + '|'.join(labels) + r')[：:][ \t]*(.*?)(?=\n(?:' + '|'.join(labels) + r')[：:]|\Z)'
    for match in re.finditer(pattern, text, re.S): fields[match.group(1)] = clean(match.group(2))
    return fields

def formula_record(url):
    slug = url.rsplit('/', 1)[1]
    html = fetch(url, 'formula-' + slug)
    fields = parse_formula_html(html)
    return {'name': fields.get('方名', ''), 'url': url, 'sha256': hashlib.sha256(html.encode()).hexdigest(), 'fields': fields}

def nhs_record(row):
    url = row['url']; slug = row['slug']
    html = fetch(url, f'nhs-{slug}.html')
    soup = BeautifulSoup(html, 'html.parser')
    if not soup.find('h1'): raise ValueError('No profile title')
    sources = [{'url': url, 'title': clean(soup.find('h1').get_text()), 'sha256': hashlib.sha256(html.encode()).hexdigest()}]
    links = sorted({urljoin(url, a['href']) for a in soup.select('a[href]') if any(part in a['href'] for part in ['about-', 'who-can-and-cannot', 'taking-', 'side-effects-']) and a['href'].startswith('/medicines/' + slug + '/')})
    for index, child in enumerate(links):
        page = fetch(child, f'nhs-{slug}-{index}.html')
        parsed = BeautifulSoup(page, 'html.parser')
        sources.append({'url': child, 'title': clean(parsed.find('h1').get_text()) if parsed.find('h1') else slug, 'sha256': hashlib.sha256(page.encode()).hexdigest()})
    return {**row, 'sources': sources}

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(); parser.add_argument('--kind', choices=['poly', 'formula', 'nhs', 'all'], default='all'); args = parser.parse_args()
    for kind, listing, reader in [('poly', poly_links, poly_record), ('formula', formula_links, formula_record)]:
        if args.kind not in ['all', kind]: continue
        urls = listing()
        rows, errors = [], []
        def one(url):
            try: return reader(url), None
            except Exception as e: return None, {'url': url, 'error': type(e).__name__}
        with ThreadPoolExecutor(max_workers=3) as pool:
            for index, (row, error) in enumerate(pool.map(one, urls)):
                if row: rows.append(row)
                if error: errors.append(error)
                if index % 20 == 0: print(kind, 'records', index + 1, '/', len(urls), flush=True)
        (CACHE / f'{kind}-records.json').write_text(json.dumps({'records': rows, 'errors': errors}, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'kind': kind, 'records': len(rows), 'unique': len(set(row['name'] for row in rows)), 'errors': errors}, ensure_ascii=False), flush=True)
    if args.kind == 'nhs':
        inputs = json.loads((CACHE / 'modern-drugs-input.json').read_text(encoding='utf-8'))
        rows, errors = [], []
        def one(row):
            try: return nhs_record(row), None
            except Exception as e: return None, {'name': row['name'], 'url': row['url'], 'error': type(e).__name__}
        with ThreadPoolExecutor(max_workers=3) as pool:
            for index, (row, error) in enumerate(pool.map(one, inputs)):
                if row: rows.append(row)
                if error: errors.append(error)
                if index % 10 == 0: print('nhs records', index + 1, '/', len(inputs), flush=True)
        (CACHE / 'nhs-records.json').write_text(json.dumps({'records': rows, 'errors': errors}, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'kind': 'nhs', 'records': len(rows), 'errors': errors}, ensure_ascii=False), flush=True)
