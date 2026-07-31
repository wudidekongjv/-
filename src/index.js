// 独立插件不依赖宿主源码或 React 包,只使用 Infinite Canvas 公开的工厂运行时契约。
// 导演台静态资源来自公开 GitHub 仓库;发布插件时可将此地址固定到某个 tag。
const DIRECTOR_ASSET_BASE = "https://cdn.jsdelivr.net/gh/tigerowo/infinite-canvas@main/web/public/director";
const DIRECTOR_PROTOCOL = "storyai:director";

function cacheBusted(url) {
    return `${url}${url.includes("?") ? "&" : "?"}plugin_t=${Date.now()}`;
}

async function fetchText(url) {
    const response = await fetch(cacheBusted(url), { cache: "no-store" });
    if (!response.ok) throw new Error(`导演台资源下载失败 (${response.status})`);
    return response.text();
}

function resolveDirectorAsset(path) {
    if (path.startsWith("/director/")) return `${DIRECTOR_ASSET_BASE}/${path.slice("/director/".length)}`;
    if (path.startsWith("/")) return `${DIRECTOR_ASSET_BASE}/${path.slice(1)}`;
    return new URL(path, `${DIRECTOR_ASSET_BASE}/`).toString();
}

function rewriteDirectorScript(source, hostOrigin) {
    // 导演台构建产物默认从 /director/ 读取模型;改成公开 CDN 地址后可在任意画布域名运行。
    return source
        .replace(/(["'])\/director\/\1/g, (_match, quote) => `${quote}${DIRECTOR_ASSET_BASE}/${quote}`)
        // srcdoc documents have a null location origin; point the existing
        // director protocol at the embedding canvas origin instead.
        .replace(/window\.location\.origin/g, JSON.stringify(hostOrigin));
}

async function prepareDirectorFrame(hostOrigin) {
    const html = await fetchText(`${DIRECTOR_ASSET_BASE}/index.html`);
    const scriptMatch = html.match(/<script[^>]+src=["']([^"']+)["'][^>]*>/i);
    const styleMatch = html.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
    if (!scriptMatch) throw new Error("导演台页面缺少脚本入口");

    const scriptSource = rewriteDirectorScript(await fetchText(resolveDirectorAsset(scriptMatch[1])), hostOrigin);
    const styleUrl = styleMatch ? resolveDirectorAsset(styleMatch[1]) : null;
    // srcdoc keeps the frame embedded with the host and avoids browser policies
    // that block blob: iframe navigation in embedded canvas environments.
    // Prevent an HTML parser from terminating the inline module on a literal
    // `</script>` sequence that may appear inside the bundled source.
    const safeScriptSource = scriptSource.replace(/<\/script/gi, "<" + String.fromCharCode(92) + "/script");
    const inlineScript = `<script type="module">${safeScriptSource}</script>`;
    const frameHtml = html
        .replace(scriptMatch[0], () => inlineScript)
        .replace(styleMatch?.[1] || "", () => styleUrl || "");

    return {
        html: frameHtml,
        dispose: () => {},
    };
}

function randomId(prefix) {
    if (typeof crypto?.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function themeMode(ctx) {
    const background = String(ctx.theme?.canvas?.background || "").replace("#", "");
    if (background.length !== 6) return "dark";
    const red = Number.parseInt(background.slice(0, 2), 16);
    const green = Number.parseInt(background.slice(2, 4), 16);
    const blue = Number.parseInt(background.slice(4, 6), 16);
    return (red * 299 + green * 587 + blue * 114) / 1000 > 150 ? "light" : "dark";
}

function buildPanoramas(ctx) {
    const upstream = ctx.getUpstream();
    const connections = ctx.getConnections();
    return upstream
        .filter((node) => node?.type === "image" && typeof node.metadata?.content === "string" && node.metadata.content)
        .map((node) => {
            const connection = connections.find((item) => item.fromNodeId === node.id && item.toNodeId === ctx.node.id);
            return {
                edgeId: connection?.id || `${node.id}->${ctx.node.id}`,
                sourceNodeId: node.id,
                imageUrl: node.metadata.content,
                fileName: node.title || "画布图片.png",
                projectionMode: node.metadata.panoramaProjection === "equirectangular" ? "equirectangular" : "backdrop",
            };
        });
}

function imageSize(dataUrl) {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth || 1024, height: image.naturalHeight || 576 });
        image.onerror = () => resolve({ width: 1024, height: 576 });
        image.src = dataUrl;
    });
}

function fitImageSize(width, height) {
    const maxWidth = 720;
    const maxHeight = 540;
    const scale = Math.min(1, maxWidth / Math.max(width, 1), maxHeight / Math.max(height, 1));
    return { width: Math.max(220, Math.round(width * scale)), height: Math.max(160, Math.round(height * scale)) };
}

async function sendCaptures(ctx, captures) {
    if (!captures.length) return;
    const director = ctx.node;
    const nodes = ctx.getNodes();
    const connections = ctx.getConnections();
    let y = director.position.y;
    for (const connection of connections) {
        if (connection.fromNodeId !== director.id) continue;
        const output = nodes.find((node) => node.id === connection.toNodeId);
        if (output?.type === "image") y = Math.max(y, output.position.y + output.height + 36);
    }

    const ops = [];
    for (const [index, capture] of captures.entries()) {
        const dataUrl = typeof capture?.dataUrl === "string" ? capture.dataUrl : "";
        if (!dataUrl.startsWith("data:image/")) continue;
        const natural = await imageSize(dataUrl);
        const size = fitImageSize(natural.width, natural.height);
        const id = randomId("director-capture");
        const title = typeof capture.fileName === "string" && capture.fileName.trim() ? capture.fileName.trim() : `导演台截图-${index + 1}.png`;
        ops.push({
            type: "add_node",
            id,
            nodeType: "image",
            title,
            x: director.position.x + director.width + 96,
            y,
            width: size.width,
            height: size.height,
            metadata: { content: dataUrl, status: "success", naturalWidth: natural.width, naturalHeight: natural.height, mimeType: "image/png" },
        });
        ops.push({ type: "connect_nodes", fromNodeId: director.id, toNodeId: id });
        y += size.height + 36;
    }
    if (ops.length) ctx.applyOps(ops);
}

function DirectorContent({ ctx, React }) {
    const h = React.createElement;
    const [open, setOpen] = React.useState(false);
    const [status, setStatus] = React.useState("");
    const ctxRef = React.useRef(ctx);
    const panoramas = buildPanoramas(ctx);
    const panoramasRef = React.useRef(panoramas);
    const sendRef = React.useRef(null);
    const readyRef = React.useRef(false);
    ctxRef.current = ctx;
    panoramasRef.current = panoramas;

    React.useEffect(() => {
        if (!open || !sendRef.current || !readyRef.current) return;
        sendRef.current(`${DIRECTOR_PROTOCOL}-panoramas`, { panoramas: panoramasRef.current });
    }, [open, JSON.stringify(panoramas)]);

    React.useEffect(() => {
        if (!open) return undefined;
        let disposed = false;
        let frame = null;
        let prepared = null;
        const origin = window.location.origin;
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:#090909";
        const loading = document.createElement("div");
        loading.textContent = "正在加载 3D 导演台…";
        loading.style.cssText = "position:absolute;inset:0;display:grid;place-items:center;color:#fff;font:14px system-ui,sans-serif;z-index:1";
        overlay.appendChild(loading);
        document.body.appendChild(overlay);

        const send = (type, payload) => frame?.contentWindow?.postMessage({ type, payload }, origin);
        sendRef.current = send;

        const closeButton = document.createElement("button");
        closeButton.type = "button";
        closeButton.textContent = "关闭导演台";
        closeButton.style.cssText = "position:absolute;right:16px;top:12px;z-index:2;border:1px solid #ffffff44;border-radius:8px;padding:6px 10px;background:#0008;color:#fff;cursor:pointer";
        closeButton.onclick = () => setOpen(false);
        overlay.appendChild(closeButton);

        const handleMessage = (event) => {
            if (!frame || event.source !== frame.contentWindow || event.origin !== origin) return;
            const type = event.data?.type;
            if (type === `${DIRECTOR_PROTOCOL}-ready`) {
                readyRef.current = true;
                loading.remove();
                send(`${DIRECTOR_PROTOCOL}-session`, {
                    instanceId: ctxRef.current.node.id,
                    theme: themeMode(ctxRef.current),
                    project: ctxRef.current.node.metadata?.directorProject || null,
                });
                send(`${DIRECTOR_PROTOCOL}-panoramas`, { panoramas: panoramasRef.current });
                return;
            }
            if (type === `${DIRECTOR_PROTOCOL}-close`) {
                setOpen(false);
                return;
            }
            if (type === `${DIRECTOR_PROTOCOL}-project-changed`) {
                const project = event.data?.payload?.project;
                if (project && typeof project === "object" && !Array.isArray(project)) ctxRef.current.updateMetadata({ directorProject: project });
                return;
            }
            if (type === `${DIRECTOR_PROTOCOL}-panorama-removed`) {
                const edgeId = event.data?.payload?.edgeId;
                if (typeof edgeId === "string" && edgeId) ctxRef.current.applyOps([{ type: "delete_connections", ids: [edgeId] }]);
                return;
            }
            if (type === `${DIRECTOR_PROTOCOL}-captures-sent`) {
                const captures = Array.isArray(event.data?.payload?.captures) ? event.data.payload.captures : [];
                void sendCaptures(ctxRef.current, captures);
            }
        };

        window.addEventListener("message", handleMessage);
        void (async () => {
            try {
                prepared = await prepareDirectorFrame(origin);
                if (disposed) return;
                frame = document.createElement("iframe");
                frame.title = "3D导演台";
                frame.allow = "fullscreen";
                frame.referrerPolicy = "no-referrer";
                frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0";
                frame.srcdoc = prepared.html;
                overlay.appendChild(frame);
            } catch (error) {
                if (!disposed) {
                    loading.textContent = `导演台加载失败：${error instanceof Error ? error.message : String(error)}`;
                    setStatus("加载失败");
                }
            }
        })();

        return () => {
            disposed = true;
            readyRef.current = false;
            sendRef.current = null;
            window.removeEventListener("message", handleMessage);
            prepared?.dispose();
            overlay.remove();
        };
    }, [open, React]);

    const buttonStyle = {
        border: `1px solid ${ctx.theme.node.stroke}`,
        borderRadius: 10,
        padding: "8px 16px",
        background: ctx.theme.toolbar.itemHover,
        color: ctx.theme.node.text,
        cursor: "pointer",
        fontSize: 13,
    };
    return h(
        "div",
        { "data-canvas-no-zoom": true, onMouseDown: (event) => event.stopPropagation(), style: { display: "flex", height: "100%", width: "100%", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: ctx.theme.node.text } },
        h("div", { style: { fontSize: 34 } }, "🎬"),
        h("div", { style: { fontSize: 16, fontWeight: 600 } }, "3D 导演台"),
        h("div", { style: { color: ctx.theme.node.muted, fontSize: 12, textAlign: "center" } }, "连接上游图片，搭建场景并输出多视角截图"),
        h("button", { type: "button", style: buttonStyle, onMouseDown: (event) => event.stopPropagation(), onClick: () => { setStatus(""); setOpen(true); } }, open ? "导演台已打开" : "打开导演台"),
        status ? h("div", { style: { color: "#ef9a9a", fontSize: 11 } }, status) : null,
    );
}

export default function createDirectorPlugin(runtime) {
    const React = runtime.React;
    return {
        id: "director",
        name: "3D 导演台",
        version: "0.1.0",
        minAppVersion: "0.12.0",
        description: "可独立安装的 3D 场景导演台节点,支持全景输入与多视角截图输出。",
        nodes: [
            {
                type: "director:scene",
                title: "3D 导演台",
                icon: "🎬",
                description: "在 3D 空间中搭建场景并输出多视角截图",
                defaultSize: { width: 360, height: 260 },
                defaultMetadata: { directorProject: null },
                hasSourceHandle: true,
                hidePanel: true,
                Content: (props) => DirectorContent({ ...props, React }),
            },
        ],
    };
}
