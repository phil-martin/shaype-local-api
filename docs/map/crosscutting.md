# Shaype B2B Operations API — cross-cutting conventions

Ground truth for the local cleanroom re-implementation. Every claim is tagged `[spec]` (b2b-operations-api.json, OpenAPI 3.0.1, info.version 0.0.1), `[spec:webhooks]` (notification-webhooks.json), `[spec:ext-balance]` (external-balance.yaml), `[docs:<slug>]` (developer.shaype.com page) or `[inferred]`. Names and enums are verbatim from the source. Where the spec is silent, this file says so rather than guessing.

Spec facts used throughout `[spec]`: 169 operations, 253 component schemas, 23 tags, one server `http://localhost:8080` ("Generated server url"), no top-level `security`, no `components.securitySchemes`, one vendor extension at the root (`x-explorer-enabled`).

---

## 1. Error envelope

### 1.1 `ErrorResponse` schema `[spec]`

`jq '.components.schemas.ErrorResponse'`:

```json
{
  "type": "object",
  "properties": {
    "details": { "type": "string", "description": "Error details" },
    "message": { "type": "string", "description": "Error description" },
    "status":  { "type": "string", "description": "HTTP response status" },
    "traceId": { "type": "string", "description": "TraceID that can be used by HAY for troubleshooting the request" }
  },
  "description": "An error response."
}
```

- No `required` list — all four fields optional in the contract. `[spec]`
- `status` is a **string**, not an integer. The spec does not say whether it is `"400"` or `"BAD_REQUEST"`; see §1.5. `[spec]`
- `traceId` also appears on `DirectDebitResponse` / `DirectDebitResponseV1` as "Unique identifier (UUID) of the request used by Shaype to troubleshoot" — the only hint that a traceId is a UUID. `[spec]`

### 1.2 Status-code usage across all 169 operations `[spec]`

Counts from `jq` over every operation's `responses` keys:

| Code | Ops | Description(s) (verbatim, with counts) | Body schema |
|---|---|---|---|
| 200 | 166 | 163× `Success`; 1× `Card was already enrolled.` (rewards); 1× `Branch Identifier eligibility check completed` (checkBsbIsSupportedByPayTo); 1× `Success (response may include per-pair errors)` (getFxRates) | per-op |
| 201 | 2 | `Card successfully enrolled.` (rewards); `Created` (createOrder) | per-op |
| 202 | 1 | `Accepted` (closeAccount) | per-op |
| 204 | 1 | `Success` (updateBpayBiller) | none |
| 400 | 169 | 168× `Bad Request`; 1× `Invalid request - tag validation failed, list is empty, or operation is missing` | `ErrorResponse` (169/169) |
| 403 | 169 | `Forbidden` | `ErrorResponse` (169/169) |
| 404 | 2 | `Operator not found` (getOperatorById); `Product not found` (getProductById) | `OperatorSummary` / `ProductSummary` (**not** ErrorResponse — almost certainly a generator artefact) |
| 409 | 1 | `Conflict` (createBPayBiller) | `ErrorResponse` |
| 422 | 169 | 163× `Unprocessable Content`; 3× `Unprocessable Entity`; 1× `Invalid Input`; 1× `Branch Identifier format is invalid`; 1× `One or more accounts in scope could not be blocked` | `ErrorResponse` (166/169); `BlockAccountResponse`, `CloseAccountResponse`, `DirectDebitResponse` on the three exceptions listed in §1.3 |
| 429 | 2 | `Too many requests` (rewards → `CardRewardsStatusBody`; createMandate → `ErrorResponse`) | see left |
| 500 | 169 | `Internal Server Error` | `ErrorResponse` (169/169) |
| 501 | 169 | `Not Implemented` | `ErrorResponse` (169/169) |

**Reading:** every operation carries the identical five-code boilerplate `400/403/422/500/501 → ErrorResponse`. The spec does not distinguish *when* 400 vs 422 is raised; the response `description` is the only differentiator and it is boilerplate. No operation declares 401. `[spec]`

Implementer default `[inferred]`: 400 for malformed JSON / schema violations, 422 for semantically invalid requests (business-rule rejections), 403 for a missing/invalid bearer token (the spec declares no 401 anywhere), 404 for unknown path IDs even though only two ops declare it, 500 for unexpected failures. Treat 501 as "declared but never expected".

### 1.3 Operations whose 4xx bodies are *not* `ErrorResponse` `[spec]`

| Op | Code | Description (verbatim) | Body schema |
|---|---|---|---|
| `blockAccount` | 422 | `One or more accounts in scope could not be blocked` | `BlockAccountResponse` |
| `closeAccount` | 422 | `Unprocessable Entity` | `CloseAccountResponse` |
| `createDirectDebitV0` | 422 | `Invalid Input` | `DirectDebitResponse` |
| `rewards` | 429 | `Too many requests` | `CardRewardsStatusBody` |
| `getOperatorById` | 404 | `Operator not found` | `OperatorSummary` |
| `getProductById` | 404 | `Product not found` | `ProductSummary` |

Ops with a non-boilerplate 422 description but still `ErrorResponse`: `createHayAccount`, `createHayAccountForGroup` (`Unprocessable Entity`), `verifyBranchIdentifier` (`Branch Identifier format is invalid`). The single non-boilerplate 400 (`Invalid request - tag validation failed, list is empty, or operation is missing`) is on `modifyTagsForTransaction (/v1/transactions/{transactionHayId}/tags)`. `[spec]`

### 1.4 Example error bodies

- The B2B spec contains **no** `example`/`examples` on any 4xx/5xx response (all 250 example nodes in the spec sit on 2xx bodies or schema properties). `[spec]`
- The reference pages under `developer.shaype.com/reference/*` only repeat the `ErrorResponse` schema. `[docs]`
- The **one real error body** found in all fetched docs, from the PayTo staging test suite (a `createMandate` rejection): `[docs:payto-staging-testing-suite]`

```json
{
 "message": "NOT_FOUND: CUS.API.100522 - Creditor account details incorrect (M900 - No matching record found)",
 "details": "Please refer to the API documentation or contact Shaype for more info with the traceId.",
 "status": "422",
 "traceId": "9b8fa212-d655-487e-bf91-4406957bb584"
}
```

What that single example establishes: `status` is the numeric HTTP code **as a string** (`"422"`); `traceId` is a UUID; `details` is a generic constant sentence; `message` is free text of the shape `<REASON_CODE>: <upstream code> - <text>`. Whether `message` always starts with a `REASON_CODE:` prefix is unknown — one sample. `[docs]`+`[inferred]`

### 1.5 What is unknown about errors

Collected in §11 (Q1–Q4).

---

## 2. Authentication and connectivity

### 2.1 What the B2B spec says `[spec]`

Nothing. `jq '.security, .components.securitySchemes'` → `null, null`. No operation has a `security` array and no `header` parameter is declared on any operation (`jq` over all parameters with `in=="header"` returns 0 rows). Authentication is entirely out-of-band to the OpenAPI document.

### 2.2 Legacy setup `[docs:page/api-connectivity]`

> "In our legacy setup, we provide you with a long-living authentication token that you will need to pass as an Authentication: Bearer HTTP header."

(The page literally says `Authentication: Bearer`; the curl example in the gateway section uses `Authorization: Bearer`. Treat the doc's "Authentication" as a typo for `Authorization` `[inferred]`.) Connectivity is AWS PrivateLink or site-to-site VPN; IP allow-listing exists in staging only.

### 2.3 API Gateway setup — OAuth2 client-credentials via AWS Cognito `[docs:page/api-connectivity]`

Verbatim curl from the page:

```
curl --location --request POST <cognito-url>/oauth2/token \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode client_id=<client-id> \
  --data-urlencode client_secret=<client-secret> \
  --data-urlencode grant_type=client_credentials
```

- Token endpoint: `POST {cognito-url}/oauth2/token`, body `application/x-www-form-urlencoded` with `client_id`, `client_secret`, `grant_type=client_credentials`. Per-client Cognito URL, protected by IP allow-list. `[docs]`
- Lifetime: "An access token will be returned by Cognito, this allows access to the Shaype API gateway for 60 mins. Once this token expires please repeat the process above to obtain an updated access token." `[docs]`
- Use: `curl --location 'https://staging.api.au.shaype.com/v1/products' --header 'Authorization: Bearer <<access-token>>'` `[docs]`
- The page does not show the Cognito token response body. Standard Cognito client-credentials returns `{"access_token","expires_in","token_type":"Bearer"}` `[inferred — AWS Cognito behaviour, not from Shaype docs]`.
- Different Cognito endpoints, gateway endpoints and client credentials per environment. `[docs]`

### 2.4 Base URLs `[docs:page/api-connectivity]`

| Environment | Host (verbatim) |
|---|---|
| Staging | `staging.api.au.shaype.com` |
| Production | `prod. api.au.shaype.com` (sic — stray space in the doc table; `[inferred]` `prod.api.au.shaype.com`) |

Paths in the spec are absolute (`/v0/...`, `/v1/...`) and the example call is `https://staging.api.au.shaype.com/v1/products`, so the gateway host is the origin with **no path prefix**. `[spec]+[docs]`

### 2.5 What an unauthenticated call returns

**Unknown.** Neither the spec nor any fetched page documents the status/body for a missing or expired token. The spec declares 403 `Forbidden` (ErrorResponse) on every operation and never 401. `[spec]` Implementer default: 403 with an `ErrorResponse` `[inferred]`; see §11.

### 2.6 Related auth material for the *outbound* direction (Shaype → client)

See §7.3 (`Shaype-*` headers, RSA signatures, JWKS at `https://auth.{staging,prod}.hay.co/.well-known/jwks.json`). `[docs:external-authorisation-and-balance]`

---

## 3. Pagination

There is **no single pagination convention**. Five query-param families exist, and only one operation returns a total count. No cursor / next-token / `Link` header / `hasNext` appears anywhere in the spec (a jq scan of all schema property names for `content|totalElements|totalPages|hasNext|pageable|number|first|last|cursor|nextToken` finds nothing but liquidity `total`s). `[spec]`

### 3.1 Family A — `offset` / `limit` (12 ops) `[spec]`

Two sub-flavours; the response is always a **bare JSON array** of the entity, with no count or wrapper.

| Op | Route | Params (verbatim schema + description) |
|---|---|---|
| `getAllStackTransactions` | `GET /v0/accounts/{accountId}/stacks/transactions` | `offset`: req=true, integer — "Offset used for paging results"<br>`limit`: req=true, integer — "List fetch limit, value between 1 and 1000" |
| `getTransactionsForStack` | `GET /v0/accounts/{accountId}/stacks/{stackId}/transactions` | `offset`: req=true, integer — "Offset used for paging results"<br>`limit`: req=true, integer — "List fetch limit, value between 1 and 1000" |
| `getAllCustomers` | `GET /v0/customers` | `offset`: req=true, integer/int32 — "Offset used for paging results"<br>`limit`: req=true, integer/int32 — "List fetch limit" |
| `searchCustomers` | `POST /v0/customers/search` | `limit`: req=true, integer/int32 — "List fetch limit, value between 1 and 1000"<br>`offset`: req=true, integer/int32 — "Offset used for paging results" |
| `getDirectDebitsV0` | `GET /v0/direct-debits` | `offset`: req=true, integer/int32 — "Offset used for paging results"<br>`limit`: req=true, integer/int32 — "List fetch limit, value between 1 and 1000" |
| `searchTransactions` | `POST /v0/transactions/search` | `limit`: req=true, integer/int32 — "List fetch limit, value between 1 and 1000"<br>`offset`: req=true, integer/int32 — "Offset used for paging results" |
| `retrieveBillers` | `GET /v1/accounts/{accountId}/bpay-billers` | `limit`: req=true, integer/int32 — ""<br>`offset`: req=true, integer/int32 — "" |
| `getDirectDebitsV1` | `GET /v1/direct-debits` | `offset`: req=true, integer/int32 — "Offset used for paging results"<br>`limit`: req=true, integer/int32 — "List fetch limit, value between 1 and 1000" |
| `getCountries` | `GET /v1/perks/countries` | `limit`: req=false, integer/int32, default 20, min 1, max 100 — "Maximum results to return (page size); defaults to 20, max 100"<br>`offset`: req=false, integer/int32, default 0, min 0 — "Number of results to skip; defaults to 0" |
| `getOperators` | `GET /v1/perks/operators` | `limit`: req=false, integer/int32, default 20, min 1, max 100 — "Maximum results to return (page size); defaults to 20, max 100"<br>`offset`: req=false, integer/int32, default 0, min 0 — "Number of results to skip; defaults to 0" |
| `getOrders` | `GET /v1/perks/orders` | `limit`: req=false, integer/int32, default 20, min 1, max 100 — "Maximum results to return (page size); defaults to 20, max 100"<br>`offset`: req=false, integer/int32, default 0, min 0 — "Number of results to skip; defaults to 0, must be a multiple of limit" |
| `getProducts` | `GET /v1/perks/products` | `limit`: req=false, integer/int32, default 20, min 1, max 100 — "Maximum results to return (page size); defaults to 20, max 100"<br>`offset`: req=false, integer/int32, default 0, min 0 — "Number of results to skip; defaults to 0" |

- Legacy flavour (8 ops): both params **required**, no declared default/min/max; `getAllStackTransactions`/`getTransactionsForStack` declare plain `integer` (no `int32`). Only the direct-debit ops say "List fetch limit, value between 1 and 1000" and "must be a multiple of limit"; the others just say "List fetch limit" / "Number of results to skip; defaults to 0". `[spec]`
- Perks flavour (4 ops, `/v1/perks/*`): optional, `limit` default 20 / min 1 / max 100, `offset` default 0 / min 0. `[spec]`
- Implementer note `[inferred]`: for the legacy flavour, accept `limit` 1–1000 and treat a missing required param as 400; for perks apply the declared defaults and clamp to max 100 (or 400 — the spec does not say which).

### 3.2 Family B — `pageNumber` / `pageSize` (1 op) `[spec]`

Only `getMandates` (`GET /v1/payto/mandates`): `pageNumber` int32 **min 1** (1-based) required; `pageSize` int32 min 1 **max 50** required; filters `accountIds` (array<string>, required, "Account numbers") and `statuses` (array of `CREATED|ACTIVE|SUSPENDED|CANCELLED`). Response is the **only paginated wrapper in the spec**:

```
GetMandatesResponseBody  (required: result, totalCount)
  result:     array<GetMandateSummaryDto>   "List of mandates on the given page."
  totalCount: integer(int32)                "Count of all matching mandates."
```

### 3.3 Family C — `fromUtc` / `toUtc` (2 ops) `[spec]`

`getDirectDebitsV0`, `getDirectDebitsV1`: both **required**, `type: string, format: date` (a calendar date, despite the description "DateTime in UTC format for the start/end date range of the Transaction search"). Combined with Family A offset/limit and a `status` enum filter (V1 adds `senderAccountNumber`). Implementer: accept `YYYY-MM-DD`; whether a full timestamp is also accepted is unknown `[inferred]`.

### 3.4 Family D — `from` / `to` (2 ops) `[spec]`

`getMandateActionsByInitiator`, `getMandateActionsByPayer`: optional strings with a strict regex (ISO-8601 UTC, `Z` suffix mandatory, up to 3 fractional digits):

```
^(?:[1-9]\d{3}-(?:(?:0[1-9]|1[0-2])-(?:0[1-9]|1\d|2[0-8])|(?:0[13-9]|1[0-2])-(?:29|30)|(?:0[13578]|1[02])-31)|(?:[1-9]\d(?:0[48]|[2468][048]|[13579][26])|(?:[2468][048]|[13579][26])00)-02-29)T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.[0-9]{1,3})?(?:Z)$
```

Semantics (verbatim): `from` — "If omitted, then this time defaults to the moment of mandate creation. If provided, then this must not be a time in the future."; `to` — "If omitted, then this time defaults to the current moment in time. If provided, then this must not be a time in the future." Plus `pendingOnly` boolean. No paging params; response is unpaged.

### 3.5 Family E — `fromDate` / `toDate` (1 op) `[spec]`

`getOrders` (perks): plain `string`, "Created-from timestamp (ISO 8601); window to toDate max 24h" / "Created-to timestamp (ISO 8601)". Combined with Family A perks-flavour paging.

### 3.6 Body-carried date range (1 op) `[spec]`

`searchTransactions` puts the range in the body: `SearchTransactionsRequestBody.fromDateTimeUtc` / `toDateTimeUtc` (`date-time`, **both required**) and paging in the query (`limit`, `offset` required; `sortBy` enum `CLEARING_TIME` ("default if not provided") | `TRANSACTION_TIME`). See §8.

### 3.7 Ops returning bare arrays (28) `[spec]`

All list/search endpoints return `type: array` at the top level, never an envelope: getCardsForAccountId, getPendingHolds, getScheduledPayments, getAllStacks, getAllStackTransactions, getTransactionsForStack, getAllCustomers, searchCustomers, getAccountsForCustomerId, getCardsForCustomerId, getDirectDebitsV0, getAllMerchantCategoryCodes, getPayIdDeregisterHistory, searchTransactions, searchAccounts, getAccountLimits, getPayIdsForAccount, getAccountRules, getDirectDebitsV1, searchConversions, getClientLiquidityThresholds, getMandateIdsByInitiator (array of uuid strings), getCountries, getOperators, lookupOperators, getOrders, getProducts, getAllProducts.

---

## 4. Identifiers

### 4.1 Entity IDs `[spec]`

Every entity identifier is `type: string, format: uuid`, in path params, bodies and responses alike. No pattern and no example on any path param (only `branchIdentifier` has an example, `636636`). Naming is inconsistent between "…HayId" (response objects) and "…Id" (path params / request bodies) for the same thing:

| Concept | Response field | Path / request field | Notes |
|---|---|---|---|
| Customer | `customerHayId` (HayCustomer, HayCard, HayScheduledPayment) | path `{customerHayId}` (3 ops) **and** `{customerId}` (9 ops); body `customerId`, `senderCustomerHayId`, `customerHayIds[]` | same UUID |
| Account | `accountHayId` (HayAccount, HayCard, FinancialTransaction, AuthorisationHold, BPayBillerResponse) | path `{accountId}` (39 ops); body `accountId`, `accountHayId`, `recipientAccountHayId`, `parentAccountId`, `accountHolderId` | same UUID |
| Card | `cardHayId` (HayCard); `cardId` (FinancialTransaction, AuthorisationHold); `renewedIntoCardId` | path `{cardId}` (21 ops) | same UUID |
| Transaction | `transactionHayId` (FinancialTransaction, DeTransactionDetails[V1]); `transactionId` (TransactionOutcome, DirectDebitResponse[V1], BpayPaymentResponseBody); `hayId` (HayStackTransaction) | path `{transactionHayId}` (3 ops), `{transactionId}` (3 ops) | |
| Hold | `holdHayId` (AuthorisationHold); `relatedHoldHayId` (FinancialTransaction) | path `{holdId}` | |
| Mandate | `mandateId` (uuid) — but in `GenerateMandateNotificationMandateDetailsDto` it is `^[0-9a-fA-F]{32}$` "Identifier of the mandate affected by action expressed as Unique identifier (UUID) version 1 format without the 4 hyphen separators." (same for `actionId`) | path `{mandateId}` (17 ops) | two encodings |
| PayID | `payId` — **plain string**, "PayID of Account receiving the transfer" (email / phone / ABN / org id, discriminated by `payIdType` enum `EMAIL|TELEPHONE|INDIVIDUAL_AUSTRALIAN_BUSINESS|ORGANISATION`) | path `{payId}` (7 ops, `type: string`) | not a UUID |
| Group | `groupHayId` | path `{groupHayId}` (5 ops) | |
| Stack | `stackHayId` (HayStack, HayStackTransaction); `hayId` (Stack) | path `{stackId}` (5 ops) | |
| Biller (BPAY) | `hayId` (BPayBillerResponse) | path `{billerId}` | |
| Product (perks) | `id`, `productId` | path `{id}` | |
| Scheduled payment | `hayId` | path `{paymentId}`; one `{accountId}` is mis-described as "Unique identifier (UUID) of the Scheduled Payment" | |
| Rule / Threshold / Conversion / Quote | `id`, `conversionId`, `quoteId` | `{ruleId}`, `{thresholdId}`, `{conversionId}` | |
| Idempotency | `idempotencyKey` uuid | body only | §7.2 |
| Trace | `traceId` string — ErrorResponse: "TraceID that can be used by HAY for troubleshooting the request"; DirectDebitResponse[V1]: "Unique identifier (UUID) of the request used by Shaype to troubleshoot" | | docs example is a UUID |

Example UUIDs from the docs `[docs:sample-requests-responses]`: `customerHayId: "d177961c-68a6-45fa-af8d-d571d274b111"`, `accountHayId: "7bd7479d-787a-9876-8a11-d8424f1ea078"`, `productId: "997d394b-e22f-8467-a69d-0b209671brre"` (sic — not valid hex; the docs samples are hand-edited). Spec-embedded examples: `Tag.id: "550e8400-e29b-41d4-a716-446655440000"`, perks ids `"3f2504e0-4f89-41d3-9a0c-0305e82c3301"`, `idempotencyKey: "79ac5cce-3349-42ed-aa67-9764c8a35d31"`. `[spec]`

Implementer default `[inferred]`: generate v4 UUIDs; accept any RFC-4122 string on input; treat a non-UUID path param as 400.

### 4.2 `accountNumber` and `bsb` `[spec]`

| Field | Where | Declared shape (verbatim) |
|---|---|---|
| `bsb` | HayAccount | `string`, "BSB (Bank State Branch) of Account, 6 digits in length" |
| `bsb` | AccountTransfer (request) | `string`, `pattern: [\d]{6}`, minLength 1 |
| `accountNumber` | HayAccount | `string`, "Account number, 5-9 digits in length" |
| `accountNumber` | SearchAccountsRequestBody, AccountTransfer | `string`, `pattern: [\d]{5,9}` |
| `accountNumber` | CreateAccountRequestBody | `string`, `pattern: ^[1-9][0-9]{7,8}$`, "Account number, 8-9 digits in length", nullable (client-chosen number) |
| `accountNumber` | PayTo Create*DetailsDto / GetMandateActions*Dto | `string`, `pattern: ^[ -~]{11,15}$` (or minLength 11 / maxLength 15), "BSB (Bank State Branch) of Account, 6 digits in length combined with account number, 5-9 digits in length." — **BSB+account concatenated** |
| `branchNumber` + `accountNumber` | BasicAccountNumber, PayIdAccountDetails | `branchNumber` "BSB (Bank State Branch) of Account, 6 digits in length" |
| `senderBsb`/`recipientBsb`, `senderAccountNumber`/`recipientAccountNumber` | Direct-debit / DE schemas | `\d{6}` and `\d{5,9}` (utility mocks: `[0-9]{6}`, `[0-9]{6,9}`, `[0-9]{8}`) |
| path `{bsbNumber}`, `{branchIdentifier}` | NPP eligibility | `pattern: ^\d{6}$` |

Docs example `[docs:sample-requests-responses]`: `"accountNumber": "66090672"`, `"bsb": "636220"`. Spec examples: `senderBsb "302227"`, `senderAccountNumber "112836327"`, `recipientAccountNumber "522843"`, `recipientBsb "35022223"` (sic — 8 digits, contradicts its own `\d{6}` pattern). `[spec]`

Implementer default `[inferred]`: issue one fixed 6-digit BSB (e.g. `636220` from the docs) and 8-digit account numbers matching `^[1-9][0-9]{7}$`; in PayTo DTOs serialise `accountNumber` as `bsb + accountNumber` (14 chars).

### 4.3 Other formatted identifiers `[spec]`

`businessNumber` ABN 11 chars; `companyNumber` ACN / `registeredBodyNumber` ARBN / `registeredSchemeNumber` ARSN 9 chars; `merchantCategoryCode` `^\d{4}$`; `merchantId` "maximum 15 characters", `terminalId` "maximum 8 characters"; `mobileNumber` E.164 `^\+[1-9][0-9]{6,14}$`; `endToEndId`/`instructionId` ≤35 chars; `partyReference` `^[ -~]{1,35}$`; `initgPtyIdOrgId` BIC11 `^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}[A-Z0-9]{3}$`; Cuscal `paymentId` = BIC11 + 23 digits; `externalCustomerId` ≤64 chars; `identityDocumentCardNumber` `^[a-zA-Z0-9]{6,10}$`.

---

## 5. Money and dates

### 5.1 Amounts `[spec]`

Three representations coexist:

1. **Plain `number`, 2 dp, no currency** — the dominant form. `amount` on CreateTransactionRequestBody, CreateDirectDebitRequestBody, AccountToStackTransferRequestBody, HayStackTransaction, DeTransactionDetails[V1] ("Value of the Transaction, to 2 decimal places"); all `HayAccount` balances (`totalBalance`, `availableBalance`, `heldBalance`, `lockedBalance`, `stacksBalance`, `overdraftBalance`, `overdraftLimit`, `technicalOverdraftBalance`), `FinancialTransaction.rollingAccountBalance`, limits (`limitAmount`, `maxBalanceLimit`, `overdraftLimit`), stack `balance`/`targetAmount` (`format: double` on CreateHayStackRequestBody). Request amounts usually carry `minimum: 0, exclusiveMinimum: true`. Utility mock card amounts are **negative** (`maximum: 0, exclusiveMaximum: true`, "Transaction amount."). Docs show balances serialised as bare `0` (`"totalBalance": 0`). `[docs:sample-requests-responses]`

2. **`CurrencyAmount`** `{ amount: number "Amount of the transaction to 2 decimal places", currency: enum(162 ISO-4217 codes) }`, both required, description "Monetary value and currency". Embedded by 14 schemas: AuthorisationHold (`currencyAmount`, `originalCurrencyAmount`), FinancialTransaction (same two), HayScheduledPayment / HayArchivedScheduledPayment, PaymentDto, MakeAdhocPaymentRequestBody, SetScheduledPaymentInitiationAmountRequestBody, Create/GetPaymentTermsDto(+Summary), Conversion{Quote,Execute,Details}Response, LiquidityBalancesResponse (example `[{"amount":1250.75,"currency":"AUD"},{"amount":99.1,"currency":"USD"}]`). Docs example: `"amount": { "amount": 2.10, "currency": "AUD" }`. `[docs:payto-staging-testing-suite]`

3. **`CurrencyAmountDto`** (PayTo notification/action DTOs) — `amount` is a **string** with `pattern ^(?=.{1,19}$)[0-9]{0,18}(?:\.[0-9]{0,2})?$`, `currency` `^[A-Z]{3}$`. The same string-amount pattern is on GenerateMandateNotificationPaymentInformationDto and the GenerateRap*PaymentInformation fields. Perks use `Money` / `MonetaryValue`: `amount: number(double)`, `currency: string` (no enum), example `{"amount": 5, "currency": "USD"}`.

Contrast `[spec:ext-balance]`: the outbound External Authorisation API's `CurrencyAmount` is `{ amount: string, currency: string }` — "Transaction amount. Positive when crediting customer account and negative when debiting." — examples `"12.43"`, `"56.87"`, `"1260.94"`.

Implementer note `[inferred]`: store a decimal string or minor units internally; serialise B2B `number` amounts as JSON numbers with ≤2 dp; emit strings only in CurrencyAmountDto / ext-balance payloads.

### 5.2 Currency `[spec]`

`currency` is a 162-value ISO-4217 enum (`AED, AFN, ALL, …` incl. `CNH`, `XCG`, `ZWG`) on CurrencyAmount, HayAccount, HomeCurrencyBalanceEquivalent and the FX schemas; `nullable: true` on CreateAccountRequestBody and the mock-card bodies ("Transaction currency. Defaults to AUD if not provided."). Non-enum `string` on Money / MonetaryValue and CurrencyAmountDto (`^[A-Z]{3}$`).

### 5.3 Dates and times `[spec]`

- **Timestamps**: `type: string, format: date-time`, field names end in `Utc` — `creationDateTimeUtc`, `lastUpdatedDateTimeUtc`, `closedDateTimeUtc`, `approvedDateTimeUtc`, `issuedDateTimeUtc`, `voidDateTimeUtc`, `transactionTimeUtc`, `clearingTimeUtc`, `expiresAtUtc`, `createdAtUtc`, `closedAtUtc`, `registrationDateTimeUtc`, `lastResolutionDateTimeUtc`, `lastProcessedDateTimeUtc`, `fromDateTimeUtc`/`toDateTimeUtc`. Description boilerplate "DateTime in UTC format when …". Docs render them with **microseconds and `Z`**: `"creationDateTimeUtc": "2024-03-12T22:59:48.357089Z"`; the create-case sample uses millis: `"timestamp": "2024-03-12T23:00:17.559Z"`. `[docs:sample-requests-responses]`
- Exceptions without the suffix: `creationDateTime` (PaymentInstruction, date-time), perks `createdAt`/`confirmedAt`/`dueDate` (plain string "ISO 8601"), PayTo action `time` (regex-constrained `…Z`, "UTC expressed without offset"), `UserConsentRequestBody.consentObtainedAt`, and `accessExpiresUtc`, which is an **`integer int64`** (epoch — units not stated).
- **Dates**: `format: date` (`YYYY-MM-DD`) — `dateOfBirth`, `identityDocumentExpiry` (ex `2030-06-15`), card `expiryDate` (ex `2027-09-30`, "date of the last day of the expiry month and year" — but on HayCard it is a plain `string`), `processingDate`, `startDate`/`endDate`, `validityStartDate`/`validityEndDate` (PayTo DTOs use a leap-year-aware regex instead; end-date semantics "valid until 23:59:59.999 Australia Sydney time"), query `fromUtc`/`toUtc`/`date`/`conversionDate`.
- Timezone: everything is UTC unless the field says otherwise (only the PayTo validity dates reference Australia/Sydney). `[spec]`

---

## 6. Shared schemas (referenced by ≥3 operations, or embedded by ≥3 schemas)

Computed with jq over `$ref`s inside each operation (direct) and inside each component schema (transitive). `[spec]`

| Schema | Ops (direct) | Used by |
|---|---|---|
| `ErrorResponse` | 169 | every op (§1) |
| `GenericMessage` | 47 | all state-change ops: block/unblock/cancel/activate card, customer, PayID, mandate actions, utility mock triggers, custom-data create/delete, limit updates |
| `HayCard` | 7 | getCardsForAccountId, createHayCard, getCard, convertCard, reissueHayCard, renewCard, getCardsForCustomerId |
| `HayCustomer` | 6 | getAllCustomers, createHayCustomer, searchCustomers, getHayCustomerById, updateCustomer, changeHayCustomerStatus |
| `TransactionOutcome` | 6 | makeTransferV0/V1, createCreditTransactionV0/V1, createDebitTransactionV0/V1 |
| `HayAccount` | 5 | getHayAccount, createHayAccount, getAccountsForCustomerId, createAccount, searchAccounts (+ embedded in HayJointAccount) |
| `CreateTransactionRequestBody` | 4 | createCredit/DebitTransactionV0/V1 |
| `HayJointAccount` | 4 | getHayJointAccountByGroupHayId, createHayAccountForGroup, addCustomersToGroup, removeCustomerFromGroup |
| `BPayBillerResponse` | 3 | retrieveBillers, createBPayBiller, retrieveBpayBiller |
| `ConfirmationResponse` + `OnboardingStageApprovalBody` | 3 | approveAmlKycCheck, approveDocumentCheck, approveSanctionCheck |
| `ExternalTransactionRuleResponse` | 3 | getAccountRules, addAccountRule, getAccountRuleById |
| `LiquidityThreshold` | 3 | getClientLiquidityThresholds, createLiquidityThreshold, updateLiquidityThreshold |
| `ProductSummary` | 3 | getProducts, getProductById, getAllProducts |
| `CurrencyAmount` | — | 14 schemas (§5.1) |
| `Address` | — | 7: ConvertCardRequestBody, CreateHayCardRequestBody, CreateHayCustomerRequestBody, HayCustomer, ReissueHayCardRequestBody, RenewCardRequestBody, UpdateCustomerRequestBody |
| `PhoneNumber` | — | 5: CreateHayCardRequestBody, CreateHayCustomerRequestBody, HayCustomer, SearchCustomersRequestBody, UpdateCustomerRequestBody |
| `BusinessIdentifiers` | — | 4: CreateHayGroupRequestBody, HayGroup, HayJointAccount, UpdateGroupRequestBody |
| `MerchantDetails` | — | 4 utility mock-card bodies |
| `Tag` | — | 3: FinancialTransaction, ModifyTagsRequestBody, TagsResponseBody |

### 6.1 Field lists (verbatim names; enums verbatim) `[spec]`

**GenericMessage** — `{ message: string "Message indicating operation result" }`, description "Message response", nothing required.
**ConfirmationResponse** — `{ message: string "A confirmation message." }`. **OnboardingStageApprovalBody** — `{ comments: string "Note / comment to be captured with approval" }`.

**TransactionOutcome** — `{ outcome: enum, transactionId: uuid "Unique identifier (UUID) of the Transaction" }`. `outcome` enum (21 values) begins `ACCEPTED, INTERNAL_ERROR, REFUSED_LIMIT_BREACH, REFUSED_FRAUD, REFUSED_CUSTOMER_PREFERENCE, REFUSED_INSUFFICIENT_FUNDS, REFUSED_ACCOUNT_BLOCKED, REFUSED_RECIPIENT_ACCOUNT_BLOCKED, REFUSED_ACCOUNT_CLOSED, REFUSED_RECIPIENT_ACCOUNT_CLOSED, REFUSED_INVALID_PAY_ID, UNKNOWN, …` — full list in transactions-holds.md.

**CurrencyAmount** — `{ amount: number, currency: enum }` both required. **Address** — required `countryCodeIso` ("Country as three letter code as per ISO 3166"), `line1`; optional `line2`, `townOrCity`, `administrativeRegion` ("Second part of ISO 3166-2 region code"), `postcode`. **PhoneNumber** — required `countryCodePrefix`, `numberAfterPrefix` (docs: request `"+61"` is echoed back as `"61"` `[docs:sample-requests-responses]`). **BusinessIdentifiers** — `businessNumber` (ABN, 11), `companyNumber` (ACN, 9), `registeredBodyNumber` (ARBN, 9), `registeredSchemeNumber` (ARSN, 9). **MerchantDetails** — `merchantCategoryCode` (`^\d{4}$`, nullable), `merchantId` (nullable), `merchantName` (nullable). **Tag** — `id` uuid | `category` + `value` (pattern `\S(.*\S)?`), all three nullable; "Either provide an 'id' to reference an existing tag, or provide both 'category' and 'value' to create/reference a tag."

**HayCustomer** (24 props, none required): `customerHayId, clientReference, customerDetails→CustomerDetails, email, phoneNumber→PhoneNumber, address→Address, deviceId, deviceOs{enum}, firebaseToken, identityDocumentType{enum}, identityDocumentNumber, identityDocumentCardNumber, identityDocumentExpiry(date), identityDocumentIssuingCountry, identityDocumentRegion, tier{enum}, status{ACTIVE,INACTIVE,REJECTED,BLOCKED,PENDING_APPROVAL,REFERRED}, statusReason{SUSPICIOUS,DECEASED,CUSTOMER,OPERATIONAL}, blockedBy{CLIENT,PLATFORM}, customData(object,nullable), creationDateTimeUtc, lastUpdatedDateTimeUtc, approvedDateTimeUtc, closedDateTimeUtc`.

**HayAccount** (22 props; `required: ["customData"]` — sic): `accountHayId, accountHolderId, accountHolderType{CUSTOMER,GROUP}, productId, parentAccountId(nullable), accountNumber, bsb, currency{enum}, status{PENDING_APPROVAL,APPROVED,ACTIVE,LOCKED,DORMANT,CLOSED,ACTIVE_IN_ARREARS}, blockedBy{CLIENT,PLATFORM}, totalBalance, availableBalance, heldBalance, lockedBalance, stacksBalance, overdraftBalance, overdraftLimit, technicalOverdraftBalance, homeCurrencyBalanceEquivalent→HomeCurrencyBalanceEquivalent, customData(object,nullable), creationDateTimeUtc, closedDateTimeUtc`. The docs create-account sample returns **no** `customData` key despite the schema marking it required, and `getHayAccount` has `?expand=customData` "Includes Custom Data with returned Account object". `[docs:sample-requests-responses]`+`[spec]`

**HayCard** (15 props, none required): `cardHayId, accountHayId, customerHayId, cardStatus{ACTIVE,AWAITING_ACTIVATION,BLOCKED,INACTIVE,EXPIRED}, blockedBy{CLIENT,PLATFORM}, cardType{enum}, deliveryMethod{enum}, cardToken, lastFourDigits, nameOnCard, nameOnCardLine2, expiryDate(string), issuedDateTimeUtc, voidDateTimeUtc(nullable), renewedIntoCardId(nullable)`.

**HayJointAccount** — `groupHayId, groupType{PERSONAL,BUSINESS}, name, customerHayIds[uuid], businessIdentifiers→BusinessIdentifiers, hayAccount→HayAccount`.

**CreateTransactionRequestBody** — required `accountHayId, amount, counterpartName, description, idempotencyKey, transactionChannel`; optional `category, originChannel{ATM_CASH,POS_DEBIT,VENUE}, originId(uuid), originType{CUSTOMER,SCHEDULED_PAYMENT,HAAS_OPERATIONS,OPERATIONS,DIRECT_DEBIT}, reference("only applicable to NPP transactions, maximum 35 alphanumeric characters")`; `transactionChannel{LOAN_REPAYMENT,MANUAL_ADJUSTMENT,INTEREST_ADJUSTMENT,LOAN_ADJUSTMENT,ACCOUNT_ADJUSTMENT,SERVICE_FEE,APPLE_REWARD}`.

**BPayBillerResponse** — `hayId, accountHayId, name, image, billerDetails→BPayBillerDetails`. **ExternalTransactionRuleResponse** — `id, name, ownerId(string: "either the Customer ID or Client Reference"), ruleType{MERCHANT_CODE_BLOCK,MERCHANT_ID_BLOCK,MERCHANT_NAME_BLOCK}, rule→Rule, disabled, expiresAtUtc`. **LiquidityThreshold** — required `id, clientReference, type{TOTAL_DAILY_INBOUND_DIRECT_DEBIT,TOTAL_DAILY_NET_NON_SCHEME,TOTAL_DAILY_NET_VISA,TOTAL_DAILY_OUTBOUND_BPAY}`; `active, external, percental, amount(nullable, min 1), percent(int32 1–100, nullable)`. **ProductSummary** (perks) — `id, name, description, countryIsoCode, operatorId, operatorName, type{FIXED_VALUE_RECHARGE,RANGED_VALUE_RECHARGE,FIXED_VALUE_PIN_PURCHASE,RANGED_VALUE_PIN_PURCHASE,RANGED_VALUE_PAYMENT}, perkSubType{17 values}, source/destination→MonetaryValue, redemption→RedemptionDetails, required*Fields: array<array<string>>`.

---
