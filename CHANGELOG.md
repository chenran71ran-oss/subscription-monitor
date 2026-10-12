# 变更记录

## v01 · 0.1.0 · 首次开源发布 — 2026-10-12

这是基于 Demo v18 的首次开源整理。此前版本仅属于 Demo 开发阶段；同步版本与历史文案，保留已确认的 Worker 行为和前端布局。

- 拆分 src 后端和 web HTML / CSS / JS，确定性生成完整 worker.js / worker.txt。
- 添加 Wrangler 示例、锁文件、构建检查、离线与响应式交互测试。
- 补齐中英文 README、部署、解析、API、架构、使用、迁移、安全与社区文档。
- 用虚构数据生成预览，移除私人订阅、账号截图与研究下载脚本。

## Demo v18 · 开源前流量兼容基线

- Worker 环境下兼容 QX 配额字段、缺 upload 的合法响应头、bytes_remaining 与 STATUS。
- 兼容 Base64 元数据、流量备注与旧快照保留。
- 有限配额补充请求和冷却，保持 Demo v17 前端。

## Demo 阶段主要演进

以下根据程序内记录与已确认需求归纳，不能作为每个历史构建都可下载的发布列表。

<div align="center">
<table align="center">
<thead>
<tr><th align="center">阶段</th><th align="center">变化</th></tr>
</thead>
<tbody>
<tr><td align="center">Demo v17</td><td align="center">桌面 UI 优化，移动端保持验收效果</td></tr>
<tr><td align="center">Demo v12–v16</td><td align="center">手机安全区、底部导航、国家对齐、主题 / 布局同行折叠、首屏比例</td></tr>
<tr><td align="center">Demo v07–v11</td><td align="center">流量扩展、手动快照、TCP 探测、诊断与请求预算，减少重复抓取</td></tr>
<tr><td align="center">Demo v03–v06</td><td align="center">三视图、四布局、主题图标、液态交互与配色</td></tr>
<tr><td align="center">Demo v01–v02</td><td align="center">今日用量；移除本周用量</td></tr>
<tr><td align="center">较早构建</td><td align="center">文件导入、统一卡片与拖动、点阵地球、控制中心整理</td></tr>
</tbody>
</table>
</div>

早期“构建 18”与后来重新命名后的“Demo v18”是不同阶段。本仓库以 Demo v18 为源码来源，首次开源发布从 v01（0.1.0）开始，主标题不显示版本号。在线代码验证和更新模块已删除，不在当前功能中。
