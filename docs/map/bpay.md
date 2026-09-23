# bpay

Domain: tag `BPAY API` ("Set of APIs related to BPAY functionality") [spec]. 6 operations.

Source labels used below: `[spec]` = `b2b-operations-api.json`; `[webhook-spec]` = `notification-webhooks.json`; `[ext-auth-spec]` = `external-balance.yaml`; `[docs:bpay]`, `[docs:payment-transaction-outcome]`, `[docs:account-limits]`, `[docs:account-balances]`, `[docs:account-status]`, `[docs:liquidity-monitoring-and-alerting-1]`, `[docs:scheduled-payments]`, `[docs:webhook-notification]`, `[docs:external-authorisation-and-balance]` = the corresponding `https://developer.shaype.com/docs/<slug>.md`; `[inferred]` = my reading, not stated anywhere. The six `reference/<operationId>.md` pages contain only the OpenAPI JSON already in the spec (verified: no prose beyond the title), so they add nothing.

The spec has no `security`, no `securitySchemes`, no header parameters, no request/response examples, and no `deprecated` flags on any BPAY operation [spec]. Every BPAY operation also declares `500 Internal Server Error` and `501 Not Implemented` with `ErrorResponse` bodies [spec]; those are omitted from the per-operation lists below.

`ErrorResponse` (used by every 4xx/5xx) [spec]:

| field | type | description |
|---|---|---|
| `details` | string | "Error details" |
| `message` | string | "Error description" |
| `status` | string | "HTTP response status" |
| `traceId` | string | "TraceID that can be used by HAY for troubleshooting the request" |

No field is marked required; no example values exist anywhere in spec or docs [spec].

## 1. Operations

### GET /v1/accounts/{accountId}/bpay-billers (retrieveBillers)

**Purpose:** "BPAY billers for account" — "retrieve biller details that are belongs to the account" [docs:bpay]. Not deprecated.

**Path/query params** [spec]:

| name | in | type | required | notes |
|---|---|---|---|---|
| `accountId` | path | string (uuid) | yes | "Unique identifier (UUID) of the Account" |
| `limit` | query | integer (int32) | **yes** | no default, no min/max, no description |
| `offset` | query | integer (int32) | **yes** | no default, no min/max, no description |

**Request body:** none.

**Response** [spec]:
- `200 Success` → `BPayBillerResponse` (see §2). NOTE: the schema is a single object, not an array, even though the summary is plural and `limit`/`offset` are required. See §7.
- `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content` → `ErrorResponse`. No 404 declared.

**Behaviour:**
- Returns the billers saved against `accountId` via `createBPayBiller` [docs:bpay].
- Whether `DISMISSED` billers (see `updateBpayBiller`) are included is not stated [inferred: open question].
- Which error is returned for an unknown `accountId`, or a `limit`/`offset` that is missing/negative, is not stated; the declared codes are 400/403/422 only [spec].
- Idempotent read; no state change [inferred].

**Webhooks:** none stated.

### POST /v1/accounts/{accountId}/bpay-billers (createBPayBiller)

**Purpose:** "Create BPAY Biller for Account ID" — "store BPAY details against an account (Just like contacts), allowing you to look up and use these details for future payments" [docs:bpay]. Not deprecated. "The platform does not support creating BPAY Billers. It allows you to add your existing biller to your account for lookup" [docs:bpay] — i.e. this creates a *saved biller record*, not a biller in the BPAY scheme.

**Path params** [spec]: `accountId` — path, string (uuid), required, "Unique identifier (UUID) of the Account".

**Request body:** `BPayBillerAddRequestBody` (required) [spec]:

| field | type | required | constraints | description (verbatim) |
|---|---|---|---|---|
| `billerCode` | string | yes | `minLength: 3`, `maxLength: 10` | "The Biller Code for the biller that will receivethe payment. It must be of length 3 to 10 digits." |
| `name` | string | yes | none | "Nick name of the BPAY biller" |
| `reference` | string | yes | **none in this schema** (description says 2–20 digits; the sibling schemas `BPayBillerRequestBody`/`BPayBillerUpdateRequestBody` do declare `minLength: 2`, `maxLength: 20`) | "BPAY biller reference. It must be of length 2 to 20 digits" |

**Response** [spec]:
- `200 Success` → `BPayBillerResponse` (§2). (Not 201.)
- `400 Bad Request`, `403 Forbidden`, `409 Conflict`, `422 Unprocessable Content` → `ErrorResponse`. This is the only BPAY operation that declares 409.

**Behaviour:**
- "You can provide the same Biller code more than once however cannot assign the same reference or nickname as other saved billers" [docs:bpay].
- Validation rules, verbatim [docs:bpay]:
  - "`billerCode` can have leading zeros" → store and compare as a string; do not numeric-normalise [inferred].
  - "Throw error if active biller is not found for that biller code" → the biller code is looked up in a biller directory (Cuscal/BPAY biller list; Staging uses a mock — see §4 fixtures) and must exist and be active.
  - "`name` must not match an existing record with same nickname".
  - "If the request is validated the associated details supplied in the response should be captured and held against the details provided by the customer, including: Short name, Long name, Biller ANZSIC code" → the stored record carries `billerDetails.shortName`, `billerDetails.longName`, `billerDetails.industryAnzsicCode` copied from the directory lookup, plus the customer-supplied `billerCode`/`reference`/`name`.
- "We use Look Who's Charging to enrich the biller details such as logo image, long name" [docs:bpay] → `image` (and possibly `longName`) come from an external enrichment service; the local implementation must fabricate these (see §7).
- Error-code mapping: the docs never say which HTTP code each rule produces. Reasonable mapping [inferred]: schema violations (missing field, length) → 400; duplicate `reference` or `name` within the same account → 409 (the only op declaring it); biller code not found / not active → 422. Treat as a decision, see §7.
- Scope of uniqueness (per account vs per client) is not stated; "other saved billers" in the context of "against an account" reads as per-account [inferred].
- Idempotency: no idempotency key; a retried identical request would hit the duplicate-nickname/reference rule [inferred].
- Initial `status` of the created record is not stated; `ACTIVE` is the only sensible default given the `updateBpayBiller` status values [inferred].

**Webhooks:** none stated.

### POST /v1/accounts/{accountId}/payments/bpay (makeBpayPayment)

**Purpose:** "Initiate BPAY payment" — "submit payment Instructions for biller code and CRN" [docs:bpay]. Not deprecated.

**Path params** [spec]: `accountId` — path, string (uuid), required, "Unique identifier (UUID) of the Account" (the debited account).

**Request body:** `BPayPaymentRequestBody` (required). Required: `amount`, `billerCode`, `category`, `reference`, `senderCustomerHayId` [spec].

| field | type | required | constraints | description (verbatim) |
|---|---|---|---|---|
| `amount` | number | yes | `minimum: 0`, `exclusiveMinimum: true` (i.e. > 0) | "The amount to be transferred" |
| `billerCode` | string | yes | `minLength: 3`, `maxLength: 10` | "The Biller Code for the biller that will receivethe payment. It must be of length 3 to 10 digits." |
| `category` | string | yes | `minLength: 1` | "Used to assign a category of the transfer" |
| `description` | string | no | `minLength: 1`, `maxLength: 255` | "Transfer description, will be seen by both sender and recipient" |
| `idempotencyKey` | string (uuid) | no | — | "Unique value (UUID) used to identify this request and used to recognise any subsequent retries" |
| `name` | string | no | none | "Nick name of the BPAY biller" |
| `reference` | string | yes | `minLength: 2`, `maxLength: 20` | "Biller Reference to be included with the transfer" |
| `senderCustomerHayId` | string (uuid) | yes | — | "Unique identifier (UUID) of the Customer (initiator of the transfer)" |

No currency field: the amount is in the account's currency (webhook example shows `AUD`) [inferred from docs:bpay example]. The request does not reference a saved biller id; it carries `billerCode`+`reference` directly, so a saved biller is not a precondition [spec].

**Response** [spec]:
- `200 Success` → `BpayPaymentResponseBody`:

| field | type | description |
|---|---|---|
| `outcome` | string enum | see below |
| `transactionId` | string (uuid) | "Unique identifier (UUID) of the Transaction" |

`outcome` enum, verbatim and in spec order [spec]: `ACCEPTED`, `INVALID_PAYMENT`, `REFUSED_INSUFFICIENT_FUNDS`, `INTERNAL_ERROR`, `REFUSED_DAILY_BPAY_LIMIT_BREACHED`, `REFUSED_BPAY_INVALID_BILLER_CODE`, `REFUSED_BPAY_INVALID_REFERENCE`, `REFUSED_BPAY_INVALID_PAYMENT`, `REFUSED_BPAY_REJECTED`, `REFUSED_ACCOUNT_BLOCKED`, `REFUSED_RECIPIENT_ACCOUNT_BLOCKED`, `REFUSED_ACCOUNT_CLOSED`, `REFUSED_RECIPIENT_ACCOUNT_CLOSED`, `REFUSED_CAPABILITY_NOT_ENABLED`.

The field's prose description lists a *different* set: `ACCEPTED`, `INTERNAL_ERROR`, `INVALID_PAYMENT`, `INSUFFICIENT_FUNDS` (no `REFUSED_` prefix — not in the enum), `REFUSED_ACCOUNT_CLOSED`, `REFUSED_RECIPIENT_ACCOUNT_CLOSED`, `REFUSED_DAILY_BPAY_LIMIT_BREACHED`, `REFUSED_BPAY_INVALID_BILLER_CODE`, `REFUSED_BPAY_INVALID_REFERENCE`, `REFUSED_BPAY_INVALID_PAYMENT`, `REFUSED_BPAY_REJECTED` [spec]. The enum is authoritative for a validator; the description is stale [inferred].

- Refusals are returned as **HTTP 200 with a non-`ACCEPTED` `outcome`**, not as 4xx [inferred from the schema shape; consistent with the other payment endpoints' `TransactionOutcome` pattern in the spec]. Whether `transactionId` is populated on a refusal is not stated.
- `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content` → `ErrorResponse`.

**Behaviour** (order below is [inferred]; each rule is sourced):
1. Schema validation → 400 [inferred].
2. Account status: "LOCKED … will block all transactions and transfers" [docs:account-status]; `REFUSED_ACCOUNT_BLOCKED` = "Transaction declined as the account is currently blocked", `REFUSED_ACCOUNT_CLOSED` = "because the account has been closed" [docs:payment-transaction-outcome]. Mapping `LOCKED`→`REFUSED_ACCOUNT_BLOCKED`, `CLOSED`→`REFUSED_ACCOUNT_CLOSED` is [inferred]. `REFUSED_RECIPIENT_ACCOUNT_*` are documented as occurring "when transferring funds between Shaype accounts" [docs:payment-transaction-outcome] and have no obvious BPAY meaning; present in the enum only.
3. "The platform will check the **BPAY_DAILY_LIMIT** account limits before initiating the payment. If the daily limit is breached e.g., if the BPAY limit is $100 and the user attempts to send a BPAY transaction of $101, the platform will reject the transaction." [docs:bpay]. Daily limits use "a rolling 24h window … get all transactions from the past 24h for that account and check if the total (including the current transaction) would go over the limit" [docs:account-limits]. Outcome: `REFUSED_DAILY_BPAY_LIMIT_BREACHED` per this endpoint's enum [spec]; but the outcome catalogue names `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED` as "declined because the total daily BPAY_DAILY_LIMIT limit for outbound BPAY transactions has been exceeded" [docs:payment-transaction-outcome], and that value is what the webhook `outcome` enum and the generic `TransactionOutcome` schema carry [webhook-spec][spec]. See §7.
4. "The `amount` field cannot be zero and must not exceed the available balance in the account." [docs:bpay] → `REFUSED_INSUFFICIENT_FUNDS` [spec enum; the docs page lists `REFUSED_NOT_ENOUGH_FUNDS` for MIN_BALANCE breaches generally, which is *not* in this endpoint's enum].
5. "Additionally, the amount must exactly match the expected amount due." [docs:bpay]. This is only meaningful for billers whose CRN encodes an amount (Staging biller `600015`, check-digit rule `ICRNAMT`, "Amount Exact only - $104.00") and billers with Lower/Upper limits (Staging fixtures list e.g. `$20.00`–`$50,000.00`) [docs:bpay]. Outcome for a mismatch is not stated; `REFUSED_BPAY_INVALID_PAYMENT` ("the BPAY payment details are incorrect or invalid") is the closest [inferred].
6. Biller code must be a known, active biller → `REFUSED_BPAY_INVALID_BILLER_CODE` ("invalid BPAY biller code provided") [docs:payment-transaction-outcome]; reference must pass the biller's CRN length/check-digit rules → `REFUSED_BPAY_INVALID_REFERENCE` ("invalid BPAY reference number") [docs:payment-transaction-outcome]. Which rules apply per biller are the Staging fixture fields "Valid CRN Lengths", "Check digit rule", "Variable CRN Indicator" [docs:bpay].
7. `REFUSED_BPAY_REJECTED` = "the BPAY payment was rejected by the payment gateway" [docs:payment-transaction-outcome]. `REFUSED_CAPABILITY_NOT_ENABLED` — in enum; not described in any BPAY doc (product/client not enabled for BPAY [inferred]).
8. On `ACCEPTED`: a transaction of type `BPAY_TRANSFER_OUT` is created and the account balance is debited immediately — the `TRANSACTION` webhook example shows `isPending: false`, `currencyAmount.amount: -20.00`, `updatedBalance` = `accountBalances.totalBalance` = `accountBalances.availableBalance` [docs:bpay]. Whether the platform first creates an authorisation hold (spec `AuthorisationHold.type` includes `BPAY_TRANSFER_OUT`) is not stated → §7.
9. Downstream, asynchronous: "The platform sends payment requests to Cuscal to process payments via BPAY. The platform uses two submission windows each business day, at 1 PM and 5 PM AEST/AEDT. Payments submitted on non-business days will be processed on the following business day"; "There is no restriction on the number of transactions that can be instructed."; "Payment files will be returned at approximately 2:45pm and 6:15pm AEST/AEDT each business day for any PDF files submitted in the period prior to the associated cutoff. This will instruct the result of transactions."; "If the rejection contains any error codes against a transaction within the range of 100 - 199. This means there has been an issue with the transaction itself which may or may not be related to customer input. Due to the upfront validations this should be a rare occurrence." [docs:bpay]. How a post-acceptance rejection is surfaced (a `BPAY_IN_REJECT`-channel credit? a webhook with `REFUSED_BPAY_REJECTED`?) is not documented → §7.
10. Idempotency: `idempotencyKey` is optional and "used to recognise any subsequent retries" [spec]. What a retry returns (same `transactionId`? same outcome? 409?) is not documented → §7.
11. External-balance clients: Shaype calls the client's `POST /transactions` with `authorisationTransactionType: "BPAY_TRANSFER_OUT"` before completing [ext-auth-spec]; client refusal is HTTP 470 with `errorCode` ∈ {`REFUSED_MAX_BALANCE_EXCEEDED`, `REFUSED_NOT_ENOUGH_FUNDS`, `REFUSED_SENDER_ACCOUNT_NOT_VERIFIED`} [ext-auth-spec]; non-scheme timeout is 10 s, after which the transaction is "automatically rejected with outcome: INTERNAL_ERROR" [docs:external-authorisation-and-balance]. See §5.

**Webhooks:** `type: "TRANSACTION"` with `transactionEvent.transactionType: "BPAY_TRANSFER_OUT"` — "The transactionType: BPAY_TRANSFER_OUT is a part of type: TRANSACTION event" [docs:bpay]. Full example payload in §2 (Webhook payload). Only an `ACCEPTED` example is shown; whether refused attempts emit a webhook is not stated [docs:bpay].

### POST /v1/bpay-billers/validate (validateBpay)

**Purpose:** "Validate BPAY" — "validate the biller code and reference field length. Call to Validate BPAY Payment may return validation against specific billers having minimum, maximum or specific values they will allow" [docs:bpay]. Not deprecated. No `accountId`: this is account-independent [spec].

**Path/query params:** none.

**Request body:** `BPayBillerRequestBody` (required). Required: `billerCode`, `reference` [spec].

| field | type | required | constraints | description (verbatim) |
|---|---|---|---|---|
| `billerCode` | string | yes | `minLength: 3`, `maxLength: 10` | "The Biller Code for the biller that will receivethe payment. It must be of length 3 to 10 digits." |
| `reference` | string | yes | `minLength: 2`, `maxLength: 20` | "BPAY biller reference. It must be of length 2 to 20 digits" |

**Response** [spec]:
- `200 Success` → `BPayBillerDetails`:

| field | type | description (verbatim) |
|---|---|---|
| `billerCode` | string | "The Biller Code for the biller that will receivethe payment. It must be of length 3 to 10 digits." |
| `industryAnzsicCode` | string | "ANZSIC codes are four-digit numbers. This is a code that identifies the classification of the industry in which the organisation operates in." |
| `longName` | string | "The long description for the Biller or Service. Max 50 characters. Commas are not allowed in this field." |
| `referenceNumber` | string | "BPAY biller reference. It must be of length 2 to 20 digits" |
| `shortName` | string | "The short description for the Biller or Service. Max 20 characters. Commas are not allowed in this field." |

No field is required [spec].
- `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content` → `ErrorResponse`.

**Behaviour:**
- Looks the biller up by `billerCode` and validates `reference` against that biller's CRN rules (lengths, check digit, variable-CRN indicator, and for `ICRNAMT` billers the embedded amount) [docs:bpay, via the Staging fixture fields]. Success echoes the reference as `referenceNumber` and returns the directory attributes [spec].
- Failure code is not stated. 422 for "biller not found / not active / reference fails biller rules", 400 for schema violations is the natural split [inferred].
- Read-only; no state change [inferred]. `makeBpayPayment` does *not* require a prior validate call [spec].
- Staging: "When a request payload sent does not match with the test data provided in this guide, error message will be returned specific to the Staging environment" [docs:bpay] — text not given.

**Webhooks:** none.

### GET /v1/bpay-billers/{billerId} (retrieveBpayBiller)

**Purpose:** "Retrieve BPAY Biller". Not deprecated. The docs say "retrieve the details of a BPAY Biller based on the Biller Code" and "We can reliably use the SearchAPI to lookup a merchant by the biller code" [docs:bpay], but the spec's path parameter is the saved biller's UUID, not a biller code [spec] → §7.

**Path params** [spec]: `billerId` — path, string (uuid), required, "Unique identifier (UUID) of the Biller." (= `BPayBillerResponse.hayId` [inferred]).

**Request body:** none.

**Response** [spec]:
- `200 Success` → `BPayBillerResponse` (§2).
- `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content` → `ErrorResponse`. No 404 declared; unknown id presumably 400 or 422 [inferred].

**Behaviour:** read-only. No account scoping in the path; a `billerId` belonging to a different client should presumably be 403 [inferred].

**Webhooks:** none.

### PATCH /v1/bpay-billers/{billerId} (updateBpayBiller)

**Purpose:** "Update BPAY Biller". Not deprecated. (The docs line for this endpoint, "This endpoint allow to submit payment Instructions for biller code and CRN", is a copy-paste of the payment description and does not describe this operation [docs:bpay].)

**Path params** [spec]: `billerId` — path, string (uuid), required, "Unique identifier (UUID) of the Biller."

**Request body:** `BPayBillerUpdateRequestBody` (required at the HTTP level; **no field is required**) [spec]:

| field | type | required | constraints | description (verbatim) |
|---|---|---|---|---|
| `image` | string | no | `minLength: 1`, `maxLength: 2147483647` | "Biller image" |
| `name` | string | no | `minLength: 1`, `maxLength: 2147483647` | "Nick name of the BPAY biller" |
| `reference` | string | no | `minLength: 2`, `maxLength: 20` | "BPAY biller reference. It must be of length 2 to 20 digits" |
| `status` | string | no | **no `enum` in the schema**; description: "BPAY biller status. Possible Values:\n**ACTIVE**: Biller is active.\n**DISMISSED**: Biller is dimissed" | |

`billerCode` is not updatable [spec].

**Response** [spec]:
- `204 Success` — declared with `content: application/json` schema `{type: object}`; treat as empty body [inferred: 204 cannot carry a body].
- `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content` → `ErrorResponse`. No 404, no 409 declared.

**Behaviour:**
- Partial update: only supplied fields change [inferred from PATCH + all-optional body].
- Changing `name` or `reference` should re-apply the create-time uniqueness rules ("cannot assign the same reference or nickname as other saved billers" [docs:bpay]); the resulting code is unstated (409 is not declared here; 422 or 400 [inferred]).
- `status: "DISMISSED"` is the only documented way to retire a saved biller; there is no DELETE [spec]. Whether `DISMISSED → ACTIVE` is allowed is not stated → §3/§7.
- Values outside `ACTIVE`/`DISMISSED` → 400 or 422 [inferred].

**Webhooks:** none.

## 2. Entities and fields

There are no spec examples for any BPAY schema; the only example values anywhere are in the `BPAY_TRANSFER_OUT` webhook sample and the Staging fixtures in [docs:bpay], quoted where relevant.

### SavedBiller — `BPayBillerResponse` ("BPAY biller Response body") [spec]

The per-account saved-biller record ("Just like contacts" [docs:bpay]). Created by `createBPayBiller`; read by `retrieveBillers` and `retrieveBpayBiller`; updated by `updateBpayBiller`. No delete operation.

| field | type | required | nullable | description (verbatim) | set by |
|---|---|---|---|---|---|
| `hayId` | string (uuid) | no | not stated | "Unique identifier (UUID) of the Biller." | platform on create; is the `billerId` path param [inferred] |
| `accountHayId` | string (uuid) | no | not stated | "Unique identifier (UUID) of the Account" | `accountId` path param on create |
| `name` | string | no | not stated | "Nick name of the Bpay biller" | request `name`; `PATCH name` |
| `image` | string | no | not stated | "Biller image" | Look Who's Charging enrichment [docs:bpay]; `PATCH image` |
| `billerDetails` | `BPayBillerDetails` | no | not stated | — | directory lookup + request `reference` |

Fields that exist on the record but are **not** in this response schema: `status` (`ACTIVE`/`DISMISSED`, writable via PATCH only) [spec]. The webhook-side `billerImage` example value is `"https://images.lookwhoscharging.com/8d9595b6-812e-4e32-8a58-fedbe856b2f2/iinet-ci-image.png"` [docs:bpay] — a URL, so `image` is most plausibly a URL too [inferred].

### `BPayBillerDetails` ("BPAY biller details") [spec]

Returned standalone by `validateBpay`, and embedded as `BPayBillerResponse.billerDetails`.

| field | type | constraints (from description) | description (verbatim) |
|---|---|---|---|
| `billerCode` | string | 3–10 digits (no `minLength`/`maxLength` in this schema) | "The Biller Code for the biller that will receivethe payment. It must be of length 3 to 10 digits." |
| `industryAnzsicCode` | string | four-digit | "ANZSIC codes are four-digit numbers. This is a code that identifies the classification of the industry in which the organisation operates in." |
| `longName` | string | max 50 chars, no commas | "The long description for the Biller or Service. Max 50 characters. Commas are not allowed in this field." |
| `referenceNumber` | string | 2–20 digits | "BPAY biller reference. It must be of length 2 to 20 digits" |
| `shortName` | string | max 20 chars, no commas | "The short description for the Biller or Service. Max 20 characters. Commas are not allowed in this field." |

Nothing required. Example values from the Staging fixtures [docs:bpay]: `billerCode` `"7773"`, `longName` `"APIBCD SERVICES AV1"`, `industryAnzsicCode` `"1113"` ("1113 - Cured Meat and Smallgoods Manufacturing"). Note fixture `93880` lists industry code `94540` (five digits), contradicting "four-digit".

### Request bodies (not persisted entities) [spec]

- `BPayBillerAddRequestBody` — required `billerCode`(3–10), `name`, `reference`(no constraint). Description: "BPAY biller request body".
- `BPayBillerRequestBody` — required `billerCode`(3–10), `reference`(2–20). Description: "BPAY Biller request body".
- `BPayBillerUpdateRequestBody` — optional `image`(1..2147483647), `name`(1..2147483647), `reference`(2–20), `status`(string; ACTIVE/DISMISSED by description only). Description: "BPAY biller reques Request body".
- `BPayPaymentRequestBody` — see §1 makeBpayPayment. No description.

### Payment result — `BpayPaymentResponseBody` ("Transaction outcome details") [spec]

| field | type | enum |
|---|---|---|
| `outcome` | string | `ACCEPTED`, `INVALID_PAYMENT`, `REFUSED_INSUFFICIENT_FUNDS`, `INTERNAL_ERROR`, `REFUSED_DAILY_BPAY_LIMIT_BREACHED`, `REFUSED_BPAY_INVALID_BILLER_CODE`, `REFUSED_BPAY_INVALID_REFERENCE`, `REFUSED_BPAY_INVALID_PAYMENT`, `REFUSED_BPAY_REJECTED`, `REFUSED_ACCOUNT_BLOCKED`, `REFUSED_RECIPIENT_ACCOUNT_BLOCKED`, `REFUSED_ACCOUNT_CLOSED`, `REFUSED_RECIPIENT_ACCOUNT_CLOSED`, `REFUSED_CAPABILITY_NOT_ENABLED` |
| `transactionId` | string (uuid) | "Unique identifier (UUID) of the Transaction" |

Nothing required. Created by `makeBpayPayment` only. This schema is BPAY-specific; the other payment endpoints use `TransactionOutcome` whose enum differs (it has `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`, `REFUSED_LIMIT_BREACH`, `UNKNOWN`, … and lacks all `REFUSED_BPAY_*`) [spec].

### BPAY transaction (cross-domain: Transactions) — `FinancialTransaction` [spec]

`makeBpayPayment` with `ACCEPTED` produces a transaction retrievable via `getTransactionById` (`GET /v1/transactions/{transactionHayId}`) and `searchTransactions` (`POST /v0/transactions/search`, filters: `accountId`, `fromDateTimeUtc`, `toDateTimeUtc`, `originChannel`, `originId`, `originType`) [spec]. Relevant enum members [spec]:

- `FinancialTransaction.type`: `BPAY_TRANSFER_OUT` = "BPAY payment made out of Account"; `BPAY_TRANSFER_IN` = "(not currently in use)".
- `FinancialTransaction.transactionChannel`: `CUSCAL_BPAY_TRANSFER_OUT` and `BPAY_IN_REJECT` (both under "Transaction channels applicable to Shaype operated functions"); `CUSCAL_BPAY_TRANSFER_IN` (under "Transaction channels not in use").
- `FinancialTransaction.originType`: `CUSTOMER` ("Transaction initiated by a customer") for API-initiated payments, `SCHEDULED_PAYMENT` for schedule-initiated ones [inferred from the enum descriptions].
- `FinancialTransaction.counterpartDetails` is `ExternalCounterpartDetails` {`accountId`, `basicAccountNumber`, `customerId`, `merchantDetails`, `name`} — **no `bpayDetails`** field, unlike the webhook's `CounterpartDetails` [spec]. Where the biller code/CRN surface on the stored transaction is undocumented → §7.
- `FinancialTransaction.reference` description: "Reference on the transaction (only applicable to NPP transactions), maximum 35 alphanumeric characters" — so the BPAY CRN may not be in `reference` [spec].

`AuthorisationHold.type` also lists `BPAY_TRANSFER_OUT` and `BPAY_TRANSFER_IN`, and `AuthorisationHold.transactionChannel` lists `CUSCAL_BPAY_TRANSFER_IN`, `CUSCAL_BPAY_TRANSFER_OUT`, `BPAY_IN_REJECT` [spec]; no doc describes BPAY holds.

### `BpayDetails` ("Details of the BPAY Biller") [spec] / ("BPAY transaction counterpart details.") [webhook-spec]

Main-spec version (used by `ScheduledPaymentRecipient.bpayDetails`):

| field | type | description (verbatim) |
|---|---|---|
| `billerCode` | string | "BPAY Biller Code, 3 to 10 digits in length" |
| `billerImage` | string | "URL to external image representing Biller's logo (if available)" |
| `billerName` | string | "Name of the BPAY Biller, 1 to 50 characters in length" |
| `billerReference` | string | "BPAY Customer Reference Number (CRN), 2 to 20 digits in length" |
| `category` | string | "Category assigned on the transaction" |

Webhook version (`CounterpartDetails.bpayDetails`): `billerCode` ("Biller code."), `billerReference` ("Customer reference number (CRN)."), `billerName` ("Biller name."), `billerImage` ("Biller image.") — **no `category`** [webhook-spec]. Example [docs:bpay]: `{"billerCode": "93880", "billerReference": "271682361223", "billerName": "iiNet", "billerImage": "https://images.lookwhoscharging.com/8d9595b6-812e-4e32-8a58-fedbe856b2f2/iinet-ci-image.png"}`.

### Webhook payload — `NotificationDto` with `type: "TRANSACTION"` [webhook-spec]

`NotificationDto` required: `customerHayId`, `idempotencyKey`, `type`. `TransactionEventDto` fields present in the BPAY example [docs:bpay]: `transactionHayId`, `accountHayId`, `currencyAmount` {`currency`, `amount`}, `updatedBalance`, `isPending`, `counterpartName`, `outcome`, `transactionTimeUtc`, `isAtmTransaction` (deprecated), `transactionType`, `accountBalances` {`totalBalance`, `heldBalance`, `lockedBalance`, `stacksBalance`, `availableBalance`}, `customerHayId`, `counterpartDetails` {`name`, `bpayDetails`}, `category`, `description`. Other `TransactionEventDto` fields (not in the example): `holdHayId`, `originalCurrencyAmount`, `cardPreferenceOutcome`, `cardProcessorResponse`, `merchantName`, `cardUsageDetails`, `cardHayId`, `ruleDetails`, `originId`, `originType`, `merchantId`, `mandatePaymentDetails`, `returnReason`, `reference`, `externalIdentifiers` [webhook-spec].

Verbatim example [docs:bpay]:

```json
{
  "customerHayId": "63d24ae0-d497-485e-800a-ad141542d23r",
  "idempotencyKey": "f2f7076f-6fb1-46e1-9730-369a86f3234e",
  "type": "TRANSACTION",
  "productId": "8aa68646-77a4-8411-0177-a4dabc5d03d1",
  "transactionEvent": {
    "transactionHayId": "d3daec8e-6044-4c60-b233-ad141542d23r",
    "accountHayId": "150960b2-d042-4b63-abaa-ad141542d23r",
    "currencyAmount": { "currency": "AUD", "amount": -20.00 },
    "updatedBalance": { "currency": "AUD", "amount": 151087.66 },
    "isPending": false,
    "counterpartName": "TestGQL",
    "outcome": "ACCEPTED",
    "transactionTimeUtc": "2024-06-21T03:03:16.354179Z",
    "isAtmTransaction": false,
    "transactionType": "BPAY_TRANSFER_OUT",
    "accountBalances": {
      "totalBalance": { "currency": "AUD", "amount": 151087.66 },
      "heldBalance": { "currency": "AUD", "amount": 0 },
      "lockedBalance": { "currency": "AUD", "amount": 0 },
      "stacksBalance": { "currency": "AUD", "amount": 0 },
      "availableBalance": { "currency": "AUD", "amount": 151087.66 }
    },
    "customerHayId": "63d24ae0-d497-485e-800a-ad141542d23r",
    "counterpartDetails": {
      "name": "TestGQL",
      "bpayDetails": {
        "billerCode": "93880",
        "billerReference": "271682361223",
        "billerName": "iiNet",
        "billerImage": "https://images.lookwhoscharging.com/8d9595b6-812e-4e32-8a58-fedbe856b2f2/iinet-ci-image.png"
      }
    },
    "category": "Category",
    "description": "test BPAY TRANSFER BA AU PAYEE"
  }
}
```

(The example ids end in `d23r`, which is not valid hex — they are illustrative, not real UUIDs.) `counterpartDetails.name`/`counterpartName` = `"TestGQL"` while `bpayDetails.billerName` = `"iiNet"`: the counterpart name is the payer-supplied nickname (`name` on the payment request), not the biller's registered name [inferred].

`TransactionEventDto.outcome` enum (full, verbatim) [webhook-spec]: `ACCEPTED`, `REFUSED_CARD_PREFERENCE`, `REFUSED_ACCOUNT_PREFERENCE`, `REFUSED_FRAUD`, `REFUSED_AML`, `REFUSED_MAX_BALANCE_EXCEEDED`, `REFUSED_NOT_ENOUGH_FUNDS`, `REFUSED_DAILY_LIMIT_EXCEEDED`, `INTERNAL_ERROR`, `REFUSED_ACCOUNT_NOT_FOUND_FOR_CARD_TOKEN`, `REFUSED_UNDETERMINED_BALANCE_FOR_ACCOUNT`, `REFUSED_ACCOUNT_NOT_FOUND_FOR_CURRENCY`, `REFUSED_UNDETERMINED_SPENDING_FOR_ACCOUNT`, `REFUSED_UNDETERMINED_TOP_UPS_FOR_ACCOUNT`, `REFUSED_UNDETERMINED_ATM_WITHDRAWALS_FOR_ACCOUNT`, `REFUSED_ANNUAL_SPENDING_LIMIT_BREACHED`, `REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED`, `REFUSED_DAILY_TOP_UP_LIMIT_BREACHED`, `REFUSED_ACCOUNT_BLOCKED`, `REFUSED_ACCOUNT_CLOSED`, `REFUSED_RECIPIENT_ACCOUNT_BLOCKED`, `REFUSED_RECIPIENT_ACCOUNT_CLOSED`, `REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED`, `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED`, `REFUSED_RULES`, `REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_NET_VISA_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_NON_SCHEME_DAILY_LIMIT_BREACHED`, `REFUSED_BPAY_INVALID_BILLER_CODE`, `REFUSED_BPAY_INVALID_REFERENCE`, `REFUSED_BPAY_INVALID_PAYMENT`, `REFUSED_BPAY_REJECTED`, `REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED`, `REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED`, `REFUSED_SANCTIONS`, `REFUSED_UNABLE_TO_VALIDATE`, `REFUSED_INSUFFICIENT_DATA`, `REFUSED_SENDER_ACCOUNT_NOT_VERIFIED`, `REFUSED_CAPABILITY_NOT_ENABLED`, `REFUSED_QUOTE_EXPIRED`. Note it contains neither `REFUSED_DAILY_BPAY_LIMIT_BREACHED` nor `REFUSED_INSUFFICIENT_FUNDS` nor `INVALID_PAYMENT` — three of the sync `BpayPaymentResponseBody` values have no webhook counterpart [spec][webhook-spec].

`TransactionEventDto.transactionType` enum (verbatim) [webhook-spec]: `CARD_TRANSACTION`, `CARD_TRANSACTION_REFUND`, `CARD_TRANSACTION_SETTLED`, `INTRABANK_TRANSFER_IN`, `INTRABANK_TRANSFER_OUT`, `INTERBANK_TRANSFER_IN`, `INTERBANK_TRANSFER_OUT`, `DIRECT_DEBIT_TRANSFER`, `HAY_TOP_UP`, `INTERBANK_TRANSFER_OUT_REVERSAL`, `REWARD`, `GENERAL_CREDIT`, `GENERAL_DEBIT`, `ORIGINAL_CREDIT`, `BPAY_TRANSFER_OUT`, `CONVERSION_IN`, `CONVERSION_OUT`. (`BPAY_TRANSFER_OUT` = "Outgoing BPAY transfer".)

### `BPayLiquidity` (cross-domain: Liquidity) [spec]

`ClientLiquidity.nonScheme.bpay` in `GET /v1/liquidity` (`getClientLiquidity`, optional `date` query). Required: `inbound`, `outbound`, `total` — all `number`, no descriptions. Presumably day-aggregated sums of BPAY movements [inferred].

### Account limit `BPAY_DAILY_LIMIT` (cross-domain: Accounts) [spec]

`ExternalLimitAmounts` {`type`, `accountLimit`, `effectiveLimit`, `productLimit`} from `getAccountLimits`; `setAccountLimit` (`PUT /v1/accounts/{accountId}/limits/BPAY_DAILY_LIMIT`, body `ExternalSetAccountLimitRequestBody` {`limitAmount` number > 0, required}); `deleteAccountLimit`. `BPAY_DAILY_LIMIT` = "Maximum value of outgoing BPAY payments" [spec] / "The maximum amount of money that can be transferred using BPAY within a single day" [docs:account-limits]. `BPAY_TOP_UP_PER_DAY` = "Not currently used" [spec][docs:account-limits] and is absent from the `setAccountLimit` `limitType` path enum [spec].

### Staging biller fixtures [docs:bpay]

These are the only concrete biller records anywhere; a local implementation should seed them. "The data used in the mock is for testing purposes only."

| billerCode | Industry Code | Long Name | Valid CRN Lengths | Variable CRN | Valid CRNs | Check digit rule | Payment Methods | Lower | Upper / Amount | active |
|---|---|---|---|---|---|---|---|---|---|---|
| `7773` | 1113 - Cured Meat and Smallgoods Manufacturing | APIBCD SERVICES AV1 | 8 | N | 74177361 / 23915754 / 48165831 / 12914552 / 14525281 | MOD10V01 | Debit | $20.00 | $50,000.00 | yes |
| `93849` | 6931 - Legal Services | APIBCD SERVICES AV8 | 7, 9, 10 | N | 7231016 | MOD11V09 | Debit | $10.00 | $20,000.00 | yes |
| `93880` | 94540 - Religious Services | APIBCD SERVICES AV12 | 12 | N | 271682361214 / 781133471230 / 351118227898 / 859167654564 / 637933921214 | MOD10V01 | Debit | $10.00 | $4,000.00 | yes |
| `600015` | 3501 - Car Wholesaling | API2 SERVICES ICRN AMT | 4–20 (every length 4..20) | Y | 0808812345678260 | ICRNAMT | Debit | — | Exact only - $104.00 | yes |
| `1016` | 3501 - Car Wholesaling | BILLER LONG NAME 505529 | 10 | N | 42741454 | MOD10V01 | NONE (Inactive Biller) | N/A | N/A | **no** (Deactivated) |

Note: the webhook example uses `billerCode 93880` with `billerReference 271682361223`, which is *not* in that biller's Valid CRNs list (`…214`), and `billerName "iiNet"`, not the fixture long name — the example and the fixtures are not mutually consistent. Fixture `1016` lists a Valid CRN of 8 digits against a Valid CRN Length of 10.

## 3. State machines

### SavedBiller `status` [spec: `BPayBillerUpdateRequestBody.status` description]

Values (verbatim): `ACTIVE` ("Biller is active."), `DISMISSED` ("Biller is dimissed"). Not exposed on any response schema [spec].

| from | to | via |
|---|---|---|
| (none) | `ACTIVE` | `createBPayBiller` — initial status not stated; `ACTIVE` [inferred] |
| `ACTIVE` | `DISMISSED` | `updateBpayBiller` with `status: "DISMISSED"` [spec] |
| `DISMISSED` | `ACTIVE` | `updateBpayBiller` with `status: "ACTIVE"` — not stated whether allowed [inferred: open] |

Terminal: none documented. No transitions are documented as forbidden.

### Directory biller active flag [docs:bpay]

External data, not a state the API mutates: a biller in the BPAY directory is either active or "Deactivated"/"Inactive Biller" (fixture `1016`). `createBPayBiller` "Throw[s] error if active biller is not found for that biller code" and `makeBpayPayment` returns `REFUSED_BPAY_INVALID_BILLER_CODE` [inferred mapping]. No transition is driven by this API.

### BPAY payment lifecycle [inferred synthesis; no status enum exists on the payment itself]

The payment has no status field; its lifecycle is expressed by (a) the synchronous `outcome`, (b) the `FinancialTransaction` record, (c) the async Cuscal result.

| from | to | via |
|---|---|---|
| (request) | sync `outcome` ≠ `ACCEPTED` | `makeBpayPayment` refused by platform validation (§1, rules 1–7). No balance change [inferred]. |
| (request) | sync `outcome = ACCEPTED`, transaction `BPAY_TRANSFER_OUT` created, balance debited, `TRANSACTION` webhook with `isPending: false` | `makeBpayPayment` [docs:bpay example] |
| accepted | submitted to Cuscal | platform batch at 1 PM / 5 PM AEST/AEDT business days [docs:bpay] |
| submitted | settled / rejected (result file ~2:45pm / ~6:15pm AEST/AEDT; error codes 100–199 = transaction issue) | Cuscal result file [docs:bpay]. Surfacing mechanism undocumented; `BPAY_IN_REJECT` transaction channel exists [spec] → §7. |

Terminal: refused (sync), settled, rejected-after-acceptance (mechanism unknown).

### Scheduled payment with `recipientType: BPAY` (cross-domain, for reference) [spec: `HayScheduledPayment.status`]

`ACTIVE`, `CANCELLED`, `DELETED`, `FAILED`, `REJECTED`, `COMPLETED`, `REPLACED`. Owned by the scheduled-payments domain; not driven by any BPAY operation. Scheduled payments cannot be created through the B2B API ("The Create and Update Scheduled Payment features are available through the UI portal" [docs:scheduled-payments]).

## 4. Invariants and calculations

### Field formats [spec unless noted]

- `billerCode`: string, length 3–10, digits; "can have leading zeros" [docs:bpay] → **keep as string, never parse to a number, compare byte-wise**. `BpayDetails.billerCode`: "3 to 10 digits in length".
- `reference` / `referenceNumber` / `billerReference` (CRN): string, length 2–20, digits. On `BPayBillerAddRequestBody` the 2–20 bound is description-only (no `minLength`/`maxLength`); on `BPayBillerRequestBody`, `BPayBillerUpdateRequestBody`, `BPayPaymentRequestBody` it is enforced by schema.
- `name` (nickname): free string, required on create; on update `minLength 1`. Not constrained on `BPayPaymentRequestBody`.
- `longName` ≤ 50 chars, `shortName` ≤ 20 chars, both "Commas are not allowed"; `billerName` (webhook/BpayDetails) 1–50 chars. `industryAnzsicCode` "four-digit numbers".
- `amount`: number > 0 (`minimum: 0, exclusiveMinimum: true`); "cannot be zero" [docs:bpay]. Decimal, two places in examples (`-20.00`, `151087.66`). Currency is implicit (`AUD` in every example).
- `category`: string, `minLength 1`, required on payment; echoed on the webhook `transactionEvent.category` [docs:bpay example] and on `BpayDetails.category` "Category assigned on the transaction".
- `description`: 1–255 chars, optional; echoed as `transactionEvent.description`.
- `idempotencyKey`: uuid, optional.
- All ids (`accountId`, `billerId`/`hayId`, `senderCustomerHayId`, `transactionId`) are UUID strings.
- `limit`/`offset` on `retrieveBillers`: int32, both required, semantics not described (assume offset-based paging [inferred]).

### Uniqueness [docs:bpay]

Within the saved billers of an account [scope inferred]:
- `billerCode` may repeat ("You can provide the same Biller code more than once").
- `reference` must be unique ("cannot assign the same reference … as other saved billers").
- `name` must be unique ("`name` must not match an existing record with same nickname").
Whether `DISMISSED` billers count toward uniqueness is not stated.

### Payment validation formulas

- Amount vs balance: `amount <= availableBalance` [docs:bpay: "must not exceed the available balance in the account"]. Balance definitions [docs:account-balances]: "Available Balance = Account Balance + (Overdraft Limit + Overdraft Balance) + Technical Overdraft Balance + Held Balance + Stacks balance" and "Total Balance = Total Available Balance + (Overdraft Limit + Overdraft Balance) + Technical Overdraft Balance + Stacks Balance" (quoted as written; the doc's sign conventions are not self-consistent — the webhook example with held=locked=stacks=0 shows `availableBalance == totalBalance == updatedBalance`, which is the invariant to preserve in the simple case).
- Daily limit: let `L = effectiveLimit(BPAY_DAILY_LIMIT)` where `effectiveLimit = accountLimit if set else productLimit` [docs:account-limits: "If an account level limit is set this will be the effective limit, otherwise the default Product level limit will be used"]. Refuse if `sum(amount of accepted BPAY_TRANSFER_OUT for this account in the trailing 24 h) + amount > L` [docs:account-limits: "rolling 24h window … check if the total (including the current transaction) would go over the limit"]. Worked example: "if the BPAY limit is $100 and the user attempts to send a BPAY transaction of $101, the platform will reject the transaction" [docs:bpay]. Account limit cannot exceed product limit [docs:account-limits]. Risk level `HIGH` "set all limits to 0, which means … will prevent all outbound and inbound transactions" [docs:account-limits].
- Amount vs biller rules [docs:bpay fixtures]: `Lower Limit <= amount <= Upper Limit` for billers that declare them; for `ICRNAMT` billers the amount must equal the amount encoded in the CRN ("Exact only - $104.00"; "the amount must exactly match the expected amount due").
- CRN vs biller rules [docs:bpay fixtures]: `len(reference) ∈ Valid CRN Lengths`; check-digit rule (`MOD10V01`, `MOD11V09`, `ICRNAMT`) must pass — the algorithms are named but not specified anywhere in these sources; in Staging only the listed "Valid CRNs" are accepted.
- Post-acceptance balance effect: `updatedBalance = previousBalance + currencyAmount.amount` where `currencyAmount.amount` is negative for the debit (`-20.00`) [docs:bpay example].

### Time handling

- `transactionTimeUtc`: ISO-8601 UTC with microseconds in the example (`2024-06-21T03:03:16.354179Z`) [docs:bpay].
- Rolling-24h limit window is wall-clock based [docs:account-limits]; the account-limits doc's ATM example says "until the next calendar day", which contradicts "rolling 24h window" — treat rolling as authoritative for BPAY since the BPAY doc cross-links to it [inferred].
- Cuscal batching uses AEST/AEDT business days (1 PM, 5 PM submit; ~2:45 PM, ~6:15 PM results) [docs:bpay]. Nothing in the API surface depends on these times; a local implementation can ignore them unless simulating late rejections.

### Liquidity threshold `TOTAL_DAILY_OUTBOUND_BPAY` (client-level) [docs:liquidity-monitoring-and-alerting-1]

- Amount mode: alert "If amount ($) + Total Outbound BPAY Running Balance <= 0".
- Percent mode: alert "If BPAY_DAILY_LIMIT * percentage (%) + Total Outbound BPAY Running Balance <= 0"; the percentage base for this type is `BPAY_DAILY_LIMIT`.
- Alerts are emails, not webhooks, and do not refuse transactions. `LiquidityThreshold`: `percent` 1–100 int32 nullable, `amount` ≥ 1 nullable, `active`, `percental`, `external`, `clientReference`, `id` [spec].

## 5. Cross-domain dependencies

| other domain | what BPAY reads | what BPAY writes / triggers | source |
|---|---|---|---|
| **Accounts** (`Accounts API`) | `accountId` must resolve to an account for `retrieveBillers`, `createBPayBiller`, `makeBpayPayment` (all take `{accountId}`); account `status` (`HayAccount.status` enum: `PENDING_APPROVAL`, `APPROVED`, `ACTIVE`, `LOCKED`, `DORMANT`, `CLOSED`, `ACTIVE_IN_ARREARS`) — `LOCKED` "will block all transactions and transfers", `CLOSED` "is a final status" [docs:account-status]; the account's `availableBalance`; the `BPAY_DAILY_LIMIT` effective limit (`getAccountLimits`, `setAccountLimit`, `deleteAccountLimit` — `PUT/DELETE /v1/accounts/{accountId}/limits/{limitType}`, `limitType` enum includes `BPAY_DAILY_LIMIT`); risk level (`HIGH` zeroes all limits) | On `ACCEPTED` payment: debits `totalBalance`/`availableBalance`/`updatedBalance` by `amount` | [spec][docs:bpay][docs:account-status][docs:account-limits] |
| **Customers** | `senderCustomerHayId` "Unique identifier (UUID) of the Customer (initiator of the transfer)"; echoed as webhook `customerHayId` and top-level `NotificationDto.customerHayId` | — | [spec][docs:bpay example] |
| **Transactions** (`getTransactionById`, `searchTransactions`, tags) | — | Creates a `FinancialTransaction` with `type: BPAY_TRANSFER_OUT`, `transactionChannel: CUSCAL_BPAY_TRANSFER_OUT`, `originType: CUSTOMER`; returns its id as `transactionId`. `BPAY_IN_REJECT` channel exists for reversals/rejections. `BPAY_TRANSFER_IN` and `CUSCAL_BPAY_TRANSFER_IN` are "not currently in use" | [spec] |
| **Scheduled payments** (`getScheduledPayments`, `getScheduledPaymentById`, `cancelScheduledPayment`) | — | A schedule with `recipient.recipientType: "BPAY"` and `recipient.bpayDetails` (`billerCode`, `billerReference`, `billerName`, `billerImage`, `category`) produces BPAY payments with `originType: SCHEDULED_PAYMENT` when due; schedule creation is GraphQL/UI only | [spec][docs:scheduled-payments] |
| **Liquidity** (`getClientLiquidity`, `createLiquidityThreshold`, `updateLiquidityThreshold`, `getClientLiquidityThresholds`) | — | Accepted payments feed `ClientLiquidity.nonScheme.bpay` {`inbound`, `outbound`, `total`} and the `TOTAL_DAILY_OUTBOUND_BPAY` running balance used by email alerts | [spec][docs:liquidity-monitoring-and-alerting-1] |
| **Holds** (`AuthorisationHold`) | — | Spec enum lists `BPAY_TRANSFER_OUT`/`BPAY_TRANSFER_IN` hold types; no doc says BPAY creates holds; webhook example has `isPending: false` and no `holdHayId` | [spec][docs:bpay] |
| **External authorisation** (Shaype → client, `external-balance.yaml`) | For clients holding balances externally, Shaype calls client `POST /transactions` with `Transaction{transactionId, authorisationTransactionType: "BPAY_TRANSFER_OUT", accountId, amount{amount: string, currency}, counterpartDetails{name, basicAccountNumber}, description, reference, account{id, balance, holder{id, type: CUSTOMER|GROUP}, statistics{txn_count_last_10m, txn_sum_last_24h}}, customer{id, details, address, tenure_days}, transactionTimeUtc}` plus headers `Shaype-Version`, `Shaype-Trace-Id`, `Shaype-Idempotency-Key`, `Shaype-Timestamp`, `Shaype-Signature`, `Shaype-Key-Id`. Client answers 200 (approve) or 470 `Response{errorCode ∈ REFUSED_MAX_BALANCE_EXCEEDED | REFUSED_NOT_ENOUGH_FUNDS | REFUSED_SENDER_ACCOUNT_NOT_VERIFIED, reason}` or 500. Timeout for non-scheme = 10 s → `INTERNAL_ERROR`. Platform limit checks run first and "reject the transaction without performing a balance check on the client's side" (the listed limits are card/NPP ones; `BPAY_DAILY_LIMIT` is not in that list) | — | [ext-auth-spec][docs:external-authorisation-and-balance] |
| **Webhooks** (`notification-webhooks.json`, client `/notification` endpoint) | — | `NotificationDto{type: "TRANSACTION", transactionEvent{transactionType: "BPAY_TRANSFER_OUT", …}}`; platform retries 18 times over up to 48 h with exponential backoff on client 401/403/429/5XX | [webhook-spec][docs:webhook-notification] |
| **External biller directory / Look Who's Charging** (not a Shaype API) | Biller existence + active flag, `shortName`, `longName`, `industryAnzsicCode`, CRN rules, amount limits; logo `image`/`billerImage` and enriched `longName` from Look Who's Charging | — | [docs:bpay] |

## 6. Error catalogue

No source gives any `ErrorResponse.message`/`details` text for BPAY. The Staging mock returns an "error message … specific to the Staging environment" when the payload does not match the fixtures [docs:bpay], text not shown.

### HTTP-level errors (all bodies `ErrorResponse`) [spec]

| operation | 400 | 403 | 404 | 409 | 422 |
|---|---|---|---|---|---|
| `retrieveBillers` | declared | declared | not declared | not declared | declared |
| `createBPayBiller` | declared | declared | not declared | **declared** ("Conflict") | declared |
| `makeBpayPayment` | declared | declared | not declared | not declared | declared |
| `validateBpay` | declared | declared | not declared | not declared | declared |
| `retrieveBpayBiller` | declared | declared | not declared | not declared | declared |
| `updateBpayBiller` | declared | declared | not declared | not declared | declared |

Plus `500 Internal Server Error` and `501 Not Implemented` on all six. No operation declares 404 — unknown `accountId`/`billerId` must map to 400/403/422 [inferred].

### Documented failing conditions and their (partly inferred) mapping

| condition | operation(s) | result | source |
|---|---|---|---|
| Body/param fails schema (missing required, length, uuid format, `amount <= 0`) | all | 400 [inferred] | [spec constraints] |
| "active biller is not found for that biller code" | `createBPayBiller` | error; 422 [inferred] | [docs:bpay] |
| `reference` duplicates another saved biller's reference | `createBPayBiller` (and `updateBpayBiller reference`) | error; 409 on create [inferred], unstated on update | [docs:bpay] |
| `name` "must not match an existing record with same nickname" | `createBPayBiller` (and `updateBpayBiller name`) | error; 409 on create [inferred] | [docs:bpay] |
| biller code / reference fail biller rules | `validateBpay` | error; 422 [inferred] | [docs:bpay] |
| `status` not in {ACTIVE, DISMISSED} | `updateBpayBiller` | error; 400/422 [inferred] | [spec description] |
| BPAY_DAILY_LIMIT breached (rolling 24 h incl. this txn) | `makeBpayPayment` | 200 `outcome: REFUSED_DAILY_BPAY_LIMIT_BREACHED` [spec enum] — docs text: `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED` "Transaction declined because the total daily BPAY_DAILY_LIMIT limit for outbound BPAY transactions has been exceeded." | [spec][docs:bpay][docs:payment-transaction-outcome] |
| `amount` "cannot be zero and must not exceed the available balance" | `makeBpayPayment` | 200 `REFUSED_INSUFFICIENT_FUNDS` [spec enum]; zero amount fails schema first (400) [inferred] | [docs:bpay][spec] |
| "amount must exactly match the expected amount due" / outside biller Lower–Upper limit | `makeBpayPayment` | 200 `REFUSED_BPAY_INVALID_PAYMENT` — "Transaction declined because the BPAY payment details are incorrect or invalid." [inferred mapping] | [docs:bpay][docs:payment-transaction-outcome] |
| Unknown/inactive biller code | `makeBpayPayment` | 200 `REFUSED_BPAY_INVALID_BILLER_CODE` — "Transaction declined due to an invalid BPAY biller code provided." | [docs:payment-transaction-outcome] |
| CRN fails length/check-digit | `makeBpayPayment` | 200 `REFUSED_BPAY_INVALID_REFERENCE` — "Transaction declined due to an invalid BPAY reference number." | [docs:payment-transaction-outcome] |
| Gateway rejection | `makeBpayPayment` | 200 `REFUSED_BPAY_REJECTED` — "Transaction declined because the BPAY payment was rejected by the payment gateway." | [docs:payment-transaction-outcome] |
| Account `LOCKED` | `makeBpayPayment` | 200 `REFUSED_ACCOUNT_BLOCKED` — "Transaction declined as the account is currently blocked." | [docs:payment-transaction-outcome][docs:account-status] |
| Account `CLOSED` | `makeBpayPayment` | 200 `REFUSED_ACCOUNT_CLOSED` — "Transaction declined because the account has been closed." | [docs:payment-transaction-outcome] |
| Recipient blocked/closed (Shaype-to-Shaype only; no BPAY meaning) | `makeBpayPayment` | `REFUSED_RECIPIENT_ACCOUNT_BLOCKED` / `REFUSED_RECIPIENT_ACCOUNT_CLOSED` — "This occurs when transferring funds between Shaype accounts." | [docs:payment-transaction-outcome] |
| Capability not enabled | `makeBpayPayment` | `REFUSED_CAPABILITY_NOT_ENABLED` — in enum, undocumented | [spec] |
| Internal failure / external-auth timeout (10 s) | `makeBpayPayment` | `INTERNAL_ERROR` — "Transaction failed due to a system internal error within the payment processing service." | [docs:payment-transaction-outcome][docs:external-authorisation-and-balance] |
| `INVALID_PAYMENT` | `makeBpayPayment` | in enum; no description anywhere | [spec] |
| External-balance client refuses | `makeBpayPayment` (via callback) | client HTTP 470 `errorCode` `REFUSED_MAX_BALANCE_EXCEEDED` / `REFUSED_NOT_ENOUGH_FUNDS` / `REFUSED_SENDER_ACCOUNT_NOT_VERIFIED`; resulting API `outcome` not stated (`REFUSED_INSUFFICIENT_FUNDS` for the second [inferred]) | [ext-auth-spec] |
| Post-acceptance Cuscal rejection, error codes 100–199 | async | "an issue with the transaction itself which may or may not be related to customer input"; surfacing undocumented | [docs:bpay] |

Outcomes documented as "not currently in use" (never emit) [docs:payment-transaction-outcome]: `REFUSED_ACCOUNT_PREFERENCE`, `REFUSED_DAILY_LIMIT_EXCEEDED`, `REFUSED_AML`, `REFUSED_ACCOUNT_NOT_FOUND_FOR_CARD_TOKEN`, `REFUSED_UNDETERMINED_BALANCE_FOR_ACCOUNT`, `REFUSED_ACCOUNT_NOT_FOUND_FOR_CURRENCY`, `REFUSED_UNDETERMINED_SPENDING_FOR_ACCOUNT`, `REFUSED_UNDETERMINED_TOP_UPS_FOR_ACCOUNT`, `REFUSED_UNDETERMINED_ATM_WITHDRAWALS_FOR_ACCOUNT`.

## 7. Open questions

Decisions the implementer must make; none of these is answered by spec or docs.

1. **`retrieveBillers` response shape.** Spec says a single `BPayBillerResponse` object, but the operation is a paged list (`limit`/`offset` required, summary plural). Almost certainly an array (or a wrapper) in reality. Decide: return `BPayBillerResponse[]`.
2. **Daily-limit outcome name.** Sync enum has `REFUSED_DAILY_BPAY_LIMIT_BREACHED`; the outcome catalogue, `TransactionOutcome`, and the webhook enum only have `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`. Suggested: sync response uses `REFUSED_DAILY_BPAY_LIMIT_BREACHED` (this endpoint's own enum); if a webhook is emitted for refusals, use the webhook enum's value.
3. **Are webhooks emitted for refused payments?** Only an `ACCEPTED` example exists. Three sync outcomes (`REFUSED_DAILY_BPAY_LIMIT_BREACHED`, `REFUSED_INSUFFICIENT_FUNDS`, `INVALID_PAYMENT`) have no webhook-enum counterpart, which suggests refusals are sync-only. Decide: no webhook on refusal.
4. **`transactionId` on refusal.** Populated or absent when `outcome != ACCEPTED`? Decide (suggest absent/null).
5. **Idempotency semantics of `idempotencyKey`.** Same key + same body → return the original response? Same key + different body → 409/422? Retention window? None stated. Decide (suggest: replay original response; mismatched body → 422).
6. **Duplicate-rule HTTP codes on `createBPayBiller`.** Which of duplicate `reference`, duplicate `name`, biller-not-found maps to 409 vs 422 vs 400. Suggested mapping in §1.
7. **Uniqueness scope.** Per account (assumed) or per client/customer? Do `DISMISSED` billers still block reuse of their `name`/`reference`?
8. **Initial biller `status`** and whether `DISMISSED → ACTIVE` is permitted; whether `retrieveBillers` returns `DISMISSED` billers; and whether `status` should be added to `BPayBillerResponse` (the spec omits it — a strict cleanroom keeps it hidden).
9. **`retrieveBpayBiller` semantics.** Spec: lookup by saved-biller UUID. Docs: "based on the Biller Code" via the Look Who's Charging SearchAPI. Follow the spec (UUID) — but then the docs' "lookup a merchant by the biller code" has no endpoint.
10. **Does `makeBpayPayment` require a saved biller?** Request carries `billerCode`+`reference` directly and no biller id; treat saved billers as purely a convenience (no precondition). Should a successful payment auto-save the biller when `name` is supplied? Not stated; suggest no.
11. **Does `senderCustomerHayId` have to own/be linked to `accountId`?** Not stated; what error if not (403? `INVALID_PAYMENT`?).
12. **Biller directory and CRN rules.** `MOD10V01`, `MOD11V09`, `ICRNAMT` are named but unspecified here; Staging accepts only the enumerated Valid CRNs. Decide whether to implement the real mod-10/mod-11 algorithms or a fixture whitelist (fixture whitelist matches Staging behaviour). Seed with the §2 fixtures; note their internal inconsistencies (fixture `1016` CRN length, webhook CRN `271682361223` not in `93880`'s list, five-digit industry code `94540`).
13. **`image`/`billerImage` source.** Look Who's Charging is external; the local implementation must fabricate a URL (or leave null). Also whether `PATCH image` can override the enriched value.
14. **Where BPAY details live on the stored `FinancialTransaction`.** `ExternalCounterpartDetails` has no `bpayDetails`; `reference` is documented as NPP-only. Decide what `getTransactionById` returns for a BPAY transaction (suggest `counterpartDetails.name` = payer-supplied `name`, and expose biller code/CRN in `description`/`reference` or extend the schema).
15. **Post-acceptance rejection.** The Cuscal result-file rejection (codes 100–199) has no documented surface. Options: emit a `TRANSACTION` webhook with `outcome: REFUSED_BPAY_REJECTED`, and/or create a `BPAY_IN_REJECT`-channel credit reversing the debit. Suggest making this a test-controllable hook rather than a default behaviour.
16. **Authorisation hold.** `AuthorisationHold.type` includes `BPAY_TRANSFER_OUT`; the webhook example is `isPending: false`. Suggest no hold: debit immediately.
17. **`REFUSED_RECIPIENT_ACCOUNT_*`, `REFUSED_CAPABILITY_NOT_ENABLED`, `INVALID_PAYMENT`** — in the enum with no BPAY trigger documented. Suggest never emitting the first two; use `INVALID_PAYMENT` only if a generic non-`REFUSED_BPAY_*` validation failure is needed.
18. **Amount-vs-balance vs external balance.** For an external-balance client, does the platform still enforce "must not exceed the available balance" itself, or delegate wholly to the callback? The doc lists only card/NPP limits as pre-checks; BPAY_DAILY_LIMIT is not in that list though the BPAY doc says it is checked.
19. **Currency.** `BPayPaymentRequestBody` has no currency; multi-currency accounts exist elsewhere in the spec (FX). Assume the account's currency (AUD).
20. **`updateBpayBiller` 204 body.** Spec declares a JSON `object` content on 204; send no body.
21. **Unknown ids.** No 404 anywhere; choose 400 vs 422 for unknown `accountId`/`billerId`, and 403 for a `billerId` outside the caller's client.
22. **`limit`/`offset` validation** on `retrieveBillers` (missing, negative, max) — undefined; suggest 400 when missing/negative.
