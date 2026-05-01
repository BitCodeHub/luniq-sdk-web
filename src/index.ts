import { _designMode } from "./design-mode";
import { _engage } from "./engage";
import { TestRunner } from "./test-runner";

type Props = Record<string, any>;

// ── Auto-capture helpers ─────────────────────────────────────────────────────
// User-agent parsing: minimal regex-based classifier. Real ua-parser-js is
// 30 KB; this catches the 95% case in <1 KB. Returns { browser, version,
// deviceType } for breakdowns. Server-side ingest treats them as columns.
function parseUserAgent(ua: string): { browser: string; version: string; deviceType: string } {
  const lower = ua.toLowerCase();
  const isTablet = /ipad|tablet|playbook|silk|kindle/.test(lower) || (/android/.test(lower) && !/mobile/.test(lower));
  const isMobile = /mobi|iphone|ipod|blackberry|opera mini|opera mobi|webos/.test(lower) && !isTablet;
  const deviceType = isTablet ? "tablet" : isMobile ? "mobile" : "desktop";
  const tests: [string, RegExp][] = [
    ["Edge",    /edg\/(\d+(?:\.\d+)?)/],
    ["Opera",   /opr\/(\d+(?:\.\d+)?)/],
    ["Chrome",  /chrome\/(\d+(?:\.\d+)?)/],
    ["Firefox", /firefox\/(\d+(?:\.\d+)?)/],
    ["Safari",  /version\/(\d+(?:\.\d+)?).*safari/],
    ["Safari",  /safari\/(\d+(?:\.\d+)?)/],
  ];
  for (const [name, re] of tests) {
    const m = lower.match(re);
    if (m) return { browser: name, version: m[1], deviceType };
  }
  return { browser: "Other", version: "", deviceType };
}

// Acquisition: UTM params from the landing URL, plus referrer host. Sticky
// per browser session via sessionStorage so post-landing events keep the
// original campaign — matches GA4's behavior. URL params win over a previous
// session value (last-touch). Cleared automatically when the tab closes.
const ACQUISITION_KEY = "luniq_acq";
function readAcquisition(): {
  utm_source: string; utm_medium: string; utm_campaign: string;
  utm_term: string; utm_content: string; referrer_domain: string;
} {
  const empty = { utm_source: "", utm_medium: "", utm_campaign: "", utm_term: "", utm_content: "", referrer_domain: "" };
  try {
    const url = new URL(location.href);
    const fromUrl = {
      utm_source:   url.searchParams.get("utm_source")   || "",
      utm_medium:   url.searchParams.get("utm_medium")   || "",
      utm_campaign: url.searchParams.get("utm_campaign") || "",
      utm_term:     url.searchParams.get("utm_term")     || "",
      utm_content:  url.searchParams.get("utm_content")  || "",
      referrer_domain: refDomain(document.referrer),
    };
    const hasUrlSignal = !!(fromUrl.utm_source || fromUrl.utm_medium || fromUrl.utm_campaign);
    if (hasUrlSignal) {
      sessionStorage.setItem(ACQUISITION_KEY, JSON.stringify(fromUrl));
      return fromUrl;
    }
    const cached = sessionStorage.getItem(ACQUISITION_KEY);
    if (cached) {
      try { return { ...empty, ...JSON.parse(cached) }; } catch {}
    }
    // No UTM signal at all — fall back to just the referrer domain.
    return { ...empty, referrer_domain: fromUrl.referrer_domain };
  } catch {
    return empty;
  }
}
function refDomain(ref: string): string {
  if (!ref) return "";
  try {
    const u = new URL(ref);
    if (u.hostname === location.hostname) return ""; // internal nav, not a real referrer
    return u.hostname;
  } catch { return ""; }
}

interface Config {
  apiKey: string;
  endpoint: string;
  environment?: string;
  autoCapture?: boolean;
  batchSize?: number;
  flushIntervalMs?: number;
}

interface PulseEvent {
  id: string;
  name: string;
  properties: Props;
  timestamp: string;
  sessionId: string;
  visitorId: string | null;
  accountId: string | null;
}

const uuid = () =>
  ([1e7] as any + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c: any) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  );

class LuniqClient {
  private cfg!: Config;
  private queue: PulseEvent[] = [];
  private visitorId: string | null = null;
  private accountId: string | null = null;
  private traits: Props = {};
  private sessionId: string = uuid();
  private lastActivity = Date.now();
  private sessionTimeoutMs = 30 * 60 * 1000;
  private flushTimer: any;

  // ── resilience state ────────────────────────────────────────────
  // Circuit breaker: after consecutive failures we back off exponentially
  // (1s, 2s, 4s, … capped at 5 min) so a backend outage doesn't have every
  // customer hammering us in lockstep when we recover.
  private consecFailures = 0;
  private retryAfter = 0; // epoch ms; flush() returns early before this time
  // Remote kill switch: SDK polls /v1/sdk/config and respects { enabled, sample }.
  // Cached for 5 min in localStorage so a config-endpoint outage can't silence
  // working SDKs.
  private remoteEnabled = true;
  private remoteSample = 1.0;
  // Error reporting: count failures and beacon at most once per hour so we
  // see customer-side breakage without flooding our own ingest.
  private errorWindowStart = 0;
  private errorWindowCount = 0;
  private lastErrorBeacon = 0;

  start(cfg: Config) {
    this.cfg = { autoCapture: true, batchSize: 50, flushIntervalMs: 30000, environment: "PRD", ...cfg };
    this.visitorId = localStorage.getItem("hp_visitor");
    this.accountId = localStorage.getItem("hp_account");
    try { this.traits = JSON.parse(localStorage.getItem("hp_traits") || "{}"); } catch {}
    try { this.queue = JSON.parse(localStorage.getItem("hp_queue") || "[]"); } catch {}

    this.flushTimer = setInterval(() => this.flush(), this.cfg.flushIntervalMs);
    window.addEventListener("visibilitychange", () => this.flush());
    window.addEventListener("beforeunload", () => this.flush(true));

    this.loadRemoteConfig();
    this.refreshRemoteConfig();

    if (this.cfg.autoCapture) this.installAutoCapture();
    this.screen(document.title || location.pathname);
    this.installAnchorScanner();

    // Test mode: only activates if the API key is in the test prefix.
    // Production keys (lq_live_*) never enter the runner.
    if (TestRunner.isTestKey(this.cfg.apiKey)) {
      try {
        new TestRunner(this.cfg.endpoint, this.cfg.apiKey).start();
      } catch { /* never break customer pages on runner failure */ }
    }

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
  showBanner(id: string) { _engage.showBanner(id); }
  showGuide(id: string)  { _engage.showGuide(id); }
  showSurvey(id: string) { _engage.showSurvey(id); }

  /** Manually enter design mode with a 6-char pairing code from the dashboard. */
  enableDesignMode(code: string) {
    _designMode.configure(this.cfg.endpoint, this.cfg.apiKey);
    _designMode.pair(code);
  }

  identify(visitorId: string, accountId?: string, traits?: Props) {
    this.visitorId = visitorId;
    this.accountId = accountId ?? null;
    this.traits = { ...this.traits, ...(traits || {}) };
    localStorage.setItem("hp_visitor", visitorId);
    if (accountId) localStorage.setItem("hp_account", accountId);
    localStorage.setItem("hp_traits", JSON.stringify(this.traits));
  }

  track(name: string, properties: Props = {}) {
    try {
      // Honor the remote kill switch + sampling. A flipped `enabled=false`
      // makes track() a no-op in production within ~5 min — no app update
      // needed. Sampling drops a fraction of events at the source so a
      // misbehaving customer can be dialed down without code changes.
      if (!this.remoteEnabled) return;
      if (this.remoteSample < 1 && Math.random() >= this.remoteSample) return;

      if (Date.now() - this.lastActivity > this.sessionTimeoutMs) this.sessionId = uuid();
      this.lastActivity = Date.now();
      const ev: PulseEvent = {
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
      if (this.queue.length >= (this.cfg.batchSize || 50)) this.flush();
    } catch { /* never throw into customer code */ }
  }

  screen(name: string, properties: Props = {}) {
    this.track("$screen", { ...properties, screen_name: name });
    // SPA route change → re-detect anchors on the new view.
    this.seenAnchors.clear();
  }

  optOut(on: boolean) { localStorage.setItem("hp_opt_out", on ? "1" : "0"); }

  async submitFeedback(kind: "idea" | "bug" | "kudos" | "other", message: string) {
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

  private enrich(p: Props): Props {
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
      utm_source:   acq.utm_source,
      utm_medium:   acq.utm_medium,
      utm_campaign: acq.utm_campaign,
      utm_term:     acq.utm_term,
      utm_content:  acq.utm_content,
      referrer_domain: acq.referrer_domain,
      ...this.traits,
    };
  }

  private persist() {
    localStorage.setItem("hp_queue", JSON.stringify(this.queue.slice(-5000)));
  }

  async flush(sync = false) {
    if (localStorage.getItem("hp_opt_out") === "1") return;
    if (this.queue.length === 0) return;
    // Circuit breaker — if we're inside a backoff window, skip. The unload
    // path (sync=true) is exempt: best-effort sendBeacon never blocks unload
    // and we'd rather try to deliver than drop on close.
    if (!sync && Date.now() < this.retryAfter) return;

    const batch = this.queue.splice(0, this.cfg.batchSize || 50);
    this.persist();
    const body = JSON.stringify({ events: batch });
    const url = `${this.cfg.endpoint}/v1/events`;
    const headers = { "Content-Type": "application/json", "X-Luniq-Key": this.cfg.apiKey };

    let ok = false;
    let errCode = "fetch_error";
    try {
      if (sync && "sendBeacon" in navigator) {
        ok = navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      } else {
        // 5-second timeout on the network call. Without this, a hung TCP
        // connection (rare but real — origin behind a misbehaving LB) ties
        // up a fetch slot on every customer page load.
        const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), 5000) : 0;
        try {
          const r = await fetch(url, { method: "POST", headers, body, keepalive: true, signal: ctrl?.signal });
          if (!r.ok) {
            errCode = `http_${r.status}`;
            throw new Error("send failed");
          }
          ok = true;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    } catch (e: any) {
      if (e && e.name === "AbortError") errCode = "timeout";
    }

    if (ok) {
      this.consecFailures = 0;
      this.retryAfter = 0;
      return;
    }

    // Failure path — re-queue at the front so events keep their order, then
    // open the circuit for an exponentially growing window.
    this.queue.unshift(...batch);
    this.persist();
    this.consecFailures += 1;
    const backoffMs = Math.min(300_000, 1000 * Math.pow(2, Math.min(this.consecFailures - 1, 8)));
    this.retryAfter = Date.now() + backoffMs;
    this.recordSdkError(errCode, "ingest failure");
  }

  private recordSdkError(code: string, message: string) {
    // Count failures, but only beacon home at most once per hour. Crucially,
    // this beacon must not itself fail loudly — wrap the whole thing in a
    // try/catch and never throw into customer code.
    try {
      const now = Date.now();
      if (now - this.errorWindowStart > 3600_000) {
        this.errorWindowStart = now;
        this.errorWindowCount = 0;
      }
      this.errorWindowCount += 1;

      if (now - this.lastErrorBeacon < 3600_000) return;
      this.lastErrorBeacon = now;
      const url = `${this.cfg.endpoint}/v1/sdk/error`;
      const body = JSON.stringify({
        sdk: "web",
        version: "1.3.0",
        code,
        message,
        count: this.errorWindowCount,
      });
      // Use sendBeacon if available — it survives navigation and is fire-
      // and-forget. Falls back to fetch with a short timeout.
      if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
        try {
          navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
          return;
        } catch { /* fall through to fetch */ }
      }
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 3000) : 0;
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Luniq-Key": this.cfg.apiKey },
        body,
        keepalive: true,
        signal: ctrl?.signal,
      }).catch(() => { /* swallow — error reporter must never error loudly */ })
        .finally(() => { if (timer) clearTimeout(timer); });
    } catch { /* swallow */ }
  }

  private loadRemoteConfig() {
    try {
      const raw = localStorage.getItem("hp_sdk_cfg");
      if (!raw) return;
      const cfg = JSON.parse(raw);
      if (typeof cfg.enabled === "boolean") this.remoteEnabled = cfg.enabled;
      if (typeof cfg.sample === "number") this.remoteSample = Math.max(0, Math.min(1, cfg.sample));
    } catch { /* ignore — defaults stay */ }
  }

  private async refreshRemoteConfig() {
    try {
      const url = `${this.cfg.endpoint}/v1/sdk/config?key=${encodeURIComponent(this.cfg.apiKey)}`;
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 4000) : 0;
      try {
        const r = await fetch(url, { method: "GET", signal: ctrl?.signal });
        if (!r.ok) return;
        const cfg = await r.json();
        if (typeof cfg.enabled === "boolean") this.remoteEnabled = cfg.enabled;
        if (typeof cfg.sample === "number") this.remoteSample = Math.max(0, Math.min(1, cfg.sample));
        try {
          localStorage.setItem("hp_sdk_cfg", JSON.stringify({
            enabled: this.remoteEnabled, sample: this.remoteSample,
          }));
        } catch { /* private mode */ }
        const pollSecs = Math.max(60, Math.min(3600, Number(cfg.pollSecs) || 300));
        setTimeout(() => this.refreshRemoteConfig(), pollSecs * 1000);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch {
      // Network error — stick with current values, retry in 10 min.
      setTimeout(() => this.refreshRemoteConfig(), 600_000);
    }
  }

  // Track which anchors we've already reported this page-view so we only
  // fire one $luniq_anchor_seen per (anchor id) per page. Reset on screen()
  // calls (single-page-app navigations) so SPA route changes get a fresh
  // scan when the new view's elements appear.
  private seenAnchors: Set<string> = new Set();

  private installAnchorScanner() {
    // Scan now + on every DOM mutation (debounced) so dynamically-rendered
    // elements are picked up. Anchor convention: any element with a
    // data-luniq-anchor attribute (preferred) or class luniq-anchor.
    const scan = () => {
      try {
        const els = document.querySelectorAll<HTMLElement>("[data-luniq-anchor]");
        els.forEach(el => {
          const id = el.getAttribute("data-luniq-anchor") || "";
          if (!id || this.seenAnchors.has(id)) return;
          this.seenAnchors.add(id);
          this.track("$luniq_anchor_seen", {
            anchor: id,
            screen: location.pathname,
          });
        });
      } catch { /* ignore selector errors */ }
    };
    scan();
    if (typeof MutationObserver !== "undefined") {
      let pending = 0;
      const obs = new MutationObserver(() => {
        if (pending) return;
        pending = window.setTimeout(() => { pending = 0; scan(); }, 500);
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  private installAutoCapture() {
    // Click tracking
    document.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (!t) return;
      const tag = t.tagName.toLowerCase();
      const props: Props = {
        tag,
        text: (t.innerText || t.textContent || "").slice(0, 80).trim(),
        id: t.id || "",
        classes: t.className || "",
        href: (t as HTMLAnchorElement).href || "",
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
    history.pushState = function (...args) { const r = origPush.apply(this, args as any); onRoute(); return r; };
    history.replaceState = function (...args) { const r = origReplace.apply(this, args as any); onRoute(); return r; };
    window.addEventListener("popstate", onRoute);
  }
}

export const Luniq = new LuniqClient();

// UMD-style global for <script> include
if (typeof window !== "undefined") (window as any).Luniq = Luniq;
