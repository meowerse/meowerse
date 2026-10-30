# Meowsenger web performance: harness and baseline

Plan: `meowverse-design/2026-10-30-ux-performance-program.md`, section (c) and PR-0. This file is the committed
before/after record; each perf PR re-runs the harness and updates the table below. Raw results are never committed except
the published `meowsenger-baseline.json` next to this file.

## How to run (tier A: built app + mock backend)

```sh
bun install --frozen-lockfile
bun run --filter @meowerse/meowsenger-web build        # the harness serves apps/meowsenger-web/dist
nice -n 19 bun run perf:meowsenger                     # from the repo root; same as `bun run perf:baseline` in apps/meowsenger-web
```

It is **not** part of `bun run test`, `lint` or CI: it needs a built `dist/` and a Chromium, takes ~15-25 minutes at the
default N=5 and is meant for a quiet machine. Options (pass after `--`, or call `bun perf/run.ts` directly in
`apps/meowsenger-web`): `--runs 5 --warm 20 --leak-switches 50 --rtts 80,150,300 --lat-runs 3 --profiles desktop,phone
--api-ms 150 --ws-ms 120 --out /var/tmp/mw-perf --publish`. `--publish` rewrites `meowsenger-baseline.json` and the
table between the markers below. Results always land in `/var/tmp/mw-perf/<git-sha>/A/{results.json,summary.md}` (raw
per-switch data included). It is a single sequential browser (no parallel workers); run it under `nice -n 19`.

Safety: nothing leaves localhost. The mock serves `dist/` on `127.0.0.1:<random port>` with the real `_headers` (CSP
included, so CSP violations are measured) and fakes `/api/session`, `/api/chats`, `/api/chats/:id/messages[?before]`,
`/members` and the `/ws` + `/inbox/ws` sockets (real WebSockets) from deterministic fixtures. No credentials, no
production host, no real data. Service workers are blocked in the test contexts.

### What is in `apps/meowsenger-web/perf/`

| file | role |
|---|---|
| `fixtures.ts` | seeded fixtures: 8 chats (DM 300 msgs, group 1000 msgs + 40 members, channel, 3 unread DMs, small group, DM), Cyrillic/long/links/code/emoji/replies/reactions/edits/tombstones, a unique `PERF-MARK::<chat>` last message per chat; `selfCheck()` asserts the markers/sizes at every start |
| `mock-server.ts` | the backend; control plane `/__mock/{config,reset,drop,push,frame,stats}`: per-route latency + seeded jitter, forced WS drop, scripted peer messages/edit/delete/reaction frames, failing poll, lost ack |
| `instrument.ts` | init script (never bundled): WebSocket tap, `.mw-chat__conn[data-state]` observer, CLS / longtask / long-animation-frame / event-timing observers, CSP-violation counter, `switchTo()` |
| `run.ts` | scenarios, aggregation, report writer |
| `bundle.ts` | gzip -9 per chunk for `/app` (report only, no budget gate yet) |

### Scenarios and metrics (each run = fresh browser context, so no shared cache)

- **Re-entry latency**: `switchTo` clicks a sidebar row and resolves on the first animation frame whose `.mw-chat__log`
  contains the chat's marker, so it is selection-to-visible content. Cold = first visit; warm = 20 switches
  cycling 3 chats (A,B,C,A,...). Reported: median of per-context p50, pooled p95.
- **Indicator**: transitions of `.mw-chat__conn[data-state]`; a "flash" is a `wait` (yellow) state entered between the
  click and the indicator settling on `on`; dwell time is recorded too.
- **Requests / sockets per journey**: `/api/*` counted per route for boot, per cold open and per warm switch; WS
  opens/closes by kind from both the page tap and the server; peak in-flight duplicates of `/api/chats`.
- **Repeated navigation**: warm cycle above, plus 10x open / `back to chats` / re-open of the same chat.
- **Simultaneous events during re-entry**: a scripted second client edits + reacts at +40 ms, deletes and sends a live
  message at +250 ms, sends another at +700 ms, while the harness re-enters a chat that has the targets. Checks the
  final DOM (edit applied and stale text gone, tombstone, reaction pill, each live message exactly once).
- **Interaction latency (INP-ish)**: Event Timing entries with an `interactionId`, grouped per interaction (max
  duration): click chat row, 40 typed characters, Enter to send, open the members drawer (real Playwright input).
- **CLS** on `/app` boot and across the 20 warm switches; **long tasks** + long-animation-frame blocking time during
  the switches and during a 1000-message-group burst of 20 typing frames + 20 reactions.
- **Memory / listeners**: in a separate fresh context, every chat visited once, GC, then 50 switches, GC; heap
  (`JSHeapUsedSize`), DOM nodes, `JSEventListeners` and `DOMDebugger.getEventListeners` on window + document, plus
  sockets still open (expected 2: inbox + current chat).
- **Mobile-keyboard proxy** (both profiles; the phone profile is 390x844, touch, 4x CPU): focus the composer with a
  draft, switch chat, then check the composer is still focused, is the same DOM node and kept its draft. Headless
  Chromium has no on-screen keyboard, so "the keyboard was not dismissed" is approximated by focus retention.
- **Correctness probes** (assertions-as-metrics): tab return (`focus` + `visibilitychange`) `listChats` count and
  concurrency; sidebar-empty frame during a failing poll; peers' messages lost across a forced WS close; copies of a
  message whose ack was lost; CSP violations.
- **Service-latency sweep**: boot + 3 cold + 20 warm switches at API RTT 80 / 150 / 300 ms with +-20% seeded jitter
  (WS open = 0.8 x RTT), N=`--lat-runs` contexts each.
- **Bundle**: per-chunk gzip -9 and the eager closure of `/app`.

### Approved targets (owner review of PR-0)

Warm cached chat re-entry p50 < 50 ms and p95 < 100 ms (selection to visible content), and zero false-outage
(`wait`) indicator on a normal switch. The report prints a MEETS/MISSES line per profile.

## Tier B (real local stack): deferred, not implemented in PR-0

Tier B (`wrangler dev` with D1 + Durable Objects and seeded data) is part of the plan's section (c) but was not built in
PR-0: it needs a session-cookie seeding path, ~300+1000 messages seeded through the real WS `send` path under the
`RATE_MAX=30 / 10 s` limit, and a `__Host-` cookie check on `http://localhost` that cannot be validated without that
stack, so it would have been unverified code. Exact steps for the follow-up (`perf:local`):

1. `bun run --filter @meowerse/meowsenger-web build`, then `cd workers/meowsenger && wrangler dev --persist-to /var/tmp/mw-perf-state` (the worker serves `dist/` through `ASSETS`).
2. Schema: `wrangler d1 execute meowsenger --local --persist-to /var/tmp/mw-perf-state --file schema.sql`, then each `schema-*.sql`.
3. Identity without OIDC: insert `users` rows and a `sessions` row whose `id` = `sha256hex(cookie)` (`wk/session.ts`) with a future `expires_at`; set cookie `__Host-mw_session=<cookie>` on `http://localhost:8787`. Verify Chromium accepts `__Host-` on localhost first; fallback `wrangler dev --local-protocol https` + `ignoreHTTPSErrors`.
4. Seed messages through the real `/ws?chat=` `send` frames from 4 sockets x 2 users (rate limit), once per persist dir.
5. Reuse `perf/run.ts` scenarios with the mock swapped for the worker origin, CDP `Network.emulateNetworkConditions` (150 ms, 1.6 Mbps down, 750 Kbps up) instead of mock-injected latency.

## Limitations of the tier-A numbers

- **Dataset size is not rendered size.** The 1000-message fixture is the size of the chat's history on the mock
  server, but `/messages` returns 50 per page (like the real worker), so a re-entry or the typing-event burst renders
  at most the loaded pages (~50 messages unless the run scrolls back). These numbers therefore do NOT measure a
  1000-message DOM. Long-rendered-history scenarios (scroll back through many pages, then measure re-render cost per
  typing/presence/reaction event) belong to the rendering-optimization PRs (P3) and must be added there.

- The mock does not implement `?around=` / `?after=` on `/messages` (the real worker does), does not enforce the
  session cookie (no 401/403 paths), and omits `forwarded` on inbox frames and `away` in presence snapshots. Any
  later PR that measures deep links, detached windows or auth expiry must extend the mock first.
- The harness sources under `apps/meowsenger-web/perf/` are outside the app's `tsconfig` include, so `lint`/`astro
  check` do not type-check them; run the harness after protocol changes to catch drift.
- Provenance: this baseline was produced from origin/master `9f03306` with the harness as committed on the
  `test/meowsenger-perf-harness` branch (no product code differs); re-run `--publish` after merge to stamp a
  merge-commit SHA.

- The backend is a Bun mock: latency is `setTimeout`-injected, there is no D1/DO cost, no TLS, no HTTP/2, no real WAN
  jitter; CPU throttling uses CDP `Emulation.setCPUThrottlingRate` (4x on the phone profile), not a real phone.
- Headless Chromium (Playwright's build) on a shared, often heavily loaded desktop: the load average is recorded in the
  report and absolute numbers move with it. Only large, reproducible differences should be quoted (plan, AITS rule).
- Event-timing INP is measured from synthetic-but-real input events in headless mode; it is "INP-ish", not field INP.
- Re-entry is timed to the first rAF after the marker text is in the DOM (~one frame of resolution), not to a
  paint-confirmed screenshot. Row selection uses the app's own onClick via `element.click()`; the INP set uses real
  Playwright clicks.
- No real on-screen keyboard (see above); no 401-upgrade probe; no scripted peer presence flaps; mock peers are
  stateless apart from edit/delete/reaction mutations of fixtures.
- The CLS figure across switches is the plain SUM of layout-shift values over the 20-switch window (not a session
  window), so it is large (0.2+ per switch) and is the number to drive down; boot CLS is 0.
- "Re-open after back" on the phone profile is bimodal (p50 far below p95) under 4x CPU throttling on a loaded host;
  treat it as indicative only.
- The commit recorded in the table is the base commit the harness ran on (origin/master 9f03306); the harness itself
  is the only difference.
- The mock reproduces the HTTP/WS shapes the client reads today; if the worker protocol changes (PR-4/PR-3), the mock
  must follow.

## Baseline (origin/master, tier A)

<!-- baseline:start -->
- commit: `9f033064bf576de7c5ced7022ac5bab58d80ca35` (+ uncommitted harness changes)
- browser: Chromium 153.0.8010.12 (Playwright 1.63.0, headless)
- host: AMD Ryzen 5 240 w/ Radeon 760M Graphics x12, load avg at start 13.8 / 22 / 24.6, end 17.3 / 13.7 / 17.5
- mock latency: API 150 ms, WS open 120 ms (injected in the mock server; no CDP network throttling)
- runs: 5 fresh browser contexts per profile (+ 5 for the leak test), 20 warm switches/context, 50 switches in the leak test
- date: 2026-10-30T13:38:56.629Z

## desktop (1440x900, CPU 1x)

| metric | value |
|---|---|
| warm re-entry to visible messages p50 / p95 (ms) | 171.2 / 199.9 (n=100; per-run p50: 170.6, 179.1, 171.8, 171.1, 171.2) |
| cold chat open p50 / p95 (ms) | 172.4 / 202.1 (n=20) |
| wait (yellow) flashes per warm switch / per cold open | 1 / 1 (median dwell 117.5 ms) |
| HTTP /api per warm switch | {"messages":1.5,"members":0.4} |
| HTTP /api per cold open | {"messages":1.4,"members":0.5} |
| HTTP /api at boot (median) | {"session":2,"chats":1} |
| chat sockets opened per warm switch; at boot (inbox/chat) | 1; 1/0 |
| boot: 8 sidebar rows visible (ms, median) | 384 |
| re-open same chat after "back" p50 / p95 (ms), flashes | 174.8 / 186.5, 1 |
| composer across a chat switch (runs of 5): focus kept / same node / draft kept | 0 / 5 / 5 |
| events during re-entry (edit+react, delete, 2 live msgs), runs OK of 5: edit / delete / reaction / live exactly once | 5 / 5 / 5 / 5 (switch 171.1 ms) |
| INP-ish (ms): click p75 / max, keys p75 / max (n=143) | 24 / 32, 16 / 24 |
| CLS: /app boot (median / max), across 20 switches (max) | 0 / 0, 4.5939 |
| long tasks per 20-switch run: n / total ms / max ms / LoAF blocking ms | 0 / 0 / 70 / 0 |
| long tasks in 1000-msg burst (20 typing + 20 reactions): median n / max ms | 0 / 0 |
| leak after 50 switches: heap delta MB median / max (base 3.3), DOM nodes, JS listeners, window+document listeners | 0.4 / 0.7, 0, 0, 0 |
| sockets still open at end of leak test (max); chat sockets opened | 2; 53 |
| listChats per tab return (focus + visibilitychange); max concurrent | 2; 2 |
| sidebar "no chats yet" shown during a failed poll (runs of 5) | 5 |
| peer messages lost across forced WS close (of 5, median) | 5 |
| copies of a message whose ack was lost, after reconnect (max) | 1 |
| CSP violations (all runs) | 0 |

## phone (390x844, CPU 4x, touch)

| metric | value |
|---|---|
| warm re-entry to visible messages p50 / p95 (ms) | 208.5 / 275.5 (n=100; per-run p50: 192.2, 195.8, 208.6, 208.5, 259.1) |
| cold chat open p50 / p95 (ms) | 257.7 / 348.8 (n=20) |
| wait (yellow) flashes per warm switch / per cold open | 1 / 1 (median dwell 110.1 ms) |
| HTTP /api per warm switch | {"messages":1.5,"members":0.4} |
| HTTP /api per cold open | {"messages":1.5,"members":0.5} |
| HTTP /api at boot (median) | {"session":2,"chats":1} |
| chat sockets opened per warm switch; at boot (inbox/chat) | 1; 1/0 |
| boot: 8 sidebar rows visible (ms, median) | 589 |
| re-open same chat after "back" p50 / p95 (ms), flashes | 38.7 / 219.4, 1 |
| composer across a chat switch (runs of 5): focus kept / same node / draft kept | 0 / 5 / 5 |
| events during re-entry (edit+react, delete, 2 live msgs), runs OK of 5: edit / delete / reaction / live exactly once | 5 / 5 / 5 / 5 (switch 210.9 ms) |
| INP-ish (ms): click p75 / max, keys p75 / max (n=187) | 48 / 112, 16 / 72 |
| CLS: /app boot (median / max), across 20 switches (max) | 0 / 0, 8.0458 |
| long tasks per 20-switch run: n / total ms / max ms / LoAF blocking ms | 3 / 350 / 246 / 183.1 |
| long tasks in 1000-msg burst (20 typing + 20 reactions): median n / max ms | 0 / 59 |
| leak after 50 switches: heap delta MB median / max (base 3.3), DOM nodes, JS listeners, window+document listeners | 0.4 / 0.4, 0, 0, 0 |
| sockets still open at end of leak test (max); chat sockets opened | 2; 53 |
| listChats per tab return (focus + visibilitychange); max concurrent | 2; 2 |
| sidebar "no chats yet" shown during a failed poll (runs of 5) | 5 |
| peer messages lost across forced WS close (of 5, median) | 5 |
| copies of a message whose ack was lost, after reconnect (max) | 1 |
| CSP violations (all runs) | 0 |

## Service-latency sweep (warm re-entry, API RTT with +-20% seeded jitter, WS open = 0.8 x RTT)

| profile | RTT ms | warm p50 / p95 (ms) | cold p50 / p95 (ms) | flashes per warm switch | n warm |
|---|---|---|---|---|---|
| desktop | 80 | 97.3 / 111.3 | 103.2 / 121.1 | 1 | 60 |
| desktop | 150 | 176.3 / 263.7 | 196 / 258.3 | 1 | 60 |
| desktop | 300 | 325.3 / 394.9 | 348.4 / 372.3 | 1 | 60 |
| phone | 80 | 257.2 / 321.2 | 284.8 / 398.3 | 1 | 60 |
| phone | 150 | 280.6 / 410 | 235.6 / 529.4 | 1 | 60 |
| phone | 300 | 432.3 / 562.8 | 458.9 / 504.6 | 1 | 60 |

## Owner targets (warm cached re-entry p50 < 50 ms, p95 < 100 ms at the default 150 ms RTT; zero false-outage flashes on a normal switch)

| profile | p50 | p95 | flashes/switch | verdict |
|---|---|---|---|---|
| desktop | 171.2 | 199.9 | 1 | MISSES |
| phone | 208.5 | 275.5 | 1 | MISSES |

## Bundle (/app, gzip -9)

eager JS: 86889 B gz / 288690 B raw across 4 chunks; CSS 11296 B gz; all built JS 88580 B gz; HTML 2600 B gz

| chunk | raw B | gzip B |
|---|---|---|
| client.DKvnRPH4.js (eager) | 180580 | 56559 |
| AppShell.C2d8dir7.js (eager) | 76553 | 19927 |
| chat.CfY101fB.js (eager) | 20525 | 6476 |
| react-dom.8nq12Ben.js (eager) | 11032 | 3927 |
| ChannelPreview.DcrjhLXG.js | 5568 | 1691 |
| Layout.DRzqk8lZ.css (css) | 63866 | 11296 |
<!-- baseline:end -->
