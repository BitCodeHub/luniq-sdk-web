# Changelog

All notable changes to `@luniq/sdk` are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] — 2026-04-28

### Added
- **Auto-captured marketing attribution**: every event now includes
  `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`,
  and `referrer_domain`. UTM params are read from the landing URL and
  made sticky for the session via `sessionStorage` so post-landing
  events keep the original campaign context — matches GA4 last-touch.
- **Browser + device-type auto-detection**: every event now includes
  `browser` (Chrome / Safari / Firefox / Edge / Opera), `browser_version`,
  and `device_type` (desktop / mobile / tablet) from a tiny built-in
  user-agent classifier. Adds <1 KB to the bundle (no `ua-parser-js`).

These fields are promoted to first-class ClickHouse columns by the
backend's worker, so the dashboard's `breakdown` tool and Ask Luna can
group by them directly (e.g. "drop-offs by utm_source", "users by
browser").

## [1.0.0] — 2026-04-27

### Added
- Initial public release.
- `Luniq.start({ apiKey, endpoint, autoCapture, batchSize, flushIntervalMs })`.
- `track(name, properties)`, `screen(name, properties)`,
  `identify(visitorId, accountId, traits)`, `submitFeedback(...)`,
  `optOut(bool)`, `enableDesignMode()`.
- Auto-capture: clicks, screen views, errors, network calls.
- Offline event queue with periodic flush.
- TypeScript declarations shipped in `dist/index.d.ts`.
- ESM (`luniq.esm.js`) and UMD (`luniq.js`, registers `window.Luniq`) builds.
- Demo page at `examples/index.html`.
