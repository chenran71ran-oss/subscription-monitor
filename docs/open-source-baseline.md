# 开源组织参考

调研日期：2026-10-11。Stars 为调研时 GitHub 页面近似显示，不是永久排名或本项目承诺。

<div align="center">
<table align="center">
<thead>
<tr><th align="center">参考项目</th><th align="center">规模参考</th><th align="center">本项目借鉴</th><th align="center">区别</th></tr>
</thead>
<tbody>
<tr><td align="center"><a href="https://github.com/louislam/uptime-kuma">Uptime Kuma</a></td><td align="center">约 92.3k stars</td><td align="center">定位清晰、截图、快速开始、贡献与安全入口</td><td align="center">通用服务监控，不替本项目实现订阅解析</td></tr>
<tr><td align="center"><a href="https://github.com/komari-monitor/komari">Komari</a></td><td align="center">约 6.4k stars</td><td align="center">中英文说明、部署入口、集中展示</td><td align="center">服务器监控，有不同数据采集架构</td></tr>
<tr><td align="center"><a href="https://github.com/sub-store-org/Sub-Store">Sub-Store</a></td><td align="center">约 10.7k stars</td><td align="center">输入兼容文档、边界声明、独立 API 文档</td><td align="center">订阅管理 / 转换，本项目侧重额度与状态观察</td></tr>
<tr><td align="center"><a href="https://github.com/KOP-XIAO/QuantumultX">KOP-XIAO/QuantumultX</a></td><td align="center">不以星数评价</td><td align="center">资源与流量字段兼容研究</td><td align="center">QX 宿主脚本，不在 Worker 直接运行</td></tr>
</tbody>
</table>
</div>

借鉴的是文档组织、信息清晰度与兼容性表达，不复制仓库营销文案，也不把参考项目功能当作本项目能力。未收录它们的源代码或完整解析器。

## 本仓库交付清单

- 中英文 README、部署、使用、API、架构、故障排查、迁移与开发文档。
- 源码和可直接粘贴的单文件成品。
- 可重现的模拟截图与安全样例。
- LICENSE、NOTICE、SECURITY、CONTRIBUTING、行为规范。
- Issues / PR 模板、CI、Dependabot 与版本记录。

## 发布前检查

使用新仓库，不覆盖无关仓库；公开前检查订阅 token、管理口令、Cookie、私密 URL、KV 备份与实际账号截图。测试和示例使用保留域名。确认文档没有承诺官网自动抓取、本地内核延迟或自动回退。

公开仓库不携带 Cloudflare 部署凭证，CI 不自动发布生产。后续发布可使用 GitHub 的标签与 Release；首次开源版本命名 v01，建议标签 v0.1.0；源码来自 Demo v18，不将 Demo 编号当作开源发布历史，也不冒充已发布的 GitHub Release。
