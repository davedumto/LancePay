# Inbound Webhook Signatures and Replay Windows

This document is the authoritative reference for the four inbound webhook integrations. All handlers read the **raw request body** before parsing, so proxies must not rewrite it.

Shared signature fixtures for tests live in [`tests/fixtures/inbound-webhooks.ts`](../tests/fixtures/inbound-webhooks.ts).

## Summary

| Provider | Route | Signature header | Secret env var | Replay tolerance |
|---|---|---|---|---|
| Privy (Svix) | `POST /api/webhooks/privy` | `svix-id`, `svix-timestamp`, `svix-signature` | `PRIVY_WEBHOOK_SECRET` | None enforced by the verifier |
| MoonPay | `POST /api/webhooks/moonpay` | `moonpay-signature-v2` | `MOONPAY_WEBHOOK_KEY` | `MOONPAY_WEBHOOK_TOLERANCE_SECONDS`, default 300s |
| Offramp (Yellow Card) | `POST /api/webhooks/offramp` | `x-yc-signature` | `OFFRAMP_WEBHOOK_SECRET` | None; idempotency by withdrawal state |
| Circle deposits | `POST /api/routes-d/integrations/circle/deposit-callback` | `x-circle-signature` | `CIRCLE_WEBHOOK_SECRET` | None; idempotency by deposit id |

## Privy (Svix)

**Implementation:** `lib/privy-webhook-verify.ts`, `app/api/webhooks/privy/route.ts`

- **Headers:** `svix-id` (event id), `svix-timestamp` (unix seconds), `svix-signature` (one or more `v1,<base64>` entries, space separated).
- **Signed payload:** `${svix-id}.${svix-timestamp}.${rawBody}`.
- **Encoding:** HMAC-SHA256. The `whsec_` prefix is stripped from the secret and the remainder is base64-decoded into the HMAC key. The expected digest is base64 and compared with `crypto.timingSafeEqual`.
- **Secret:** `PRIVY_WEBHOOK_SECRET`.
- **Replay tolerance:** the timestamp is part of the signed content but is **not** compared to the current time, so there is no replay window in the application. Svix's recommended five-minute window should be enforced at the edge until the verifier checks it explicitly.
- **Idempotency:** `privy.test` and unknown event types are acknowledged without writes. `user.created` looks up `user.privyId` inside a transaction before creating a row; wallet funding is itself idempotent. The `svix-id` value is not persisted, so a replayed `user.created` is deduplicated by the unique user id rather than the delivery id.
- **Retry behaviour:** `401` for a missing/invalid signature; `200 { received: true }` for invalid JSON after a valid signature and for every handled or ignored event. Handler errors are also acknowledged with `200`, so Privy does not retry them.

## MoonPay

**Implementation:** `lib/moonpay-signature.ts`, `app/api/webhooks/moonpay/route.ts`

- **Header:** `moonpay-signature-v2`, formatted as `t=<unix seconds>,s=<hex digest>`.
- **Signed payload:** `${timestamp}.${rawBody}`.
- **Encoding:** HMAC-SHA256 with the raw secret; hex digest compared in constant time.
- **Secret:** `MOONPAY_WEBHOOK_KEY`.
- **Replay tolerance:** `MOONPAY_WEBHOOK_TOLERANCE_SECONDS`, default `300` seconds. `Math.abs(now - timestamp) > tolerance` is rejected. Set to `0` only for testing.
- **Idempotency:** `prisma.transaction.findUnique({ where: { externalId: data.id } })` skips an already-recorded MoonPay transaction. Invoices already marked `paid` are acknowledged without changes, and the invoice update uses `updateMany({ status: 'pending' })` so concurrent deliveries settle once.
- **Retry behaviour:** `401` for an invalid signature; `200 { received: true }` for non-completion events, missing invoice numbers, duplicates, mismatched amounts (after alerting admins), and unexpected handler errors.

## Offramp (Yellow Card)

**Implementation:** `app/api/webhooks/offramp/route.ts`

- **Header:** `x-yc-signature`.
- **Signed payload:** the raw body.
- **Encoding:** base64 of HMAC-SHA256(rawBody, secret), compared with `lib/crypto.ts`'s `timingSafeEqual`.
- **Secret:** `OFFRAMP_WEBHOOK_SECRET`. Missing secret returns `500`.
- **Replay tolerance:** none. Replays are contained by the withdrawal state machine: `completed`, `failed` and `reversed` are terminal and later updates are acknowledged with `ignored: true`.
- **Idempotency:** withdrawals are located by `stellarTxId` (`transactionId`) or internal `id` (`reference`). Unknown records are acknowledged with `200` and are never disclosed to the caller.
- **Retry behaviour:** `401` for a missing/invalid signature, `400` for invalid JSON or a payload without `reference`/`transactionId`, `200 { received: true }` for accepted and duplicate deliveries, `500` for unexpected errors.

## Circle deposits

**Implementation:** `app/api/routes-d/integrations/circle/deposit-callback/route.ts`

- **Header:** `x-circle-signature`.
- **Signed payload:** none. Despite the header name, this is a plain shared-secret comparison, not an HMAC over the body. Protect the endpoint at the transport layer and rotate the secret if it leaks.
- **Encoding:** the header value must equal `CIRCLE_WEBHOOK_SECRET` exactly.
- **Secret:** `CIRCLE_WEBHOOK_SECRET`. When it is unset every callback is rejected.
- **Replay tolerance:** none. Idempotency is by `data.id`: `prisma.transaction.findFirst({ where: { externalId: data.id } })` short-circuits duplicates.
- **Retry behaviour:** `401` for an invalid signature, `400` for missing event type/data/fields, `404` for an unknown virtual account, `200 { received: true, handled: false, duplicate: true }` for replays and non-deposit events, `200 { received: true, handled: true }` for a recorded deposit.

## Testing

`tests/fixtures/inbound-webhooks.ts` exports `signPrivyWebhook`, `signMoonPayWebhookFixture`, `signOfframpWebhook` and `signCircleWebhook`. Use them instead of hand-rolling HMACs in route tests so the fixtures stay aligned with the verifiers. Each helper returns the exact header values and the secret that produced them.
