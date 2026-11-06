import type { Category, Question, QuestionInput } from '../../../shared/models/types.js';
import type {
  ImportDedupPreview,
  ImportDedupItem,
  ImportDedupCandidate,
  ImportDedupOptions,
} from '../../../shared/models/import-dedup.js';
import {
  importDigest,
  importQuestionContent,
  importQuestionFeatures,
  importTokenScore,
} from '../../../shared/questions/import-dedup.js';
import type { ImportIndexRow } from '../../database/import-projections.js';
import { type Store, makeId, now, nextStamp } from '../../core/store.js';
import { fail, parse, questionSchema } from '../../core/validation.js';
import { validateAssetReferences } from '../assets/service.js';
import { validateDocumentCitations } from '../library/sources.js';
import { captureQuestionRevision } from '../questions/revisions.js';
import { getSettings } from '../settings/service.js';
import { importDedupOptionsSchema } from './schema.js';
import type { PackageQuestionHashHint } from '../../../shared/packages/question-hashes.js';

const candidateLimit = 50,
  chunkSize = 200;
type IncomingBuckets = Map<string, Map<string, number[]>>;

/** Keep bounded postings per domain, rather than letting an unrelated large
 * domain evict all of a smaller domain's candidates from the incoming batch. */
function incomingCandidates(buckets: IncomingBuckets, value: string, domains: ReadonlySet<string>) {
  const byDomain = buckets.get(value);
  if (!byDomain) return [];
  const selected = domains.size
    ? ['', ...domains].map((domain) => byDomain.get(domain) || [])
    : [...byDomain.values()];
  return [...new Set(selected.flat())].sort((a, b) => b - a).slice(0, candidateLimit);
}

function rememberIncoming(
  buckets: IncomingBuckets,
  value: string,
  domains: ReadonlySet<string>,
  index: number,
) {
  if (!value) return;
  const byDomain = buckets.get(value) || new Map<string, number[]>();
  for (const domain of domains.size ? domains : ['']) {
    const entries = byDomain.get(domain) || [];
    entries.push(index);
    if (entries.length > candidateLimit) entries.shift();
    byDomain.set(domain, entries);
  }
  buckets.set(value, byDomain);
}
const grouped = <T>(rows: T[], key: (row: T) => string) => {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = result.get(k) || [];
    bucket.push(row);
    result.set(k, bucket);
  }
  return result;
};
const stateRank = (row: ImportIndexRow) =>
  row.status === 'published' ? 0 : row.status === 'pending' ? 1 : 2;
const signature = (question: QuestionInput, assetKey: (id: string) => string) =>
  importDigest(importQuestionContent(question, assetKey));

/** A read-only business operation over disposable indexes. It never invokes
 * the O(N) substring similarity route once for each incoming question. */
export function previewQuestionImport(
  store: Store,
  questions: QuestionInput[],
  assetKey = store.database.imports.assetResolver(),
  options: ImportDedupOptions = {},
  hashHints?: ReadonlyArray<PackageQuestionHashHint | undefined>,
  stagedCategories?: ReadonlyMap<string, string>,
): ImportDedupPreview {
  const db = store.database,
    q = db.query;
  if (options.enabled === false) {
    const suppliedIds = questions.flatMap((question) => (question.id ? [question.id] : []));
    if (new Set(suppliedIds).size !== suppliedIds.length)
      fail(400, 'IMPORT_DUPLICATE_SOURCE_ID', '关闭查重时，来源题号仍不能重复，请先整理重复题号。');
    const headers = db.all(
      q
        .selectFrom('questions')
        .select(['id', db.expressions.field<string>('data', 'updatedAt').as('stamp')])
        .orderBy('id'),
    );
    return {
      enabled: false,
      fingerprint: importDigest(
        JSON.stringify({
          enabled: false,
          questions: questions.map((question) => {
            const { createdAt: _created, updatedAt: _updated, ...content } = question as Question;
            return content;
          }),
          headers,
        }),
      ),
      total: questions.length,
      counts: { new: questions.length, exact: 0, similar: 0 },
      items: questions.map((question, index) => ({
        key: `i-${index}`,
        index,
        title: question.title,
        type: question.type,
        kind: 'new' as const,
        candidates: [],
      })),
      metrics: { indexed: 0, compared: 0, candidateLimit, hashesReused: 0, hashesComputed: 0 },
    };
  }
  db.imports.ensure();
  const rows = db
    .all(q.selectFrom('question_import_index').selectAll())
    .sort((a, b) => stateRank(a) - stateRank(b) || a.id.localeCompare(b.id));
  const byId = new Map(rows.map((row) => [row.id, row])),
    exact = grouped(rows, (row) => row.content_hash),
    prompt = grouped(rows, (row) => row.prompt_hash),
    titles = grouped(rows, (row) => row.title_key),
    words = grouped(rows, (row) => row.vocab_key);
  const features = questions.map(importQuestionFeatures),
    hashes = questions.map(
      (question, index) => hashHints?.[index]?.contentHash || signature(question, assetKey),
    );
  const categoryDomains = new Map(
    store.all<Category>('categories').map((category) => [category.id, category.domainId]),
  );
  for (const [id, domain] of stagedCategories || []) categoryDomains.set(id, domain);
  const domainsFor = (categories: string[]) =>
    new Set(
      categories.flatMap((id) => (categoryDomains.has(id) ? [categoryDomains.get(id)!] : [])),
    );
  const incomingDomains = questions.map((question) => domainsFor(question.categoryIds || []));
  const localDomains = new Map(
    db
      .all(
        q
          .selectFrom('questions')
          .select(['id', db.expressions.field<string>('data', 'categoryIds').as('categories')]),
      )
      .map((row) => [row.id, domainsFor(JSON.parse(row.categories || '[]'))]),
  );
  const sharesDomain = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
    !left.size || !right.size || [...left].some((id) => right.has(id));
  let hashesReused = 0,
    hashesComputed = questions.length - (hashHints?.filter(Boolean).length || 0);
  const termCounts = new Map(
    db
      .all(
        q
          .selectFrom('question_import_terms')
          .select('term')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .groupBy('term'),
      )
      .map((row) => [row.term, Number(row.count)]),
  );
  const originalCache = new Map<string, string>();
  let compared = 0;
  const canonicalFor = (id: string) => {
    if (!originalCache.has(id)) {
      const original = store.get<Question>('questions', id);
      if (original) originalCache.set(id, importQuestionContent(original, assetKey));
    }
    return originalCache.get(id);
  };
  const incomingExact = new Map<string, number[]>(),
    incomingPrompt: IncomingBuckets = new Map(),
    incomingTitle: IncomingBuckets = new Map(),
    incomingWord: IncomingBuckets = new Map(),
    incomingTerms: IncomingBuckets = new Map();
  const items: ImportDedupItem[] = [];
  for (let offset = 0; offset < questions.length; offset += chunkSize) {
    const exactIds = [
      ...new Set(
        hashes.slice(offset, offset + chunkSize).flatMap((hash) => {
          const id = exact.get(hash)?.[0]?.id;
          return id && !originalCache.has(id) ? [id] : [];
        }),
      ),
    ];
    if (exactIds.length)
      for (const row of db.all(
        q.selectFrom('questions').select(['id', 'data']).where('id', 'in', exactIds),
      ))
        originalCache.set(row.id, importQuestionContent(JSON.parse(row.data), assetKey));
    const termSelections = features.slice(offset, offset + chunkSize).map((value) =>
      value.tokens
        .filter((term) => (termCounts.get(term) || 0) > 0 && (termCounts.get(term) || 0) <= 200)
        .sort((a, b) => termCounts.get(a)! - termCounts.get(b)!)
        .slice(0, 4),
    );
    const terms = [...new Set(termSelections.flat())],
      postings = new Map<string, string[]>();
    for (let start = 0; start < terms.length; start += 300)
      for (const row of db.all(
        q
          .selectFrom('question_import_terms')
          .select(['term', 'question_id'])
          .where('term', 'in', terms.slice(start, start + 300)),
      )) {
        const ids = postings.get(row.term) || [];
        ids.push(row.question_id);
        postings.set(row.term, ids);
      }
    for (let index = offset; index < Math.min(offset + chunkSize, questions.length); index++) {
      const question = questions[index]!,
        feature = features[index]!,
        initialHash = hashes[index]!,
        key = `i-${index}`,
        content = importQuestionContent(question, assetKey);
      let hash = initialHash;
      let repeated = (incomingExact.get(hash) || []).find(
        (prior) => importQuestionContent(questions[prior]!, assetKey) === content,
      );
      let existing = (exact.get(hash) || []).find((row) => canonicalFor(row.id) === content);
      if (hashHints?.[index]) {
        if (repeated !== undefined || existing) hashesReused++;
        else {
          hashes[index] = hash = signature(question, assetKey);
          hashesComputed++;
          repeated = (incomingExact.get(hash) || []).find(
            (prior) => importQuestionContent(questions[prior]!, assetKey) === content,
          );
          existing = (exact.get(hash) || []).find((row) => canonicalFor(row.id) === content);
        }
      }
      const item: ImportDedupItem = {
        key,
        index,
        title: question.title,
        type: question.type,
        kind: 'new',
        candidates: [],
      };
      if (repeated !== undefined) {
        item.kind = 'exact';
        item.duplicateOf = `i-${repeated}`;
        item.targetId = items[repeated]?.targetId;
      } else if (existing) {
        item.kind = 'exact';
        item.targetId = existing.id;
      } else {
        const ids = new Set<string>();
        if (question.id && byId.has(question.id)) ids.add(question.id);
        for (const bucket of [
          prompt.get(feature.promptHash),
          titles.get(feature.titleKey),
          feature.vocabKey ? words.get(feature.vocabKey) : undefined,
        ])
          for (const row of (bucket || [])
            .filter((row) =>
              sharesDomain(incomingDomains[index]!, localDomains.get(row.id) || new Set()),
            )
            .slice(0, candidateLimit))
            ids.add(row.id);
        const hits = new Map<string, number>();
        for (const term of termSelections[index - offset] || [])
          for (const id of postings.get(term) || []) hits.set(id, (hits.get(id) || 0) + 1);
        for (const [id] of [...hits]
          .filter(([id]) =>
            sharesDomain(incomingDomains[index]!, localDomains.get(id) || new Set()),
          )
          .sort((a, b) => b[1] - a[1])
          .slice(0, candidateLimit))
          ids.add(id);
        const candidates: ImportDedupCandidate[] = [];
        for (const id of [...ids].slice(0, candidateLimit)) {
          const row = byId.get(id);
          if (
            !row ||
            (question.id !== id &&
              !sharesDomain(incomingDomains[index]!, localDomains.get(id) || new Set()))
          )
            continue;
          compared++;
          const samePrompt = row.prompt_hash === feature.promptHash,
            sameTitle = row.title_key === feature.titleKey,
            sameWord = !!feature.vocabKey && row.vocab_key === feature.vocabKey;
          const sameId = question.id === id,
            score = samePrompt
              ? 100
              : sameId
                ? 99
                : sameWord
                  ? 96
                  : sameTitle
                    ? 90
                    : importTokenScore(feature.tokens, JSON.parse(row.tokens));
          if (score >= 65)
            candidates.push({
              id,
              title: row.title,
              type: row.type as Question['type'],
              status: row.status as Question['status'],
              score,
              reason: samePrompt
                ? '题面一致，答案或解析等内容有差异'
                : sameId
                  ? '题号相同但内容不同，请确认是否更新'
                  : sameWord
                    ? '词头或概念名称相同，可能属于不同义项'
                    : sameTitle
                      ? '标题相同，内容需要核对'
                      : '题目文字具有较高重合',
            });
        }
        const batchIndices = new Set<number>();
        for (const map of [
          [incomingPrompt, feature.promptHash],
          [incomingTitle, feature.titleKey],
          [incomingWord, feature.vocabKey],
        ] as const)
          if (map[1])
            for (const prior of incomingCandidates(map[0], map[1], incomingDomains[index]!))
              batchIndices.add(prior);
        for (const term of feature.tokens.slice(0, 12))
          for (const prior of incomingCandidates(
            incomingTerms,
            term,
            incomingDomains[index]!,
          ).slice(0, 20))
            if (batchIndices.size < candidateLimit) batchIndices.add(prior);
        for (const prior of [...batchIndices].slice(0, candidateLimit)) {
          if (
            items[prior]?.kind === 'exact' ||
            !sharesDomain(incomingDomains[index]!, incomingDomains[prior]!)
          )
            continue;
          const other = features[prior]!;
          compared++;
          const score =
            feature.promptHash === other.promptHash
              ? 100
              : feature.vocabKey && feature.vocabKey === other.vocabKey
                ? 96
                : feature.titleKey === other.titleKey
                  ? 90
                  : importTokenScore(feature.tokens, other.tokens);
          if (score >= 65)
            candidates.push({
              id: `batch:i-${prior}`,
              incomingIndex: prior,
              title: questions[prior]!.title,
              type: questions[prior]!.type,
              status: 'pending',
              score,
              reason: '与本批前面的题目相近，请核对内容',
            });
        }
        item.candidates = candidates
          .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
          .slice(0, 5);
        if (item.candidates.length) item.kind = 'similar';
      }
      items.push(item);
      const exactEntries = incomingExact.get(hash) || [];
      exactEntries.push(index);
      incomingExact.set(hash, exactEntries);
      for (const [map, value] of [
        [incomingPrompt, feature.promptHash],
        [incomingTitle, feature.titleKey],
        [incomingWord, feature.vocabKey],
      ] as const) {
        rememberIncoming(map, value, incomingDomains[index]!, index);
      }
      for (const term of feature.tokens)
        rememberIncoming(incomingTerms, term, incomingDomains[index]!, index);
    }
  }
  const counts = { new: 0, exact: 0, similar: 0 };
  for (const item of items) counts[item.kind]++;
  return {
    fingerprint: importDigest(
      JSON.stringify([
        questions.map((question, index) => [question.id, hashes[index]]),
        rows.map((row) => [row.id, row.content_hash, row.source_stamp, row.status]),
        questions.map((question) => question.categoryIds),
        [...categoryDomains],
      ]),
    ),
    enabled: true,
    total: questions.length,
    counts,
    items,
    metrics: { indexed: rows.length, compared, candidateLimit, hashesReused, hashesComputed },
  };
}

export function resolveQuestionImportTargets(
  store: Store,
  questions: QuestionInput[],
  plan: ImportDedupPreview,
  rawOptions: ImportDedupOptions = {},
  allowUnresolved = false,
) {
  const options = parse(importDedupOptionsSchema, rawOptions),
    decisions = new Map(options.decisions?.map((decision) => [decision.key, decision]));
  if (decisions.size !== (options.decisions?.length || 0))
    fail(400, 'IMPORT_DUPLICATE_DECISION', '同一题目只能选择一种处理方式');
  if (options.expectedFingerprint && options.expectedFingerprint !== plan.fingerprint)
    fail(409, 'IMPORT_PREVIEW_STALE', '题目或题库在预览后发生变化，请重新查重');
  const itemByKey = new Map(plan.items.map((item) => [item.key, item]));
  for (const decision of decisions.values()) {
    if (itemByKey.get(decision.key)?.kind !== 'similar')
      fail(400, 'IMPORT_INVALID_DECISION', '处理选择不属于当前相似题');
  }
  if (
    !allowUnresolved &&
    plan.items.some((item) => item.kind === 'similar' && !decisions.has(item.key))
  )
    fail(409, 'IMPORT_SIMILAR_REVIEW_REQUIRED', '请先为所有相似题选择处理方式');
  const targets = new Map<string, string>(),
    replaceTargets = new Set<string>(),
    replacements = new Map<string, number>(),
    occupied = new Set<string>();
  for (const item of plan.items) {
    const question = questions[item.index]!,
      decision = decisions.get(item.key);
    if (item.duplicateOf) {
      const target =
        targets.get(item.duplicateOf) || fail(400, 'IMPORT_INVALID_TARGET', '本批重复题引用无效');
      targets.set(item.key, target);
      continue;
    }
    if (item.kind === 'exact') {
      targets.set(item.key, item.targetId!);
      continue;
    }
    if (decision && decision.action !== 'both') {
      const candidate = item.candidates.find((candidate) => candidate.id === decision.targetId);
      if (!candidate) fail(400, 'IMPORT_TARGET_REQUIRED', '请选择当前相似候选作为处理目标');
      const target =
        candidate!.incomingIndex !== undefined
          ? targets.get(`i-${candidate!.incomingIndex}`)
          : candidate!.id;
      if (!target) fail(400, 'IMPORT_INVALID_TARGET', '本批目标必须先确定且不能循环引用');
      targets.set(item.key, target!);
      if (decision.action === 'replace') {
        if (replaceTargets.has(target!))
          fail(
            409,
            'IMPORT_MULTIPLE_REPLACEMENTS',
            '多道导入题要覆盖同一道原题，请只选择一个最终版本',
          );
        replaceTargets.add(target!);
        replacements.set(target!, item.index);
      }
    } else {
      const target =
        question.id &&
        !['new', 'review', 'import', 'import-template'].includes(question.id) &&
        !store.get('questions', question.id) &&
        !occupied.has(question.id)
          ? question.id
          : makeId('q');
      targets.set(item.key, target);
      occupied.add(target);
    }
  }
  return { targets, replacements };
}
export interface AppliedQuestionImport {
  added: number;
  reused: number;
  updated: number;
  items: Question[];
  idMap: Record<string, string>;
  dedup: ImportDedupPreview;
}
export function prepareQuestionImport(
  store: Store,
  questions: QuestionInput[],
  rawOptions: ImportDedupOptions = {},
  suppliedPlan?: ImportDedupPreview,
  assetKey = store.database.imports.assetResolver(),
  allowUnresolved = false,
  hashHints?: ReadonlyArray<PackageQuestionHashHint | undefined>,
) {
  const plan =
      suppliedPlan || previewQuestionImport(store, questions, assetKey, rawOptions, hashHints),
    { targets, replacements } = resolveQuestionImportTargets(
      store,
      questions,
      plan,
      rawOptions,
      allowUnresolved,
    ),
    stamp = now();
  const idMap = () =>
    Object.fromEntries(
      questions.flatMap((question, index) =>
        question.id ? [[question.id, targets.get(`i-${index}`)!]] : [],
      ),
    );
  const rewrite = (value: any, map: Record<string, string>): any =>
    typeof value === 'string'
      ? value.replace(
          /(^|[\s("'<>])#\/questions\/([^/\s?#"'()<>\]]+)/g,
          (match, prefix: string, encoded: string) => {
            let id = encoded;
            try {
              id = decodeURIComponent(encoded);
            } catch {
              return match;
            }
            return map[id] ? `${prefix}#/questions/${encodeURIComponent(map[id]!)}` : match;
          },
        )
      : Array.isArray(value)
        ? value.map((item) => rewrite(item, map))
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value).map(([key, item]) => [key, rewrite(item, map)]),
            )
          : value;
  const updates = new Map<string, Question>(),
    contentUpdates = new Set<string>();
  const skippedSources = new Set(
    (rawOptions.decisions || [])
      .filter((decision) => decision.action === 'keep')
      .map((decision) => decision.key),
  );
  for (const item of plan.items)
    if (item.duplicateOf && skippedSources.has(item.duplicateOf)) skippedSources.add(item.key);
  for (const item of plan.items) {
    const target = targets.get(item.key)!;
    if (updates.has(target)) continue;
    const replace = replacements.get(target),
      existing = store.get<Question>('questions', target);
    if (existing && replace === undefined) continue;
    const source = questions[replace ?? item.index]!,
      input = structuredClone(source);
    if (input.parts && existing?.parts) {
      const used = new Set<string>();
      input.parts = input.parts.map((part) => {
        const retained = existing.parts?.find(
          (candidate) =>
            !used.has(candidate.id) &&
            candidate.type === part.type &&
            candidate.stemMarkdown === part.stemMarkdown &&
            (candidate.id === part.id || candidate.answerMarkdown === part.answerMarkdown),
        );
        if (retained) {
          used.add(retained.id);
          return { ...part, id: retained.id };
        }
        return { ...part, id: makeId('part') };
      });
    }
    const next = {
      ...input,
      id: target,
      status: existing?.status || 'pending',
      createdAt: existing?.createdAt || stamp,
      updatedAt: existing ? nextStamp(existing.updatedAt) : stamp,
    } as Question;
    updates.set(target, next);
    if (existing) contentUpdates.add(target);
  }
  if (rawOptions.enabled !== false) {
    // Collapse identities introduced by reference rewriting; an existing target
    // with learning evidence cannot be silently redirected by a replacement.
    const seen = new Map<string, Array<{ id: string; content: string }>>();
    const originalRows = store.database.all(
      store.database.query.selectFrom('question_import_index').select(['id', 'content_hash']),
    );
    const existingByHash = grouped(originalRows, (row) => row.content_hash);
    for (const [target, next] of updates) {
      const content = importQuestionContent(rewrite(next, idMap()), assetKey),
        hash = importDigest(content);
      let same = (seen.get(hash) || []).find((value) => value.content === content)?.id;
      if (!same)
        for (const row of existingByHash.get(hash) || []) {
          if (row.id === target || updates.has(row.id)) continue;
          const original = store.get<Question>('questions', row.id);
          if (original && importQuestionContent(original, assetKey) === content) {
            same = row.id;
            break;
          }
        }
      if (same) {
        if (store.get('questions', target))
          fail(
            409,
            'IMPORT_REPLACEMENT_DUPLICATE',
            '覆盖会产生完全重复题，请改为保留原题或调整选择',
          );
        for (const [key, value] of targets) if (value === target) targets.set(key, same);
        updates.delete(target);
      } else {
        const bucket = seen.get(hash) || [];
        bucket.push({ id: target, content });
        seen.set(hash, bucket);
      }
    }
  }
  const finalMap = idMap();
  for (const [target, next] of updates) updates.set(target, rewrite(next, finalMap));
  // Sources are attached once to a reused question, never used as its identity.
  // Organization remains local; incoming categories/tags are not overwritten.
  for (const item of plan.items) {
    // Keeping an original skips a different incoming version, including its
    // copies. Its citations must not become evidence for the retained answer.
    if (skippedSources.has(item.key)) continue;
    const target = targets.get(item.key)!,
      base = updates.get(target) || store.get<Question>('questions', target);
    if (!base) continue;
    const incoming = questions[item.index]!;
    const refs = [...(base.sourceRefs || [])],
      keys = new Set(refs.map((ref) => JSON.stringify(ref)));
    for (const ref of incoming.sourceRefs || [])
      if (!keys.has(JSON.stringify(ref))) {
        refs.push(ref);
        keys.add(JSON.stringify(ref));
      }
    if (refs.length > 100)
      fail(400, 'IMPORT_SOURCE_LIMIT', '合并后的参考来源超过100条，请先整理来源');
    const links = [...(base.documentLinks || [])],
      linkKeys = new Set(links.map((link) => JSON.stringify(link)));
    for (const link of incoming.documentLinks || [])
      if (!linkKeys.has(JSON.stringify(link))) {
        links.push(link);
        linkKeys.add(JSON.stringify(link));
      }
    if (links.length > 30)
      fail(400, 'IMPORT_SOURCE_LIMIT', '合并后的原文关联超过30条，请先整理来源');
    if (
      JSON.stringify(refs) !== JSON.stringify(base.sourceRefs || []) ||
      JSON.stringify(links) !== JSON.stringify(base.documentLinks || [])
    )
      updates.set(target, {
        ...base,
        sourceRefs: refs,
        ...(links.length ? { documentLinks: links } : {}),
        updatedAt: nextStamp(base.updatedAt),
      });
  }
  return { plan, targets, replacements, updates, contentUpdates, idMap: finalMap };
}
export function applyQuestionImport(
  store: Store,
  questions: QuestionInput[],
  rawOptions: ImportDedupOptions = {},
  hashHints?: ReadonlyArray<PackageQuestionHashHint | undefined>,
): AppliedQuestionImport {
  const options = parse(importDedupOptionsSchema, rawOptions);
  return store.transaction(() => {
    const settings = getSettings(store),
      validationCache = new Map();
    for (const question of questions) {
      parse(questionSchema, question);
      store.validateRefs(question);
      validateAssetReferences(store, question, settings);
      validateDocumentCitations(store, question, true, validationCache);
    }
    const { plan, targets, updates, contentUpdates, idMap } = prepareQuestionImport(
        store,
        questions,
        options,
        undefined,
        undefined,
        false,
        hashHints,
      ),
      currentSettings = getSettings(store),
      sourceCache = new Map();
    for (const next of updates.values()) {
      parse(questionSchema, next);
      store.validateRefs(next);
      validateAssetReferences(store, next, currentSettings);
      validateDocumentCitations(store, next, true, sourceCache);
    }
    let added = 0,
      reused = 0,
      updated = 0;
    for (const [target, next] of updates) {
      const previous = store.get<Question>('questions', target);
      if (previous) {
        captureQuestionRevision(
          store,
          previous,
          next,
          'manual',
          contentUpdates.has(target) ? '导入相似题确认覆盖' : '导入重复题补充来源',
        );
        if (contentUpdates.has(target)) updated++;
      } else added++;
      store.put('questions', target, next);
    }
    const items = plan.items.map((item) =>
      store.require<Question>('questions', targets.get(item.key)!),
    );
    reused = questions.length - added - updated;
    return { added, reused, updated, items, idMap, dedup: plan };
  });
}
