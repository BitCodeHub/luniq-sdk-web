var Luniq = (function (exports) {
    'use strict';

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
    class DesignMode {
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
    const _designMode = new DesignMode();

    // ── Auto-capture helpers ─────────────────────────────────────────────────────
    // User-agent parsing: minimal regex-based classifier. Real ua-parser-js is
    // 30 KB; this catches the 95% case in <1 KB. Returns { browser, version,
    // deviceType } for breakdowns. Server-side ingest treats them as columns.
    function parseUserAgent(ua) {
        const lower = ua.toLowerCase();
        const isTablet = /ipad|tablet|playbook|silk|kindle/.test(lower) || (/android/.test(lower) && !/mobile/.test(lower));
        const isMobile = /mobi|iphone|ipod|blackberry|opera mini|opera mobi|webos/.test(lower) && !isTablet;
        const deviceType = isTablet ? "tablet" : isMobile ? "mobile" : "desktop";
        const tests = [
            ["Edge", /edg\/(\d+(?:\.\d+)?)/],
            ["Opera", /opr\/(\d+(?:\.\d+)?)/],
            ["Chrome", /chrome\/(\d+(?:\.\d+)?)/],
            ["Firefox", /firefox\/(\d+(?:\.\d+)?)/],
            ["Safari", /version\/(\d+(?:\.\d+)?).*safari/],
            ["Safari", /safari\/(\d+(?:\.\d+)?)/],
        ];
        for (const [name, re] of tests) {
            const m = lower.match(re);
            if (m)
                return { browser: name, version: m[1], deviceType };
        }
        return { browser: "Other", version: "", deviceType };
    }
    // Acquisition: UTM params from the landing URL, plus referrer host. Sticky
    // per browser session via sessionStorage so post-landing events keep the
    // original campaign — matches GA4's behavior. URL params win over a previous
    // session value (last-touch). Cleared automatically when the tab closes.
    const ACQUISITION_KEY = "luniq_acq";
    function readAcquisition() {
        const empty = { utm_source: "", utm_medium: "", utm_campaign: "", utm_term: "", utm_content: "", referrer_domain: "" };
        try {
            const url = new URL(location.href);
            const fromUrl = {
                utm_source: url.searchParams.get("utm_source") || "",
                utm_medium: url.searchParams.get("utm_medium") || "",
                utm_campaign: url.searchParams.get("utm_campaign") || "",
                utm_term: url.searchParams.get("utm_term") || "",
                utm_content: url.searchParams.get("utm_content") || "",
                referrer_domain: refDomain(document.referrer),
            };
            const hasUrlSignal = !!(fromUrl.utm_source || fromUrl.utm_medium || fromUrl.utm_campaign);
            if (hasUrlSignal) {
                sessionStorage.setItem(ACQUISITION_KEY, JSON.stringify(fromUrl));
                return fromUrl;
            }
            const cached = sessionStorage.getItem(ACQUISITION_KEY);
            if (cached) {
                try {
                    return { ...empty, ...JSON.parse(cached) };
                }
                catch { }
            }
            // No UTM signal at all — fall back to just the referrer domain.
            return { ...empty, referrer_domain: fromUrl.referrer_domain };
        }
        catch {
            return empty;
        }
    }
    function refDomain(ref) {
        if (!ref)
            return "";
        try {
            const u = new URL(ref);
            if (u.hostname === location.hostname)
                return ""; // internal nav, not a real referrer
            return u.hostname;
        }
        catch {
            return "";
        }
    }
    const uuid = () => ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
    class LuniqClient {
        constructor() {
            this.queue = [];
            this.visitorId = null;
            this.accountId = null;
            this.traits = {};
            this.sessionId = uuid();
            this.lastActivity = Date.now();
            this.sessionTimeoutMs = 30 * 60 * 1000;
        }
        start(cfg) {
            this.cfg = { autoCapture: true, batchSize: 50, flushIntervalMs: 30000, environment: "PRD", ...cfg };
            this.visitorId = localStorage.getItem("hp_visitor");
            this.accountId = localStorage.getItem("hp_account");
            try {
                this.traits = JSON.parse(localStorage.getItem("hp_traits") || "{}");
            }
            catch { }
            try {
                this.queue = JSON.parse(localStorage.getItem("hp_queue") || "[]");
            }
            catch { }
            this.flushTimer = setInterval(() => this.flush(), this.cfg.flushIntervalMs);
            window.addEventListener("visibilitychange", () => this.flush());
            window.addEventListener("beforeunload", () => this.flush(true));
            if (this.cfg.autoCapture)
                this.installAutoCapture();
            this.screen(document.title || location.pathname);
            // Design Mode: auto-pair if URL has ?luniq_design=CODE
            _designMode.configure(this.cfg.endpoint, this.cfg.apiKey);
            _designMode.maybeAutoPair();
        }
        /** Manually enter design mode with a 6-char pairing code from the dashboard. */
        enableDesignMode(code) {
            _designMode.configure(this.cfg.endpoint, this.cfg.apiKey);
            _designMode.pair(code);
        }
        identify(visitorId, accountId, traits) {
            this.visitorId = visitorId;
            this.accountId = accountId ?? null;
            this.traits = { ...this.traits, ...(traits || {}) };
            localStorage.setItem("hp_visitor", visitorId);
            if (accountId)
                localStorage.setItem("hp_account", accountId);
            localStorage.setItem("hp_traits", JSON.stringify(this.traits));
        }
        track(name, properties = {}) {
            if (Date.now() - this.lastActivity > this.sessionTimeoutMs)
                this.sessionId = uuid();
            this.lastActivity = Date.now();
            const ev = {
                id: uuid(),
                name,
                properties: this.enrich(properties),
                timestamp: new Date().toISOString(),
                sessionId: this.sessionId,
                visitorId: this.visitorId,
                accountId: this.accountId,
            };
            this.queue.push(ev);
            this.persist();
            if (this.queue.length >= (this.cfg.batchSize || 50))
                this.flush();
        }
        screen(name, properties = {}) {
            this.track("$screen", { ...properties, screen_name: name });
        }
        optOut(on) { localStorage.setItem("hp_opt_out", on ? "1" : "0"); }
        async submitFeedback(kind, message) {
            await fetch(`${this.cfg.endpoint}/v1/sdk/feedback`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Luniq-Key": this.cfg.apiKey },
                body: JSON.stringify({
                    kind, message,
                    visitorId: this.visitorId || "",
                    accountId: this.accountId || "",
                    screen: location.pathname,
                    appVersion: "web",
                }),
            });
        }
        enrich(p) {
            const ua = parseUserAgent(navigator.userAgent);
            const acq = readAcquisition();
            return {
                ...p,
                os_type: "WEB",
                env: this.cfg.environment,
                user_agent: navigator.userAgent,
                url: location.href,
                path: location.pathname,
                referrer: document.referrer,
                // Browser + device classification (auto-detected, can be overridden by caller)
                browser: ua.browser,
                browser_version: ua.version,
                device_type: ua.deviceType,
                // Marketing attribution (UTM params + referrer domain). Sticky for the
                // session so post-landing events keep the original campaign context.
                utm_source: acq.utm_source,
                utm_medium: acq.utm_medium,
                utm_campaign: acq.utm_campaign,
                utm_term: acq.utm_term,
                utm_content: acq.utm_content,
                referrer_domain: acq.referrer_domain,
                ...this.traits,
            };
        }
        persist() {
            localStorage.setItem("hp_queue", JSON.stringify(this.queue.slice(-5000)));
        }
        async flush(sync = false) {
            if (localStorage.getItem("hp_opt_out") === "1")
                return;
            if (this.queue.length === 0)
                return;
            const batch = this.queue.splice(0, this.cfg.batchSize || 50);
            this.persist();
            const body = JSON.stringify({ events: batch });
            const url = `${this.cfg.endpoint}/v1/events`;
            const headers = { "Content-Type": "application/json", "X-Luniq-Key": this.cfg.apiKey };
            try {
                if (sync && "sendBeacon" in navigator) {
                    navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
                }
                else {
                    const r = await fetch(url, { method: "POST", headers, body, keepalive: true });
                    if (!r.ok)
                        throw new Error("send failed");
                }
            }
            catch {
                this.queue.unshift(...batch);
                this.persist();
            }
        }
        installAutoCapture() {
            // Click tracking
            document.addEventListener("click", (e) => {
                const t = e.target;
                if (!t)
                    return;
                const tag = t.tagName.toLowerCase();
                const props = {
                    tag,
                    text: (t.innerText || t.textContent || "").slice(0, 80).trim(),
                    id: t.id || "",
                    classes: t.className || "",
                    href: t.href || "",
                    source: "auto",
                };
                this.track("$tap", props);
            }, true);
            // SPA route change
            const origPush = history.pushState;
            const origReplace = history.replaceState;
            const onRoute = () => this.screen(document.title || location.pathname);
            history.pushState = function (...args) { const r = origPush.apply(this, args); onRoute(); return r; };
            history.replaceState = function (...args) { const r = origReplace.apply(this, args); onRoute(); return r; };
            window.addEventListener("popstate", onRoute);
        }
    }
    const Luniq = new LuniqClient();
    // UMD-style global for <script> include
    if (typeof window !== "undefined")
        window.Luniq = Luniq;

    exports.Luniq = Luniq;

    return exports;

})({});
//# sourceMappingURL=luniq.js.map
