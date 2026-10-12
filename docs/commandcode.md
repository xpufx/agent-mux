# Command Code — Quota, Usage, and Pricing API Reference

[Command Code](https://commandcode.ai) is the default provider in this
environment, wired into `pi` through the community
[`pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider)
extension. Its **alpha API** exposes account identity, credit balances,
subscription details, and aggregate usage — the same data the provider's
`/commandcode-quota` command and the Command Code usage page read.

This document records the endpoints, authentication rules, response shapes,
known caveats, and a live snapshot so `agent-mux` tooling can query the same
data without reverse-engineering the provider.

> **Alpha:** these endpoints are undocumented and unversioned by Command Code.
> Shapes can change without notice. The provider treats a section it cannot
> parse as *unavailable* rather than as zero.

---

## Authentication

| Item | Value |
| :--- | :--- |
| Base URL | `https://api.commandcode.ai` |
| Header | `Authorization: Bearer <api-key>` |
| Header | `accept: application/json` |
| Key format | `user_...` (personal keys) |

Personal keys return `org: null` from `/alpha/whoami`, so the `orgId` query
parameter is simply omitted on billing and usage calls. Organization keys set
`org.id` and should pass it as `?orgId=<uuid>`.

### Key resolution

`pi-commandcode-provider` resolves a key in this order (see
`src/api-key.ts` in the provider package):

1. `COMMAND_CODE_API_KEY` environment variable
2. `COMMANDCODE_API_KEY` environment variable
3. `~/.commandcode/auth.json`
4. `~/.pi/agent/auth.json`
5. `~/.omp/agent/auth.json`

For each auth file it accepts any of:

- a top-level `apiKey` string (`~/.commandcode/auth.json` uses this shape),
- a top-level `commandcode` string,
- a `commandcode` credential object, or
- a `command-code` string / credential object.

A credential object resolves by `type`: `oauth` → `access`, `api` →
`key`, otherwise `access ?? key`. A typical `pi` auth file entry looks like:

```json
{
  "commandcode": {
    "type": "api_key",
    "key": "user_..."
  }
}
```

`agent-mux` scopes this file per profile: in `scoped` isolation mode only
`.pi/agent/auth.json` is bind-mounted from the profile, so each account keeps
its own Command Code key while everything else stays on the real host home.

---

## Endpoints

| Endpoint | Purpose | Key fields |
| :--- | :--- | :--- |
| `/alpha/whoami` | Account identity | `user.id`, `user.name`, `user.userName`, `user.email`, `user.keyName`, `org` (null for personal keys) |
| `/alpha/billing/credits` | Credit balance + rate windows | `credits.monthlyCredits`, `credits.purchasedCredits`, `credits.freeCredits`, `credits.belowThreshold`, `credits.creditThreshold`; `windowLimits.fiveHour.{used,cap,exceeded,resetAt}`, `windowLimits.weekly.{used,cap,exceeded,resetAt}`, `windowLimits.limited`; `sandboxAccess`, `sandboxMinutes` |
| `/alpha/billing/subscriptions` | Plan / subscription | `data.planId`, `data.status`, `data.currentPeriodStart`, `data.currentPeriodEnd`, `data.cancelAtPeriodEnd`, `data.priceId` |
| `/alpha/usage/summary` | Aggregate usage for the billing period | `totalCount`, `completedCount`, `failedCount`, `successRate`, `totalCost`, `averageCost`, `totalTokensIn`, `totalTokensOut`, `totalTokens`, `totalCredits`, `totalMonthlyCredits`, `totalFreeCredits`, `totalPurchasedCredits`, `periodBasis` |

### Parameters

- **`orgId`** (optional, string): only for organization keys; omit for
  personal `user_...` keys.
- **`since`** (optional, ISO-8601 or epoch): start of the aggregate usage
  window. The provider passes `subscriptions.data.currentPeriodStart` when it
  is available so the summary matches the billing period. Without it the API
  returns its own default window (`periodBasis` in the response).

### Response notes

- **Credits** are USD-denominated. The provider's effective remaining balance
  is `monthlyCredits + purchasedCredits + freeCredits`; the pool size is only
  known by adding the billing-period spend (`totalCost`) back in.
- **`windowLimits`** is a top-level object on the credits response keyed by
  `fiveHour` and `weekly`, each with `used`, `cap`, `exceeded`, and `resetAt`.
  `resetAt` may be an ISO-8601 string or an epoch value; the provider
  normalizes it to epoch seconds and treats `0`/absent as "no reset".
  A window with `used === 0 && cap === 0` is treated as not reported.
- **`/alpha/billing/subscriptions`** timestamps (`currentPeriodStart`,
  `currentPeriodEnd`) may be ISO-8601 strings or epoch values.
- Sections that fail to parse or time out are reported as `unavailable`
  (`credits`, `subscription`, `usage`) instead of being zero-filled. A
  `401`/`403` on any call aborts the whole snapshot as a rejected key.

---

## Shell examples

Resolve the key from either store, then hit each endpoint:

```sh
# From pi's provider-scoped auth file:
KEY=$(python3 -c "import json; print(json.load(open('$HOME/.pi/agent/auth.json'))['commandcode']['key'])")

# Or from the Command Code CLI store:
# KEY=$(python3 -c "import json; print(json.load(open('$HOME/.commandcode/auth.json'))['apiKey'])")

curl -s -H "Authorization: Bearer $KEY" -H "accept: application/json" \
  https://api.commandcode.ai/alpha/whoami

curl -s -H "Authorization: Bearer $KEY" -H "accept: application/json" \
  https://api.commandcode.ai/alpha/billing/credits

curl -s -H "Authorization: Bearer $KEY" -H "accept: application/json" \
  https://api.commandcode.ai/alpha/billing/subscriptions

curl -s -H "Authorization: Bearer $KEY" -H "accept: application/json" \
  https://api.commandcode.ai/alpha/usage/summary
```

Pass `?orgId=<uuid>` on the billing and usage calls when `/alpha/whoami`
returns a non-null `org.id`. Chain the billing period into the usage window:

```sh
PERIOD_START=$(
  curl -s -H "Authorization: Bearer $KEY" https://api.commandcode.ai/alpha/billing/subscriptions \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['currentPeriodStart'])"
)

curl -s -H "Authorization: Bearer $KEY" \
  "https://api.commandcode.ai/alpha/usage/summary?since=$PERIOD_START"
```

The `agent-mux` hooks in `pi-commandcode-provider` add a `ZDR` (zero-data-
retention) header to these requests when configured; replicate the provider's
`commandcodeHeaders()` if you need byte-identical requests.

---

## Pricing caveats

- The model catalog at `/provider/v1/models` does **not** include prices.
  `pi-commandcode-provider` keeps a static
  [`MODEL_COSTS`](https://github.com/patlux/pi-commandcode-provider/blob/main/src/pricing.ts)
  table for models with known prices so `pi` can display estimated request
  costs.
- Models missing from that table display **$0** in `pi`. That does **not**
  mean the request is billed at zero — it means the price is unknown.
- The pricing table is manually reviewed (promotions and long-context tiers
  require a human pass). `npm run check:commandcode-pricing` in the provider
  compares the static table against the live catalog and public pricing page
  and fails loudly on drift instead of silently adopting new rates.
- The Command Code usage page
  (https://commandcode.ai/docs/resources/pricing-limits) remains
  **authoritative** for the amount billed per request.

### DeepSeek V4 peak / off-peak windows

DeepSeek V4 models use time-dependent rates. The provider applies the
documented **2x peak rates** on weekdays during:

| Window (UTC) | Rate |
| :--- | :--- |
| Monday–Friday 01:00–04:00 | Peak (2x) |
| Monday–Friday 06:00–10:00 | Peak (2x) |
| All other times, including the entire weekend | Off-peak |

The same request-time selection is applied on both the native Provider API
path and the legacy `/alpha/generate` fallback. The displayed table values are
the off-peak rates, which apply for 17 hours per day.

---

## How this is consumed

### `pi-commandcode-provider`

- `/commandcode-quota` — dashboard-style quota view (credits
  remaining/used with percentage, monthly/purchased/free sources, current
  plan, usage totals, API key name, 5-hour and weekly windows). Reads
  `whoami`, `billing/credits`, `billing/subscriptions`, and `usage/summary`
  with the same key; reports unavailable sections explicitly instead of
  showing zero.
- `/commandcode-status` — catalog discovery diagnostics (cache vs live, model
  count, timestamps, endpoint). The catalog is cached at
  `~/.pi/agent/commandcode-models.json`.
- On OMP the provider additionally registers a host `usage` provider built from
  the same endpoints. `pi` has no such field and ignores it.

### `agent-mux`

`agent-mux` drives `pi` through the `PiAdapter`. Command Code appears as
dynamic inner pools discovered from the model catalog:

- `commandcode` — preferred model `commandcode/deepseek/deepseek-v4-flash`
- `commandcode-free` — preferred model `commandcode/poolside/laguna-s-2.1-free`

Quota state in `agent-mux` is derived from persisted cooldowns and live probes
(`agent-mux probe`), not from the alpha billing endpoints. The alpha API is the
ground truth for manual inspection only; `agent-mux` deliberately does not
poll it on the routing hot path.

---

## Live snapshot (2026-10-12 ~08:30 UTC)

- Account: `xpufx` (github@xpufx.com), plan `individual-goat`, active period
  2026-10-04 → 2026-11-04
- Credits: $34.73 monthly remaining, $0 purchased, $0 free
- 5-hour window: $0.267 used / $14 cap (resets ~Oct 12); weekly:
  $0.267 / $35 cap (resets ~Oct 18)
- Billing-period totals: 24,051 requests, 100% success, $35.08 credits
  consumed, 3,645,017,057 tokens (3,630,786,156 in / 14,230,901 out), average
  $0.00146/request

---

## Related

- [Issue #43](https://forge.mrs.uppidi.com/xpufx-org/agent-mux/issues/43) —
  this reference
- [Issue #41](https://forge.mrs.uppidi.com/xpufx-org/agent-mux/issues/41) —
  Pi provider + Command Code integration
- [Issue #38](https://forge.mrs.uppidi.com/xpufx-org/agent-mux/issues/38) —
  lingering quota notices across model/account switches
- [Command Code pricing & limits](https://commandcode.ai/docs/resources/pricing-limits)
- [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider)
