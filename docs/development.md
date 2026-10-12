# 开发与验证

## 安装

Node.js 22+。`npm ci` 使用锁文件安装开发依赖。Worker 自身不依赖 Node 服务，Wrangler 与 Playwright 仅用于部署 / 开发。

## 修改与构建

改后端：`src/worker.js`。改结构 / 配色 / 交互：`web/index.html`、`web/styles.css`、`web/app.js`。

```bash
npm run build
npm run check
```

构建脚本检查标记唯一性，逐字嵌入 CSS / JS，生成 worker.js 与 worker.txt，不读取 Secrets 或本地配置。build:check 检测成品是否过期；`.artifacts/page.html` 仅用于测试。

目录拆分时已与原 Demo v18 单文件及 HTML 逐字节比较；v01 随后仅统一版本与历史文案，保持已有核心功能、交互和 UI 布局。后续修改必须更新成品，不能只编辑生成文件。

## 验证层次

<div align="center">
<table align="center">
<thead>
<tr><th align="center">命令</th><th align="center">验证</th></tr>
</thead>
<tbody>
<tr><td align="center">npm test</td><td align="center">离线配额 / fetch 管道、鉴权、文件覆盖保护、API 行为</td></tr>
<tr><td align="center">npm run check</td><td align="center">确定性构建、JS 语法、离线测试、文档相对链接</td></tr>
<tr><td align="center">npm run test:ui</td><td align="center">8 个视口、4 布局、主题、折叠、导航、弹窗、横向溢出</td></tr>
<tr><td align="center">npx wrangler deploy --dry-run</td><td align="center">Wrangler 打包校验；不代表线上绑定或上游正常</td></tr>
</tbody>
</table>
</div>

浏览器测试前：

```bash
npx playwright install chromium
npm run test:ui
```

Linux 缺系统库时使用官方 `npx playwright install --with-deps chromium`。CI 同样安装 Chromium。自带浏览器可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定路径。

截图和测试结果写到 `.artifacts/`，使用虚构资源，不提交实际线上数据。UI 测试不包含真实网络、真实代理协议或自动安全审计。

## 改解析器

先提交最小脱敏 fixture，断言输入值到输出字段的含义，特别验证 unknown / zero、缺字段、溢出、日期、来源优先级、旧快照。不要通过固定机场名字或账号配额解决通用问题。

## 改 UI

保留移动端已确认布局。至少检查 320 / 360 / 375 / 390 / 430 / 768 / 1366 / 1920 宽度和四布局；关注顶栏遮挡、页脚被 dock 覆盖、国家标签换行、卡片结构一致、交互期间重渲染。

不添加重复操作入口；Liquid feedback 应留在按钮交互中，遵循 reduced motion。任何代码升级器、真实本地测速或自动通知属于新增功能，需要设计后单独实现，不通过文档“宣布上线”。

## CI

仓库 workflow 执行检查、UI 测试和 Worker dry-run。它不携带 Cloudflare 凭证，不自动部署生产、不读取真实订阅。CI 状态以 GitHub 实际运行结果为准。
