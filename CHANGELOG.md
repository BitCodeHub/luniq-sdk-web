# Changelog

All notable changes to `@luniq/sdk` are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/).

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
