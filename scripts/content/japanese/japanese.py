#!/usr/bin/env python3
"""Build the Japanese review pack from redistributable, pinned source snapshots.

Python 3.10+, standard library only. Run from any working directory:
    python scripts/content/japanese/japanese.py
    python scripts/content/japanese/japanese.py --refresh

--refresh downloads the same pinned revision again; a source update is a reviewed
change to REVISION and SOURCE_HASHES, not an unrecorded change behind a stable ID.
The source is a study snapshot (May 2026), not an official JLPT syllabus or a
continuously updated dictionary service. Chinese glosses/examples are upstream
LLM output and must remain pending until checked by the user.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import unicodedata
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
CACHE = ROOT / '.localtools' / 'content-sources' / 'japanese'
REVISION = 'e9eb4ab0ddb50f2f6ef7c7dafca6cf1fd4d8ca60'
STAMP = '2026-10-22T00:00:00.000Z'
UPSTREAM = 'https://github.com/zzhuxiaojun-glitch/jmdict-cn'
RAW = f'https://raw.githubusercontent.com/zzhuxiaojun-glitch/jmdict-cn/{REVISION}'
LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1', 'untagged']
SOURCE_HASHES = {
    'N1': '47ffd1537a9ae97dea22b5581f971bcdacb98b6d75c6f1fdd00a28c79c2dca46',
    'N2': 'dbf6387babb07670fafa2d0c0ab30aa5ed9cec0453b6039fc1e2305c32132b35',
    'N3': '78565478a5998f7cbedfb1741edb8d13a350ac18b5cd2a0ec83cc7f80858117f',
    'N4': '9887b900a954bd87ef28a49087241dbdf97ff29b51ad3bba79bbe31272a67524',
    'N5': '14c0fcef7b7fc55d3deed84bd72d564ccb8a19304cb11c811055aa6ac01b464f',
    'untagged': '6f05d818a5f3b5c8c0b2dc7e51d3e020f5d59e84f1cb2fca015c482300fd95fb',
}
POS_ZH = {
    'n': '名词', 'adj-no': '名词性修饰', 'adj-na': 'な形容词', 'adj-i': 'い形容词',
    'adj-ix': 'い形容词（いい类）', 'adj-pn': '连体词', 'adj-f': '前置修饰',
    'adj-t': 'タリ形容词', 'adj-ku': '古典ク活用形容词', 'adv': '副词',
    'adv-to': 'と型副词', 'exp': '表达／短语', 'prt': '助词', 'conj': '接续词',
    'pn': '代词', 'int': '感叹词', 'num': '数词', 'ctr': '量词', 'pref': '接头词',
    'suf': '接尾词', 'n-suf': '名词接尾词', 'n-pref': '名词接头词',
    'vt': '他动词', 'vi': '自动词', 'v1': '一段动词', 'v1-s': '一段动词（特殊）',
    'v5r': '五段动词（る）', 'v5k': '五段动词（く）', 'v5g': '五段动词（ぐ）',
    'v5s': '五段动词（す）', 'v5t': '五段动词（つ）', 'v5n': '五段动词（ぬ）',
    'v5b': '五段动词（ぶ）', 'v5m': '五段动词（む）', 'v5u': '五段动词（う）',
    'v5r-i': '五段动词（る特殊）', 'v5k-s': '行く类五段动词', 'v5u-s': '問う类五段动词',
    'v5aru': 'くださる类五段动词', 'vs': 'サ变动词', 'vs-s': 'する特殊活用',
    'vs-i': 'する不规则活用', 'vs-c': 'す型前身サ变动词', 'vk': 'カ变动词',
    'vz': 'ずる类动词', 'vr': '不规则る动词', 'aux-v': '助动词',
    'aux': '助词性辅助成分', 'aux-adj': '形容词型助动词', 'cop': '系词',
    'v2a-s': '古典二段动词', 'unc': '未分类词性',
}
TOPICS = {
    'particles': '助词与句子成分', 'forms': '活用、可能、被动与使役',
    'aspect': '时态、体与变化', 'honorific': '授受与敬语',
    'conditionals': '条件与让步', 'expressions': '句型、语气与篇章',
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def retrieve(name: str, url: str, expected: str | None, refresh: bool) -> bytes:
    path = CACHE / name
    if refresh or not path.exists():
        request = urllib.request.Request(url, headers={'User-Agent': 'NoeticAtlas-ContentBuilder/1.0'})
        data = urllib.request.urlopen(request, timeout=120).read()
        if expected and digest(data) != expected:
            raise ValueError(f'Checksum mismatch: {name}; do not silently accept changed upstream content')
        path.write_bytes(data)
    data = path.read_bytes()
    if expected and digest(data) != expected:
        raise ValueError(f'Cached checksum mismatch: {name}')
    return data


def primary(entry: dict) -> str:
    written = entry.get('kanji', [])
    readings = entry.get('kana', [])
    candidate = next((x for x in written if x.get('common')), None)
    candidate = candidate or (written[0] if written else None)
    candidate = candidate or next((x for x in readings if x.get('common')), None)
    candidate = candidate or (readings[0] if readings else None)
    return unicodedata.normalize('NFKC', candidate['text']).strip() if candidate else ''


def unique(items: list) -> list:
    return list(dict.fromkeys(items))


def readings_for_head(entries: list[dict], head: str) -> list[str]:
    matches = []
    for entry in entries:
        for reading in entry.get('kana', []):
            applies = reading.get('appliesToKanji') or ['*']
            if '*' in applies or head in [unicodedata.normalize('NFKC', text) for text in applies]:
                matches.append(reading)
    common = [reading for reading in matches if reading.get('common')]
    return unique(unicodedata.normalize('NFKC', reading['text']) for reading in (common or matches))


def glosses(entry: dict, key: str) -> list[str]:
    return [str(g).strip() for sense in entry.get(key, []) if isinstance(sense, dict)
            for g in (sense.get('glosses') or []) if g is not None and str(g).strip()]


def examples(entry: dict) -> list[dict]:
    # Tatoeba snippets are deliberately omitted: this source snapshot retains
    # sentence IDs but not all author/translation attribution needed to relicense.
    return [e for e in entry.get('examples', []) if e.get('source') == 'llm' and e.get('jp') and e.get('zh')]


def eligible(entry: dict) -> bool:
    return bool(primary(entry) and readings_for_head([entry], primary(entry)) and glosses(entry, 'senses_en')
                and glosses(entry, 'senses_zh') and examples(entry))


def daily_rank(item: tuple[str, dict]) -> tuple:
    head, group = item
    senses = [sense for e in group['entries'] for sense in e.get('senses_en', [])]
    misc = set(m for sense in senses for m in sense.get('misc', []))
    # JMdict common is not a corpus frequency rank. Prefer unmarked general
    # senses; within equally marked entries retain stable dictionary order.
    specialist = not any(not s.get('field') for s in senses)
    dated = bool(misc & {'arch', 'obs', 'obsc', 'rare', 'sens'})
    return (dated, specialist, int(group['entries'][0]['id']), head)


def taxonomy() -> tuple[list, list, list]:
    domains = [{'id': 'japanese', 'name': '日语', 'description': '日语词汇、读音、语法与表达；等级为学习参考，不是官方JLPT固定大纲', 'sortOrder': 20}]
    categories = []
    def cat(cid, name, parent, order, description=''):
        categories.append({'id': cid, 'domainId': 'japanese', 'parentId': parent, 'name': name, 'description': description, 'sortOrder': order})
    cat('ja-root', '日语学习', None, 0)
    cat('ja-vocabulary', '单词与表达', 'ja-root', 0)
    cat('ja-grammar', '语法巩固', 'ja-root', 1)
    for i, level in enumerate(LEVELS):
        label = f'{level}参考词汇' if level != 'untagged' else '日常与拓展（未分级）'
        cat(f'ja-vocab-{level.lower()}', label, 'ja-vocabulary', i, '第三方学习分级；非官方完整词表' if level != 'untagged' else '从JMdict common词条补充，未按语料频率排序')
    for i, (key, label) in enumerate(TOPICS.items()):
        cat(f'ja-grammar-{key}', label, 'ja-grammar', i)
    tags = []
    def tag(tid, name, kind='topic', description=''):
        tags.append({'id': tid, 'name': name, 'domainId': 'japanese', 'kind': kind, 'color': '#c45d85', 'description': description})
    for level in LEVELS[:-1]:
        tag(f'ja-{level.lower()}-reference', f'日语{level}参考', description='第三方词表／编写者学习难度参考；不是官方JLPT词汇或语法清单')
    tag('ja-daily', '日语日常与拓展', description='JMdict common未分级词汇；不代表官方或统计前10000词')
    # The product reserves method tags for global study methods. These labels
    # are Japanese-specific, so retain their domain and use custom instead.
    tag('ja-vocabulary-card', '日语单词卡', 'custom')
    tag('ja-upstream-ai-review', '日语上游AI释义待校订', 'custom', '中文释义及例句来自上游LLM生成；进入正式题库前须核对语义、搭配、敬语及译文')
    tag('ja-grammar-practice', '日语语法巩固', 'custom')
    for key, label in TOPICS.items():
        tag(f'ja-{key}', f'日语：{label}')
    for pos, label in [('noun', '名词'), ('verb', '动词'), ('adjective', '形容词'), ('adverb', '副词'), ('function', '功能词'), ('phrase', '短语与其他')]:
        tag(f'ja-pos-{pos}', f'日语{label}')
    return domains, categories, tags


def base_question(qid, title, stem, categories, tags, level) -> dict:
    return {
        'id': qid, 'title': title, 'type': 'short_answer', 'stemMarkdown': stem,
        'answerMarkdown': '', 'explanationMarkdown': '', 'options': [], 'correctAnswers': [],
        'difficulty': {'N5': 1, 'N4': 1, 'N3': 2, 'N2': 3, 'N1': 4, 'untagged': 2}[level],
        'depth': 1, 'frequency': 0, 'frequencyScope': '日语学习',
        'frequencyBasis': '未进行考试命中率或语料频率统计；JLPT标签只作第三方学习参考',
        'collection': 'general', 'status': 'pending', 'categoryIds': categories,
        'tagIds': unique(tags), 'sourceRefs': [], 'sourceDocument': None,
        'sourceAnchor': None,
    }


def pos_tags(codes: list[str]) -> list[str]:
    tags = []
    if any(p == 'n' or p.startswith('n-') for p in codes): tags.append('ja-pos-noun')
    if any(p.startswith('v') or p == 'aux-v' for p in codes): tags.append('ja-pos-verb')
    if any(p.startswith('adj') for p in codes): tags.append('ja-pos-adjective')
    if any(p.startswith('adv') for p in codes): tags.append('ja-pos-adverb')
    if any(p in {'prt', 'conj', 'pref', 'suf', 'aux', 'aux-v', 'aux-adj', 'cop', 'ctr', 'pn', 'num'} for p in codes): tags.append('ja-pos-function')
    if 'exp' in codes or not tags: tags.append('ja-pos-phrase')
    return tags


def load_grammar() -> list[dict]:
    questions = []
    path = Path(__file__).with_name('japanese-grammar.tsv')
    for line in path.read_text(encoding='utf-8').splitlines():
        if not line or line.startswith('#'): continue
        fields = line.split('|')
        if len(fields) != 11: raise ValueError(f'Invalid grammar row: {fields[:3]}')
        level, topic, title, stem, answer, *rest = fields
        distractors, explanation, pitfall, followup = rest[:3], rest[3], rest[4], rest[5]
        number = len(questions) + 1
        choices = [answer, *distractors]
        if len(set(choices)) != 4: raise ValueError(f'Duplicate grammar choices: {title}')
        shift = number % 4
        choices = choices[-shift:] + choices[:-shift] if shift else choices
        q = base_question(f'JA-G-{number:06d}', title, stem,
                          ['ja-grammar', f'ja-grammar-{topic}'],
                          ['ja-grammar-practice', f'ja-{topic}', f'ja-{level.lower()}-reference'], level)
        if number % 6 == 0:
            q.update({'type': 'fill_blank', 'blanks': [{'id': 'b1', 'label': '第1空（从给定候选表达中填写）', 'answers': [answer], 'caseSensitive': False, 'trim': True}]})
            q['stemMarkdown'] = f'请从候选表达中选择一个填入空白处。\n\n{stem}\n\n候选表达：' + ' ／ '.join(choices)
        else:
            q.update({'type': 'single_choice', 'options': [{'key': chr(65 + i), 'text': c} for i, c in enumerate(choices)], 'correctAnswers': [chr(65 + choices.index(answer))]})
            q['stemMarkdown'] = f'请选择在给定语境与题干限定下最合适的一项。\n\n{stem}'
        q['answerMarkdown'] = answer
        q['explanationMarkdown'] = f'**解析**\n\n{explanation}\n\n**易错点与边界**\n\n{pitfall}\n\n**追问／迁移练习**\n\n{followup}\n\n**编写说明**：本题与解析为认知星图原创练习，不是JLPT真题。等级为学习难度参考，待审核后再进入正式题库。'
        q['depth'] = 3 if level == 'N1' else 2
        q['sourceRefs'] = [
            {'label': '日本国际交流基金：いろどり（语法学习参考；未复制习题）', 'url': 'https://www.irodori.jpf.go.jp/'},
            {'label': 'JLPT官方FAQ：不发布固定词汇语法清单', 'url': 'https://www.jlpt.jp/e/faq/index.html'},
        ]
        if topic == 'honorific':
            q['sourceRefs'].append({'label': '文化厅：敬语的基础与五分类（规则参考；题文原创）', 'url': 'https://www.bunka.go.jp/seisaku/kokugo_nihongo/kokugo_shisaku/keigo/chapter2/detail.html'})
        questions.append(q)
    if len(questions) < 120: raise ValueError('At least 120 distinct grammar questions are required')
    return questions


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh', action='store_true', help='Redownload and verify the pinned snapshot')
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    def get_level(level):
        name = f'jmdict-cn-{level}.json'
        url = f'{RAW}/data/{name}'
        data = retrieve(name, url, SOURCE_HASHES[level], args.refresh)
        return level, json.loads(data), {'name': name, 'url': url, 'sha256': digest(data), 'bytes': len(data), 'license': 'CC-BY-SA-4.0'}
    with ThreadPoolExecutor(max_workers=6) as executor:
        downloaded = list(executor.map(get_level, LEVELS))
    groups = {}
    source_rows = 0
    excluded = 0
    for level, rows, _ in downloaded:
        source_rows += len(rows)
        for entry in rows:
            # Some upstream generated arrays contain null placeholders. Retain
            # only real sense objects; never turn null into a fake definition.
            for key in ['senses_en', 'senses_zh', 'examples']:
                entry[key] = [s for s in (entry.get(key) or []) if isinstance(s, dict)]
            for sense in entry['senses_en'] + entry['senses_zh']:
                for key in ['glosses', 'pos', 'misc', 'field', 'info']:
                    if key in sense:
                        sense[key] = [s for s in (sense[key] or []) if isinstance(s, str) and s.strip()]
            if not eligible(entry):
                excluded += 1
                continue
            head = primary(entry)
            group = groups.setdefault(head, {'entries': [], 'levels': []})
            if level not in group['levels']: group['levels'].append(level)
            if entry['id'] not in {e['id'] for e in group['entries']}:
                group['entries'].append(entry)
    tagged = [(h, g) for h, g in groups.items() if any(level != 'untagged' for level in g['levels'])]
    untagged = sorted(((h, g) for h, g in groups.items() if g['levels'] == ['untagged']), key=daily_rank)
    selected = tagged + untagged[:10_000 - len(tagged)]
    if len(selected) != 10_000: raise ValueError('Cannot meet 10000 unique, complete source headwords')
    selected_map = dict(selected)
    by_reading = defaultdict(list)
    by_kanji = defaultdict(list)
    for head, group in selected:
        for reading in readings_for_head(group['entries'], head):
            by_reading[reading].append(head)
        for char in set(re.findall(r'[\u3400-\u9fff]', head)):
            by_kanji[char].append(head)
    ids = {head: f'JA-V-{i + 1:06d}' for i, (head, _) in enumerate(selected)}
    questions = []
    coverage = Counter()
    level_counts = Counter()
    for head, group in selected:
        entries = group['entries']
        levels = [x for x in group['levels'] if x != 'untagged'] or ['untagged']
        level = levels[0]
        level_counts.update(levels)
        readings = readings_for_head(entries, head)
        variants = unique(unicodedata.normalize('NFKC', r['text']) for e in entries for r in e.get('kanji', []) if unicodedata.normalize('NFKC', r['text']) != head)
        codes = unique(p for e in entries for s in e.get('senses_en', []) for p in s.get('pos', []))
        q = base_question(ids[head], f'{head}｜日语单词',
                          f'请写出日语词语 **{head}** 的读音与主要含义，并尝试写一个符合语境的日语句子。\n\n可先回忆再查看答案；参考释义和例句需经人工审核。',
                          ['ja-vocabulary', *[f'ja-vocab-{x.lower()}' for x in levels]],
                          ['ja-vocabulary-card', 'ja-upstream-ai-review', *[f'ja-{x.lower()}-reference' if x != 'untagged' else 'ja-daily' for x in levels], *pos_tags(codes)], level)
        zh = unique(g for e in entries for g in glosses(e, 'senses_zh'))
        q['answerMarkdown'] = f'**读音**：' + ' ／ '.join(readings) + '\n\n**中文主要释义（上游AI生成，待校订）**：' + '；'.join(zh)
        lines = ['**词性**：' + '；'.join(f'{POS_ZH.get(c, c)}（{c}）' for c in codes), '', '**英文释义（JMdict / EDRDG）**', '']
        for e in entries:
            if len(entries) > 1: lines += [f'同形词源条目 {e["id"]}：', '']
            for i, sense in enumerate(e.get('senses_en', []), 1):
                gloss = '; '.join(sense.get('glosses', []))
                if gloss:
                    context = '; '.join(sense.get('info', []))
                    lines.append(f'{i}. {gloss}' + (f'（原词典补充：{context}）' if context else ''))
        lines += ['', '**中文释义与语境（上游AI生成，待校订）**', '']
        for e in entries:
            for i, sense in enumerate(e.get('senses_zh', []), 1):
                text = '；'.join(sense.get('glosses', []))
                if text: lines.append(f'- {text}' + (f'（语境：{sense["context"]}）' if sense.get('context') else ''))
        lines += ['', '**常用语境例句（日中对照；上游AI生成，待核对搭配、敬语与译文）**', '']
        seen_examples = set()
        for e in entries:
            for example in examples(e):
                if example['jp'] in seen_examples: continue
                seen_examples.add(example['jp'])
                lines += [f'- {example["jp"]}', f'  - {example["zh"]}']
        related = []
        if variants: lines += ['', '**同一词条的其他写法**：' + ' ／ '.join(variants)]
        additional_readings = []
        for e in entries:
            for reading in e.get('kana', []):
                value = unicodedata.normalize('NFKC', reading['text'])
                if value in readings:
                    continue
                applies = reading.get('appliesToKanji') or ['*']
                scope = '仅适用写法：' + '、'.join(applies) if '*' not in applies else '其他读音，源条目未标为common'
                additional_readings.append(f'{value}（{scope}）')
        if additional_readings:
            lines += ['', '**其他词形读音说明（不要直接当作本卡词头的常用读音）**：' + '；'.join(unique(additional_readings))]
        same_readings = unique(other for reading in readings for other in by_reading[reading] if other != head)
        if same_readings:
            related += same_readings[:3]
            lines += ['', '**同音联想（不表示同义，需注意重音、语境与词性）**：' + '、'.join(f'[{w}](#/questions/{ids[w]})' for w in same_readings[:3])]
        kanji = set(re.findall(r'[\u3400-\u9fff]', head))
        if kanji:
            candidates = unique(other for char in sorted(kanji) for other in by_kanji[char] if other != head and other not in related)
            candidates.sort(key=lambda w: (-len(kanji & set(w)), abs(len(w) - len(head)), w))
            related += candidates[:3]
            if candidates: lines += ['', '**同字构词联想（自动关联，非近义词判断）**：' + '、'.join(f'[{w}](#/questions/{ids[w]})' for w in candidates[:3])]
        if not related and not variants:
            lines += ['', '**关联词**：无']
        lines += ['', '**学习级别**：' + ('、'.join(levels) + '（第三方参考，非官方N1～N5完整清单）' if level != 'untagged' else 'JMdict common日常与拓展（未分级；不是词频前10000排名）'), '',
                  '**审核重点**：中文释义和上述例句来自上游LLM，可能有义项错配、用词不自然或语法问题。请先以英文义项核对语义，再检查读音、搭配、译文和多义词语境。', '',
                  f'**来源与许可**：JMdict（日英词形、读音、词性和英文释义，© EDRDG / James William Breen）；jmdict-cn（中文释义与LLM例句）。本词卡为选择、重排、去重和添加学习提示后的衍生数据，按CC BY-SA 4.0共享。上游修订 `{REVISION[:12]}`；JMdict源条目ID：' + '、'.join(e['id'] for e in entries) + '。', '',
                  '参考等级由上游第三方JLPT词汇资源标注，不表示官方推荐、官方大纲或考试命中率。未复制Tatoeba句对及商业词典释义。']
        q['explanationMarkdown'] = '\n'.join(lines)
        q['sourceRefs'] = [
            {'label': 'JMdict / EDRDG（日英词典来源）', 'url': 'https://www.edrdg.org/jmdict/j_jmdict.html'},
            {'label': 'EDRDG词典许可与版权说明', 'url': 'https://www.edrdg.org/edrdg/licence.html'},
            {'label': f'jmdict-cn（固定修订{REVISION[:12]}，中文及例句为AI生成）', 'url': f'{UPSTREAM}/tree/{REVISION}'},
            {'label': 'CC BY-SA 4.0许可', 'url': 'https://creativecommons.org/licenses/by-sa/4.0/'},
            {'label': 'JLPT官方FAQ：没有官方固定分级词汇清单', 'url': 'https://www.jlpt.jp/e/faq/index.html'},
        ]
        coverage.update({'reading': bool(readings), 'englishGloss': bool(glosses(entries[0], 'senses_en')), 'chineseGloss': bool(zh), 'partOfSpeech': bool(codes), 'japaneseChineseExamples': bool(seen_examples), 'relatedWordsOrVariants': bool(related or variants), 'verifiedHumanChineseGloss': False, 'verifiedHumanExamples': False})
        questions.append(q)
    grammar = load_grammar()
    domains, categories, tags = taxonomy()
    banks = [
        {'id': 'ja-vocabulary-10000', 'name': '日语10000词学习资料（待审核）', 'description': 'N1～N5第三方参考词与JMdict common未分级补充；中文和例句为上游AI生成，须校订；非官方完整词表。', 'questionIds': [q['id'] for q in questions]},
        {'id': 'ja-grammar-practice-bank', 'name': '日语语法巩固（待审核）', 'description': '助词、活用、授受敬语、时体、条件与高级句型，题目原创；不是真题。', 'questionIds': [q['id'] for q in grammar]},
    ]
    pack = {'schemaVersion': 1, 'generatedAt': STAMP, 'domains': domains, 'categories': categories, 'tags': tags, 'questions': questions + grammar, 'questionBanks': banks, 'documents': [], 'papers': []}
    write_json(ROOT / 'data/content-packs/japanese.json', pack)
    grammar_types = Counter(q['type'] for q in grammar)
    manifest = {
        'id': 'japanese', 'title': '日语词汇与语法待审核扩展包', 'generatedAt': STAMP,
        'license': 'CC-BY-SA-4.0', 'packPath': 'data/content-packs/japanese.json',
        'upstream': {'repository': UPSTREAM, 'commit': REVISION, 'commitDate': '2026-05-20T18:20:05Z', 'checkedAt': STAMP, 'sourceDictionary': 'JMdict / EDRDG via scriptin/jmdict-simplified', 'languageLevels': 'Third-party JLPT study labels; not an official fixed syllabus', 'chineseAndExamplesOrigin': 'Upstream LLM-generated, not human-verified dictionary translations', 'tatoebaReused': False},
        'sources': [x[2] for x in downloaded],
        'officialReferences': [
            {'label': 'JLPT official FAQ: no published fixed Test Content Specifications after 2010', 'url': 'https://www.jlpt.jp/e/faq/index.html'},
            {'label': 'EDRDG dictionary license', 'url': 'https://www.edrdg.org/edrdg/licence.html'},
            {'label': 'Culture Agency honorific guidance', 'url': 'https://www.bunka.go.jp/seisaku/kokugo_nihongo/kokugo_shisaku/keigo/chapter2/detail.html'},
        ],
        'statistics': {'sourceRows': source_rows, 'sourceUniqueEntryIds': len({e['id'] for _, rows, _ in downloaded for e in rows}), 'eligibleHeadwordGroups': len(groups), 'excludedIncompleteRows': excluded, 'vocabulary': len(questions), 'uniqueNormalizedHeadwords': len(set(selected_map)), 'grammar': len(grammar), 'grammarTypes': dict(grammar_types), 'total': len(questions) + len(grammar), 'published': 0, 'pending': len(questions) + len(grammar), 'wordLevelReferenceCounts': dict(level_counts)},
        'coverage': {key: {'count': coverage[key], 'of': 10_000, 'percent': round(coverage[key] / 100, 2)} for key in ['reading', 'englishGloss', 'chineseGloss', 'partOfSpeech', 'japaneseChineseExamples', 'relatedWordsOrVariants', 'verifiedHumanChineseGloss', 'verifiedHumanExamples']},
        'selection': 'Merge identical NFKC headwords and original entry IDs; retain all usable N1-N5 tagged headwords, then supplement to 10000 from JMdict common untagged entries, preferring non-archaic general senses. Dictionary order is not corpus frequency order. Homographs may include multiple readings/senses in one card.',
        'transformation': ['Extract source glosses/readings/POS', 'Omit all Tatoeba examples to avoid incomplete author attribution', 'Retain only explicitly LLM-labelled Japanese/Chinese example pairs', 'Create vocabulary short-answer prompts', 'Add linked homophone/character associations, explicitly not synonym claims', 'Author 132 distinct grammar items, explanatory boundaries and follow-up prompts', 'Keep all new content pending and frequency=0'],
        'limitations': ['N1-N5 labels are third-party study references, not official exhaustive vocabulary or grammar lists.', 'Chinese glosses and Japanese/Chinese examples are upstream LLM output; verified-human coverage is 0%, and all imported cards require review.', 'The May 2026 source is a fixed learning snapshot; it is not the latest continuously maintained JMdict dictionary. Refresh source pin and checksums before periodic content updates.', 'Related vocabulary is automatically linked by shared reading or characters, not a claim of synonymy/antonymy; missing relationships are explicitly marked.'],
        'rebuild': 'python scripts/content/japanese/japanese.py; --refresh redownloads the same pinned, checksum-verified upstream revision. To update, review a new upstream commit, update REVISION/SOURCE_HASHES and rerun; compare semantic changes and repeat user review before publishing.',
        'notices': ['docs/licenses/japanese-NOTICE.md', 'docs/licenses/japanese-CC-BY-SA-4.0.txt', 'docs/licenses/japanese-upstream-ATTRIBUTION.md'],
    }
    write_json(ROOT / 'data/content-sources/japanese.json', manifest)
    notice_dir = ROOT / 'docs/licenses'
    notice_dir.mkdir(parents=True, exist_ok=True)
    attribution = retrieve('ATTRIBUTION.md', f'{RAW}/ATTRIBUTION.md', 'd150f992e01102d2019a6c52ac7b727f1932e53794796a013ca2109328f0f921', args.refresh)
    (notice_dir / 'japanese-upstream-ATTRIBUTION.md').write_bytes(attribution)
    license_bytes = retrieve('CC-BY-SA-4.0.txt', 'https://raw.githubusercontent.com/spdx/license-list-data/main/text/CC-BY-SA-4.0.txt', None, args.refresh)
    (notice_dir / 'japanese-CC-BY-SA-4.0.txt').write_bytes(license_bytes)
    edrdg_bytes = retrieve('edrdg-license.html', 'https://www.edrdg.org/edrdg/licence.html', None, args.refresh)
    (notice_dir / 'japanese-EDRDG-license.html').write_bytes(edrdg_bytes)
    print(json.dumps({'vocabulary': len(questions), 'grammar': len(grammar), 'status': 'pending', 'coverage': manifest['coverage']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
