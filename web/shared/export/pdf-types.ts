export type PdfNode = {
  type: string;
  lang?: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number;
  checked?: boolean;
  url?: string;
  alt?: string;
  identifier?: string;
  children?: PdfNode[];
};
export interface PdfImageData {
  data: Uint8Array;
  mimeType: string;
}
export interface PdfFormulaImage extends PdfImageData {
  width: number;
  height: number;
  baseline: number;
}
export type PdfFormulaResolver = (
  source: string,
  display: boolean,
  size: number,
) => Promise<PdfFormulaImage>;
export type PdfImageResolver = (url: string) => Promise<PdfImageData | null>;
