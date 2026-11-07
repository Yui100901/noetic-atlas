/** Question counts are owned by the actual selection, never a provider batch.
 * Only explicit question/vocabulary count phrases are touched; levels (N5),
 * chapter numbers, years, percentages and unrelated bare numbers stay intact. */
const countPhrases = () =>
  /(?<![A-Za-z0-9])(\d+)\s*(?:(?:道|个)?\s*题(?:目)?|(?:个|条)?(?:常用|高频|核心|基础|重点|日语|英语){0,4}(?:单词|词汇|词语)|questions?\b)/gi;
export function paperMetadataForCount(
  metadata: { title: string; description: string },
  count: number,
  options: { providerBatch?: boolean; previousCount?: number } = {},
) {
  let mismatch = false;
  const replace = (text: string, previousOnly = false) =>
    text.replace(countPhrases(), (phrase, value: string) => {
      if (
        previousOnly &&
        options.previousCount !== undefined &&
        Number(value) !== options.previousCount
      )
        return phrase;
      if (Number(value) === count) return phrase;
      mismatch = true;
      return phrase.replace(value, String(count));
    });
  const title = replace(metadata.title, options.previousCount !== undefined),
    description = replace(metadata.description, true);
  const batchSpecific = /本批|首批|当前批|这批|本轮(?:选取|选择|推荐)|this batch/i.test(
    metadata.description,
  );
  return {
    title: title.replace(/本批|首批|当前批|这批/g, '').trim() || `学习题集（${count}题）`,
    description:
      options.providerBatch && (mismatch || batchSpecific)
        ? `本题集包含${count}道题目；学习范围、难度和顺序请以全卷预览为准。`
        : description,
    adjusted: mismatch || !!(options.providerBatch && batchSpecific),
  };
}
