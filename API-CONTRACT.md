# 认知星图 API 契约 · v1.0

认知星图（noetic-atlas）采用 React、Fastify、TypeScript 与 SQLite。桌面服务默认监听 `127.0.0.1:4317`；Android 使用同一业务模块和 SQLite WASM。本文说明关键行为和事务边界，字段结构以启动时自动生成的 OpenAPI 为准。

- [交互式接口文档](http://127.0.0.1:4317/api/docs/)：Swagger UI，可查看参数并在本机试用。
- [OpenAPI JSON](http://127.0.0.1:4317/api/openapi.json)：由当前注册路由及共用 Zod 校验器自动生成；Android 本地 API 也提供此 JSON。
- [数据类型](shared/models/types.ts)、[系统配置](shared/models/settings.ts)、[AI 类型](shared/ai/ai.ts)、[分享封包](shared/models/sharing.ts)。
- [使用说明书](docs/使用说明书.md)、[README](README.md)。

服务为单用户本地应用，默认没有多用户鉴权。写操作限制同源，远程部署应在受保护的入口后使用。接口文档只生成说明，不安装额外业务校验器，也不改变响应序列化。返回错误统一为 `{error:{code,message,details?}}`；批量写入先验证后以事务提交。

## 分页与通用查询

分页数据使用 `{items,total,page,pageSize}`，页码从 1 开始。资料、题集、作答历史、领域、分类、标签、资源与 AI 记录等列表传入 `page` 或 `pageSize` 时返回分页对象；不传分页参数时可供内部选择器获取完整数组。常用每页数量为 10、20、50、100。题目列表始终返回分页对象。

所有筛选条件取交集。分类筛选包含子类；题目标签支持 `tagMode=all|any`。对字段版本的乐观校验使用返回记录的 `updatedAt`；发生 409 后应刷新记录，保留未提交的编辑内容，再重新确认。

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | `{ok:true}` 健康检查 |
| `GET /api/bootstrap` | 领域、分类、标签、默认配置和统计 |
| `GET /api/taxonomy` | 完整领域／分类／标签树，供选择器使用 |
| `GET /api/{domains,categories,tags}` | 对应实体列表与分页查询 |
| `POST /api/{domains,categories,tags}` | 新建知识归类 |
| `PUT /api/{domains,categories,tags}/:id` | 修改知识归类 |
| `DELETE /api/{domains,categories,tags}/:id` | 删除无引用项；有引用返回 409 |

领域 Domain 与多级 Category 表达知识归属。分类父子必须同领域，禁止循环。题目和资料可使用多个分类。Tag 的 `domainId:null` 表示全局标签；领域标签只用于匹配领域的内容。`kind` 为 `topic|method|custom`，method 表达概念、应用、对比、排错等全局学习方式。难度 D1–D4、深度 L1–L4、频次 F0–F3 使用独立结构化字段，不复制为普通标签。

## 题目

- `GET /api/questions`：支持 search、page、pageSize、domainId、categoryId、tagIds、tagMode、type、difficulty、depth、frequency、collection、status、favorite、due、wrong。
- `GET /api/questions/:id`：题目、答案解析与本机学习状态。
- `GET /api/questions/:id/statistics?partId=...`：实际填写并提交的累计次数，以及 correct、partial、incorrect、ungraded；草稿与整卷漏答不计。answered 为四类总和，unknown 为旧数据无法确认是否填写的数量，不计入作答次数。
- `GET /api/questions/:id/history?partId=...&page=1&pageSize=10`：最近完整作答及 summary、retention，始终分页。包含当时题目、公共材料、答案解析、个人回答、判定、分值与来源；historyAvailable 表示整卷是否还在。组合题可按 partId 查询，省略时汇总各小题。
- 详细历史可加 `summary=false`，省略 summary 且不执行累计统计查询；用于“学习情况”侧栏已单独读取 statistics 的页面。默认仍返回 summary。
- `GET /api/vocabulary?word=...`：按NFKC及大小写规范化后的英语词头精确查找，返回`{word,matches:[{id,title,status}]}`。英文领域或题号经分享重映射后仍按实际领域及词头查询；缺词返回空数组，不自动新增或改变审核状态。多份词卡保留各自状态供选择。网页引用为`#/vocabulary/<词头>`，考试期间此接口同样受锁定。
- `POST /api/questions`：新增题目。显式 draft 保存为草稿，其他状态统一进入 pending；新题不能直接发布。
- `PUT /api/questions/:id`：修改题目，可携带 updatedAt 校验版本；未发布题不能借编辑直接变为 published。
- `DELETE /api/questions/:id`：永久删除。源题集仍引用时返回 `QUESTION_IN_PAPER`；删除清理该题学习状态及复习事件，保留历史作答快照。
- `POST /api/questions/metadata`：严格接收 `{ids}`，1—50,000个不重复题号，返回 `{items,missingIds}`；按输入顺序提供 `id/title/type/status`，包含未发布状态，不读取正文或学习笔记。用于大型题集编辑与草稿恢复的只读批量核对。
- `POST /api/questions/review`：`{ids,action:'approve'|'return_to_draft',confirmed:true,expectedUpdatedAt}`。最多 500 道 pending 题，版本 map 恰好覆盖选题，整批校验后原子处理。
- `GET /api/questions/import-template`：新题 JSON 模板。
- `POST /api/questions/bulk-import`：`{data:learning-new-questions封包,confirmed:true}`。整批新增全部待审核，不覆盖已有 ID。
- `POST /api/questions/pending/export`：`{ids}`，导出带版本的待审核 JSON。
- `POST /api/questions/pending/import`：`{data,confirmed:true}`，批量修订原有待审核题，不新建、不自动发布；保留 id、pending 状态及导出时 updatedAt。
独立题库集合接口已移除，统一通过 `/api/papers` 管理题集。`QuestionBank` 与 `question_banks` 只作为旧数据库／旧 JSON 的迁移输入保留，不再是可创建的业务实体；迁移规则见下文。

题型为 `true_false、single_choice、multiple_choice、fill_blank、short_answer、essay、group`。判断答案为 `true|false`，选择题答案引用选项 key；填空题的 blanks 按顺序保存可接受答案、大小写及首尾空白规则。group 含 2–30 道独立子题，共用主干材料，组题按整组选择，作答时展开。题集可保存超过500个作答项，每次练习或考试最多500个独立作答项。图片采用托管资源链接或已验证的栅格 data URI。

## 资料与文件

- `GET /api/documents`：按 search、collection、kind、domainId、categoryId、tagIds、format 和分页查询。
- `GET /api/documents/kinds`：去重后的有效资料类型，不读取正文供类型选择器使用。
- `GET /api/documents/:id`、`POST /api/documents`、`PUT /api/documents/:id`、`DELETE /api/documents/:id`：管理资料，删除为归档。
- `GET /api/document-drafts?documentId=...`：该资料最近的编辑草稿；省略documentId仅返回新增资料上下文，按更新时间倒序，默认每个上下文最多3份。
- `POST /api/document-drafts`：`{documentId:null|string,baseDocumentUpdatedAt:null|string,state}`，允许未填标题／类型的独立草稿，返回201；不会写入正式资料。
- `PUT /api/document-drafts/:id`：`{expectedUpdatedAt,state}`，覆盖同ID草稿，版本冲突返回409；已删除稿不能通过更新复活。
- `DELETE /api/document-drafts/:id`：`{expectedUpdatedAt}`，仅删除匹配版本的草稿。
- `POST /api/document-drafts/:id/publish`：`{expectedUpdatedAt,asNew?:boolean}`，在事务内校验当前草稿、来源资料版本及正式资料规则，再保存资料并删除对应草稿；原资料更新／归档／删除时保留草稿并返回409，asNew可显式另存。

资料草稿保留完整可编辑字段及附件引用，支持SQLite和完整JSON的documentDrafts迁移。草稿不参与资料搜索、统计或内容分享；草稿引用的附件不能删除。只读取当前上下文的有界正文，保留裁剪读取轻量头部。配置maxDocumentDrafts默认3，自动保存等待复用autosaveDebounceMs。
- 资料字段含 title、kind、domainIds、categoryIds、tagIds、author、publisher、publishedYear、description。Markdown 正文保存为 bodyMarkdown；PDF 通过 assetId 关联 PDF 资源，fileName 记录文件名。
- `POST /api/assets`：`{filename,mimeType,dataBase64}`，验证字节、MIME、大小及图片尺寸，返回资源元信息。
- `GET /api/assets`：资源列表及 referenced 状态，支持分页。
- `GET /api/assets/:id`：元信息；`GET /api/assets/:id/data`：含 Base64 的完整资源；`GET /api/assets/:id/content`：准确二进制与 MIME。
- `DELETE /api/assets/:id`：仅可删除无引用资源。保护题目、资料、笔记、题集和历史作答快照中的资源引用。

支持 UTF-8 Markdown、PDF、PNG、JPEG、GIF、WebP；不接受 SVG。图片不超过单边 16384 像素及总计 4000 万像素，文件大小另受配置限制。资源字节包含在 SQLite 中，完整迁移不依赖外部文件目录。

## 题集、组题草稿与计分

- `GET /api/papers`：支持 archived、organization=domain|other、domainId 和分页；`GET /api/papers/:id` 返回题集及不含答案的题目快照，同时提供选题单位数 questionCount 与展开作答项数 answerCount。加 `?summary=true` 仅返回题目元数据，不传题干、选项和材料；需要完整内容时按题读取快照接口。
- `GET /api/papers/:id/questions/:questionId`：读取题集内指定作答项的完整快照与答案，用于就地看题；不会替换为当前源题内容。考试期间仍受其他功能访问锁限制。
- `POST /api/papers`、`PUT /api/papers/:id`：手动卷使用 questionIds；随机卷使用 filters、count 或 scoring。领域专项需 `organization:'domain',domainId`，其他卷使用 other。修改创建新版本，不修改已开始作答的快照。
- `POST /api/papers/preview`：同一组题结构，返回预览但不保存；随机卷正式生成时重新抽题。候选不足、无精确分值组合或展开后超限时拒绝，不静默放宽条件。
- `DELETE /api/papers/:id`：归档；加 `?permanent=true` 永久删除源卷，保留作答快照。
- `POST /api/papers/:id/restore`：显式 `{confirmed:true}` 恢复非空且全部成员已发布的归档题集。首次恢复未经编辑的旧集合无分题集时刷新已审核快照并产生新版本；其他恢复保留原快照、版本和分值。已有作答不受影响。
- `GET /api/paper-drafts?context=...`：最近组题草稿数组，按 updatedAt 排序。
- `POST /api/paper-drafts`：`{context,state:PaperDraftState}`，保存新的组题草稿并按 context 裁剪最近 maxPaperDrafts 份。
- `PUT /api/paper-drafts/:id`：`{expectedUpdatedAt,state}`，继续原草稿时覆盖同一 ID，版本不符返回 `PAPER_DRAFT_VERSION_CONFLICT`。
- `DELETE /api/paper-drafts/:id`：删除组题草稿。

PaperDraftState 保存未完成的卷名、组织、题目顺序、筛选、随机规则、计分开关、逐题分值与总分等，不要求它已经满足正式成卷条件。组题草稿与答题草稿分别管理，默认上限均为 3。

计分使用最多两位小数的分值。手动卷逐题分值之和必须等于总分。随机计分卷按总分、题型分值和目标客观占比寻找组合；目标比例不能保证完全命中，会显示实际组成。计分配置随卷及作答快照保存，后续默认值变化不重算历史成绩。无分练习仍核对客观题答案，但不产生数字成绩。

## 作答计时与考试模式

- `POST /api/papers/:id/attempts`：可选 `{mode:'practice'|'exam',durationMinutes:1..1440,count?:1..500,selection?:'ordered'|'random'}`，创建一次独立作答。count 按父题／组合组选题，展开后仍不得超过500个作答项。大型题集必须显式指定本次题量，缺失返回 `QUESTION_SET_SESSION_LIMIT`；不能静默截取前500题。ordered 按题集顺序从头选题，random 不重复随机抽取，题集本身保持完整。普通练习默认顺计时；考试时长缺省取系统 examDurationMinutes，初始 120 分钟。
- `GET /api/papers/:id/drafts`：该卷最近未交卷作答，受 maxDraftsPerPaper 限制；继续答题使用原 attempt ID。
- `GET /api/attempts`：按 paperId、source=paper|quick、status=in_progress|submitted 与分页查询。
- `GET /api/attempts/:id`：作答快照；未交卷隐藏答案、解析和填空标准答案。
- `PUT /api/attempts/:id`：`{answers:Record<questionId,{value}>}`，合并并持久化本次传入答案，不新建草稿。
- `POST /api/attempts/:id/submit`：可选 `{answers}`，交卷并计算客观题得分，固定 elapsedSeconds；重复交卷不重复累计错题。
- `PUT /api/attempts/:id/review`：`{scores?,mastery?,verdicts?}`，交卷后保存主观评分、掌握自评或 correct／partial／incorrect 判定；数字评分限主观题 0 至快照满分，null 撤销评分。计分题判定必须与分值一致；不计分题可以只判对错。不能修改客观得分。
- `GET /api/exams/active`：`{attempt:Attempt|null}`，查询当前考试。
- `POST /api/exams/sync`：同步到期状态，返回当前考试；`POST /api/attempts/:id/sync` 同步一份作答并返回 Attempt。
- `POST /api/quick-practice`：指定 questionId，或使用 filters 与 excludeQuestionId 随机单题自测；`POST /api/attempts/:id/reveal` 仅允许随机／单题会话提前查看解析。

计时依据 startedAt、deadlineAt 与持久化时间戳，页面刷新或休眠不依赖 interval 累加。考试进行中网页路由固定在考试页面；API 也限制使用其他功能，交卷完成后解除。到期通过界面或后续请求同步自动交卷，仅使用到期前已经保存的答案；到期后的请求不能替换答案。考试过期交卷的 submittedAt 固定为 deadlineAt，并记录 autoSubmitted。

作答页不挂载学习笔记编辑器，也不为展示学习控件额外请求原题内容或历史统计。笔记在题库和题集查阅组件中编辑；随机自测仍允许显式调用 reveal 查看参考解析，交卷后才展示阅卷与本次掌握自评。

答题卡的状态由共用规则计算：提交前为未作答／已作答；提交后为未作答／正确／部分正确／错误／未判定。主观题满分、部分得分和零分分别对应三种判定，不计分题使用已确认的判定；未判题保留未判定。

## 题集学习记录与系统配置

- `GET /api/learning/summary?source=paper&paperId=ID`：当前题集的草稿、历史、错题、到期与收藏计数；随机／单题使用 `source=quick` 且不能携带 paperId。
- `GET /api/learning/attempts`：同一上下文，必填 `status=in_progress|submitted`，支持 page、pageSize，返回不含题目和答案正文的分页历史摘要。
- `GET /api/learning/questions`：同一上下文，必填 `kind=wrong|due|favorite`，支持分页，返回当次内容快照、关联作答及必要原题学习状态。
- `GET /api/learning/contexts`：分页返回仍有作答或独立学习结果、但源题集已永久删除的上下文，供题集页保留历史入口。
- `GET /api/learning/global/summary`：返回三个固定汇总题集的去重题数 `{counts:{wrong,favorite,due}}`。
- `GET /api/learning/global/questions?kind=wrong|favorite|due`：分页返回汇总题目、复合 `key`、完整 `origins` 及 `snapshotSource`。错题合并各来源仍待巩固的错误，默认返回最近错误快照；收藏与到期采用存活原题，包含没有题集或作答关联的题目。来源可含题集、版本、是否已删除、具体作答ID与时间；不截断来源列表。
- `POST /api/learning/card-summaries`：严格接收 `{paperIds}`，1—100个不重复题集ID，返回 `{items:[{paperId,counts:{wrong,favorite,due,drafts,submitted}}]}`。只读批量统计，不写学习状态；移动运行时不触发落盘。
- `GET /api/study`：`items`整题状态、`partItems`小题状态和复习记录；`GET /api/reviews` 可按 questionId、partId 与分页查询，`whole=true`仅查询整题旧记录。
- `PUT /api/study/:id`：`{partId?,favorite?,mastery?,notes?,nextReviewAt?}`；`POST /api/study/:id/review`：`{partId?,mastery:0..3}`。指定partId时掌握、日期和笔记仅作用于该小题，收藏仍在整题记录操作。题目详情返回`partStudies`，旧整组状态不克隆为各小题状态。
- `GET /api/learning/reset-preview`：读取影响数量及新鲜度指纹；`POST /api/learning/reset`接收`{confirmed:true,fingerprint}`，事务内重新核对。清除掌握、复习安排、错误状态与复习事件，保留收藏、笔记、卷面历史成绩和草稿。过期返回`LEARNING_RESET_PREVIEW_STALE`，必须重新预览。
- `GET /api/settings`：SystemSettings；`PUT /api/settings`：`{settings,confirmedRetention?,expectedRetention?}`。

`SystemSettings.theme`为`green|dark|pink|sky|mint`，默认`green`；旧配置缺少该字段时补默认值。主题属于可迁移的外观偏好，配置导出、完整备份及Android本地持久化均保留，未知主题拒绝写入。

前端不再设置全局学习记录导航：题集详情组织各自草稿、历史、错题与复习，随机与单题在随机练习页单独组织。上下文错题取该范围内每个叶题最新已判结果，后续正确则移出，未判不覆盖已判，未答客观题需巩固。`learning_results`独立保存判定、来源及错误题目必要快照，不保留整卷答案；清理历史后仍可阅读公共材料和错误题目，`historyAvailable:false`表示不再有完整复盘，客户端不生成失效链接。组合小题使用原题ID与小题ID的元组保存学习状态；收藏整组，掌握、日期及笔记独立。

配置包括答题草稿上限、随机自测草稿、组题草稿 maxPaperDrafts、历史保留、考试分钟、组题默认值、每种题型分值、复习间隔、自动保存等待、资料及图片大小。初始答题／组题草稿各 3 份；提交历史 0 表示不限量；组题默认 20 题、不计分；计分时默认 100 分、客观目标 60%；考试默认 120 分钟。

单题详情由 maxQuestionHistory 独立控制，默认每个叶题10次，0关闭独立详情保留，不限制整卷历史。整卷存在时 question_history 仅引用原作答；整卷裁剪前只归档仍被单题保留的快照与回答。单题详情超限不清累计统计，也不清整卷；提高上限不会复活已裁剪详情。重评更新同一回答的分类，不增加作答次数。重置学习进度清累计统计，保留的旧详情标 beforeReset。旧备份仅能从尚存完整作答补建详情，已经清掉的回答不推算。

降低保留上限若会删除已有记录，首次返回 409 `RETENTION_CONFIRMATION_REQUIRED` 与 `{drafts,history,authoring?,documentDrafts?,questionHistory?,total}`。界面展示具体数量，用户确认后携带原 expectedRetention 再保存；确认期间数量改变再次要求确认。配置版本、记录裁剪与设置保存都在事务中处理。裁剪不删除独立错题状态、错误快照、来源摘要、笔记及复习安排。旧库启动和旧备份导入时从尚存历史补建学习证据，已提前删除的历史无法追溯恢复。

## AI 配置与任务

AI 使用 OpenAI-compatible Chat Completions 协议，结果为结构化 JSON，兼容普通和流式响应。默认关闭、端点与模型为空、无密钥；发布版不包含个人服务配置。调用由用户发起，输入作为不可信资料，模型不执行代码或工具。请求／输出仍由服务进行结构、版本、引用与分值校验。

| 接口 | 请求与结果 |
| --- | --- |
| `GET /api/ai/settings` | AiSettings，仅返回 hasKey，不返回密钥 |
| `PUT /api/ai/settings` | enabled、baseUrl、model、supportsImages、sendImages、timeoutSeconds、maxTokens；可附 updatedAt、只写 key 或 clearKey |
| `POST /api/ai/test` | `{}` → `{ok,message,model}`，真实连通测试 |
| `GET /api/ai/capabilities` | 开启情况与支持的功能，不等于已验证远端在线 |
| `GET /api/ai/runs` | 按 kind、questionId、attemptId 过滤并分页 |
| `GET /api/ai/runs/:id` | 单条结构化分析记录 |
| `DELETE /api/ai/runs/:id` | 删除分析记录，不撤销已经采纳的内容 |

key 省略保留，空字符串或 clearKey 清除。baseUrl 支持 HTTP(S) 根地址或完整 chat/completions 路径；不允许嵌入账号、查询参数或片段。密钥通过 Authorization Bearer 发送，不自动跟随重定向。默认超时 60 秒（可设 5–180），输出上限 4096 tokens（可设 256–32000）。

任务成功返回 `AiRun<Result>`，kind 为 `explain|grade|import|review|paper_plan`，含 id、createdAt、model、warnings、questionIds、result 及应用标记。内部版本上下文和 API 凭据不对外返回。失败不伪造成功记录。

### 实时进度与取消

`POST /api/ai/test、explain、grade、import、review、paper-plan` 及 `POST /api/attempts/:id/ai-review` 默认保持 JSON 请求／响应。Web 和 Windows 桌面端发送 `Accept: text/event-stream`，服务立即建立 SSE，逐帧发送 `data: <JSON>\n\n`；注释心跳应忽略。事件协议见 [AiProgressUpdate / AiStreamEvent](shared/ai/ai-progress.ts)：

| type | 字段及含义 |
| --- | --- |
| `status` | stage、message，以及可选 current、total；实际执行阶段与已完成数量 |
| `delta` | text；模型真实返回的答案片段，仍可能是未闭合、未验证的 JSON |
| `result` | result；完整校验并保存后的最终 JSON 结果，与普通调用的响应对象一致 |
| `error` | error:{code,message,statusCode?}；流建立后的失败，无最终成功结果 |

不能将 `delta` 用于保存、评分或导入；只有 `result` 表示本次处理完成。流建立前同源检查、考试锁等失败仍使用普通 HTTP 错误；流建立后 HTTP 已为 200，客户端必须处理 `error` 并检查最终事件，不能仅按 HTTP 状态判成功。连接中断且未收到 `result` 也不能当作成功。服务不发送模型隐藏思考、提供商原始错误、凭据或堆栈。

浏览器取消通过 AbortSignal 断开请求，服务中止提供商读取，并在异步模型请求后、保存记录或自动发布前检查取消状态。Android 通过 `x-atlas-ai-progress` 对应的同进程订阅接收阶段更新，仍等待 JSON 和 SQLite 文件持久化后确认成功；当前原生 HTTP 通道缓冲完整响应，因此只显示真实阶段，不模拟逐字输出。取消后忽略原生请求的迟到结果，不继续保存或应用未完成结果。

### 推荐组题

1. `POST /api/ai/paper-plan`：`{prompt,count?,filters?}`。count 可选，范围 1–500；手动指定时优先于提示词数量。省略时从提示词识别题量，未写数量默认 20。领域、分类、标签、题型、难度等可直接写入 prompt，无需先选择筛选；手动 filters 为硬约束，与提示词识别条件取交集，不能被模型扩大。
2. 候选范围不再设 300 题上限。先查询已发布题目的轻量元数据，从要求中识别范围并检索排序，按输入字节预算截取候选摘要，再分批推荐；小候选池且手动指定数量时可直接让选择阶段理解提示词。不把全库正文一次性发送给模型。仅发送候选题号、标题、题干摘要、类型、难度及相关分类标签等，不发送参考答案、解析、笔记、作答或图片。
3. 返回 `AiRun<AiPaperPlanResult>`：title、description、items:[{questionId,reason}]、requestedCount、candidateCount、candidates，以及 retrieval:{availableCount,matchedCount,reviewedCount,batches,interpreted,summary}。availableCount 是手动范围内可用题量，matchedCount／candidateCount 是识别条件匹配量，reviewedCount 是实际送入模型比较的不重复候选量；batches 是选题批次，interpreted 表示是否先单独解析提示词。模型必须返回要求数量的不重复候选 ID，跨批次也不得重复。每次AI推荐最多500个展开作答项，组合题按子题数量占用额度。
4. 用户可在预览中移除、添加本次实际比较过的候选题、修改顺序、题量和逐题分值。可用范围和匹配量不表示该范围内每题都已发给模型；补充选择只允许返回的 candidates。
5. `POST /api/ai/runs/:id/paper`：`{confirmed:true,title,description?,questionIds,organization?,domainId?,scoring?}`。重新校验选题、发布状态、分析时版本与展开作答项上限，复用普通组题业务，返回 201 `{paper,run}`。同一结果只创建一次，保存后通过普通题集编辑。

相关错误：`AI_PAPER_INSUFFICIENT_QUESTIONS`、`AI_PAPER_COUNT_TOO_LARGE`、`AI_PAPER_FILTER_INVALID`、`AI_PAPER_TOO_MANY_PARTS`、`AI_PAPER_SELECTION_INVALID`、`AI_PAPER_CANDIDATE_MISMATCH`、`AI_PAPER_ALREADY_CREATED`、`AI_QUESTION_VERSION_CONFLICT`。数量不足、提示词条件不合法或题目变更时明确失败，不静默放宽范围；分批任务全部成功后才生成一条完整分析记录。

### 解析与主观评价

- `POST /api/ai/explain`：`{questionId,partId?}` → explanationMarkdown、followUpsMarkdown、pitfallsMarkdown。结合题干、原答案解析和追问补充说明，不替换原解析。
- `POST /api/ai/grade`：`{attemptId,questionIds?,gradingRequirements?}` 评价已提交卷中的 1–20 道主观题；或 `{questionId,answer,maxPoints?,gradingRequirements?}` 临时评价单道简答／论述。要求最多10000字符；单题满分范围0.01–1000、最多两位小数；卷题使用当时快照。`POST /api/attempts/:id/ai-review` 同样接收 questionIds 和 gradingRequirements。
- 评价返回逐题 verdict（correct／partial／incorrect）、score、maxPoints、comment、strengths、improvements。有分卷建议分与判定须一致；无分卷分数二者为 null，仍给出判定。服务保存实际使用的 gradingRequirements。旧无明确判定且无分值的分析标 requiresRegrade，显示未判定并阻止应用，须重新评价。
- `POST /api/ai/runs/:id/apply`：`{confirmed:true,applyScores?,appendNotes?,questionIds?}`。至少选择一项；applyScores 应用已提交作答的判定，有分题另应用分值；返回 appliedScores、appliedVerdicts。单次临时评价可写笔记，不能伪造已提交统计。笔记包含判题要求与结果并保留原内容，同一结果不重复追加。应用前校验源题／作答版本，客观成绩不变。

### 转换导入与审核

- `POST /api/ai/import`：`{text,sourceName?,categoryIds?,tagIds?,count?}`，每批最多 50 题。返回候选结构及领域／分类／标签名称建议；文件先在客户端提取文字，扫描 PDF 需先 OCR，不接受任意服务器文件路径。
- `POST /api/ai/runs/:id/import`：`{confirmed:true,indexes?或questions?,categoryIds?,tagIds?}`。选择或修订后确认，生成新 ID，全量进入 pending。整批校验失败不保存；同一结果不可重复导入。
- `POST /api/ai/review`：`{questionIds,autoApprove?,expectedUpdatedAt}`。每批 1–20 道 pending 题。返回 valid／needs_changes／uncertain、issues 和可选 suggestedChanges。仅本次明确启用 autoApprove 且模型无问题、无缺图等警告时，valid 项通过审核；发布前再次校验版本。
- `POST /api/ai/runs/:id/correction`：`{confirmed:true,questionId}`，应用修订建议后仍为 pending，需要再次审核。

图片需同时开启 supportsImages 与 sendImages，仅发送用户选中资料中的托管／合法内嵌栅格图片，最多 8 张、Base64 总量 8 MiB；不自动下载远程图片。未发送、缺失或超限图片写入警告，阻止自动发布。推荐组题始终只使用文字摘要，不传图片。

单次模型文字输入上限 600000 字节，完整答案上限 2 MiB；提供商 SSE 传输另有 32 MiB 字节上限，客户端进度流累计接收上限 16000000 字节。分批组题按每次提供商请求执行超时和输出限制，不将整份大卷塞入一次响应。不透出提供商原始错误正文。常见错误为 `AI_DISABLED`、`AI_CANCELLED`、`AI_TIMEOUT`、`AI_PROVIDER_ERROR`、`AI_INVALID_JSON`、`AI_INVALID_OUTPUT`、`AI_OUTPUT_TRUNCATED`、`AI_SCORE_OUT_OF_RANGE` 和版本冲突。

## 分享、导出与迁移

- `POST /api/sharing/export`：按 ShareSelection 导出单题、筛选题目或题集的自包含 learning-share JSON，包含领域、分类、标签、题目、必要图片及卷配置。
- `POST /api/sharing/preview`：预检分享包、冲突映射与 fingerprint；`POST /api/sharing/import`：确认后按预检 fingerprint 导入。自动补齐知识归类并处理 ID 冲突；不会因对方缺少分类而要求手工先建完整目录。
- `POST /api/sharing/export-document`：同一选择返回 ExportDocument，由网页／Android 共用渲染器生成含答案的 PDF 或 Markdown；普通题目选择单批最多500题，题集分享受封包大小和完整性校验。
- `GET /api/papers/:id/export-document?mode=blank|answers`：空白卷或答案卷；`GET /api/attempts/:id/export-document?mode=blank|answers|completed`：已提交会话的快照卷。
- `GET /api/papers/:id/export?answers=true|false`：Markdown 卷。网页下载转换托管图片为 data URI；PDF 中 PNG/JPEG 直嵌，GIF/WebP 使用首帧。
- `GET /api/export`：完整 JSON；`POST /api/import`：`{data,mode:'merge'}`。迁移保留题目原审核状态，与新增题目导入区分；同 ID 内容不静默覆盖。
- `GET /api/backup.sqlite`：可迁移 SQLite 下载副本，清除 AI 密钥，保留本机源库。JSON 备份／分享不包含 AI 凭据；附件较多时优先 SQLite。

Android通过原生平台接口接收SQLite二进制进行完整恢复，不通过HTTP JSON传输。预览先检查原始文件头、完整性、版本、应用表结构及记录主键，再在隔离副本验证数据和引用，剥除输入触发器及派生缓存并由可信代码重建。确认绑定已校验文件、本机写入版本及磁盘基线；本机有活动考试时拒绝。替换前写入并回读独立原库副本，落盘失败回退原连接和原文件；成功后刷新应用，旧页面写入被拒绝。恢复后的AI密钥清除且AI关闭，需重新填写启用；原库私有副本仍含原配置，对外导出时脱敏。JSON完整备份包含`studyParts`、`learningResults`及`questionHistory`，与同包作答不一致的学习证据整批拒绝。合并时同ID保留本地记录，不用旧备份覆盖本地较新判题。

旧数据库启动、可信 JSON 导入及旧分享包导入时，会把 questionBanks／question_banks 自动转为题集，保留名称、说明、顺序与完整题目快照；ID冲突使用迁移标记和新ID处理，重复导入不重复创建。含未发布题或空集合先归档。旧 bankId 筛选被清理，已有题目、笔记和作答历史不改写。

导入和读取旧记录时，也会清理已停用的专用复习元数据；题目、个人专项属性、笔记、成绩及作答时间保留。JSON和SQLite下载副本也采用相同清理规则，不改写正文中的普通词语或任意用户对象。

分享用于独立内容交付，完整迁移用于恢复工作空间。两者都由服务验证关系、图片字节和引用完整性；分享不携带个人笔记、作答和 AI 密钥。Android 的文件分享面板由用户选择应用及接收者，系统不自动向联系人发送文件。
