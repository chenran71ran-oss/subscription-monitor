# API 参考

所有 API 均与页面同源，JSON 响应 `cache-control: no-store`。除旧版 `/api/ingest` 外使用：

```http
Authorization: Bearer YOUR_ADMIN_TOKEN
Content-Type: application/json
```

`ADMIN_TOKEN` 是拥有添加、删除、检测与导出数据权限的管理口令，不是只读 token。API 未提供第三方浏览器跨域访问配置；服务器端调用不受浏览器 CORS 限制。

## 接口目录

<div align="center">
<table align="center">
<thead>
<tr><th align="center">方法与路径</th><th align="center">用途</th><th align="center">请求 / 返回</th></tr>
</thead>
<tbody>
<tr><td align="center">GET <code>/api/status</code></td><td align="center">读取所有快照</td><td align="center"><code>{subs:[...]}</code></td></tr>
<tr><td align="center">POST <code>/api/check</code></td><td align="center">检查所有订阅</td><td align="center"><code>{subs:[...]}</code></td></tr>
<tr><td align="center">POST <code>/api/check?id=ID</code></td><td align="center">检查单条订阅</td><td align="center"><code>{sub:...}</code></td></tr>
<tr><td align="center">POST <code>/api/subs</code></td><td align="center">新建拉取或推送订阅</td><td align="center"><code>{name,url}</code> / <code>{name,mode:&quot;push&quot;}</code> → <code>{sub:...}</code></td></tr>
<tr><td align="center">DELETE <code>/api/subs?id=ID</code></td><td align="center">删除列表与记录</td><td align="center"><code>{ok:true}</code></td></tr>
<tr><td align="center">POST <code>/api/import</code></td><td align="center">创建文件订阅</td><td align="center"><code>{name,content,userinfo?}</code></td></tr>
<tr><td align="center">POST <code>/api/import?id=ID</code></td><td align="center">重新导入已有文件订阅</td><td align="center">同上，只允许 file 来源</td></tr>
<tr><td align="center">POST <code>/api/quota?id=ID</code></td><td align="center">手动流量快照</td><td align="center"><code>{total,remaining,noExpiry}</code></td></tr>
<tr><td align="center">POST <code>/api/push?id=ID</code></td><td align="center">推送订阅内容</td><td align="center"><code>{body,contentType?,userinfo?}</code></td></tr>
<tr><td align="center">POST <code>/api/ingest</code></td><td align="center">旧版 Windows 采集兼容</td><td align="center">使用独立 <code>INGEST_TOKEN</code>，见下文</td></tr>
</tbody>
</table>
</div>

路径匹配不统一自动提供 OPTIONS。未知路径或不匹配的方法多数返回 404；import / quota 非 POST 返回 405。

## 新建订阅

```json
{"name":"Demo subscription","url":"https://example.com/subscription?token=YOUR_PROVIDER_TOKEN"}
```

名称非空、最多 80 字符，链接最大 2048 字符，HTTPS 域名且不包含用户名 / 密码。重复链接 409，最大 30 条。URL 的 fragment 会剥离。拉取来源添加时立即检查；上游失败也会保留新建记录并返回相应状态。

```json
{"name":"Local collector","mode":"push"}
```

推送来源不会保存订阅 URL，返回的八位 ID 用于后续写入。不建议手动假设 ID。

## 文件导入

`content` 为文件文本，不是 multipart / 文件路径 / Base64 上传包。UTF-8 内容最大 1,000,000 bytes。外层 JSON 请求也有大小限制。解析到至少一个有效 host 和 1–65535 端口才能接受。

```json
{"name":"Demo YAML","content":"proxies:\n  - name: US demo\n    type: trojan\n    server: example.invalid\n    port: 443\n"}
```

返回 `{sub,format,nodes,hasUsage}`。无有效节点返回 422；覆盖 ID 非 file 来源返回 404；失败不替换旧文件数据。传入合法的 `userinfo` 可携带对应资源的配额头，不能把猜测数值伪装成官方数据。

## 手动配额

```json
{"total":10737418240,"remaining":8589934592,"noExpiry":true}
```

total / remaining 使用 **bytes 的安全整数**；total > 0，0 ≤ remaining ≤ total，noExpiry 必须是 boolean。`noExpiry:false` 不新增日期，保留已有到期值。返回 `{ok:true,sub}`。记录标记 `quotaSource:"manual"`，不自动扣减、不计今日用量。

## 现代推送

```json
{"body":"完整节点订阅文本","contentType":"text/plain","userinfo":"upload=0;download=1073741824;total=10737418240"}
```

只能写入被识别为 push 模式的订阅。注意大小写：这里是 `body` 和 `userinfo`，不是 legacy 的 `content` 和 `userInfo`。

返回 `{ok:true,format,nodes,hasUsage}`。HTML / 无有效资源会返回 422 并保存错误诊断；保留旧快照不等于本次成功。若写入的是 file 模式，建议走重新导入路径而不是通用 push。

## 旧版 Windows ingest

使用 `Authorization: Bearer YOUR_INGEST_TOKEN`，不是 ADMIN_TOKEN。

```json
{"id":"0123abcd","status":200,"content":"订阅文本","contentType":"text/plain","userInfo":"upload=0;download=0;total=10737418240","fetchMs":300,"truncated":false}
```

ID 为列表中真实存在的八位十六进制值；status 为 0–599 整数。content 最大 256 KiB。file 来源不允许 legacy ingest，返回 409。失败可携带 `error`，成功条件还要求内容 / 元数据有效。返回 `{ok,state,httpStatus}`，HTTP 200 本身不保证 `ok:true`。

## 状态字段

<div align="center">
<table align="center">
<thead>
<tr><th align="center">字段</th><th align="center">含义</th></tr>
</thead>
<tbody>
<tr><td align="center">id / name / mode / source</td><td align="center">标识、名称、pull 或 push、可选 file 来源</td></tr>
<tr><td align="center">state / online</td><td align="center">订阅抓取与配额综合状态；不是所有节点的协议验证</td></tr>
<tr><td align="center">upload / download / used / total / remaining</td><td align="center">bytes；未知为 null</td></tr>
<tr><td align="center">percent</td><td align="center">已用 / 总量 × 100；未知为 null</td></tr>
<tr><td align="center">expire / noExpiry</td><td align="center">Unix 毫秒到期值 / 明确无到期标记</td></tr>
<tr><td align="center">quotaSource / quotaUpdatedAt</td><td align="center">配额来源与最后有效更新时间</td></tr>
<tr><td align="center">lastCheck / lastOnline / resourceUpdatedAt</td><td align="center">检查时间、最后在线、资源更新时间</td></tr>
<tr><td align="center">usageToday</td><td align="center"><code>{bytes,since,until,partial,reset}</code> 或 null</td></tr>
<tr><td align="center">delta24h</td><td align="center">历史采样支持时的 24 小时差值或 null；UI 不展示本周用量</td></tr>
<tr><td align="center">resourceFormat / nodeCount / nodesMore</td><td align="center">识别格式、可知总数、未保留数量</td></tr>
<tr><td align="center">nodes</td><td align="center">公开节点名、协议、传输、TLS 标签和探测结果，无 host / port / 密码字段</td></tr>
<tr><td align="center">httpStatus / attempts / triedUA</td><td align="center">拉取 HTTP 状态、客户端兼容尝试</td></tr>
<tr><td align="center">error / errorCode / errorSnippet</td><td align="center">有限诊断，公开前仍须检查敏感信息</td></tr>
<tr><td align="center">checkDeferred / checkNote</td><td align="center">批量资源预算不足时的本次延后提示，可能仅出现在 check 返回</td></tr>
</tbody>
</table>
</div>

`state` 值包括 pending、unreachable、no_quota_header、expired、exhausted、warning、manual_quota、active。warning 条件包括已用 ≥90% 或到期不足 3 天；配额颜色阈值不等同于该状态阈值。

## 常见错误

<div align="center">
<table align="center">
<thead>
<tr><th align="center">HTTP</th><th align="center">常见含义</th></tr>
</thead>
<tbody>
<tr><td align="center">400</td><td align="center">无效 JSON、字段、名称、链接或配额</td></tr>
<tr><td align="center">401</td><td align="center">缺少 / 不匹配口令</td></tr>
<tr><td align="center">404</td><td align="center">未找到订阅、来源不符合接口要求或未知接口</td></tr>
<tr><td align="center">405</td><td align="center">import / quota 方法错误</td></tr>
<tr><td align="center">409</td><td align="center">重复链接或 legacy ingest 不允许写 file 来源</td></tr>
<tr><td align="center">413</td><td align="center">请求 / 内容超过限制</td></tr>
<tr><td align="center">422</td><td align="center">非有效资源、缺少可用文件节点、验证页</td></tr>
<tr><td align="center">503</td><td align="center">缺少 KV 或 legacy ingest Secret</td></tr>
</tbody>
</table>
</div>

抓取上游 403 / 429 不一定转换为 API 同号 HTTP 状态；查看记录中的 httpStatus 和 error。

## 调用示例

下面变量由自己的终端安全配置，勿将真实 token 写进 Issues：

```bash
curl --fail-with-body "$MONITOR_URL/api/status" \
  -H "Authorization: Bearer $MONITOR_ADMIN_TOKEN"
```

不要把返回完整状态直接贴到公开讨论。项目提供单一管理权限，自动采集程序应部署在受信任设备。
