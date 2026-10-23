#!/usr/bin/env python3
"""Build the review-only English content pack using explicitly reusable lexical data.

Python 3.10+, standard library only. Run from any directory:
    python scripts/content/english/english.py
    python scripts/content/english/english.py --download

Raw sources stay in the ignored .localtools/content-sources directory.  On first
download verify the recorded hashes; subsequent rebuilds fail closed on changes.
No Oxford/Longman/Collins dictionary text is used. ECDICT contributes only factual
word-list labels, frequency ranks and inflection metadata, never definitions.
"""
from __future__ import annotations

import argparse
import bz2
import collections
import csv
import hashlib
import importlib.util
import json
import pathlib
import re
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
CACHE = ROOT / '.localtools' / 'content-sources'
PACK = ROOT / 'data' / 'content-packs' / 'english.json'
MANIFEST = ROOT / 'data' / 'content-sources' / 'english.json'
NOTICE = ROOT / 'data' / 'content-sources' / 'english-NOTICE.md'
GENERATED_AT = '2026-10-22T00:00:00.000Z'
ECDICT_REV = 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b'
NLTK_REV = '550b6625bcef1f2abff2ff770a5a0d272c9c6b2a'
RESOURCES = {
    'wordnet.zip': f'https://raw.githubusercontent.com/nltk/nltk_data/{NLTK_REV}/packages/corpora/wordnet.zip',
    'omw.zip': f'https://raw.githubusercontent.com/nltk/nltk_data/{NLTK_REV}/packages/corpora/omw-1.4.zip',
    'ecdict.csv': f'https://raw.githubusercontent.com/skywind3000/ECDICT/{ECDICT_REV}/ecdict.csv',
    'ecdict-license.txt': f'https://raw.githubusercontent.com/skywind3000/ECDICT/{ECDICT_REV}/LICENSE',
    'tatoeba-eng.tsv.bz2': 'https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences_detailed.tsv.bz2',
}
EXAM_TAGS = {'gk': ('en-gk-source', '高考词汇（ECDICT 标注）'),
             'cet4': ('en-cet4-source', '四级词汇（ECDICT 标注）'),
             'cet6': ('en-cet6-source', '六级词汇（ECDICT 标注）')}
POS = {'n': 'noun / 名词', 'v': 'verb / 动词', 'a': 'adjective / 形容词', 'r': 'adverb / 副词'}
# Original Chinese descriptions of WordNet's numbered syntactic frames.
# These are structural patterns with placeholders, not invented example sentences.
FRAMES = {
  1:'某物 + 动词', 2:'某人 + 动词', 3:'It is + 动词-ing', 4:'某物 + be + 动词-ing + 介词短语',
  5:'某物 + 动词 + 某物 + 形容词／名词补语', 6:'某物 + 动词 + 形容词／名词补语',
  7:'某人 + 动词 + 形容词补语', 8:'某人 + 动词 + 某物', 9:'某人 + 动词 + 某人',
 10:'某物 + 动词 + 某人', 11:'某物 + 动词 + 某物', 12:'某物 + 动词 + to + 某人',
 13:'某人 + 动词 + on + 某物', 14:'某人 + 动词 + 某人 + 某物（双宾语）',
 15:'某人 + 动词 + 某物 + to + 某人', 16:'某人 + 动词 + 某物 + from + 某人',
 17:'某人 + 动词 + 某人 + with + 某物', 18:'某人 + 动词 + 某人 + of + 某物',
 19:'某人 + 动词 + 某物 + on + 某人', 20:'某人 + 动词 + 某人 + 介词短语',
 21:'某人 + 动词 + 某物 + 介词短语', 22:'某人 + 动词 + 介词短语', 23:'某人的身体部位 + 动词',
 24:'某人 + 动词 + 某人 + to do', 25:'某人 + 动词 + 某人 + 不带 to 的原形',
 26:'某人 + 动词 + that 从句', 27:'某人 + 动词 + to + 某人', 28:'某人 + 动词 + to do',
 29:'某人 + 动词 + whether + 不定式', 30:'某人 + 动词 + 某人 + into doing something',
 31:'某人 + 动词 + 某物 + with + 某物', 32:'某人 + 动词 + 不带 to 的原形',
 33:'某人 + 动词 + doing', 34:'It + 动词 + that 从句', 35:'某物 + 动词 + 不带 to 的原形',
}
SENSITIVE = re.compile(r'\b(?:fuck\w*|shit\w*|nigg\w*|rape\w*|porn\w*|suicid\w*|kill\w*|murder\w*|sex\w*|naked|drunk|bastard\w*|bitch\w*)\b', re.I)
# Original, non-graphic learning examples for examination-source words that have
# no suitable open example in the selected sense. These are never dictionary quotes.
ORIGINAL_EXAMPLES = {
 'accessary':'The court found him an accessary to the theft.',
 'alteration':'The alteration to the timetable caused some confusion.',
 'by-product':'Sawdust is a by-product of cutting wood.',
 'curative':'The treatment has a curative effect on this condition.',
 'deformation':'The engineer measured the deformation of the beam under load.',
 'despatch':'The warehouse will despatch the parcel this afternoon.',
 'drunk':'The passengers realised that the driver was drunk.',
 'dynamical':'The students compared two dynamical models of the pendulum.',
 'endow':'The donation will endow a scholarship for future students.',
 'first-rate':'The workshop offered first-rate practical training.',
 'glasshouse':'The seedlings grew quickly inside the glasshouse.',
 'gramme':'The sample weighs less than one gramme.',
 'kill':'High temperatures can kill many types of bacteria.',
 'kilowatt':'The motor has a rated output of one kilowatt.',
 'living-room':'The living-room window faces the garden.',
 'maturation':'The study tracked the maturation of the young trees.',
 'murder':'The detective investigated a murder near the station.',
 'naked':'The distant stars were visible to the naked eye.',
 'perplex':'The conflicting instructions may perplex new users.',
 'practicable':'The plan is attractive, but it is not practicable with our budget.',
 'reflexion':'She paused for a moment of quiet reflexion.',
 'resultant':'The resultant force points to the left in this diagram.',
 'sex':"The form asks for the applicant's age and sex.",
 'sexual':'The workplace policy prohibits sexual harassment.',
 'so-called':'The so-called shortcut took much longer than the main road.',
 'strangler':'The story follows a detective searching for a strangler.',
 'subscript':'The numeral in the chemical formula appears as a subscript.',
 'suicide':'The article discusses suicide prevention and available support services.',
 'touchable':'The exhibit includes touchable models for young visitors.',
 'up-to-date':'The technician keeps an up-to-date record of every inspection.',
 'upside-down':'The upside-down image made the diagram difficult to read.',
 'ware':'The merchant displayed the ware on a low table.',
 'world-wide':'The charity launched a world-wide appeal for donations.',
 'x-ray':'An x-ray showed that the bone was not broken.',
}


def sha(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def resources(download: bool):
    CACHE.mkdir(parents=True, exist_ok=True)
    previous = json.loads(MANIFEST.read_text(encoding='utf-8')) if MANIFEST.exists() else {}
    expected = {r['file']: r['sha256'] for r in previous.get('resources', [])}
    result = []
    for name, url in RESOURCES.items():
        target = CACHE / name
        if not target.exists():
            if not download:
                raise SystemExit(f'Missing {name}. Re-run with --download; inspect the upstream license first.')
            temp = target.with_suffix(target.suffix + '.download')
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'NoeticAtlas-content/1.0'}), timeout=120) as source, temp.open('wb') as dest:
                while chunk := source.read(1024 * 1024):
                    dest.write(chunk)
            temp.replace(target)
        digest = sha(target)
        if name in expected and expected[name] != digest:
            raise SystemExit(f'Hash mismatch for {name}. Upstream snapshot changed; review and version the content instead of silently rebuilding.')
        result.append({'file': name, 'url': url, 'sha256': digest, 'bytes': target.stat().st_size})
    return result


def wordnet():
    english = zipfile.ZipFile(CACHE / 'wordnet.zip')
    chinese = zipfile.ZipFile(CACHE / 'omw.zip')
    cn = collections.defaultdict(list)
    for line in chinese.read('omw-1.4/cow/wn-data-cmn.tab').decode('utf-8').splitlines():
        fields = line.split('\t')
        if len(fields) == 3 and fields[1] == 'cmn:lemma':
            term = fields[2].replace('+', '').replace('_', ' ').strip()
            if term not in cn[fields[0]]:
                cn[fields[0]].append(term)
    synsets, words, collocations = {}, collections.defaultdict(list), collections.defaultdict(set)
    for part in ('noun', 'verb', 'adj', 'adv'):
        for line in english.read('wordnet/data.' + part).decode('utf-8').splitlines():
            if not line[:1].isdigit():
                continue
            data, gloss = line.split('|', 1)
            fields = data.split()
            count = int(fields[3], 16)
            pos = 'a' if fields[2] == 's' else fields[2]
            key = fields[0] + '-' + pos
            lemmas = [fields[4 + 2 * i].split('(')[0] for i in range(count)]
            cursor = 4 + count * 2
            pointer_count = int(fields[cursor]); cursor += 1
            pointers = []
            for i in range(pointer_count):
                symbol, offset, target_pos, source_target = fields[cursor:cursor + 4]; cursor += 4
                pointers.append((symbol, offset + '-' + ('a' if target_pos == 's' else target_pos), source_target))
            frames = []
            if pos == 'v':
                frame_count = int(fields[cursor]); cursor += 1
                for i in range(frame_count):
                    marker, frame, word_number = fields[cursor:cursor + 3]; cursor += 3
                    assert marker == '+'
                    frames.append((int(frame), int(word_number, 16)))
            examples = re.findall(r'"([^"]+)"', gloss)
            definition = re.sub(r';?\s*"[^"]+"', '', gloss).strip(' ;')
            record = dict(key=key, pos=pos, lemmas=lemmas, definition=definition,
                          chinese=cn.get(key, []), examples=examples, pointers=pointers, frames=frames)
            synsets[key] = record
            for lemma in lemmas:
                if '_' in lemma:
                    bits = lemma.lower().split('_')
                    if len(bits) <= 5:
                        for bit in bits:
                            if re.fullmatch('[a-z][a-z-]+', bit):
                                collocations[bit].add(lemma.replace('_', ' '))
                if key in cn and re.fullmatch('[a-z][a-z-]+', lemma):
                    words[lemma].append(record)
        # Respect the source's sense ordering within a part of speech.
        for line in english.read('wordnet/index.' + part).decode('utf-8').splitlines():
            if line.startswith(' ') or not line:
                continue
            fields = line.split()
            lemma = fields[0]
            if lemma not in words:
                continue
            offsets = fields[6 + int(fields[3]):]
            rank = {offset: i for i, offset in enumerate(offsets)}
            for record in words[lemma]:
                if record['pos'] == fields[1]:
                    record.setdefault('ranks', {})[lemma] = rank.get(record['key'].split('-')[0], 999)
    return english, chinese, words, synsets, collocations


def factual_metadata():
    result = {}
    with (CACHE / 'ecdict.csv').open(encoding='utf-8', newline='') as stream:
        for row in csv.DictReader(stream):
            word = row['word'].strip().lower()
            # Never retain or use the mixed-provenance definition/translation fields.
            if not re.fullmatch("[a-z][a-z'-]*", word):
                continue
            item = {key: row.get(key, '') for key in ('tag', 'bnc', 'frq', 'exchange')}
            if word not in result:
                result[word] = item
    return result


def corpus_examples(selected: set[str]):
    examples = {}
    with bz2.open(CACHE / 'tatoeba-eng.tsv.bz2', 'rt', encoding='utf-8') as stream:
        for line in stream:
            fields = line.rstrip('\n').split('\t')
            if len(fields) < 4 or fields[1] != 'eng' or fields[3] in ('', '\\N'):
                continue
            sid, _, sentence, author = fields[:4]
            tokens = re.findall(r"[a-z]+(?:[-'][a-z]+)*", sentence.lower())
            if not 5 <= len(tokens) <= 18 or len(sentence) > 160 or SENSITIVE.search(sentence):
                continue
            if not sentence[:1].isupper() or sentence[-1:] not in '.?!':
                continue
            # Prefer concise ordinary statements, not proper-name-heavy snippets.
            score = abs(len(tokens) - 10) + sum(t in sentence for t in ('Tom', 'Mary', 'Boston', 'John')) * 8
            for word in set(tokens) & selected:
                candidate = {'id': sid, 'text': sentence, 'author': author, 'score': score}
                previous = examples.get(word)
                if previous is None or (score, int(sid)) < (previous['score'], int(previous['id'])):
                    examples[word] = candidate
    return examples


def base_question(qid: str, title: str, kind: str, category: str, tags: list[str], level=1):
    return dict(id=qid, title=title, type=kind, stemMarkdown='', answerMarkdown='', explanationMarkdown='',
                options=[], correctAnswers=[], difficulty=level, depth=min(level, 3), frequency=0,
                frequencyScope='通用语言学习；非面试频率', frequencyBasis='不统计面试出现频率；0 表示不适用',
                collection='general', status='pending', categoryIds=[category], tagIds=tags,
                sourceRefs=[], sourceDocument=None, sourceAnchor=None)


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument('--download', action='store_true')
    options = args.parse_args()
    inventory = resources(options.download)
    eng, cmn, words, synsets, collocations = wordnet()
    metadata = factual_metadata()
    authored = module('english_function_words', 'english-function-words.py').ENTRIES
    grammar = module('english_grammar', 'english-grammar.py')
    positive = lambda value: int(value) if value and value.isdigit() and int(value) > 0 else 999999999

    def rank(word):
        record = metadata.get(word, {})
        return (min(positive(record.get('frq')), positive(record.get('bnc'))), word)

    def senses_for(word):
        by_pos = collections.defaultdict(list)
        for sense in words.get(word, []):
            by_pos[sense['pos']].append(sense)
        result = []
        for items in by_pos.values():
            result.extend(sorted(items, key=lambda s: s.get('ranks', {}).get(word, 999))[:2])
        return result[:6]

    def forms_for(word):
        forms = {word}
        for entry in metadata.get(word, {}).get('exchange', '').split('/'):
            if ':' in entry:
                forms.update(entry.split(':', 1)[1].lower().split('/'))
        return forms

    def has_source_example(word):
        forms = forms_for(word)
        return any(not SENSITIVE.search(example) and set(re.findall(r"[a-z]+(?:[-'][a-z]+)*", example.lower())) & forms
                   for sense in senses_for(word) for example in sense['examples'])

    exam_words = sorted((word for word in words if set(metadata.get(word, {}).get('tag', '').split()) & EXAM_TAGS.keys()), key=rank)
    selected = set(authored) | set(exam_words)
    for word in sorted(words, key=rank):
        if len(selected) == 10000:
            break
        selected.add(word)
    assert len(selected) == 10000
    # Search a larger candidate pool once. Replace only non-exam, non-core tail
    # entries lacking all natural examples; do not discard a tagged exam word
    # just because its open-source example coverage is poor.
    ranked_words = sorted(words, key=rank)
    corpus = corpus_examples(selected | set(ranked_words[:18000]))
    replacements = []
    replacement_candidates = (word for word in ranked_words if word not in selected and (word in corpus or has_source_example(word)))
    for old in sorted(selected, key=rank, reverse=True):
        if old in authored or set(metadata.get(old, {}).get('tag', '').split()) & EXAM_TAGS.keys() or old in corpus or has_source_example(old):
            continue
        new = next(replacement_candidates)
        selected.remove(old); selected.add(new)
        replacements.append({'removed':old,'replacement':new,'reason':'non-exam source entry without a verifiable natural example'})
    assert len(selected) == 10000
    questions, lexical_details = [], {}
    stats = collections.Counter()
    exam_stats = collections.Counter()

    for i, word in enumerate(sorted(selected), 1):
        info = metadata.get(word, {})
        source_tags = set(info.get('tag', '').split())
        tag_ids = ['en-vocabulary', 'en-original-entry' if word in authored else 'en-open-wordnet']
        for key, (tag, _) in EXAM_TAGS.items():
            if key in source_tags:
                tag_ids.append(tag); exam_stats[key] += 1
        if not source_tags & EXAM_TAGS.keys():
            tag_ids.append('en-frequency-supplement')
        q = base_question(f'EN-V-{i:06}', authored.get(word, {}).get('word', word), 'short_answer', 'en-vocabulary', tag_ids,
                          1 if word in authored or 'gk' in source_tags else 2 if 'cet4' in source_tags else 3 if 'cet6' in source_tags else 2)
        q['stemMarkdown'] = f"**{q['title']}**\n\n请回忆其英文含义、中文释义、主要词性及使用方式；可尝试先口头或书面造句，再查看释义与来源用例。"
        answer, examples, patterns, related = [], [], [], []
        selected_senses = []
        if word in authored:
            row = authored[word]
            answer.append(f"**词性**：{row['pos']}\n\n**English definition**：{row['definition']}\n\n**中文释义**：{row['chinese']}")
            examples.append(f"{row['example']}\n\n（认知星图原创学习例句）")
            patterns.append(row['pattern'])
            related.extend(row['related'])
            stats['originalCoreWords'] += 1
            q['sourceRefs'].append({'label': '认知星图原创基础词释义与例句；使用 CC0 1.0 发布', 'url': 'https://creativecommons.org/publicdomain/zero/1.0/'})
        else:
            selected_senses = senses_for(word)
            forms = forms_for(word)
            for sense in selected_senses:
                answer.append(f"**{POS[sense['pos']]} · {sense['key']}**\n\nEnglish: {sense['definition']}\n\n中文义项：{'；'.join(sense['chinese'][:7])}")
                for example in sense['examples']:
                    tokens = set(re.findall(r"[a-z]+(?:[-'][a-z]+)*", example.lower()))
                    if tokens & forms and not SENSITIVE.search(example) and len(examples) < 2:
                        examples.append(f"{example}\n\n（Princeton WordNet 3.0；义项 {sense['key']} 原例句）")
                lexical_numbers = {j + 1 for j, lemma in enumerate(sense['lemmas']) if lemma.lower() == word}
                for frame_number, number in sense['frames']:
                    if number == 0 or number in lexical_numbers:
                        pattern = f"{word}：{FRAMES[frame_number]}（WordNet 框架 {frame_number}；义项 {sense['key']}）"
                        if pattern not in patterns:
                            patterns.append(pattern)
                for lemma in sense['lemmas']:
                    if lemma.lower() != word:
                        related.append(f"{lemma.replace('_', ' ')}（同义项表达）")
                for symbol, target, source_target in sense['pointers']:
                    if symbol not in ('+', '!', '@', '&') or target not in synsets:
                        continue
                    source_number, target_number = int(source_target[:2], 16), int(source_target[2:], 16)
                    if source_number and source_number not in lexical_numbers:
                        continue
                    target_lemmas = synsets[target]['lemmas']
                    targets = [target_lemmas[target_number - 1]] if target_number else target_lemmas[:2]
                    relation = {'+': '派生相关', '!': '反义', '@': '上位概念', '&': '相似义项'}[symbol]
                    related.extend(f"{lemma.replace('_', ' ')}（{relation}）" for lemma in targets if lemma.lower() != word)
            q['sourceRefs'] += [
                {'label': 'Princeton WordNet 3.0：英文释义、原例句、关系与动词框架', 'url': 'https://wordnet.princeton.edu/'},
                {'label': 'Chinese Open WordNet：同 synset 中文义项', 'url': 'https://github.com/omwn/omw-data/tree/main/wns/cow'},
            ]
            stats['wordnetEntries'] += 1
            phrases = sorted(collocations.get(word, []), key=lambda phrase: (len(phrase.split()), len(phrase), phrase))[:4]
            if phrases:
                patterns += [f"词典收录的复合词／短语：{'；'.join(phrases)}（未作现代日常频率排序）"]
                stats['hasDictionaryCollocation'] += 1

        if not examples and word in ORIGINAL_EXAMPLES:
            examples.append(ORIGINAL_EXAMPLES[word] + '\n\n（认知星图原创学习例句；CC0 1.0；不是词典引文。部分词为源词表的历史拼写或变体，使用前宜核对现代常用形式。）')
            q['sourceRefs'].append({'label':'认知星图原创补充例句 · CC0 1.0', 'url':'https://creativecommons.org/publicdomain/zero/1.0/'})
            stats['originalSupplementExampleEntries'] += 1
        elif not examples and word in corpus:
            item = corpus[word]
            url = 'https://tatoeba.org/en/sentences/show/' + item['id']
            examples.append(f"{item['text']}\n\n（Tatoeba 句子 #{item['id']}，贡献者 {item['author']}；[原句]({url})；[CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/)；原文未改写。同词用例尚未人工逐义对齐。）")
            q['sourceRefs'].append({'label': f"Tatoeba #{item['id']} · {item['author']} · CC BY 2.0 FR", 'url': url})
            stats['tatoebaExampleEntries'] += 1
        elif examples and word not in authored:
            stats['wordnetExampleEntries'] += 1

        q['answerMarkdown'] = '\n\n---\n\n'.join(answer)
        explanation = ['### 使用方式／搭配\n' + ('\n'.join('- ' + p for p in patterns[:5]) if patterns else '无')]
        explanation.append('### 例句\n' + ('\n\n'.join(examples) if examples else '无'))
        unique_related = list(dict.fromkeys(related))[:10]
        explanation.append('### 关联词汇\n' + ('；'.join(unique_related) if unique_related else '无'))
        inflections = []
        labels = {'p':'过去式', 'd':'过去分词', 'i':'现在分词', '3':'第三人称单数', 'r':'比较级', 't':'最高级', 's':'复数', '0':'词元', '1':'词形标记'}
        for change in info.get('exchange', '').split('/'):
            if ':' in change:
                key, form = change.split(':', 1)
                if key in labels and key != '1':
                    inflections.append(labels[key] + '：' + form)
        if inflections:
            explanation.append('### 词形变化（ECDICT 元数据）\n' + '；'.join(inflections))
        marks = [label for key, (_, label) in EXAM_TAGS.items() if key in source_tags]
        provenance = '考试标签采用 ECDICT 的原始 ' + '/'.join(key for key in EXAM_TAGS if key in source_tags) + ' 标注，' if marks else '此词作为基础功能词或按 ECDICT 词频元数据补充，'
        definition_note = ('本条基础词的简明中英释义、句式和例句为项目原创学习摘要；未逐一展开该词的所有义项。' if word in authored else '中文为对应 WordNet 义项的中文近义表达；未提供的义项不在本条展开。')
        explanation.append('### 学习与审核说明\n' + provenance + '不表示已核验现行官方考试大纲，也不保证覆盖全部考纲词。' + definition_note + '\n\n先看搭配的语法角色，再用例句判断词义；同义项词通常只在特定语境可互换。例句、搭配、考试归属均仍需用户审核。')
        # Every independent single-question share must carry the source's full
        # notice, not merely a URL to the pack-wide notice.
        licenses = []
        if word not in authored:
            licenses += ['Princeton WordNet 3.0\n' + eng.read('wordnet/LICENSE').decode('utf-8').strip(),
                         'Chinese Open WordNet\n' + cmn.read('omw-1.4/cow/LICENSE').decode('utf-8').strip()]
        if info:
            licenses.append('ECDICT metadata only\n' + (CACHE / 'ecdict-license.txt').read_text(encoding='utf-8').strip())
        if licenses:
            explanation.append('### 数据许可与完整署名声明\n以下声明随单题一并保留。全包来源与变更记录另见随包 english-NOTICE.md。\n\n```text\n' + '\n\n'.join(licenses) + '\n```')
        q['explanationMarkdown'] = '\n\n'.join(explanation)
        if info:
            q['sourceRefs'].append({'label': 'ECDICT：仅考试标签、词频选择与词形元数据；不使用其混合来源释义', 'url': f'https://github.com/skywind3000/ECDICT/tree/{ECDICT_REV}'})
        stats['hasEnglishDefinition'] += bool(answer)
        stats['hasChineseDefinition'] += bool(answer)
        stats['hasExample'] += bool(examples)
        stats['hasSpecificPatternOrCollocation'] += bool(patterns)
        stats['hasRelatedVocabulary'] += bool(unique_related)
        lexical_details[q['id']] = dict(word=word, synsets=[s['key'] for s in selected_senses], exampleAvailable=bool(examples),
                                      patternAvailable=bool(patterns), relatedAvailable=bool(unique_related), original=word in authored,
                                      sourceTags=sorted(source_tags & EXAM_TAGS.keys()))
        questions.append(q)

    grammar_counts = collections.Counter()
    for i, (topic, level, stem, choices, answer_index, rationale, misconception) in enumerate(grammar.ROWS, 1):
        name, reference = grammar.TOPICS[topic]
        q = base_question(f'EN-G-{i:06}', f'{name} · {i:03}', 'fill_blank' if answer_index is None else 'single_choice',
                          'en-grammar-' + topic, ['en-grammar', 'en-grammar-' + topic, 'en-original-practice'], level)
        q['stemMarkdown'] = stem
        if answer_index is None:
            q['blanks'] = [{'id':'blank1', 'label':'填空', 'answers':choices, 'caseSensitive':False, 'trim':True}]
            q['answerMarkdown'] = '可接受答案：' + ' / '.join(choices)
        else:
            assert len(choices) == len(set(choices)), stem
            # Keep deterministic rebuilds while avoiding an answer-key pattern
            # caused by writing many correct phrases in the same source column.
            order = list(range(len(choices)))
            shift = int(hashlib.sha256(stem.encode('utf-8')).hexdigest()[:8], 16) % len(order)
            order = order[shift:] + order[:shift]
            q['options'] = [{'key': chr(65 + j), 'text': choices[source_index]} for j, source_index in enumerate(order)]
            key = chr(65 + order.index(answer_index))
            q['correctAnswers'] = [key]
            q['answerMarkdown'] = f'{key}：{choices[answer_index]}'
        q['explanationMarkdown'] = f'### 判断依据\n{rationale}\n\n### 易错点与边界\n{misconception}\n\n### 复习动作\n先圈出时间、主语和从句边界，再解释排除其他形式的理由；不要只记选项字母。复述本题规则后，可换一个真实语境检查规则是否仍适用。\n\n本题句子、选项和中文解析均为认知星图原创练习；来源链接用于核对通用语法事实，未复制链接页面的练习题。'
        q['sourceRefs'] = [{'label':'通用语法规则核对：British Council LearnEnglish（题目与解析原创）', 'url':reference},
                           {'label':'认知星图原创题目以 CC0 1.0 发布', 'url':'https://creativecommons.org/publicdomain/zero/1.0/'}]
        grammar_counts[topic] += 1
        questions.append(q)

    domains = [{'id':'english','name':'英语','description':'开放词汇资料与原创语法练习；本轮新增均待审核','sortOrder':10}]
    categories = [
        {'id':'en-root','domainId':'english','parentId':None,'name':'英语学习','description':'词汇、语法及后续阅读听说扩展','sortOrder':0},
        {'id':'en-vocabulary','domainId':'english','parentId':'en-root','name':'词汇与词表','description':'10000 个去重词目；开放释义与来源用例','sortOrder':1},
        {'id':'en-grammar','domainId':'english','parentId':'en-root','name':'语法与用法','description':'原创选择与填空题，按知识点由浅入深','sortOrder':2},
    ]
    for i, (key, (name, reference)) in enumerate(grammar.TOPICS.items(), 1):
        categories.append({'id':'en-grammar-' + key,'domainId':'english','parentId':'en-grammar','name':name,'description':'通用语法巩固；非历年试题复制','sortOrder':i})
    tags = []
    def tag(tid, name, description):
        tags.append({'id':tid, 'name':name, 'description':description, 'color':'#2980b9', 'domainId':'english', 'kind':'topic'})
    tag('en-vocabulary','英语词汇','可拼为无分值词表；先回忆再展开释义')
    tag('en-grammar','英语语法','独立原创语法巩固练习')
    tag('en-open-wordnet','开放 WordNet 词汇','英文 WordNet + Chinese Open WordNet 对齐义项')
    tag('en-original-entry','基础日常词（原创）','补齐开放 WordNet 较少覆盖的功能词、助动词、日期和语言名称')
    tag('en-frequency-supplement','词频补充（ECDICT）','按源 frq/bnc 较小正排名补充；不是官方考试标签，也不宣称都是生活口语高频')
    tag('en-original-practice','原创语言练习','句子、选项与解析原创；不是考试真题')
    for _, (tid, name) in EXAM_TAGS.items():
        tag(tid, name, '仅保留 ECDICT 源标签，不保证现行官方大纲归属或完整覆盖')
    for key, (name, _) in grammar.TOPICS.items():
        tag('en-grammar-' + key, name, '英语语法知识点')
    banks = [{'id':'en-bank-vocabulary','name':'英语 · 开放词汇 10000','description':'10000 个去重词目；全部待用户审核；含源考试标签和词频补充','questionIds':[q['id'] for q in questions if q['type']=='short_answer']},
             {'id':'en-bank-grammar','name':'英语 · 原创语法 144','description':'12 类语法点，每类12题；选择题129，填空题15（以统计结果为准）','questionIds':[q['id'] for q in questions if q['id'].startswith('EN-G-')]}]
    banks[1]['description'] = f"12 类语法点，各12题；{sum(q['type']=='single_choice' for q in questions)}道选择题，{sum(q['type']=='fill_blank' for q in questions)}道填空题；均待用户审核"
    pack = {'schemaVersion':1,'generatedAt':GENERATED_AT,'domains':domains,'categories':categories,'tags':tags,'questions':questions,'questionBanks':banks,'documents':[],'papers':[]}
    PACK.parent.mkdir(parents=True, exist_ok=True)
    PACK.write_text(json.dumps(pack, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    limitations = [
        '本包是待审核学习资料，不是官方考试词汇表、牛津词典或完整权威双解词典。',
        'ECDICT 存在混合词库历史，故只采用事实性标签、排名与词形；完全不采用其英文释义、中文翻译、Collins/Oxford 标记或未核实的音标。',
        '高考/CET4/CET6 标签仅表示 ECDICT 数据中的标签；未验证当前官方大纲，不保证全覆盖。',
        'WordNet 偏重实词。中文来自相同 synset 的词义表达，不是自行机器翻译；一词只展开选取的最多六个有中文对应义项。',
        '词汇词性与中文存在源数据误差可能；Tatoeba 补充例句未人工逐义对齐；所有新增词条与语法题都保持 pending。',
        '专用句式/搭配与例句未覆盖的词条明确标注待补，未使用通用占位句冒充专用用法。',
        '词典收录复合短语没有频率排序，不等同于已统计的常见搭配。',
        '词汇题难度为学习组织值，非 CEFR 等级或官方考试难度；frequency=0 为不适用面试频率。',
    ]
    provenance = {'id':'english-open-lexicon-2026-10','version':'1.0.0','generatedAt':GENERATED_AT,'pack':'../content-packs/english.json',
                  'status':'pending','vocabularyCount':10000,'grammarCount':len(grammar.ROWS),'questionCount':len(questions),
                  'statistics':dict(stats),'examSourceLabels':dict(exam_stats),'grammarTopics':dict(grammar_counts),
                  'resources':inventory,'selection':'先纳入原创基础功能词/日期词与具有中文 WordNet 义项、ECDICT gk/cet4/cet6 标签的词，再按 min(正数 frq, 正数 bnc) 补足 10000；仅无可核验自然例句且无考试源标签的尾部词允许由有例句候选替换；词目忽略大小写去重。',
                  'licenses':[{'component':'Princeton WordNet 3.0','license':'WordNet-3.0','holder':'Princeton University','url':'https://wordnet.princeton.edu/license-and-commercial-use'},
                              {'component':'Chinese Open WordNet (OMW 1.4/cow)','license':'Chinese Open WordNet permissive database license','holder':'Francis Bond and Shan Wang, 2013/2014','url':'https://github.com/omwn/omw-data/blob/main/wns/cow/LICENSE'},
                              {'component':'ECDICT metadata only','license':'MIT','holder':'Linwei, 2025 (upstream notice)','url':f'https://github.com/skywind3000/ECDICT/blob/{ECDICT_REV}/LICENSE'},
                              {'component':'Tatoeba sentence examples','license':'CC-BY-2.0-FR','holder':'Individual contributors named with each sentence','url':'https://creativecommons.org/licenses/by/2.0/fr/'},
                              {'component':'Original function-word explanations, examples and grammar questions','license':'CC0-1.0','holder':'Noetic Atlas contributors','url':'https://creativecommons.org/publicdomain/zero/1.0/'}],
                  'notice':'english-NOTICE.md','limitations':limitations,'exampleAvailabilityReplacements':replacements,'lexicalCoverage':lexical_details}
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    notice = '# 英语内容来源与许可\n\n本文件适用于 [英语内容包](../content-packs/english.json)。程序代码许可不取代下列数据许可。\n\n'
    notice += '\n'.join('- ' + item for item in limitations) + '\n\n'
    notice += '## Princeton WordNet 3.0\n\n英文定义、词性、原例句、词义关系和动词框架。对义项做筛选、排序、与中文对齐，未冒称为原版完整词典。\n\n```text\n' + eng.read('wordnet/LICENSE').decode('utf-8').strip() + '\n```\n\n'
    notice += '## Chinese Open WordNet\n\n中文义项来自 OMW 1.4 中 cow/wn-data-cmn.tab，去除内部的 +、_ 展示标记，按相同 WordNet 3.0 synset 关联。\n\n```text\n' + cmn.read('omw-1.4/cow/LICENSE').decode('utf-8').strip() + '\n```\n\n'
    notice += '## ECDICT：仅事实性元数据\n\n使用考试标签、frq/bnc 排名以筛选词表以及 exchange 词形；未使用混合来源的 definition/translation 及 Oxford/Collins 资料。数据版本见 [来源清单](english.json)。\n\n```text\n' + (CACHE / 'ecdict-license.txt').read_text(encoding='utf-8').strip() + '\n```\n\n'
    notice += '## Tatoeba 例句\n\n来自 [官方每周英语详细句子导出](https://downloads.tatoeba.org/exports/per_language/eng/)，本快照为 2026-10-17 周数据，下载于 2026-10-22。依 [官方许可说明](https://tatoeba.org/en/downloads) 按 [CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/) 提供。每条引用均注明原句 ID、原句链接和贡献者用户名；文本未改写。未保留作者的邮箱或其他私人资料。\n\n分享单题、题库或试卷时，请保留题目解析里的贡献者署名、原句链接及许可。部分句子来自公有领域 Tanaka Corpus，本包为简化归属仍按官方导出的 CC BY 2.0 FR 方式署名。\n\n'
    notice += '## 原创补充\n\n基础功能词的简明释义、中文说明、句式与例句，以及 144 道语法练习的题干、选项和解析由本项目独立编写，使用 [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) 提供。British Council 链接用于核对通用语法事实，没有复制其题干、选项或解释。\n\n'
    notice += '## 可复现构建\n\n执行 `python scripts/content/english/english.py --download`；源快照哈希收录在来源清单。再次生成遇到源文件变更会中止，以免周更源被静默替换。原始源不提交 Git，最终题包、来源清单与本声明共同分发。\n'
    NOTICE.write_text(notice, encoding='utf-8')
    print(json.dumps({'questions':len(questions),'vocabulary':10000,'grammar':len(grammar.ROWS),'coverage':dict(stats),'examSourceLabels':dict(exam_stats),'bytes':PACK.stat().st_size},ensure_ascii=True,indent=2))


if __name__ == '__main__':
    main()
