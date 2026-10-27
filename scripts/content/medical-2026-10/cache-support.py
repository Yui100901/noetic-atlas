"""Cache conversion dictionaries and the official pharmacopoeia for extraction.
Existing files are reused. No application database is opened or changed.
"""
from pathlib import Path
import hashlib
import requests

ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / 'data/content-cache/medical-2026-10'
CACHE.mkdir(parents=True, exist_ok=True)
SOURCES = {
    'TSCharacters.txt': 'https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSCharacters.txt',
    'TSPhrases.txt': 'https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSPhrases.txt',
    'opencc-LICENSE': 'https://raw.githubusercontent.com/BYVoid/OpenCC/master/LICENSE',
    'taiwan-pharmacopeia-4.pdf': 'https://www.mohw.gov.tw/dl-71936-0a89f40d-7558-4ab2-8f4b-55e58de6552b.html',
}

if __name__ == '__main__':
    for name, url in SOURCES.items():
        path = CACHE / name
        if not path.exists() or path.stat().st_size < 100:
            response = requests.get(url, timeout=(15, 120))
            response.raise_for_status()
            body = response.content
            if name.endswith('.pdf') and not body.startswith(b'%PDF-'):
                raise ValueError('Official download did not return PDF')
            path.write_bytes(body)
        print(name, path.stat().st_size, hashlib.sha256(path.read_bytes()).hexdigest())
