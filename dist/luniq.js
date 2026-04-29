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

    /**
     * In-app engagement layer — fetches active guides, banners, and surveys
     * from the dashboard, evaluates per-page audience + trigger conditions,
     * and renders them in the host app. Backend already publishes these:
     *
     *   GET /v1/sdk/banners  → BannerObject[]
     *   GET /v1/sdk/guides   → Guide[]
     *   GET /v1/sdk/surveys  → Survey[]
     *
     * Targeting is intentionally minimal v1 — page-path match and a couple
     * of trait checks. Anything more sophisticated can be added later
     * without changing the SDK contract because the audience + trigger
     * fields are JSON blobs the dashboard owns.
     *
     * Tracking: every render emits a `$banner_shown` / `$guide_started` /
     * `$survey_shown` event so impressions appear in the dashboard, and
     * dismiss/click/answer events ride the same analytics pipeline. No new
     * backend endpoints needed for this — everything flows through the
     * existing /v1/events ingest.
     */
    const DISMISSED_KEY = "luniq_engage_dismissed";
    const REFRESH_MS = 5 * 60 * 1000;
    const FIRST_FETCH_DELAY_MS = 4000;
    class EngageRuntime {
        constructor() {
            this.banners = [];
            this.guides = [];
            this.surveys = [];
            this.dismissed = new Set();
            this.bannerEl = null;
            this.guideEl = null;
            this.surveyEl = null;
            this.guideState = null;
            this.timers = new Set();
            // Tracks listeners armed by armOrRender so we can remove them on
            // SPA route changes — prevents leaks + duplicate fires on cross-page
            // navigation, which the prior implementation couldn't recover from.
            this.attachedArms = new Map();
        }
        start(client, endpoint, apiKey, env) {
            this.client = client;
            this.endpoint = endpoint.replace(/\/+$/, "");
            this.apiKey = apiKey;
            this.env = env || "PRD";
            this.loadDismissed();
            this.injectStyles();
            this.scheduleFetch();
            window.addEventListener("luniq:route-change", () => {
                // Detach trigger listeners armed for the previous path so they
                // don't fire (or leak) on the new one. evaluateAll() then re-arms
                // anything that still matches.
                this.detachAllArms();
                this.evaluateAll();
            });
            const id = window.setInterval(() => this.evaluateAll(), 60000);
            this.timers.add(id);
        }
        /** Public manual triggers — host apps can call these to surface a
         *  specific item ad-hoc, e.g. after a successful checkout. */
        showBanner(id) { const b = this.banners.find((x) => x.id === id); if (b)
            this.renderBanner(b); }
        showGuide(id) { const g = this.guides.find((x) => x.id === id); if (g)
            this.renderGuide(g); }
        showSurvey(id) { const s = this.surveys.find((x) => x.id === id); if (s)
            this.renderSurvey(s); }
        // ── Fetching ─────────────────────────────────────────────────────────
        scheduleFetch() {
            const id = window.setTimeout(() => this.fetchAll(), FIRST_FETCH_DELAY_MS);
            this.timers.add(id);
            const refresh = window.setInterval(() => this.fetchAll(), REFRESH_MS);
            this.timers.add(refresh);
        }
        async fetchAll() {
            const headers = { "X-Luniq-Key": this.apiKey, "X-Luniq-Env": this.env };
            const [b, g, s] = await Promise.all([
                this.fetchJSON("/v1/sdk/banners", headers),
                this.fetchJSON("/v1/sdk/guides", headers),
                this.fetchJSON("/v1/sdk/surveys", headers),
            ]);
            this.banners = (b || []).sort((a, b) => (b.priority || 0) - (a.priority || 0));
            this.guides = g || [];
            this.surveys = s || [];
            this.evaluateAll();
        }
        async fetchJSON(path, headers) {
            try {
                const r = await fetch(this.endpoint + path, { headers });
                if (!r.ok)
                    return null;
                return (await r.json());
            }
            catch {
                return null;
            }
        }
        // ── Audience + trigger gating ────────────────────────────────────────
        audienceMatch(a) {
            if (!a)
                return true;
            const path = location.pathname;
            if (a.pages && a.pages.length) {
                const ok = a.pages.some((p) => matchPath(path, p));
                if (!ok)
                    return false;
            }
            if (a.excludePages && a.excludePages.some((p) => matchPath(path, p)))
                return false;
            return true;
        }
        evaluateAll() {
            if (!this.bannerEl) {
                const b = this.banners.find((x) => !this.dismissed.has(x.id) && this.audienceMatch(x.audience) && this.triggerNow(x.trigger));
                if (b)
                    this.armOrRender(b, () => this.renderBanner(b));
            }
            if (!this.guideEl) {
                const g = this.guides.find((x) => !this.dismissed.has(x.id) && this.audienceMatch(x.audience) && this.triggerNow(x.trigger));
                if (g)
                    this.armOrRender(g, () => this.renderGuide(g));
            }
            if (!this.surveyEl) {
                const s = this.surveys.find((x) => !this.dismissed.has(x.id) && this.audienceMatch(x.audience) && this.triggerNow(x.trigger));
                if (s)
                    this.armOrRender(s, () => this.renderSurvey(s));
            }
        }
        triggerNow(t) {
            if (!t || !t.type || t.type === "page-load")
                return true;
            return false;
        }
        armOrRender(item, render) {
            const t = item.trigger;
            if (!t || !t.type || t.type === "page-load") {
                render();
                return;
            }
            if (t.type === "after-seconds") {
                const ms = Math.max(1, (t.delaySeconds || 0)) * 1000;
                const id = window.setTimeout(() => { if (!this.dismissed.has(item.id))
                    render(); }, ms);
                this.timers.add(id);
                return;
            }
            if (t.type === "on-click" && t.selector) {
                const sel = t.selector;
                const handler = (e) => {
                    const target = e.target;
                    if (target && target.closest(sel)) {
                        this.detachArm(handler, "click");
                        if (!this.dismissed.has(item.id))
                            render();
                    }
                };
                this.attachedArms.set(handler, "click");
                document.addEventListener("click", handler, true);
                return;
            }
            if (t.type === "exit-intent") {
                const handler = (e) => {
                    if (e.clientY <= 0) {
                        this.detachArm(handler, "mouseout");
                        if (!this.dismissed.has(item.id))
                            render();
                    }
                };
                this.attachedArms.set(handler, "mouseout");
                document.addEventListener("mouseout", handler);
                return;
            }
        }
        /** Tear down a single armed listener — used both when the trigger
         *  finally fires AND on SPA route changes when we re-evaluate. */
        detachArm(handler, kind) {
            if (kind === "click")
                document.removeEventListener("click", handler, true);
            else
                document.removeEventListener("mouseout", handler);
            this.attachedArms.delete(handler);
        }
        /** Tear down EVERY armed listener — called on route change so a
         *  click trigger configured for /pricing doesn't keep listening on
         *  /platform after navigation. evaluateAll re-arms anything that
         *  still matches the new page's audience. */
        detachAllArms() {
            this.attachedArms.forEach((kind, handler) => this.detachArm(handler, kind));
        }
        // ── Renders ──────────────────────────────────────────────────────────
        renderBanner(b) {
            const wrap = document.createElement("div");
            wrap.className = "luniq-banner";
            wrap.setAttribute("data-luniq-id", b.id);
            const placement = b.placement === "bottom" ? "bottom" : "top";
            wrap.style.cssText = `position:fixed;left:0;right:0;${placement}:0;z-index:2147483640;background:#14110d;color:#fff;padding:12px 18px;display:flex;align-items:center;gap:14px;font:14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:${placement === "top" ? "0 6px 20px -6px rgba(0,0,0,.3)" : "0 -6px 20px -6px rgba(0,0,0,.3)"};animation:luniq-slide-${placement} .28s ease-out both;`;
            if (b.imageUrl) {
                const img = document.createElement("img");
                img.src = b.imageUrl;
                img.alt = "";
                img.style.cssText = "width:36px;height:36px;border-radius:6px;object-fit:cover;flex-shrink:0";
                wrap.appendChild(img);
            }
            const text = document.createElement("div");
            text.style.cssText = "flex:1;line-height:1.4";
            if (b.title) {
                const t = document.createElement("div");
                t.style.cssText = "font-weight:600;margin-bottom:2px";
                t.textContent = b.title;
                text.appendChild(t);
            }
            if (b.body) {
                const bo = document.createElement("div");
                bo.style.cssText = "opacity:.85;font-size:13px";
                bo.textContent = b.body;
                text.appendChild(bo);
            }
            wrap.appendChild(text);
            if (b.ctaLabel && b.linkUrl) {
                const a = document.createElement("a");
                a.href = b.linkUrl;
                a.textContent = b.ctaLabel;
                a.style.cssText = "background:#d79750;color:#14110d;padding:7px 14px;border-radius:999px;font-weight:600;text-decoration:none;font-size:13px";
                a.addEventListener("click", () => this.client.track("$banner_click", { banner_id: b.id, banner_name: b.name }));
                wrap.appendChild(a);
            }
            const close = document.createElement("button");
            close.setAttribute("aria-label", "Dismiss");
            close.style.cssText = "background:transparent;border:none;color:#fff;opacity:.6;font-size:18px;cursor:pointer;padding:4px 8px";
            close.textContent = "×";
            close.addEventListener("click", () => this.dismiss(b.id, this.bannerEl, "banner"));
            wrap.appendChild(close);
            document.body.appendChild(wrap);
            this.bannerEl = wrap;
            this.client.track("$banner_shown", { banner_id: b.id, banner_name: b.name, placement });
        }
        renderGuide(g) {
            const steps = g.steps || [];
            if (steps.length === 0)
                return;
            this.guideState = { guide: g, step: 0 };
            this.client.track("$guide_started", { guide_id: g.id, guide_name: g.name, total_steps: steps.length });
            this.drawGuideStep();
        }
        drawGuideStep() {
            if (!this.guideState)
                return;
            if (this.guideEl) {
                this.guideEl.remove();
                this.guideEl = null;
            }
            const { guide, step } = this.guideState;
            const s = (guide.steps || [])[step];
            if (!s) {
                this.completeGuide();
                return;
            }
            const card = document.createElement("div");
            card.className = "luniq-guide-card";
            card.setAttribute("data-luniq-id", guide.id);
            const isLast = step === (guide.steps || []).length - 1;
            let anchorRect = null;
            if (s.selector) {
                try {
                    const el = document.querySelector(s.selector);
                    if (el) {
                        el.scrollIntoView({ behavior: "smooth", block: "center" });
                        anchorRect = el.getBoundingClientRect();
                    }
                }
                catch { /* invalid selector */ }
            }
            const baseStyle = "position:fixed;z-index:2147483640;background:#fff;color:#14110d;border:1px solid #e3e3e0;border-radius:14px;box-shadow:0 32px 80px -20px rgba(20,17,13,.32);padding:18px 20px;width:min(360px,calc(100vw - 32px));font:14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;animation:luniq-pop .26s cubic-bezier(.22,1,.36,1) both;";
            let positionStyle = "left:50%;top:50%;transform:translate(-50%,-50%);";
            if (anchorRect) {
                const top = Math.min(window.innerHeight - 240, anchorRect.bottom + 12);
                const left = Math.min(Math.max(16, anchorRect.left), window.innerWidth - 380);
                positionStyle = `top:${top}px;left:${left}px;`;
            }
            card.style.cssText = baseStyle + positionStyle;
            if (s.title) {
                const t = document.createElement("div");
                t.style.cssText = "font-weight:600;font-size:15px;margin-bottom:6px";
                t.textContent = s.title;
                card.appendChild(t);
            }
            if (s.body) {
                const b = document.createElement("div");
                b.style.cssText = "opacity:.85;line-height:1.55;font-size:13.5px;margin-bottom:14px";
                b.textContent = s.body;
                card.appendChild(b);
            }
            const dots = document.createElement("div");
            dots.style.cssText = "display:flex;gap:4px;margin-bottom:12px";
            (guide.steps || []).forEach((_, i) => {
                const d = document.createElement("span");
                d.style.cssText = `display:block;width:${i === step ? "18px" : "5px"};height:5px;border-radius:999px;background:${i === step ? "#d79750" : "#ececea"}`;
                dots.appendChild(d);
            });
            card.appendChild(dots);
            const row = document.createElement("div");
            row.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px";
            const skip = document.createElement("button");
            skip.textContent = "Skip";
            skip.style.cssText = "background:transparent;border:none;color:#6f6c66;font-size:12.5px;font-weight:500;cursor:pointer;text-transform:uppercase;letter-spacing:.14em";
            skip.addEventListener("click", () => this.dismissGuide(guide));
            row.appendChild(skip);
            const next = document.createElement("button");
            next.textContent = isLast ? "Got it" : (s.ctaLabel || "Next →");
            next.style.cssText = "background:#14110d;color:#fff;border:1px solid #14110d;padding:7px 14px;border-radius:999px;font-weight:600;font-size:12.5px;cursor:pointer";
            next.addEventListener("click", () => {
                this.client.track("$guide_step_advanced", { guide_id: guide.id, step });
                if (isLast)
                    this.completeGuide();
                else {
                    this.guideState = { guide, step: step + 1 };
                    this.drawGuideStep();
                }
            });
            row.appendChild(next);
            card.appendChild(row);
            document.body.appendChild(card);
            this.guideEl = card;
            this.client.track("$guide_step_shown", { guide_id: guide.id, guide_name: guide.name, step });
        }
        completeGuide() {
            if (!this.guideState)
                return;
            const { guide } = this.guideState;
            this.client.track("$guide_completed", { guide_id: guide.id, guide_name: guide.name });
            if (this.guideEl) {
                this.guideEl.remove();
                this.guideEl = null;
            }
            this.dismissed.add(guide.id);
            this.persistDismissed();
            this.guideState = null;
        }
        dismissGuide(g) {
            this.client.track("$guide_dismissed", { guide_id: g.id, guide_name: g.name, step: this.guideState?.step ?? 0 });
            if (this.guideEl) {
                this.guideEl.remove();
                this.guideEl = null;
            }
            this.dismissed.add(g.id);
            this.persistDismissed();
            this.guideState = null;
        }
        renderSurvey(s) {
            const qs = s.questions || [];
            if (qs.length === 0)
                return;
            const card = document.createElement("div");
            card.setAttribute("data-luniq-id", s.id);
            card.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483640;background:#fff;color:#14110d;border:1px solid #e3e3e0;border-radius:14px;box-shadow:0 32px 80px -20px rgba(20,17,13,.32);padding:16px 18px;width:min(340px,calc(100vw - 32px));font:14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;animation:luniq-pop .26s cubic-bezier(.22,1,.36,1) both;";
            const head = document.createElement("div");
            head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:10px";
            const title = document.createElement("span");
            title.style.cssText = "font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#d79750";
            title.textContent = s.name || "Quick question";
            head.appendChild(title);
            const close = document.createElement("button");
            close.setAttribute("aria-label", "Dismiss");
            close.style.cssText = "background:transparent;border:none;color:#6f6c66;font-size:18px;cursor:pointer;padding:0 4px;line-height:1";
            close.textContent = "×";
            close.addEventListener("click", () => {
                this.client.track("$survey_dismissed", { survey_id: s.id });
                this.dismiss(s.id, card, "survey");
            });
            head.appendChild(close);
            card.appendChild(head);
            const answers = {};
            let qIdx = 0;
            const renderQuestion = () => {
                const old = card.querySelector("[data-luniq-q]");
                if (old)
                    old.remove();
                const q = qs[qIdx];
                if (!q)
                    return;
                const wrap = document.createElement("div");
                wrap.setAttribute("data-luniq-q", "1");
                const prompt = document.createElement("div");
                prompt.textContent = q.prompt;
                prompt.style.cssText = "font-size:14px;line-height:1.45;margin-bottom:12px";
                wrap.appendChild(prompt);
                const submit = (val) => {
                    answers[q.id || `q${qIdx}`] = val;
                    qIdx += 1;
                    if (qIdx >= qs.length) {
                        this.client.track("$survey_completed", { survey_id: s.id, survey_name: s.name, answers });
                        // Replace the card content with a simple thank-you (textContent
                        // path; no innerHTML to keep the SDK XSS-safe).
                        while (card.firstChild)
                            card.removeChild(card.firstChild);
                        const thanks = document.createElement("div");
                        thanks.textContent = "Thanks — we've got it.";
                        thanks.style.cssText = "font-size:13.5px;line-height:1.55;color:#3a3733;text-align:center;padding:14px 6px";
                        card.appendChild(thanks);
                        window.setTimeout(() => this.dismiss(s.id, card, "survey"), 1500);
                        return;
                    }
                    renderQuestion();
                };
                if (q.type === "rating" || (!q.type && q.scale)) {
                    const scale = Math.max(2, Math.min(11, q.scale || 5));
                    const row = document.createElement("div");
                    row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
                    for (let i = 1; i <= scale; i++) {
                        const b = document.createElement("button");
                        b.textContent = String(i);
                        b.style.cssText = "background:#fff;border:1px solid #e3e3e0;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:13px;color:#14110d;font-weight:500;flex:1;min-width:32px";
                        b.addEventListener("click", () => submit(i));
                        row.appendChild(b);
                    }
                    wrap.appendChild(row);
                }
                else if (q.type === "single" || q.type === "multi") {
                    const choices = q.choices || [];
                    if (q.type === "multi") {
                        const picked = new Set();
                        choices.forEach((c) => {
                            const b = document.createElement("button");
                            b.textContent = c;
                            b.style.cssText = "display:block;width:100%;text-align:left;background:#fff;border:1px solid #e3e3e0;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:13px;color:#14110d;margin-bottom:6px";
                            b.addEventListener("click", () => {
                                if (picked.has(c)) {
                                    picked.delete(c);
                                    b.style.background = "#fff";
                                    b.style.color = "#14110d";
                                    b.style.borderColor = "#e3e3e0";
                                }
                                else {
                                    picked.add(c);
                                    b.style.background = "#14110d";
                                    b.style.color = "#fff";
                                }
                            });
                            wrap.appendChild(b);
                        });
                        const submitBtn = document.createElement("button");
                        submitBtn.textContent = "Submit";
                        submitBtn.style.cssText = "margin-top:8px;background:#14110d;color:#fff;border:1px solid #14110d;padding:7px 14px;border-radius:999px;font-weight:600;font-size:12.5px;cursor:pointer;width:100%";
                        submitBtn.addEventListener("click", () => submit(Array.from(picked)));
                        wrap.appendChild(submitBtn);
                    }
                    else {
                        choices.forEach((c) => {
                            const b = document.createElement("button");
                            b.textContent = c;
                            b.style.cssText = "display:block;width:100%;text-align:left;background:#fff;border:1px solid #e3e3e0;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:13px;color:#14110d;margin-bottom:6px";
                            b.addEventListener("click", () => submit(c));
                            wrap.appendChild(b);
                        });
                    }
                }
                else {
                    const ta = document.createElement("textarea");
                    ta.style.cssText = "width:100%;min-height:60px;padding:8px 10px;border:1px solid #e3e3e0;border-radius:8px;font:inherit;color:#14110d;background:#fff;resize:vertical;box-sizing:border-box";
                    ta.placeholder = "Type your answer…";
                    wrap.appendChild(ta);
                    const submitBtn = document.createElement("button");
                    submitBtn.textContent = "Send";
                    submitBtn.style.cssText = "margin-top:8px;background:#14110d;color:#fff;border:1px solid #14110d;padding:7px 14px;border-radius:999px;font-weight:600;font-size:12.5px;cursor:pointer;width:100%";
                    submitBtn.addEventListener("click", () => submit(ta.value.trim()));
                    wrap.appendChild(submitBtn);
                }
                card.appendChild(wrap);
            };
            renderQuestion();
            document.body.appendChild(card);
            this.surveyEl = card;
            this.client.track("$survey_shown", { survey_id: s.id, survey_name: s.name });
        }
        // ── Dismiss + persistence ────────────────────────────────────────────
        dismiss(id, el, kind) {
            if (el)
                el.remove();
            if (kind === "banner")
                this.bannerEl = null;
            if (kind === "survey")
                this.surveyEl = null;
            this.dismissed.add(id);
            this.persistDismissed();
            this.client.track(`$${kind}_dismissed`, { [`${kind}_id`]: id });
        }
        loadDismissed() {
            try {
                const raw = localStorage.getItem(DISMISSED_KEY);
                if (!raw)
                    return;
                const arr = JSON.parse(raw);
                if (Array.isArray(arr))
                    arr.forEach((x) => this.dismissed.add(x));
            }
            catch { /* private mode */ }
        }
        persistDismissed() {
            try {
                localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(this.dismissed)));
            }
            catch { /* noop */ }
        }
        injectStyles() {
            if (document.getElementById("luniq-engage-styles"))
                return;
            const s = document.createElement("style");
            s.id = "luniq-engage-styles";
            s.textContent =
                "@keyframes luniq-slide-top { from { transform: translateY(-100%); } to { transform: translateY(0); } }\n" +
                    "@keyframes luniq-slide-bottom { from { transform: translateY(100%); } to { transform: translateY(0); } }\n" +
                    "@keyframes luniq-pop { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }\n" +
                    ".luniq-guide-card[data-luniq-id], [data-luniq-id] { box-sizing: border-box; }";
            document.head.appendChild(s);
        }
    }
    function matchPath(path, pattern) {
        if (!pattern)
            return true;
        if (pattern === "*" || pattern === "/*")
            return true;
        if (pattern.endsWith("/*"))
            return path.startsWith(pattern.slice(0, -1));
        return path === pattern || path.startsWith(pattern.endsWith("/") ? pattern : pattern + "/");
    }
    const _engage = new EngageRuntime();

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
            // In-app engagement: fetch + render guides/banners/surveys defined
            // in the dashboard. Targeting happens inside the runtime; impressions
            // and dismissals stream back through the existing track() pipeline,
            // so the dashboard counts every render automatically.
            _engage.start(this, this.cfg.endpoint, this.cfg.apiKey, this.cfg.environment || "PRD");
        }
        /** Manually surface a banner / guide / survey by id. Useful for
         *  context-specific moments your code already knows about (e.g. fire
         *  the upgrade survey after a successful checkout). */
        showBanner(id) { _engage.showBanner(id); }
        showGuide(id) { _engage.showGuide(id); }
        showSurvey(id) { _engage.showSurvey(id); }
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
            // SPA route change — both auto-tracks the screen view and notifies
            // the engagement runtime so it re-evaluates audience targeting for
            // the new path.
            const origPush = history.pushState;
            const origReplace = history.replaceState;
            const onRoute = () => {
                this.screen(document.title || location.pathname);
                window.dispatchEvent(new Event("luniq:route-change"));
            };
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
