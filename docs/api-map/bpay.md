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
