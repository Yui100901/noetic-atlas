# 测试隔离与 CI

业务测试继续使用一个入口：`npm test`。页面验收脚本只检查已经构建的 Web 资源，执行前需要 `npm run build`；它们不会自行替换正在运行的应用。

## Android 测试构建复用

`scripts/testing/native-runtime-bundle.mjs` 用实际 Android 的 `mobile/runtime.ts` 和 `nativeAliases` 编译测试模块。`scripts/test.mjs` 在启动 Node 的测试文件进程前构建一次，通过 `NOETIC_NATIVE_TEST_BUNDLE` 传递模块的绝对路径。移动测试统一调用 `tests/helpers/native-runtime.ts` 的 `loadNativeRuntime()`。

单文件仍可直接执行，不依赖先运行全量测试：

```bash
node --import tsx --test tests/mobile/mobile-storage-effects.test.ts
```

直接执行时，helper 会准备同样的缓存。缓存位于被 Git 忽略的 `test-results/cache/native-runtime/`；键包含 mobile、server、shared 的源码、依赖锁、Node 版本和构建 helper 内容，源码或依赖变化会产生新的缓存。生成资源、工作数据和学习状态不参与缓存。

多个测试进程同时首次构建时使用独占锁，先在独立临时目录编译，再原子发布整个输出目录。只有包含完整 manifest 和模块的缓存可以复用。编译失败会清理当前临时输出及当前锁；强行终止构建可能留下 `.lock`，超时错误会给出路径。先确认没有仍在构建的进程，再删除该锁或整个缓存目录，不要在构建进行中清理缓存。

**复用的是编译代码，不能复用运行实例。** `loadNativeRuntime()` 每次导入独立的模块命名空间，隔离 SQLite/fs shim 的模块全局值。测试仍分别创建 SQL 模块、`createLocalRuntime()`、种子及存储适配器，并关闭自己的实例。测试内部需要模拟重新打开数据库时，可以有意复用当前测试的存储字节，不能把字节放到跨测试的单例里。

`NOETIC_NATIVE_TEST_BUNDLE` 只供受控测试进程使用；自定义时必须给出当前源码对应的绝对模块路径。无效路径应报错，不静默导入另一个旧 bundle。一般无需手动配置它。

## 浏览器隔离 harness

新脚本优先使用 `scripts/qa/helpers/browser-harness.mjs`。目前已迁移保存条、设置保存和资料筛选三份脚本，既有业务断言保持原范围。

- 每次启动独立 `:memory:` 数据库，禁用每日推题定时器，显式不加载本地题库种子，只监听 `127.0.0.1` 的动态空闲端口。不能连接用户的 4317 服务。
- `setup` 只构造合成 fixture，可返回少量题目／题集 ID；不能读取用户数据库、配置或真实 AI 密钥。AI 协议测试另建本机假 provider；真实模型测试保留在专门且显式运行的脚本中。
- 浏览器使用独立 context，默认阻止外部请求并记录尝试，服务 worker 被禁用以防请求绕过拦截。确有需要时显式传入允许的本机 origin。
- 捕获页面错误，失败时保留截图、当前 URL、fixture stderr 和断言进度。输出只在 `test-results/<name>/`，不要把真实数据放进诊断报告。
- `finally` 必须调用 `close()`。helper 关闭自己创建的浏览器与 Node 子进程，等待退出，超时才强制终止；不按端口或进程名杀其他服务。Windows 使用隐藏进程，不经 shell 拼装命令。

Playwright 不加入应用依赖。可用 `PLAYWRIGHT_MODULE` 指向已安装的 `playwright/index.mjs`；浏览器选择沿用 `PLAYWRIGHT_CHANNEL`，Windows 默认 `msedge`，Linux 默认 Playwright Chromium。

```bash
# 已安装 Playwright 和浏览器时
node scripts/qa/check-form-save-bar-focus-ui.mjs
node scripts/qa/check-library-compact-ui.mjs
node scripts/qa/check-settings-save-bar-ui.mjs
```

## GitHub Actions

`.github/workflows/ci.yml` 在 push、pull request 或手动运行时执行 Web／移动类型检查、文档、单元测试，以及 Web／移动构建。测试先准备 native bundle，再分别运行独立测试进程。这个工作流不创建 Release、不签名 APK、不运行 Windows 桌面打包，也不需要发布密钥。

`.github/workflows/ui-smoke.yml` 是独立的手动浏览器冒烟流程。它临时安装固定版本 Playwright 和官方 Chromium，执行两个已迁移的页面脚本，并保留合成截图和失败诊断七天。临时工具位于 runner 的临时目录，不改项目依赖锁。

工作流参考 [GitHub checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node) 和 [Playwright CI 文档](https://playwright.dev/docs/ci-intro)。本机定向验证不等于 GitHub Linux 工作流已经执行成功；首次推送后需查看 Actions 实际结果。Android 真机、桌面便携包、签名和真实模型验收仍按发布检查单独执行。
