# Luniq.AI Web SDK

AI-native product analytics for the web — auto-capture, in-app guides/banners/surveys, session replay, and Design Mode pairing for live preview from the Luniq.AI dashboard.

```bash
npm install @luniq/sdk
```

## Use via ES module
```js
import { Luniq } from "@luniq/sdk";

Luniq.start({
  apiKey: "lq_live_xxx",
  endpoint: "https://your-luniq-host.com",
});

Luniq.identify("user_1234", "account_567", { plan: "pro" });

Luniq.track("checkout_started", { cart_size: 3 });
Luniq.screen("Dashboard");
Luniq.submitFeedback("idea", "Add dark mode");
```

## Use via `<script>`
```html
<script src="https://your-luniq-host.com/sdk/luniq.js"></script>
<script>
  Luniq.start({ apiKey: "lq_live_xxx", endpoint: "https://your-luniq-host.com" });
</script>
```

## Design Mode (live preview pairing)
Append `?luniq_design=CODE` to any page with the SDK installed — auto-pairs to the Luniq.AI dashboard for live preview of unpublished guides/banners/surveys. Or call `Luniq.enableDesignMode("code")`.

## Features
- Auto-capture: clicks + SPA route changes
- Offline queue: `localStorage`, up to 5000 events
- Batch + sendBeacon on page unload
- Identify + traits
- Feedback submission
- Design Mode pairing
- Opt-out via `Luniq.optOut(true)`
