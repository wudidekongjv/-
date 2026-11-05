// 视频拆帧节点插件 —— 独立安装，不依赖宿主源码或 React 包。
// 只使用 Infinite Canvas 公开的工厂运行时契约（runtime.React / ctx.*）。
//
// 关键：视频节点的视频数据存在 metadata.content（远程 http/https URL），
// 节点 type 为 "video"。浏览器 <video> 播放跨域视频时不能加 crossOrigin
// （否则会因缺少 CORS 头而加载失败）；但要 drawImage 到 canvas 又需要 CORS。
// 因此复刻宿主 captureVideoFrame 的策略：
//   1) 先尝试直接抽帧（同源 / blob / CORS 允许时成功）；
//   2) 失败则通过宿主代理 /api/proxy-image 下载成 blob，再本地抽帧。

const MIME_TYPES = ["video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-matroska"];
const VIDEO_EXT_RE = /\.(mp4|webm|ogv|ogg|mov|m4v|mkv)$/i;

function randomId(prefix) {
    if (typeof crypto?.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// 复刻宿主 getProxyUrl 的核心逻辑（本地/内网地址不代理，其余走 /api/proxy-image）。
function isLocalNetworkHost(hostname) {
    const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
    if (!host) return false;
    if (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host === "host.docker.internal" ||
        host === "::1"
    ) {
        return true;
    }
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
    const [a, b] = parts;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function getProxyUrl(url) {
    if (typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"))) return url;
    try {
        const parsed = new URL(url);
        if (isLocalNetworkHost(parsed.hostname) || (typeof window !== "undefined" && parsed.host === window.location.host)) {
            return url;
        }
    } catch {
        return url;
    }
    return `/api/proxy-image?url=${encodeURIComponent(url)}`;
}

// 把任意时间格式（秒数 / "mm:ss" / "hh:mm:ss" / "mm:ss.mmm"）解析成秒。
function parseTimeToSeconds(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const raw = String(value ?? "").trim();
    if (!raw) return NaN;
    if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
    const parts = raw.split(":").map((p) => Number(p));
    if (parts.some((p) => Number.isNaN(p))) return NaN;
    let seconds = 0;
    for (const part of parts) seconds = seconds * 60 + part;
    return seconds;
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function clamp(value, min, max) {
    if (Number.isNaN(value)) return min;
    return Math.min(max, Math.max(min, value));
}

// 判断上游节点是否携带可用视频数据。
// 视频节点 type === "video"，视频地址在 metadata.content（远程 URL / dataURL / blob URL）。
function extractVideoSource(node) {
    if (!node) return null;
    if (node.type === "video" && typeof node.metadata?.content === "string" && node.metadata.content) {
        return { id: node.id, src: node.metadata.content, name: node.title || "视频" };
    }
    // 兜底：其他类型节点若 content 是视频则也识别（兼容 dataURL/blob 直连）。
    const content = node.metadata?.content;
    const mime = node.metadata?.mimeType || "";
    if (typeof content === "string" && content) {
        const looksLikeVideo =
            content.startsWith("data:video/") ||
            (content.startsWith("blob:") && mime.startsWith("video/")) ||
            MIME_TYPES.includes(mime) ||
            VIDEO_EXT_RE.test(node.title || "") ||
            /\.(mp4|webm|ogv|ogg|mov|m4v|mkv)(\?|#|$)/i.test(content);
        if (looksLikeVideo) return { id: node.id, src: content, name: node.title || "视频" };
    }
    return null;
}

function buildVideoSources(ctx) {
    const upstream = ctx.getUpstream();
    return upstream.map(extractVideoSource).filter(Boolean);
}

// 把视频源地址解析成「浏览器可真正加载」的地址。
// 复刻宿主 hushifu-bridge 的 yye / remoteToDataUrl 逻辑：
//   - dataURL / blob URL → 原样返回
//   - https://canvas-assets/xxx → 走 window.hushifuHost.materialDataUrl(文件名) 拿 dataURL
//     （canvas-assets 是 DenyCors 虚拟主机，页面 fetch/<video> 都加载不到，必须走宿主 postMessage 通道）
//   - 其他远程 http/https URL → fetch 下载成 blob 再转本地 blob URL
async function resolveVideoSource(src) {
    const value = String(src || "");
    if (!value) return null;
    if (value.startsWith("data:") || value.startsWith("blob:")) return value;

    const host = (typeof window !== "undefined" && window.hushifuHost) || null;
    const canvasAsset = value.match(/^https:\/\/canvas-assets\/([^/?#]+)/i);
    if (canvasAsset && host && typeof host.materialDataUrl === "function") {
        try {
            const dataUrl = await host.materialDataUrl(canvasAsset[1]);
            if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) return dataUrl;
        } catch (_error) {
            // 拿不到就走下面的普通 fetch 兜底（大概率也失败，但至少给个明确错误）。
        }
        throw new Error("无法从宿主读取该视频素材（canvas-assets 通道失败）");
    }

    if (value.startsWith("http://") || value.startsWith("https://")) {
        try {
            const response = await fetch(value, { cache: "no-store" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            if (blob.type.includes("json") || blob.type.startsWith("text/")) throw new Error("远程地址返回的不是视频");
            return URL.createObjectURL(blob);
        } catch (error) {
            throw new Error(`视频下载失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return value;
}

// 从 <video> 的某个时间点抽出帧，返回 dataURL。
function captureFrame(video, time, format, quality) {
    return new Promise((resolve, reject) => {
        let finished = false;
        const done = (result) => { if (finished) return; finished = true; resolve(result); };
        const fail = (error) => { if (finished) return; finished = true; reject(error); };

        const onSeeked = () => {
            try {
                const width = video.videoWidth;
                const height = video.videoHeight;
                if (!width || !height) return fail(new Error("无法读取视频画面尺寸"));
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const context = canvas.getContext("2d");
                context.drawImage(video, 0, 0, width, height);
                const dataUrl = canvas.toDataURL(format, quality);
                done(dataUrl);
            } catch (error) {
                fail(error);
            }
        };

        video.removeEventListener("seeked", onSeeked);
        video.addEventListener("seeked", onSeeked);
        const onError = () => fail(new Error("视频解码失败"));
        video.addEventListener("error", onError);
        try {
            video.currentTime = time;
        } catch (error) {
            fail(error);
        }
        setTimeout(() => fail(new Error("抽帧超时")), 4000);
    });
}

// 从某个源加载出可用的 <video>。不加 crossOrigin（否则跨域远程视频会因缺 CORS 头加载失败）。
function loadVideo(src) {
    return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        video.preload = "auto";
        video.muted = true;
        video.playsInline = true;
        let settled = false;
        const fail = (error) => { if (settled) return; settled = true; reject(error); };
        const onLoaded = () => { if (settled) return; settled = true; resolve(video); };
        video.addEventListener("loadedmetadata", onLoaded);
        video.addEventListener("error", () => fail(new Error("视频加载失败")));
        video.src = src;
        video.load();
    });
}

// 通过宿主代理下载远程媒体为 blob（复刻 downloadRemoteMedia 策略）。
async function downloadRemoteMedia(url) {
    const response = await fetch(getProxyUrl(url), { cache: "no-store" });
    if (!response.ok) throw new Error(`媒体下载失败 (${response.status})`);
    const blob = await response.blob();
    if (blob.type.includes("json") || blob.type.startsWith("text/")) {
        const text = await blob.text().catch(() => "");
        let message = "";
        try { message = JSON.parse(text)?.msg || JSON.parse(text)?.message || ""; } catch { /* ignore */ }
        throw new Error(message || "代理下载失败");
    }
    return blob;
}

// 抽帧（先解析视频源地址，再加载抽帧；canvas-assets 虚拟地址会走宿主通道转 dataURL）。
async function captureFrameFromSource(source, time, format, quality) {
    // 1) 先解析出浏览器真正能加载的地址（canvas-assets → dataURL / 远程 → blob URL）。
    const resolved = await resolveVideoSource(source);
    if (!resolved) throw new Error("视频源地址为空");

    // 2) 加载并抽帧。
    const localUrl = resolved.startsWith("data:") || resolved.startsWith("blob:") ? resolved : null;
    try {
        const video = await loadVideo(resolved);
        try {
            return await captureFrame(video, time, format, quality);
        } finally {
            video.removeAttribute("src");
            video.load();
        }
    } catch (error) {
        // 3) 兜底：如果直连失败（跨域/CORS），尝试下载成 blob 再抽。
        if (localUrl) throw error;
        const blobUrl = URL.createObjectURL(await downloadRemoteMedia(resolved));
        try {
            const video = await loadVideo(blobUrl);
            try {
                return await captureFrame(video, time, format, quality);
            } finally {
                video.removeAttribute("src");
                video.load();
            }
        } finally {
            URL.revokeObjectURL(blobUrl);
        }
    }
}

// 输出帧图片的原始尺寸。
function imageSize(dataUrl) {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth || 960, height: image.naturalHeight || 540 });
        image.onerror = () => resolve({ width: 960, height: 540 });
        image.src = dataUrl;
    });
}

function fitImageSize(width, height) {
    const maxWidth = 420;
    const maxHeight = 320;
    const scale = Math.min(1, maxWidth / Math.max(width, 1), maxHeight / Math.max(height, 1));
    return { width: Math.max(160, Math.round(width * scale)), height: Math.max(120, Math.round(height * scale)) };
}

async function sendFrames(ctx, frames) {
    if (!frames.length) return;
    const node = ctx.node;
    const nodes = ctx.getNodes();
    const connections = ctx.getConnections();
    let y = node.position.y;
    for (const connection of connections) {
        if (connection.fromNodeId !== node.id) continue;
        const output = nodes.find((item) => item.id === connection.toNodeId);
        if (output?.type === "image") y = Math.max(y, output.position.y + output.height + 28);
    }

    const ops = [];
    for (const [index, frame] of frames.entries()) {
        if (typeof frame?.dataUrl !== "string" || !frame.dataUrl.startsWith("data:image/")) continue;
        const natural = await imageSize(frame.dataUrl);
        const size = fitImageSize(natural.width, natural.height);
        const id = randomId("video-frame");
        const title = frame.fileName || `拆帧-${index + 1}.jpg`;
        ops.push({
            type: "add_node",
            id,
            nodeType: "image",
            title,
            x: node.position.x + node.width + 88,
            y,
            width: size.width,
            height: size.height,
            metadata: { content: frame.dataUrl, status: "success", naturalWidth: natural.width, naturalHeight: natural.height, mimeType: "image/jpeg" },
        });
        ops.push({ type: "connect_nodes", fromNodeId: node.id, toNodeId: id });
        y += size.height + 28;
    }
    if (ops.length) ctx.applyOps(ops);
}

function VideoFrameContent({ ctx, React }) {
    const h = React.createElement;

    const [videoSrc, setVideoSrc] = React.useState(null);
    const [resolvedSrc, setResolvedSrc] = React.useState(null);
    const [videoName, setVideoName] = React.useState("");
    const [duration, setDuration] = React.useState(0);
    const [videoEl, setVideoEl] = React.useState(null);

    const [mode, setMode] = React.useState("single");
    const [singleTime, setSingleTime] = React.useState("0");
    const [rangeStart, setRangeStart] = React.useState("0");
    const [rangeEnd, setRangeEnd] = React.useState("");
    const [interval, setInterval] = React.useState("1");
    const [format, setFormat] = React.useState("image/jpeg");
    const [quality, setQuality] = React.useState(0.92);

    const [previews, setPreviews] = React.useState([]);
    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState("");

    const ctxRef = React.useRef(ctx);
    ctxRef.current = ctx;
    const fileInputRef = React.useRef(null);
    const videoRef = React.useRef(null);

    // 从上游自动识别视频源。
    React.useEffect(() => {
        const sources = buildVideoSources(ctxRef.current);
        if (!sources.length) return;
        const first = sources[0];
        if (!first.src) return;
        void (async () => {
            try {
                const resolved = await resolveVideoSource(first.src);
                if (!resolved) throw new Error("视频源地址为空");
                const video = await loadVideo(resolved);
                setVideoEl(video);
                setVideoSrc(first.src);
                setResolvedSrc(resolved);
                setVideoName(first.name);
                setDuration(video.duration || 0);
                setRangeEnd(String(Math.round((video.duration || 0) * 100) / 100));
                setStatus("");
            } catch (error) {
                setStatus(`视频加载失败：${error instanceof Error ? error.message : String(error)}`);
            }
        })();
    }, [JSON.stringify(buildVideoSources(ctxRef.current).map((s) => s.id))]);

    const handleFile = (event) => {
        const file = event.target?.files?.[0];
        if (!file) return;
        const url = URL.createObjectURL(file);
        void (async () => {
            try {
                const video = await loadVideo(url);
                setVideoEl(video);
                setVideoSrc(url);
                setResolvedSrc(url);
                setVideoName(file.name || "导入视频");
                setDuration(video.duration || 0);
                setRangeEnd(String(Math.round((video.duration || 0) * 100) / 100));
                setPreviews([]);
                setStatus("");
            } catch (error) {
                setStatus(`视频加载失败：${error instanceof Error ? error.message : String(error)}`);
            }
        })();
    };

    const seekPreview = (time) => {
        if (!videoEl) return;
        try {
            videoEl.currentTime = clamp(time, 0, duration || 0);
            videoEl.pause();
        } catch (_error) { /* ignore */ }
    };

    const previewSingle = async () => {
        if (!videoSrc) { setStatus("请先导入或连接视频"); return; }
        setBusy(true);
        setStatus("");
        try {
            const time = clamp(parseTimeToSeconds(singleTime), 0, duration || 0);
            if (Number.isNaN(time)) throw new Error("时间格式无效");
            const dataUrl = await captureFrameFromSource(videoSrc, time, format, quality);
            setPreviews([{ key: randomId("preview"), time, dataUrl, fileName: `${(videoName.replace(/\.[^.]+$/, "") || "拆帧")}-${time.toFixed(2)}s.jpg` }]);
            seekPreview(time);
        } catch (error) {
            setStatus(`拆帧失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusy(false);
        }
    };

    const previewRange = async () => {
        if (!videoSrc) { setStatus("请先导入或连接视频"); return; }
        const start = parseTimeToSeconds(rangeStart);
        const end = parseTimeToSeconds(rangeEnd || String(duration || 0));
        const step = parseTimeToSeconds(interval);
        if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(step)) { setStatus("起止时间或间隔格式无效"); return; }
        if (step <= 0) { setStatus("间隔必须大于 0"); return; }
        if (end <= start) { setStatus("结束时间必须大于开始时间"); return; }
        setBusy(true);
        setStatus("");
        try {
            const times = [];
            for (let t = start; t <= end + 1e-6; t += step) times.push(Math.round(t * 1000) / 1000);
            if (times.length > 120) { setStatus("单次最多拆 120 帧，请增大间隔"); setBusy(false); return; }
            const results = [];
            for (const time of times) {
                const dataUrl = await captureFrameFromSource(videoSrc, time, format, quality);
                results.push({ key: randomId("preview"), time, dataUrl, fileName: `${(videoName.replace(/\.[^.]+$/, "") || "拆帧")}-${time.toFixed(2)}s.jpg` });
            }
            setPreviews(results);
        } catch (error) {
            setStatus(`拆帧失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusy(false);
        }
    };

    const clearPreviews = () => setPreviews([]);

    const exportFrames = async () => {
        if (!previews.length) { setStatus("没有可回传的帧，请先拆帧"); return; }
        setBusy(true);
        try {
            await sendFrames(ctxRef.current, previews);
            setStatus(`已回传 ${previews.length} 帧到画布`);
        } catch (error) {
            setStatus(`回传失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setBusy(false);
        }
    };

    const muted = ctx.theme.node.muted;
    const text = ctx.theme.node.text;
    const stroke = ctx.theme.node.stroke;

    const labelStyle = { fontSize: 11, color: muted, marginBottom: 3 };
    const inputStyle = {
        background: ctx.theme.toolbar.itemHover || "transparent",
        border: `1px solid ${stroke}`,
        borderRadius: 6,
        padding: "4px 8px",
        color: text,
        fontSize: 12,
        width: "100%",
        boxSizing: "border-box",
    };
    const buttonStyle = {
        border: `1px solid ${stroke}`,
        borderRadius: 8,
        padding: "6px 12px",
        background: ctx.theme.toolbar.itemHover,
        color: text,
        cursor: "pointer",
        fontSize: 12,
    };
    const primaryStyle = { ...buttonStyle, background: ctx.theme.accent || "#4c8dff", color: "#fff", fontWeight: 600 };

    const modeButton = (value, label) =>
        h("button", {
            type: "button",
            style: { ...buttonStyle, flex: 1, background: mode === value ? (ctx.theme.accent || "#4c8dff") : ctx.theme.toolbar.itemHover, color: mode === value ? "#fff" : text },
            onClick: () => setMode(value),
        }, label);

    return h(
        "div",
        { "data-canvas-no-zoom": true, style: { display: "flex", flexDirection: "column", gap: 10, padding: 12, width: "100%", height: "100%", boxSizing: "border-box", overflowY: "auto", color: text, fontSize: 12 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            h("span", { style: { fontSize: 18 } }, "🎞️"),
            h("span", { style: { fontSize: 14, fontWeight: 600 } }, "视频拆帧"),
        ),
        h("div", null,
            h("div", { style: labelStyle }, "视频源"),
            h("input", { ref: fileInputRef, type: "file", accept: "video/*", style: { display: "none" }, onChange: handleFile }),
            h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                h("button", { type: "button", style: buttonStyle, onClick: () => fileInputRef.current?.click() }, "导入视频"),
                videoSrc ? h("span", { style: { fontSize: 11, color: muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, videoName || "已加载") : h("span", { style: { fontSize: 11, color: muted } }, "也可连接上游视频节点"),
            ),
        ),
        videoSrc
            ? h("video", {
                ref: videoRef,
                src: resolvedSrc || videoSrc,
                controls: true,
                muted: true,
                playsInline: true,
                style: { width: "100%", maxHeight: 180, borderRadius: 8, background: "#000" },
                onLoadedMetadata: (event) => { setDuration(event.target.duration || 0); setRangeEnd(String(Math.round((event.target.duration || 0) * 100) / 100)); },
            })
            : null,
        h("div", { style: { display: "flex", gap: 6 } },
            modeButton("single", "拆单帧"),
            modeButton("range", "间隔拆帧"),
        ),
        mode === "single"
            ? h("div", null,
                h("div", { style: labelStyle }, `单帧时间（当前 ${duration ? `0:00 - ${formatTime(duration)}` : "未知时长"}）`),
                h("input", { type: "text", value: singleTime, style: inputStyle, placeholder: "秒数或 mm:ss", onChange: (e) => setSingleTime(e.target.value) }),
                h("div", { style: { display: "flex", gap: 6, marginTop: 8 } },
                    h("button", { type: "button", style: primaryStyle, onClick: previewSingle, disabled: busy }, busy ? "拆帧中…" : "预览这一帧"),
                ),
            )
            : h("div", null,
                h("div", { style: labelStyle }, "开始时间"),
                h("input", { type: "text", value: rangeStart, style: inputStyle, onChange: (e) => setRangeStart(e.target.value) }),
                h("div", { style: { ...labelStyle, marginTop: 6 } }, "结束时间"),
                h("input", { type: "text", value: rangeEnd, style: inputStyle, onChange: (e) => setRangeEnd(e.target.value) }),
                h("div", { style: { ...labelStyle, marginTop: 6 } }, "间隔（秒）"),
                h("input", { type: "text", value: interval, style: inputStyle, onChange: (e) => setInterval(e.target.value) }),
                h("div", { style: { display: "flex", gap: 6, marginTop: 8 } },
                    h("button", { type: "button", style: primaryStyle, onClick: previewRange, disabled: busy }, busy ? "拆帧中…" : "拆分多帧"),
                ),
            ),
        h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
            h("select", { value: format, style: { ...inputStyle, width: "auto" }, onChange: (e) => setFormat(e.target.value) },
                h("option", { value: "image/jpeg" }, "JPG"),
                h("option", { value: "image/png" }, "PNG"),
                h("option", { value: "image/webp" }, "WebP"),
            ),
            h("span", { style: { fontSize: 11, color: muted } }, "质量"),
            h("input", { type: "range", min: 0.5, max: 1, step: 0.01, value: quality, style: { flex: 1 }, onChange: (e) => setQuality(Number(e.target.value)) }),
        ),
        previews.length
            ? h("div", null,
                h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
                    h("div", { style: labelStyle }, `预览（${previews.length} 帧）`),
                    h("button", { type: "button", style: buttonStyle, onClick: clearPreviews }, "清空"),
                ),
                h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: 6 } },
                    previews.map((preview) =>
                        h("div", { key: preview.key, style: { position: "relative", cursor: "pointer" }, onClick: () => seekPreview(preview.time) },
                            h("img", { src: preview.dataUrl, alt: `${preview.time}s`, style: { width: "100%", borderRadius: 6, display: "block", background: "#000" } }),
                            h("div", { style: { position: "absolute", left: 0, bottom: 0, right: 0, fontSize: 9, color: "#fff", background: "#0008", padding: "1px 4px", borderBottomLeftRadius: 6, borderBottomRightRadius: 6 } }, formatTime(preview.time)),
                        ),
                    ),
                ),
                h("button", { type: "button", style: { ...primaryStyle, marginTop: 8 }, onClick: exportFrames, disabled: busy }, busy ? "处理中…" : `回传 ${previews.length} 帧到画布`),
            )
            : null,
        status ? h("div", { style: { color: "#ef9a9a", fontSize: 11 } }, status) : null,
    );
}

export default function createVideoFramePlugin(runtime) {
    const React = runtime.React;
    return {
        id: "video-frame",
        name: "视频拆帧",
        version: "0.2.0",
        minAppVersion: "0.12.0",
        description: "从视频中拆分单帧或多帧（间隔拆分），带预览，可回传为画布图片节点。",
        nodes: [
            {
                type: "video:frame",
                title: "视频拆帧",
                icon: "🎞️",
                description: "导入或连接视频，拆分单帧 / 间隔多帧并回传画布",
                defaultSize: { width: 360, height: 620 },
                defaultMetadata: {},
                hasSourceHandle: true,
                hidePanel: true,
                Content: (props) => VideoFrameContent({ ...props, React }),
            },
        ],
    };
}
