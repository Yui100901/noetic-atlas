import type { PaperScoring, Question, QuestionType, ScoringInput } from '../../../shared/models/types.js';
import { fail } from '../../core/validation.js';
import { isSubjectiveType } from '../../../shared/questions/question-utils.js';
import { distributeGroupPoints, flattenQuestions, type StoredLeafQuestion } from '../questions/structure.js';

export const DEFAULT_POINTS: Record<QuestionType, number> = { short_answer: 3, true_false: 1, single_choice: 2, multiple_choice: 4, fill_blank: 2, essay: 10, group: 6 };
export const LEGACY_POINTS: Record<QuestionType, number> = { short_answer: 3, true_false: 1, single_choice: 1, multiple_choice: 2, fill_blank: 2, essay: 10, group: 6 };
export const cents = (value: number) => Math.round(value * 100);
export const fromCents = (value: number) => value / 100;
const percentage = (part: number, total: number) => total ? Math.round(part / total * 10000) / 100 : 0;

export function normalizeScoring(questions: Question[], input?: ScoringInput | PaperScoring): PaperScoring {
  const scheme = !input || ('scheme' in input && input.scheme === 'legacy') ? 'legacy' : input.enabled ? 'custom' : 'none';
  if ('scheme' in (input || {}) && (input as PaperScoring).scheme !== scheme) fail(400, 'INVALID_SCORING', '计分模式与启用状态不一致');
  const enabled = scheme !== 'none';
  if (scheme === 'legacy' && input && !input.enabled) fail(400, 'INVALID_SCORING', '旧版计分不能标记为禁用');
  const pointsByType = { ...(scheme === 'legacy' ? LEGACY_POINTS : DEFAULT_POINTS), ...(scheme === 'custom' ? input?.pointsByType : {}) };
  const questionPoints: Record<string, number> = {};
  const questionIds = new Set(questions.map(q=>q.id));
  if (input?.questionPoints && Object.keys(input.questionPoints).some(qid => !questionIds.has(qid))) fail(400, 'INVALID_QUESTION_POINTS', '分值表包含不在本卷中的题号');
  for (const q of questions) {
    const point = scheme === 'none' ? 0 : scheme === 'legacy' ? LEGACY_POINTS[q.type] : input?.questionPoints ? input.questionPoints[q.id] : pointsByType[q.type];
    if (point === undefined || !Number.isFinite(point) || (enabled && (point < ((q as StoredLeafQuestion).groupId ? 0 : 0.01) || point > 1000)) || Math.abs(point * 100 - cents(point)) > 1e-6) fail(400, 'INVALID_QUESTION_POINTS', '计分卷每题须有0.01至1000之间、最多两位小数的分值（组合题按分分配后允许零分子题）');
    questionPoints[q.id] = point!;
  }
  const totalCents = questions.reduce((n, q) => n + cents(questionPoints[q.id]!), 0);
  if (totalCents > 1000000) fail(400, 'INVALID_TOTAL_POINTS', '试卷总分不可超过10000分');
  const objectiveCents = questions.reduce((sum, q) => {
    if (q.type !== 'group') return sum + (isSubjectiveType(q.type) ? 0 : cents(questionPoints[q.id]!));
    const parts = distributeGroupPoints(q, questionPoints[q.id]!);
    return sum + flattenQuestions([q]).filter(part => !isSubjectiveType(part.type)).reduce((n, part) => n + cents(parts[part.id]!), 0);
  }, 0);
  const totalPoints = fromCents(totalCents);
  if (input?.totalPoints !== undefined && cents(input.totalPoints) !== totalCents) fail(400, 'TOTAL_POINTS_MISMATCH', '填写的总分与逐题分值之和不一致', { configured: input.totalPoints, actual: totalPoints });
  if (input?.questionPoints && Object.keys(questionPoints).some(qid => input.questionPoints![qid] !== questionPoints[qid])) fail(400, 'INVALID_QUESTION_POINTS', '分值表缺项或与计分模式不一致');
  const result: PaperScoring = { enabled, scheme, totalPoints, questionPoints, objectivePercent: scheme === 'custom' ? input?.objectivePercent ?? 60 : percentage(objectiveCents, totalCents), actualObjectivePercent: percentage(objectiveCents, totalCents), objectivePoints: fromCents(objectiveCents), subjectivePoints: fromCents(totalCents - objectiveCents), pointsByType };
  if (input && 'scheme' in input) {
    for (const key of ['scheme', 'enabled', 'totalPoints', 'objectivePoints', 'subjectivePoints', 'actualObjectivePercent'] as const) if (input[key] !== result[key]) fail(400, 'INVALID_SCORING_SNAPSHOT', `计分快照的 ${key} 与题目分值不一致`);
    if (scheme !== 'custom' && input.objectivePercent !== result.objectivePercent) fail(400, 'INVALID_SCORING_SNAPSHOT', '旧版或无分卷的比例须与派生结果一致');
    if (Object.entries(input.pointsByType).some(([type, point]) => pointsByType[type as QuestionType] !== point)) fail(400, 'INVALID_SCORING_SNAPSHOT', '题型分值与计分模式不一致');
  }
  return result;
}

const objectiveTypes: QuestionType[] = ['true_false', 'single_choice', 'multiple_choice'];
const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;

/** Exact bounded planning. Scores are integer cents; the objective percentage
 * is a preference, never a reason to silently change total, filters or points.
 * Three bounded-knapsack passes cap memory/CPU at 200001 states. If callers
 * also fix a question count, a two-variable enumeration has at most 251001
 * combinations and derives the third objective count algebraically. */
export function planScoredQuestions(pool: Question[], input: ScoringInput, count?: number): { selected: Record<QuestionType, number>; available: Record<QuestionType, number>; questionIds?: string[] } {
  if (pool.some(q => ['fill_blank', 'essay', 'group'].includes(q.type))) return planExtendedQuestions(pool, input, count);
  if (!input.totalPoints || input.totalPoints <= 0) fail(400, 'TOTAL_POINTS_REQUIRED', '随机计分卷须填写大于0的总分');
  if (input.questionPoints && Object.keys(input.questionPoints).length) fail(400, 'RANDOM_QUESTION_POINTS', '随机组卷请设置题型分值，生成后可手动修改逐题分值');
  const available = Object.fromEntries(Object.keys(DEFAULT_POINTS).map(type => [type, pool.filter(q => q.type === type).length])) as Record<QuestionType, number>;
  const points = { ...DEFAULT_POINTS, ...input.pointsByType };
  const values = Object.fromEntries(Object.entries(points).map(([type, point]) => [type, cents(point)])) as Record<QuestionType, number>;
  const target = cents(input.totalPoints!); const requestedPercent = input.objectivePercent ?? 60;
  const maxSubjective = Math.min(available.short_answer, count ?? 500, Math.floor(target / values.short_answer));
  const candidates = Array.from({ length: maxSubjective + 1 }, (_, n) => n).sort((a, b) => Math.abs((target - a * values.short_answer) / target * 100 - requestedPercent) - Math.abs((target - b * values.short_answer) / target * 100 - requestedPercent));
  const result = (objective: number[], subjective: number) => ({ selected: { true_false: objective[0]!, single_choice: objective[1]!, multiple_choice: objective[2]!, short_answer: subjective, fill_blank: 0, essay: 0, group: 0 }, available });
  if (count !== undefined) {
    const [a, b, c] = objectiveTypes.map(t => values[t]);
    const caps = objectiveTypes.map(t => available[t]);
    for (const subjective of candidates) {
      const remainingCount = count - subjective; const remainingPoints = target - subjective * values.short_answer;
      for (let n0 = 0; n0 <= Math.min(caps[0]!, remainingCount); n0++) {
        const otherCount = remainingCount - n0; const delta = remainingPoints - a! * n0 - c! * otherCount;
        if (b === c) {
          if (delta !== 0) continue;
          const n1 = Math.min(caps[1]!, otherCount); const n2 = otherCount - n1;
          if (n2 <= caps[2]!) return result([n0, n1, n2], subjective);
        } else {
          const n1 = delta / (b! - c!); const n2 = otherCount - n1;
          if (Number.isInteger(n1) && n1 >= 0 && n2 >= 0 && n1 <= caps[1]! && n2 <= caps[2]!) return result([n0, n1, n2], subjective);
        }
      }
    }
  } else {
    const active = objectiveTypes.filter(t => available[t] > 0);
    if (!active.length) {
      const subjective = target / values.short_answer;
      if (Number.isInteger(subjective) && subjective > 0 && subjective <= maxSubjective) return result([0, 0, 0], subjective);
    } else {
      const divisor = active.map(t => values[t]).reduce(gcd);
      const maximumObjectivePoints = active.reduce((sum, type) => sum + Math.min(available[type], 500) * values[type], 0);
      const limit = Math.floor(Math.min(target, maximumObjectivePoints) / divisor);
      if (limit > 200000) fail(422, 'SCORING_COMPLEXITY_LIMIT', '该总分和分值步进的精确规划范围过大，请提高每题分值步进、降低总分或指定题量', { maxStates: 200001, suggestion: '使用0.5/1等常见分值步进，或填写固定题量' });
      const infinity = 1000000;
      let previous = new Int32Array(limit + 1).fill(infinity); previous[0] = 0;
      const traces: Int16Array[] = [];
      for (const type of objectiveTypes) {
        const value = values[type] / divisor; const cap = Math.min(available[type], 500);
        const used = new Int16Array(limit + 1); const current = new Int32Array(limit + 1).fill(infinity);
        if (!cap || !Number.isInteger(value) || value > limit) { traces.push(used); continue; }
        const queue = new Int32Array(limit + 1);
        for (let residue = 0; residue < value && residue <= limit; residue++) {
          let head = 0, tail = 0;
          for (let k = 0, amount = residue; amount <= limit; k++, amount += value) {
            while (head < tail && queue[head]! < k - cap) head++;
            if (previous[amount]! < infinity) {
              const candidate = previous[amount]! - k;
              while (head < tail && previous[residue + queue[tail - 1]! * value]! - queue[tail - 1]! >= candidate) tail--;
              queue[tail++] = k;
            }
            if (head < tail) { const chosen = queue[head]!; current[amount] = previous[residue + chosen * value]! + k - chosen; used[amount] = k - chosen; }
          }
        }
        previous = current; traces.push(used);
      }
      for (const subjective of candidates) {
        const objectiveAmount = target - subjective * values.short_answer;
        if (objectiveAmount % divisor || objectiveAmount / divisor > limit) continue;
        let amount = objectiveAmount / divisor;
        if (previous[amount]! >= infinity || previous[amount]! + subjective > 500 || previous[amount]! + subjective < 1) continue;
        const counts = [0, 0, 0];
        for (let i = objectiveTypes.length - 1; i >= 0; i--) { counts[i] = traces[i]![amount]!; amount -= counts[i]! * values[objectiveTypes[i]!] / divisor; }
        if (amount === 0) return result(counts, subjective);
      }
    }
  }
  return fail(422, 'UNREACHABLE_TOTAL_POINTS', '现有题目和分值无法同时满足精确总分与题量限制，请调整总分、题型分值或筛选条件', { available, totalPoints: input.totalPoints, requestedCount: count ?? null, maxQuestions: 500, suggestion: '总分必须能由可用题目的分值组合得到；可尝试0.5/1/2/3等步进，或去掉固定题量' });
}

/** Exact bounded subset planning for all seven types, including mixed groups.
 * Each state retains exact total/objective cents (and count when fixed), so
 * matching a preferred objective ratio never changes the configured total. */
function planExtendedQuestions(pool: Question[], input: ScoringInput, count?: number): { selected: Record<QuestionType, number>; available: Record<QuestionType, number>; questionIds: string[] } {
  if (!input.totalPoints || input.totalPoints <= 0) fail(400, 'TOTAL_POINTS_REQUIRED', '随机计分卷须填写大于0的总分');
  if (input.questionPoints && Object.keys(input.questionPoints).length) fail(400, 'RANDOM_QUESTION_POINTS', '随机组卷请设置题型分值');
  const available = Object.fromEntries(Object.keys(DEFAULT_POINTS).map(type => [type, pool.filter(q => q.type === type).length])) as Record<QuestionType, number>;
  const points = { ...DEFAULT_POINTS, ...input.pointsByType }, target = cents(input.totalPoints!), preference = input.objectivePercent ?? 60;
  type Node = { total: number; objective: number; count: number; answers: number; previous?: Node; ids?: string[] };
  const buckets = new Map<string, { value: number; objective: number; answers: number; ids: string[] }>();
  for (const q of pool) {
    const value = cents(points[q.type]);
    const split = distributeGroupPoints(q, points[q.type]);
    const objective = q.type === 'group' ? flattenQuestions([q]).filter(p => !isSubjectiveType(p.type)).reduce((n, p) => n + cents(split[p.id]!), 0) : isSubjectiveType(q.type) ? 0 : value;
    const answers = q.type === 'group' ? q.parts!.length : 1;
    const key = `${value}:${objective}:${answers}`; const bucket = buckets.get(key) || { value, objective, answers, ids: [] }; bucket.ids.push(q.id); buckets.set(key, bucket);
  }
  const key = (n: Node) => `${n.total}:${n.objective}${count === undefined ? '' : `:${n.count}`}`;
  let states = new Map<string, Node>(); const origin: Node = { total: 0, objective: 0, count: 0, answers: 0 }; states.set(key(origin), origin);
  for (const bucket of buckets.values()) {
    let offset = 0, remaining = Math.min(bucket.ids.length, count ?? 500, Math.floor(500 / bucket.answers), Math.floor(target / bucket.value));
    // Binary bounded chunks preserve every selectable count and avoid 500 passes.
    for (let size = 1; remaining > 0; size *= 2) {
      const take = Math.min(size, remaining), ids = bucket.ids.slice(offset, offset + take); offset += take; remaining -= take;
      const next = new Map(states);
      for (const prev of states.values()) {
        const node: Node = { total: prev.total + take * bucket.value, objective: prev.objective + take * bucket.objective, count: prev.count + take, answers: prev.answers + take * bucket.answers, previous: prev, ids };
        if (node.total > target || node.count > (count ?? 500) || node.answers > 500) continue;
        // At equal totals/objective points (and requested root count), fewer
        // answer slots dominates: it leaves at least as much capacity for all
        // remaining groups. Root count alone cannot make this guarantee.
        const existing = next.get(key(node)); if (!existing || node.answers < existing.answers || (node.answers === existing.answers && node.count < existing.count)) next.set(key(node), node);
      }
      if (next.size > 300000) fail(422, 'SCORING_COMPLEXITY_LIMIT', '精确计分组合过多，请缩小题型范围、使用常见整数分值或降低总分', { maxStates: 300000 });
      states = next;
    }
  }
  const candidates = [...states.values()].filter(n => n.total === target && n.count > 0 && (count === undefined || n.count === count)).sort((a, b) => Math.abs(a.objective / target * 100 - preference) - Math.abs(b.objective / target * 100 - preference) || a.count - b.count);
  const best = candidates[0];
  if (!best) return fail(422, 'UNREACHABLE_TOTAL_POINTS', '现有题目和分值无法同时满足精确总分与题量限制', { available, totalPoints: input.totalPoints, requestedCount: count ?? null });
  const questionIds: string[] = []; for (let node: Node | undefined = best; node?.previous; node = node.previous) questionIds.push(...node.ids!);
  const selected = Object.fromEntries(Object.keys(DEFAULT_POINTS).map(t => [t, 0])) as Record<QuestionType, number>;
  for (const qid of questionIds) selected[pool.find(q => q.id === qid)!.type]++;
  return { selected, available, questionIds };
}
