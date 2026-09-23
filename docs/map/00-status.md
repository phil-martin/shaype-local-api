# 00 — Status enums, transitions and cross-domain preconditions

Consistency pass over `customers.md`, `accounts.md`, `cards.md`, `payid-npp.md`, `payto.md`, `transactions-holds.md`, `kyc.md`, `groups-stacks.md`.
Every enum in §A was re-verified with `jq` against `b2b-operations-api.json` (B2B spec) or `notification-webhooks.json` (webhook spec); the exact jq path is given per row.

Source labels: `[spec]` B2B OpenAPI · `[webhook-spec]` notification-webhooks.json · `[docs:<slug>]` developer.shaype.com/docs/<slug>.md · `[map:<key>]` one of the eight domain maps · `[inferred]` reasoning, not stated anywhere · `[decision]` recommended default for the local implementation · `[open]` nobody can settle it from the sources.

---

## A. Status enums — one canonical list per entity

### A.1 Cross-check matrix

| entity | canonical enum (spec) | customers | accounts | cards | payid-npp | payto | transactions-holds | kyc | groups-stacks |
|---|---|---|---|---|---|---|---|---|---|
| Customer `status` | 6 values (A.2) | ✓ | ✓ (subset used) | – | – | – | – | ✓ | ✓ |
| Account `status` | 7 values (A.3) | ✓ | ✓ | – | ✓ | ✓ | ✓ (`LOCKED` = blocked) | – | ✓ |
| Card `cardStatus` | 5 values (A.4) | ✓ | ✓ | ✓ | – | – | – | – | – |
| PayID `status` | 4 values (A.5) | – | – | – | ✓ | – | – | – | – |
| Mandate `status` | 4 values (A.6) | – | – | – | – | ✓ | – | – | – |
| Hold | **no enum** (A.7) | – | – | – | – | – | ✓ (internal states, `[inferred]`) | – | – |
| Stack `status` | 2 values (A.8) | – | – | – | – | – | – | – | ✓ |
| Group | **no enum** (A.9) | – | – | – | – | – | – | – | ✓ |
| KYC / onboarding | **no customer-level enum** (A.10) | ✓ | – | – | – | – | – | ✓ | – |

**Result: no map lists a different value set for any entity.** Every divergence found is between the *sources* (spec vs webhook-spec vs docs), not between maps — see §D. Two maps differ only in an `[inferred]` target state (§D-5).

### A.2 Customer — `HayCustomer.status`

`ACTIVE`, `INACTIVE`, `REJECTED`, `BLOCKED`, `PENDING_APPROVAL`, `REFERRED` [spec]

- jq: `jq '.components.schemas.HayCustomer.properties.status.enum' b2b-operations-api.json`
- Identical sets: `ChangeHayCustomerStatusRequestBody.properties.newStatus.enum`, `SearchCustomersRequestBody.properties.status.enum` [spec]; `CustomerStatusUpdatedEventDto.properties.customerStatus.enum` [webhook-spec] (`jq '.components.schemas.CustomerStatusUpdatedEventDto.properties.customerStatus.enum' notification-webhooks.json`).
- Spec-internal quirk: the `newStatus` *description* lists only five values ("Allowed Customer status") and omits `BLOCKED`, while its `enum` carries all six [spec]. `[map:customers]` §7 item 2 already records this.
- Glosses [spec]: ACTIVE "Customer is active"; BLOCKED "Customer is blocked"; INACTIVE "Customer is not active (closed)"; PENDING_APPROVAL "Customer is awaiting approval"; REFERRED "Customer is referred for further KYC checks"; REJECTED "Customer has been rejected".
- Companion enums [spec]: `statusReason` = `SUSPICIOUS`, `DECEASED`, `CUSTOMER`, `OPERATIONAL` (jq `.components.schemas.HayCustomer.properties.statusReason.enum`; same set as `CloseAccountRequestBody.properties.reason.enum`); `blockedBy` = `CLIENT`, `PLATFORM`.
- Maps checked: customers ✓, kyc ✓, groups-stacks ✓ (quotes the six with glosses), accounts ✓ (uses `ACTIVE`/`BLOCKED`/`INACTIVE` only, as effects).

### A.3 Account — `HayAccount.status`

`PENDING_APPROVAL`, `APPROVED`, `ACTIVE`, `LOCKED`, `DORMANT`, `CLOSED`, `ACTIVE_IN_ARREARS` [spec]

- jq: `jq '.components.schemas.HayAccount.properties.status.enum' b2b-operations-api.json`
- Webhook set **differs**: `AccountStatusChangeEventDto.properties.accountStatus.enum` = `ACTIVE`, `BLOCKED`, `PENDING_APPROVAL`, `APPROVED`, `DORMANT`, `CLOSED`, `ACTIVE_IN_ARREARS` [webhook-spec] (jq `.components.schemas.AccountStatusChangeEventDto.properties.accountStatus.enum`). `BLOCKED` replaces `LOCKED`; the webhook description additionally omits `DORMANT` from its bullet list while the enum has it. → §D-2.
- Docs table [docs:account-status] describes only `APPROVED`, `ACTIVE`, `ACTIVE_IN_ARREARS`, `LOCKED`, `CLOSED` (no `PENDING_APPROVAL`, no `DORMANT`).
- Glosses [spec]: PENDING_APPROVAL "Account is created but not yet approved (Note: Accounts created through this API are automatically set as APPROVED)"; APPROVED "Account is approved and ready for use"; ACTIVE "Account is approved and has had a transactional action performed on it"; LOCKED "Account is blocked"; DORMANT "Account is dormant due to inactivity on Account for a specific period of time"; CLOSED "Account is closed"; ACTIVE_IN_ARREARS "Account balance is in a negative position beyond the total deposits / overdraft limit on the Account".
- Companion enums [spec]: `blockedBy` = `CLIENT`, `PLATFORM`; `BlockAccountRequestBody.accountBlockStyle` = `ACCOUNT_ONLY`, `ACCOUNT_AND_CUSTOMER`; risk level = `LOW`, `HIGH` (`ChangeHayAccountRiskLevelRequestBody.level`); `CloseAccountResponse.result` = `SUCCESS`, `FAILURE`; `ClosureCheckerError.type` = `ACCOUNT_BALANCE_TOTAL`, `ACCOUNT_BALANCE_STACKS`, `ACCOUNT_BALANCE_HELD`, `ACCOUNT_BALANCE_LOCKED`, `ACCOUNT_BALANCE_OVERDRAFT`, `ACCOUNT_BALANCE_TECHNICAL_OVERDRAFT`, `INFLIGHT_OUTBOUND_DIRECT_DEBITS`, `CHILD_ACCOUNT_STATUS`.
- Maps checked: accounts ✓ (and records the webhook `BLOCKED` mapping), customers ✓, payid-npp ✓, payto ✓, groups-stacks ✓, transactions-holds ✓ ("account blocked (LOCKED)"). None uses `BLOCKED` as a stored account status.

### A.4 Card — `HayCard.cardStatus`

`ACTIVE`, `AWAITING_ACTIVATION`, `BLOCKED`, `INACTIVE`, `EXPIRED` [spec]

- jq: `jq '.components.schemas.HayCard.properties.cardStatus.enum' b2b-operations-api.json`
- Webhook: `CardStatusChangeEventDto.properties.cardStatus.enum` = same five values, order `ACTIVE, BLOCKED, EXPIRED, INACTIVE, AWAITING_ACTIVATION` [webhook-spec].
- Glosses [spec]: ACTIVE "Card is active and available for use"; AWAITING_ACTIVATION "Card is yet to be activated and unable to be used"; BLOCKED "Card has been blocked"; EXPIRED "Card has expired"; INACTIVE "Card has been cancelled / voided and can no longer be used".
- Companion states [spec]: `cardType` = `PHYSICAL`, `VIRTUAL`; `blockedBy` = `CLIENT`, `PLATFORM`; `CardPinStatus.enabled` boolean ("False indicates the Card PIN is blocked"); `CardCvvStatus.cvvRemainingTries` integer ("When the number reaches 0, the CVV is blocked"); `CardRewardsStatusBody.status` = `ACTIVE` only; preferences `cardEnabled` boolean ("freeze", not a `cardStatus`) [docs:card-lifecycle-stauts].
- Maps checked: cards ✓, accounts ✓ (§2 HayCard note), customers ✓.

### A.5 PayID — `PayIdDetailsResponse.status`

`ACTIVE`, `DEREGISTERED`, `DISABLED`, `PORTABLE` [spec]

- jq: `jq '.components.schemas.PayIdDetailsResponse.properties.status.enum' b2b-operations-api.json`; identical `UpdatePayIdStatusRequestBody.properties.payIdStatus.enum`.
- Glosses [spec]: ACTIVE "Activate PayID to allow it to be used"; DISABLED "Disable PayID and prevent it from being used or transferred"; DEREGISTERED "De-register PayID from current Account"; PORTABLE "Place PayID in transferable state allowing it to be registered to a different Account while still being used".
- Companion enum [spec]: `reason` = `FROD`, `CUST`, `DECD`, `LEGL`, `PART`.
- No webhook event type exists for PayID [webhook-spec `NotificationDto.type`].
- Maps checked: payid-npp ✓ (also names the NPP diagram's pseudo-states "Initial"/"Archived", which the API never returns).

### A.6 Mandate (PayTo) — `GetMandateResponseBody.status`

`CREATED`, `ACTIVE`, `SUSPENDED`, `CANCELLED` [spec]

- jq: `jq '.components.schemas.GetMandateResponseBody.properties.status.enum' b2b-operations-api.json`; identical `GetMandateSummaryDto.properties.status.enum`.
- Companion enums [spec]: `GetMandateActionsActionDto.status` = `COMPLETED`, `DECLINED`, `PENDING`, `RECALLED`, `TIMED_OUT`; `…CxExtensionDto.cxMandateStatus` = `ACTION_REQUIRED`, `ACTIVE_TRANSFER_INITIATED`, `PAUSED_TRANSFER_INITIATED`, `TRANSFERRED`, `ACTIVE`, `PAUSED_BY_PAYMENT_INITIATOR`, `PAUSED_BY_CUSTOMER`, `PAUSED_BY_PAYER_INSTITUTION`, `CANCELLED_AUTHORISATION_TIMED_OUT`, `CANCELLED_BY_PAYMENT_INITIATOR`, `CANCELLED`; `PaymentInstruction.transactionStatus` (= `GetMandatePaymentStatusResponseBody`, `MakeAdhocPaymentResponseBody`) = `RECEIVED`, `UNDELIVERED`, `SENT`, `STORE_AND_FORWARD`, `ACCEPTED_FOR_CLEARANCE`, `SETTLEMENT_ABORTED`, `ACCEPTED_AND_SETTLED`, `REJECTED`, `PENDING`; `PaymentInstructionSummary.transactionStatus` (MMS codes) = `RECV`, `UNDV`, `SENT`, `SAFD`, `ACCP`, `ACSP`, `ACSC`, `RJCT` (8 codes — no code for `PENDING`).
- Webhook: `MandatePaymentEventDto.paymentStatus` = `MANDATE_PAYMENT_ACCEPTED`, `…_ACCEPTED_FOR_CLEARANCE`, `…_PENDING`, `…_RECEIVED`, `…_REJECTED`, `…_SENT`, `…_SETTLEMENT_ABORTED`, `…_STORE_AND_FORWARD`, `…_UNDELIVERED` [webhook-spec]; no mandate-status enum on `MandateEventDto` (only `trigger`).
- Maps checked: payto ✓ for all of the above (including the missing MMS code for `PENDING`).

### A.7 Authorisation hold — **no status field**

- `AuthorisationHold` has no `status`/`state` property [spec]: jq `jq '.components.schemas.AuthorisationHold.properties | keys' b2b-operations-api.json` → `accountHayId, cardId, category, currencyAmount, customerId, description, holdHayId, merchantDetails, originalCurrencyAmount, transactionChannel, transactionTimeUtc, type`.
- Observable lifecycle only via webhooks: `TransactionEventDto.isPending` boolean + `transactionType` ∈ {`CARD_TRANSACTION`, `CARD_TRANSACTION_REFUND`, `CARD_TRANSACTION_SETTLED`} [webhook-spec][docs:card-transactions].
- `[map:transactions-holds]` §3.1 defines internal states `AUTHORISED`, `SETTLED`, `REVERSED`, `CANCELLED` `[inferred]` — legitimate, clearly labelled, and no other map claims a hold status.

### A.8 Stack — `HayStack.status`

`OPEN`, `CLOSED` [spec]

- jq: `jq '.components.schemas.HayStack.properties.status.enum' b2b-operations-api.json`; identical `Stack.properties.status.enum`.
- Glosses [spec]: OPEN "Stack is active and in use"; CLOSED "Stack is inactive and can no longer be used".
- Companion: `StackTransactionResponse.outcome` = `ACCEPTED`, `INTERNAL_ERROR`, `REFUSED_INSUFFICIENT_FUNDS`, `UNKNOWN` [spec]; `UpdateStackResponse.error` tokens `STACK_NAME_ALREADY_IN_USE`, `OPEN_STACKS_LIMIT_REACHED`, `TOTAL_STACKS_LIMIT_REACHED` [map:groups-stacks].
- Maps checked: groups-stacks ✓.

### A.9 Group — **no status field**

- `HayGroup.properties` = `businessIdentifiers, customerHayIds, groupHayId, groupName, groupType` [spec]; jq `jq '.components.schemas.HayGroup.properties | keys' b2b-operations-api.json`. Only `groupType` = `PERSONAL`, `BUSINESS` is an enum.
- Maps checked: groups-stacks ✓ ("no status enum").

### A.10 KYC / onboarding — **no customer-level onboarding enum**; progress is expressed through `HayCustomer.status`

- `ExternalCase.outcome` = `NOT_EXECUTED`, `REJECTED`, `WARNING`, `PASSED` [spec]; jq `jq '.components.schemas.ExternalCase.properties.outcome.enum' b2b-operations-api.json`.
- `OnboardingStageApprovalBody` has only `comments` [spec]; the three `approve*Check` ops return `ConfirmationResponse` with no status [spec].
- Webhook: `OnboardingFailedEventDto.state` = `DOCUMENT_SCAN`, `SANCTIONS_SCAN`, `KYC_AML_SCAN`, `DUPLICATE_CHECK` [webhook-spec] (jq `.components.schemas.OnboardingFailedEventDto.properties.state.enum`); event types `ONBOARDING_PASSED`, `ONBOARDING_FAILED` in `NotificationDto.type`.
- Onboarding-related customer statuses: `PENDING_APPROVAL` → `ACTIVE` | `REFERRED` | `REJECTED` [docs:customer-status-flow].
- Maps checked: kyc ✓, customers ✓ (both list the same sets; kyc additionally models a per-stage pending/passed/failed/approved result, explicitly `[inferred]`).

---

## B. Transition tables

Format: `from | to | via operation or event | source`. Operation names are spec `operationId`s (all confirmed present in `ops.json`). Side effects caused by *other* domains are included so each table is complete for its entity.

### B.1 Customer `status`

| from | to | via operation or event | source |
|---|---|---|---|
| (none) | `PENDING_APPROVAL` | `createHayCustomer` (`POST /v0/customers/create`) | [docs:customer-creation-1] "The default the customer status would be `PENDING_APPROVAL`"; [docs:sample-requests-responses] create response `"status": "PENDING_APPROVAL"` |
| `PENDING_APPROVAL` | `ACTIVE` | platform: all Shaype-KYC stages pass → webhooks `ONBOARDING_PASSED` + `CUSTOMER_STATUS_UPDATED` | [docs:customer-creation-1] "The customer will become active automatically when the KYC is successful" |
| `PENDING_APPROVAL` | `ACTIVE` | `changeHayCustomerStatus {newStatus: ACTIVE}` (client-side KYC) | [docs:customer-creation-1] "If you are not using Shaype KYC, you will need to manually update the customer status to `ACTIVE`" |
| `PENDING_APPROVAL` | `REFERRED` | platform: a KYC stage fails → `ONBOARDING_FAILED {state}` | [docs:customer-status-flow] target gloss; from-state `[inferred]` — [map:customers] and [map:kyc] agree |
| `PENDING_APPROVAL` | `REJECTED` | platform: onboarding concluded negatively | [docs:customer-status-flow]; from-state `[inferred]` |
| `PENDING_APPROVAL` | withdrawn | client, `changeHayCustomerStatus` | [docs:customer-status-flow] "It can be 'Withdrawn' by the client at this stage" — target status unnamed; `[decision]` `INACTIVE` with `statusReason: CUSTOMER` (§D-5) |
| `REFERRED` | `ACTIVE` | `approveDocumentCheck` / `approveAmlKycCheck` / `approveSanctionCheck` clearing the last failed stage, or Shaype operations | `[inferred]` [map:kyc][map:customers] — no endpoint documents a resulting status [spec] |
| `REFERRED` | `REJECTED` | Shaype operations (or client `changeHayCustomerStatus`) | `[inferred]` from [docs:customer-status-flow] |
| `ACTIVE` | `BLOCKED` (`blockedBy: CLIENT`) | `blockCustomer` | [docs:customer-creation-1] "Blocking will change the customer status to BLOCKED and sends a webhook event with the type CUSTOMER_STATUS_UPDATED" |
| `ACTIVE` | `BLOCKED` | `blockAccount` with `accountBlockStyle` absent or `ACCOUNT_AND_CUSTOMER` | [spec blockAccount] "Blocks the account (and by default its owning customer(s))" |
| any | `BLOCKED` (`blockedBy: PLATFORM`) | Shaype | `[inferred]` from the `blockedBy` enum gloss [spec] |
| `BLOCKED` | `ACTIVE` | `unblockCustomer` | [docs:customer-creation-1] "Unblock customer will change the customer status to ACTIVE" |
| `BLOCKED` | `ACTIVE` ? | `unblockAccount` | `[open]` — undocumented [map:accounts §7-5][map:customers §7-12]; `[decision]` no cascade: `unblockAccount` touches the account only |
| any non-`INACTIVE` | `INACTIVE` (`statusReason` ← `closeAccount.reason`) | `closeAccount` that closes the customer's last non-`CLOSED` account (asynchronous) | [docs:customer-status-flow] "Closing all the accounts for a customer ... will also change the customer status to `INACTIVE`"; [docs:account-closure] "If the customer is linked only to accounts with a Closed status ... their status will be updated" |
| any non-`INACTIVE` | `INACTIVE` | `removeCustomerFromGroup` when the customer is then linked only to `CLOSED` accounts | [docs:customer-removal] |
| any | any of the six | `changeHayCustomerStatus` — schema permits every value, no legal matrix published | [spec]; `[decision]` matrix below |
| `INACTIVE` | (new record in `PENDING_APPROVAL`) | re-onboarding creates a **new** `customerHayId` | [docs:account-closure] "we would maintain the old customer profile in the system in an Inactive state" |

Terminal: `INACTIVE` (for the record) [docs:customer-status-flow]; `REJECTED` `[inferred]` (nothing documents leaving it).

`[decision]` legal `changeHayCustomerStatus` matrix for the local implementation: `PENDING_APPROVAL → {ACTIVE, REFERRED, REJECTED, INACTIVE}`; `REFERRED → {ACTIVE, REJECTED}`; `ACTIVE → {BLOCKED, INACTIVE}`; `BLOCKED → {ACTIVE, INACTIVE}`; `INACTIVE`, `REJECTED` → none. Same-status request → `200` no-op, no webhook. Illegal → `422` `ErrorResponse` with `message` `PERMISSION_DENIED: Customer <id> cannot move from <from> to <to>` (pattern modelled on the spec's 422 examples). Every effective change emits `CUSTOMER_STATUS_UPDATED` (`actionOwner: CLIENT`), sets `lastUpdatedDateTimeUtc`, sets `approvedDateTimeUtc` on first entry to `ACTIVE`, `closedDateTimeUtc` on `INACTIVE`.

### B.2 Account `status`

| from | to | via operation or event | source |
|---|---|---|---|
| (none) | `APPROVED` | `createAccount` (`POST /v1/accounts`), `createHayAccount`, `createHayAccountForGroup` | [spec HayAccount.status] "Accounts created through this API are automatically set as APPROVED"; [docs:customer-creation-1] `ACCOUNT_STATUS_CHANGE` sample `"accountStatus": "APPROVED"` — **but** [docs:sample-requests-responses] Create Account response shows `"status": "PENDING_APPROVAL"` (§D-1); `[decision]` `APPROVED` |
| `PENDING_APPROVAL` | `APPROVED` | platform approval, no client operation | `[inferred]` from the enum glosses |
| `APPROVED` | `ACTIVE` | first deposit, withdrawal or transfer on the account | [docs:account-status] "Once deposit or withdrawal happens account automatically changes status to Active"; whether a stack transfer counts is `[open]` [map:groups-stacks §7-11]; `[decision]` any posted `FinancialTransaction` or stack transfer counts |
| `ACTIVE` | `ACTIVE_IN_ARREARS` | overdraft expiry with negative balance, `updateOverdraftLimit` below the drawn amount, or technical overdraft | [docs:account-status] |
| `ACTIVE_IN_ARREARS` | `ACTIVE` | deposit that covers the overdraft balance | [docs:account-status] "When the overdraft balance is covered, the deposit account will be sent back to the ACTIVE state" |
| `APPROVED` / `ACTIVE` / `ACTIVE_IN_ARREARS` | `LOCKED` (`blockedBy: CLIENT`) | `blockAccount` (also blocks every child account; by default the owning customer(s)) | [docs:accounts-overview] "On a blocked account, the account status would be LOCKED"; [spec]; blockable from-set `[inferred]` — [docs:account-status] says "Refers to an Active account that has been Blocked" |
| any non-`CLOSED` | `LOCKED` (`blockedBy: PLATFORM`) | Shaype | [docs:account-status] "Blocked by Shaype or the Client" |
| `LOCKED` | `LOCKED` | `blockAccount` again | [spec] "The operation is idempotent and can be safely retried" |
| `CLOSED` | `CLOSED` | `blockAccount` | [spec] "The request succeeds when every account in scope ends blocked or closed" |
| `LOCKED` | `ACTIVE` | `unblockAccount` | [docs:accounts-overview] "On an unblocked account, the account status will become ACTIVE" (always `ACTIVE`, even if it was `APPROVED` before the block — `[open]` [map:accounts §7-5]; `[decision]` always `ACTIVE`) |
| `ACTIVE` `[inferred]` | `DORMANT` | platform inactivity timer; period unspecified; no client op | [spec] gloss "dormant due to inactivity on Account for a specific period of time" |
| `DORMANT` | `ACTIVE` | next transaction | `[inferred]` [map:accounts] |
| any non-`CLOSED` passing the closure checks | `CLOSED` | `closeAccount` (`202`; status change is synchronous, cascades asynchronous) | [docs:account-closure] "if account closure requests pass validation the account status is immediately updated to Closed" |
| `CLOSED` | — | terminal | [docs:account-status] "CLOSED is a final status and there is no way to re-activate a closed account" |

Webhook: `ACCOUNT_STATUS_CHANGE` carries `accountStatus` with `LOCKED` rendered as `BLOCKED` [webhook-spec] — `[decision]` store `LOCKED`, emit `BLOCKED`, never return `BLOCKED` from `GET`.
Risk level (separate axis): `HIGH` on create → `LOW` / `HIGH` via `changeAccountRiskLevel` [docs:accounts-overview][docs:account-limits].

### B.3 Card `cardStatus`

| from | to | via operation or event | source |
|---|---|---|---|
| (none) | `AWAITING_ACTIVATION` | `createHayCard` with `cardType: PHYSICAL` (default) | [docs:card-creation] "Physical card will be created and sent in `AWAITING_ACTIVATION`" |
| (none) | `ACTIVE` | `createHayCard` with `cardType: VIRTUAL` | [docs:card-creation] "Virtual cards will be created and automatically `ACTIVE`" |
| (none) | `AWAITING_ACTIVATION` / `ACTIVE` | `reissueHayCard` → new card (PHYSICAL / VIRTUAL) | [docs:card-operations] "If the new card created is PHYSICAL, it will be issued AWAITING_ACTIVATION" |
| (none) | `AWAITING_ACTIVATION` / `ACTIVE` | `renewCard` → new card | [docs:card-operations]; VIRTUAL case `[inferred]` [map:cards] |
| `ACTIVE` (VIRTUAL) | `AWAITING_ACTIVATION` (now PHYSICAL) | `convertCard` | [docs:card-operations] "the physical card will be temporarily inactive during shipment"; [docs:card-lifecycle-stauts] |
| `AWAITING_ACTIVATION` | `ACTIVE` | `activateCard` | [spec] "This action is only valid for cards with a status of AWAITING_ACTIVATION" |
| `ACTIVE` | `BLOCKED` (`blockedBy: CLIENT`) | `blockCard` | [docs:card-operations] "It will move card status to `BLOCKED`" |
| `ACTIVE` | `BLOCKED` (`blockedBy: PLATFORM`) | Shaype | `[inferred]` from `blockedBy` gloss [spec] |
| `BLOCKED` | `ACTIVE` | `unblockCard` | [docs:card-operations] "Upon unblocking the card, the card status would be ACTIVE" |
| `ACTIVE` | `INACTIVE` | `cancelCard` | [docs:card-operations] "It will move card status to `INACTIVE`" |
| `ACTIVE` | `INACTIVE` | `reissueHayCard` on this (old) card | [docs:card-operations] "It marks the old card as inactive and issues a new one" |
| `ACTIVE` | `INACTIVE` | `activateCard` on the card in this card's `renewedIntoCardId` | [docs:card-operations] "Once the new card is received and activated, the old card is disabled" |
| any non-`INACTIVE` | `INACTIVE` | `closeAccount` on the linked account (asynchronous) | [docs:account-closure] "Shaype card status will be updated to Inactive" |
| any non-`INACTIVE` | `INACTIVE` | `removeCustomerFromGroup` — cards the customer holds on group-held accounts | [docs:customer-removal] "search for any cards the customer holds that are issued against accounts held by the group and cancel them"; value `INACTIVE` `[inferred]` |
| `ACTIVE` | `EXPIRED` | platform "scheduled job to retrieve expired cards" | [docs:card-lifecycle-stauts] (diagram) |
| `ACTIVE` | `ACTIVE` (+`renewedIntoCardId`) | `renewCard` — old card unchanged | [docs:card-operations] "The old card will stay active while the new card is in transit" |

Terminal: `INACTIVE` [docs:card-operations] "`INACTIVE` is a final state and cannot be reverted once Canceled"; `EXPIRED` `[decision]` terminal (diagram has no exit edge).
Undocumented and `[decision]` allowed: `AWAITING_ACTIVATION → BLOCKED` (block), `AWAITING_ACTIVATION → INACTIVE` (cancel / re-issue), `BLOCKED → INACTIVE` (cancel / re-issue / account closure). `[decision]` rejected with `422`: `activateCard` from anything but `AWAITING_ACTIVATION`; `unblockCard` when not `BLOCKED`; any op on `INACTIVE`/`EXPIRED` except reads; `convertCard` on `PHYSICAL`.
Sub-states: `CardPinStatus.enabled` `true → false` after 3 wrong PINs (processor), `false → true` via `unblockCardPin`; `cvvRemainingTries` decrements on wrong CVV, `unblockCardCvv` resets [spec][map:cards]. `cardEnabled` `true ↔ false` via `updatePaymentPreferences` (only while `ACTIVE`) [docs:card-operations].

### B.4 PayID `status`

| from | to | via operation or event | source |
|---|---|---|---|
| (none / Initial) | `ACTIVE` | `postPayIdRegister` (`POST /v1/accounts/{accountId}/payids/{payId}/register`) | [docs:payid] "Allows the registration of a PayID with a particular customer's account" |
| `DEREGISTERED` (record kept < 90 days) | `ACTIVE` | `postPayIdRegister` (same or different account) | [docs:payid] "it can be be re-registered again with the same or different account at any point" |
| `ACTIVE` | `DISABLED` | `updatePayIdStatus {payIdStatus: DISABLED}` | [spec]; [docs:payid] "A PayID can be disabled at any time" |
| `ACTIVE` | `DISABLED` | NPP timer: 10 years without activity | [docs:payid] state diagram (image) via [map:payid-npp] |
| `DISABLED` | `ACTIVE` | `updatePayIdStatus {payIdStatus: ACTIVE}` | [spec]; diagram "AliasEnabling" [map:payid-npp] |
| `ACTIVE` | `PORTABLE` | `updatePayIdStatus {payIdStatus: PORTABLE}` | [spec] "Place PayID in transferable state" |
| `PORTABLE` | `ACTIVE` | NPP timer: 14 days without registration elsewhere | [docs:payid] "If the PayID isn't registered with this period it will automatically return to an Active state" |
| `PORTABLE` | `ACTIVE` | `updatePayIdStatus {payIdStatus: ACTIVE}` | `[open]` — not in the NPP diagram [map:payid-npp §7-9]; `[decision]` accept (it only shortens the timer) |
| `PORTABLE` | `DISABLED` | `updatePayIdStatus {payIdStatus: DISABLED}` | diagram [map:payid-npp] |
| `PORTABLE` | (gone — registered at another FI) | other FI registers within 14 days | [docs:payid] |
| `ACTIVE` / `DISABLED` / `PORTABLE` | `DEREGISTERED` | `updatePayIdStatus {payIdStatus: DEREGISTERED}` | [spec]; diagram [map:payid-npp] |
| any non-`DEREGISTERED` | `DEREGISTERED` | `closeAccount` on the linked account (asynchronous) | [docs:account-closure] "All PayID's registered to that account are deleted"; value `DEREGISTERED` `[inferred]`; `[decision]` `reason: CUST` |
| `DEREGISTERED` | (record purged) | NPP timer: 90 days | [docs:payid] "automatically remove a PayID record after the record has been in deregistered state for 90 days" |
| `DEREGISTERED` | anything via `updatePayIdStatus` | **rejected** | [docs:payid] "A PayID in a DEREGISTERED state cannot have its status updated, the PayID must be registered again" |
| `DISABLED` | `PORTABLE` | **not in diagram** — `[decision]` reject `422` | [map:payid-npp] |

### B.5 Mandate `status` (PayTo)

| from | to | via operation or event | source |
|---|---|---|---|
| (none) | `CREATED` | `createMandate` | [docs:payto-staging-testing-suite] "On production, mandates initially are in status CREATED" |
| `CREATED` | `ACTIVE` | Payer accepts: `resolveMandateByPayer?resolution=ACCEPT` or external bank authorisation (`MCRC`) | [docs:payto-staging-testing-suite] "when mandate creation proposal is accepted by the other party, the mandate status is switched to ACTIVE" |
| `CREATED` | `CANCELLED` | MMS authorisation timeout (6 days, `MCRX`) | [docs:payto-staging-testing-suite] "after 6 days mandate should be automatically rejected and set into CANCELED status by MMS" |
| `CREATED` | `CANCELLED` | Payer declines: `resolveMandateByPayer?resolution=REJECT` (`MCRD`) | target `[inferred]` [map:payto] |
| `CREATED` | `CANCELLED` | Initiator recalls: `resolveMandateByInitiator` (`MCRR`) | target `[inferred]` [map:payto] |
| `ACTIVE` | `SUSPENDED` | `suspendMandateByInitiator` / `suspendMandateByPayer` / debtor institution | [docs:payto-staging-testing-suite] "Only mandates that are in ACTIVE status can be successfully suspended" |
| `SUSPENDED` | `ACTIVE` | `releaseMandateByInitiator` / `releaseMandateByPayer` | [docs:payto-staging-testing-suite] "mandates can be released only when suspended" |
| `ACTIVE` / `SUSPENDED` | `CANCELLED` | `cancelMandateByInitiator` / `cancelMandateByPayer` | [spec cancelMandateByInitiator] "Changes status to CNCD in the central Mandate Management Service"; [docs:payto-staging-testing-suite] "Mandates can be cancelled from any other status" |
| `CREATED` | `CANCELLED` | `cancelMandateByPayer` | `[open]` — docs only forbid the Initiator (§D-7); `[decision]` allow for Payer, reject for Initiator |
| any non-`CANCELLED` | `CANCELLED` | `closeAccount` on the creditor or debtor account (asynchronous) | [docs:account-closure] "All PayTo arrangements registered with that account are cancelled" |
| `ACTIVE` / `SUSPENDED` | `CANCELLED` | validity end date passed / MMS expiry | `[open]` reason codes `MD20`, `CTEX` exist; behaviour undocumented [map:payto] |
| `ACTIVE` | `ACTIVE` | `amendMandateByInitiator`, `amendMandateByPayer`, accepted `amendMandatePaymentTerms` | [spec]; no status change |

Terminal: `CANCELLED` `[inferred]`. `MandateAction.status`: `PENDING → COMPLETED | DECLINED | RECALLED | TIMED_OUT`; unilateral actions are born `COMPLETED` [spec]. `PaymentInstruction.transactionStatus`: final = `UNDELIVERED`, `ACCEPTED_AND_SETTLED`, `REJECTED`; non-final = the other six [docs:status-transitions].

### B.6 Authorisation hold (internal states — nothing exposed on `AuthorisationHold`)

| from | to | via operation or event | source |
|---|---|---|---|
| (none) | `AUTHORISED` | Visa authorisation passing balance / limit / rule / fraud checks; staging `generateAuthHold` | [docs:card-transactions] "If all checks passed, platform will block the requested amount by increasing **held balance**"; webhook `CARD_TRANSACTION` / `isPending: true` |
| (none) | (refused, no hold) | checks fail → webhook `outcome: REFUSED_*` | [docs:payment-transaction-outcome]; `[inferred]` that a webhook is still emitted [map:transactions-holds] |
| `AUTHORISED` | `AUTHORISED` (amount ↑ / ↓) | incremental authorisation / partial reversal; staging `generateHoldAndUpdateHoldTransactions` | [docs:card-transactions] §2–3 |
| `AUTHORISED` | `REVERSED` | full reversal (update amount = hold amount) | [docs:card-transactions] "partial or full reversal"; webhook `CARD_TRANSACTION_REFUND` / `isPending: true` |
| `AUTHORISED` | `SETTLED` | Visa settlement; staging `generateCardTransaction` | [docs:card-transactions] §1; webhook `CARD_TRANSACTION_SETTLED` / `isPending: false`, new `transactionHayId`, `FinancialTransaction.relatedHoldHayId` = hold |
| `AUTHORISED` | `CANCELLED` | Shaype ops console (no API) | [docs:page/authorisation-hold-cancel] via [map:transactions-holds] |
| `AUTHORISED` | expiry | **undocumented** | `[open]` [map:transactions-holds §7-9]; `[decision]` no automatic expiry in the local implementation |

All states after `AUTHORISED` are terminal `[inferred]`.

### B.7 Stack `status`

| from | to | via operation or event | source |
|---|---|---|---|
| (none) | `OPEN` | `createStack` | [docs:stack] "This endpoint is used to close an open stack" (initial state `[inferred]`) |
| `OPEN` | `OPEN` | `updateStack`, `accountToStackTransfer`, `stackToAccountTransfer`, `stackToStackTransfer` | [spec] — data/balance changes only |
| `OPEN` | `CLOSED` (`closedAtUtc` set, balance swept to account) | `closeStack` | [spec closeStack] "Funds will be transferred into account."; [docs:stack] "If the stack holds any balance, the funds will be transferred to the account's main balance" |
| `CLOSED` | — | terminal | [docs:stack] "Closed stack can't be open again" |
| (any) | (no cascade) | `closeAccount` | `[inferred]` — closure is refused with `ACCOUNT_BALANCE_STACKS` while stacks hold funds [spec `ClosureCheckerError.type`]; `[decision]` require stacks to be empty (open-but-empty stacks are closed on account closure) |

### B.8 Group — no lifecycle

No status; membership (`customerHayIds`) and descriptive fields are the only mutable dimensions [spec]. `createHayGroup` → exists; `addCustomersToGroup` / `removeCustomerFromGroup` change membership; removal of the final member is rejected [docs:customer-removal] "If the customer is the group's final member, then the remove from group API will reject the request". No close/delete operation exists [spec].

### B.9 KYC — `ExternalCase.outcome` and onboarding stages

| from | to | via operation or event | source |
|---|---|---|---|
| (none) | `NOT_EXECUTED` | `createCase` (`POST /v1/kyc/identity-verification/cases`) | [docs:sample-requests-responses] initial value in the sample; [spec] "Outcome is unknown because customer didn't complete the identity verification or customer input processing isn't complete yet" |
| `NOT_EXECUTED` | `PASSED` / `REJECTED` / `WARNING` | platform / vendor after the end user completes the flow | [spec] glosses; transitions `[inferred]` [map:kyc]; no API advances a case |
| stage pending | stage passed | platform check succeeds | [docs:customer-creation-1] "automatically" |
| stage pending | stage failed | platform check fails → `ONBOARDING_FAILED {state: DOCUMENT_SCAN \| SANCTIONS_SCAN \| KYC_AML_SCAN \| DUPLICATE_CHECK}`; customer → `REFERRED` | [webhook-spec]; [docs:customer-status-flow] "If a customer fails a check they will be referred" |
| stage failed | stage approved | `approveDocumentCheck` / `approveAmlKycCheck` / `approveSanctionCheck` respectively (`POST /v1/kyc/{customerId}/onboarding/{documentCheck\|amlKycCheck\|sanctionCheck}/approval`) | [spec] endpoint existence; effect `[inferred]`; no endpoint for `DUPLICATE_CHECK` |
| all stages passed/approved | customer `ACTIVE` + `ONBOARDING_PASSED` | platform | [docs:customer-creation-1]; `[inferred]` for the manual-approval path |

---

## C. Cross-domain preconditions

Columns: `operation | requires customer status | requires account status | requires card status | balance/limit requirement | error returned when unmet | source`. "—" = no requirement documented and none inferred; "n/a" = the entity is not involved. Business refusals on money movement are HTTP `200` with an `outcome`; state/precondition failures on management ops are `422 ErrorResponse` in every documented example [spec].

### C.1 Customer and KYC operations

| operation | requires customer status | requires account status | requires card status | balance/limit requirement | error returned when unmet | source |
|---|---|---|---|---|---|---|
| `createCase` | n/a (precedes the customer) | n/a | n/a | — | `400` schema violations `[inferred]` | [docs:customer-creation-1] "Create a case is the first step" |
| `createHayCustomer` | n/a; `identityVerificationCaseId` must equal a `scanCase.id` | n/a | n/a | — | duplicate (email / phone / doc / name+DOB among non-excluded records) → "customer creation will fail" — code unstated, `[decision]` `422 PERMISSION_DENIED: Duplicate customer` | [docs:customer-creation-1]; exclusion of `INACTIVE` records unless closure `reason` ∈ {SUSPICIOUS, DECEASED} [docs:account-closure] |
| `changeHayCustomerStatus` | transition must be legal — no matrix published; `[decision]` matrix in B.1 | — | — | — | `[decision]` `422 PERMISSION_DENIED: …` | [spec] schema allows all six values |
| `blockCustomer` | `[decision]` `ACTIVE` (also `PENDING_APPROVAL`/`REFERRED` allowed, `INACTIVE`/`REJECTED` rejected) | — | — | — | `[decision]` `422`; already `BLOCKED` → `200` no-op | [docs:customer-creation-1] gives no precondition; [map:customers §7-11] |
| `unblockCustomer` | `BLOCKED` `[inferred]`; `blockedBy: PLATFORM` `[open]` (`[decision]` allow) | — | — | — | `[decision]` `422` when not `BLOCKED` | [docs:customer-creation-1] "Unblock a blocked customer" |
| `approveDocumentCheck` / `approveAmlKycCheck` / `approveSanctionCheck` | `PENDING_APPROVAL` or `REFERRED` with that stage failed under Shaype KYC `[inferred]` | n/a | n/a | — | `[decision]` `422` for `ACTIVE`/`REJECTED`/`INACTIVE`/`BLOCKED`, for `skipKyc` customers, and for a stage absent under Reduced KYC; repeat approval → `200` no-op | [map:kyc §6] — spec documents no condition |

### C.2 Account operations

| operation | requires customer status | requires account status | requires card status | balance/limit requirement | error returned when unmet | source |
|---|---|---|---|---|---|---|
| `createAccount` (`POST /v1/accounts`, holder `CUSTOMER`) / `createHayAccount` | `ACTIVE` | n/a (creates `APPROVED`) | n/a | — | `422` `PERMISSION_DENIED: Account cannot be created for customer with id <id> as their status is currently BLOCKED` (example is for `BLOCKED`; same shape for every non-ACTIVE status `[inferred]`) | [spec createHayAccount 422 example]; [docs:customer-status-flow] "An account can only be opened if the customer is in `ACTIVE` status"; declared on `/v0/customers/{id}/account` only — same on `/v1/accounts` `[inferred]` |
| `createAccount` (holder `GROUP`) / `createHayAccountForGroup` | **all** members `ACTIVE` | n/a | n/a | — | `422` `PERMISSION_DENIED: Account cannot be created for group with id <id>, all members of the group should have an ACTIVE status` | [spec createHayAccountForGroup 422 example] |
| `changeAccountRiskLevel` | — | `[decision]` not `CLOSED` | n/a | — | `[decision]` `422` on `CLOSED` | none documented |
| `blockAccount` | — (blocks the customer too unless `accountBlockStyle: ACCOUNT_ONLY`) | any; `LOCKED` and `CLOSED` count as success | n/a | — | `422` `BlockAccountResponse {failedAccounts[], message}` when an account in scope could not be blocked; `200` with partial success when only the customer block failed | [spec blockAccount] "succeeds when every account in scope ends blocked or closed … idempotent" |
| `unblockAccount` | — | `LOCKED` `[inferred]`; `blockedBy: PLATFORM` `[open]` | n/a | — | `[decision]` `422` when not `LOCKED` (incl. `CLOSED`) | [docs:accounts-overview] "Endpoint to unblock a blocked account" |
| `closeAccount` | — | not `CLOSED` `[inferred]`; child accounts `CLOSED` (`CHILD_ACCOUNT_STATUS`) | any — linked cards are set `INACTIVE` afterwards | `totalBalance`, `heldBalance`, `lockedBalance`, `stacksBalance`, `overdraftBalance`, `technicalOverdraftBalance` all zero; no in-flight outbound direct debits | `422` `CloseAccountResponse {result: FAILURE, description: "Account closure failed. Check errors for more details.", errors[{type, errorMessage}]}` e.g. `ACCOUNT_BALANCE_HELD` "Account has 17.78 held balance."; all failing checks listed together | [docs:account-closure]; [spec `ClosureCheckerError.type`]; HTTP code `422` `[inferred]` [map:accounts] |
| `setAccountLimit` / `updateMaxBalanceLimit` / `updateOverdraftLimit` / `deleteAccountLimit` | — | `[decision]` not `CLOSED` | n/a | account limit ≤ product limit | `422` `[inferred]` "cannot exceed … applied to the Product" | [docs:account-limits] "An account level limit cannot exceed the Product level" |
| `addAccountRule` / `disableRule` | — | `[open]` on `CLOSED` [map:accounts §7-20]; `[decision]` reject `422` | n/a | — | — | — |

### C.3 Money movement (HTTP 200 + `outcome` unless stated)

| operation | requires customer status | requires account status | requires card status | balance/limit requirement | error returned when unmet | source |
|---|---|---|---|---|---|---|
| `makeTransferV1` / `makeTransferV0` (outbound) | **none** — a `BLOCKED` customer may still transact | sender not `LOCKED` / `CLOSED`; recipient (Shaype-to-Shaype) not `LOCKED` / `CLOSED`; risk level `LOW` | n/a | `availableBalance` ≥ amount (`MIN_BALANCE`); daily transfers-out limit; recipient `MAX_BALANCE`; `TOTAL_*` daily client limits; PayID resolvable for `PAY_ID` | `REFUSED_ACCOUNT_BLOCKED`, `REFUSED_ACCOUNT_CLOSED`, `REFUSED_RECIPIENT_ACCOUNT_BLOCKED`, `REFUSED_RECIPIENT_ACCOUNT_CLOSED`, `REFUSED_INSUFFICIENT_FUNDS` (spec) / `REFUSED_NOT_ENOUGH_FUNDS` (docs, webhook — §D-6), `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED`, `REFUSED_MAX_BALANCE_EXCEEDED`, `REFUSED_TOTAL_*_DAILY_LIMIT_BREACHED`, `REFUSED_INVALID_PAY_ID`, `REFUSED_FRAUD`; risk `HIGH` → `[decision]` `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED` (limits are 0) | [docs:customer-status-flow] "This status does not impact the account or cards and transactions are still allowed"; [docs:payment-transaction-outcome]; [docs:account-limits] "HIGH risk level set all limits to 0 … will prevent all outbound and inbound transactions"; [spec `TransactionOutcome.outcome`] |
| `createCreditTransactionV1` / `createDebitTransactionV1` (general credit/debit) | none | not `LOCKED` / `CLOSED`; `APPROVED` → becomes `ACTIVE` `[decision]`; `DORMANT`/`PENDING_APPROVAL` `[open]` | n/a | debit: `MIN_BALANCE` only ("only minimum balance validation is applied"); credit: `MAX_BALANCE` (v0 description names `REFUSED_MAX_BALANCE_EXCEEDED`) | `REFUSED_ACCOUNT_BLOCKED`, `REFUSED_ACCOUNT_CLOSED`, `REFUSED_INSUFFICIENT_FUNDS`, `REFUSED_MAX_BALANCE_EXCEEDED`, `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED` (v0 collapses the last two to `REFUSED_LIMIT_BREACH`) | [docs:payments]; [spec createCreditTransactionV0 description]; [map:transactions-holds §6.2] |
| Card authorisation (inbound Visa; staging `generateAuthHold` / `generateCardTransaction`) | none documented | not `LOCKED` / `CLOSED`; risk `LOW` | `ACTIVE` **and** `cardEnabled: true`; PIN/CVV not blocked for PIN/CVV transactions | `availableBalance` ≥ amount; `SINGLE_CARD_TRANSACTION`, `CARD_PAYMENTS_DAILY`, `ATM_WITHDRAWAL_PER_DAY`, annual spend; account rules; fraud | webhook `outcome`: `REFUSED_CARD_PREFERENCE`, `REFUSED_ACCOUNT_BLOCKED`, `REFUSED_ACCOUNT_CLOSED`, `REFUSED_NOT_ENOUGH_FUNDS`, `REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED`, `REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED`, `REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED`, `REFUSED_RULES`, `REFUSED_FRAUD`; processor declines `CARD_IS_NOT_ACTIVE`, `CARD_EXPIRED`, `CVV_BLOCKED`, `ALLOWED_PIN_RETRIES_EXCEEDED` | [docs:card-transactions] "internal checks, including account balance verification, limit assessments, rule enforcement, and fraud detection"; [docs:payment-transaction-outcome]; [docs:card-operations] `cardEnabled` "Disabling the card prevents transactions from being processed using it"; [spec `declineReason` enum] |
| `makeAdhocPayment` (PayTo) | none | debtor/creditor accounts "activated and they should contain money" (staging prerequisite) | n/a | `amount` ≤ `paymentTerms.maximumAmount`; `amount` > 0; debtor funds | `200` with `transactionStatus: REJECTED` + webhook `reasonCode` (`AM14`/`AM21` amount exceeds limit, `AM01` zero amount, `AB01` timeout); mandate not `ACTIVE` / not `ADHOC` → `[decision]` `422` | [docs:payto-staging-testing-suite]; reason codes [spec][webhook-spec]; enforcement split `[open]` [map:payto §7-9] |
| `accountToStackTransfer` | none | `OPEN` stack; account not `LOCKED` / `CLOSED` `[inferred]` from "This status will block all transactions and transfers" | n/a | `availableBalance` ≥ amount; exempt from daily transfer limits; counts toward `MAX_BALANCE` (unchanged by the move) | `200` `outcome: REFUSED_INSUFFICIENT_FUNDS` | [spec `StackTransactionResponse.outcome`]; [docs:stack] "internal cash transfers within an account that involve a Stack will not form part of the daily transfer limits"; [docs:account-status] |
| `stackToAccountTransfer` | none | `OPEN` stack; account not `LOCKED` / `CLOSED` `[inferred]` | n/a | stack `balance` ≥ amount; `MIN_STACK_BALANCE` `[open]` | `200` `outcome: REFUSED_INSUFFICIENT_FUNDS` | [spec]; [map:groups-stacks] |
| `stackToStackTransfer` | none | both stacks `OPEN`, same account | n/a | source `balance` ≥ amount; `amount` > 0 (`exclusiveMinimum`) | `200` `outcome: REFUSED_INSUFFICIENT_FUNDS`; `amount ≤ 0` → `400` `[inferred]` | [spec] |

### C.4 Card operations

| operation | requires customer status | requires account status | requires card status | balance/limit requirement | error returned when unmet | source |
|---|---|---|---|---|---|---|
| `createHayCard` | undocumented — `[decision]` `ACTIVE` | undocumented — `[decision]` not `CLOSED` / `LOCKED` | n/a (creates `AWAITING_ACTIVATION` / `ACTIVE`) | — | `[decision]` `422 PERMISSION_DENIED: …`; unagreed `cardType` → "an error will occur" (code unstated) | [map:cards §7-4] "Cards docs are silent"; [docs:card-creation] |
| `activateCard` | — | — | `AWAITING_ACTIVATION` | — | error, code undocumented → `[decision]` `422` | [spec] "This action is only valid for cards with a status of AWAITING_ACTIVATION" |
| `blockCard` | — | — | `ACTIVE` (diagram); `AWAITING_ACTIVATION` `[decision]` allowed; `INACTIVE`/`EXPIRED` rejected | — | `[decision]` `422`; already `BLOCKED` → `200` no-op | [docs:card-lifecycle-stauts]; [map:cards §7-5, §7-13] |
| `unblockCard` | — | — | `BLOCKED` | — | `[decision]` `422` when not `BLOCKED` | [docs:card-operations] "can be reverted using Unblock Card" |
| `cancelCard` | — | — | not `INACTIVE` (`EXPIRED` `[decision]` allowed) | — | `[decision]` `422` on `INACTIVE` | [docs:card-operations] "INACTIVE is a final state" |
| `reissueHayCard` | — | — | `ACTIVE` (diagram); `BLOCKED` `[decision]` allowed (lost/stolen flow); `INACTIVE` rejected | — | `[decision]` `422` | [docs:card-operations]; [map:cards §7-5] |
| `renewCard` | — | — | `ACTIVE`; within 2 months of `expiryDate`; `EXPIRED` `[open]` (`[decision]` reject) | — | error, code undocumented → `[decision]` `422` | [docs:card-operations] "Renew can only be called within 2 months of the expiry date of the card" |
| `convertCard` | — | — | `cardType: VIRTUAL` and `ACTIVE` | — | error, code undocumented → `[decision]` `422` | [docs:card-operations] "Only converting from virtual to physical is possible" |
| `updatePaymentPreferences` | — | — | `ACTIVE` | — | error, code undocumented → `[decision]` `422` | [docs:card-operations] "Card preferences can only be updated if the card is `ACTIVE`" (but see §D-8) |
| `unblockCardPin` / `unblockCardCvv` | — | — | `[decision]` not `INACTIVE` / `EXPIRED`; already unblocked → `200` no-op | — | `[decision]` `422` | none documented [map:cards §7-14] |
| `changeCardPin` | — | — | `[decision]` `ACTIVE` or `AWAITING_ACTIVATION` | — | `403` without CSM-granted privilege | [docs:card-operations] "Card PIN change requires an API token with specific privilege" |

### C.5 PayID, PayTo, stacks, groups

| operation | requires customer status | requires account status | requires card status | balance/limit requirement | error returned when unmet | source |
|---|---|---|---|---|---|---|
| `postPayIdRegister` | — (`ownerName` "must be reflective of the account holder name" — client obligation) | account exists, NPP-enabled BSB; status undocumented → `[decision]` not `CLOSED` / `LOCKED` | n/a | — | value already `ACTIVE`/`DISABLED` elsewhere → `[decision]` `422` (no 409 declared); not NPP-enabled → `422` | [docs:payid] "PayIDs can only be registered against accounts that are NPP enabled"; [map:payid-npp §7-14] |
| `updatePayIdStatus` | — | — | n/a | — | current status `DEREGISTERED` → `[decision]` `422`; transition outside B.4 → `[decision]` `422` | [docs:payid] "A PayID in a DEREGISTERED state cannot have its status updated" |
| `resolvePayId` | — | — | n/a | — | PayID `DISABLED` / `DEREGISTERED` / unknown → `[decision]` `422`; `PORTABLE` resolves | `[inferred]` [map:payid-npp §7-6] |
| `createMandate` | — | creditor account must exist and be matchable; `ACTIVE` not stated (staging prerequisite: accounts "have been activated") | n/a | rate limit (`429` + `Retry-After`) | `422` `NOT_FOUND: CUS.API.100522 - Creditor account details incorrect (M900 - No matching record found)` | [docs:payto-staging-testing-suite]; [spec] |
| `suspendMandateByInitiator` / `suspendMandateByPayer` | — | — (mandate `ACTIVE`) | n/a | — | `Validation of the request for suspension mandate with id: {mandate_id}: To suspend a mandate it must be in active status.` (HTTP code not shown; `[decision]` `422`) | [docs:payto-staging-testing-suite] |
| `releaseMandateByInitiator` / `releaseMandateByPayer` | — | — (mandate `SUSPENDED`) | n/a | — | `Validation of the request for releasing mandate with id: {mandate_id} failed. To release a mandate it must be in suspended status.` (`[decision]` `422`) | [docs:payto-staging-testing-suite] |
| `cancelMandateByInitiator` | — | — (mandate `ACTIVE` / `SUSPENDED`; **not** `CREATED`) | n/a | — | `[decision]` `422` for `CREATED` and `CANCELLED` | [docs:payto-staging-testing-suite] "canceling a mandate from CREATED status is not done by the Initiator" |
| `cancelMandateByPayer` | — | — (any non-`CANCELLED` `[decision]`) | n/a | — | `[decision]` `422` for `CANCELLED` | §D-7 |
| `amendMandateByInitiator` / `amendMandateByPayer` | — | new account `ACTIVE` and same holder; Payer amend needs mandate `ACTIVE` or `SUSPENDED` | n/a | — | "an error will be returned that data validation hasn't passed" (code/text not given; `[decision]` `422`) | [docs:payto-staging-testing-suite]; [spec] "Must be an account belonging to the same holder" |
| `createStack` | — | account exists; `[decision]` not `CLOSED` | n/a | name 1–20, unique on the account, no emoji; `targetAmount` ≥ 0 and ≤ account max balance; open/total stack count limits (values `[open]`) | `STACK_NAME_ALREADY_IN_USE`, `OPEN_STACKS_LIMIT_REACHED`, `TOTAL_STACKS_LIMIT_REACHED` (tokens defined only on `UpdateStackResponse.error`; channel for create `[open]`, `[decision]` `422` with the token as `message`) | [docs:stack]; [spec] |
| `updateStack` | — | stack `OPEN` `[inferred]` | n/a | name uniqueness | `200` `UpdateStackResponse.error = STACK_NAME_ALREADY_IN_USE` `[inferred]` from schema placement | [spec]; [map:groups-stacks] |
| `closeStack` | — | stack `OPEN` | n/a | — (balance is swept, not a precondition) | repeat close → `[decision]` `422` | [docs:stack] |
| `createHayGroup` / `addCustomersToGroup` | members must exist; status undocumented at add-time (only at account creation) → `[decision]` reject `INACTIVE` / `REJECTED` members with `422` | n/a | n/a | ≥ 1 member | "requires a minimum of one customerHayId" (code unstated; `[decision]` `400`) | [docs:groups]; [map:groups-stacks §7-14, §7-19] |
| `removeCustomerFromGroup` | — (side effects: cards on group accounts → `INACTIVE`; customer → `INACTIVE` if only `CLOSED` accounts remain) | — | — | group must retain ≥ 1 member | "the remove from group API will reject the request" — code unstated, `[decision]` `422` | [docs:customer-removal] |

---

## D. Contradictions and divergences (both sides quoted)

Numbered so §B/§C can reference them. "Between maps" means two of the eight maps disagree; everything else is source-vs-source, which the maps report consistently.

| # | topic | side 1 | side 2 | maps | `[decision]` |
|---|---|---|---|---|---|
| D-1 | **Initial account status** | [spec `HayAccount.status`]: "PENDING_APPROVAL: Account is created but not yet approved (Note: Accounts created through this API are automatically set as APPROVED)"; [docs:customer-creation-1] `ACCOUNT_STATUS_CHANGE` sample after create: `"accountStatus": "APPROVED"` | [docs:sample-requests-responses] "Create Account" response payload: `"status": "PENDING_APPROVAL"` | [map:accounts] §3/§7-1 flags it; [map:groups-stacks] §5 states `status = APPROVED` without the caveat — not a contradiction between maps, but groups-stacks is silent on the sample | create as `APPROVED`; emit `ACCOUNT_STATUS_CHANGE` `APPROVED` |
| D-2 | **`LOCKED` vs `BLOCKED` for a blocked account** | [spec `HayAccount.status`] enum has `LOCKED` "Account is blocked", no `BLOCKED`; [docs:accounts-overview] "On a blocked account, the account status would be LOCKED." | [webhook-spec `AccountStatusChangeEventDto.accountStatus`] enum has `BLOCKED` "Account has been blocked", no `LOCKED` (its description also omits `DORMANT`, which the enum contains) | all maps use `LOCKED` as the stored value; [map:accounts] documents the mapping | store `LOCKED`; emit `BLOCKED` in webhooks; never return `BLOCKED` from the REST API |
| D-3 | **Which account states are blockable** | [docs:account-status] `LOCKED` "Refers to an Active account that has been Blocked by Shaype or the Client" | [spec blockAccount] "The request succeeds when every account in scope ends blocked or closed. The operation is idempotent" — i.e. `LOCKED` and `CLOSED` inputs succeed; [map:accounts] infers `APPROVED` / `ACTIVE` / `ACTIVE_IN_ARREARS` → `LOCKED` | consistent across maps (all `[inferred]`) | block from any non-`CLOSED` status; `CLOSED` → `200` unchanged |
| D-4 | **`BLOCKED` customer: what is blocked** | [docs:customer-status-flow] `BLOCKED`: "This status does not impact the account or cards and transactions are still allowed." | [spec createHayAccount 422 example] "Account cannot be created for customer with id … as their status is currently BLOCKED" | [map:customers] and [map:kyc] carry both; no map claims transactions are refused for a `BLOCKED` customer | transactions unaffected; only account creation (and group-account creation) requires `ACTIVE` |
| D-5 | **Target status of "Withdrawn"** (between maps) | [map:customers] §3: "Withdrawn (target status not named; `INACTIVE` or `REJECTED` `[inferred]`)" | [map:kyc] §3: "withdrawn (target status unnamed; `INACTIVE` `[inferred]`)" | both `[inferred]` from [docs:customer-status-flow] "It can be 'Withdrawn' by the client at this stage" | `INACTIVE` with `statusReason: CUSTOMER`, via `changeHayCustomerStatus {newStatus: INACTIVE}` |
| D-6 | **Insufficient-funds outcome name** | [spec `TransactionOutcome.outcome`] `REFUSED_INSUFFICIENT_FUNDS` (also `StackTransactionResponse.outcome`) | [docs:payment-transaction-outcome] and [webhook-spec `TransactionEventDto.outcome`] `REFUSED_NOT_ENOUGH_FUNDS` — whose docs gloss is itself garbled: "Transaction declined as it would exceed the account's maximum balance MIN_BALANCE limit" | [map:transactions-holds] §6.2/§7-3 flags it; [map:accounts] lists both as spec-only vs webhook-only; [map:groups-stacks] correctly uses `REFUSED_INSUFFICIENT_FUNDS` for stacks | REST responses return `REFUSED_INSUFFICIENT_FUNDS`; webhooks emit `REFUSED_NOT_ENOUGH_FUNDS` |
| D-7 | **Cancelling a `CREATED` mandate** | [docs:payto-staging-testing-suite] "Mandates can be cancelled from any other status" | [docs:payto-staging-testing-suite] "canceling a mandate from CREATED status is not done by the Initiator" | [map:payto] §3 flags; Payer side `[open]` | Initiator: `422` from `CREATED` (use `resolveMandateByInitiator` to recall); Payer: allowed from `CREATED` |
| D-8 | **Card preferences before activation** | [docs:card-operations] "Card preferences can only be updated if the card is `ACTIVE`" | [docs:card-operations] preference table (per [map:cards] §7-10): `mobileWalletPaymentsEnabled` "YES" before activation; `contactlessEnabled`/`magneticStripeEnabled` "NO" for physical cards even after activation | [map:cards] flags | enforce the sentence: `updatePaymentPreferences` → `422` unless `ACTIVE`; ignore the table's per-phase flags |
| D-9 | **`skipKyc` meaning (affects the `PENDING_APPROVAL → ACTIVE` path)** | [docs:customer-creation-1] "If you are not using Shaype KYC, you will need to manually update the customer status to `ACTIVE`" — `skipKyc` is the client-KYC switch | [spec `CreateHayCustomerRequestBody.skipKyc`] "Only applicable to Clients using Shaype KYC solution. Used to bypass KYC checks for the Customer. Must only set as 'true' in agreed scenarios (i.e. permission to generate a dummy / test account has been granted)" | [map:kyc] §7-17 flags; [map:customers] follows the docs reading | `skipKyc: true` (or a client configured without Shaype KYC) → customer stays `PENDING_APPROVAL` until `changeHayCustomerStatus`; otherwise a test hook drives the KYC outcome |
| D-10 | **Result of `ONBOARDING_FAILED`** | [docs:customer-status-flow] `REFERRED`: "failed one or more the of the steps such as provided an invalid ID or flagged as a PEP"; [docs:customer-creation-1] "If a customer fails a check they will be referred to an operational colleague" | [docs:customer-status-flow] `REJECTED`: "the onboarding evaluation has concluded that Shaype cannot open an account for the user as a result of the information provided" — no rule says which failure yields which | [map:kyc] §7-10 open; [map:customers] maps failure → `REFERRED` | `ONBOARDING_FAILED` → `REFERRED` for `DOCUMENT_SCAN` / `KYC_AML_SCAN` / `SANCTIONS_SCAN` (approvable); → `REJECTED` for `DUPLICATE_CHECK` (no approval endpoint) |
| D-11 | **`unblockAccount` target when the account was `APPROVED`** | [docs:accounts-overview] "On an unblocked account, the account status will become ACTIVE." | [spec] `ACTIVE` gloss "has had a transactional action performed on it" — an unblocked never-transacted account would be `ACTIVE` without one | [map:accounts] §7-5 open | follow the docs: always `ACTIVE` |
| D-12 | **Description/enum mismatches inside the spec** | [spec `ChangeHayCustomerStatusRequestBody.newStatus`] description lists 5 values (no `BLOCKED`); [webhook-spec `AccountStatusChangeEventDto.accountStatus`] description lists 6 (no `DORMANT`) | the `enum` arrays carry 6 and 7 values respectively | [map:customers] §7-2 notes the first; [map:accounts] does not note the second | validate against the `enum` arrays |
| D-13 | **Docs account-status table incomplete** | [docs:account-status] table lists `APPROVED`, `ACTIVE`, `ACTIVE_IN_ARREARS`, `LOCKED`, `CLOSED` | [spec] adds `PENDING_APPROVAL`, `DORMANT` | [map:accounts] covers all seven | implement all seven; `DORMANT` only via a test hook |
| D-14 | **Stack transfer as the `APPROVED → ACTIVE` trigger** | [docs:account-status] "Once the client makes any transaction (deposit, withdrawal or transfer) on the account, it will transition from Approved to Active" | [docs:stack] stack moves are "internal cash transfers within an account" that "will not form part of the daily transfer limits" — never called a transaction | [map:groups-stacks] §7-11 open; [map:accounts] says "first deposit, withdrawal or transfer" | count stack transfers as the first transaction |

Not contradictions, but gaps every map reports identically and the local implementation must fill (`[decision]` in §B/§C): no `404`/`409` is declared on any operation; no legal-transition matrix for `changeHayCustomerStatus`; no HTTP code for any card-state precondition failure; no account-status precondition for `createHayCard`, `postPayIdRegister`, `createStack`; hold expiry; `DORMANT` trigger; PORTABLE → ACTIVE via API.
