import { _designMode } from "./design-mode";

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

  start(cfg: Config) {
    this.cfg = { autoCapture: true, batchSize: 50, flushIntervalMs: 30000, environment: "PRD", ...cfg };
    this.visitorId = localStorage.getItem("hp_visitor");
    this.accountId = localStorage.getItem("hp_account");
    try { this.traits = JSON.parse(localStorage.getItem("hp_traits") || "{}"); } catch {}
    try { this.queue = JSON.parse(localStorage.getItem("hp_queue") || "[]"); } catch {}

    this.flushTimer = setInterval(() => this.flush(), this.cfg.flushIntervalMs);
    window.addEventListener("visibilitychange", () => this.flush());
    window.addEventListener("beforeunload", () => this.flush(true));

    if (this.cfg.autoCapture) this.installAutoCapture();
    this.screen(document.title || location.pathname);

    // Design Mode: auto-pair if URL has ?luniq_design=CODE
    _designMode.configure(this.cfg.endpoint, this.cfg.apiKey);
    _designMode.maybeAutoPair();
  }

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
  }

  screen(name: string, properties: Props = {}) {
    this.track("$screen", { ...properties, screen_name: name });
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
    const batch = this.queue.splice(0, this.cfg.batchSize || 50);
    this.persist();
    const body = JSON.stringify({ events: batch });
    const url = `${this.cfg.endpoint}/v1/events`;
    const headers = { "Content-Type": "application/json", "X-Luniq-Key": this.cfg.apiKey };
    try {
      if (sync && "sendBeacon" in navigator) {
        navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      } else {
        const r = await fetch(url, { method: "POST", headers, body, keepalive: true });
        if (!r.ok) throw new Error("send failed");
      }
    } catch {
      this.queue.unshift(...batch);
      this.persist();
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

    // SPA route change
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    const onRoute = () => this.screen(document.title || location.pathname);
    history.pushState = function (...args) { const r = origPush.apply(this, args as any); onRoute(); return r; };
    history.replaceState = function (...args) { const r = origReplace.apply(this, args as any); onRoute(); return r; };
    window.addEventListener("popstate", onRoute);
  }
}

export const Luniq = new LuniqClient();

// UMD-style global for <script> include
if (typeof window !== "undefined") (window as any).Luniq = Luniq;
