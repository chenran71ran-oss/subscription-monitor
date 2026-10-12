# 路线图

路线图是候选工作清单，不是已实现功能或时间承诺。

## 当前基线已完成

- 单 Worker + KV、链接 / 文件 / 推送三类输入。
- QX 兼容配额提取、未知值与旧快照处理。
- 今日快照用量，四布局与三主题。
- 节点 TCP 分类、地区与协议展示、异常摘要。
- 可维护目录、确定性成品、离线 / UI 检查、完整文档。

## 优先考虑

<div align="center">
<table align="center">
<thead>
<tr><th align="center">方向</th><th align="center">前置条件 / 验收</th></tr>
</thead>
<tbody>
<tr><td align="center">解析器 fixture 扩展</td><td align="center">真实问题先脱敏，用通用规则解决，避免机场名字特判</td></tr>
<tr><td align="center">完整 YAML 解析</td><td align="center">明确依赖、体积、许可证与复杂语法测试</td></tr>
<tr><td align="center">大订阅调度</td><td align="center">跨轮次公平性，预算耗尽不误标离线，成本可见</td></tr>
<tr><td align="center">数据并发保护</td><td align="center">评估 Durable Objects / 数据库，避免 KV 写覆盖</td></tr>
<tr><td align="center">诊断脱敏加强</td><td align="center">名称、错误片段、URL 查询值与导出报告安全检查</td></tr>
<tr><td align="center">只读访问模式</td><td align="center">明确 scope，避免共享完整管理口令</td></tr>
<tr><td align="center">英文 UI</td><td align="center">文案与数字 / 日期格式完整验证</td></tr>
</tbody>
</table>
</div>

## 需要独立设计

官网余额适配器必须验证 API 语义与安全凭证存储；不抓取未知含义的 DOM 数字。真实本地协议探测需要 agent / 客户端 API 与明确身份验证。通知、备份恢复和多用户能力同样需要单独的权限与数据设计。

暂不重新加入在线代码覆盖 / 验证 / 自动回退模块。生产部署仍由 Cloudflare 管理工具完成。
