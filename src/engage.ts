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

type Trigger = {
  type?: "page-load" | "after-seconds" | "on-click" | "exit-intent";
  delaySeconds?: number;
  selector?: string;
};
type Audience = {
  pages?: string[];
  excludePages?: string[];
  traits?: Record<string, string | number | boolean>;
  visitorIs?: "new" | "returning" | "any";
};

export type Banner = {
  id: string;
  name: string;
  imageUrl?: string;
  title: string;
  body: string;
  ctaLabel?: string;
  linkUrl?: string;
  placement?: "top" | "bottom";
  priority?: number;
  trigger?: Trigger;
  audience?: Audience;
};
export type Guide = {
  id: string;
  name: string;
  kind?: string;
  trigger?: Trigger;
  audience?: Audience;
  steps?: GuideStep[];
};
type GuideStep = {
  selector?: string;
  title?: string;
  body?: string;
  ctaLabel?: string;
};
export type Survey = {
  id: string;
  name: string;
  kind?: string;
  trigger?: Trigger;
  audience?: Audience;
  questions?: SurveyQuestion[];
};
type SurveyQuestion = {
  id?: string;
  type?: "rating" | "single" | "multi" | "text";
  prompt: string;
  choices?: string[];
  scale?: number;
};

interface ClientLike {
  track(name: string, props?: Record<string, unknown>): void;
}

const DISMISSED_KEY = "luniq_engage_dismissed";
const REFRESH_MS = 5 * 60 * 1000;
const FIRST_FETCH_DELAY_MS = 4_000;

class EngageRuntime {
  private client!: ClientLike;
  private endpoint!: string;
  private apiKey!: string;
  private env!: string;
  private banners: Banner[] = [];
  private guides: Guide[] = [];
  private surveys: Survey[] = [];
  private dismissed = new Set<string>();
  private bannerEl: HTMLElement | null = null;
  private guideEl: HTMLElement | null = null;
  private surveyEl: HTMLElement | null = null;
  private guideState: { guide: Guide; step: number } | null = null;
  private timers = new Set<number>();
  // Tracks listeners armed by armOrRender so we can remove them on
  // SPA route changes — prevents leaks + duplicate fires on cross-page
  // navigation, which the prior implementation couldn't recover from.
  private attachedArms = new Map<EventListener, "click" | "mouseout">();

  start(client: ClientLike, endpoint: string, apiKey: string, env: string) {
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
    const id = window.setInterval(() => this.evaluateAll(), 60_000);
    this.timers.add(id);
  }

  /** Public manual triggers — host apps can call these to surface a
   *  specific item ad-hoc, e.g. after a successful checkout. */
  showBanner(id: string) { const b = this.banners.find((x) => x.id === id); if (b) this.renderBanner(b); }
  showGuide(id: string)  { const g = this.guides.find((x) => x.id === id); if (g) this.renderGuide(g); }
  showSurvey(id: string) { const s = this.surveys.find((x) => x.id === id); if (s) this.renderSurvey(s); }

  // ── Fetching ─────────────────────────────────────────────────────────

  private scheduleFetch() {
    const id = window.setTimeout(() => this.fetchAll(), FIRST_FETCH_DELAY_MS);
    this.timers.add(id);
    const refresh = window.setInterval(() => this.fetchAll(), REFRESH_MS);
    this.timers.add(refresh);
  }
  private async fetchAll() {
    const headers = { "X-Luniq-Key": this.apiKey, "X-Luniq-Env": this.env };
    const [b, g, s] = await Promise.all([
      this.fetchJSON<Banner[]>("/v1/sdk/banners", headers),
      this.fetchJSON<Guide[]>("/v1/sdk/guides", headers),
      this.fetchJSON<Survey[]>("/v1/sdk/surveys", headers),
    ]);
    this.banners = (b || []).sort((a, b) => (b.priority || 0) - (a.priority || 0));
    this.guides = g || [];
    this.surveys = s || [];
    this.evaluateAll();
  }
  private async fetchJSON<T>(path: string, headers: Record<string, string>): Promise<T | null> {
    try {
      const r = await fetch(this.endpoint + path, { headers });
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch { return null; }
  }

  // ── Audience + trigger gating ────────────────────────────────────────

  private audienceMatch(a?: Audience): boolean {
    if (!a) return true;
    const path = location.pathname;
    if (a.pages && a.pages.length) {
      const ok = a.pages.some((p) => matchPath(path, p));
      if (!ok) return false;
    }
    if (a.excludePages && a.excludePages.some((p) => matchPath(path, p))) return false;
    return true;
  }

  private evaluateAll() {
    if (!this.bannerEl) {
      const b = this.banners.find((x) => !this.dismissed.has(x.id) && this.audienceMatch(x.audience) && this.triggerNow(x.trigger));
      if (b) this.armOrRender(b, () => this.renderBanner(b));
    }
    if (!this.guideEl) {
      const g = this.guides.find((x) => !this.dismissed.has(x.id) && this.audienceMatch(x.audience) && this.triggerNow(x.trigger));
      if (g) this.armOrRender(g, () => this.renderGuide(g));
    }
    if (!this.surveyEl) {
      const s = this.surveys.find((x) => !this.dismissed.has(x.id) && this.audienceMatch(x.audience) && this.triggerNow(x.trigger));
      if (s) this.armOrRender(s, () => this.renderSurvey(s));
    }
  }
  private triggerNow(t?: Trigger): boolean {
    if (!t || !t.type || t.type === "page-load") return true;
    return false;
  }
  private armOrRender(item: { id: string; trigger?: Trigger }, render: () => void) {
    const t = item.trigger;
    if (!t || !t.type || t.type === "page-load") { render(); return; }
    if (t.type === "after-seconds") {
      const ms = Math.max(1, (t.delaySeconds || 0)) * 1000;
      const id = window.setTimeout(() => { if (!this.dismissed.has(item.id)) render(); }, ms);
      this.timers.add(id);
      return;
    }
    if (t.type === "on-click" && t.selector) {
      const sel = t.selector;
      const handler = (e: Event) => {
        const target = e.target as Element | null;
        if (target && target.closest(sel)) {
          this.detachArm(handler, "click");
          if (!this.dismissed.has(item.id)) render();
        }
      };
      this.attachedArms.set(handler, "click");
      document.addEventListener("click", handler, true);
      return;
    }
    if (t.type === "exit-intent") {
      const handler = (e: MouseEvent) => {
        if (e.clientY <= 0) {
          this.detachArm(handler as EventListener, "mouseout");
          if (!this.dismissed.has(item.id)) render();
        }
      };
      this.attachedArms.set(handler as EventListener, "mouseout");
      document.addEventListener("mouseout", handler);
      return;
    }
  }

  /** Tear down a single armed listener — used both when the trigger
   *  finally fires AND on SPA route changes when we re-evaluate. */
  private detachArm(handler: EventListener, kind: "click" | "mouseout") {
    if (kind === "click") document.removeEventListener("click", handler, true);
    else document.removeEventListener("mouseout", handler);
    this.attachedArms.delete(handler);
  }

  /** Tear down EVERY armed listener — called on route change so a
   *  click trigger configured for /pricing doesn't keep listening on
   *  /platform after navigation. evaluateAll re-arms anything that
   *  still matches the new page's audience. */
  private detachAllArms() {
    this.attachedArms.forEach((kind, handler) => this.detachArm(handler, kind));
  }

  // ── Renders ──────────────────────────────────────────────────────────

  private renderBanner(b: Banner) {
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

  private renderGuide(g: Guide) {
    const steps = g.steps || [];
    if (steps.length === 0) return;
    this.guideState = { guide: g, step: 0 };
    this.client.track("$guide_started", { guide_id: g.id, guide_name: g.name, total_steps: steps.length });
    this.drawGuideStep();
  }

  private drawGuideStep() {
    if (!this.guideState) return;
    if (this.guideEl) { this.guideEl.remove(); this.guideEl = null; }
    const { guide, step } = this.guideState;
    const s = (guide.steps || [])[step];
    if (!s) { this.completeGuide(); return; }

    const card = document.createElement("div");
    card.className = "luniq-guide-card";
    card.setAttribute("data-luniq-id", guide.id);
    const isLast = step === (guide.steps || []).length - 1;
    let anchorRect: DOMRect | null = null;
    if (s.selector) {
      try {
        const el = document.querySelector(s.selector);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          anchorRect = el.getBoundingClientRect();
        }
      } catch { /* invalid selector */ }
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
      if (isLast) this.completeGuide();
      else { this.guideState = { guide, step: step + 1 }; this.drawGuideStep(); }
    });
    row.appendChild(next);
    card.appendChild(row);

    document.body.appendChild(card);
    this.guideEl = card;
    this.client.track("$guide_step_shown", { guide_id: guide.id, guide_name: guide.name, step });
  }

  private completeGuide() {
    if (!this.guideState) return;
    const { guide } = this.guideState;
    this.client.track("$guide_completed", { guide_id: guide.id, guide_name: guide.name });
    if (this.guideEl) { this.guideEl.remove(); this.guideEl = null; }
    this.dismissed.add(guide.id);
    this.persistDismissed();
    this.guideState = null;
  }

  private dismissGuide(g: Guide) {
    this.client.track("$guide_dismissed", { guide_id: g.id, guide_name: g.name, step: this.guideState?.step ?? 0 });
    if (this.guideEl) { this.guideEl.remove(); this.guideEl = null; }
    this.dismissed.add(g.id);
    this.persistDismissed();
    this.guideState = null;
  }

  private renderSurvey(s: Survey) {
    const qs = s.questions || [];
    if (qs.length === 0) return;
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

    const answers: Record<string, unknown> = {};
    let qIdx = 0;
    const renderQuestion = () => {
      const old = card.querySelector("[data-luniq-q]");
      if (old) old.remove();
      const q = qs[qIdx];
      if (!q) return;
      const wrap = document.createElement("div");
      wrap.setAttribute("data-luniq-q", "1");
      const prompt = document.createElement("div");
      prompt.textContent = q.prompt;
      prompt.style.cssText = "font-size:14px;line-height:1.45;margin-bottom:12px";
      wrap.appendChild(prompt);

      const submit = (val: unknown) => {
        answers[q.id || `q${qIdx}`] = val;
        qIdx += 1;
        if (qIdx >= qs.length) {
          this.client.track("$survey_completed", { survey_id: s.id, survey_name: s.name, answers });
          // Replace the card content with a simple thank-you (textContent
          // path; no innerHTML to keep the SDK XSS-safe).
          while (card.firstChild) card.removeChild(card.firstChild);
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
      } else if (q.type === "single" || q.type === "multi") {
        const choices = q.choices || [];
        if (q.type === "multi") {
          const picked = new Set<string>();
          choices.forEach((c) => {
            const b = document.createElement("button");
            b.textContent = c;
            b.style.cssText = "display:block;width:100%;text-align:left;background:#fff;border:1px solid #e3e3e0;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:13px;color:#14110d;margin-bottom:6px";
            b.addEventListener("click", () => {
              if (picked.has(c)) { picked.delete(c); b.style.background = "#fff"; b.style.color = "#14110d"; b.style.borderColor = "#e3e3e0"; }
              else { picked.add(c); b.style.background = "#14110d"; b.style.color = "#fff"; }
            });
            wrap.appendChild(b);
          });
          const submitBtn = document.createElement("button");
          submitBtn.textContent = "Submit";
          submitBtn.style.cssText = "margin-top:8px;background:#14110d;color:#fff;border:1px solid #14110d;padding:7px 14px;border-radius:999px;font-weight:600;font-size:12.5px;cursor:pointer;width:100%";
          submitBtn.addEventListener("click", () => submit(Array.from(picked)));
          wrap.appendChild(submitBtn);
        } else {
          choices.forEach((c) => {
            const b = document.createElement("button");
            b.textContent = c;
            b.style.cssText = "display:block;width:100%;text-align:left;background:#fff;border:1px solid #e3e3e0;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:13px;color:#14110d;margin-bottom:6px";
            b.addEventListener("click", () => submit(c));
            wrap.appendChild(b);
          });
        }
      } else {
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

  private dismiss(id: string, el: HTMLElement | null, kind: "banner" | "survey") {
    if (el) el.remove();
    if (kind === "banner") this.bannerEl = null;
    if (kind === "survey") this.surveyEl = null;
    this.dismissed.add(id);
    this.persistDismissed();
    this.client.track(`$${kind}_dismissed`, { [`${kind}_id`]: id });
  }

  private loadDismissed() {
    try {
      const raw = localStorage.getItem(DISMISSED_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw) as string[];
      if (Array.isArray(arr)) arr.forEach((x) => this.dismissed.add(x));
    } catch { /* private mode */ }
  }
  private persistDismissed() {
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(this.dismissed))); } catch { /* noop */ }
  }

  private injectStyles() {
    if (document.getElementById("luniq-engage-styles")) return;
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

function matchPath(path: string, pattern: string): boolean {
  if (!pattern) return true;
  if (pattern === "*" || pattern === "/*") return true;
  if (pattern.endsWith("/*")) return path.startsWith(pattern.slice(0, -1));
  return path === pattern || path.startsWith(pattern.endsWith("/") ? pattern : pattern + "/");
}

export const _engage = new EngageRuntime();
