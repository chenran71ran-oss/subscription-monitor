# 界面预览

以下来自开源前 Demo 界面的本地模拟数据；v01 保留同样的布局，版本记录文案已更新。不是生产可用率或真实额度证明。

## 桌面 / 手机

![桌面白天](assets/desktop-light.png)

![手机黑夜](assets/mobile-dark.png)

<img src="assets/mobile.png" width="390" alt="手机端订阅概览，模拟数据">

## 四种布局

<div align="center">
<table align="center">
<thead>
<tr><th align="center">详细</th><th align="center">紧凑</th></tr>
</thead>
<tbody>
<tr><td align="center"><img src="assets/layout-detail.png" alt="详细"></td><td align="center"><img src="assets/layout-compact.png" alt="紧凑"></td></tr>
</tbody>
</table>
</div>

<div align="center">
<table align="center">
<thead>
<tr><th align="center">磁贴</th><th align="center">表格</th></tr>
</thead>
<tbody>
<tr><td align="center"><img src="assets/layout-tiles.png" alt="磁贴"></td><td align="center"><img src="assets/layout-table.png" alt="表格"></td></tr>
</tbody>
</table>
</div>

布局切换只改变显示，不改变采集逻辑。截图可通过 `npm run test:ui` 重建到 `.artifacts/`，人工检查后再更新这里的发布图片。
