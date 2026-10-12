# 部署与升级

## 运行条件

- Cloudflare 账号，可创建 **模块 Worker** 与 Workers KV。
- `SUB_KV` KV binding、`ADMIN_TOKEN` Secret。
- 可选 Cron；可选 `INGEST_TOKEN`，仅旧版 Windows 接口需要。
- CLI 路径使用 Node.js 22+ 和仓库锁定的 Wrangler。网页编辑器路径无需本地 Node。

不需要数据库服务器、Docker、代理内核或前端托管。运行期页面与 API 由同一 Worker 提供。不要把该项目仅作为 Cloudflare Pages 静态 HTML 部署。

## 路径 A：Cloudflare 网页编辑器

1. 创建 Worker，进入代码编辑器，使用 ES 模块形式。
2. 打开根目录 `worker.js` 或同内容 `worker.txt`，完整复制；保留首部 `cloudflare:sockets` 导入和末尾 `export default`。
3. 保存并部署。
4. 创建 KV namespace，绑定名称必须是 `SUB_KV`，不是 namespace 显示名称。
5. 在 Worker 的变量 / Secrets 设置添加 `ADMIN_TOKEN`，选择加密 Secret。重新部署使绑定生效。
6. 打开 Worker 的 HTTPS URL，输入口令。首次没有订阅是正常状态。
7. 添加一条受信任订阅或导入示例文件，确认状态和更新时间。
8. 需要自动采集时添加 Cron Trigger，例如每 30 分钟 `*/30 * * * *`。

Cloudflare 控制台菜单名称可能变化，以当前官方页面为准。绑定后 `/api/status` 应不再报告“缺少 SUB_KV 绑定”；口令错误则返回 401。

## 路径 B：Wrangler

```bash
npm ci
cp wrangler.example.toml wrangler.toml
npx wrangler login
npx wrangler kv namespace create SUB_KV
```

将返回的 namespace ID 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "SUB_KV"
id = "YOUR_ACTUAL_NAMESPACE_ID"
```

保持自己的 Worker 名称，然后：

```bash
npm run check
npx wrangler deploy
npx wrangler secret put ADMIN_TOKEN
```

首次 deploy 先创建 Worker，随后设置 Secret；未设置口令时 API 拒绝访问。`secret put` 会创建并部署新版本，最后再检查页面。不要将口令写在命令参数、TOML 的 `[vars]` 或 Git 文件中。

Windows PowerShell 可用 `Copy-Item` 复制配置，其他 npm / npx 命令相同。

## Cron 与刷新

示例配置使用：

```toml
[triggers]
crons = ["*/30 * * * *"]
```

Cron 表达式使用 UTC；今日用量日界线使用 Asia/Shanghai，这是两个不同设置。Cron 配置生效可能有传播延迟。浏览器的 60 秒轮询只读取已有数据，不能替代 Cron。

根据订阅数量、上游请求限制与 Cloudflare 配额选择频率。流量识别补充请求有 30 分钟冷却，不因频繁点按钮无限重复。这里不承诺任何套餐永久免费或固定成本；检查账号实际计费与配额。

## 本地开发

复制 `.dev.vars.example` 为 `.dev.vars` 并设置仅供本地的随机口令，然后 `npm run dev`。本地 KV 与线上 namespace 不等同；不要把真实订阅作为公开测试 fixture。完整 TCP 能力需要在目标 Worker 环境验证。

`wrangler.toml`、`.dev.vars`、`.env`、状态导出与本地运行数据均被 `.gitignore` 排除。

## 自定义域名

在 Cloudflare 为 Worker 配置自己的域名 / 路由并保持 HTTPS。页面使用同源相对 API 地址，不需要开放跨域通配符。自定义域名不保证绕过订阅提供方对 Cloudflare 出站请求的限制。

## 升级和恢复

1. 保留当前 Worker 源码、版本标识与 KV 的受保护备份。
2. 阅读 CHANGELOG 和迁移说明，确认绑定与口令名称。
3. 更新代码，执行构建和检查；需要时先在独立测试 Worker / 独立 KV 验证。
4. 部署到原 Worker，保持 `SUB_KV` 指向原 namespace，保留 Secrets。
5. 检查页面、三种视图、单条检测、已有文件与推送订阅。

控制中心的版本记录不是 Cloudflare 的部署记录。项目没有在线代码覆盖、代码验证或自动拒绝覆盖 / 回退功能。需要恢复时使用 Cloudflare 的部署版本管理或重新部署已保存源码；不要依赖网页自身来救援网页故障。保留旧代码无需另建生产 Worker。

## 官方参考

- [KV 入门](https://developers.cloudflare.com/kv/get-started/)
- [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
