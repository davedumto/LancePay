# Compliance risk endpoints

This note tracks the initial compliance API surface for risk assessments and sanctions screenings.

## Risk assessment latest lookup

`GET /api/risk-assessments/[entityType]/[entityId]/latest` returns the newest `RiskAssessment` row for an entity, ordered by `createdAt desc`. It returns `404` when no assessment exists so callers can distinguish a missing result from an empty list.

## Automatic hold

`POST /api/risk-assessments/[id]/auto-hold` applies a hold marker to the assessment when its `riskScore` is at or above the configured threshold. The current Prisma schema does not include a separate hold table, so the endpoint records the idempotent hold metadata in `signals.autoHold` and sets `status` to `hold_applied`.

## Sanctions screening upsert

`GET /api/sanctions-screenings?userId=...` returns one user's screening row. `POST /api/sanctions-screenings` upserts the single `SanctionsScreening` row per user and calculates `clear`, `under_review`, or `flagged` status from the documented match score thresholds.

## Expiring screenings

`GET /api/sanctions-screenings/expiring?days=30` lists screenings whose `expiresAt` is in the future and inside the lookahead window. Already-expired rows are excluded from this scheduled re-screening list.