# Changelog

All notable changes to `n8n-nodes-arduino-cloud` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the version numbers follow [SemVer](https://semver.org/).

## [0.1.0] — 2026-04-25

First public release. Two nodes plus a credential, built on the official Arduino JS SDKs.

### Added

- **`Arduino Cloud`** action node with the Property resource (Get / Set / Get History). Marked `usableAsTool: true` so it drops into a Tools Agent's tool connector without a wrapper. Thing and Property dropdowns load live from the REST API. Value coercion is automatic for primitives and JSON literals; explicit type override available. Location (`{lat, lon}`) and Color (`{hue, sat, bri}`) variables pass through unchanged from n8n expressions.
- **`Arduino Cloud Trigger`** trigger node, backed by [`arduino-iot-js`](https://github.com/arduino/arduino-iot-js) over MQTT-over-WebSocket. Connection sharing: multiple triggers on the same credential collapse to a single MQTT client via the package's `CloudClientManager`, which refcounts subscriptions and demuxes deliveries to all listening handlers.
- **`Arduino Cloud OAuth2 API`** credential — Client ID + Client Secret + optional Organization ID. Test Connection mints a fresh token and lists Things.
- **Property Guard** on the action node — user-editable JS predicate that runs at invocation with `operation`, `thingId`, `propertyId`, `value`, and a `budget` view. Returns `true`/`null`/`undefined` to allow, a string to reject (the string is fed back to the LLM as tool output for self-correction), `false` for a generic rejection, or throws for a hard error. Same trust model as the n8n Code node.
- **Rate Limit** on the action node — sliding-window cap (Max Calls per Minute / Hour / Day) keyed per `(node, thingId, propertyId, operation)`. Exceeding the cap short-circuits with a `Refused: ... Retry in ~Xs.` string the LLM reads. Counters are in-memory per process; not shared across queue-mode workers.
- **Per-credential REST throttle** — strict-FIFO token bucket (10 tokens, 10/s) keyed on `clientId\0organizationId`, applied to every REST call. Workflows with many parallel nodes serialise transparently instead of hitting the Arduino Cloud 10 req/s limit and 429-ing.
- **OAuth2 token cache** — pre-expiry refresh and request coalescing keep the auth round-trip out of the hot path; one mint per credential per ~50-min token lifetime.

### Notes

- Disjoint from `n8n-nodes-uno-q` — no shared runtime, no transitive dependency. Install both side by side if you have UNO Q hardware *and* Arduino Cloud-connected boards.
- The package depends on `@arduino/arduino-iot-client` (REST) and `arduino-iot-js` (MQTT). Both are pulled in automatically by n8n's community-nodes installer.
- Documentation: [README](README.md) for end users; [`docs/master-plan/13-arduino-cloud.md`](https://github.com/raas-impact/n8n-uno-q/blob/main/docs/master-plan/13-arduino-cloud.md) for the wedge analysis and the rationale behind the v1 scope cuts.
