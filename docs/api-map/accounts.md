# accounts

Domain map for the **Accounts API** tag of the Shaype B2B Operations API (spec title "B2B Operations API", version "0.0.1"). 24 operations. Source labels: `[spec]` = b2b-operations-api.json, `[webhook-spec]` = notification-webhooks.json, `[ext-auth-spec]` = external-balance.yaml (JSON content), `[docs:<slug>]` = developer.shaype.com page, `[inferred]` = not stated anywhere; implementer's reasonable reading.

Conventions used below:
- Every `accountId` path parameter is `string`, `format: uuid`, required, description "Unique identifier (UUID) of the Account" [spec] (makeTransferV0 says just "Account ID").
- **Common error responses** (identical on every operation unless stated): `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content`, `500 Internal Server Error`, `501 Not Implemented`, all with body `ErrorResponse` [spec]. `ErrorResponse` = `{ details: string ("Error details"), message: string ("Error description"), status: string ("HTTP response status"), traceId: string ("TraceID that can be used by HAY for troubleshooting the request") }` — none marked required [spec]. The spec never says which condition yields 400 vs 422; the only documented 422 bodies are the `fx.childAccounts` validation messages on createAccount [docs:bulk-account-opening] and the closure/block special-case bodies below.
- No 404 is declared on any Accounts operation [spec]. Unknown-account behaviour is an open question (section 7).
- No `security` section and no `securitySchemes` exist in the spec [spec]; auth is out of scope for this map.
- `GenericMessage` = `{ message: string ("Message indicating operation result") }` [spec].
- Currency enums: `HayAccount.currency`, `CurrencyAmount.currency`, `HomeCurrencyBalanceEquivalent.currency`, `ChildAccountsDataRequest.currencies[]` use the full 163-value ISO 4217 list (AED … ZWL, including CNH, XCG, ZWG). `CreateAccountRequestBody.currency` uses a restricted 31-value list (given verbatim under createAccount). Verified by jq.

## 1. Operations

### GET /v0/accounts/{accountId} (getHayAccount)

- Purpose: "Get Account by ID" — returns the full `HayAccount` [spec]. Not deprecated.
- Path params: `accountId` (uuid, required).
- Query params: `expand` (string, optional, description "Includes Custom Data with returned Account object", example `` `customData` ``) [spec]. Only the value `customData` is documented [spec]. Whether `customData` is omitted / null when not expanded is not stated — note `HayAccount.required` = `["customData"]` [spec], so the property is always present; [inferred] it is `null` unless expanded.
- Request body: none.
- Response: `200 Success` → `HayAccount` (see section 2 for every field). Common error responses.
- Behaviour: read-only [spec]. "Accounts are identified by a unique ID and all account information is retrievable using this ID" [docs:account]. Balances, overdraft, status, and `homeCurrencyBalanceEquivalent` (multi-currency) are all on this object [spec].
- Webhooks: none.

### POST /v0/accounts/{accountId}/block (blockAccount)

- Purpose: "Block Account and Customer". Spec description verbatim: "Blocks the account (and by default its owning customer(s)). When the account has child accounts linked (e.g. the FX accounts of a multi-currency wallet), every child is blocked in the same request. The request succeeds when every account in scope ends blocked or closed. The operation is idempotent and can be safely retried." [spec]. Schema-level deprecation notice: "**Body of a request to block an account.** (Deprecation Notice: this functionality will be modified in the future releases, check schema for more details)." [spec]
- Path params: `accountId` (uuid, required).
- Request body (required): `BlockAccountRequestBody`
  - `note` — string, **required**, `minLength: 1`, "Note or explanation for reason block is applied" [spec].
  - `accountBlockStyle` — string, optional, enum `ACCOUNT_ONLY` | `ACCOUNT_AND_CUSTOMER`. Description verbatim: "Deprecation Notice: ACCOUNT_AND_CUSTOMER value to be removed. Deprecation Notice: ACCOUNT_AND_CUSTOMER default value to be removed. Controls which entities will have block applied. Use of ACCOUNT_ONLY is encouraged. Possible values: **ACCOUNT_ONLY** (Preferred): Only the account will be blocked. **ACCOUNT_AND_CUSTOMER** (Default if no value provided): Both the account and customer(s) owning it will be blocked. It returns SUCCESS in case of partial success (Account blocked, but customer not blocked due to permission issues)." [spec]
- Response:
  - `200 Success` → `BlockAccountResponse` = `{ failedAccounts: uuid[] ("Accounts that could not be blocked and remain able to transact. Empty when every account in scope ended blocked or closed."), message: string ("Outcome message for the block request") }` [spec].
  - `422 One or more accounts in scope could not be blocked` → **`BlockAccountResponse`** (not ErrorResponse) [spec] — i.e. `failedAccounts` non-empty.
  - `400`, `403`, `500`, `501` → `ErrorResponse`.
- Behaviour:
  - Account `status` → `LOCKED` [docs:accounts-overview "On a blocked account, the account status would be LOCKED"]. `HayAccount.blockedBy` → `CLIENT` when blocked via this API [inferred from the `blockedBy` enum `CLIENT` "The account was blocked by the Client" / `PLATFORM` "blocked by the Platform"].
  - Scope = the account plus every linked child account (FX children); success iff every account in scope ends `LOCKED` or `CLOSED` [spec]. Already-`CLOSED` accounts in scope do not fail the request [spec].
  - Default (`accountBlockStyle` absent or `ACCOUNT_AND_CUSTOMER`): owning customer(s) are also blocked [spec] → customer `status` `BLOCKED` [inferred from `HayCustomer.status` enum in spec and `CustomerStatusUpdatedEventDto.customerStatus` enum `BLOCKED` in webhook-spec]. For a GROUP-held account "customer(s)" plural implies every group member [inferred]. Partial success (account blocked, customer not, due to permissions) still returns success [spec].
  - `LOCKED` "will block all transactions and transfers to the account" [docs:account-status]. Transfers into/out of a LOCKED account produce outcome `REFUSED_ACCOUNT_BLOCKED` / `REFUSED_RECIPIENT_ACCOUNT_BLOCKED` [spec TransactionOutcome enum; docs:payment-transaction-outcome].
  - Idempotent; safe to retry [spec]. Blocking an already-LOCKED account is a success [inferred from "idempotent"].
  - Validation: missing/empty `note` → 400 or 422 [inferred; spec does not say which].
- Webhooks: `ACCOUNT_STATUS_CHANGE` with `accountStatusChangeEvent.accountStatus` — the webhook enum uses **`BLOCKED`**, not `LOCKED` (`AccountStatusChangeEventDto.accountStatus` enum: `ACTIVE`, `BLOCKED`, `PENDING_APPROVAL`, `APPROVED`, `DORMANT`, `CLOSED`, `ACTIVE_IN_ARREARS`) [webhook-spec]. Emission on block is [inferred] from the event's existence ("The status of an account has changed") — the block docs do not name it. If customers are blocked: `CUSTOMER_STATUS_UPDATED` with `customerStatus: BLOCKED` [inferred].

### GET /v0/accounts/{accountId}/cards (getCardsForAccountId)

- Purpose: "Get all Cards by Account ID" — "retrieve all cards linked to an account by account Id" [docs:accounts-overview]. Not deprecated.
- Path params: `accountId` (uuid, required).
- Request body: none.
- Response: `200 Success` → `array<HayCard>` [spec]. Common error responses.
  - `HayCard` fields [spec]: `accountHayId` uuid; `blockedBy` enum `CLIENT` | `PLATFORM`; `cardHayId` uuid; `cardStatus` enum `ACTIVE` | `AWAITING_ACTIVATION` | `BLOCKED` | `INACTIVE` | `EXPIRED`; `cardToken` string ("Public token of the Card, maximum 9 digits in length"); `cardType` enum `PHYSICAL` | `VIRTUAL`; `customerHayId` uuid; `deliveryMethod` enum `STANDARD` | `REGISTERED` | `COURIER` | `EXPRESS`; `expiryDate` date; `issuedDateTimeUtc` date-time; `lastFourDigits` string; `nameOnCard` string; `nameOnCardLine2` string; `renewedIntoCardId` uuid nullable; `voidDateTimeUtc` date-time nullable. No required fields.
- Behaviour: read-only. Cards belong to an individual customer but are linked to an account (group accounts may have many cards) [docs:groups]. Whether `INACTIVE` (voided) cards are included is not stated [open].
- Webhooks: none.

### POST /v0/accounts/{accountId}/close (closeAccount)

- Purpose: "Closes an account". Not deprecated.
- Path params: `accountId` (uuid, required).
- Request body (**optional** — `requestBody.required` not set [spec]): `CloseAccountRequestBody`
  - `reason` — string, optional, nullable, enum `SUSPICIOUS` | `DECEASED` | `CUSTOMER` | `OPERATIONAL`. Description verbatim: "Customer account close reason. Stored in Customer model if customer is closed along with its last open account. **SUSPICIOUS**: The customer was made inactive due to concerns about their account conduct. **DECEASED**: The customer was made inactive after confirmation was received that they are deceased. **CUSTOMER**: The customer was made inactive due to a customer request. **OPERATIONAL**: The customer was made inactive due to an operational request." [spec]
- Response:
  - `202 Accepted` → `CloseAccountResponse` = `{ result: enum SUCCESS | FAILURE ("Result of account closure request"), description: string ("Description of account closure request"), errors: ClosureCheckerError[] ("List of errors if any") }` [spec].
  - `422 Unprocessable Entity` → **`CloseAccountResponse`** (not ErrorResponse) [spec]; docs example body: `{"result":"FAILURE","description":"Account closure failed. Check errors for more details.","errors":[...]}` [docs:account-closure].
  - `ClosureCheckerError` = `{ type: enum (required) ACCOUNT_BALANCE_TOTAL | ACCOUNT_BALANCE_STACKS | ACCOUNT_BALANCE_HELD | ACCOUNT_BALANCE_LOCKED | ACCOUNT_BALANCE_OVERDRAFT | ACCOUNT_BALANCE_TECHNICAL_OVERDRAFT | INFLIGHT_OUTBOUND_DIRECT_DEBITS | CHILD_ACCOUNT_STATUS, errorMessage: string }` [spec].
  - `400`, `403`, `500`, `501` → `ErrorResponse`.
- Behaviour — synchronous validation [docs:account-closure]; all failing checks are reported together in `errors`:
  - Total balance must be zero → `ACCOUNT_BALANCE_TOTAL`, message example "Account has 17.78 total balance." [docs:account-closure]
  - Held balance must be zero → `ACCOUNT_BALANCE_HELD`, example "Account has 17.78 held balance." [docs:account-closure]
  - No in-flight outbound direct debits → `INFLIGHT_OUTBOUND_DIRECT_DEBITS`, example "Account has 1 inflight outbound direct entries: [87225f75-9e63-4aa4-9594-8cea4d96e1c1]" [docs:account-closure]
  - Additional checker types exist only in the spec enum with no documented message: `ACCOUNT_BALANCE_STACKS`, `ACCOUNT_BALANCE_LOCKED`, `ACCOUNT_BALANCE_OVERDRAFT`, `ACCOUNT_BALANCE_TECHNICAL_OVERDRAFT`, `CHILD_ACCOUNT_STATUS` [spec]. [inferred] each corresponds to the like-named balance being non-zero, and `CHILD_ACCOUNT_STATUS` to a multi-currency parent having a child account that is not yet CLOSED.
  - Which HTTP code carries `result: FAILURE` — the docs only show the body. [inferred] 422 with `CloseAccountResponse` for validation failure, 202 with `result: SUCCESS` on acceptance.
- Behaviour — synchronous outcome: `status` → `CLOSED` immediately when validation passes [docs:account-closure]; `closedDateTimeUtc` set [inferred from field]. `CLOSED` is terminal: "There is no way to activate closed account" [docs:accounts-overview, docs:account-status].
- Behaviour — asynchronous outcomes [docs:account-closure]: all PayTo arrangements cancelled; all PayIDs registered to the account deleted; all linked cards → Shaype status `INACTIVE` (processor Thredd "voided"); all scheduled payments cancelled; if the customer becomes Inactive, all future scheduled notification events cancelled.
- Behaviour — customer impact [docs:account-closure, docs:customer-status-flow]: after processing, if the customer is linked only to `CLOSED` accounts, customer `status` → `INACTIVE`; `reason` is stored on the customer in that case [spec]. `reason` affects duplicate-checks on re-onboarding: `SUSPICIOUS` and `DECEASED` → included in duplication checks; `CUSTOMER` and `OPERATIONAL` → excluded [docs:account-closure].
- Behaviour — group accounts: any member of a joint/business (group) account may close it without other members' consent; if a hierarchy with an admin exists, the admin may close [docs:accounts-overview]. Group accounts have a flat structure with no primary owner [docs:groups].
- Idempotency: not stated. Closing an already-CLOSED account — unknown [open].
- Webhooks: `ACCOUNT_STATUS_CHANGE` ("Account Status Change") from the synchronous status update; `CARD_STATUS_CHANGE` ("Card Status Change") from asynchronous card voiding [docs:account-closure]. `CUSTOMER_STATUS_UPDATED` with `customerStatus: INACTIVE` when the customer is deactivated [inferred from webhook-spec enum; docs say the customer status changes but do not name the event].

### PATCH /v0/accounts/{accountId}/cop-opt-out (updateCopOptOut)

- Purpose: "Update Account CoP opt-out" (Confirmation of Payee). Not deprecated. No docs page covers it among the provided slugs.
- Path params: `accountId` (uuid, required).
- Request body (required): `UpdateOptOutRequestBody` = `{ optOut: boolean (**required**, "Whether the account should opt out of Confirmation of Payee") }` [spec].
- Response: `200 Success` → `GenericMessage`. Common error responses.
- Behaviour: sets a per-account CoP opt-out flag [spec]. The flag is **not** exposed on `HayAccount` [spec] — no read-back path exists in this tag. Effect on payments (CoP lookups on inbound transfers) is not described anywhere in the provided sources [open]. Idempotency not stated; [inferred] setting the same value twice succeeds.
- Webhooks: none documented.

### GET /v0/accounts/{accountId}/holds (getPendingHolds)

- Purpose: "Get all Authorisation Holds by Account ID" — pending card authorisations not yet cleared [docs:accounts-overview]. Not deprecated.
- Path params: `accountId` (uuid, required).
- Request body: none.
- Response: `200 Success` → `array<AuthorisationHold>` [spec]. Common error responses.
  - `AuthorisationHold` fields [spec] (none required): `accountHayId` uuid; `cardId` uuid; `category` string ("Category applied to transaction, will be initially populated based on merchant type if known"); `currencyAmount` `CurrencyAmount`; `customerId` uuid ("Customer (cardholder)"); `description` string; `holdHayId` uuid; `merchantDetails` `ExternalMerchantDetails`; `originalCurrencyAmount` `CurrencyAmount`; `transactionChannel` enum (62 values, listed in section 2); `transactionTimeUtc` date-time ("when Transaction was Authorised on the Account"); `type` enum `CARD_PRESENT_PAYMENT` | `CARD_NOT_PRESENT_PAYMENT` | `INTRABANK_TRANSFER_IN` | `INTRABANK_TRANSFER_OUT` | `INTERBANK_TRANSFER_IN` | `INTERBANK_TRANSFER_OUT` | `DIRECT_DEBIT_TRANSFER` | `ATM_WITHDRAWAL` | `CARD_PAYMENT_REVERSAL` | `INTERBANK_TRANSFER_OUT_REVERSAL` | `GENERAL_CREDIT` | `GENERAL_DEBIT` | `ORIGINAL_CREDIT` | `BPAY_TRANSFER_OUT` | `BPAY_TRANSFER_IN`.
  - `CurrencyAmount` = `{ amount: number (required, "Amount of the transaction to 2 decimal places"), currency: enum ISO-4217 (required) }` [spec].
  - `ExternalMerchantDetails` = `{ address: MerchantAddress, cardAcceptorLocation: string (max 101 chars), chainName: string, circularLogoUrl: string, merchantCategoryCode: int32 (ISO 18245), merchantId: string nullable (max 15), name: string, terminalId: string nullable (max 8) }`; `MerchantAddress` = `{ addressLine1, lat: double, lng: double, postcode, singleLineAddress, state, suburb }` [spec].
- Behaviour: read-only. Sum of open holds is the account's `heldBalance` ("Total value of all authorised but not yet cleared transactions for all Cards on Account") [spec HayAccount] / "Total balance of authorised card payments that have not yet cleared" [docs:account-balances]. Holds are created/updated by card authorisations (external-auth `POST /holds`, `PATCH /holds/{holdId}` when the client holds balances) [ext-auth-spec]; in the local re-implementation they come from the cards/transactions domain [inferred].
- Webhooks: none from this read.

### PATCH /v0/accounts/{accountId}/max-balance (updateMaxBalanceLimit)

- Purpose: "Update Account max balance". Not deprecated.
- Path params: `accountId` (uuid, required).
- Request body (required): `UpdateMaxBalanceLimitRequestBody` = `{ maxBalanceLimit: number (**required**, `minimum: 0`, `exclusiveMinimum: true` i.e. > 0, "The new maximum balance limit to apply on Account, cannot exceed maximum balance limit applied to the Product. Positive value to 2 decimal places.") }` [spec].
- Response: `200 Success` → `GenericMessage`. Common error responses.
- Behaviour: sets the account-level `MAX_BALANCE` limit [inferred — same limit type as `PUT /v1/accounts/{id}/limits/MAX_BALANCE`; the spec does not say the two endpoints share storage]. Must not exceed the product's `MAX_BALANCE` (`productLimit`) [spec]; violation → 422 [inferred]. Value ≤ 0 → 400/422 [spec constraint; code inferred]. Effect: inbound credits that would push the (aggregated, for multi-currency) balance over the effective limit are refused with outcome `REFUSED_MAX_BALANCE_EXCEEDED` [docs:limits-1, docs:payment-transaction-outcome]. Stack balances count toward max balance [docs:stack].
- Webhooks: none documented.

### PATCH /v0/accounts/{accountId}/overdraft (updateOverdraftLimit)

- Purpose: "Update Account overdraft limit". Not deprecated.
- Path params: `accountId` (uuid, required).
- Request body (required): `UpdateOverdraftLimitRequestBody` = `{ overdraftLimit: number (**required**, no min/max declared, "The new overdraft limit to apply on Account, cannot exceed overdraft limit applied to the Product. Positive value to 2 decimal places.") }` [spec].
- Response: `200 Success` → `GenericMessage`. Common error responses.
- Behaviour:
  - Requires the Overdraft facility to be enabled for the client [docs:account-limits]. Cap = product `OVERDRAFT_PRODUCT_LIMIT` ("Maximum overdraft value that can be applied on Account") [spec]; exceeding → 422 [inferred].
  - Writes `HayAccount.overdraftLimit` [inferred from field]. Increases `availableBalance` by the unused limit (available includes "overdraft funds") [docs:account-balances].
  - "If an account with an overdraft has a negative balance after the overdraft expiry date or the overdraft limit is decreased below the current negative balance, the state will change to ACTIVE_IN_ARREARS until the deposited amount will cover the overdraft balance… When the overdraft balance is covered, the deposit account will be sent back to the ACTIVE state" [docs:account-status]. So lowering the limit below `overdraftBalance` → status `ACTIVE_IN_ARREARS` (with an `ACCOUNT_STATUS_CHANGE` webhook [inferred]).
  - Overdraft expiry date is mentioned [docs:account-status] but no API field exists for it [spec] — [open].
  - Whether `0` is accepted (removing the overdraft) is not stated [open]; the spec sets no minimum.
- Webhooks: `ACCOUNT_STATUS_CHANGE` only if the status flips to/from `ACTIVE_IN_ARREARS` [inferred].
