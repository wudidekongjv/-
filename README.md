# Infinite Canvas 3D 导演台节点插件

这是一个可独立发布的 Infinite Canvas 第三方节点插件。用户不需要启动本地 3001 服务，只需在画布右上角「节点插件 → 第三方插件」中安装公开的 `dist/director.js` 地址即可。

## 使用方式

发布本仓库后，推荐使用固定版本的 CDN 地址安装：

```text
https://cdn.jsdelivr.net/gh/esncy/infinite-canvas-director-plugin@main/dist/director.js
```

如需锁定稳定版本，可将 `@main` 换成已发布的版本标签，例如 `@v0.1.1`。

安装后，画布创建菜单中会出现「3D 导演台」节点。把图片节点连到它，点击「打开导演台」即可使用；导演台截图会自动回传为画布图片节点。

## 构建

```bash
npm install
npm run typecheck
npm run build
```

插件产物是 `dist/director.js`，不依赖宿主源码、不打包第二份 React，也不要求用户安装任何本地服务。发布到 GitHub 时请把 `dist/director.js` 一并提交，jsDelivr 才能直接提供安装地址。

导演台静态资源默认从 `tigerowo/infinite-canvas` 的公开 GitHub 内容通过 jsDelivr 加载。插件把页面放入 `srcdoc` iframe，并把通信目标显式指向当前画布域名，因此可以在任意画布域名中使用现有的 `storyai:director-*` 通信协议，也不会要求用户运行 `localhost:3001`。

## 独立更新

- 无限画布宿主可以独立升级，不需要重新发布本插件。
- 本插件可以独立发版；用户在插件管理器点击「从来源更新」即可重新拉取同一个 URL。
- 导演台资源默认跟随 `tigerowo/infinite-canvas@main`，所以导演台仓库的更新可以独立生效；生产环境也可以在 `src/index.js` 中固定到某个 tag，避免上游变更影响已发布插件。
- 如果插件仓库使用固定版本 URL（例如 `@v0.1.1`），发布新插件版本时把 URL 改为新 tag；如果使用 `@main`，提交到主分支后用户更新同一个 URL 即可获得最新构建。

发布时请保留导演台原项目的 AGPL-3.0 许可和 3D 模型许可说明。远程插件代码会在画布页面内执行，请只安装自己信任的发布地址。
