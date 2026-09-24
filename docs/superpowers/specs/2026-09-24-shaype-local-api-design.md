# shaype-local-api — design

A cleanroom local re-implementation of the Shaype B2B Operations API for end-to-end testing of code that integrates with Shaype. Runs on a developer machine, keeps state in SQLite, behaves like the real platform for the in-scope domains, and pushes webhook notifications to the system under test.

This document is the ground truth for implementers. Per-domain field lists, enums, transitions and source citations live in `docs/map/<domain>.md` (verified against the spec), and the cross-domain reconciliations in `docs/map/00-*.md` (balance model, transaction model, status enums, webhook trigger matrix, open questions with recommended defaults); this document fixes the architecture, cross-cutting conventions and every decision the spec leaves open. Where this document and a map or critic note disagree, this document wins. Tags: `[spec]` from the OpenAPI file, `[docs]` from developer.shaype.com, `[decision]` chosen here.

## 1. Goals and non-goals

- Faithful: same paths, request/response shapes, status codes and `ErrorResponse` envelope as `spec/b2b-operations-api.json`; same webhook payloads as `spec/notification-webhooks.json`.
- Stateful: customer → account → card → transactions → balances, with the documented state machines and balance arithmetic.
- Testable: deterministic ids where useful, a virtual clock, an admin API to reset state and inspect webhooks, synchronous-by-default async effects.
- Not goals: scale, security hardening, multi-currency wallets beyond response shapes, the end-user Authentication API, the External Authorisation callback (Shaype → client balance checks), the Batch API, GraphQL, rate limiting.

## 2. Scope by domain

| Domain (folder) | Tags | Ops | Fidelity |
|---|---|---|---|
| customers | Customers API | 11 | full |
| accounts (+products) | Accounts API (excl. transfers, holds), Products API | 23 | full |
| transactions | Transactions API, Holds API, `getPendingHolds`, `makeTransferV0/V1` | 12 | full |
| cards | Cards API | 19 | full |
| utilities | Utilities API | 13 | full (mock generators drive the ledger + webhooks) |
| payid-npp | PayID API, NPP API | 9 | full |
| bpay | BPAY API | 6 | full |
| direct-entry | Direct Debits API, Direct Entry API, Scheduled Payments API | 10 | full |
| groups-stacks | Groups API, Stacks API | 15 | full |
| kyc | KYC API | 4 | full |
| payto | PayTo API | 22 | full |
| stubs | Perks, FX, Liquidity, Click to Pay, Tokens, Merchant Category Codes | 25 | spec-shaped deterministic responses (`src/stubs`) |

Total 169. `getAllProducts` and `getAllMerchantCategoryCodes` return seeded reference data.

## 3. Architecture

Node 22, TypeScript strict, ESM, Fastify 5, better-sqlite3, jose, Vitest. Single package, CLI `shaype-local`.

```
spec/                      vendored OpenAPI files (source of truth)
scripts/gen-contract.ts    spec -> src/contract/generated/* (routing table, ajv schemas, TS types)
src/
  cli.ts                   flags/env -> buildServer -> listen
  server.ts                buildServer(config): Fastify + schemas + hooks + domains + stubs + admin; asserts 169/169 routed
  config.ts                Config, defaults, CLI/env parsing
  context.ts               AppContext { config, db, clock, log, events, webhooks, services, handled }
  contract/                index.ts (loader), route.ts (defineRoute)
  db/                      openDatabase, registerSchema, resetDatabase, nextSeq
  lib/                     errors (ApiError + ErrorResponse), clock, ids, money, idempotency
  events/                  bus.ts (DomainEvents), webhooks.ts (dispatcher), notify.ts (envelope helpers)
  auth/                    token.ts (HS256 JWT), routes.ts (/oauth2/token), hook.ts (403 guard)
  admin/routes.ts          /_admin/*
  stubs/                   example.ts (schema -> example), index.ts (register leftovers)
  domains/<name>/          schema.ts, repo.ts, service.ts, routes.ts, events.ts, index.ts
  domains/index.ts         imports every domain and calls register() in dependency order
test/                      one file per domain + contract/auth/webhooks + scenario tests
```

### 3.1 Contract layer

`gen-contract` emits, per operation: method, Fastify url, `params`/`querystring`/`body` JSON Schemas and a `responses` map, with `$ref`s rewritten to shared schema ids (`req:<Name>` keeps `required` for validation; `res:<Name>` drops `required` so the serializer never throws on optional fields). Conversions: `nullable` → union type, boolean `exclusiveMinimum` → numeric, 45 comma-joined single-value enums split, duplicate enum values removed, OpenAPI-only keywords dropped. `defineRoute(app, ctx, operationId, handler)` attaches those schemas, so Fastify validates input (400) and serializes output through the success schema (unknown fields are stripped, shapes are guaranteed). Only the success schema and the six domain-specific 4xx schemas are compiled per route; `ErrorResponse` bodies come from the error handler.

Optional request bodies (`bodyRequired: false`, 5 ops) are not validated at the route level; handlers validate them when present.

### 3.2 Request lifecycle

1. `onRequest` auth hook: `/v0/*` and `/v1/*` require `Authorization: Bearer <jwt>`; otherwise 403 `ErrorResponse` (the spec declares 403 on every op and never 401) `[decision]`. `--no-auth` disables.
2. Schema validation → 400 `ErrorResponse` with `message: "BAD_REQUEST: <ajv message>"`.
3. Handler → service → repo (synchronous better-sqlite3 calls inside `db.transaction()` for multi-row changes).
4. Services emit domain events on the bus; domain `events.ts` mappers turn them into notifications via `notify.ts`; the dispatcher POSTs after the response is sent.
5. Errors: `ApiError(status, message[, body])` → `ErrorResponse` (or the declared domain body); unknown → 500.

### 3.3 Storage

better-sqlite3, `:memory:` default or a file (`--db ./shaype.db`, WAL). Each domain contributes DDL through `registerSchema()` at import time; `openDatabase()` applies all DDL idempotently. Rows keep scalar columns for anything filtered/sorted plus `TEXT` JSON columns for nested blobs (`address`, `customData`, `customerDetails`). Money is `INTEGER` minor units. `/_admin/reset` truncates every table and resets the clock.

### 3.4 Events and webhooks

`DomainEvents` is the single event stream. Rule: a service emits exactly one event per state change, at the point of commit, never from a route handler. `notify.v0(ctx, { customerHayId, type, actionOwner, ...eventProps })` builds a `NotificationDto` (adds `idempotencyKey`), `notify.v1(...)` a `NotificationDtoV1`, and both hand the payload to `WebhookDispatcher.enqueue`. Envelopes use the compact form: absent event properties are omitted, not `null` `[decision]`. `actionOwner` is `CLIENT` when an API call caused the change and `PLATFORM` for asynchronous platform behaviour. Delivery: POST to `<webhookUrl>/api/hay/v0|v1/communications/notification`; retry on 401/403/429/5xx/network error/timeout (`--webhook-timeout-ms`, default 10 s) with doubling backoff on the real clock (`--webhook-backoff-ms`, `--webhook-max-attempts`), unaffected by the virtual clock; other 4xx are terminal. Rows left queued in a file database resume at startup. Every notification is persisted and inspectable at `/_admin/notifications` regardless of delivery.

### 3.5 Asynchrony

Shaype performs some effects asynchronously (onboarding outcome, card settlement, DE status progression, account-closure cascade). Locally these run after `config.asyncDelayMs` (default 0 → next macrotask via `setTimeout(0)`), through `ctx.scheduler.later(fn, ms)` in `src/lib/scheduler.ts`; timers are `unref`'d and cancelled on close/reset. Time-driven effects (card expiry, scheduled payments, rule expiry) are evaluated lazily by `tick()` functions that domains register with the scheduler; `tick()` runs on every admin clock change and on each request (cheap indexed queries).

### 3.6 Services registry

Domains register singletons in `ctx.services` (typed via module augmentation of `ServiceMap` in `src/context.ts`) so later domains can call earlier ones without import cycles: `ctx.services.customers.get(id)`, `ctx.services.accounts.post(...)`, `ctx.services.transactions.post(...)`, `ctx.services.cards.byToken(...)`, `ctx.services.payid.resolve(...)`. Registration order is the dependency order in `domains/index.ts`.

## 4. Cross-cutting conventions (decisions)

| Topic | Decision |
|---|---|
| Ids | v4 UUIDs. Path params declared `format: uuid` are validated by schema (400). Unknown entity → 404 `ErrorResponse`, message `NOT_FOUND: <Entity> <id> not found` `[decision]` (spec declares 404 on only two perks ops). |
| 400 vs 422 | 400 = malformed JSON, schema violation, bad uuid/enum. 422 = business rule (state, balance, limit, permission, uniqueness). Message format `<REASON_CODE>: <text>` following the four documented samples (`PERMISSION_DENIED:`, `NOT_FOUND:`). 409 only where declared (`createBPayBiller` duplicate). |
| ErrorResponse | `{ message, details: "Please refer to the API documentation or contact Shaype for more info with the traceId.", status: "<code>", traceId: <uuid> }`. |
| Idempotency | Body `idempotencyKey` (18 create ops). Scope = operationId. Same key + identical body → replay the stored status and body. Same key + different body → 422 `IDEMPOTENCY_KEY_REUSED`. Helper `withIdempotency(ctx, operationId, key, body, fn)` in `src/lib/idempotency.ts`. |
| Pagination | Legacy `offset`/`limit`: both required (schema), `limit` 1..1000 else 400; results are bare arrays with no total. Perks flavour: defaults 20, max 100. `getMandates`: `pageNumber` (1-based)/`pageSize` ≤ 50 with `{ result, totalCount }`. Lists are ordered by creation time ascending unless the op defines `sortBy`. |
| Search | Filters AND-ed; string filters exact, case-insensitive; empty filter body returns all (paged). |
| Money | Internal `INTEGER` cents; JSON `number` with ≤ 2 dp (`fromCents`). Sign in webhook `currencyAmount.amount`: negative for debits/holds/settlements, positive for credits/refunds/reversals. Request amounts on create ops are magnitudes; direction comes from the op. |
| Currency | Accounts are AUD unless `currency` is supplied (31-value create enum). No FX. |
| Time | `*DateTimeUtc` rendered by `isoUtc()` (microsecond `Z` form). `format: date` fields as `YYYY-MM-DD`. All times from `ctx.clock`. |
| Phone | `countryCodePrefix` stored without leading `+`. |
| Nullable | Omit absent optional fields; emit `null` only for explicitly-null nullable fields. |
| Account numbers | BSB `636220` for every local account; account numbers 8 digits from a sequence (`10000001`, …) unless the client supplies one. Uniqueness enforced (422 `DUPLICATE_ACCOUNT_NUMBER`). |
| Deprecated ops | Served exactly like their replacements (v0 create credit/debit collapses detailed limit outcomes into `REFUSED_LIMIT_BREACH`). |
| 501 | Never returned. |
| Contract fidelity | Responses follow the declared schema literally. Deviate only where the literal contract cannot carry the documented flow (e.g. `retrieveBillers` declares one `BPayBillerResponse` but is a paged list → return the array), and record each deviation in the domain's `index.ts` header comment. |
| Enum values | An out-of-enum value is a schema violation → 400 (the critics' notes suggest 422; the spec decision is 400 because Fastify validation produces it uniformly). |
| Outcome enums | Each surface uses its own enum verbatim: REST `TransactionOutcome.outcome` has `REFUSED_INSUFFICIENT_FUNDS`, the webhook `TransactionEventDto.outcome` has `REFUSED_NOT_ENOUGH_FUNDS`; BPAY REST uses `REFUSED_DAILY_BPAY_LIMIT_BREACHED`, webhook `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`. |

## 5. Domain model

### 5.1 Customers

- `createHayCustomer` → `PENDING_APPROVAL`, `creationDateTimeUtc = now`, `tier` mirrors `customerTier`, defaults `deviceId: "NOT_SPECIFIED"`. Uniqueness per `email`, `phoneNumber`, `(identityDocumentType, identityDocumentNumber)`, `(firstName, lastName, dateOfBirth)` among customers that are not `INACTIVE` with reason `CUSTOMER`/`OPERATIONAL` → 422 `DUPLICATE_CUSTOMER`.
- Onboarding outcome is asynchronous (`scheduler.later`): default → `ACTIVE`, emit `ONBOARDING_PASSED` then `CUSTOMER_STATUS_UPDATED` (`actionOwner: PLATFORM`). Test steering `[decision]`: email local-part tag `+referred` → `REFERRED` + `ONBOARDING_FAILED` (`failedStage: KYC_AML_SCAN`), `+rejected` → `REJECTED` + `ONBOARDING_FAILED` (`DOCUMENT_SCAN`), `+pending` → stays `PENDING_APPROVAL` (client drives status via `changeHayCustomerStatus`).
- `changeHayCustomerStatus` accepts any enum value (spec) except leaving `INACTIVE` → 422 `INVALID_STATE`; emits `CUSTOMER_STATUS_UPDATED`.
- `blockCustomer` → `BLOCKED` (`blockedBy: CLIENT`), `unblockCustomer` → `ACTIVE` (422 if not `BLOCKED`); both emit `CUSTOMER_STATUS_UPDATED`. Blocking a customer does not block accounts/cards `[docs]`.
- `updateCustomer` → `CUSTOMER_DETAILS_CHANGE` with the four change booleans; propagates name to the customer's PayIDs unless `skipPayIdUpdate`.
- `getAllCustomers`/`searchCustomers` paged; `getAccountsForCustomerId`, `getCardsForCustomerId` delegate to other services.
- Customer becomes `INACTIVE` (with `statusReason` from the closure `reason`) when its last non-`CLOSED` account closes (async cascade owned by accounts).

### 5.2 Accounts, products, limits, rules

- Product: one seeded product `LOCAL_PRODUCT_ID = "a1b2c3d4-0000-4000-8000-000000000001"` ("Local Everyday Account", AUD) with product-level limits (below). `getAllProducts` lists it. Unknown `productId` on create → 422 `PRODUCT_NOT_FOUND`.
- `createAccount` (v1) / `createHayAccount` (v0) / `createHayAccountForGroup`: holder must exist and be `ACTIVE` (group: all members `ACTIVE`) → 422 `PERMISSION_DENIED: ...` with the documented messages; status `APPROVED`; risk level per `config.defaultRiskLevel` (default `HIGH`, faithful to docs; set `LOW` via `PATCH /v0/accounts/{id}/riskLevel` or `--default-risk-level LOW`); balances 0; emits `ACCOUNT_STATUS_CHANGE` (`APPROVED`, `PLATFORM`).
- Balance fields (cents on the row: `ledger` = net settled postings including money in stacks, `held`, `locked`, `stacks`, `overdraft_limit`; see `docs/map/00-balance.md` §1.2 for the full derivation):
  - `totalBalance = ledger + overdraftLimit` (spec: total "will also include unused overdraft limit")
  - `overdraftBalance = max(0, min(-ledger, overdraftLimit))`
  - `technicalOverdraftBalance = max(0, -ledger - overdraftLimit)`
  - `availableBalance = totalBalance - held - locked - stacks`
  - `heldBalance`, `lockedBalance`, `stacksBalance`, `overdraftLimit` reported positive.
  - Funds check for any debit or hold: `amount <= availableBalance`. `MAX_BALANCE` compares `ledger + amount`. Closure check `ACCOUNT_BALANCE_TOTAL` tests `ledger == 0` (not `totalBalance`).
  With `overdraftLimit = 0` these reproduce every documented sample (hold: total unchanged, held +a, available −a; settlement: total −s, held −h; refund/credit: total and available +x).
- Status machine: `APPROVED → ACTIVE` on the first posting (any settled transaction) `[docs]`; `ACTIVE ↔ ACTIVE_IN_ARREARS` when `technicalOverdraftBalance > 0`; `blockAccount` → `LOCKED` (`blockedBy: CLIENT`; also blocks the owning customer unless `accountBlockStyle: ACCOUNT_ONLY`; idempotent); `unblockAccount` → `ACTIVE`; `closeAccount` → 202 then async `CLOSED` when `ledger == held == locked == stacks == 0` (else 422 `CloseAccountResponse` with `ClosureCheckerError`s), cancels linked cards (`INACTIVE`, `CARD_STATUS_CHANGE`), sets the customer `INACTIVE` if it was the last open account. Every status change emits `ACCOUNT_STATUS_CHANGE` with `LOCKED` rendered as `BLOCKED` in the webhook enum.
- Movements on a `LOCKED`/`CLOSED` account are refused (`REFUSED_ACCOUNT_BLOCKED` / `REFUSED_ACCOUNT_CLOSED`).
- Limits: effective = account-level if set else product-level; account-level may not exceed product-level (422). Risk level `HIGH` ⇒ every limit is 0 ⇒ all movements refused `[docs]`. Daily limits use a rolling 24 h window over posted transactions of the matching kind; `MAX_BALANCE` compares `ledger + amount`; `TOTAL_SPEND_PER_YEAR` rolling 365 days. Product defaults `[decision]`: `MAX_BALANCE` 1,000,000; `CARD_PAYMENTS_DAILY` 50,000; `SINGLE_CARD_TRANSACTION` 20,000; `ATM_WITHDRAWAL_PER_DAY` 5,000; `TOP_UP_PER_DAY` and `BANK_TRANSFER_TOP_UP_PER_DAY` 100,000; `BPAY_DAILY_LIMIT`, `DIRECT_DEBIT_PER_DAY`, `PAYMENT_TO_ACCOUNT_NUMBER` 50,000; `TOTAL_SPEND_PER_YEAR` 10,000,000. Outcome mapping per `docs/map/transactions-holds.md` §4.4.
- Rules (`MERCHANT_CODE_BLOCK`, `MERCHANT_ID_BLOCK`, `MERCHANT_NAME_BLOCK`): evaluated on card authorisations; a hit refuses with `REFUSED_RULES` and the `TRANSACTION` webhook carries `ruleDetails`. `expiresAtUtc = created + expiresIn`; expired rules are reported `disabled: true`.
- Custom data: create/delete replace/remove the whole `customData` object; `getHayAccount?expand=customData` includes it, other reads omit it `[docs]`.
- Risk level, max balance, overdraft limit, CoP opt-out: simple stored attributes.

### 5.3 Transactions and holds (the ledger)

- `FinancialTransaction` rows are immutable postings. `post({ accountId, amountCents (signed), type, channel, counterpart, description, reference, originType, originId, relatedHoldId, transactionTimeUtc })` checks account status, limits and funds (`amount ≤ availableBalance` for debits), updates `ledger`, sets `rollingAccountBalance = totalBalance after`, flips `APPROVED → ACTIVE`, emits `transaction.posted`. Refusals return an outcome and post nothing.
- Holds (`AuthorisationHold`, internal state `AUTHORISED | SETTLED | REVERSED | CANCELLED`): `authorise` (held +a, available −a, webhook `TRANSACTION`/`CARD_TRANSACTION`/`isPending: true`, `transactionHayId == holdHayId`), `increase` (same id, new total), `decrease` (`CARD_TRANSACTION_REFUND` pending, positive amount), `reverse`, `settle(s)` (releases the whole hold, posts −s as a new transaction with `relatedHoldHayId`, `CARD_TRANSACTION_SETTLED`). No expiry.
- `createCreditTransactionV1/V0`, `createDebitTransactionV1/V0`: idempotent by key; `TransactionOutcome { outcome, transactionId }`; webhook `TRANSACTION` with `transactionType` `GENERAL_CREDIT`/`GENERAL_DEBIT`.
- `makeTransferV1/V0`: `transferType ACCOUNT` with BSB `636220` → internal transfer (both accounts posted, `INTRABANK_TRANSFER_OUT` to sender's customer and `INTRABANK_TRANSFER_IN` to the recipient's); other BSB → `INTERBANK_TRANSFER_OUT` posted immediately (NPP); `INTERNAL` (`recipientAccountHayId`) → internal; `PAY_ID` → resolve through `services.payid`, unknown → `REFUSED_INVALID_PAY_ID`. Daily transfers-out limit → `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED`.
- `searchTransactions` (required date range, optional filters, `sortBy`), `getTransactionById`, tags (`ADD` idempotent, `REMOVE` no-op when absent, key `(category, value)`), `getAuthorisationHold`, `getPendingHolds` (open holds only).

### 5.4 Cards

- `createHayCard`: customer `ACTIVE` and account open → 422 otherwise; `PHYSICAL` → `AWAITING_ACTIVATION`, `VIRTUAL` → `ACTIVE`; `cardToken` 9 digits from a sequence, PAN from `cardPan()` (only `lastFourDigits` exposed), `expiryDate` = last day of the month 4 years from issue `[decision]`, `nameOnCard` default rule from docs, preferences defaults from spec (`cardEnabled true, mobileWalletPaymentsEnabled true`, rest false), PIN stored hashed, CVV tries 3. Emits `CARD_STATUS_CHANGE`.
- Transitions exactly as `docs/map/cards.md` §3; undocumented ones `[decision]`: `AWAITING_ACTIVATION → BLOCKED/INACTIVE` allowed; `BLOCKED → INACTIVE` (cancel) allowed; re-issue allowed from `ACTIVE`/`BLOCKED`/`EXPIRED`; renew only within 2 months of expiry and from `ACTIVE`; convert only `VIRTUAL`+`ACTIVE`. Invalid → 422 `INVALID_CARD_STATUS`.
- Expiry `tick()`: `ACTIVE`/`AWAITING_ACTIVATION` cards past `expiryDate` → `EXPIRED` (`PLATFORM`), reminders `REMINDER`/`CARD_EXPIRY_*` at 1 month, 2 weeks, 1 day (each once). `changeCardExpiryDate` (utilities) moves the date.
- Authorisation checks used by the ledger/utilities: status `ACTIVE`, `cardEnabled`, channel preference (`contactless`, `cardNotPresent`, `cashWithdrawal`, `magneticStripe`), PIN/CVV blocked state, account rules; refusal reasons map to the `TRANSACTION` webhook `outcome`.
- Digital wallets, OEM provisioning, rewards, click-to-pay: minimal stored state with spec-shaped responses.

### 5.5 Utilities (mock generators)

Each generator resolves the card by `cardToken`/`cardId`, runs the authorisation checks, and drives the ledger and webhooks exactly as `docs/map/webhooks.md` §4.4: `generateAuthHold`, `generateCardTransaction` (hold then settlement after `settlementDelayInSeconds` on the virtual clock, or `asyncDelayMs` when 0), `generateHoldAndUpdateHoldTransactions`, `generateRefundTransaction`, `generateAtmTransaction`, `generateInboundNppTransaction`/`V2` (`INTERBANK_TRANSFER_IN`), `generateInboundDeTransaction` (CREDIT → `INTERBANK_TRANSFER_IN`, DEBIT → `DIRECT_DEBIT_TRANSFER`, RETURN/REFUSAL → `DIRECT_ENTRY`), `generateMandateNotificationForInitiator/Payer` (`MANDATE`), `generateReceiveAPaymentInstruction` (`MANDATE_PAYMENT`), `changeCardExpiryDate`, `createStubForMandateSearchPaymentInstructions` (stores instructions for `searchPaymentsInstructions`). `declineReason` values force the matching refusal.

### 5.6 PayID and NPP

PayIDs per account with the documented statuses/transitions; `resolvePayId` returns the local account for registered PayIDs; `getPayIdAvailability` true unless registered locally; deregister history recorded. `verifyBranchIdentifier`: every 6-digit BSB is eligible except `999999` `[decision]`; malformed → 422 with the documented message.

### 5.7 BPAY

Billers per account (duplicate biller code + CRN → 409). `validateBpay` accepts any 4–10 digit biller code with a CRN that passes the length rule, refusing biller code `000000` `[decision]`. `makeBpayPayment` posts `BPAY_TRANSFER_OUT` via the ledger and emits `TRANSACTION` with `counterpartDetails.bpayDetails`.

### 5.8 Direct entry and scheduled payments

`createDirectDebitV1/V0` creates an outbound DE instruction (`RECEIVED` → `ACCEPTED` synchronously, then `SUBMITTED` → `COMPLETE` via the scheduler) emitting `DIRECT_ENTRY` per status and posting `DIRECT_DEBIT_TRANSFER` on completion; list/get by date range and status. `getDirectEntryStatusV1` reads the same rows. Scheduled payments are created only through Shaype's portal, so locally they are created through `POST /_admin/scheduled-payments` `[decision]`; `tick()` executes due payments through the ledger and cancellation works as documented.

### 5.9 Groups and stacks

Groups (`PERSONAL`/`BUSINESS`) with member customers; group accounts require all members `ACTIVE`; add/remove members; removal cascades the customer to `INACTIVE` when only closed accounts remain. Stacks per account: `stacks` balance moves on transfer-in/out/stack-to-stack, `closeStack` returns funds, stack transactions listed with paging, `MAX_BALANCE` counts stacked funds, stacked funds are never spendable.

### 5.10 KYC

`createCase` stores a verification case (returns `caseId`); the three approval endpoints mark the corresponding check approved on a `REFERRED` customer and, once every failed check is approved, set the customer `ACTIVE` (`CUSTOMER_STATUS_UPDATED`, `ONBOARDING_PASSED`) `[decision]`. Approving on a non-`REFERRED` customer → 422 `INVALID_STATE`.

### 5.11 PayTo

Mandates (initiator and payer sides) with the statuses and transitions in `docs/map/payto.md` §3, both mandate id encodings accepted, `getMandates` paged with `totalCount`, actions log per mandate, adhoc payments recorded as payment instructions (`RJCT` by default in staging per the spec description; `ACCP` when the debtor is a local account with funds `[decision]`), and the two mock notification generators emitting `MANDATE`/`MANDATE_PAYMENT`.

## 6. Admin API (`/_admin`, no auth)

`GET /health`, `GET /operations` (handled vs stubbed), `POST /reset`, `GET|POST /clock` (`{ set | freeze | advanceMs | reset }`), `GET /notifications?type&status&sinceSeq&limit&order`, `DELETE /notifications`, `GET /notifications/:id`, `POST /notifications/:id/redeliver`, `POST /notifications/flush` (await idle), `POST /scheduled-payments`.

## 7. Testing

- Contract: every operation routed; GET operations without required query answer their success status; response bodies of scenario tests validated against the `res:` schema by test-only `preSerialization` (object bodies, before the serializer coerces them) and `onSend` (string bodies) hooks; undeclared statuses: `>= 400` against `ErrorResponse`, `2xx` refused.
- Domain: Vitest per domain using `app.inject`, TDD, covering each transition table row and each refusal outcome.
- Webhooks: payloads validated against `wh:NotificationDto` in tests; trigger matrix rows asserted.
- Scenario: onboard → account → risk LOW → card → activate → mock purchase (hold, settlement) → refund → transfer → BPAY → close, asserting balances and the webhook sequence delivered to a test receiver.

## 8. Configuration

Flags/env as printed by `--help`, plus `--default-risk-level HIGH|LOW` (`SHAYPE_LOCAL_DEFAULT_RISK_LEVEL`) and `--async-delay-ms`.
