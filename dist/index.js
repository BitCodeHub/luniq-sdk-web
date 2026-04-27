import { _designMode } from "./design-mode";
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
        return {
            ...p,
            os_type: "WEB",
            env: this.cfg.environment,
            user_agent: navigator.userAgent,
            url: location.href,
            path: location.pathname,
            referrer: document.referrer,
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
export const Luniq = new LuniqClient();
// UMD-style global for <script> include
if (typeof window !== "undefined")
    window.Luniq = Luniq;
