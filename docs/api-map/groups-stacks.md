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
