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
declare class EngageRuntime {
    private client;
    private endpoint;
    private apiKey;
    private env;
    private banners;
    private guides;
    private surveys;
    private dismissed;
    private bannerEl;
    private guideEl;
    private surveyEl;
    private guideState;
    private timers;
    private attachedArms;
    start(client: ClientLike, endpoint: string, apiKey: string, env: string): void;
    /** Public manual triggers — host apps can call these to surface a
     *  specific item ad-hoc, e.g. after a successful checkout. */
    showBanner(id: string): void;
    showGuide(id: string): void;
    showSurvey(id: string): void;
    private scheduleFetch;
    private fetchAll;
    private fetchJSON;
    private audienceMatch;
    private evaluateAll;
    private triggerNow;
    private armOrRender;
    /** Tear down a single armed listener — used both when the trigger
     *  finally fires AND on SPA route changes when we re-evaluate. */
    private detachArm;
    /** Tear down EVERY armed listener — called on route change so a
     *  click trigger configured for /pricing doesn't keep listening on
     *  /platform after navigation. evaluateAll re-arms anything that
     *  still matches the new page's audience. */
    private detachAllArms;
    private renderBanner;
    private renderGuide;
    private drawGuideStep;
    private completeGuide;
    private dismissGuide;
    private renderSurvey;
    private dismiss;
    private loadDismissed;
    private persistDismissed;
    private injectStyles;
}
export declare const _engage: EngageRuntime;
export {};
