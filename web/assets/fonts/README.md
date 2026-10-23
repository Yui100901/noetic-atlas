# 离线 PDF 中文字体

- 字体：Noto Sans SC Regular，静态 TrueType（10,596,232 字节）。
- 来源：[notofonts/noto-cjk 官方仓库的 NotoSansSC-VF.ttf](https://github.com/notofonts/noto-cjk/blob/main/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf)。将变量字体固化为 `wght=400`，保留完整字符覆盖和原有版权元数据；未使用其保留名称 `Source`。
- 来源 SHA-256：`d68bafcb48a2707749396aa12bbbd833cb70401f3a9a689fd2902c7e0d295964`。
- 静态文件 SHA-256：`dc2b39840d14e98879d8455f1258560464910f1b735d296098631aab2be0082c`。
- 许可证：SIL Open Font License 1.1，随附 `OFL-NotoSansCJK.txt`。
- 使用：Vite 将字体作为本地资产打包；仅在生成 PDF 时加载，PDF 完整嵌入并压缩字体。该字体在 fontkit 子集嵌入时会产生缺字，因此禁用子集以确保普通阅读器可正确显示中文。每份 PDF 有约 6.5 MB 固定字体开销。
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
