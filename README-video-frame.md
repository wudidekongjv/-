# 视频拆帧节点插件

这是一个可独立发布的 Infinite Canvas 第三方节点插件（与 `infinite-canvas-director-plugin` 同架构）。用户无需启动本地服务，只需在画布右上角「节点插件 → 第三方插件」中安装公开的 `dist/video-frame.js` 地址即可。

## 功能

- **拆单帧**：输入秒数或 `mm:ss` 时间点，精确定位并抽取一帧。
- **间隔拆多帧**：指定开始时间、结束时间、间隔秒数，批量拆分（单次最多 120 帧）。
- **内置预览**：节点内嵌视频播放器与逐帧预览画廊，点击缩略图可跳转回视频对应时间。
- **回传画布**：把拆出的帧自动回传为画布图片节点，并与本节点连线。
- **视频来源**：可导入本地视频文件，也可连接上游视频节点（自动识别）。

## 使用方式

发布本仓库后，使用固定版本的 CDN 地址安装：

```text
https://cdn.jsdelivr.net/gh/esncy/infinite-canvas-director-plugin@main/dist/video-frame.js
```

安装后，画布创建菜单中会出现「视频拆帧」节点。导入或连接视频后，选择「拆单帧」或「间隔拆帧」，点击拆帧即可预览；确认后点击「回传 N 帧到画布」。

## 构建

```bash
npm install
node --check src/video-frame.js   # 语法检查
node build-video-frame.mjs        # 产物 -> dist/video-frame.js
```

插件产物是 `dist/video-frame.js`，不依赖宿主源码、不打包第二份 React、无第三方运行时依赖（拆帧引擎为原生 `<video>` + `<canvas>`）。

## 技术说明

- **拆帧引擎**：`<video>` 定位到目标时间（`seeked` 事件）→ `drawImage` 到 `<canvas>` → `toDataURL` 输出帧图，支持 JPG / PNG / WebP 与质量调节。
- **回传机制**：复用宿主 `ctx.applyOps`，以 `add_node`（`nodeType: "image"`）+ `connect_nodes` 将每帧写为图片节点，与导演台插件的截图回传逻辑一致。
- **上游数据**：通过 `ctx.getUpstream()` 识别视频节点，视频文件以 `metadata.content`（dataURL / blob URL）传递。

保留原导演台项目的 AGPL-3.0 许可。远程插件代码会在画布页面内执行，请只安装自己信任的发布地址。
