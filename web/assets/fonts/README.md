# 离线 PDF 中文字体

- 字体：Noto Sans SC Regular，静态 TrueType（10,596,232 字节）。
- 来源：[notofonts/noto-cjk 官方仓库的 NotoSansSC-VF.ttf](https://github.com/notofonts/noto-cjk/blob/main/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf)。将变量字体固化为 `wght=400`，保留完整字符覆盖和原有版权元数据；未使用其保留名称 `Source`。
- 来源 SHA-256：`d68bafcb48a2707749396aa12bbbd833cb70401f3a9a689fd2902c7e0d295964`。
- 静态文件 SHA-256：`dc2b39840d14e98879d8455f1258560464910f1b735d296098631aab2be0082c`。
- 许可证：SIL Open Font License 1.1，随附 `OFL-NotoSansCJK.txt`。
- 使用：资源准备脚本生成 `public/fonts/` 与 `mobile/assets/fonts/` 下的 `NotoSansSC-Regular.ttf.bin`（6,308,656 字节，内容为gzip），不将原始TTF重复放进分发目录。使用`.bin`避免Android AAPT将`.gz`文件自动解压并去掉后缀；前端显式解码。生成PDF时才本地加载、按上限流式解压并缓存；优先原生 `DecompressionStream`，旧环境回退FFlate，解码结果与原字体逐字节一致。
- PDF仍完整嵌入并压缩字体。该字体在fontkit子集嵌入时会产生缺字，因此禁用子集以确保普通阅读器可正确显示中文。每份PDF仍有约6.5MB固定字体开销；gzip存储减少分发资源和Web加载流量，Android APK本已压缩资源，不能将原始资源节省量直接当作APK节省量。
- PDF 渲染不请求在线字体或远程图片。极少数字体未覆盖的字符会显示为可读的 `[U+码点]`，避免静默丢字或黑方块。
- Markdown 的图片保留文字说明；大于 5 列的表格在 PDF 中转为逐条带列名的记录，以保持 A4 上可读性。

可使用 FontTools 4.67.0 在构建环境复现静态字重（运行应用无需 Python 或 FontTools）：

```python
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
font = TTFont('NotoSansSC-VF.ttf')
instantiateVariableFont(font, {'wght': 400}, inplace=True)
font.save('NotoSansSC-Regular.ttf')
```

来源字体版权：© 2014–2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.
