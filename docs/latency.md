# 节点检测与延迟

## 当前测量

Worker 用 `cloudflare:sockets` 对节点服务器 / 端口建连，记录 socket opened 前的耗时。连接随后关闭，不发送代理认证或应用层测试数据。

<div align="center">
<table align="center">
<thead>
<tr><th align="center">数值</th><th align="center">实际含义</th></tr>
</thead>
<tbody>
<tr><td align="center">订阅拉取耗时 <code>latencyMs</code></td><td align="center">当前采集路径请求订阅资源的耗时</td></tr>
<tr><td align="center">节点 <code>latencyMs</code></td><td align="center">Cloudflare 执行位置到节点端点的 TCP 建连耗时</td></tr>
<tr><td align="center">Windows ingestion <code>fetchMs</code></td><td align="center">外部采集程序报告的订阅请求耗时</td></tr>
</tbody>
</table>
</div>

以上均不是用户设备经过代理访问网站的延迟。Cloudflare 地理位置、网络路由、防火墙、域名解析与端口限制都会影响结果。

## 探测结果

<div align="center">
<table align="center">
<thead>
<tr><th align="center"><code>probeState</code></th><th align="center">解释</th></tr>
</thead>
<tbody>
<tr><td align="center"><code>reachable</code></td><td align="center">TCP 建连成功</td></tr>
<tr><td align="center"><code>timeout</code> / <code>refused</code> / <code>failed</code></td><td align="center">当前 Cloudflare 路径连接未成功，不能直接推断所有客户端不可用</td></tr>
<tr><td align="center"><code>unsupported</code></td><td align="center">UDP / QUIC 类协议不适用此 TCP 测量</td></tr>
<tr><td align="center"><code>restricted</code></td><td align="center">平台限制目标连接</td></tr>
<tr><td align="center"><code>dns</code> / <code>invalid</code></td><td align="center">Worker 解析失败或缺少可用地址 / 端口</td></tr>
<tr><td align="center"><code>resource_limit</code> / <code>budget</code></td><td align="center">平台或项目预算不足，未作真实离线结论</td></tr>
<tr><td align="center"><code>metadata</code></td><td align="center">说明 / 流量条目，不是需要探测的节点</td></tr>
</tbody>
</table>
</div>

## 限额与调度

最多解析 / 保留每条 200 个节点，最多选择每条 60 个符合条件的节点进入探测；这不是保证每次完成 60 个。并发 4，单次超时 5.5 秒，记录探测时间预算 35 秒。timeout / failed 在预算允许时最多重试一次。

批量检查先抓取订阅，再探测节点，共享 40 次网络操作预算；订阅拉取并发 2，优先检查较久未刷新的记录。数量较多时会出现等待后续轮次的记录。这是主动保护，不是丢失节点。

## 如何测本地路径

使用你本地的代理客户端 / 内核进行延迟测试，是与日常访问路径更一致的办法。未来可以考虑一个明确授权、带独立鉴权的本地代理测试 agent，并把结果单独标为“本地协议测试”。当前没有实现该 agent，也不把 Cloudflare TCP 结果伪装成本地结果。

参考 [Cloudflare TCP sockets 文档](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)。
