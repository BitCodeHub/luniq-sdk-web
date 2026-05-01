// Web SDK test-runner module.
// Activates only when the API key is in the test-mode prefix (lq_test_*).
// Long-polls the backend for queued runs, executes each step against the live
// DOM, and reports per-step + final results back to the dashboard.
//
// Step actions:
//   navigate      - location.assign(screen)
//   tap           - dispatchEvent click on [data-luniq-anchor=anchor]
//   type          - set value + dispatch input event
//   wait          - setTimeout
//   assert_visible- check element exists and is in-viewport
//   assert_text   - element.textContent contains step.text
//   assert_screen - location.pathname matches step.screen
//   screenshot    - serialize element outerHTML (lightweight; full visual
//                   capture would require html2canvas which is too heavy
//                   to bundle in the SDK)
//
// Customers run this in their internal/test build by swapping the API key
// to a `lq_test_*` value. Their production users (with `lq_live_*` keys)
// will never enter this code path.

type Step = {
  action: string;
  anchor?: string;
  text?: string;
  ms?: number;
  screen?: string;
  name?: string;
  comment?: string;
};

type RunPayload = {
  runId: string;
  testId: string;
  spec: { steps: Step[] };
};

export class TestRunner {
  private endpoint: string;
  private apiKey: string;
  private polling = false;

  constructor(endpoint: string, apiKey: string) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  static isTestKey(apiKey: string): boolean {
    return typeof apiKey === "string" && apiKey.startsWith("lq_test_");
  }

  start() {
    if (this.polling) return;
    this.polling = true;
    this.loop();
    if (typeof console !== "undefined") {
      console.log("[Luniq] test-mode runner active. Polling for queued runs.");
    }
  }

  private async loop() {
    while (this.polling) {
      try {
        const run = await this.poll();
        if (run && run.runId) {
          await this.execute(run);
        }
      } catch (e) {
        // Network or backend error — back off briefly so we don't spin.
        await sleep(5000);
      }
    }
  }

  private async poll(): Promise<RunPayload | null> {
    const r = await fetch(`${this.endpoint}/v1/sdk/test/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Luniq-Key": this.apiKey },
      body: JSON.stringify({
        deviceInfo: `${navigator.userAgent} | ${window.innerWidth}x${window.innerHeight}`,
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j.runId) return null;
    return j as RunPayload;
  }

  private async execute(run: RunPayload) {
    const steps = run.spec?.steps || [];
    let final: "passed" | "failed" = "passed";
    let lastIndex = 0;
    for (let i = 0; i < steps.length; i++) {
      lastIndex = i;
      const step = steps[i];
      const start = Date.now();
      let status: "pass" | "fail" = "pass";
      let error = "";
      let artifact = "";
      try {
        artifact = await this.runStep(step) || "";
      } catch (e: any) {
        status = "fail";
        error = (e && e.message) || String(e);
      }
      const dur = Date.now() - start;
      const isFinal = i === steps.length - 1;
      if (status === "fail") final = "failed";
      await this.report(run.runId, i, step.action, status, dur, error, artifact, isFinal && final === "passed", isFinal ? final : "");
      if (status === "fail") break;
    }
    if (final === "failed") {
      await this.report(run.runId, lastIndex, "(final)", "fail", 0, "", "", true, "failed");
    }
  }

  private async runStep(step: Step): Promise<string> {
    switch (step.action) {
      case "navigate": {
        if (!step.screen) throw new Error("navigate needs `screen`");
        location.assign(step.screen);
        await sleep(800);
        return "";
      }
      case "tap": {
        const el = this.findAnchor(step.anchor || "");
        el.click();
        return "";
      }
      case "type": {
        const el = this.findAnchor(step.anchor || "") as HTMLInputElement;
        if (!("value" in el)) throw new Error("anchor is not an input");
        el.focus();
        el.value = step.text || "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return "";
      }
      case "wait": {
        await sleep(step.ms || 500);
        return "";
      }
      case "assert_visible": {
        const el = this.findAnchor(step.anchor || "");
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) throw new Error("element not visible");
        return "";
      }
      case "assert_text": {
        const el = this.findAnchor(step.anchor || "");
        const got = (el.textContent || "").trim();
        if (!got.includes(step.text || "")) {
          throw new Error(`text mismatch: expected "${step.text}", got "${got.slice(0, 200)}"`);
        }
        return "";
      }
      case "assert_screen": {
        const want = step.screen || "";
        const path = location.pathname + location.search;
        if (!path.includes(want)) throw new Error(`screen mismatch: expected ${want}, got ${path}`);
        return "";
      }
      case "screenshot": {
        // Lightweight screenshot: serialize the body's outer HTML truncated
        // to 50 KB. Real visual screenshots would bundle html2canvas (~100 KB).
        // The dashboard renders this as a code block for now; a future build
        // can opt into html2canvas behind a feature flag.
        const html = (document.body.outerHTML || "").slice(0, 50_000);
        return `html:${html}`;
      }
      default:
        throw new Error(`unknown action: ${step.action}`);
    }
  }

  private findAnchor(anchor: string): HTMLElement {
    if (!anchor) throw new Error("anchor missing");
    // Prefer data-luniq-anchor; fall back to id, then any CSS selector.
    const tries = [
      `[data-luniq-anchor="${cssEscape(anchor)}"]`,
      `#${cssEscape(anchor)}`,
      anchor, // raw selector
    ];
    for (const sel of tries) {
      try {
        const el = document.querySelector<HTMLElement>(sel);
        if (el) return el;
      } catch { /* invalid selector, keep trying */ }
    }
    throw new Error(`anchor not found: ${anchor}`);
  }

  private async report(
    runId: string, stepIndex: number, action: string,
    status: string, durationMs: number, error: string, artifact: string,
    final: boolean, finalStatus: string,
  ) {
    try {
      await fetch(`${this.endpoint}/v1/sdk/test/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Luniq-Key": this.apiKey },
        body: JSON.stringify({ runId, stepIndex, action, status, durationMs, error, artifact, final, finalStatus }),
      });
    } catch {
      /* swallow — never throw from the runner; another run will pick up next loop */
    }
  }
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function cssEscape(s: string): string {
  // Minimal escape — datalist anchor IDs are usually [a-z0-9_-] so the full
  // CSS.escape polyfill isn't worth the bytes.
  return s.replace(/(["\\])/g, "\\$1");
}
