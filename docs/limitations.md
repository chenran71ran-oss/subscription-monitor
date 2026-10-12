# 当前能力边界

这是个人订阅监控面板，不是完整代理内核、订阅转换服务或企业级监控平台。

<div align="center">
<table align="center">
<thead>
<tr><th align="center">事项</th><th align="center">当前事实</th></tr>
</thead>
<tbody>
<tr><td align="center">服务商额度</td><td align="center">依赖响应里的有效字段，无法从节点数量或 TCP 连通性计算余额</td></tr>
<tr><td align="center">官网抓取</td><td align="center">未实现账号登录与配额 API 适配</td></tr>
<tr><td align="center">YAML</td><td align="center">轻量字段提取，不覆盖完整 YAML 标准</td></tr>
<tr><td align="center">代理可用性</td><td align="center">检测 TCP，不校验密码、TLS、Reality、代理协议握手与网页出口</td></tr>
<tr><td align="center">UDP / QUIC</td><td align="center">识别常见协议标签，但不提供 UDP 测速</td></tr>
<tr><td align="center">本地延迟</td><td align="center">未实现，本机到节点和 CF 到节点不可互换</td></tr>
<tr><td align="center">地区</td><td align="center">由名字推断，不做 IP 定位；旗帜是显示规则</td></tr>
<tr><td align="center">文件订阅</td><td align="center">静态内容，需要重新导入</td></tr>
<tr><td align="center">快照导出</td><td align="center">不能恢复订阅，可能仍带名称与诊断信息</td></tr>
<tr><td align="center">在线升级 / 回退</td><td align="center">已移除，网页仅记录版本</td></tr>
<tr><td align="center">并发数据</td><td align="center">KV 最终一致，不提供跨记录事务或锁</td></tr>
<tr><td align="center">权限体系</td><td align="center">单个管理口令；旧 ingest 可单独设口令，无用户 / 角色隔离</td></tr>
<tr><td align="center">安全</td><td align="center">有 URL 与响应限制，不宣称完整 SSRF 防护或安全审计完成</td></tr>
<tr><td align="center">通知</td><td align="center">没有 Telegram、邮件、Bark 等通知通道</td></tr>
<tr><td align="center">可观测性</td><td align="center">保存有限历史和当前快照，不是长期时序数据库</td></tr>
</tbody>
</table>
</div>

项目上限：30 个订阅；每条保留 200 个节点；文件 1 MB；拉取预览 256 KiB；推送请求约 1.5 MB（各路径计量方式略有差异，以实际接口检查为准）。响应截断时节点总数可能未知。

状态未知 / 未检测与失败严格区分。上游限制、HTTP 403 验证页、Cloudflare 出站限制不保证能靠换 UA 或导入资源解析器解决。

部署前检查自己的 Cloudflare 套餐、KV 读写额度与使用场景。项目不承诺无限规模、永久免费、实时一致或固定服务可用率。
