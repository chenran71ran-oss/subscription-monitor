# 资源解析与流量识别

## 两条独立链路

资源解析提取节点名、协议、服务器与端口；配额解析提取流量和到期字段。前者成功不能证明后者存在。响应内容看起来像 HTML 验证页时，不当作节点订阅。

## 输入兼容表

<div align="center">
<table align="center">
<thead>
<tr><th align="center">格式</th><th align="center">当前行为</th><th align="center">限制</th></tr>
</thead>
<tbody>
<tr><td align="center">URI 列表</td><td align="center">VMess、VLESS、Trojan、SS、SSR、Hysteria / Hysteria2 / HY2、TUIC</td><td align="center">提取监控字段，不连接完整代理协议</td></tr>
<tr><td align="center">Base64</td><td align="center">普通 / URL-safe / 无补位的常见节点链接，部分 YAML / JSON</td><td align="center">需要足够完整内容；截断时不盲目解码</td></tr>
<tr><td align="center">Clash JSON</td><td align="center">读取 <code>proxies</code> 数组</td><td align="center">不加载外部 providers</td></tr>
<tr><td align="center">Clash YAML</td><td align="center">常见 <code>proxies:</code> 列表、块状和单行节点</td><td align="center">轻量字段提取，不是完整 YAML 解析器</td></tr>
<tr><td align="center">sing-box JSON</td><td align="center">含 server 的 <code>outbounds</code></td><td align="center">不计入无 server 的 direct / selector 等对象</td></tr>
<tr><td align="center">文本配置</td><td align="center"><code>[Proxy]</code> 下 <code>名称 = 类型, 地址, 端口, ...</code></td><td align="center">非完整 QX / Surge / Loon 配置语法</td></tr>
<tr><td align="center">QX 流量文本 / JSON</td><td align="center">可识别配额对象和部分备注</td><td align="center">配额可解析不等于该格式节点能解析</td></tr>
<tr><td align="center">只有 providers 的 YAML</td><td align="center">不递归下载节点</td><td align="center">文件导入拒绝缺少可用节点的内容</td></tr>
</tbody>
</table>
</div>

不执行订阅里的脚本、QX 环境变量或远程资源解析器。Yaml anchors、复杂 quoting / 嵌套、厂商扩展均不保证兼容。需要格式扩展时提交脱敏最小样例，而不是声称兼容整个客户端内核。

## 流量数据来源

1. `subscription-userinfo` 及兼容响应头。
2. 正文注释里的同类字段、JSON 元数据。
3. QX 风格 `bytes_used`、`bytes_remaining`、`expire_date`。
4. Shadowrocket `STATUS` 中上传、下载、总量和日期。
5. 节点备注或文本中的可识别流量 / 到期标签。

响应头的有效字段优先；正文用于补足，不以模糊备注覆盖有效响应头。为避免抓取风暴，缺少用量字段时只允许有冷却的有限补充请求。

```text
subscription-userinfo: upload=1073741824; download=2147483648; total=10737418240; expire=0
```

这个样例表示总量 10 GiB、已用 3 GiB、剩余 7 GiB。项目界面使用 GB / TB 标签，但按 1024 换算。`expire=0` 明确表示没有到期时间。

```json
{"info":{"bytes_used":2147483648,"bytes_remaining":8589934592,"expire_date":0}}
```

```text
STATUS=↑:0GB,↓:1GB,TOT:10GB💡Expires:2026-12-31
```

```text
剩余流量：128 GB
```

只提供剩余的最后一例不会推测总量和已用。无到期字段保持未知，而不是伪造永久或 2099 年日期。无 upload 但合法 download 的响应头按 QX 兼容逻辑把 upload 视为零；显式非法 upload 不静默修复。

## 旧快照与今日用量

抓取失败或没有新配额时保留旧值与 `quotaUpdatedAt`。同时通过状态和检测时间表明数据未更新。切换配额来源可能清空旧历史，避免混合不同计数基线。

历史保留约八天，今日按 UTC+8 自然日边界计算。如果没有日界线前 90 分钟内的基线，会标记 partial；计数下降按重置处理并保留 reset 信息，不假装数据完整。

## 一次性流量与官网

永久 / 一次性套餐不是格式障碍。只要上游给出总额、已用或剩余，就能按字段组合显示。QX 客户端显示某个用量数字并不能证明订阅响应里同时包含总额和剩余。

服务商官网“套餐流量”也不能未经接口含义验证直接映射为“剩余流量”。当前没有登录官网抓取适配器；没有自动保存账号密码、Cookie 或网页 token。可先用服务商明确提供的订阅额度，或手动校准 / 从受信任设备推送。

仓库 [样例](../examples/README.md) 全部使用虚构服务器与凭证，不能直接作为可用代理。
