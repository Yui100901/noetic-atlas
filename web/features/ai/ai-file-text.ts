import {
  aiImportLimits,
  needsBatchedImport,
  type AiImportLimits,
} from '../../../shared/ai/import-limits';
import { extractDocumentFiles } from './ai-document-files';

/** File parsing is local. Only reviewed text is sent to the provider. */
export async function extractQuestionFile(
  file: File,
  configuration?: Partial<AiImportLimits>,
): Promise<{ text: string; message: string }> {
  const limits = aiImportLimits(configuration);
  const extracted = await extractDocumentFiles([file], { limits });
  const text = extracted.sections
    .map((section) => section.text)
    .join(/\.pdf$/i.test(file.name) || file.type === 'application/pdf' ? '\n\n' : '');
  if (needsBatchedImport(text))
    throw new Error(
      '材料已超过单次模型处理预算，请切换本页“教材分批出题”并选择此文件。材料未截断或发送模型。',
    );
  return {
    text,
    message: `已在本机读取${extracted.pages ? extracted.pages + '页PDF' : file.name}。请核对原文、多栏、公式与图片；确认前不会发送模型。`,
  };
}
