# groups-stacks

Domain: **Groups API** (tag description: "Set of APIs related to managing Groups (for Joint and Business accounts)") and **Stacks API** (tag description: "Set of APIs related to managing savings or money jars through Stacks") [spec]. 15 operations: 9 Stacks, 6 Groups.

Sources: `[spec]` = b2b-operations-api.json; `[docs:groups]`, `[docs:stack]`, `[docs:customer-removal]`, `[docs:account-balances]`, `[docs:account-status]`, `[docs:account-closure]`, `[docs:customer-status-flow]` = developer.shaype.com/docs/<slug>.md; `[ref:<slug>]` = developer.shaype.com/reference/<slug>.md (these pages contain only the per-operation OpenAPI JSON plus the summary/description already in the spec — no extra prose); `[webhooks]` = notification-webhooks.json; `[ext-auth]` = external-balance.yaml; `[inferred]` = my reading, not stated anywhere.

Conventions common to every operation in this domain [spec]:
- Every operation declares responses `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content` (`Unprocessable Entity` on createHayAccountForGroup), `500 Internal Server Error`, `501 Not Implemented`, all with schema `ErrorResponse`. **No operation declares 404 or 409.** Which failing condition maps to 400 vs 422 is not stated anywhere except the one 422 example on createHayAccountForGroup.
- `ErrorResponse` = `{ details: string, message: string, status: string, traceId: string }` (no required fields).
- No operation declares request headers, security schemes, or examples beyond the one 422 example noted below.
- All IDs are `string` `format: uuid`. All timestamps are `string` `format: date-time`, described as "DateTime in UTC format".
- Money is `type: number`, "to 2 decimal places" (no `currency` field anywhere in this domain; the account's `currency` applies) [spec, inferred].

## 1. Operations

### GET /v0/accounts/{accountId}/stacks (getAllStacks)
- **Purpose:** "Get all Stacks by Account ID" [spec]. Not deprecated.
- **Path params:** `accountId` — string, uuid, required, "Unique identifier (UUID) of the Account" [spec].
- **Query params:** `includeClosed` — boolean, optional, default `false`, "Includes closed Stacks if set to true (default to false if no option provided)" [spec].
- **Request body:** none.
- **Response 200:** `array` of `HayStack` (see §2): `accountHayId`, `balance`, `closedAtUtc`, `createdAtUtc`, `imageUrl`, `name`, `stackHayId`, `status` enum `["OPEN","CLOSED"]`, `targetAmount` [spec].
- **Behaviour:**
  - Returns all stacks of the account; with `includeClosed=false` (default) stacks with `status = CLOSED` are omitted [spec param description; docs:stack "You can include closed stacks by setting the includeClosed parameter to true"].
  - Read-only, no state change [inferred].
  - Unknown account: no 404 declared; which of 400/422 is returned is undefined [spec, open].
  - Ordering of the array is undefined [open].
- **Webhooks:** none mentioned.

### POST /v0/accounts/{accountId}/stacks (createStack)
- **Purpose:** "Create new stack" [spec]. Not deprecated.
- **Path params:** `accountId` — string, uuid, required [spec].
- **Request body:** `CreateHayStackRequestBody` (required) — "Body of a request to create a stack." [spec]
  | field | type | required | constraints | description |
  |---|---|---|---|---|
  | `name` | string | **yes** | minLength 1, maxLength 20 | "Name of the Stack" |
  | `imageUrl` | string | no | — | "URL of image representing the Stack goal embedded in app" |
  | `targetAmount` | number (format double) | no | minimum 0 | "Target balance value set on Stack" |
- **Response 200:** schema `type: boolean` (a bare JSON boolean, description "Success"). **The created stack (and its `stackHayId`) is NOT returned**; the caller must call getAllStacks to discover it [spec; inferred consequence].
- **Behaviour:**
  - "You can create as many stacks as you like under a single account." [docs:stack] — but the spec's `UpdateStackResponse.error` enum contains `OPEN_STACKS_LIMIT_REACHED` and `TOTAL_STACKS_LIMIT_REACHED` [spec], so some limit exists at least in some configuration; the limit values are undefined [open].
  - "Each stack must have a unique name; duplicate names are not allowed." [docs:stack]. The spec names the error `STACK_NAME_ALREADY_IN_USE` (only on `UpdateStackResponse`) [spec]. How createStack reports a duplicate (HTTP status, message) is undefined [open]. Whether uniqueness is scoped to OPEN stacks only or includes CLOSED stacks is undefined [open].
  - "Stack names cannot contain emojis." [docs:stack]. Error code/status for this is undefined [open].
  - "you can set a your goal by specifying a target amount, which can be up to the total limit applied to the account." [docs:stack] — i.e. `targetAmount` ≤ the account's limit; which limit ("total limit") is not named; most plausibly `MAX_BALANCE` [inferred].
  - New stack: `status = OPEN`, `balance = 0`, `createdAtUtc = now`, `closedAtUtc` absent [inferred from HayStack field semantics; not stated].
  - No `idempotencyKey` in the body; the operation is not documented as idempotent [spec].
  - Which account statuses permit stack creation is undefined [open]. (`LOCKED` "will block all transactions and transfers to the account" [docs:account-status], which does not obviously cover stack creation.)
- **Webhooks:** none mentioned.

### GET /v0/accounts/{accountId}/stacks/transactions (getAllStackTransactions)
- **Purpose:** "Get all Stack Transactions by Account ID" — "Retrieves all transactions across all Stacks" [spec]. Not deprecated.
- **Path params:** `accountId` — string, uuid, required [spec].
- **Query params** [spec]:
  | name | type | required | constraints | description |
  |---|---|---|---|---|
  | `offset` | integer | **yes** | — | "Offset used for paging results" |
  | `limit` | integer | **yes** | "value between 1 and 1000" (description only; no `minimum`/`maximum` keywords) | "List fetch limit, value between 1 and 1000" |
  | `type` | string, nullable | no | enum `["STANDARD","ROUND_UP"]` | "Stack transaction type" |
- **Request body:** none.
- **Response 200:** `array` of `HayStackTransaction` (see §2) [spec].
- **Behaviour:**
  - "This endpoint is used to retrieve all the transactions of a Stacks that belongs to account." [docs:stack]
  - When `type` is omitted, both `STANDARD` and `ROUND_UP` transactions are returned [docs:stack states this for the by-stack-ID variant; inferred to apply here too].
  - Includes transactions of CLOSED stacks — "Historical transactions will still be visible within transaction list." [docs:stack; inferred that this list is meant].
  - Sort order undefined [open]. `limit` outside 1..1000 → presumably 400, not stated [open].
- **Webhooks:** none.

### POST /v0/accounts/{accountId}/stacks/transactions (stackToStackTransfer)
- **Purpose:** "Transfer funds from Stack to Stack of an Account" [spec]. Not deprecated.
- **Path params:** `accountId` — string, uuid, required [spec].
- **Request body:** `StackToStackTransferRequestBody` (required) — "Body of a request to move funds from a stack to another stack." [spec]
  | field | type | required | constraints | description |
  |---|---|---|---|---|
  | `amount` | number | **yes** | minimum 0, exclusiveMinimum true (i.e. > 0) | "Value of the Transaction, to 2 decimal places" |
  | `customerId` | string uuid | **yes** | — | "Unique identifier (UUID) of the Customer (initiator of the transfer)" |
  | `depositStackId` | string uuid | **yes** | — | "Unique identifier (UUID) of the destination Stack" |
  | `withdrawalStackId` | string uuid | **yes** | — | "Unique identifier (UUID) of the source Stack" |
  | `description` | string | no | minLength 0, maxLength 20 | "Transaction description" |
- **Response 200:** `StackToStackTransactionOutcome` — "Stack to Stack Transaction outcome details" [spec]:
  | field | type | description |
  |---|---|---|
  | `depositTransactionId` | string uuid | "Unique identifier (UUID) of the Deposit (account to destination stack) Transaction" |
  | `outcome` | string enum `["ACCEPTED","INTERNAL_ERROR","REFUSED_INSUFFICIENT_FUNDS","UNKNOWN"]` | "Transaction outcome" |
  | `withdrawalTransactionId` | string uuid | "Unique identifier (UUID) of the Withdrawal (source stack to account) Transaction" |
- **Behaviour:**
  - Moves `amount` from `withdrawalStackId` to `depositStackId`; both stacks must belong to the same account (`accountId`) — "Funds can be transferred between two stacks linked to the same account" [docs:stack].
  - Implemented as two stack transactions: a withdrawal (source stack → account) and a deposit (account → destination stack), each with its own transaction id [spec field descriptions]. `HayStackTransaction.counterpartTransactionId` links the pair: "Unique identifier (UUID) of the counterpart transaction (Stack to Stack transactions)" [spec].
  - Net effect on account balances: `stacksBalance` unchanged, `availableBalance` unchanged; source stack `balance -= amount`, destination stack `balance += amount` [inferred from docs:stack].
  - "Any internal cash transfers within an account that involve a Stack will not form part of the daily transfer limits, these include: Available Balance to Stack or Stack to Stack" [docs:stack].
  - Source stack balance < amount → `outcome = REFUSED_INSUFFICIENT_FUNDS` [spec enum; inferred that this is returned with HTTP 200 as a business outcome rather than a 4xx].
  - Stacks must be `OPEN`; `depositStackId == withdrawalStackId`; stack not belonging to `accountId`; `customerId` not a holder/member of the account — all plausible validations with undefined status/message [open].
  - Resulting `HayStackTransaction.type = STANDARD`, `originType = CUSTOMER` for API-initiated transfers [inferred from enum descriptions: "STANDARD: Movement of fund to, from or between stacks triggered by customer or ops"].
  - No idempotency key [spec].
- **Webhooks:** none mentioned. The webhook `TransactionEventDto.transactionType` enum has no stack-related value [webhooks]; whether a `TRANSACTION` notification fires for stack movements is undefined [open].

### PUT /v0/accounts/{accountId}/stacks/{stackId} (updateStack)
- **Purpose:** "Update Stack" [spec]. Not deprecated.
- **Path params:** `accountId` — string uuid required, "Unique identifier (UUID) of the Account"; `stackId` — string uuid required, "Unique identifier (UUID) of the Stack" [spec].
- **Request body:** `UpdateStackRequestBody` (required) — "Body of a request to update a stack." No required fields [spec].
  | field | type | required | constraints | description |
  |---|---|---|---|---|
  | `imageUrl` | string | no | — | "URL of image representing the Stack goal embedded in app" |
  | `name` | string | no | minLength 1, maxLength 20 | "Name of the Stack" |
  | `targetAmount` | number | no | minimum 0 | "Target balance value set on Stack" |
- **Response 200:** `UpdateStackResponse` [spec]:
  | field | type | description |
  |---|---|---|
  | `error` | string enum `["OPEN_STACKS_LIMIT_REACHED","TOTAL_STACKS_LIMIT_REACHED","STACK_NAME_ALREADY_IN_USE"]` | (no description) |
  | `stack` | `Stack` (NOT `HayStack`) | `{ accountHayId: uuid, balance: number, closedAtUtc: date-time, createdAtUtc: date-time, hayId: uuid, imageUrl: string, name: string, status: enum ["OPEN","CLOSED"], targetAmount: number }` — note the id field is `hayId` here, whereas `HayStack` uses `stackHayId` |
- **Behaviour:**
  - "This endpoint is utilised to update the stack name, target amount, and stack image." [docs:stack]
  - Renaming to a name already used on the account → `error = STACK_NAME_ALREADY_IN_USE` [spec enum]. Whether this comes with HTTP 200 (error inside the body) or a 4xx is undefined; the schema placement strongly suggests 200 with `error` set and `stack` possibly absent [inferred].
  - `OPEN_STACKS_LIMIT_REACHED` / `TOTAL_STACKS_LIMIT_REACHED` are in this response's enum although they read as creation-time errors; whether they can actually occur on update is undefined [open].
  - Partial-update vs full-replace semantics (PUT with all-optional fields) undefined; `imageUrl` clearing undefined [open].
  - Updating a `CLOSED` stack: undefined [open].
  - `balance`, `status`, `accountHayId` are not updatable via this endpoint [spec: not in request body].
- **Webhooks:** none mentioned.

### POST /v0/accounts/{accountId}/stacks/{stackId}/close (closeStack)
- **Purpose:** "Close Stack" — "Funds will be transferred into account." [spec]. Not deprecated.
- **Path params:** `accountId`, `stackId` — string uuid, required [spec].
- **Request body:** none [spec].
- **Response 200:** `type: boolean` (bare JSON boolean; "Success") [spec].
- **Behaviour:**
  - "This endpoint is used to close an open stack." [docs:stack] → precondition `status = OPEN` [inferred]; result for an already-CLOSED stack undefined [open].
  - "We perform a soft deletion meaning records of the Stack will be stored. Historical transactions will still be visible within transaction list." [docs:stack] → stack row retained with `status = CLOSED`, `closedAtUtc = now`; still returned by getAllStacks when `includeClosed=true` [spec + docs:stack].
  - "If the stack holds any balance, the funds will be transferred to the account's main balance." [docs:stack] → stack `balance` → 0; account `availableBalance += balance`; account `stacksBalance -= balance`; `totalBalance` unchanged [inferred from docs:account-balances formulas].
  - "Closed stack can't be open again" [docs:stack] → `CLOSED` is terminal.
  - Whether the sweep creates a `HayStackTransaction` (type `STANDARD`, stack → account) is undefined [open]. Whether a stack with balance 0 closes identically is implied yes [docs:stack].
  - Not idempotent by declaration; second call behaviour undefined [open].
- **Webhooks:** none mentioned.

### GET /v0/accounts/{accountId}/stacks/{stackId}/transactions (getTransactionsForStack)
- **Purpose:** "Get all Stack Transactions by Stack ID" [spec]. Not deprecated.
- **Path params:** `accountId`, `stackId` — string uuid, required [spec].
- **Query params** [spec]: `offset` integer required ("Offset used for paging results"); `limit` integer required ("List fetch limit, value between 1 and 1000"); `type` string nullable optional enum `["STANDARD","ROUND_UP"]` ("Stack transaction type").
- **Request body:** none.
- **Response 200:** `array` of `HayStackTransaction` [spec].
- **Behaviour:**
  - "This endpoint is used to retrieve all the transaction of a Stack by stack id. This will return all the transactions including standard and ROUND_UP if type is not provided in the request." [docs:stack]
  - Filter is on `HayStackTransaction.stackHayId == stackId` [inferred]. For a stack-to-stack transfer, each leg appears under its own stack, linked via `counterpartTransactionId` [inferred from spec descriptions].
  - Works for CLOSED stacks (history retained) [docs:stack].
  - Ordering undefined [open].
- **Webhooks:** none.

### POST /v0/accounts/{accountId}/stacks/{stackId}/transfer-in (accountToStackTransfer)
- **Purpose:** "Transfer funds from Account to Stack" [spec]. Not deprecated.
- **Path params:** `accountId` — "Unique identifier (UUID) of the Account"; `stackId` — "Unique identifier (UUID) of the Stack"; both string uuid required [spec].
- **Request body:** `AccountToStackTransferRequestBody` (required) — "Body of a request to move funds from the main account to a stack." [spec]
  | field | type | required | constraints | description |
  |---|---|---|---|---|
  | `amount` | number | **yes** | none declared (no `minimum`, unlike stack-to-stack) | "Value of the Transaction, to 2 decimal places" |
  | `customerId` | string uuid | **yes** | — | "Unique identifier (UUID) of the Customer (initiator of the transfer)" |
  | `description` | string | no | minLength 0, maxLength 20 | "Transaction description" |
- **Response 200:** `StackTransactionResponse` — "Stack Transaction outcome details" [spec]:
  | field | type | description |
  |---|---|---|
  | `outcome` | string enum `["ACCEPTED","INTERNAL_ERROR","REFUSED_INSUFFICIENT_FUNDS","UNKNOWN"]` | "Transaction outcome" |
  | `transactionId` | string uuid | "Unique identifier (UUID) of the Transaction" |
- **Behaviour:**
  - "This endpoint is used to transfer the funds from Account to Stack." [docs:stack]. Effect: account `availableBalance -= amount`, account `stacksBalance += amount`, stack `balance += amount`, account `totalBalance` unchanged [inferred from docs:account-balances formulas: available excludes stacks, total includes them].
  - Insufficient `availableBalance` → `outcome = REFUSED_INSUFFICIENT_FUNDS` [spec enum; inferred mapping]. Whether overdraft funds can be moved into a stack is undefined [open].
  - Not counted against daily transfer limits: "Available Balance to Stack" is explicitly listed [docs:stack]. Stack funds still count towards the account's max balance: "Any funds that reside in a Stack will form part of the total account's max balance limit." [docs:stack] — so the transfer cannot breach `MAX_BALANCE` since total is unchanged [inferred].
  - Stack must be `OPEN` [inferred]. Account must permit transfers (not `LOCKED`/`CLOSED`) [inferred from docs:account-status].
  - Creates a `HayStackTransaction` with `type = STANDARD`, `originType = CUSTOMER`, `customerId` as given, `notes = description` [inferred from field descriptions]. `ROUND_UP`-type transactions are "Account to Stack transfer triggered by RoundUp functionality" [spec] — i.e. produced by a platform feature, not by this endpoint; no API in the spec creates them [spec, inferred].
  - No idempotency key [spec].
- **Webhooks:** none mentioned.

### POST /v0/accounts/{accountId}/stacks/{stackId}/transfer-out (stackToAccountTransfer)
- **Purpose:** "Transfer funds from Stack to Account" [spec]. Not deprecated.
- **Path params:** `accountId` — described simply as "Account ID"; `stackId` — "Stack ID"; both string uuid required [spec].
- **Request body:** `StackToAccountTransferRequestBody` (required) — "Body of a request to move funds from a stack to the main account." [spec]
  | field | type | required | constraints | description |
  |---|---|---|---|---|
  | `amount` | number | **yes** | none declared | "Amount of money to be moved from a stack." |
  | `customerId` | string uuid | **yes** | — | "Customer ID to be associated with this transaction." |
  | `description` | string | no | minLength 0, maxLength 20 | "Description of the transaction." |
- **Response 200:** `StackTransactionResponse` (`outcome` enum `["ACCEPTED","INTERNAL_ERROR","REFUSED_INSUFFICIENT_FUNDS","UNKNOWN"]`, `transactionId` uuid) [spec].
- **Behaviour:**
  - "This endpoint is used to transfer back the funds from Stack to Account" [docs:stack]. Effect: stack `balance -= amount`, account `stacksBalance -= amount`, account `availableBalance += amount`, `totalBalance` unchanged [inferred from docs:account-balances].
  - Stack `balance < amount` → `outcome = REFUSED_INSUFFICIENT_FUNDS` [spec enum; inferred mapping].
  - A `MIN_STACK_BALANCE` account limit exists ("Minimum balance that can be held in Stack (Shaype use only)") [spec, limitType enum on deleteAccountLimit / ExternalLimitAmounts; docs:account-limits]; it is not settable by clients via setAccountLimit (absent from that op's enum) [spec]. Its effect on this transfer is undefined [open].
  - Not part of daily transfer limits [docs:stack lists "Available Balance to Stack or Stack to Stack"; stack→account is not listed explicitly but is an "internal cash transfer within an account that involve a Stack" — inferred to be exempt].
  - Creates a `HayStackTransaction` with `type = STANDARD` [inferred].
- **Webhooks:** none mentioned.

### POST /v0/groups/create (createHayGroup)
- **Purpose:** "Create Group" [spec]. Not deprecated.
- **Path/query params:** none [spec].
- **Request body:** `CreateHayGroupRequestBody` (required) — "Body of a request to create a group of customers." [spec]
  | field | type | required | constraints | description |
  |---|---|---|---|---|
  | `customerHayIds` | array of string uuid | **yes** | no `minItems` declared; docs require ≥ 1 | "Unique identifiers (UUID) of the Customer(s) associated to this Group" |
  | `idempotencyKey` | string uuid | **yes** | — | "Unique value (UUID) used to identify this request and used to recognise any subsequent retries" |
  | `groupName` | string | no | none declared (contrast updateGroup: 1..100) | "Name of the Group, if not provided a generic name associated with the client will be generated" |
  | `groupType` | string enum `["PERSONAL","BUSINESS"]` | no | default `PERSONAL` | "Group type. Possible values: **BUSINESS**: Non-individual / joint entity; **PERSONAL**: Joint account entity (default if no option selected)" |
  | `businessIdentifiers` | `BusinessIdentifiers` object | no | see below | "Identifiers issued by the government to the entity represented by this Group" |
  `BusinessIdentifiers` [spec]: `businessNumber` string minLength 11 maxLength 11 "Australian Business Number (ABN)"; `companyNumber` string 9/9 "Australian Company Number (ACN)"; `registeredBodyNumber` string 9/9 "Australian Registered Body Number (ARBN)"; `registeredSchemeNumber` string 9/9 "Australian Registered Scheme Number (ARSN)". None required.
- **Response 200:** `HayGroup` — "Details of a Group" [spec]: `businessIdentifiers` (BusinessIdentifiers), `customerHayIds` (array uuid), `groupHayId` (uuid, "Unique identifier (UUID) of the Group"), `groupName` (string), `groupType` (enum `["PERSONAL","BUSINESS"]`).
- **Behaviour:**
  - "A group is an association of 1 or more customers. It can be of type PERSONAL or BUSINESS" [docs:groups].
  - "Creating a group requires a minimum of one customerHayId but a list of customerHayIds can be passed in this request to include as many customers to the group as required. Once the group is created successfully the API will respond with the groupHayId" [docs:groups]. Empty `customerHayIds` → rejected; status code undefined (400 or 422) [docs:groups + open].
  - "There is currently no limit on the number of customers that can be added to a group." [docs:groups]
  - Customers must already exist ("Create customers A, B and C individually using Create Customer" precedes group creation in the example flow) [docs:groups]. Unknown customer id → error, status undefined [open].
  - Whether members must be `ACTIVE` at group-creation time is not stated; the ACTIVE requirement is documented only for account creation (see createHayAccountForGroup) [open].
  - `groupName` omitted → "a generic name associated with the client will be generated" [spec]; the generated value is undefined [open].
  - `idempotencyKey` is "used to recognise any subsequent retries" [spec] → a retry with the same key should return the same group rather than create a duplicate; exact replay semantics (same body required? conflict status?) undefined [inferred, open].
  - Whether `businessIdentifiers` are validated against `groupType = BUSINESS` is undefined [open].
  - Creates no account: the account is a separate step (createAccount with `accountHolderType = GROUP` or the deprecated createHayAccountForGroup) [docs:groups].
- **Webhooks:** none mentioned.

### GET /v0/groups/{groupHayId} (getHayJointAccountByGroupHayId)
- **Purpose:** "Get Account by Group ID" [spec]. Not deprecated.
- **Path params:** `groupHayId` — string uuid required, "Unique identifier (UUID) of the Group" [spec].
- **Request body:** none.
- **Response 200:** `HayJointAccount` — "Details of a joint or business account." [spec]:
  | field | type | description |
  |---|---|---|
  | `businessIdentifiers` | `BusinessIdentifiers` | see createHayGroup |
  | `customerHayIds` | array of string uuid | "Unique identifiers (UUID) of the Customer(s) associated to this Group" |
  | `groupHayId` | string uuid | "Unique identifier (UUID) of the Group" |
  | `groupType` | string enum `["PERSONAL","BUSINESS"]` | as above |
  | `hayAccount` | `HayAccount` | the group's account (see §2 for the one-level expansion; notable fields `accountHayId`, `accountHolderId` = groupHayId, `accountHolderType = GROUP`, `status`, `availableBalance`, `stacksBalance`, `totalBalance`) |
  | `name` | string | "Name of the Group, if not provided a generic name associated with the client will be generated" — **note: `name` here vs `groupName` on `HayGroup`** |
- **Behaviour:**
  - Read-only. Returns the group and its (single) account: "A group should have a single account." [docs:groups]
  - When the group has no account yet, the shape of `hayAccount` (absent / null) is undefined [open]. If more than one account was created for the group via createAccount, which is returned is undefined [open].
  - Unknown `groupHayId` → status undefined (no 404 declared) [open].
- **Webhooks:** none.

### PATCH /v0/groups/{groupHayId} (updateGroup)
- **Purpose:** "Update Group details" [spec]. Not deprecated.
- **Path params:** `groupHayId` — string uuid required [spec].
- **Request body:** `UpdateGroupRequestBody` (required) — "Describes the changes to be applied to Group record. Only the provided information will be updated. Business identifiers will be replaced as a whole (no partial updates are possible)." No required fields [spec].
  | field | type | required | constraints | description |
  |---|---|---|---|---|
  | `businessIdentifiers` | `BusinessIdentifiers` | no | replaced as a whole | see createHayGroup |
  | `groupName` | string | no | minLength 1, maxLength 100 | "Name of the Group" |
  | `groupType` | string enum `["PERSONAL","BUSINESS"]` | no | — | as above |
- **Response 200:** `HayGroup` (`businessIdentifiers`, `customerHayIds`, `groupHayId`, `groupName`, `groupType`) [spec].
- **Behaviour:**
  - Partial update: fields absent from the body are left unchanged; `businessIdentifiers`, when present, replaces the whole object (sub-fields omitted are cleared) [spec description].
  - Membership (`customerHayIds`) cannot be changed here — use addCustomersToGroup / removeCustomerFromGroup [spec: not in body].
  - Whether changing `groupType` after an account exists is allowed is undefined [open]. Whether `businessIdentifiers: null` clears is undefined [open].
- **Webhooks:** none mentioned.

### POST /v0/groups/{groupHayId}/account (createHayAccountForGroup)
- **Purpose:** "Create Account for Group - (To be DEPRECATED - Use POST /v1/accounts instead)" [spec]. **Deprecation:** flagged "To be DEPRECATED" in the summary; not marked `deprecated: true` in the spec. Replacement: `POST /v1/accounts` (createAccount) with `accountHolderType = "GROUP"` and `accountHolderId = groupHayId` [spec: CreateAccountRequestBody; docs:groups "To be used with accountHolderType = GROUP. Creating an account for a group requires the groupHayId to be provided."].
- **Path params:** `groupHayId` — string uuid required [spec].
- **Request body:** `CreateHayAccountForGroupRequestBody` (required) — "Body of a request to create an account owned by a group (joint or business account)" [spec]
  | field | type | required | constraints | description |
  |---|---|---|---|---|
  | `idempotencyKey` | string uuid | **yes** | — | "Unique value (UUID) used to identify this request and used to recognise any subsequent retries" |
  | `customData` | object, nullable | no | — | "Contains custom metadata stored with the Account" |
  No `productId`, `currency`, or `accountNumber` — contrast createAccount, which requires `productId` [spec].
- **Response 200:** `HayJointAccount` (see getHayJointAccountByGroupHayId) [spec].
- **Response 422** (`Unprocessable Entity`) — the only worked error example in this domain [spec]:
  ```json
  {"message":"PERMISSION_DENIED: Account cannot be created for group with id f64f41eb-41f4-4619-9fc4-68d292aeb0f9, all members of the group should have an ACTIVE status","details":"Please refer to the API documentation or contact Shaype for more info with the traceId.","status":"422","traceId":"b24daeb7-4242-4ff1-ba50-9825d5deedd8"}
  ```
  (example name "Not enough permissions").
- **Behaviour:**
  - Precondition: **every** member customer of the group has `status = ACTIVE`; otherwise 422 with the message above [spec example]. Consistent with "An account can only be opened if the customer is in `ACTIVE` status." [docs:customer-status-flow].
  - Creates a `HayAccount` with `accountHolderType = GROUP`, `accountHolderId = groupHayId` [spec HayAccount descriptions]; initial `status = APPROVED` ("Accounts created through this API are automatically set as APPROVED") [spec HayAccount.status]; balances 0 [inferred].
  - Which product / currency the account gets (no `productId` in body) is undefined — presumably a client default [open].
  - "A group should have a single account." [docs:groups] — whether a second call (different idempotencyKey) is rejected or creates a second account is undefined [open].
  - `idempotencyKey` replay → same account [spec description; inferred].
  - All members get equal, flat access: "Our Group Accounts have a flat structure so all customers linked to the account have the same access and their is no specified notion of a primary owner or main account holder." / "All parties linked to the account have the ability to request account closure without requiring consent from other account holders." [docs:groups]
- **Webhooks:** none stated. (An `ACCOUNT_STATUS_CHANGE` notification type exists [webhooks]; whether account creation emits one is not documented [open].)

### POST /v0/groups/{groupHayId}/addCustomers (addCustomersToGroup)
- **Purpose:** "Add Customers to Group" [spec]. Not deprecated.
- **Path params:** `groupHayId` — string uuid required [spec].
- **Request body:** `AddCustomersToGroupRequestBody` (required) — "Body of a request to add customers to an existing group" [spec]
  | field | type | required | constraints | description |
  |---|---|---|---|---|
  | `customerHayIds` | array of string uuid | **yes** | no `minItems` | "Unique identifiers (UUID) of the Customer(s) associated to this Group" |
- **Response 200:** `HayJointAccount` (group + its account) [spec].
- **Behaviour:**
  - "Once a group has a groupHayId assigned to it in the system it can have additional customers added to that group that will have immediate access to any accounts linked to that groupHayId." [docs:groups] → membership is appended; no re-approval step; the added customers can immediately create cards against the group account [docs:groups example flow, inferred].
  - "There is currently no limit on the number of customers that can be added to a group." [docs:groups]
  - Adding a customer who is already a member, an unknown customer, or a non-`ACTIVE` customer: outcomes undefined [open].
  - No idempotency key; the natural idempotent behaviour (set-union) is not stated [open].
- **Webhooks:** none mentioned.

### POST /v0/groups/{groupHayId}/removeCustomer (removeCustomerFromGroup)
- **Purpose:** "Remove a Customer from a Group" [spec]. Not deprecated.
- **Path params:** `groupHayId` — string uuid required [spec].
- **Request body:** `RemoveCustomerFromGroupRequestBody` (required) — "Body of a request to remove a customer from an existing group" [spec]
  | field | type | required | constraints | description |
  |---|---|---|---|---|
  | `customerId` | string uuid | **yes** | — | "Unique identifier (UUID) of the Customer associated to this Group" — **note: `customerId`, not `customerHayId`** |
- **Response 200:** `HayJointAccount` (group after removal + its account) [spec].
- **Behaviour** [docs:customer-removal unless noted]:
  - Precondition / rejection: "the system will validate if the group has one or more members remaining. If the customer is the group's final member, then the remove from group API will reject the request." → removing the last member fails; HTTP status not stated (422 most plausible given the rest of the domain) [open]. "When a group only has one member, that customer should remain associated with the group. Any accounts linked to that group should be closed via the close account API."
  - State change: `customerId` removed from `customerHayIds`.
  - Side effect 1 — card cancellation: "the Shaype system will search for any cards the customer holds that are issued against accounts held by the group and cancel them." (Cards domain: the customer's cards whose account is a group account → cancelled.)
  - Side effect 2 — customer status: "we will assess if that customer now meets our definition of a customer status **Inactive**. ... If the customer is linked only to accounts with a Closed status, then the customer is deemed Inactive, and their status is updated to reflect this." → after removal, if every account the customer is still linked to (own accounts + remaining group accounts) has `status = CLOSED` (a customer with no linked accounts at all is not explicitly covered [open]), set `HayCustomer.status = INACTIVE`.
  - Removing a customer who is not a member, or unknown ids: undefined [open].
  - Whether the removal is synchronous or the side effects are asynchronous (account closure's customer-status update is described as asynchronous in docs:account-closure) is not stated [open].
- **Webhooks:** none stated explicitly for this operation. By consequence of the side effects, the client may receive `CARD_STATUS_CHANGE` ("The status of a card has changed") and `CUSTOMER_STATUS_UPDATED` ("Customer's status has been updated") notifications, both defined in `NotificationDto.type` [webhooks] — [inferred].

## 2. Entities and fields

No `required` arrays exist on any response schema in this domain; nullability is never declared (`nullable` appears only on `CreateHayAccountForGroupRequestBody.customData` and the `type` query param) — treat every response field as optional/omittable [spec]. No examples exist in the spec for these schemas except the one 422 body on createHayAccountForGroup [spec].

### HayGroup — "Details of a Group" [spec]
| field | type | enum / constraints | description |
|---|---|---|---|
| `groupHayId` | string uuid | — | "Unique identifier (UUID) of the Group" |
| `groupName` | string | — | "Name of the Group, if not provided a generic name associated with the client will be generated" |
| `groupType` | string | `["PERSONAL","BUSINESS"]` | "BUSINESS: Non-individual / joint entity; PERSONAL: Joint account entity (default if no option selected)" |
| `customerHayIds` | array of string uuid | — | "Unique identifiers (UUID) of the Customer(s) associated to this Group" |
| `businessIdentifiers` | `BusinessIdentifiers` | — | "Identifiers issued by the government to the entity represented by this Group" |

Created by: createHayGroup. Read by: getHayJointAccountByGroupHayId (as `HayJointAccount`). Updated by: updateGroup (name/type/identifiers), addCustomersToGroup, removeCustomerFromGroup (membership). No delete/close operation exists for a group [spec]. No status field [spec].

### HayJointAccount — "Details of a joint or business account." [spec]
| field | type | enum | description |
|---|---|---|---|
| `groupHayId` | string uuid | — | "Unique identifier (UUID) of the Group" |
| `name` | string | — | "Name of the Group, ..." (same semantics as `HayGroup.groupName`; different property name) |
| `groupType` | string | `["PERSONAL","BUSINESS"]` | as HayGroup |
| `customerHayIds` | array of string uuid | — | as HayGroup |
| `businessIdentifiers` | `BusinessIdentifiers` | — | as HayGroup |
| `hayAccount` | `HayAccount` | — | the group's account |

Returned by: getHayJointAccountByGroupHayId, createHayAccountForGroup, addCustomersToGroup, removeCustomerFromGroup. It is a projection of Group + Account, not a separately stored entity [inferred].

### BusinessIdentifiers [spec]
| field | type | constraints | description |
|---|---|---|---|
| `businessNumber` | string | minLength 11, maxLength 11 | "Australian Business Number (ABN)" |
| `companyNumber` | string | minLength 9, maxLength 9 | "Australian Company Number (ACN)" |
| `registeredBodyNumber` | string | minLength 9, maxLength 9 | "Australian Registered Body Number (ARBN)" |
| `registeredSchemeNumber` | string | minLength 9, maxLength 9 | "Australian Registered Scheme Number (ARSN)" |
No required fields; no pattern (digits-only not enforced by schema) [spec]. Written by createHayGroup, updateGroup (whole-object replace).

### HayAccount (one-level expansion; owned by Accounts domain) — "Details of an account" [spec]
Only `customData` is required. Fields: `accountHayId` uuid; `accountHolderId` uuid "Unique identifier (UUID) of the account holder"; `accountHolderType` enum `["CUSTOMER","GROUP"]` ("CUSTOMER: The account holder is a Customer, accountHolderId contains a Customer ID; GROUP: The account holder is a Group, accountHolderId contains a Group ID"); `accountNumber` string "Account number, 5-9 digits in length"; `bsb` string "6 digits in length"; `currency` ISO-4217 enum; `productId` uuid; `parentAccountId` uuid nullable; `customData` object nullable; `status` enum `["PENDING_APPROVAL","APPROVED","ACTIVE","LOCKED","DORMANT","CLOSED","ACTIVE_IN_ARREARS"]`; `blockedBy` enum `["CLIENT","PLATFORM"]`; `creationDateTimeUtc`, `closedDateTimeUtc` date-time; balances (all number, 2dp): `availableBalance` ("Total balance available for use on Account. Funds that are held, locked and allocated to a Stack will not be available."), `heldBalance`, `lockedBalance`, `overdraftBalance`, `overdraftLimit`, `technicalOverdraftBalance`, **`stacksBalance`** ("Total value current held against any Stack(s) on the Account. Positive value to 2 decimal places."), `totalBalance` ("Total value of all funds on the Account (this amount will also include unused overdraft limit and Stacks, held and locked value)."); `homeCurrencyBalanceEquivalent` object (`availableBalance`, `currency`, `heldBalance`, `totalBalance` — its `totalBalance` also "including ... Stacks").

Touched by this domain: created by createHayAccountForGroup (holder type GROUP); `stacksBalance`/`availableBalance` moved by accountToStackTransfer, stackToAccountTransfer, closeStack; read via getHayJointAccountByGroupHayId.

### HayStack — "Details of a stack used to save or ring-fence money separately from the main account." [spec]
| field | type | enum / constraints | description |
|---|---|---|---|
| `stackHayId` | string uuid | — | "Unique identifier (UUID) of the Stack" |
| `accountHayId` | string uuid | — | "Unique identifier (UUID) of the Account" |
| `name` | string | 1..20 on write; unique per account; no emojis [docs:stack] | "Name of the Stack" |
| `imageUrl` | string | — | "URL of image representing the Stack goal embedded in app" |
| `targetAmount` | number | ≥ 0 on write; ≤ account "total limit" [docs:stack] | "Target balance value set on Stack" |
| `balance` | number | — | "Total balance available for use on Stack" |
| `status` | string | `["OPEN","CLOSED"]` | "OPEN: Stack is active and in use; CLOSED: Stack is inactive and can no longer be used" |
| `createdAtUtc` | string date-time | — | "DateTime in UTC format when the Stack was created" |
| `closedAtUtc` | string date-time | — | "DateTime in UTC format when the Stack was closed" |

Created by createStack (not returned). Read by getAllStacks, embedded in `HayStackTransaction.stack`. Updated by updateStack (name/imageUrl/targetAmount), accountToStackTransfer / stackToAccountTransfer / stackToStackTransfer (`balance`), closeStack (`status`, `closedAtUtc`, `balance`→0).

### Stack (alternate projection returned only by updateStack) [spec]
Same fields as HayStack but the identifier is **`hayId`** instead of `stackHayId`, and no descriptions: `accountHayId` uuid, `balance` number, `closedAtUtc` date-time, `createdAtUtc` date-time, `hayId` uuid, `imageUrl` string, `name` string, `status` enum `["OPEN","CLOSED"]`, `targetAmount` number. Implementer: serialise the same record under both shapes [inferred].

### HayStackTransaction — "Details of a stack transaction." [spec]
| field | type | enum | description |
|---|---|---|---|
| `hayId` | string uuid | — | "Unique identifier (UUID) of the Transaction" |
| `accountHayId` | string uuid | — | "Unique identifier (UUID) of the Account" |
| `stackHayId` | string uuid | — | "Unique identifier (UUID) of the Stack" |
| `stack` | `HayStack` | — | embedded stack snapshot/details |
| `amount` | number | — | "Value of the Transaction, to 2 decimal places" (sign convention not stated [open]) |
| `customerId` | string uuid | — | "Unique identifier (UUID) of the Customer (initiator of the transfer)" |
| `notes` | string | — | "Transaction description" (populated from request `description` [inferred]) |
| `counterpartTransactionId` | string uuid | — | "Unique identifier (UUID) of the counterpart transaction (Stack to Stack transactions)" |
| `originId` | string uuid | — | "Additional identifier applied to Transaction related to origin of the request" |
| `originType` | string | `["CUSTOMER","SCHEDULED_PAYMENT","HAAS_OPERATIONS","OPERATIONS","MANDATE_PAYMENT","DIRECT_DEBIT","TRANSACTION"]` | "CUSTOMER: Transaction initiated by a customer; SCHEDULED_PAYMENT: Transaction initiated by a schedule; HAAS_OPERATIONS: Transaction initiated by Client Operations team; OPERATIONS: Transaction initiated by Shaype Operations team; MANDATE_PAYMENT: Transaction initiated by mandate; DIRECT_DEBIT: Transaction initiated by direct debit; TRANSACTION: Transaction initiated by transaction" |
| `type` | string | `["STANDARD","ROUND_UP"]` | "STANDARD: Movement of fund to, from or between stacks triggered by customer or ops; ROUND_UP: Account to Stack transfer triggered by RoundUp functionality" |
| `transactionTimeUtc` | string date-time | — | "DateTime in UTC format when the Transaction was initiated" |

Created by accountToStackTransfer, stackToAccountTransfer (one each), stackToStackTransfer (two, cross-linked), possibly closeStack sweep [open], and the platform RoundUp feature (`ROUND_UP`, no API) [spec]. Read by getAllStackTransactions, getTransactionsForStack. Never updated or deleted [inferred; "soft deletion" keeps history — docs:stack].

### StackTransactionResponse — "Stack Transaction outcome details" [spec]
`outcome` enum `["ACCEPTED","INTERNAL_ERROR","REFUSED_INSUFFICIENT_FUNDS","UNKNOWN"]` ("Transaction outcome"); `transactionId` uuid ("Unique identifier (UUID) of the Transaction"). Returned by accountToStackTransfer, stackToAccountTransfer.

### StackToStackTransactionOutcome — "Stack to Stack Transaction outcome details" [spec]
`outcome` (same enum as above); `withdrawalTransactionId` uuid ("Withdrawal (source stack to account) Transaction"); `depositTransactionId` uuid ("Deposit (account to destination stack) Transaction"). Returned by stackToStackTransfer.

### UpdateStackResponse [spec]
`error` enum `["OPEN_STACKS_LIMIT_REACHED","TOTAL_STACKS_LIMIT_REACHED","STACK_NAME_ALREADY_IN_USE"]`; `stack` (`Stack`). Returned by updateStack.

### ErrorResponse — "An error response." [spec]
`details` string "Error details"; `message` string "Error description"; `status` string "HTTP response status"; `traceId` string "TraceID that can be used by HAY for troubleshooting the request". Example values [spec, createHayAccountForGroup 422]: `message` = `"PERMISSION_DENIED: Account cannot be created for group with id f64f41eb-41f4-4619-9fc4-68d292aeb0f9, all members of the group should have an ACTIVE status"`, `details` = `"Please refer to the API documentation or contact Shaype for more info with the traceId."`, `status` = `"422"` (a string), `traceId` = `"b24daeb7-4242-4ff1-ba50-9825d5deedd8"`.

### Cross-domain entities read/written here (for status enums see §3)
- `HayCustomer.status` enum `["ACTIVE","INACTIVE","REJECTED","BLOCKED","PENDING_APPROVAL","REFERRED"]` — read by createHayAccountForGroup (must be ACTIVE), written to `INACTIVE` by removeCustomerFromGroup [spec enum; docs:customer-removal].
- Cards: cancelled by removeCustomerFromGroup [docs:customer-removal]; card status enum lives in the Cards domain.
- `AccountBalancesDto` (webhook payload inside `TransactionEventDto.accountBalances`) has `stacksBalance: CurrencyAmount` alongside `totalBalance`, `heldBalance`, `lockedBalance`, `availableBalance` [webhooks].
- External authorisation `Account.balance`: "Balance of the Account immediately before this transaction was applied. Money held in stacks is not included" [ext-auth]; `AccountHolder.type` enum `["CUSTOMER","GROUP"]` with `id` = "the Group when type is GROUP"; `Customer` object "Set when the account holder is a customer, or when a group account transaction was triggered by one." [ext-auth].

## 3. State machines

### HayStack.status — `["OPEN","CLOSED"]` [spec]
| from | to | via | notes |
|---|---|---|---|
| (none) | `OPEN` | createStack | initial state [inferred from "This endpoint is used to close an open stack" — docs:stack] |
| `OPEN` | `CLOSED` | closeStack | sets `closedAtUtc`; sweeps `balance` to account [docs:stack] |
| `CLOSED` | — | — | **terminal**: "Closed stack can't be open again" [docs:stack] |

Only `OPEN` stacks may receive/send transfers or be updated [inferred; docs say CLOSED "can no longer be used" — spec enum description].

### HayGroup — no status enum [spec]
A group has no lifecycle state; the only mutable dimensions are membership (`customerHayIds`) and descriptive fields. There is no close/delete operation. Membership invariant: at least one member at all times (removal of the final member is rejected) [docs:customer-removal].

### Outcome enums (single-shot results, not state machines) [spec]
`StackTransactionResponse.outcome` / `StackToStackTransactionOutcome.outcome`: `["ACCEPTED","INTERNAL_ERROR","REFUSED_INSUFFICIENT_FUNDS","UNKNOWN"]`. A transfer is either applied (`ACCEPTED`) or not; no pending state exists for stack movements [inferred].

### Cross-domain transitions caused by this domain
| entity | from | to | via | condition |
|---|---|---|---|---|
| `HayCustomer.status` | `ACTIVE` (or any non-INACTIVE) | `INACTIVE` | removeCustomerFromGroup | after removal the customer "is linked only to accounts with a Closed status" [docs:customer-removal] |
| `HayAccount.status` | (none) | `APPROVED` | createHayAccountForGroup | "Accounts created through this API are automatically set as APPROVED" [spec HayAccount.status]; later `APPROVED → ACTIVE` happens on first transaction [docs:account-status] — whether a stack transfer counts as that first "deposit or withdrawal" is undefined [open] |
| Card status | (active states) | cancelled | removeCustomerFromGroup | for cards the customer holds on accounts held by the group [docs:customer-removal] |

Customer status values for reference [spec HayCustomer.status]: `ACTIVE` "Customer is active", `BLOCKED` "Customer is blocked", `INACTIVE` "Customer is not active (closed)", `PENDING_APPROVAL` "Customer is awaiting approval", `REFERRED` "Customer is referred for further KYC checks", `REJECTED` "Customer has been rejected". Account status values [spec HayAccount.status]: `PENDING_APPROVAL`, `APPROVED`, `ACTIVE`, `LOCKED`, `DORMANT`, `CLOSED`, `ACTIVE_IN_ARREARS` (`CLOSED` "is a final status" [docs:account-status]).

## 4. Invariants and calculations

### Account balance decomposition (docs:account-balances, verbatim formulas)
- "**Available Balance** = Account Balance + (Overdraft Limit + Overdraft Balance) + Technical Overdraft Balance + Held Balance + Stacks balance" — where in that doc Held, Overdraft Balance, Technical Overdraft are "$0 or Negative" and Stack Balance is "$0 or Positive" but is being subtracted in effect ("Total balance of stacks within an account"). Read together with the spec: `availableBalance` = "Total balance available for use on Account. Funds that are held, locked and allocated to a Stack will not be available." [spec HayAccount].
- "**Total Balance** = Total Available Balance + (Overdraft Limit + Overdraft Balance) + Technical Overdraft Balance + Stacks Balance" [docs:account-balances]; spec: `totalBalance` "will also include unused overdraft limit and Stacks, held and locked value" [spec].
- Practical invariant for the local implementation [inferred from the above]: `availableBalance = totalBalance - stacksBalance - heldBalance - lockedBalance (± overdraft terms)`; a stack transfer changes `stacksBalance` and `availableBalance` by equal and opposite amounts and leaves `totalBalance` unchanged.
- `stacksBalance` = "Total value current held against any Stack(s) on the Account. Positive value to 2 decimal places." [spec] = sum of `balance` over the account's stacks [inferred]; since CLOSED stacks have balance 0 after the sweep, sum over OPEN stacks is equivalent [inferred].
- Webhook `TransactionEventDto.accountBalances.stacksBalance` (CurrencyAmount) carries the same figure in transaction notifications [webhooks].
- External-authorisation callbacks present `account.balance` **excluding** stack money: "Money held in stacks is not included" [ext-auth].

### Stack balance rules
- Stack `balance` ≥ 0 at all times: transfers out beyond the balance yield `REFUSED_INSUFFICIENT_FUNDS` [spec enum; inferred].
- Card transactions and outbound payments never draw down stacks: "Any Card transactions and Outbound payments (NPP, DE, BPAY, Internal transfer) are linked solely to the main transactional account and its balance. Therefore, if a transaction is attempted by a customer where insufficient balance is present on their main transactional account, this transaction will fail due to insufficient balance being available. No drawdown will occur from the various Stacks that may hold balance." [docs:stack]
- Stack funds count toward the account maximum: "Any funds that reside in a Stack will form part of the total account's max balance limit." [docs:stack] (limit type `MAX_BALANCE` "Maximum balance that can be held in Account" [spec]).
- Stack movements are exempt from daily transfer limits: "Any internal cash transfers within an account that involve a Stack will not form part of the daily transfer limits, these include: Available Balance to Stack or Stack to Stack" [docs:stack].
- `MIN_STACK_BALANCE` — "Minimum balance that can be held in Stack (Shaype use only)" [spec limitType enum; docs:account-limits] — exists as a platform-set limit; not client-settable (absent from setAccountLimit's enum, present in deleteAccountLimit's) [spec]. Enforcement point undefined [open].
- `targetAmount` is informational (a goal); nothing in spec/docs says reaching it changes state or blocks further deposits [inferred]. Constraint: ≥ 0 [spec] and "up to the total limit applied to the account" [docs:stack].

### Stack-to-stack accounting
- One request → two `HayStackTransaction` records (withdrawal from source stack, deposit to destination stack), ids returned as `withdrawalTransactionId` / `depositTransactionId`, mutually referenced via `counterpartTransactionId` [spec descriptions]. Amount must be > 0 (`exclusiveMinimum`) [spec]. Whether an all-or-nothing guarantee is enforced when the second leg fails is undefined (`INTERNAL_ERROR` / `UNKNOWN` outcomes exist) [open].

### Names, limits, counters
- Stack `name`: 1–20 chars [spec], unique within the account [docs:stack], no emojis [docs:stack]. Error token `STACK_NAME_ALREADY_IN_USE` [spec].
- Stack count limits: error tokens `OPEN_STACKS_LIMIT_REACHED`, `TOTAL_STACKS_LIMIT_REACHED` [spec] vs "as many stacks as you like" [docs:stack]; values undefined [open].
- Group membership: ≥ 1 member always [docs:groups, docs:customer-removal]; no upper bound [docs:groups]. "A group should have a single account." [docs:groups].
- `description` on all three transfer bodies: 0–20 chars; `groupName` on update: 1–100 chars; `BusinessIdentifiers`: ABN exactly 11 chars, ACN/ARBN/ARSN exactly 9 chars [spec].

### Account closure interaction
- `ClosureCheckerError.type` enum includes `ACCOUNT_BALANCE_STACKS` (alongside `ACCOUNT_BALANCE_TOTAL`, `ACCOUNT_BALANCE_HELD`, `ACCOUNT_BALANCE_LOCKED`, `ACCOUNT_BALANCE_OVERDRAFT`, `ACCOUNT_BALANCE_TECHNICAL_OVERDRAFT`, `INFLIGHT_OUTBOUND_DIRECT_DEBITS`, `CHILD_ACCOUNT_STATUS`) [spec, CloseAccountResponse] → closeAccount is refused while stacks hold a balance; the client must empty/close stacks first [inferred from enum name; docs:account-closure lists only the total/held/direct-debit checks in prose]. Error message pattern from the doc's examples: `"Account has 17.78 held balance."` / `"Account has 17.78 total balance."` [docs:account-closure] — the stacks variant's wording is not shown [open].

### ID and date formats
- All identifiers: UUID strings (`groupHayId`, `customerHayId(s)`/`customerId`, `accountHayId`/`accountId`, `stackHayId`/`stackId`/`hayId`, transaction ids, `idempotencyKey`) [spec].
- Timestamps: RFC 3339 `date-time`, UTC (`createdAtUtc`, `closedAtUtc`, `transactionTimeUtc`) [spec].
- Amounts: JSON numbers with 2 decimal places; `targetAmount` on create is `format: double` [spec].
- Idempotency: only createHayGroup and createHayAccountForGroup carry `idempotencyKey`; no stack operation has one [spec].

## 5. Cross-domain dependencies

| this domain | depends on / affects | how | source |
|---|---|---|---|
| createHayGroup, addCustomersToGroup | Customers API | members must be existing customers (created via createHayCustomer first) | docs:groups example flow |
| createHayAccountForGroup | Customers API | all members must have `status = ACTIVE` else 422 `PERMISSION_DENIED: ...` | spec 422 example; docs:customer-status-flow |
| createHayAccountForGroup | Accounts API | creates a `HayAccount` (`accountHolderType = GROUP`, `accountHolderId = groupHayId`, `status = APPROVED`); superseded by createAccount `POST /v1/accounts` with `accountHolderType = "GROUP"` (which additionally requires `productId`) | spec |
| getHayJointAccountByGroupHayId | Accounts API | embeds the group's `HayAccount` | spec |
| removeCustomerFromGroup | Cards API | cancels the customer's cards issued against group-held accounts | docs:customer-removal |
| removeCustomerFromGroup | Customers API | sets customer `INACTIVE` when only CLOSED accounts remain linked | docs:customer-removal |
| Group accounts | Cards API | "A card must belong to an individual customer and linked to the group account." Any member may create a card on the group account via createHayCard with the group account's `accountId`; multiple cards per group account; "All group account members have the same level of access to the account via their card." | docs:groups |
| Group accounts | Accounts API (closeAccount) | any member may request closure; a single remaining member closes accounts via closeAccount rather than being removed | docs:groups; docs:customer-removal |
| All stack ops | Accounts API | stacks belong to exactly one account; every stack path is nested under `/v0/accounts/{accountId}`; account status gating (LOCKED "will block all transactions and transfers") | spec; docs:stack; docs:account-status |
| Stack transfers | Accounts API balances | move value between `availableBalance` and `stacksBalance`; `totalBalance` invariant | spec HayAccount; docs:account-balances |
| Stacks | Accounts API (closeAccount) | `ACCOUNT_BALANCE_STACKS` closure-check error | spec ClosureCheckerError |
| Stacks | Limits (setAccountLimit/deleteAccountLimit) | `MAX_BALANCE` includes stack funds; `MIN_STACK_BALANCE` platform-only limit; daily transfer limits exclude stack movements | docs:stack; spec limitType enums |
| Stacks | Transactions API / webhooks | stack transactions have their own list endpoints and schema (`HayStackTransaction`), distinct from `HayTransaction`; webhook `TransactionEventDto.transactionType` has no stack value; `accountBalances.stacksBalance` is reported on transaction events | spec; webhooks |
| Stacks | External authorisation | callback `account.balance` excludes stack money, so a client authoriser never sees stack funds as spendable | ext-auth |
| Stacks | Payments (NPP/DE/BPAY/internal), Cards | never draw from stacks; insufficient main balance fails the payment | docs:stack |
| Group accounts | External authorisation | `account.holder.type = GROUP`, `holder.id = groupHayId`; `customer` set to the initiating member when "a group account transaction was triggered by one" | ext-auth |

## 6. Error catalogue

Declared per operation (all 15): `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content`/`Unprocessable Entity`, `500 Internal Server Error`, `501 Not Implemented`, body `ErrorResponse` [spec]. No 404/409 anywhere in this domain [spec].

| condition | status | message / token | source |
|---|---|---|---|
| createHayAccountForGroup: a group member is not `ACTIVE` | 422 | `PERMISSION_DENIED: Account cannot be created for group with id <groupHayId>, all members of the group should have an ACTIVE status`; `details`: `Please refer to the API documentation or contact Shaype for more info with the traceId.`; `status`: `"422"`; `traceId`: uuid | spec example |
| removeCustomerFromGroup: customer is the group's final member | undefined (422 plausible) | not shown — "the remove from group API will reject the request" | docs:customer-removal; status [inferred] |
| createHayGroup: empty `customerHayIds` | undefined (400/422) | not shown — "requires a minimum of one customerHayId" | docs:groups |
| createStack / updateStack: duplicate stack name on the account | updateStack: 200 with `error = STACK_NAME_ALREADY_IN_USE` [inferred from schema]; createStack: undefined | `STACK_NAME_ALREADY_IN_USE` | spec enum; docs:stack |
| createStack: emoji in name | undefined | not shown — "Stack names cannot contain emojis" | docs:stack |
| createStack: `name` length outside 1..20; `targetAmount` < 0 | undefined (400 plausible) | — | spec constraints |
| createStack: too many open / total stacks | undefined (tokens exist only on UpdateStackResponse) | `OPEN_STACKS_LIMIT_REACHED`, `TOTAL_STACKS_LIMIT_REACHED` | spec enum |
| accountToStackTransfer: `availableBalance` < amount | 200 | `outcome = REFUSED_INSUFFICIENT_FUNDS` | spec enum; 200 mapping [inferred] |
| stackToAccountTransfer: stack `balance` < amount | 200 | `outcome = REFUSED_INSUFFICIENT_FUNDS` | spec enum; [inferred] |
| stackToStackTransfer: source stack `balance` < amount | 200 | `outcome = REFUSED_INSUFFICIENT_FUNDS` | spec enum; [inferred] |
| any transfer: platform failure | 200 | `outcome = INTERNAL_ERROR` or `UNKNOWN` | spec enum |
| stackToStackTransfer: `amount` ≤ 0 | undefined (400 plausible) | — | spec `exclusiveMinimum` |
| any transfer: `description` > 20 chars | undefined (400 plausible) | — | spec |
| getAllStackTransactions / getTransactionsForStack: `limit` not in 1..1000, missing `offset`/`limit` | undefined (400 plausible) | — | spec description |
| updateGroup: `groupName` outside 1..100; `BusinessIdentifiers` field wrong length | undefined (400 plausible) | — | spec |
| closeAccount on an account whose stacks hold funds | 422 (CloseAccountResponse) | `errors[].type = ACCOUNT_BALANCE_STACKS`, `result = FAILURE`; message wording not shown | spec; docs:account-closure pattern |
| unknown `accountId` / `stackId` / `groupHayId` / `customerId` | undefined (no 404 declared) | — | spec |
| stack operation on a `CLOSED` stack (update/transfer/close again) | undefined | — | docs:stack "can no longer be used" |
| stack transfer on `LOCKED`/`CLOSED` account | undefined | — | docs:account-status [inferred] |

## 7. Open questions

1. **createStack returns a bare boolean** — the new `stackHayId` is not returned. Decide: return `true` and require getAllStacks, or (deviating from spec) also expose the id elsewhere. Recommend strict spec behaviour (`true`) so integrators' code paths match production.
2. **HTTP status for validation failures**: nothing distinguishes 400 vs 422 except the single ACTIVE-members example (422). Decide a consistent rule (e.g. schema/shape → 400, business rule → 422) and document it as a local convention.
3. **Not-found handling**: no 404 is declared for any op. Pick 400 or 422 (with an `ErrorResponse`) for unknown account/stack/group/customer ids.
4. **Duplicate / emoji stack names on createStack**: HTTP status and whether the `STACK_NAME_ALREADY_IN_USE` token appears in `ErrorResponse.message`. Also whether uniqueness considers CLOSED stacks.
5. **updateStack error channel**: is `UpdateStackResponse.error` returned with HTTP 200 (and `stack` omitted), or alongside a 4xx? Schema placement suggests 200.
6. **Stack count limits**: values behind `OPEN_STACKS_LIMIT_REACHED` / `TOTAL_STACKS_LIMIT_REACHED`, and whether they apply at all ("as many stacks as you like"). Suggest configurable, default unlimited.
7. **closeStack sweep transaction**: does closing a funded stack create a `HayStackTransaction` (STANDARD, stack → account)? What `customerId`/`originType` would it carry (no body on closeStack)?
8. **Repeat closeStack / update or transfer on CLOSED stack**: error vs no-op.
9. **Transfer outcomes as 200 vs 4xx**: `REFUSED_INSUFFICIENT_FUNDS` is modelled as a 200 outcome; confirm no 422 is used for refusals.
10. **Sign convention of `HayStackTransaction.amount`** (positive for both legs vs signed by direction) and sort order of the transaction list endpoints; pagination beyond `offset`/`limit` (no total count field).
11. **Does a stack transfer flip the account from `APPROVED` to `ACTIVE`** ("Once deposit or withdrawal happens account automatically changes status to Active")?
12. **Overdraft into stacks**: can `accountToStackTransfer` use overdraft funds (availableBalance includes overdraft limit)?
13. **`MIN_STACK_BALANCE`** enforcement: where and how (stackToAccountTransfer? closeStack?).
14. **createHayGroup with zero members / unknown customer / non-ACTIVE customer**: which fail, with what status.
15. **createHayGroup `idempotencyKey` replay**: same-key-different-body behaviour; whether replay returns 200 with the original group.
16. **Generated `groupName`** when omitted: format of "a generic name associated with the client".
17. **`HayJointAccount.hayAccount` when the group has no account** (omit vs null) and when several accounts exist (createAccount can be called repeatedly with the same GROUP holder — is "A group should have a single account" enforced?).
18. **createHayAccountForGroup product/currency**: no `productId` in the body — which product does the account get? Mark deprecated in the local server and route to createAccount semantics with a default product?
19. **addCustomersToGroup**: duplicates (ignore vs error), unknown ids, non-ACTIVE customers; empty array.
20. **removeCustomerFromGroup**: status for last-member rejection; non-member `customerId`; whether the INACTIVE assessment treats "no linked accounts at all" as inactive; synchronous vs asynchronous card cancellation and status update; which card statuses count as "cancel".
21. **Webhooks**: no event is documented for any group/stack operation. Decide whether the local server emits `CARD_STATUS_CHANGE` / `CUSTOMER_STATUS_UPDATED` for removeCustomerFromGroup side effects, `ACCOUNT_STATUS_CHANGE` on group-account creation, and whether stack transfers produce any `TRANSACTION` notification (the webhook `transactionType` enum has no stack value — suggests none).
22. **Do stack transactions appear in the main account transaction list** (`HayTransaction`)? "Historical transactions will still be visible within transaction list" is ambiguous between the stack transaction endpoints and the account-level list.
23. **`updateGroup` semantics** for `businessIdentifiers: null` / `{}` (clear vs ignore) and changing `groupType` once an account exists.
24. **`ROUND_UP` transactions**: no API creates them; decide whether the local server needs a test hook to seed them.
25. **`Stack` vs `HayStack` shape**: updateStack returns `hayId`; everything else returns `stackHayId`. Confirm both shapes are served verbatim.
