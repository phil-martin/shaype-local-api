# accounts

Domain map for the **Accounts API** tag of the Shaype B2B Operations API (spec title "B2B Operations API", version "0.0.1"). 24 operations. Source labels: `[spec]` = b2b-operations-api.json, `[webhook-spec]` = notification-webhooks.json, `[ext-auth-spec]` = external-balance.yaml (JSON content), `[docs:<slug>]` = developer.shaype.com page, `[inferred]` = not stated anywhere; implementer's reasonable reading.

Conventions used below:
- Every `accountId` path parameter is `string`, `format: uuid`, required, description "Unique identifier (UUID) of the Account" [spec] (makeTransferV0 says just "Account ID").
- **Common error responses** (identical on every operation unless stated): `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content`, `500 Internal Server Error`, `501 Not Implemented`, all with body `ErrorResponse` [spec]. `ErrorResponse` = `{ details: string ("Error details"), message: string ("Error description"), status: string ("HTTP response status"), traceId: string ("TraceID that can be used by HAY for troubleshooting the request") }` — none marked required [spec]. The spec never says which condition yields 400 vs 422; the only documented 422 bodies are the `fx.childAccounts` validation messages on createAccount [docs:bulk-account-opening] and the closure/block special-case bodies below.
- No 404 is declared on any Accounts operation [spec]. Unknown-account behaviour is an open question (section 7).
- No `security` section and no `securitySchemes` exist in the spec [spec]; auth is out of scope for this map.
- `GenericMessage` = `{ message: string ("Message indicating operation result") }` [spec].
- Currency enums: `HayAccount.currency`, `CurrencyAmount.currency`, `HomeCurrencyBalanceEquivalent.currency`, `ChildAccountsDataRequest.currencies[]` use the full 162-value ISO 4217 list (AED … ZWL, including CNH, XCG, ZWG). `CreateAccountRequestBody.currency` uses a restricted 31-value list (given verbatim under createAccount). Verified by jq.

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

### GET /v0/accounts/{accountId}/riskLevel (getAccountRiskLevel)

- Purpose: "Get Risk Level by Account ID". Not deprecated.
- Path params: `accountId` (uuid, required).
- Request body: none.
- Response: `200 Success` → `RiskLevelResponse` = `{ accountId: uuid, riskLevel: string }` [spec]. `riskLevel` has **no enum in the spec**; its description lists `LOW` ("Account has a low risk level, operating normally using standard Product limits") and `HIGH` ("Account has a high risk level, operating at restricted capacity using applicable limits (generally prevents all outgoing funds activity") [spec]. Schema description: "Details of the account risk level. **Note**: Account limits associated with each of the risk levels can be set individually for each integration; below are described default settings." [spec]. Common error responses.
- Behaviour: read-only. Default after creation is `HIGH` [docs:accounts-overview].
- Webhooks: none.

### PATCH /v0/accounts/{accountId}/riskLevel (changeAccountRiskLevel)

- Purpose: "Update Account Risk Level" — "You can update single account risk level at a time" [docs:account-limits]. Not deprecated.
- Path params: `accountId` (uuid, required).
- Request body (required): `ChangeHayAccountRiskLevelRequestBody`
  - `level` — string, **required**, enum `LOW` | `HIGH` [spec].
  - `reason` — string, **required**, `minLength: 1`, `maxLength: 128`, "Note or reason for the operation of this function" [spec].
  - (The docs sample also sends `accountId` in the body; it is not in the schema and should be ignored [docs:sample-requests-responses].)
- Response: `200 Success` → `GenericMessage`; documented sample `{"message": "Risk level changed successfully."}` [docs:sample-requests-responses]. Common error responses.
- Behaviour [docs:account-limits, docs:accounts-overview]:
  - "Account risk level is a way to control all the limits at once."
  - `HIGH` "set all limits to 0, which means setting an account to a HIGH risk level will prevent all outbound and inbound transactions" / "prevents any movement of funds".
  - `LOW` "operating normally using standard product limits" / "adjusts the limits to their default non-zero values and permits transactions".
  - New accounts start `HIGH` [docs:accounts-overview]. [inferred] the local model should store `riskLevel` per account and make the limits engine return effective limit 0 for every type while `HIGH`.
  - Interaction with custom account-level limits (`setAccountLimit`) while `HIGH` is not stated [open]. The RiskLevelResponse note says the per-level limits "can be set individually for each integration" [spec] — i.e. product configuration.
  - Idempotency: not stated; [inferred] re-setting the same level succeeds.
- Webhooks: none documented.

### POST /v0/accounts/{accountId}/transfer (makeTransferV0)

- Purpose: "Initiate Cash Transfer (DEPRECATED)". **`deprecated: true`**; description "Please use `v1/accounts/{accountId}/transfer` instead." [spec].
- Path params: `accountId` (uuid, required, description "Account ID").
- Request body (required): `TransferOutRequestBody` — identical schema to makeTransferV1 (see there) [spec].
- Response: `200 Success` → `TransactionOutcome` (see makeTransferV1). Common error responses.
- Behaviour: [inferred] identical to makeTransferV1; the spec gives no behavioural difference. Local implementation may route both paths to one handler.
- Webhooks: as makeTransferV1.

### POST /v0/accounts/{accountId}/unblock (unblockAccount)

- Purpose: "Unblock Account". Not deprecated.
- Path params: `accountId` (uuid, required).
- Request body (required): `UnblockAccountRequestBody` = `{ note: string (**required**, `minLength: 1`, "Note or explanation for reason unblock is applied") }` [spec].
- Response: `200 Success` → `GenericMessage`. Common error responses.
- Behaviour: "On an unblocked account, the account status will become ACTIVE" [docs:accounts-overview]. `blockedBy` cleared [inferred]. Not stated: whether it also unblocks the customer(s) blocked via `ACCOUNT_AND_CUSTOMER`, whether child FX accounts are unblocked too (block cascades to children [spec], unblock is silent), whether a PLATFORM-blocked account can be unblocked by the client, and the result when the account is not `LOCKED` (e.g. `CLOSED`) — all [open]. Note the docs say ACTIVE, not "previous status": an account that was `APPROVED` (never transacted) before blocking would come back as `ACTIVE` per the docs wording [docs:accounts-overview] — [open] whether that is literal.
- Webhooks: `ACCOUNT_STATUS_CHANGE` with `accountStatus: ACTIVE` [inferred from webhook-spec].

### POST /v1/accounts (createAccount)

- Purpose: "Creates an Account" for a customer or a group; optionally provisions multi-currency child accounts [spec, docs:bulk-account-opening]. Not deprecated. (Older `POST /v0/customers/{customerHayId}/account` (Customers API, `createHayAccount`) and `POST /v0/groups/{groupHayId}/account` (Groups API, `createHayAccountForGroup`) still exist in the spec with bodies `{ idempotencyKey (required), customData }` — not part of this tag; not marked deprecated [spec].)
- Path/query params: none.
- Request body (required): `CreateAccountRequestBody` — required: `accountHolderId`, `accountHolderType`, `idempotencyKey`, `productId` [spec].
  - `accountHolderId` — uuid, **required**, "Unique identifier (UUID) of the account holder."
  - `accountHolderType` — string, **required**, enum `CUSTOMER` | `GROUP` ("**CUSTOMER**: The account holder is a Customer, accountHolderId contains a Customer ID; **GROUP**: The account holder is a Group, accountHolderId contains a Group ID").
  - `idempotencyKey` — uuid, **required**, "Unique value (UUID) used to identify this request and used to recognise any subsequent retries".
  - `productId` — uuid, **required**, "Unique value (UUID) of the product used for this account."
  - `accountNumber` — string, optional, nullable, `pattern: ^[1-9][0-9]{7,8}$`, "Account number, 8-9 digits in length". (Client-chosen number; example "123456789".)
  - `currency` — string, optional, nullable, enum (31 values, verbatim): `AED`, `AUD`, `BHD`, `CAD`, `CHF`, `CNY`, `CZK`, `DKK`, `EUR`, `GBP`, `HKD`, `HUF`, `ILS`, `JPY`, `KES`, `KWD`, `MXN`, `NOK`, `NZD`, `OMR`, `PLN`, `QAR`, `RON`, `SAR`, `SEK`, `SGD`, `THB`, `TRY`, `UGX`, `USD`, `ZAR`. "Account currency as three letter code as per ISO 4217."
  - `customData` — object, optional, nullable, "Contains custom metadata stored with the Account. Needs to be a valid JSON".
  - `parentAccountId` — uuid, optional, nullable, "Unique identifier (UUID) of the parent Account. Only for FX accounts".
  - `fx` — `AccountFxDataRequest` ("FX-specific data passed through when creating an account"), optional:
    - `childAccounts` — `ChildAccountsDataRequest` ("Sub-accounts to create alongside the account"), required inside: `initMode`.
      - `initMode` — string, **required when `childAccounts` present**, enum `ALL` | `CUSTOM` | `NONE` ("**ALL**: create a child account for every Shaype-supported FX currency; **CUSTOM**: create a child account for each currency in `currencies`; **NONE**: create no child accounts"), example `CUSTOM`.
      - `currencies` — array of ISO-4217 enum strings (full 162 list), `minItems: 1`, `maxItems: 2147483647`, "Required when initMode is CUSTOM. Only currencies that Shaype supports for FX are accepted."
    - `compliance` — `FxComplianceDataRequest` ("FX compliance data passed through when creating an account"), all optional/nullable:
      - `countryOfCitizenship` — string, ISO 3166-1 alpha-3, example `AUS`, "Must be a country that transacts in a Shaype-supported currency."
      - `customerRisk` — enum `LOW` | `MEDIUM` | `HIGH`, example `LOW`.
      - `expectedMonthlyActivityValue` — number, `minimum: 0`, example 2500.5.
      - `expectedMonthlyActivityVolume` — int32, `minimum: 0`, example 50.
      - `expectedTransactionCountries` — string[] (ISO 3166-1 alpha-3), example `["AUS","USA"]`, "Only countries that transact in a Shaype-supported currency are accepted."
      - `expectedTransactionCurrency` — string, enum = full ISO list followed by the 31-value list again (duplicates present in the spec), example `AUD`, "Only one Shaype-supported currency is accepted."
  - Spec request examples (verbatim names): "Create customer account (minimal request)" `{accountHolderId, accountHolderType: CUSTOMER, idempotencyKey, productId}`; "Create group account with specific number and custom data" `{…, accountHolderType: GROUP, accountNumber: "123456789", customData: {"key":"value"}}`; "Create multi-currency child account (non-AUD)" `{…, parentAccountId: "fad572da-…", currency: "EUR"}`; "Create multi-currency parent account (AUD)" `{…, currency: "AUD", fx: {compliance: {countryOfCitizenship: "AUS", expectedMonthlyActivityVolume: 50, expectedMonthlyActivityValue: 2500.5, expectedTransactionCurrency: "AUD", expectedTransactionCountries: ["AUS","USA"], customerRisk: "LOW"}, childAccounts: {initMode: "CUSTOM", currencies: ["USD","GBP"]}}}` [spec].
- Response: **`200 Success`** (not 201) → `HayAccount` describing the parent/created account only [spec; docs:bulk-account-opening "describes the parent only"]. Common error responses; 422 carries the validation messages below.
- Behaviour:
  - Preconditions: the holder customer must be `ACTIVE` ("An account can only be opened if the customer is in `ACTIVE` status") [docs:customer-status-flow]. For `GROUP`, `accountHolderId` is the `groupHayId`; "A group should have a single account" [docs:groups] (not enforced by anything in the spec — [open]). `productId` must be one of the client's products (`GET products`) [docs:product].
  - Status on creation: spec says "Accounts created through this API are automatically set as APPROVED" [spec HayAccount.status description]; the docs sample response shows `"status": "PENDING_APPROVAL"` [docs:sample-requests-responses]. Conflict — [open]; recommended: `APPROVED` per spec, with `APPROVED → ACTIVE` on first transaction [docs:account-status].
  - Risk level defaults to `HIGH` (all limits 0, no fund movement) until `changeAccountRiskLevel` sets `LOW` [docs:accounts-overview].
  - Initial balances all 0; `bsb` assigned (sample "636220"); `accountNumber` assigned (sample "66090672", 8 digits) unless supplied; `currency` defaults to `AUD` when absent [docs:sample-requests-responses shows AUD with no currency in request; inferred as default].
  - Idempotency: `idempotencyKey` "used to recognise any subsequent retries" [spec]; [inferred] a retry with the same key returns the original account rather than creating a second.
  - Multi-currency [docs:multi-currency-onboarding-and-account-structure]: exactly one "domestic" currency per client, currently `AUD` only; any other currency is an FX holding; the domestic account is the parent; creating an FX child **requires** `parentAccountId` ("it is mandatory to provide an appropriate parent `accountId`"); FX accounts cannot use domestic payment rails — passing an FX `accountId` to a transfer request is rejected (only `internalTransfer` accepted; see makeTransferV1). Child `HayAccount.parentAccountId` is set; "Only present for child (e.g. non-AUD FX) accounts" [spec].
  - Bulk child provisioning [docs:bulk-account-opening]: `fx.childAccounts` absent → home-currency account only. `ALL` → one child per FX-engine-supported currency excluding the home currency ("For an AUD wallet that is 30 children, so 31 accounts in total"). `CUSTOM` → one child per code in `currencies`; the home currency code in the list is skipped, not rejected. `NONE` → home account only. Response returns as soon as the parent exists; children are provisioned asynchronously (dev: ~6 s for 3 currencies, up to ~1 min for ALL); provisioning retries until every requested currency exists; only one account per currency per parent, so retries never duplicate. Children are visible via `GET /v0/customers/{accountHolderId}/accounts` (Customers API, returns `array<HayAccount>`).
  - Validation errors, each **HTTP 422** with a `traceId` [docs:bulk-account-opening], messages verbatim:
    - `initMode` omitted while `fx.childAccounts` present → `fx.childAccounts.initMode must not be null`
    - `initMode` = `CUSTOM` and `currencies` omitted → `INVALID_ARGUMENT: fx.childAccounts.currencies is mandatory when initMode is CUSTOM`
    - `initMode` = `ALL` and `currencies` supplied → `INVALID_ARGUMENT: fx.childAccounts.currencies must not be provided when initMode is ALL`
    - `initMode` = `NONE` and `currencies` supplied → `INVALID_ARGUMENT: fx.childAccounts.currencies must not be provided when initMode is NONE`
    - `currencies` empty array → `fx.childAccounts.currencies size must be between 1 and 2147483647`
    - `currencies` contains a non-ISO-4217 code → `Could not read JSON: Invalid currency value 'ABC'. Known currency values are: […]`
    - "A valid code is not the same as a supported currency": a syntactically valid code can pass and still not be provisioned [docs:bulk-account-opening].
  - Other validation [spec constraints; response code inferred as 422/400]: missing required fields; `accountNumber` not matching `^[1-9][0-9]{7,8}$`; `currency` outside the 31-value enum; `customData` not valid JSON object.
  - Webhooks: none named for creation. `ACCOUNT_STATUS_CHANGE` has `PENDING_APPROVAL`/`APPROVED` values [webhook-spec] so an emission on create is plausible but [open].

### POST /v1/accounts/search (searchAccounts)

- Purpose: "Search accounts" — "Currently you can search by the accountNumber. In the future release, additional search criteria will be supported." [docs:accounts-overview]. Not deprecated.
- Path/query params: none.
- Request body (required): `SearchAccountsRequestBody` = `{ accountNumber: string (**required**, `minLength: 1`, `pattern: [\d]{5,9}`, "Account number, 5-9 digits in length") }` [spec].
- Response: `200 Success` → `array<HayAccount>` [spec]. Common error responses.
- Behaviour: exact match on `accountNumber` [inferred — the pattern is unanchored in the spec but the docs describe a lookup by number]. Empty array when nothing matches [inferred]. Whether `customData` is populated in results is not stated [open]. Whether CLOSED accounts are returned is not stated [open].
- Webhooks: none.

### DELETE /v1/accounts/{accountId}/custom-data (deleteAccountCustomData)

- Purpose: "Delete Custom Data from Account" — "This endpoint is used to delete all the custom data from an account." [docs:accounts-overview]. Not deprecated.
- Path params: `accountId` (uuid, required).
- Request body: none.
- Response: `200 Success` → `GenericMessage`. Common error responses.
- Behaviour: clears the whole `customData` object (no per-key deletion) [docs:accounts-overview]. Afterwards `GET …?expand=customData` returns `customData: null` [inferred; `customData` is nullable in `HayAccount`]. Idempotent [inferred].
- Webhooks: none.

### POST /v1/accounts/{accountId}/custom-data (createAccountCustomData)

- Purpose: "Create Custom Data for Account" — "add your custom key-value pairs to your account during account creation and through this endpoint" [docs:accounts-overview]. Not deprecated.
- Path params: `accountId` (uuid, required).
- Request body (required): `CreateAccountCustomDataRequestBody` = `{ customData: object (**required**, "Contains custom metadata stored with the Account") }` [spec]; schema description "Body of a request to update custom metadata stored with an account" [spec].
- Response: `200 Success` → `GenericMessage`. Common error responses.
- Behaviour: stores arbitrary JSON object against the account, readable via `GET /v0/accounts/{id}?expand=customData` [spec]. Whether a second call **merges** keys or **replaces** the object is not stated [open] (schema says "update", docs say "create"). Size/depth limits not stated [open].
- Webhooks: none.

### GET /v1/accounts/{accountId}/limits (getAccountLimits)

- Purpose: "Get all limits by Account ID". Not deprecated.
- Path params: `accountId` (uuid, required).
- Request body: none.
- Response: `200 Success` → `array<ExternalLimitAmounts>` [spec]. Common error responses.
  - `ExternalLimitAmounts` = `{ accountLimit: number ("Custom limit applied to the Account"), effectiveLimit: number ("Effective limit applied to the Account"), productLimit: number ("Default limit applied to the Account based on the product"), type: enum }` — none required [spec].
  - `type` enum (16 values, verbatim order): `MAX_BALANCE`, `MIN_BALANCE`, `TOTAL_SPEND_PER_YEAR`, `ATM_WITHDRAWAL_PER_DAY`, `TOP_UP_PER_DAY`, `CARD_TOP_UP_PER_DAY`, `BPAY_TOP_UP_PER_DAY`, `BANK_TRANSFER_TOP_UP_PER_DAY`, `PAYMENT_TO_ACCOUNT_NUMBER`, `PAYMENT_TO_PAY_ID`, `CARD_PAYMENTS_DAILY`, `SINGLE_CARD_TRANSACTION`, `MIN_STACK_BALANCE`, `DIRECT_DEBIT_PER_DAY`, `OVERDRAFT_PRODUCT_LIMIT`, `BPAY_DAILY_LIMIT` [spec].
  - Per-type meanings [spec, identical text on all three limit schemas]: `ATM_WITHDRAWAL_PER_DAY` Maximum value of ATM cash withdrawals; `BANK_TRANSFER_TOP_UP_PER_DAY` Maximum value of inbound cash transfers; `BPAY_DAILY_LIMIT` Maximum value of outgoing BPAY payments; `BPAY_TOP_UP_PER_DAY` Not currently used; `CARD_PAYMENTS_DAILY` Maximum value of Card payments; `CARD_TOP_UP_PER_DAY` Not currently used; `DIRECT_DEBIT_PER_DAY` Maximum value of outgoing direct debit transfers; `MAX_BALANCE` Maximum balance that can be held in Account; `MIN_BALANCE` Minimum balance that can be held in Account (Shaype use only); `MIN_STACK_BALANCE` Minimum balance that can be held in Stack (Shaype use only); `OVERDRAFT_PRODUCT_LIMIT` Maximum overdraft value that can be applied on Account; `PAYMENT_TO_ACCOUNT_NUMBER` Maximum value of individual outgoing cash transfer; `PAYMENT_TO_PAY_ID` Not currently used; `SINGLE_CARD_TRANSACTION` Maximum value of individual Card payment; `TOTAL_SPEND_PER_YEAR` Maximum value of outgoing transfers / payments on Account in a year; `TOP_UP_PER_DAY` Maximum value of inbound cash transfers.
- Behaviour: one element per limit type [inferred]. `effectiveLimit` = `accountLimit` if an account-level limit is set, else `productLimit` [docs:account-limits "Effective limit"]. What `accountLimit` is when none is set (null / absent / 0 / = productLimit) is not stated [open]. While risk level is `HIGH`, all limits are 0 [docs:account-limits] — whether that shows in `effectiveLimit` is [open].
- Webhooks: none.

### DELETE /v1/accounts/{accountId}/limits/{limitType} (deleteAccountLimit)

- Purpose: "Delete limit from Account" — "reset the limit for a specific account and limit type. Once removed, the Product level limit will be used. The Product level limit cannot be removed" [docs:account-limits]. Not deprecated.
- Path params: `accountId` (uuid, required); `limitType` (string, required, enum = the full 16-value list above: `MAX_BALANCE`, `MIN_BALANCE`, `TOTAL_SPEND_PER_YEAR`, `ATM_WITHDRAWAL_PER_DAY`, `TOP_UP_PER_DAY`, `CARD_TOP_UP_PER_DAY`, `BPAY_TOP_UP_PER_DAY`, `BANK_TRANSFER_TOP_UP_PER_DAY`, `PAYMENT_TO_ACCOUNT_NUMBER`, `PAYMENT_TO_PAY_ID`, `CARD_PAYMENTS_DAILY`, `SINGLE_CARD_TRANSACTION`, `MIN_STACK_BALANCE`, `DIRECT_DEBIT_PER_DAY`, `OVERDRAFT_PRODUCT_LIMIT`, `BPAY_DAILY_LIMIT`) [spec].
- Request body: none.
- Response: `200 Success` → `DeleteAccountLimitResponse` = `{ success: boolean }` [spec]. Common error responses.
- Behaviour: removes the account-level override; `effectiveLimit` reverts to `productLimit` [docs:account-limits]. Deleting a type that has no override — result not stated ([inferred] `success: true`, idempotent). Note the DELETE enum includes types that PUT cannot set (`MIN_BALANCE`, `MIN_STACK_BALANCE`, `OVERDRAFT_PRODUCT_LIMIT`, `CARD_TOP_UP_PER_DAY`, `BPAY_TOP_UP_PER_DAY`) [spec] — [open] whether deleting those is a no-op or an error. Invalid `limitType` string → 400 [inferred].
- Webhooks: none.

### PUT /v1/accounts/{accountId}/limits/{limitType} (setAccountLimit)

- Purpose: "Set limit for Account" — account-level override [docs:account-limits]. Not deprecated.
- Path params: `accountId` (uuid, required); `limitType` (string, required, enum — **11 values**, verbatim order: `MAX_BALANCE`, `TOTAL_SPEND_PER_YEAR`, `ATM_WITHDRAWAL_PER_DAY`, `TOP_UP_PER_DAY`, `BANK_TRANSFER_TOP_UP_PER_DAY`, `PAYMENT_TO_ACCOUNT_NUMBER`, `PAYMENT_TO_PAY_ID`, `CARD_PAYMENTS_DAILY`, `SINGLE_CARD_TRANSACTION`, `DIRECT_DEBIT_PER_DAY`, `BPAY_DAILY_LIMIT`) [spec]. `MIN_BALANCE`, `MIN_STACK_BALANCE`, `OVERDRAFT_PRODUCT_LIMIT`, `CARD_TOP_UP_PER_DAY`, `BPAY_TOP_UP_PER_DAY` are **not settable** here [spec]; the parameter description still lists all 16 with the "(Shaype use only)" / "Not currently used" notes.
- Request body (required): `ExternalSetAccountLimitRequestBody` = `{ limitAmount: number (**required**, `minimum: 0`, `exclusiveMinimum: true` → must be > 0, "Custom Account limit value being applied") }` [spec].
- Response: `200 Success` → `ExternalSetAccountLimitResponse` = `{ accountId: uuid, limitAmount: number, limitType: enum (full 16-value list) }` [spec]. Common error responses.
- Behaviour:
  - "An account level limit cannot exceed the Product level" [docs:account-limits] → 422 when `limitAmount > productLimit` [inferred code].
  - Sets `accountLimit` and hence `effectiveLimit` for that type [docs:account-limits]. Replaces any prior override (PUT semantics) [inferred].
  - `limitAmount <= 0` violates the schema → 400/422 [inferred].
  - Daily limits are evaluated on a rolling 24-hour window: "the limit checker will get all transactions from the past 24h for that account and check if the total (including the current transaction) would go over the limit" [docs:account-limits]. (The same page's example says "until the next calendar day" — inconsistent; rolling 24h is the explicit rule.)
  - Multi-currency wallets: limits are assessed across the whole hierarchy (parent + children) after converting each balance/transaction to the home currency at the margin-free cached FX rate; aggregated types: `MAX_BALANCE`, single card txn, card per day, `ATM_WITHDRAWAL_PER_DAY`, `TOP_UP_PER_DAY`, `BANK_TRANSFER_TOP_UP_PER_DAY`, transfers-out per day; **not** aggregated: `DIRECT_DEBIT_PER_DAY`, BPAY per day, `MIN_BALANCE`, `MIN_STACK_BALANCE` [docs:limits-1]. That page uses names not in the spec enum (`SINGLE_CARD_TRANSACTION_LIMIT`, `CARD_TRANSACTIONS_PER_DAY`, `TRANSFERS_OUT_PER_DAY`, `BPAY_PER_DAY`) — treat as aliases of `SINGLE_CARD_TRANSACTION`, `CARD_PAYMENTS_DAILY`, (no spec equivalent; nearest `PAYMENT_TO_ACCOUNT_NUMBER` is per-transaction), `BPAY_DAILY_LIMIT` [inferred].
  - Breach outcomes (transaction side, not this endpoint): `REFUSED_LIMIT_BREACH` with detailed outcome e.g. `REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED` [docs:account-limits]; full outcome list in section 6.
- Webhooks: none.

### GET /v1/accounts/{accountId}/rules (getAccountRules)

- Purpose: "Get all Rules by Account ID" — "retrieve all a rules associated with the specific account" [docs:account-rules]. Not deprecated.
- Path params: `accountId` (uuid, required).
- Request body: none.
- Response: `200 Success` → `array<ExternalTransactionRuleResponse>` [spec]. Common error responses. (Schema in addAccountRule.)
- Behaviour: read-only. Whether disabled/expired rules are included is not stated [open]; the response carries `disabled` and `expiresAtUtc` so [inferred] they may be.
- Webhooks: none.

### POST /v1/accounts/{accountId}/rules (addAccountRule)

- Purpose: "Create Rule for Account" — account-level control over where money can be spent (merchant blocking) [docs:account-rules]. Not deprecated.
- Path params: `accountId` (uuid, required).
- Request body (required): `ExternalAddTransactionRuleRequest` — required: `name`, `ruleDetails`, `ruleType` [spec].
  - `name` — string, **required**, `minLength: 1`, "Name assigned to the Rule".
  - `ruleType` — string, **required**, enum `MERCHANT_CODE_BLOCK` ("Transactions blocked by Merchant Category Code (MCC)") | `MERCHANT_ID_BLOCK` ("Transactions blocked by merchant ID") | `MERCHANT_NAME_BLOCK` ("Transactions blocked by merchant name").
  - `expiresIn` — integer int64, optional, `minimum: 1`, "Number of seconds until the Rule expires after it is created".
  - `ruleDetails` — `RuleDetails` (**required**), all properties optional in-schema but conditionally required by `ruleType`:
    - `blockedMerchantCategoryCodes` — int32[] , `uniqueItems: true`, "Blocked Merchant Category Code (MCC) as four digit code as per ISO 18245 (required for Rule type: MERCHANT_CODE_BLOCK)."
    - `blockedMerchantIds` — string[], `uniqueItems: true`, "List of blocked merchant identifiers, each up to 15 alphanumeric characters (required for rule type of `MERCHANT_ID_BLOCK`)."
    - `blockedMerchantName` — string, "Blocked merchant name (required for Rule type: MERCHANT_NAME_BLOCK)."
    - `merchantNameMatchingOperator` — enum `CONTAINS` ("Merchant name contains the Rule value") | `ENDS_WITH` | `EXACT` ("Merchant name is an actual match of the Rule value") | `STARTS_WITH`, "(required for Rule type: MERCHANT_NAME_BLOCK)".
- Response: `200 Success` → `ExternalTransactionRuleResponse` = `{ id: uuid ("Unique identifier (UUID) of the Rule"), name: string, ruleType: enum (as above), rule: Rule (opaque `object`, "Contains detail of the Rule"), ownerId: string ("Unique identifier (UUID) of the owner of Rule (either the Customer ID or Client Reference if a rule applied across the product)"), disabled: boolean ("Indicates if Rule is currently disabled"), expiresAtUtc: date-time ("DateTime in UTC format when the Rule expires") }` — none required [spec]. Common error responses.
- Behaviour:
  - Validation [spec descriptions; response code inferred 422]: `MERCHANT_CODE_BLOCK` requires `blockedMerchantCategoryCodes`; `MERCHANT_ID_BLOCK` requires `blockedMerchantIds` (each ≤ 15 alphanumeric); `MERCHANT_NAME_BLOCK` requires `blockedMerchantName` and `merchantNameMatchingOperator`.
  - `expiresAtUtc` = creation time + `expiresIn` seconds [inferred]; absent `expiresIn` → no expiry [inferred].
  - `ownerId` is the account holder's customer ID for account-level rules, or a client reference for product-wide rules (which are created outside this API) [spec].
  - `rule` echo shape is undefined (`Rule` is an empty object schema) [spec] — [inferred] echo the submitted `ruleDetails`.
  - Enforcement (transactions domain): card transactions matching a rule are refused with outcome `REFUSED_RULES`; "If there are multiple rules that apply to a transaction, the transaction will be blocked by the first matching rule and return only that reason"; the `TRANSACTION` webhook carries `ruleDetails: { ruleId }` [docs:account-rules]. Full webhook example in docs:account-rules (`transactionEvent.outcome: "REFUSED_RULES"`, `ruleDetails.ruleId`).
  - MCC codes are obtainable from `getallmerchantcategorycodes` (another domain) [docs:account-rules].
  - Idempotency: none (no idempotencyKey); duplicate POSTs create duplicate rules [inferred].
- Webhooks: none on creation; `TRANSACTION` with `outcome: REFUSED_RULES` when a rule later blocks a payment [docs:account-rules].

### DELETE /v1/accounts/{accountId}/rules/{ruleId} (disableRule)

- Purpose: "Delete Rule from Account" [docs:account-rules]; operationId `disableRule` and response field `disabled` indicate a soft delete [spec]. Not deprecated.
- Path params: `accountId` (uuid, required); `ruleId` (uuid, required, "Unique identifier (UUID) of the Rule").
- Request body: none.
- Response: `200 Success` → `DisableRuleResponse` = `{ success: boolean }` [spec]. Common error responses.
- Behaviour: marks the rule `disabled: true` [inferred from naming]; a disabled rule no longer blocks transactions [docs:account-rules "disable rules"]. Whether `getAccountRuleById` still returns it afterwards — [open]. Rule belonging to a different account → 4xx [inferred]. Re-disabling — [inferred] `success: true`.
- Webhooks: none.

### GET /v1/accounts/{accountId}/rules/{ruleId} (getAccountRuleById)

- Purpose: "Get Rule for Account by Rule ID" [docs:account-rules]. Not deprecated.
- Path params: `accountId` (uuid, required); `ruleId` (uuid, required).
- Request body: none.
- Response: `200 Success` → `ExternalTransactionRuleResponse` (schema above). Common error responses.
- Behaviour: read-only. Rule not found / not owned by this account → no 404 declared; [inferred] 400 or 422 `ErrorResponse`.
- Webhooks: none.

### POST /v1/accounts/{accountId}/transfer (makeTransferV1)

- Purpose: "Initiate Cash Transfer" — outbound transfer from `accountId` to another Shaype account, a BSB/account number, or a PayID [spec, docs:payments]. Not deprecated (replaces makeTransferV0).
- Path params: `accountId` (uuid, required) — the **sender** account.
- Request body (required): `TransferOutRequestBody` — required: `amount`, `description`, `senderCustomerHayId`, `transferType` [spec]. **`idempotencyKey` is NOT in the required list** [spec].
  - `amount` — number, **required**, `minimum: 0`, `exclusiveMinimum: true` (> 0), "The amount to be transferred".
  - `description` — string, **required**, `minLength: 1`, `maxLength: 255`, "Transfer description, will be seen by both sender and recipient".
  - `senderCustomerHayId` — uuid, **required**, "Unique identifier (UUID) of the Customer (initiator of the transfer)".
  - `transferType` — string, **required**, enum `ACCOUNT` ("Transfer to Account using bank account details (requires accountTransfer object to be provided)") | `INTERNAL` ("Transfer to Account using AccountID, where recipient also Client's Customer with Shaype (requires internalTransfer object to be provided)") | `PAY_ID` ("Transfer to Account using PayID (requires payIdTransfer object to be provided)").
  - `idempotencyKey` — uuid, optional, "Unique value (UUID) used to identify this request and used to recognise any subsequent retries".
  - `category` — string, optional, "Used to assign a category of the transfer" (example values seen: `EATING_OUT`, `SAVING`, `SHOPPING`).
  - `reference` — string, optional, `minLength: 0`, `maxLength: 35`, "Reference to be included with the transfer".
  - `accountTransfer` — `AccountTransfer` (required when `transferType = ACCOUNT`): `accountNumber` string **required** `minLength: 1` `pattern: [\d]{5,9}`; `bsb` string **required** `minLength: 1` `pattern: [\d]{6}`; `recipientName` string **required** 1–140; `senderName` string 0–140; `reference` string 0–35 **deprecated** (use top-level `reference`).
  - `internalTransfer` — `InternalTransfer` (required when `INTERNAL`): `recipientAccountHayId` uuid **required**; `recipientName` string **required** 1–140; `senderName` string **required** 1–140.
  - `payIdTransfer` — `PayIdTransfer` (required when `PAY_ID`): `payId` string **required** `minLength: 1`; `recipientName` string **required** 1–140; `senderName` string 0–140; `reference` string 0–35 **deprecated**.
  - Spec example (named "Inbound Direct Credit request", attached to the 200 response but shaped like a request): `{"idempotencyKey":"fbdd45c3-…","senderCustomerHayId":"f385a29e-…","description":"Table booking","reference":"140295","category":"EATING_OUT","amount":5.97,"transferType":"PAY_ID","payIdTransfer":{"recipientName":"Felix Reynolds Jr.","payId":"haas1709811448764@yopmail.com","senderName":"Ollie"}}` [spec].
- Response: `200 Success` → `TransactionOutcome` = `{ outcome: enum, transactionId: uuid ("Unique identifier (UUID) of the Transaction") }` [spec]. `outcome` enum (21 values, verbatim order): `ACCEPTED`, `INTERNAL_ERROR`, `REFUSED_LIMIT_BREACH`, `REFUSED_FRAUD`, `REFUSED_CUSTOMER_PREFERENCE`, `REFUSED_INSUFFICIENT_FUNDS`, `REFUSED_ACCOUNT_BLOCKED`, `REFUSED_RECIPIENT_ACCOUNT_BLOCKED`, `REFUSED_ACCOUNT_CLOSED`, `REFUSED_RECIPIENT_ACCOUNT_CLOSED`, `REFUSED_INVALID_PAY_ID`, `UNKNOWN`, `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED`, `REFUSED_MAX_BALANCE_EXCEEDED`, `REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_NET_VISA_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_NON_SCHEME_DAILY_LIMIT_BREACHED`, `REFUSED_SENDER_ACCOUNT_NOT_VERIFIED`, `REFUSED_CAPABILITY_NOT_ENABLED`, `REFUSED_QUOTE_EXPIRED` [spec]. Refusals are returned as **HTTP 200 with a REFUSED_* outcome**, not as 4xx [inferred from schema; docs:payment-transaction-outcome describe them as outcomes]. Common error responses for malformed requests.
- Behaviour [docs:payments unless noted]:
  - Routing: `PAY_ID` → platform resolves the PayID to BSB/account and sends via NPP. `ACCOUNT` → if the recipient BSB is a Shaype BSB the transfer is converted to `INTERNAL`; else if the recipient is NPP-enabled → NPP; else → Direct Entry (DE). `INTERNAL` → executed inside the platform ("ShaypePay").
  - Preconditions on the sender account [spec outcomes + docs:account-status/payment-transaction-outcome]: status `LOCKED` → `REFUSED_ACCOUNT_BLOCKED`; `CLOSED` → `REFUSED_ACCOUNT_CLOSED`; `availableBalance < amount` → `REFUSED_INSUFFICIENT_FUNDS` (stacks never draw down [docs:stack]); risk level `HIGH` → all limits 0 → limit refusal [docs:account-limits]; `PAYMENT_TO_ACCOUNT_NUMBER` (per-transfer max) and `TOTAL_SPEND_PER_YEAR` / daily transfers-out limits → `REFUSED_LIMIT_BREACH` or `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED`.
  - Preconditions on an INTERNAL recipient: `LOCKED` → `REFUSED_RECIPIENT_ACCOUNT_BLOCKED`; `CLOSED` → `REFUSED_RECIPIENT_ACCOUNT_CLOSED`; recipient would exceed `MAX_BALANCE` → `REFUSED_MAX_BALANCE_EXCEEDED` [docs:payment-transaction-outcome].
  - FX child accounts: "FX accounts cannot access any domestic payment rails and if an `accountId` for an FX account is passed in a account transfer request then the call will be rejected"; capability table: Initiate Cash Transfer is "partially disabled — Only `internalTransfer` are accepted" for FX accounts [docs:multi-currency-onboarding-and-account-structure]. `REFUSED_CAPABILITY_NOT_ENABLED` is the natural outcome [inferred]. `REFUSED_QUOTE_EXPIRED` relates to FX conversions [inferred].
  - Balance effects on `ACCEPTED` [inferred from docs:account-balances and webhook samples]: sender `totalBalance` and `availableBalance` decrease by `amount`; INTERNAL recipient's increase; the account transitions `APPROVED → ACTIVE` on its first transaction [docs:account-status].
  - The `senderCustomerHayId` must be the holder (or a group member) of `accountId` [inferred].
  - Idempotency: `idempotencyKey` recognises retries [spec]; optional, so without it every call is a new transfer [inferred].
- Webhooks [docs:payments]: `TRANSACTION` events with `transactionEvent.transactionType` `INTRABANK_TRANSFER_OUT` (sender, internal), `INTRABANK_TRANSFER_IN` (recipient, internal), `INTERBANK_TRANSFER_OUT` (sender, external), `INTERBANK_TRANSFER_IN` (external inbound). Reversal webhooks include `returnReason`. `transactionEvent.accountBalances` = `{ totalBalance, heldBalance, lockedBalance, stacksBalance, availableBalance }` each a `CurrencyAmount`, plus `updatedBalance` [webhook-spec AccountBalancesDto; docs:payments sample]. `ACCOUNT_STATUS_CHANGE` (`APPROVED → ACTIVE`) on first transaction [inferred].

## 2. Entities and fields

### HayAccount ("Details of an account") [spec]

`required: ["customData"]` — the only required property (odd but verbatim). All numbers are "to 2 decimal places". Example values from [docs:sample-requests-responses] create-account response.

| property | type | nullable | enum / constraint | description (spec) | example |
|---|---|---|---|---|---|
| `accountHayId` | string uuid | — | | Unique identifier (UUID) of the Account | `7bd7479d-787a-9876-8a11-d8424f1ea078` |
| `accountHolderId` | string uuid | — | | Unique identifier (UUID) of the account holder | `997d394b-e22f-0000-a69d-0b209671baab` |
| `accountHolderType` | string | — | `CUSTOMER` \| `GROUP` | CUSTOMER: accountHolderId is a Customer ID; GROUP: a Group ID | `CUSTOMER` |
| `accountNumber` | string | — | "5-9 digits in length" | Account number | `66090672` |
| `bsb` | string | — | "6 digits in length" | BSB (Bank State Branch) of Account | `636220` |
| `currency` | string | — | ISO 4217 (162 values) | Account currency | `AUD` |
| `productId` | string uuid | — | | Unique identifier (UUID) of the Product | `997d394b-e22f-8467-a69d-0b209671brre` |
| `status` | string | — | `PENDING_APPROVAL` \| `APPROVED` \| `ACTIVE` \| `LOCKED` \| `DORMANT` \| `CLOSED` \| `ACTIVE_IN_ARREARS` | see section 3 | `PENDING_APPROVAL` (sample) |
| `blockedBy` | string | — | `CLIENT` \| `PLATFORM` | The type of entity that is responsible for the blocked account | — |
| `parentAccountId` | string uuid | yes | | Unique identifier (UUID) of the parent Account. Only present for child (e.g. non-AUD FX) accounts. | — |
| `customData` | object | yes | required key | Contains custom metadata stored with the Account | `{"key":"value"}` |
| `totalBalance` | number | — | | Total value of all funds on the Account (this amount will also include unused overdraft limit and Stacks, held and locked value). | `0` |
| `availableBalance` | number | — | | Total balance available for use on Account. Funds that are held, locked and allocated to a Stack will not be available. | `0` |
| `heldBalance` | number | — | "Positive value" | Total value of all authorised but not yet cleared transactions for all Cards on Account | `0` |
| `lockedBalance` | number | — | "Positive value" | The value that has been locked and unavailable for use, typically as a result of an operations team action | `0` |
| `stacksBalance` | number | — | "Positive value" | Total value current held against any Stack(s) on the Account | `0` |
| `overdraftLimit` | number | — | "Positive value" | Total value of the overdraft limit applied to Account | `0` |
| `overdraftBalance` | number | — | "Positive value" | Total value of overdraft used where an overdraft limit exists on the Account | `0` |
| `technicalOverdraftBalance` | number | — | | Total value that is in a negative position beyond the total deposits / overdraft limit on the Account | `0` |
| `homeCurrencyBalanceEquivalent` | `HomeCurrencyBalanceEquivalent` | — | | Account balances expressed in the client's home currency | — (absent in sample) |
| `creationDateTimeUtc` | string date-time | — | | DateTime in UTC format when the Account was created | `2024-03-12T23:54:30.491966Z` |
| `closedDateTimeUtc` | string date-time | — | | DateTime in UTC format when the Account was closed | — |

`HomeCurrencyBalanceEquivalent` = `{ currency: ISO-4217 enum ("Home currency code"), totalBalance: number, availableBalance: number, heldBalance: number }` — same semantics as the account fields, "expressed in the client's home currency" [spec]. [inferred] populated for FX child accounts (converted at cached rate) and equal to the native balances for the AUD parent.

Fields not on `HayAccount` but managed by this tag: risk level (`RiskLevelResponse`), CoP opt-out flag, account-level limits (`ExternalLimitAmounts[]`), rules (`ExternalTransactionRuleResponse[]`). Fields the docs mention with no API surface: overdraft expiry date [docs:account-status].

Created by: `createAccount` (also Customers API `createHayAccount`, Groups API `createHayAccountForGroup` → `HayJointAccount.hayAccount` is a `HayAccount`). Read by: `getHayAccount`, `searchAccounts`, Customers API `getAccountsForCustomerId`. Updated by: `blockAccount` (status, blockedBy), `unblockAccount` (status), `closeAccount` (status, closedDateTimeUtc), `updateOverdraftLimit` (overdraftLimit), `createAccountCustomData` / `deleteAccountCustomData` (customData), transactions/holds/stacks domains (all balance fields, status APPROVED→ACTIVE, ACTIVE↔ACTIVE_IN_ARREARS).

### RiskLevelResponse [spec]
`{ accountId: uuid, riskLevel: string }` — values `LOW` | `HIGH` by description only (no enum). Created implicitly with the account (default `HIGH` [docs:accounts-overview]); read by `getAccountRiskLevel`; updated by `changeAccountRiskLevel`.

### ExternalLimitAmounts [spec]
`{ type: LimitType, accountLimit: number, productLimit: number, effectiveLimit: number }`. `LimitType` (16): `MAX_BALANCE`, `MIN_BALANCE`, `TOTAL_SPEND_PER_YEAR`, `ATM_WITHDRAWAL_PER_DAY`, `TOP_UP_PER_DAY`, `CARD_TOP_UP_PER_DAY`, `BPAY_TOP_UP_PER_DAY`, `BANK_TRANSFER_TOP_UP_PER_DAY`, `PAYMENT_TO_ACCOUNT_NUMBER`, `PAYMENT_TO_PAY_ID`, `CARD_PAYMENTS_DAILY`, `SINGLE_CARD_TRANSACTION`, `MIN_STACK_BALANCE`, `DIRECT_DEBIT_PER_DAY`, `OVERDRAFT_PRODUCT_LIMIT`, `BPAY_DAILY_LIMIT`. Read by `getAccountLimits`; `accountLimit` written by `setAccountLimit` (11 settable types) and `updateMaxBalanceLimit` (`MAX_BALANCE`, [inferred]); cleared by `deleteAccountLimit`; `productLimit` is product configuration (agreed with Shaype, not client-settable) [docs:account-limits].

### ExternalTransactionRuleResponse ("Details of the transaction rule") [spec]
`{ id: uuid, name: string, ruleType: MERCHANT_CODE_BLOCK | MERCHANT_ID_BLOCK | MERCHANT_NAME_BLOCK, rule: object (opaque), ownerId: string, disabled: boolean, expiresAtUtc: date-time }`. Request-side `RuleDetails` = `{ blockedMerchantCategoryCodes: int32[] unique, blockedMerchantIds: string[] unique (≤15 alphanumeric each), blockedMerchantName: string, merchantNameMatchingOperator: CONTAINS | ENDS_WITH | EXACT | STARTS_WITH }`. Created by `addAccountRule`; read by `getAccountRules`, `getAccountRuleById`; `disabled` set by `disableRule`. Webhook example `ruleDetails: { ruleId: "f305cbfa-63db-4083-8819-24daac61fbf7" }` [docs:account-rules].

### AuthorisationHold ("Details of an authorisation hold") [spec]
Fields listed under getPendingHolds. `transactionChannel` enum (62, verbatim): `HAY_TO_HAY_TRANSFER_IN`, `HAY_TO_HAY_TRANSFER_OUT`, `HAAS_TRANSFER_EXTERNAL_IN`, `HAAS_TRANSFER_EXTERNAL_OUT`, `HAAS_TRANSFER_INTERNAL_IN`, `HAAS_TRANSFER_INTERNAL_OUT`, `CURRENCY_CLOUD_CLIENT_CONVERSION_IN`, `CURRENCY_CLOUD_CLIENT_CONVERSION_OUT`, `CURRENCY_CLOUD_CARD_CONVERSION_IN`, `CURRENCY_CLOUD_CARD_CONVERSION_OUT`, `VISA_CARD_NOT_PRESENT`, `VISA_CARD_NOT_PRESENT_INTERNATIONAL`, `VISA_CARD_PRESENT`, `VISA_CARD_PRESENT_INTERNATIONAL`, `VISA_REFUND_DOMESTIC`, `VISA_REFUND_INTERNATIONAL`, `VISA_OCT_DOMESTIC`, `VISA_OCT_INTERNATIONAL`, `VISA_CONTACTLESS`, `VISA_CONTACTLESS_INTERNATIONAL`, `VISA_ATM`, `VISA_ATM_INTERNATIONAL`, `VISA_OTHER`, `APPLE_PAY_CARD_NOT_PRESENT`, `APPLE_PAY_CARD_NOT_PRESENT_INTERNATIONAL`, `APPLE_PAY_CARD_PRESENT`, `APPLE_PAY_CARD_PRESENT_INTERNATIONAL`, `GOOGLE_PAY_CARD_NOT_PRESENT`, `GOOGLE_PAY_CARD_NOT_PRESENT_INTERNATIONAL`, `GOOGLE_PAY_CARD_PRESENT`, `GOOGLE_PAY_CARD_PRESENT_INTERNATIONAL`, `CUSCAL_DE_DEBIT_IN`, `CUSCAL_DE_DEBIT_OUT`, `CUSCAL_DE_CREDIT_IN`, `CUSCAL_DE_CREDIT_OUT`, `DE_DEBIT_RETURN_IN`, `CUSCAL_RTGS_TRANSFER_IN`, `CUSCAL_NPP_TRANSFER_IN`, `CUSCAL_NPP_TRANSFER_OUT`, `NPP_RETURN_IN`, `CUSCAL_BPAY_TRANSFER_IN`, `CUSCAL_BPAY_TRANSFER_OUT`, `BPAY_IN_REJECT`, `MANUAL_ADJUSTMENT`, `VALUE_TRANSFER`, `APPLE_REWARD`, `ACCOUNT_ADJUSTMENT`, `INTEREST_ADJUSTMENT`, `LOAN_ADJUSTMENT`, `LOAN_REPAYMENT`, `SERVICE_FEE`, `VISA_LEGACY`, `VISA_REFUNDS_LEGACY`, `FAT_ZEBRA_TRANSFER_IN`, `CARD_REFUNDS`, `CUSCAL_LEGACY`, `CUSCAL_DE_TRANSFER_IN`, `CUSCAL_DE_TRANSFER_OUT`, `CUSCAL_NPP_SOLICITED_RETURN`, `CUSCAL_DE_TRANSFER_OUT_RETURN`, `NPP_RETURN_OUT`, `HAY_CREDIT`. (The property description documents only the `*_DOMESTIC`/`*_INTERNATIONAL` VISA/Apple/Google names, several of which — e.g. `VISA_CARD_NOT_PRESENT_DOMESTIC` — are **not** in the enum; the enum is authoritative.) Read by `getPendingHolds`; created/updated by the cards/transactions domain and, in external-auth mode, by Shaype calling the client's `POST /holds` / `PATCH /holds/{holdId}` [ext-auth-spec].

### HayCard [spec] — read by `getCardsForAccountId`; owned by the cards domain. `cardStatus` enum: `ACTIVE`, `AWAITING_ACTIVATION`, `BLOCKED`, `INACTIVE`, `EXPIRED`. Closing an account sets linked cards to `INACTIVE` [docs:account-closure].

### Request/response DTOs (no persistent identity)
`BlockAccountRequestBody`, `BlockAccountResponse`, `UnblockAccountRequestBody`, `CloseAccountRequestBody`, `CloseAccountResponse`, `ClosureCheckerError`, `UpdateOptOutRequestBody`, `UpdateMaxBalanceLimitRequestBody`, `UpdateOverdraftLimitRequestBody`, `ChangeHayAccountRiskLevelRequestBody`, `CreateAccountRequestBody` (+ `AccountFxDataRequest`, `ChildAccountsDataRequest`, `FxComplianceDataRequest`), `SearchAccountsRequestBody`, `CreateAccountCustomDataRequestBody`, `ExternalSetAccountLimitRequestBody`, `ExternalSetAccountLimitResponse`, `DeleteAccountLimitResponse`, `ExternalAddTransactionRuleRequest`, `DisableRuleResponse`, `TransferOutRequestBody` (+ `AccountTransfer`, `InternalTransfer`, `PayIdTransfer`), `TransactionOutcome`, `GenericMessage`, `ErrorResponse`, `CurrencyAmount` — all fully expanded in section 1.

### Webhook DTOs touching accounts [webhook-spec]
- Envelope `NotificationDto` (required `customerHayId`, `idempotencyKey`, `type`): `type` enum `ACCOUNT_STATUS_CHANGE`, `CUSTOMER_STATUS_UPDATED`, `CARD_ADDED_TO_WALLET`, `CARD_STATUS_CHANGE`, `CUSTOMER_DETAILS_CHANGE`, `ONBOARDING_PASSED`, `ONBOARDING_FAILED`, `REMINDER`, `SCHEDULED_PAYMENT`, `TRANSACTION`, `DIRECT_ENTRY`, `MANDATE`, `MANDATE_DUE_PAYMENT`, `MANDATE_PAYMENT`, `APPLE_PAY_REWARD_FOR_CUSTOMER`, `MANDATE_ACTION_EXPIRATION`, `DELEGATED_OTP_NOTIFICATION`; plus `actionOwner` enum `CLIENT` | `PLATFORM`, `productId`, `cardHayId` nullable, `firebaseDeviceToken`, and one event sub-object per type. Delivered to client `POST /api/hay/v0/communications/notification`; retried 18 times over up to 48 h with exponential backoff on 401/403/429/5XX [docs:webhook-notification].
- `AccountStatusChangeEventDto` (`accountStatusChangeEvent`): `{ accountHayId: uuid, accountStatus: ACTIVE | BLOCKED | PENDING_APPROVAL | APPROVED | DORMANT | CLOSED | ACTIVE_IN_ARREARS }` — note `BLOCKED` here vs `LOCKED` on `HayAccount.status`; no `LOCKED` value in the webhook enum.
- `CustomerStatusUpdatedEventDto`: `{ customerStatus: ACTIVE | INACTIVE | REJECTED | BLOCKED | PENDING_APPROVAL | REFERRED }`.
- `CardStatusChangeEventDto`: `{ cardHayId, accountHayId, cardStatus: ACTIVE | BLOCKED | EXPIRED | INACTIVE | AWAITING_ACTIVATION, cardLastFourDigits }`.
- `AccountBalancesDto` (inside `transactionEvent.accountBalances`): `{ totalBalance, heldBalance, lockedBalance, stacksBalance, availableBalance }` each `CurrencyAmount`.

### External-authorisation view of an account [ext-auth-spec] (Shaype → client, only when the client holds balances)
`Account` = `{ id: uuid, balance: CurrencyAmount ("Balance of the Account immediately before this transaction was applied. Money held in stacks is not included"), holder: { id: uuid, type: CUSTOMER | GROUP }, statistics: { txn_count_last_10m: int32, txn_sum_last_24h: CurrencyAmount } }`, nullable. Client answers 200 or **470** with `Response = { errorCode: REFUSED_MAX_BALANCE_EXCEEDED | REFUSED_NOT_ENOUGH_FUNDS | REFUSED_SENDER_ACCOUNT_NOT_VERIFIED, reason: string }`; anything else → outcome `INTERNAL_ERROR`; timeouts 1.2 s (card) / 10 s (non-scheme) [docs:external-authorisation-and-balance]. Not needed for the local re-implementation unless external-balance mode is simulated.

## 3. State machines

### Account status (`HayAccount.status`) [spec enum; transitions from docs]

Values (spec descriptions): `PENDING_APPROVAL` "Account is created but not yet approved (Note: Accounts created through this API are automatically set as APPROVED)"; `APPROVED` "Account is approved and ready for use"; `ACTIVE` "Account is approved and has had a transactional action performed on it"; `LOCKED` "Account is blocked"; `DORMANT` "Account is dormant due to inactivity on Account for a specific period of time"; `CLOSED` "Account is closed"; `ACTIVE_IN_ARREARS` "Account balance is in a negative position beyond the total deposits / overdraft limit on the Account".

| from | to | via | source |
|---|---|---|---|
| (none) | `APPROVED` | `createAccount` | [spec] status description ("automatically set as APPROVED") — docs sample shows `PENDING_APPROVAL` [docs:sample-requests-responses]; conflict noted in section 7 |
| (none) | `PENDING_APPROVAL` | account creation outside this API / per docs sample | [docs:sample-requests-responses]; no API transitions it to APPROVED |
| `PENDING_APPROVAL` | `APPROVED` | platform approval (no client operation) | [inferred from enum descriptions] |
| `APPROVED` | `ACTIVE` | first deposit, withdrawal or transfer on the account ("Once deposit or withdrawal happens account automatically changes status to Active") | [docs:account-status] |
| `ACTIVE` | `ACTIVE_IN_ARREARS` | overdraft: negative balance after overdraft expiry date, `updateOverdraftLimit` decreasing the limit below the current negative balance, or technical overdraft (overdrawn with no overdraft set) | [docs:account-status] |
| `ACTIVE_IN_ARREARS` | `ACTIVE` | deposit that covers the overdraft balance | [docs:account-status] |
| `APPROVED` / `ACTIVE` / `ACTIVE_IN_ARREARS` | `LOCKED` | `blockAccount` (client) or platform block ("Blocked by Shaype or the Client") | [docs:accounts-overview, docs:account-status]; which source statuses are blockable is [inferred] |
| `LOCKED` | `ACTIVE` | `unblockAccount` ("will become ACTIVE") | [docs:accounts-overview] |
| `ACTIVE` | `DORMANT` | platform inactivity timer ("for a specific period of time") — no API, period unspecified | [spec enum description] |
| `DORMANT` | `ACTIVE` | presumably a transaction — not documented | [inferred] |
| any non-`CLOSED` (validation passing) | `CLOSED` | `closeAccount` | [docs:account-closure] |
| `CLOSED` | — | terminal: "CLOSED is a final status and there is no way to re-activate a closed account" | [docs:account-status] |

Terminal: `CLOSED`. Blocking from `LOCKED` is a no-op success (idempotent) [spec]. Blocking a `CLOSED` account: it "ends … closed" so counts as success within a hierarchy [spec].

### Webhook `accountStatus` (`AccountStatusChangeEventDto`) [webhook-spec]
`ACTIVE`, `BLOCKED`, `PENDING_APPROVAL`, `APPROVED`, `DORMANT`, `CLOSED`, `ACTIVE_IN_ARREARS` — same machine, with `LOCKED` rendered as `BLOCKED`. Implementer must map `LOCKED → BLOCKED` when emitting.

### Risk level [docs:account-limits]
| from | to | via |
|---|---|---|
| (none) | `HIGH` | `createAccount` (default) [docs:accounts-overview] |
| `HIGH` | `LOW` | `changeAccountRiskLevel { level: LOW }` |
| `LOW` | `HIGH` | `changeAccountRiskLevel { level: HIGH }` |
No terminal state. Same-value set is [inferred] a success.

### Rule lifecycle [spec + inferred]
| from | to | via |
|---|---|---|
| (none) | enabled (`disabled: false`) | `addAccountRule` |
| enabled | `disabled: true` | `disableRule` |
| enabled | expired (`expiresAtUtc` passed) | time (`expiresIn`) |
Whether expired rules are reported as `disabled: true` is [open].

### Account-level limit [docs:account-limits]
| from | to | via |
|---|---|---|
| none (effective = product) | set (effective = account) | `setAccountLimit` / `updateMaxBalanceLimit` |
| set | set (new value) | `setAccountLimit` |
| set | none (effective = product) | `deleteAccountLimit` |

### Customer status changes caused by this domain [docs:account-closure, docs:customer-status-flow, spec]
| from | to | via |
|---|---|---|
| `ACTIVE` | `BLOCKED` | `blockAccount` with `accountBlockStyle` absent or `ACCOUNT_AND_CUSTOMER` [spec] |
| `ACTIVE` (or `BLOCKED`) | `INACTIVE` | `closeAccount` when it closes the customer's last non-CLOSED account (async) [docs:account-closure] |
`INACTIVE` customers must re-onboard as a new customer record; duplicate checks ignore `INACTIVE` records unless the closure `reason` was `SUSPICIOUS` or `DECEASED` [docs:account-closure]. `unblockAccount` → customer `ACTIVE`: not documented [open].

### Card status changes caused by this domain
| from | to | via |
|---|---|---|
| any | `INACTIVE` | `closeAccount` (async, all linked cards; processor status "voided") [docs:account-closure] |
`blockAccount` does **not** change card status per any source; `LOCKED` blocks transactions at the account level [docs:account-status].

## 4. Invariants and calculations

### Balances
- Spec sign convention [spec HayAccount]: `heldBalance`, `lockedBalance`, `stacksBalance`, `overdraftLimit`, `overdraftBalance` are **positive** values; `totalBalance`, `availableBalance`, `technicalOverdraftBalance` are signed. Docs sign convention [docs:account-balances]: Account Balance ≥ 0; Held Balance ≤ 0; Overdraft Balance ≤ 0; Technical Overdraft Balance ≤ 0; Stack Balance ≥ 0; Available and Total ≥ 0 "with exceptional of negative if a technical overdraft is applied". The API returns the spec convention (positives); the docs formulas use signed values.
- Docs formulas, verbatim [docs:account-balances]:
  - **Available Balance** = Account Balance + (Overdraft Limit + Overdraft Balance) + Technical Overdraft Balance + Held Balance + Stacks balance
  - **Total Balance** = Total Available Balance + (Overdraft Limit + Overdraft Balance) + Technical Overdraft Balance + Stacks Balance
  (The second is circular as written and the "+ Stacks balance" in the first contradicts the spec statement that stack funds are not available. Treat these as sign-convention-dependent prose, not implementable as written.)
- Recommended implementable model, consistent with the spec descriptions and every webhook/sample observed [inferred]:
  - `ledger` = sum of settled postings (cash actually on deposit, may be negative when overdrawn).
  - `totalBalance` = `ledger` + `overdraftLimit` (spec: total "will also include unused overdraft limit and Stacks, held and locked value").
  - `overdraftBalance` = max(0, min(−`ledger`, `overdraftLimit`)); `technicalOverdraftBalance` = max(0, −`ledger` − `overdraftLimit`) (spec: "negative position beyond the total deposits / overdraft limit").
  - `availableBalance` = `totalBalance` − `heldBalance` − `lockedBalance` − `stacksBalance` (spec: "Funds that are held, locked and allocated to a Stack will not be available"). Check: webhook sample total 999.58, held/locked/stacks 0 → available 999.58 [docs:account-rules]; sample 3144.69 after +2000 credit [docs:payments].
  - Status `ACTIVE_IN_ARREARS` iff `technicalOverdraftBalance > 0` (or overdraft past expiry) [docs:account-status].
- Stack funds count toward `MAX_BALANCE`; internal account↔stack moves are not counted in daily transfer limits; card/outbound payments never draw down stacks — insufficient main balance fails even if stacks hold funds [docs:stack]. Closing a stack returns its funds to the main balance [docs:stack].
- External-auth `Account.balance` "Money held in stacks is not included" [ext-auth-spec] — consistent with the model above.
- Closure requires `totalBalance == 0` and `heldBalance == 0` [docs:account-closure]; the spec enum implies stacks, locked, overdraft, technical overdraft must also be zero [spec ClosureCheckerError].

### Limits
- Effective limit = account-level limit if set, else product-level limit [docs:account-limits]. Account-level ≤ product-level, enforced on set [docs:account-limits].
- Daily limits: rolling 24 h window; sum of matching transactions in the past 24 h + current transaction must not exceed the limit [docs:account-limits].
- Per-transaction limits: `SINGLE_CARD_TRANSACTION`, `PAYMENT_TO_ACCOUNT_NUMBER` [spec descriptions]. Yearly: `TOTAL_SPEND_PER_YEAR` [spec].
- Risk level `HIGH` ⇒ every limit evaluates to 0 ⇒ every inbound and outbound movement refused [docs:account-limits, docs:accounts-overview].
- Multi-currency aggregation: convert every hierarchy member's balance/transactions to the home currency at the margin-free cached rate, then compare with the limit; aggregated types listed under setAccountLimit; a limit "can be breached at the aggregate level even though no single account exceeds it on its own" [docs:limits-1]. Example: MAX_BALANCE 600 AUD, parent 400 AUD + child 65 USD (=100 AUD) → +80 AUD accepted (580), +150 AUD refused `REFUSED_MAX_BALANCE_EXCEEDED` (650) [docs:limits-1].
- Limit breach on a transfer surfaces as `outcome: LIMIT_BREACH` / `detailedOutcome: REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED` in the docs example [docs:account-limits] (field names as shown there; the B2B `TransactionOutcome` only has `outcome`).
- External-auth mode: platform checks `ATM_WITHDRAWAL_PER_DAY`, `TOP_UP_PER_DAY`, `CARD_PAYMENTS_DAILY`, `PAYMENT_TO_ACCOUNT_NUMBER`, `SINGLE_CARD_TRANSACTION`, `TOTAL_SPEND_PER_YEAR` before calling the client [docs:external-authorisation-and-balance].

### Identifiers and formats
- `accountHayId`, `accountHolderId`, `productId`, `parentAccountId`, rule `id`, `holdHayId`, `transactionId`, all idempotency keys: UUID strings [spec].
- `accountNumber`: stored/returned "5-9 digits" [spec HayAccount]; client-supplied on create must match `^[1-9][0-9]{7,8}$` (8–9 digits, no leading zero) [spec]; search accepts `[\d]{5,9}` [spec]; platform-assigned sample `66090672` (8 digits) [docs:sample-requests-responses]. Uniqueness across the client is [inferred].
- `bsb`: 6 digits [spec]; platform-assigned, sample `636220` [docs:sample-requests-responses]. A "Shaype BSB" identifies internal recipients for ACCOUNT transfers [docs:payments].
- `currency`: ISO 4217 3-letter; domestic = `AUD` only; one account per currency per parent [docs:multi-currency…, docs:bulk-account-opening].
- Amounts: JSON numbers "to 2 decimal places" [spec]; webhook samples show more precision (`999.5800000000`) [docs:account-rules].
- Dates: `*DateTimeUtc` are RFC 3339 UTC with microseconds in samples (`2024-03-12T23:54:30.491966Z`); `expiryDate` on cards is a date [spec].
- `reason` (risk level) 1–128 chars; `note` (block/unblock) ≥ 1 char; transfer `description` 1–255; `reference` 0–35; names 1–140 [spec].
- Rule `blockedMerchantIds` entries ≤ 15 alphanumeric; MCC 4-digit ISO 18245 integers [spec].

### Derived / defaulted fields
- On create: `status = APPROVED` [spec] (see conflict), risk level `HIGH` [docs:accounts-overview], all balances 0, `currency` defaults `AUD` [inferred], `bsb`/`accountNumber` assigned [docs:sample-requests-responses], `creationDateTimeUtc = now`, `customData` from request or null.
- `closedDateTimeUtc` set on `CLOSED` [inferred from field]. `blockedBy` set on block (`CLIENT` for API calls) and cleared on unblock [inferred].
- `homeCurrencyBalanceEquivalent` computed from cached FX rates for FX children [docs:limits-1 aggregation rule, inferred for this field].
- `ExternalTransactionRuleResponse.expiresAtUtc = createdAt + expiresIn` seconds [inferred].
- `effectiveLimit = accountLimit ?? productLimit` [docs:account-limits].

## 5. Cross-domain dependencies

Reads from other domains:
- **Customers**: `createAccount` requires the holder customer to exist and be `ACTIVE` [docs:customer-status-flow]. `makeTransferV1.senderCustomerHayId` must be a customer (holder or group member) [inferred]. Customer `status` enum (spec `HayCustomer`): `ACTIVE`, `BLOCKED`, `INACTIVE`, `PENDING_APPROVAL`, `REFERRED`, `REJECTED`.
- **Groups**: `accountHolderType = GROUP` requires an existing `groupHayId`; group members all have equal access; any member can close [docs:groups]. `HayJointAccount` (Groups API) wraps a `HayAccount` with `groupHayId`, `groupType` `PERSONAL` | `BUSINESS`, `customerHayIds`, `name`, `businessIdentifiers` [spec].
- **Products**: `productId` must be a configured product; product-level limits (`productLimit` per type, incl. `MAX_BALANCE`, `OVERDRAFT_PRODUCT_LIMIT`) and the overdraft facility flag come from product config [docs:product, docs:account-limits].
- **Cards**: `getCardsForAccountId` reads cards by `accountHayId`; `getPendingHolds` reads holds created by card authorisations. `CreateHayCardRequestBody.accountId` links a card to an account (card creation lives in the Cards API) [spec].
- **Transactions / payments**: balances and `APPROVED→ACTIVE`, `ACTIVE↔ACTIVE_IN_ARREARS` transitions are driven by postings; `makeTransferV1` itself creates a transaction (`transactionId`) and emits `TRANSACTION` webhooks [docs:payments]. Limit and rule evaluation happens on every authorisation using this domain's limits, risk level and rules.
- **Stacks**: `stacksBalance` aggregates the account's stacks; stacks endpoints are `/v0/accounts/{accountId}/stacks…` (Stacks API) [spec paths]. `MIN_STACK_BALANCE` limit type.
- **Direct Entry / PayTo / PayID / BPAY / Scheduled Payments**: closure checks in-flight outbound direct debits and, on success, cancels PayTo mandates, deregisters PayIDs, cancels scheduled payments [docs:account-closure]. FX child accounts are disabled for outbound DD, BPAY, PayID registration and PayTo mandates [docs:multi-currency…]. Related paths keyed by `accountId`: `/v1/accounts/{accountId}/payids…`, `/v1/accounts/{accountId}/bpay-billers`, `/v1/accounts/{accountId}/payments/bpay`, `/v0/accounts/{accountId}/scheduledPayments…` [spec].
- **FX engine**: supported-currency set (30 for an AUD wallet), cached margin-free rates for aggregation and `homeCurrencyBalanceEquivalent` [docs:bulk-account-opening, docs:limits-1].

Writes to other domains:
- `blockAccount` (default style) → customer(s) `BLOCKED`; also blocks child accounts [spec].
- `closeAccount` → cards `INACTIVE`, PayIDs deleted, PayTo mandates cancelled, scheduled payments cancelled, scheduled notifications cancelled, customer `INACTIVE` (if last account) with closure `reason` stored on the customer [docs:account-closure, spec].
- `makeTransferV1` → creates a transaction; INTERNAL transfers credit the recipient account [docs:payments].
- All state changes → webhook notifications (`ACCOUNT_STATUS_CHANGE`, `CUSTOMER_STATUS_UPDATED`, `CARD_STATUS_CHANGE`, `TRANSACTION`) [webhook-spec, docs:account-closure, docs:payments].

Listing endpoints outside this tag that return `HayAccount`: `GET /v0/customers/{customerHayId}/accounts` (`getAccountsForCustomerId`, includes FX children) [spec, docs:bulk-account-opening].

## 6. Error catalogue

HTTP-level (every operation) [spec]: `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content` (closeAccount says "Unprocessable Entity"), `500 Internal Server Error`, `501 Not Implemented` → `ErrorResponse { details, message, status, traceId }`. No message texts are given for these in the spec.

Documented condition → response:

| condition | status | body / message | source |
|---|---|---|---|
| closeAccount: held balance non-zero | 422 [inferred code] | `CloseAccountResponse` `result: FAILURE`, `description: "Account closure failed. Check errors for more details."`, error `type: ACCOUNT_BALANCE_HELD`, `errorMessage: "Account has 17.78 held balance."` | docs:account-closure |
| closeAccount: total balance non-zero | 422 | error `type: ACCOUNT_BALANCE_TOTAL`, `"Account has 17.78 total balance."` | docs:account-closure |
| closeAccount: in-flight outbound direct debits | 422 | error `type: INFLIGHT_OUTBOUND_DIRECT_DEBITS`, `"Account has 1 inflight outbound direct entries: [87225f75-9e63-4aa4-9594-8cea4d96e1c1]"` | docs:account-closure |
| closeAccount: stacks / locked / overdraft / technical overdraft non-zero; child account not closed | 422 | error `type` ∈ `ACCOUNT_BALANCE_STACKS`, `ACCOUNT_BALANCE_LOCKED`, `ACCOUNT_BALANCE_OVERDRAFT`, `ACCOUNT_BALANCE_TECHNICAL_OVERDRAFT`, `CHILD_ACCOUNT_STATUS` (no message text documented) | spec enum |
| closeAccount: multiple failures | 422 | all errors listed together in `errors[]` | docs:account-closure |
| blockAccount: one or more accounts in scope could not be blocked | 422 | `BlockAccountResponse { failedAccounts: [uuid…], message }` | spec |
| blockAccount: account blocked but customer not (permission issue) | 200 | `BlockAccountResponse` (reported as success) | spec |
| createAccount: `fx.childAccounts` present without `initMode` | 422 | `fx.childAccounts.initMode must not be null` | docs:bulk-account-opening |
| createAccount: `initMode: CUSTOM` without `currencies` | 422 | `INVALID_ARGUMENT: fx.childAccounts.currencies is mandatory when initMode is CUSTOM` | docs:bulk-account-opening |
| createAccount: `initMode: ALL` with `currencies` | 422 | `INVALID_ARGUMENT: fx.childAccounts.currencies must not be provided when initMode is ALL` | docs:bulk-account-opening |
| createAccount: `initMode: NONE` with `currencies` | 422 | `INVALID_ARGUMENT: fx.childAccounts.currencies must not be provided when initMode is NONE` | docs:bulk-account-opening |
| createAccount: `currencies: []` | 422 | `fx.childAccounts.currencies size must be between 1 and 2147483647` | docs:bulk-account-opening |
| createAccount: non-ISO-4217 currency code | 422 | `Could not read JSON: Invalid currency value 'ABC'. Known currency values are: […]` | docs:bulk-account-opening |
| createAccount: customer not `ACTIVE` | 4xx [inferred] | not documented | docs:customer-status-flow (rule only) |
| createAccount: FX currency without `parentAccountId` | 4xx [inferred] | "it is mandatory to provide an appropriate parent `accountId`" | docs:multi-currency… |
| makeTransferV1 from an FX child with non-INTERNAL type | rejected (code not given) | "the call will be rejected" | docs:multi-currency… |
| setAccountLimit / updateMaxBalanceLimit / updateOverdraftLimit above product limit | 422 [inferred] | "cannot exceed … applied to the Product" | spec descriptions |
| schema violations (missing required, `minLength`, `pattern`, `exclusiveMinimum`, enum) | 400 or 422 [open which] | `ErrorResponse` | spec |
| unknown `accountId` / `ruleId` | not declared (no 404) | [open] | spec |

Transaction outcomes (returned as HTTP 200 `TransactionOutcome.outcome` from makeTransferV0/V1, and as `transactionEvent.outcome` in webhooks) with documented meaning [docs:payment-transaction-outcome]:
`ACCEPTED` accepted for processing; `REFUSED_CARD_PREFERENCE`; `REFUSED_FRAUD`; `REFUSED_MAX_BALANCE_EXCEEDED` would exceed `MAX_BALANCE`; `REFUSED_NOT_ENOUGH_FUNDS` would breach `MIN_BALANCE`; `INTERNAL_ERROR`; `REFUSED_ANNUAL_SPENDING_LIMIT_BREACHED`; `REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED`; `REFUSED_DAILY_TOP_UP_LIMIT_BREACHED`; `REFUSED_ACCOUNT_BLOCKED` account is blocked; `REFUSED_ACCOUNT_CLOSED`; `REFUSED_RECIPIENT_ACCOUNT_BLOCKED` (Shaype-to-Shaype); `REFUSED_RECIPIENT_ACCOUNT_CLOSED`; `REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED`; `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED`; `REFUSED_RULES` account rule matched; `REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED`; `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`; `REFUSED_TOTAL_NET_VISA_DAILY_LIMIT_BREACHED` "client scheme transactions are currently blocked"; `REFUSED_TOTAL_NON_SCHEME_DAILY_LIMIT_BREACHED`; `REFUSED_BPAY_INVALID_BILLER_CODE`; `REFUSED_BPAY_INVALID_REFERENCE`; `REFUSED_BPAY_INVALID_PAYMENT`; `REFUSED_BPAY_REJECTED`; `REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED`; `REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED`; `REFUSED_SANCTIONS`; `REFUSED_UNABLE_TO_VALIDATE`; `REFUSED_INSUFFICIENT_DATA`. Not currently in use: `REFUSED_ACCOUNT_PREFERENCE`, `REFUSED_DAILY_LIMIT_EXCEEDED`, `REFUSED_AML`, `REFUSED_ACCOUNT_NOT_FOUND_FOR_CARD_TOKEN`, `REFUSED_UNDETERMINED_BALANCE_FOR_ACCOUNT`, `REFUSED_ACCOUNT_NOT_FOUND_FOR_CURRENCY`, `REFUSED_UNDETERMINED_SPENDING_FOR_ACCOUNT`, `REFUSED_UNDETERMINED_TOP_UPS_FOR_ACCOUNT`, `REFUSED_UNDETERMINED_ATM_WITHDRAWALS_FOR_ACCOUNT`. B2B-spec-only values with no docs entry: `REFUSED_LIMIT_BREACH`, `REFUSED_CUSTOMER_PREFERENCE`, `REFUSED_INSUFFICIENT_FUNDS`, `REFUSED_INVALID_PAY_ID`, `UNKNOWN`, `REFUSED_SENDER_ACCOUNT_NOT_VERIFIED`, `REFUSED_CAPABILITY_NOT_ENABLED`, `REFUSED_QUOTE_EXPIRED` [spec].

## 7. Open questions

1. **Initial status on create**: spec says `APPROVED`; docs sample response shows `PENDING_APPROVAL`. Decide (recommend `APPROVED`, transition to `ACTIVE` on first posting).
2. **Unknown account / rule IDs**: no 404 declared anywhere. Choose 400 vs 422 `ErrorResponse` (and message text) for not-found and for accounts belonging to another client (403?).
3. **400 vs 422 split** for schema/validation failures: spec lists both on every op with no rule. The only documented validation failures use 422 (bulk-account-opening).
4. **`LOCKED` vs `BLOCKED`**: `HayAccount.status` has `LOCKED`; webhook `accountStatus` has `BLOCKED` and no `LOCKED`. Implement the mapping; decide whether `GET` ever returns `BLOCKED`.
5. **Unblock semantics**: does `unblockAccount` restore the previous status (`APPROVED`) or always `ACTIVE` (docs say ACTIVE)? Does it unblock the customer(s) and child accounts blocked by `ACCOUNT_AND_CUSTOMER` / cascade? Can a `PLATFORM`-blocked account be unblocked by the client? Result when the account is not `LOCKED` (e.g. `CLOSED`)?
6. **Block scope details**: does blocking cascade to a parent when a child is targeted? What `message` text is returned? Is the customer block partial-failure message distinguishable?
7. **Close of an already-CLOSED account**: 202 SUCCESS (idempotent) or 422? Which HTTP code carries `result: FAILURE` (assumed 422). Is `description` on success documented anywhere (no)?
8. **Closure async timing**: how long after 202 do cards go `INACTIVE` and the customer `INACTIVE`; for a local mock, immediate vs delayed emission of `CARD_STATUS_CHANGE` / `CUSTOMER_STATUS_UPDATED`.
9. **Balance formulas / sign conventions**: docs formulas are not internally consistent with the spec descriptions (stacks in "available"; held sign). The section-4 model is inferred; confirm `technicalOverdraftBalance` sign (spec says "Value to 2 decimal places", docs say ≤ 0).
10. **Overdraft**: is `overdraftLimit: 0` allowed (remove overdraft)? Is there an overdraft expiry date and where is it stored? Does lowering below the drawn amount immediately set `ACTIVE_IN_ARREARS`?
11. **`updateMaxBalanceLimit` vs `setAccountLimit(MAX_BALANCE)`**: same storage? Same product cap? Which wins if both are called?
12. **`getAccountLimits` shape when no account override**: `accountLimit` null / 0 / absent / equal to product; does risk level `HIGH` show as `effectiveLimit: 0`? Are the 5 non-settable types still listed (with product values)?
13. **Deleting a non-settable limit type** (`MIN_BALANCE`, `MIN_STACK_BALANCE`, `OVERDRAFT_PRODUCT_LIMIT`, `CARD_TOP_UP_PER_DAY`, `BPAY_TOP_UP_PER_DAY`) via `deleteAccountLimit`: no-op, `success:false`, or error?
14. **Limit-type aliases** in docs:limits-1 (`SINGLE_CARD_TRANSACTION_LIMIT`, `CARD_TRANSACTIONS_PER_DAY`, `TRANSFERS_OUT_PER_DAY`, `BPAY_PER_DAY`) — no spec enum equivalent for `TRANSFERS_OUT_PER_DAY` (outcome `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED` exists). Decide whether a hidden daily transfers-out limit exists at product level.
15. **Daily window**: rolling 24 h (explicit rule) vs "until the next calendar day" (example text) — implement rolling 24 h.
16. **Risk level interplay**: while `HIGH`, are custom account limits preserved and re-applied on `LOW`? Does `changeAccountRiskLevel` emit any webhook?
17. **Custom data**: `createAccountCustomData` merge vs replace; size limits; key restrictions; is `customData` returned by `searchAccounts` / `getAccountsForCustomerId` without `expand`?
18. **`expand` query**: are other values accepted (comma-separated list)? Behaviour for unknown values (ignore vs 400)?
19. **Search**: exact match only; does it return `CLOSED` accounts and FX children; is the `accountNumber` pattern anchored (5–9 digits exactly)?
20. **Rules**: does `disableRule` hard-delete or set `disabled: true` (naming says disable); are disabled/expired rules returned by `getAccountRules` / `getAccountRuleById`; what does `rule` (opaque object) contain; is rule name unique per account; can a rule be added to a `CLOSED` account; are product-wide rules (`ownerId` = client reference) visible via `getAccountRules`?
21. **CoP opt-out**: no read-back field, no documented effect. Decide storage + whether to surface on `HayAccount`.
22. **Transfer idempotency**: `idempotencyKey` optional — behaviour on omitted key (always new) and on reuse with a different body (409? not declared).
23. **Transfer refusals**: confirm all `REFUSED_*` outcomes come back as HTTP 200 `TransactionOutcome` (no 4xx). Which outcome for an FX-child sender with non-INTERNAL type (`REFUSED_CAPABILITY_NOT_ENABLED` assumed). Which outcome when risk level is `HIGH` (`REFUSED_LIMIT_BREACH` assumed).
24. **Group accounts**: "A group should have a single account" — enforce on create (422) or allow? Does `blockAccount` default style block every group member?
25. **Multi-currency**: which 30 currencies the FX engine supports (needed for `initMode: ALL` and the "valid but unsupported" 422); child accounts' `accountNumber`/`bsb` (do FX children get one?); does closing a parent require children `CLOSED` first (`CHILD_ACCOUNT_STATUS`) or cascade; is `homeCurrencyBalanceEquivalent` present on AUD accounts.
26. **`DORMANT`**: inactivity period and whether any client operation can trigger/clear it — nothing documented.
27. **Webhook emission set** for this domain: only closure names `ACCOUNT_STATUS_CHANGE` + `CARD_STATUS_CHANGE`; block/unblock/create/arrears emissions are inferred. Decide which to emit locally and the `actionOwner` (`CLIENT` for API-driven changes).
28. **Deprecated v0 create endpoints** (`POST /v0/customers/{id}/account`, `POST /v0/groups/{id}/account`) still in the spec — implement as aliases of `createAccount` or omit.
