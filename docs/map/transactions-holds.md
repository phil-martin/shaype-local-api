# transactions-holds

Domain: Shaype B2B Operations API, tags **"Transactions API"** ("Set of APIs related to managing Transactions" [spec]) and **"Holds API"** ("Set of APIs related to managing card Authorisation Holds" [spec]). 9 operations. Source labels: [spec] = b2b-operations-api.json, [spec:webhooks] = notification-webhooks.json, [spec:external-balance] = external-balance.yaml, [docs:<slug>] = developer.shaype.com page, [inferred] = not stated by any source.

## 1. Operations

Nine operations (verified with the `jq` filter over ops.json: 8 tagged "Transactions API", 1 tagged "Holds API"). Common to all nine [spec]:

- Every operation declares responses `400` Bad Request, `403` Forbidden, `422` Unprocessable Content, `500` Internal Server Error, `501` Not Implemented, each with body `ErrorResponse` (`details`, `message`, `status`, `traceId` — see section 2). No operation declares `404`, `409` or `201`.
- Success is always `200`.
- The spec declares no `securitySchemes` and no global `security`; auth is handled by the separate Authentication API (out of scope here). The `403` response is present on every op but the spec gives no per-op condition for it — [inferred] it is the generic "caller not permitted / wrong client" response.
- Example of the real error body shape, taken from another endpoint's example in the same spec [spec: `/v0/customers/{customerHayId}/account` 422 example]:
  `{"message":"PERMISSION_DENIED: Account cannot be created for customer with id … as their status is currently BLOCKED","details":"Please refer to the API documentation or contact Shaype for more info with the traceId.","status":"422","traceId":"b24daeb7-4242-4ff1-ba50-9825d5deedd8"}` — note `status` is a **string**, and `message` is prefixed with an upper-snake code followed by `: `.

The four "create transaction" operations share one request body (`CreateTransactionRequestBody`) and one response body (`TransactionOutcome`), so those are described once under the first op and referenced after.

### POST /v0/transactions/credit/create (createCreditTransactionV0)

**Purpose:** Create a general-purpose credit (funds in) on an account. **DEPRECATED** — `"deprecated": true` [spec]; summary "Create Credit Transaction for Account (DEPRECATED)".

**Deprecation note (verbatim spec description):** "If a limit is breached, REFUSED_LIMIT_BREACH outcome will be returned. To get the detailed limit that has been breached please use V1 of this endpoint. That will return one of the below outcomes instead of REFUSED_LIMIT_BREACH: REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED, REFUSED_MAX_BALANCE_EXCEEDED." [spec]

**Path/query params:** none.

**Request body:** `CreateTransactionRequestBody` (required) — "A body of a request to create a transaction." [spec]

| field | type | required | constraints / enum | description (spec) |
|---|---|---|---|---|
| `accountHayId` | string (uuid) | yes | — | Unique identifier (UUID) of the Account |
| `amount` | number | yes | "to 2 decimal places" (description only; no `multipleOf`/`minimum` in schema) | Value of the Transaction, to 2 decimal places |
| `category` | string | no | — | Category assigned to the Transaction |
| `counterpartName` | string | yes | `minLength: 1` | Counterpart name |
| `description` | string | yes | `minLength: 1` | Description on the Transaction |
| `idempotencyKey` | string (uuid) | yes | — | Unique value (UUID) used to identify this request and used to recognise any subsequent retries |
| `originChannel` | string | no | enum: `ATM_CASH`, `POS_DEBIT`, `VENUE` | Origin source of the Transaction (only applicable if specifically used by Client) |
| `originId` | string (uuid) | no | — | Additional identifier applied to Transaction related to origin of the request |
| `originType` | string | no | enum: `CUSTOMER`, `SCHEDULED_PAYMENT`, `HAAS_OPERATIONS`, `OPERATIONS`, `DIRECT_DEBIT` | Initiator origin of the Transaction (CUSTOMER: initiated by a customer; SCHEDULED_PAYMENT: by a schedule; HAAS_OPERATIONS: by Client Operations team; OPERATIONS: by Shaype Operations team; DIRECT_DEBIT: by Direct Debit) |
| `reference` | string | no | description says "maximum 35 alphanumeric characters in length" but the schema carries **no** `maxLength`/`pattern` | Reference on the transaction (only applicable to NPP transactions) |
| `transactionChannel` | string | yes | enum (7, verbatim order): `LOAN_REPAYMENT`, `MANUAL_ADJUSTMENT`, `INTEREST_ADJUSTMENT`, `LOAN_ADJUSTMENT`, `ACCOUNT_ADJUSTMENT`, `SERVICE_FEE`, `APPLE_REWARD` | "Transaction channels available for use by Shaype Clients" |

No request field carries `nullable: true` [spec]. There is no `currency` field — [inferred] the transaction is in the account's currency.

**Response 200:** `TransactionOutcome` — "Transaction outcome details" [spec]; no `required` list.

| field | type | enum |
|---|---|---|
| `outcome` | string | 21 values, verbatim order: `ACCEPTED`, `INTERNAL_ERROR`, `REFUSED_LIMIT_BREACH`, `REFUSED_FRAUD`, `REFUSED_CUSTOMER_PREFERENCE`, `REFUSED_INSUFFICIENT_FUNDS`, `REFUSED_ACCOUNT_BLOCKED`, `REFUSED_RECIPIENT_ACCOUNT_BLOCKED`, `REFUSED_ACCOUNT_CLOSED`, `REFUSED_RECIPIENT_ACCOUNT_CLOSED`, `REFUSED_INVALID_PAY_ID`, `UNKNOWN`, `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED`, `REFUSED_MAX_BALANCE_EXCEEDED`, `REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_NET_VISA_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_NON_SCHEME_DAILY_LIMIT_BREACHED`, `REFUSED_SENDER_ACCOUNT_NOT_VERIFIED`, `REFUSED_CAPABILITY_NOT_ENABLED`, `REFUSED_QUOTE_EXPIRED` |
| `transactionId` | string (uuid) | — "Unique identifier (UUID) of the Transaction". **Note the name**: `transactionId` here, but `transactionHayId` everywhere else (path params, `FinancialTransaction`, webhooks). [spec] |

The `outcome` description text lists 18 bullet values; the `enum` array has 21 (the last three — `REFUSED_SENDER_ACCOUNT_NOT_VERIFIED`, `REFUSED_CAPABILITY_NOT_ENABLED`, `REFUSED_QUOTE_EXPIRED` — are in the enum only) [spec].

**Behaviour:**

- Refusals are **HTTP 200** with a `REFUSED_*` outcome, not HTTP errors — the v0 description says "REFUSED_LIMIT_BREACH outcome will be returned" [spec]. HTTP 400/422 are for malformed/unprocessable requests, not business refusals [inferred from the split between `TransactionOutcome` on 200 and `ErrorResponse` on 4xx].
- Precondition — account state: `REFUSED_ACCOUNT_BLOCKED` "Transaction declined as the account is currently blocked"; `REFUSED_ACCOUNT_CLOSED` "Transaction declined because the account has been closed" [docs:payment-transaction-outcome]. Mapping to `HayAccount.status`: blocked ⇒ `LOCKED`, closed ⇒ `CLOSED` [inferred; HayAccount.status enum is `ACTIVE`, `ACTIVE_IN_ARREARS`, `APPROVED`, `CLOSED`, `DORMANT`, `LOCKED`, `PENDING_APPROVAL` [spec]]. Whether `APPROVED`/`DORMANT`/`PENDING_APPROVAL` accounts accept credits is unspecified (open question).
- Limit checks (credit direction): a credit that would push the balance over `MAX_BALANCE` ⇒ `REFUSED_MAX_BALANCE_EXCEEDED` ("Transaction declined as it would exceed the account's maximum balance MAX_BALANCE limit") [docs:payment-transaction-outcome]; on v0 this is collapsed to `REFUSED_LIMIT_BREACH` [spec]. Daily limits are evaluated over a **rolling 24h window** including the current transaction [docs:account-limits]. Effective limit = account-level limit if set, else product-level [docs:account-limits]. An account at risk level `HIGH` has all limits set to 0, "which means setting an account to a HIGH risk level will prevent all outbound and inbound transactions" [docs:account-limits]. On multi-currency wallets `MAX_BALANCE` is aggregated across the account hierarchy at the margin-free cached FX rate [docs:limits-1].
- Fraud / rules / preferences: `REFUSED_FRAUD` (fraud detection) [docs:payment-transaction-outcome]; `REFUSED_CUSTOMER_PREFERENCE` is in the enum [spec] but no doc defines when a general credit hits it (open question).
- External-authorisation clients: for clients holding balances externally, the platform calls the client's `POST /transactions` with `authorisationTransactionType` `GENERAL_CREDIT` before accepting [spec:external-balance enum includes `GENERAL_CREDIT`, `GENERAL_DEBIT`]; the client answers 200 (accept) or `470` with `errorCode` ∈ {`REFUSED_MAX_BALANCE_EXCEEDED`, `REFUSED_NOT_ENOUGH_FUNDS`, `REFUSED_SENDER_ACCOUNT_NOT_VERIFIED`} [spec:external-balance `Response.errorCode` enum]; "any other response sent by the client will default to an outcome of INTERNAL_ERROR" [docs:external-authorisation-and-balance]; non-scheme timeout 10 s ⇒ `INTERNAL_ERROR` [docs:external-authorisation-and-balance]. Platform limit checks run **before** the client balance check and reject without calling the client if breached [docs:external-authorisation-and-balance].
- Idempotency: `idempotencyKey` is "used to identify this request and used to recognise any subsequent retries" [spec]. The spec does not say what a retry returns (same `TransactionOutcome`? an error?) nor what happens when the same key is reused with a different body (open question). [inferred] A retry with the same key must not create a second transaction.
- State changes on `ACCEPTED` [inferred from spec field descriptions and docs balance rules]: a `FinancialTransaction` is created with `transactionHayId` = response `transactionId`, `type` = `GENERAL_CREDIT` ("General purpose credit on Account" [spec FinancialTransaction.type]), `transactionChannel` = request value, `accountHayId`, `description`, `counterpartName`/`counterpartDetails.name`, `category`, `originChannel`, `originId`, `originType`, `reference` copied from the request; `transactionTimeUtc` and `clearingTimeUtc` set to now (posted immediately, not pending); `currencyAmount` = {`amount`, account currency}; `rollingAccountBalance` = "Total Account balance after the transaction posted to Account" [spec]. Account `totalBalance` and `availableBalance` increase by `amount` [inferred; see section 4].
- Sign convention of `amount`: not specified anywhere for this endpoint. [inferred] the request `amount` is a positive magnitude and the endpoint (credit vs debit) fixes the direction; in stored/emitted `currencyAmount.amount`, credits are positive and debits negative (webhook samples show holds/settlements as negative, refunds positive [docs:card-transactions]; external-balance `CurrencyAmount` is "Positive when crediting customer account and negative when debiting" [spec:external-balance]).
- Usage called out in docs: "To top up a staging account, use Create Credit Transaction for Account" [docs:simulates-card-transaction-on-staging]; Apple Pay reward payouts must use this endpoint (v1) with `transactionChannel` = `APPLE_REWARD` [docs:apple-reward-transactions].

**Webhook:** [inferred] a `TRANSACTION` notification (`NotificationDto.type` = `TRANSACTION`) whose `transactionEvent.transactionType` = `GENERAL_CREDIT` ("A general account credit" [spec:webhooks]), `isPending` = `false`, `outcome` = the outcome, `updatedBalance`/`accountBalances` populated (except for external-balance clients, where "accountBalances and updatedBalance … we won't be able to populate" [docs:external-authorisation-and-balance]). No doc explicitly states that the credit/debit endpoints emit a webhook — treat as inferred. Delivery: retried 18 times over up to 48 h on 401/403/429/5XX [docs:webhook-notification].

### POST /v0/transactions/debit/create (createDebitTransactionV0)

**Purpose:** Create a general-purpose debit (funds out) on an account. **DEPRECATED** — `"deprecated": true` [spec]; summary "Create Debit Transaction for Account (DEPRECATED)". Description is identical, verbatim, to the credit v0 description above [spec].

**Params / request / response:** identical to createCreditTransactionV0 — body `CreateTransactionRequestBody`, response 200 `TransactionOutcome` [spec].

**Behaviour (differences from credit):**

- Direction: debits reduce `totalBalance` and `availableBalance` by `amount`; resulting `FinancialTransaction.type` = `GENERAL_DEBIT` ("General purpose debit on Account" [spec]) [inferred].
- Funds check: debit exceeding available funds / `MIN_BALANCE` ⇒ refusal. The `TransactionOutcome` enum carries `REFUSED_INSUFFICIENT_FUNDS` [spec], whereas the docs and the webhook enum use `REFUSED_NOT_ENOUGH_FUNDS` ("Transaction declined as it would exceed the account's … MIN_BALANCE limit" [docs:payment-transaction-outcome]; webhook `outcome` enum has `REFUSED_NOT_ENOUGH_FUNDS` and **not** `REFUSED_INSUFFICIENT_FUNDS` [spec:webhooks]). Which string the HTTP response uses is therefore ambiguous (open question); `REFUSED_INSUFFICIENT_FUNDS` is the only one valid against the HTTP schema.
- Limits (debit direction): `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED` "Transaction declined because the daily limit for outgoing transfers has been exceeded" [docs:payment-transaction-outcome] — v0 collapses this to `REFUSED_LIMIT_BREACH` [spec]. `TOTAL_SPEND_PER_YEAR` ⇒ `REFUSED_ANNUAL_SPENDING_LIMIT_BREACHED` exists in the webhook enum but **not** in the HTTP `TransactionOutcome` enum [spec both]; `REFUSED_TOTAL_NON_SCHEME_DAILY_LIMIT_BREACHED` is in both.
- External-authorisation clients: platform calls client `POST /transactions` with `authorisationTransactionType` = `GENERAL_DEBIT`; client may refuse with `REFUSED_NOT_ENOUGH_FUNDS` (470) [spec:external-balance].
- Everything else (account-status refusals, idempotency, side effects, webhook `transactionType` = `GENERAL_DEBIT` [inferred]) as for credit.

### POST /v1/transactions/credit (createCreditTransactionV1)

**Purpose:** Current (non-deprecated) version of create-credit. Summary "Create Credit Transaction for Account"; no description [spec].

**Params / request / response:** identical to v0 — body `CreateTransactionRequestBody`, response 200 `TransactionOutcome` [spec].

**Behaviour:** as createCreditTransactionV0, except limit breaches return the **detailed** outcome rather than `REFUSED_LIMIT_BREACH`: `REFUSED_MAX_BALANCE_EXCEEDED` (credit direction) or `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED` [spec v0 description]. [inferred] v1 never returns `REFUSED_LIMIT_BREACH`. This is the endpoint the docs point clients at for Apple Pay rewards (`transactionChannel` = `APPLE_REWARD`) [docs:apple-reward-transactions] and for staging top-ups [docs:simulates-card-transaction-on-staging].

**Webhook:** as v0 [inferred].

### POST /v1/transactions/debit (createDebitTransactionV1)

**Purpose:** Current (non-deprecated) version of create-debit. Summary "Create Debit Transaction for Account"; no description [spec].

**Params / request / response:** identical to v0 — body `CreateTransactionRequestBody`, response 200 `TransactionOutcome` [spec].

**Behaviour:** as createDebitTransactionV0, except limit breaches return the detailed outcome (`REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED`, or `REFUSED_MAX_BALANCE_EXCEEDED` where applicable) instead of `REFUSED_LIMIT_BREACH` [spec v0 description].

**Webhook:** as v0 [inferred].

### POST /v0/transactions/search (searchTransactions)

**Purpose:** Paged search of posted `FinancialTransaction`s by date range and optional filters. Summary "Search Transactions"; not deprecated (the only v0 op in this domain that is not) [spec].

**Query params** [spec]:

| name | in | type | required | default | enum / constraint | description |
|---|---|---|---|---|---|---|
| `limit` | query | integer (int32) | **yes** | — | "value between 1 and 1000" (description only; no `minimum`/`maximum` in schema) | List fetch limit |
| `offset` | query | integer (int32) | **yes** | — | — | Offset used for paging results |
| `sortBy` | query | string | no | `CLEARING_TIME` ("default if not provided") | enum: `CLEARING_TIME`, `TRANSACTION_TIME` | CLEARING_TIME: "Transactions sorted by clearing time"; TRANSACTION_TIME: "Transactions sorted by transaction time" |

**Request body:** `SearchTransactionsRequestBody` (required) — "Body of a request to search transactions" [spec]:

| field | type | required | enum / constraint | description |
|---|---|---|---|---|
| `accountId` | string (uuid) | no | — | Unique identifier (UUID) of the Account. **Note the name**: `accountId`, not `accountHayId` [spec] |
| `fromDateTimeUtc` | string (date-time) | **yes** | — | DateTime in UTC format for the start date range of the Transaction search |
| `toDateTimeUtc` | string (date-time) | **yes** | — | DateTime in UTC format for the end date range of the Transaction search |
| `originChannel` | string | no | `ATM_CASH`, `POS_DEBIT`, `VENUE` | Origin source of the Transaction (only applicable if specifically used by Client) |
| `originId` | string (uuid) | no | — | Additional identifier applied to Transaction related to origin of the request |
| `originType` | string | no | `CUSTOMER`, `SCHEDULED_PAYMENT`, `HAAS_OPERATIONS`, `OPERATIONS`, `DIRECT_DEBIT` (5 values — the 7-value `FinancialTransaction.originType` enum additionally has `MANDATE_PAYMENT`, `TRANSACTION`, which therefore cannot be searched for) | Initiator origin of the Transaction |

**Response 200:** JSON **array** of `FinancialTransaction` (bare array — no wrapper, no total count, no next-page token) [spec]. Fields: see section 2. Each element includes `tags` (empty array when none) [docs:draft-transaction-tagging: "Tags are automatically included on every transaction object within the results array"].

**Behaviour:**

- Filters combine with AND [inferred]. Date range is inclusive/exclusive — unspecified (open question). Which timestamp the range applies to (`clearingTimeUtc` vs `transactionTimeUtc`) is unspecified; [inferred] it follows `sortBy` (default `CLEARING_TIME` ⇒ `clearingTimeUtc`). Sort direction unspecified (open question; [inferred] descending, newest first).
- `accountId` omitted ⇒ [inferred] all accounts visible to the calling client.
- Paging: `offset`/`limit` window over the sorted result; `limit` outside 1..1000 ⇒ [inferred] `400`. Missing `limit`/`offset`/`fromDateTimeUtc`/`toDateTimeUtc` ⇒ `400` [inferred from `required`].
- Only **posted** (cleared) transactions are returned — pending authorisation holds are a separate entity (`AuthorisationHold`, listed via `GET /v0/accounts/{accountId}/holds`) and are not `FinancialTransaction`s [inferred from the two distinct schemas and `relatedHoldHayId` "Hold settled for the Transaction"]. Tags "can only be applied to transactions that have been processed and written to our the ledger" [docs:draft-transaction-tagging], consistent with search returning ledger entries.
- Performance note in docs: "tags are fetched in a single batch query alongside transaction data … for typical page sizes (up to 50 transactions per page)" [docs:draft-transaction-tagging] — the 50 is a typical page, not a cap; the spec cap is 1000.
- No state changes; no webhook.

### GET /v1/holds/{holdId} (getAuthorisationHold)

**Purpose:** Fetch one card authorisation hold by its id. Summary "Get Authorisation Hold by ID"; tag "Holds API" ("Set of APIs related to managing card Authorisation Holds") [spec]. Not deprecated. This is the **only** Holds API operation; the account-scoped list lives in the Accounts domain (`GET /v0/accounts/{accountId}/holds`, `getPendingHolds`, returns `AuthorisationHold[]`) [spec].

**Path params** [spec]:

| name | type | required | description |
|---|---|---|---|
| `holdId` | string (uuid) | yes | Unique identifier (UUID) of the Authorisation Hold |

**Request body:** none.

**Response 200:** `AuthorisationHold` — "Details of an authorisation hold" [spec]; no `required` list, no `nullable` flags. Fields (expand refs one level):

| field | type | enum / notes | description (spec) |
|---|---|---|---|
| `accountHayId` | string (uuid) | — | Unique identifier (UUID) of the Account |
| `cardId` | string (uuid) | — | Unique identifier (UUID) of the Card |
| `category` | string | — | Category applied to transaction, will be initially populated based on merchant type if known |
| `currencyAmount` | `CurrencyAmount` {`amount`: number, `currency`: string enum ISO 4217} | — | (the current hold amount; see behaviour) |
| `customerId` | string (uuid) | — | Unique identifier (UUID) of the Customer (cardholder) |
| `description` | string | — | Description on the Transaction |
| `holdHayId` | string (uuid) | — | Unique identifier (UUID) of the Authorisation Hold |
| `merchantDetails` | `ExternalMerchantDetails` {`address`: MerchantAddress, `cardAcceptorLocation`, `chainName`, `circularLogoUrl`, `merchantCategoryCode`: int32, `merchantId` (nullable), `name`, `terminalId` (nullable)} | — | Details of the merchant |
| `originalCurrencyAmount` | `CurrencyAmount` | — | (amount in the original transaction currency; [inferred] differs from `currencyAmount` only for FX / international spend) |
| `transactionChannel` | string | enum: the same 62-value list as `FinancialTransaction.transactionChannel` (verified equal by jq) — but the **description** for the hold lists only the 21 card channels, with domestic/international variants named `*_DOMESTIC` (e.g. `VISA_CARD_PRESENT_DOMESTIC`) that **do not exist in the enum** (the enum has `VISA_CARD_PRESENT` / `VISA_CARD_PRESENT_INTERNATIONAL`) | "Transaction channel, domestic if payment same country card is issued in otherwise international" |
| `transactionTimeUtc` | string (date-time) | — | DateTime in UTC format when Transaction was Authorised on the Account |
| `type` | string | enum: the same 15-value list as `FinancialTransaction.type` (verified equal by jq); description lists only the five card types `ATM_WITHDRAWAL`, `CARD_NOT_PRESENT_PAYMENT`, `CARD_PAYMENT_REVERSAL`, `CARD_PRESENT_PAYMENT`, `ORIGINAL_CREDIT` | Transaction type |

There is **no status field** on `AuthorisationHold` [spec] — a hold's lifecycle state is not exposed on this resource (see section 3).

**Behaviour:**

- Read-only; no state change; no webhook.
- Holds are never created through the B2B API: they originate from Visa authorisation requests ("the Shaype platform receives transaction authorisation requests from VISA") [docs:card-transactions], or on staging from the Utilities mock endpoints `POST /v0/utils/generate-auth-hold`, `generate-card-transaction`, `generate-update-auth-hold` [docs:simulates-card-transaction-on-staging]. For external-balance clients, Shaype first calls the client's `POST /holds` with `{holdId, accountId, cardId, customerId, amount, merchantDetails}` and only creates the hold on a 200 [spec:external-balance; docs:external-authorisation-and-balance].
- `holdHayId` equals the `transactionHayId` carried in the hold's `CARD_TRANSACTION` webhook ("`holdHayId` and `transactionHayId` set to the same value (the original hold ID)") [docs:simulates-card-transaction-on-staging; docs:card-transactions].
- `currencyAmount` is the **current** hold amount, updated in place: "Initial hold and hold Increase will have same `transactionHayId`", "Hold Increase will have the amount of the updated hold (original hold + increase)" [docs:card-transactions]; a decrease/partial reversal likewise keeps the same id [docs:card-transactions]. [inferred] `GET /v1/holds/{holdId}` therefore returns the post-update amount.
- After settlement the hold is released ("Shaype platform internally lifts the block on account and deducts the transaction amount from balance") [docs:card-transactions] and a separate `FinancialTransaction` is created whose `relatedHoldHayId` = this `holdHayId` [spec]. Whether a settled / fully-reversed / cancelled hold is still retrievable by id (200 with same body? 422? 400?) is **unspecified** (open question). The spec declares no `404`; [inferred] an unknown `holdId` yields `422` or `400` with `ErrorResponse` — which one is undefined (open question).
- Ops-console cancellation exists ("CANCEL AUTHORISATION HOLD" in the Shaype console) [docs:authorisation-hold-cancel]; there is no B2B API for it.

### GET /v1/transactions/{transactionHayId} (getTransactionById)

**Purpose:** Fetch one posted transaction by id. Summary "Get Transaction by ID" [spec]. Not deprecated.

**Path params** [spec]:

| name | type | required | description |
|---|---|---|---|
| `transactionHayId` | string (uuid) | yes | Unique identifier (UUID) of the Transaction |

**Request body:** none.

**Response 200:** `FinancialTransaction` — "Details of a financial transaction." Full field list in section 2. `tags` "is included automatically … If the transaction has no tags, the field is present as an empty array" [docs:draft-transaction-tagging].

**Behaviour:**

- Read-only; no state change; no webhook.
- [inferred] Resolves only ledger (posted) transactions — a hold's id (`holdHayId`) is not a `transactionHayId` for this endpoint even though the hold webhook reuses the value as `transactionHayId` (open question: does GET by the hold id return anything?).
- Unknown id: spec declares no `404`; [inferred] `422` or `400` with `ErrorResponse` (open question which).
- Cross-client access: [inferred] a transaction belonging to another client ⇒ `403`.

### GET /v1/transactions/{transactionHayId}/tags (getTagsForTransaction)

**Purpose:** Return all tags currently associated with a transaction. Summary "Get Tags for Transaction" [spec]. Not deprecated.

**Path params** [spec]:

| name | type | required | description |
|---|---|---|---|
| `transactionHayId` | string (uuid) | yes | Unique identifier (UUID) of the Transaction |

**Request body:** none.

**Response 200:** `TagsResponseBody` — "Response containing tags for an entity" [spec]:

| field | type | required | description |
|---|---|---|---|
| `tags` | array of `Tag` | **yes** | All tags currently associated the entity |

`Tag` = {`id`: string uuid nullable, `category`: string 1–64 chars pattern `\S(.*\S)?` nullable, `value`: string 1–64 chars pattern `\S(.*\S)?` nullable} [spec]. [inferred] in responses all three are populated (`id` is "Shaype-assigned identifier for the tag association. Returned in API responses" [docs:draft-transaction-tagging]).

**Behaviour:**

- "Tags are returned ordered by createdAt ascending." [docs:draft-transaction-tagging] (`createdAt` is **not** a field on `Tag`; it is an internal ordering key the implementer must store.)
- "If the transaction has no tags, the response contains an empty tags array." [docs:draft-transaction-tagging]
- Unknown transaction id: [inferred] `422`/`400` `ErrorResponse` (open question); no `404` declared [spec].
- No state change; no webhook.

### POST /v1/transactions/{transactionHayId}/tags (modifyTagsForTransaction)

**Purpose:** Add or remove tags on a transaction. Summary "Modify Tags for a Transaction". Description (verbatim): "Add or remove tags for transaction. Each tag must either reference an existing tag by 'id', or specify both 'category' and 'value' to create/reference a new tag. If 'id' is null, both 'category' and 'value' are required. Operation field determines whether tags are added (ADD) or removed (REMOVE)." [spec] Not deprecated.

**Path params** [spec]: `transactionHayId` — string (uuid), required, "Unique identifier (UUID) of the Transaction".

**Request body:** `ModifyTagsRequestBody` (required) — "Request to modify tags for an entity" [spec]:

| field | type | required | constraints / enum | description |
|---|---|---|---|---|
| `operation` | string | **yes** | enum: `ADD`, `REMOVE` | An indicator for whether the supplied list of tags should be added or removed |
| `tags` | array of `Tag` | **yes** | `minItems: 1`, `maxItems: 100` | List of tags to add or remove on the entity. Each tag must either have an 'id' to reference an existing tag, or both 'category' and 'value' to create/reference a new tag. |

`Tag` item [spec]:

| field | type | nullable | constraints | description |
|---|---|---|---|---|
| `id` | string (uuid) | yes | — | Unique identifier of an existing tag. If provided, 'category' and 'value' are optional. Example `550e8400-e29b-41d4-a716-446655440000` |
| `category` | string | yes | `minLength: 1`, `maxLength: 64`, `pattern: \S(.*\S)?` (no leading/trailing whitespace) | Tag category name. Required when 'id' is not provided. Example `expense-type` |
| `value` | string | yes | `minLength: 1`, `maxLength: 64`, `pattern: \S(.*\S)?` | Tag value. Required when 'id' is not provided. Example `groceries` |

Spec example body (verbatim) [spec]:
```json
{"tags":[{"id":"550e8400-e29b-41d4-a716-446655440000"},{"category":"expense-type","value":"groceries"}],"operation":"ADD"}
```

**Response 200:** `TagsResponseBody` — `tags`: the **full** current tag list after the modification ("All tags currently associated the entity") [spec], [inferred] in createdAt-ascending order like the GET.

**Response 400** (verbatim spec description, the only op in the domain with a specific 4xx text): "Invalid request - tag validation failed, list is empty, or operation is missing" [spec]. Docs: "The tags array must contain at least one entry; an empty array will be rejected with 400 Bad Request." [docs:draft-transaction-tagging]

**Behaviour:**

- Validation ⇒ `400` [spec 400 description]: `operation` missing or not `ADD`/`REMOVE`; `tags` missing, empty, or > 100 items; any item with `id` null **and** (`category` or `value` missing/blank/too long/leading-or-trailing whitespace).
- `ADD`: "Tags are idempotent — submitting a category/value pair that already exists on the transaction has no effect." "Multiple tags can be added in a single request." [docs:draft-transaction-tagging] A `category`+`value` pair that does not yet exist is created ("create/reference a new tag") [spec]. Uniqueness key on a transaction is (`category`, `value`) [docs: "Together they form a unique label"].
- `REMOVE`: "Only the specified tags are removed; all other tags on the transaction are unchanged." "Requesting removal of a tag that does not exist on the transaction is a no-op — no error is returned." [docs:draft-transaction-tagging]
- Referencing by `id` — a tag `id` that does not exist: unspecified (open question; [inferred] `400` "tag validation failed"). Whether `id` identifies a client-wide (category,value) tag definition ("existing tag" [spec]) or a per-transaction association ("identifier for the tag association" [docs]) is contradictory between spec and docs (open question — matters for whether the same `id` can be ADDed to a second transaction).
- Precondition: the transaction must be a ledger entry — "Tags can only be applied to transactions that have been processed and written to our the ledger. Tag operations are retrospective — real-time tagging during payment authorisation is not currently supported." [docs:draft-transaction-tagging] ⇒ [inferred] tagging a pending hold id fails (status code unspecified).
- Mutability: "Tags are fully mutable after assignment … There is no limit to the number of times tags on a transaction can be modified." [docs:draft-transaction-tagging]
- Not idempotent-keyed (no `idempotencyKey`), but ADD/REMOVE are naturally idempotent [docs].
- Side effects: `FinancialTransaction.tags` for this transaction changes; visible immediately via `getTransactionById` and `searchTransactions` [docs:draft-transaction-tagging].
- No webhook is documented for tag changes.

## (section 2 pending)

## (section 3 pending)

## (section 4-7 pending)

