/** Existing workflow scenarios explicitly keep distinct similar prompts. The
 * dedicated dedup suite verifies reuse, replacement and unresolved blocking. */
export async function confirmReviewedImport(scope) {
  await scope.getByRole('button', { name: /^查重并准备导入/ }).click();
  const confirm = scope.getByRole('button', { name: /^确认导入已核对题目/ });
  await confirm.waitFor();
  const keepBoth = scope.getByRole('button', { name: '未处理项全部保留两者', exact: true });
  if (await keepBoth.count()) await keepBoth.click();
  await confirm.click();
}
