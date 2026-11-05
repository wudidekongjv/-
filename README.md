# Infinite Canvas 视频拆帧节点插件

这是 [Infinite Canvas（无限画布）](https://github.com/tigerowo/infinite-canvas) 的一个第三方节点插件，用于从视频中拆分出单帧或多帧静态图片，并回传到画布作为图片节点。

## 功能

- **拆单帧**：输入秒数或 `mm:ss` 时间点，精确定位并抽取一帧。
- **间隔拆多帧**：指定开始时间、结束时间、间隔秒数，批量拆分（单次最多 120 帧）。
- **内置预览**：节点内嵌视频播放器与逐帧缩略图画廊，点击缩略图可跳转回视频对应时间。
- **回传画布**：一键把拆出的帧写为画布图片节点，并自动与本节点连线。
- **格式可调**：支持 JPG / PNG / WebP，可调节输出质量。
- **双视频来源**：可导入本地视频文件，也可连接上游视频节点自动识别。

## 安装方式

在画布右上角「节点插件 → 第三方插件」中粘贴以下地址安装：

```text
https://cdn.jsdelivr.net/gh/wudidekongjv/-@main/dist/video-frame.js
```

> 提示：jsDelivr 的 `@main` 有 CDN 缓存，发布新版本后可能延迟几分钟生效。如需立即获取某个具体版本，可把 `@main` 换成具体 commit，例如 `@bd56f92`。

安装后，画布创建菜单中会出现「🎞️ 视频拆帧」节点。导入或连接视频后，选择「拆单帧」或「间隔拆帧」，点击拆帧即可预览；确认后点击「回传 N 帧到画布」。

## 使用步骤

1. 在画布创建「视频拆帧」节点。
2. 点击「导入视频」选择本地视频文件，或把上游视频节点连到本节点。
3. 选择拆帧模式：
   - 拆单帧：填写目标时间点，点击「预览这一帧」。
   - 间隔拆帧：填写开始时间、结束时间、间隔秒数，点击「拆分多帧」。
4. 在预览画廊确认帧内容后，点击「回传 N 帧到画布」。

## 构建

```bash
npm install
node --check src/video-frame.js   # 语法检查
node build-video-frame.mjs        # 产物 -> dist/video-frame.js
```

插件产物是 `dist/video-frame.js`，不依赖宿主源码、不打包第二份 React、无第三方运行时依赖（拆帧引擎为原生 `<video>` + `<canvas>`）。

## 技术说明

- **拆帧引擎**：`<video>` 定位到目标时间（监听 `seeked` 事件）→ `drawImage` 到 `<canvas>` → `toDataURL` 输出帧图。
- **回传机制**：复用宿主 `ctx.applyOps`，以 `add_node`（`nodeType: "image"`）+ `connect_nodes` 将每帧写为图片节点。
- **视频源解析**：支持 `data:` / `blob:` / 远程 http(s) URL；对 `https://canvas-assets/...` 虚拟主机地址，会自动走宿主 `window.hushifuHost.materialDataUrl()` 通道获取可播放数据。

远程插件代码会在画布页面内执行，请只安装自己信任的发布地址。
