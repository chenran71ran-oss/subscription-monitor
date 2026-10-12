# 外部推送接入

## 什么情况下使用

当本地设备能取得订阅，而 Worker 无法取得时，可由受信任设备获取资源并携带真实响应头推送。这只是改变采集位置，不保证解决验证挑战或服务商限制。不要绕过验证 / 登录保护。

节点 TCP 测试仍由 Worker 发起。推送来自本地并不会把节点延迟变成本地协议延迟。

## 现代接口流程

1. 在面板添加“推送”来源，得到订阅 ID。
2. 本地采集程序向自己的服务商请求资源。
3. 读取正文、Content-Type 和 subscription-userinfo。
4. 向 `/api/push?id=ID` 发送 JSON，使用 ADMIN_TOKEN。
5. 检查返回 ok / hasUsage 和面板时间，不能只看 HTTP 成功。

仓库提供 [安全的文件推送示例](../examples/push-file.mjs)。它只读取已有的本地文件，不自动请求服务商，不打印凭证；配额头可以通过受保护环境变量传入。

```bash
node examples/push-file.mjs /absolute/path/subscription.yaml
```

需自行设置 `MONITOR_URL`、`MONITOR_ADMIN_TOKEN`、`MONITOR_SUB_ID`，可选 `MONITOR_USERINFO`。示例不会把文件内容或 token 写进 Git。执行前确认目标是自己的面板。

这个工具并非周期任务；需要更新频率时使用自己的系统调度器，避免请求上游过密。不要提交本地文件、环境变量或调度器输出。

## 旧 Windows 兼容

原接口 `/api/ingest` 使用独立 INGEST_TOKEN，字段见 [API](api.md)。可以兼容之前的推送调用，但新接入优先使用现代接口。legacy 的 userInfo 字段大小写不能换成 userinfo。

不要为了简化接入取消鉴权，也不要把管理口令放在网页 URL。状态 JSON 不能替代原资源文件进行恢复。
