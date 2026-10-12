# 故障排查

先区分四件事：页面是否正常、资源是否取得、字段是否解析、节点是否可从 Cloudflare 连接。不要把它们都归结为 UI 改坏或解析器不全。

<div align="center">
<table align="center">
<thead>
<tr><th align="center">现象</th><th align="center">检查与处理</th></tr>
</thead>
<tbody>
<tr><td align="center">API 503 / 缺少 SUB_KV</td><td align="center">确认绑定名称与 namespace，绑定后重新部署</td></tr>
<tr><td align="center">API 401</td><td align="center">核对 ADMIN_TOKEN Secret 是否设置；不要拿 INGEST_TOKEN 登录面板</td></tr>
<tr><td align="center">页面正常但数据不更新</td><td align="center">检查 lastCheck / quotaUpdatedAt；浏览器轮询只读，配置 Cron 或立即检测</td></tr>
<tr><td align="center">有节点、没有流量</td><td align="center">检查响应头 / 正文元数据是否包含配额；看 quotaSource / quotaNote</td></tr>
<tr><td align="center">QX 显示用量，面板无剩余</td><td align="center">用量可能只提供 used / download；剩余还需要 total 或明确 remaining</td></tr>
<tr><td align="center">一次性套餐到期未知</td><td align="center">没有日期不等于错误；明确 expire=0 / 永久标签才显示无到期</td></tr>
<tr><td align="center">HTTP 403 / 返回网页</td><td align="center">检查验证页特征；换资源解析器不能把 HTML 变成订阅</td></tr>
<tr><td align="center">HTTP 429 / 503</td><td align="center">暂缓请求、降低频率；避免连续手动重试</td></tr>
<tr><td align="center">高端口拉取失败</td><td align="center">校验 HTTPS 端口与目标策略；支持非标准端口不等于上游必然接受</td></tr>
<tr><td align="center">YAML 导入没有节点</td><td align="center">确认含 proxies 列表、UTF-8、服务器和端口；只有 providers 不够</td></tr>
<tr><td align="center">两条 YAML 计数不同</td><td align="center">比较资源内容、截断、无 server 项、元数据项、200 节点保留上限</td></tr>
<tr><td align="center">客户端正常但 TCP 检测失败</td><td align="center">路由起点不同、平台限制、UDP、预算不足；查看 probeState</td></tr>
<tr><td align="center">显示旧额度</td><td align="center">对照 quotaUpdatedAt；系统有意保留最后有效快照</td></tr>
<tr><td align="center">手动校准后今日用量为空</td><td align="center">正常，手动快照不参与自动日用量</td></tr>
<tr><td align="center">删除 / 更新后短暂旧状态</td><td align="center">KV 最终一致，等后续读取；避免并发反复写入</td></tr>
<tr><td align="center">主题 / 排序换设备丢失</td><td align="center">偏好保存在浏览器 localStorage，没有账号同步</td></tr>
<tr><td align="center">更新后界面似乎旧版</td><td align="center">根目录 worker.js 是否重新构建并完整部署；检查 Worker 部署版本</td></tr>
</tbody>
</table>
</div>

## 如何提交可复现问题

提供：项目版本、部署方式、浏览器 / 系统、来源类型、格式、HTTP 状态、相关时间、期望与实际行为。

解析问题附最小脱敏正文和响应头。替换 server、password、UUID、token、Cookie、个人名称与 URL 查询参数。不能公开真实原订阅；截图也需要检查地址栏和弹窗。

可运行 `npm test` 验证已收录样例。离线通过不能证明特定服务商目前对 CF 可访问。若官方余额接口未验证，先不要把页面“套餐流量”盲目当 remaining。

## 常见误解

安装 QX 资源解析器不会获得浏览器登录态，也不会赋予 Worker 本地网络路径；直接运行上游脚本还依赖 QX 宿主 API。这里使用 Worker 环境的字段兼容适配，没有执行整份 QX 脚本。

无法打开开发者工具不说明 API 不存在，也不证明服务商一定禁止读取。当前项目没有官网抓取适配，不要求用户在聊天里分享密码或登录 Cookie。
