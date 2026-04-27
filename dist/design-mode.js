// Design Mode for the web SDK — pairs the customer's site to the Pulse
// dashboard via WebSocket so a PM can preview unpublished guides/banners/
// surveys on the live page before publishing.
//
// Activation:
//   1. Append ?luniq_design=CODE to any page URL  → SDK auto-pairs.
//   2. Or call Luniq.enableDesignMode("CODE")    → pairs immediately.
//
// On pair, an "● LUNIQ.AI DESIGN MODE" pill appears top-center of the page;
// commands from the dashboard (preview_guide / preview_banner / preview_survey
// / fire_event / navigate) are dispatched as CustomEvents on `window` so the
// host SDK's existing engines render them on the real DOM.
export class DesignMode {
    constructor() {
        this.ws = null;
        this.endpoint = "";
        this.apiKey = "";
        this.code = null;
        this.connected = false;
        this.overlayEl = null;
        this.screen = "unknown";
        this.onCommand = null;
    }
    configure(endpoint, apiKey) {
        this.endpoint = endpoint;
        this.apiKey = apiKey;
    }
    /** Sets the host SDK callback that receives preview commands. */
    setCommandHandler(fn) { this.onCommand = fn; }
    /** Auto-pair if URL contains ?luniq_design=CODE. */
    maybeAutoPair() {
        if (typeof window === "undefined")
            return;
        try {
            const url = new URL(window.location.href);
            const code = url.searchParams.get("luniq_design");
            if (code) {
                this.pair(code);
                // strip from address bar so refresh doesn't repeat
                url.searchParams.delete("luniq_design");
                window.history.replaceState({}, "", url.toString());
            }
        }
        catch { /* ignore */ }
    }
    pair(code) {
        this.code = code.trim().toLowerCase();
        if (!this.endpoint || !this.code)
            return;
        const wsBase = this.endpoint.replace(/^https/, "wss").replace(/^http/, "ws");
        const url = `${wsBase}/v1/design/ws/${this.code}/sdk`;
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.onopen = () => {
            this.connected = true;
            this.send({ type: "hello", platform: "web", ua: navigator.userAgent, viewport: { w: window.innerWidth, h: window.innerHeight } });
            this.installOverlay("paired");
            this.startScreenObserver();
        };
        ws.onclose = () => { this.connected = false; this.setStatus("disconnected"); };
        ws.onerror = () => { this.setStatus("error"); };
        ws.onmessage = (evt) => {
            try {
                const msg = JSON.parse(evt.data);
                this.handle(msg);
            }
            catch { /* ignore */ }
        };
        this.installOverlay("connecting…");
    }
    reportScreen(name) {
        if (this.screen === name)
            return;
        this.screen = name;
        this.send({ type: "screen", name });
    }
    disconnect() {
        this.connected = false;
        this.ws?.close(1000, "exit");
        this.ws = null;
        this.removeOverlay();
    }
    send(obj) {
        if (!this.connected || !this.ws)
            return;
        try {
            this.ws.send(JSON.stringify(obj));
        }
        catch { /* ignore */ }
    }
    handle(msg) {
        switch (msg.type) {
            case "preview_guide":
                this.dispatch("guide", msg.guide);
                break;
            case "preview_banner":
                this.dispatch("banner", msg.banner);
                break;
            case "preview_survey":
                this.dispatch("survey", msg.survey);
                break;
            case "fire_event":
                this.dispatch("event", { name: msg.name });
                break;
            case "navigate":
                this.dispatch("navigate", { screen: msg.screen });
                break;
            case "exit_design_mode":
                this.disconnect();
                break;
            default: break;
        }
    }
    dispatch(kind, payload) {
        this.onCommand?.(kind, payload);
        try {
            window.dispatchEvent(new CustomEvent("luniq:design:command", { detail: { kind, payload } }));
        }
        catch { /* ignore */ }
    }
    startScreenObserver() {
        // Track SPA route changes — the host SDK already wraps history.pushState; we
        // mirror that here so design mode also notices.
        let last = location.pathname + location.search;
        const tick = () => {
            const cur = location.pathname + location.search;
            if (cur !== last) {
                last = cur;
                this.reportScreen(document.title || location.pathname);
            }
        };
        setInterval(tick, 500);
        this.reportScreen(document.title || location.pathname);
    }
    /* ───────────── Overlay UI ───────────── */
    installOverlay(initial) {
        if (typeof document === "undefined")
            return;
        if (this.overlayEl) {
            this.setStatus(initial);
            return;
        }
        const wrap = document.createElement("div");
        wrap.id = "luniq-design-overlay";
        wrap.style.cssText = [
            "position:fixed", "top:12px", "left:50%", "transform:translateX(-50%)",
            "z-index:2147483647", "display:flex", "gap:8px", "align-items:center",
            "padding:6px 12px", "border-radius:20px",
            "background:rgba(194,133,107,.95)", "color:#fff",
            "font:600 11px/1 -apple-system,Segoe UI,sans-serif", "letter-spacing:.4px",
            "box-shadow:0 6px 20px rgba(0,0,0,.4)", "cursor:default",
        ].join(";");
        const dot = document.createElement("span");
        dot.style.cssText = "width:8px;height:8px;border-radius:4px;background:#fff;display:inline-block";
        const label = document.createElement("span");
        label.dataset.role = "label";
        label.textContent = `LUNIQ.AI DESIGN MODE — ${initial}`;
        const exit = document.createElement("button");
        exit.textContent = "Exit";
        exit.style.cssText = "background:rgba(0,0,0,.4);color:#fff;border:0;border-radius:10px;padding:3px 10px;font:600 10px/1 inherit;cursor:pointer;margin-left:6px";
        exit.onclick = () => this.disconnect();
        wrap.append(dot, label, exit);
        document.body.appendChild(wrap);
        this.overlayEl = wrap;
    }
    setStatus(s) {
        const lab = this.overlayEl?.querySelector('[data-role="label"]');
        if (lab)
            lab.textContent = `LUNIQ.AI DESIGN MODE — ${s}`;
    }
    removeOverlay() {
        this.overlayEl?.parentNode?.removeChild(this.overlayEl);
        this.overlayEl = null;
    }
}
export const _designMode = new DesignMode();
