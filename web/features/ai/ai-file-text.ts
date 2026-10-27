/** File parsing is local. Only the reviewed extracted text is sent to the provider. */
export async function extractQuestionFile(file:File):Promise<{text:string;message:string}> {
  if(file.size>30*1024*1024)throw new Error('文件超过30 MiB，请拆分后处理。');
  if(/\.pdf$/i.test(file.name)||file.type==='application/pdf') {
    const pdfjs=await import('pdfjs-dist');
    const worker=await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc=worker.default;
    const base=new URL(import.meta.env.BASE_URL,document.baseURI);
    const task=pdfjs.getDocument({
      data:new Uint8Array(await file.arrayBuffer()),useSystemFonts:true,cMapPacked:true,
      cMapUrl:new URL('pdfjs/cmaps/',base).href,
      standardFontDataUrl:new URL('pdfjs/standard_fonts/',base).href,
    });
    try {
      const doc=await task.promise;
      if(doc.numPages>150)throw new Error(`文件共有${doc.numPages}页；单次最多150页，请改用“多文件 / 教材分批”，可直接选择本文件，无需外部拆分PDF。`);
      const pages:string[]=[];
      for(let pageNumber=1;pageNumber<=doc.numPages;pageNumber++) {
        const page=await doc.getPage(pageNumber);const content=await page.getTextContent();
        const lines=content.items.map(item=>'str'in item?item.str+('hasEOL'in item&&item.hasEOL?'\n':' '):'').join('');
        pages.push(`--- 第${pageNumber}页 ---\n${lines.trim()}`);page.cleanup();
      }
      const text=pages.join('\n\n');
      if(!text.replace(/--- 第\d+页 ---/g,'').trim())throw new Error('未提取到文字。此PDF可能为扫描图片，请先进行OCR或转为可复制文字后导入。');
      return {text,message:`已在本机提取${doc.numPages}页文字。请核对多栏、表格、公式和图片题，扫描图片不含OCR。`};
    } finally {await task.destroy();}
  }
  if(!/\.(txt|md|markdown|json|csv)$/i.test(file.name))throw new Error('支持PDF、TXT、Markdown、JSON和CSV文件；其他文档可先导出为这些格式。');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());
  if(text.includes('\0'))throw new Error('文件不是有效文本。请转为UTF-8文本格式。');
  return {text,message:'已在本机读取文本；请核对编码、题目范围和参考答案后运行AI转换。'};
}
