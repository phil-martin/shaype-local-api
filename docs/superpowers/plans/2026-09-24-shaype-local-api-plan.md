# shaype-local-api — implementation plan

Spec: `docs/superpowers/specs/2026-09-24-shaype-local-api-design.md`. Maps: `docs/map/*.md`.

## Conventions every task follows

- Domain folder `src/domains/<name>/` with `schema.ts` (DDL via `registerSchema`), `repo.ts`, `service.ts`, `routes.ts` (`register(app, ctx)` using `defineRoute`), `events.ts` (event map augmentation + webhook mappers), `index.ts`. Register services in `ctx.services.<name>`.
- Tests in `test/<name>.test.ts` via `startApp()` from `test/helpers.ts`; TDD; `npm test` green before commit; commit per task with a descriptive message.
- Never edit another domain's folder in parallel phases; shared additions go in `src/lib` only when unavoidable and must be additive.
- Read the domain map(s) fully before coding; the spec's decisions override the maps' open questions.

## Phase A — foundation (sequential)

A0. Core additions (done before fan-out): `ctx.services`, `src/lib/scheduler.ts`, `src/lib/idempotency.ts`, `src/events/notify.ts`, domain skeletons, `--default-risk-level`.
A1. customers (+ `lib/idempotency` tests, onboarding scheduler, uniqueness, webhooks CUSTOMER_*/ONBOARDING_*).
A2. accounts + products (entity, balances model, status ops, limits, rules, risk, custom data, search, block/close cascade, ACCOUNT_STATUS_CHANGE).
A3. transactions (ledger posting engine, holds, credit/debit create, transfers, search, tags, holds endpoints, TRANSACTION webhooks).

## Phase B — parallel domains (worktrees, one agent each)

B1 cards · B2 payid-npp · B3 bpay · B4 direct-entry (+ scheduled payments + admin create) · B5 groups-stacks · B6 kyc · B7 payto.

## Phase C — after B merges (parallel)

C1 utilities (mock generators; depends on cards, transactions, payto, direct-entry) · C2 scenario tests + response-schema `onSend` validator + README usage docs.

## Phase D — review

Adversarial review workflow over the whole tree (correctness vs maps/spec, webhook payload shapes, balance arithmetic), fix, final green run, tag v0.1.0.
