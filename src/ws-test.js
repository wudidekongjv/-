// 本地 WebSocket 连通性测试节点 —— 验证画布(WebView2)能否连本地 ws。
// 尝试连接 ws://127.0.0.1:8899，把状态/消息/错误显示在节点里。

function WsTestContent({ ctx, React }) {
    const h = React.createElement;
    const [status, setStatus] = React.useState("未连接");
    const [messages, setMessages] = React.useState([]);
    const [error, setError] = React.useState("");
    const wsRef = React.useRef(null);

    const connect = () => {
        setStatus("连接中…");
        setError("");
        setMessages([]);
        try {
            const ws = new WebSocket("ws://127.0.0.1:8899");
            wsRef.current = ws;
            ws.onopen = () => {
                setStatus("已连接 ✅");
            };
            ws.onmessage = (event) => {
                let text = String(event.data || "");
                try { text = JSON.stringify(JSON.parse(text)); } catch (_e) {}
                setMessages((prev) => [...prev.slice(-20), text]);
            };
            ws.onerror = (event) => {
                setError("WebSocket onerror 触发（详见下方）");
            };
            ws.onclose = (event) => {
                setStatus(`已关闭 (code=${event.code}, reason=${event.reason || "无"})`);
            };
        } catch (err) {
            setStatus("连接异常");
            setError(err instanceof Error ? err.message : String(err));
        }
    };

    const disconnect = () => {
        if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
        setStatus("已主动断开");
    };

    const muted = ctx.theme.node.muted;
    const text = ctx.theme.node.text;
    const stroke = ctx.theme.node.stroke;
    const buttonStyle = {
        border: `1px solid ${stroke}`, borderRadius: 8, padding: "6px 12px", background: ctx.theme.toolbar.itemHover, color: text, cursor: "pointer", fontSize: 12,
    };
    const primaryStyle = { ...buttonStyle, background: ctx.theme.accent || "#4c8dff", color: "#fff", fontWeight: 600 };

    return h(
        "div",
        { "data-canvas-no-zoom": true, style: { display: "flex", flexDirection: "column", gap: 10, padding: 12, width: "100%", height: "100%", boxSizing: "border-box", overflowY: "auto", color: text, fontSize: 12 } },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            h("span", { style: { fontSize: 18 } }, "🔌"),
            h("span", { style: { fontSize: 14, fontWeight: 600 } }, "本地 WebSocket 测试"),
        ),
        h("div", { style: { fontSize: 12 } }, `状态：${status}`),
        h("div", { style: { display: "flex", gap: 6 } },
            h("button", { type: "button", style: primaryStyle, onClick: connect }, "连接 ws://127.0.0.1:8899"),
            h("button", { type: "button", style: buttonStyle, onClick: disconnect }, "断开"),
        ),
        error ? h("div", { style: { color: "#ef9a9a", fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all" } }, `错误：${error}`) : null,
        h("div", { style: { fontSize: 11, color: muted } }, "收到消息："),
        h("div", { style: { fontSize: 11, color: muted, maxHeight: 200, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", border: `1px solid ${stroke}`, borderRadius: 6, padding: 6, background: "transparent" } },
            messages.length ? messages.map((m, i) => h("div", { key: i }, m)).join ? messages.map((m, i) => h("div", { key: i }, m)) : messages.join("\n") : "（暂无）",
        ),
    );
}

export default function createWsTestPlugin(runtime) {
    const React = runtime.React;
    return {
        id: "ws-test",
        name: "本地WebSocket测试",
        version: "0.1.0",
        minAppVersion: "0.12.0",
        description: "验证画布能否连接本地 WebSocket（ws://127.0.0.1:8899）。",
        nodes: [
            {
                type: "ws:test",
                title: "本地WebSocket测试",
                icon: "🔌",
                description: "测试画布与本地服务的 WebSocket 连通性",
                defaultSize: { width: 360, height: 320 },
                defaultMetadata: {},
                hasSourceHandle: false,
                hidePanel: true,
                Content: (props) => WsTestContent({ ...props, React }),
            },
        ],
    };
}
