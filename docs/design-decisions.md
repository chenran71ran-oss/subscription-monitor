# 设计决策与需求演进

这份文档把项目开发上下文整理为可维护的决策，不包含私人账号、订阅 token 或完整聊天原文。

## 产品目标

在同一个网页里查看订阅额度、到期、节点与采集状态。用户先看订阅，再看辅助分析；国家区域、概览与控制入口不能占据大部分手机首屏。

## 当前保留的设计

<div align="center">
<table align="center">
<thead>
<tr><th align="center">决策</th><th align="center">原因与结果</th></tr>
</thead>
<tbody>
<tr><td align="center">网站名称：订阅监控面板</td><td align="center">名称稳定，不在主标题展示版本号</td></tr>
<tr><td align="center">三个独立视图</td><td align="center">订阅、节点、控制各有职责，减少重复四框</td></tr>
<tr><td align="center">四种全局显示布局</td><td align="center">用统一模板控制信息密度，不按某条已添加订阅逐个“打补丁”</td></tr>
<tr><td align="center">明 / 系统 / 暗同行工具</td><td align="center">右上角图标表达，支持同一行折叠</td></tr>
<tr><td align="center">底部三功能导航</td><td align="center">手机触达方便，预留安全区与内容底边</td></tr>
<tr><td align="center">液态效果嵌入交互</td><td align="center">没有常驻鼠标大光斑，也没有多余开关</td></tr>
<tr><td align="center">桌面与手机分开调密度</td><td align="center">手机保持已验收排版，桌面可以显示更多信息</td></tr>
<tr><td align="center">统一卡片结构</td><td align="center">内容缺失不能导致框体高度、到期行或节点数显示错乱</td></tr>
<tr><td align="center">今日用量</td><td align="center">自然日快照统计；本周用量已删除</td></tr>
<tr><td align="center">地区 + 协议分析</td><td align="center">地球绕纵轴，地区使用图形国旗与中英文；只标名称推断</td></tr>
<tr><td align="center">文件可重导入</td><td align="center">远程受限时增加静态输入，失败先拒绝覆盖旧记录</td></tr>
<tr><td align="center">控制中心只留版本记录</td><td align="center">已删除在线代码验证 / 覆盖更新，避免重复入口与危险自救依赖</td></tr>
</tbody>
</table>
</div>

## 订阅兼容的原则

早期问题不能仅靠 UI 或资源解析器解决。需要先识别远程请求是否拿到真正资源，再判断节点字段和配额字段。高端口、防护页、UA 差异和 CF 平台连接范围属于不同层次。

Demo v18 引入 QX 行为兼容的流量提取：缺 upload 的合法头、bytes_remaining、STATUS 和流量备注；没有移植完整脚本宿主或内核。旧数据保留并标记时间，空值不假装为零。

## 未完成的原始想法

- 官网自动读取剩余流量：需要确认真正账号 API、字段语义和安全凭证模型；当前没有实现。
- 本地协议延迟：需要本地客户端 / agent，Worker TCP 不能替代。
- 在覆盖源码前检测失效并拒绝更新：原意不要求另部署 Worker，但后来用户要求删除在线代码更新模块；当前只留历史说明。

## 开源整理原则

首次开源版命名 v01（0.1.0），此前 Demo v18 仅为 Demo 功能基线；统一版本文案，文档组织与源码目录改进保留已确认 UI 布局。保留可复制的完整 JS / TXT；增加可维护源码、测试、清晰边界、脱敏示例和社区协作入口。不会把仅讨论过的功能写成已经实现。
