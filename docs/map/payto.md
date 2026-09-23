# payto

Domain map for the Shaype B2B Operations API tag **"PayTo API"** ("Set of APIs related to managing PayTo operations") — **22 operations**. Ground truth for the local cleanroom re-implementation.

Sources and labels used below:

- `[spec]` — `b2b-operations-api.json` (OpenAPI 3.0.1, "B2B Operations API"). The 22 reference pages `developer.shaype.com/reference/<operationid>.md` were fetched and their embedded OpenAPI JSON diffed against this file: every operation object and every schema is identical, so the reference pages add nothing beyond `[spec]`.
- `[webhook-spec]` — `notification-webhooks.json` (Shaype calling the client).
- `[ext-auth-spec]` — `external-balance.yaml`. **Contains no mention of PayTo or mandates** (grep for `payto|mandate` is empty), so external authorisation is not involved in this domain as far as the sources show.
- `[docs:<slug>]` — `developer.shaype.com/docs/<slug>.md`. Slugs read: `payto`, `status-transitions`, `payto-operations`, `payto-payment`, `payto-notifications`, `payto-staging-testing-suite`, plus `webhook-notification` (no PayTo content) and `llms.txt` (index; no further PayTo pages exist).
- `[inferred]` — my reading of the above; not stated anywhere. Treat as a decision the implementer may overturn.

General facts that apply to every operation in this domain:

- The spec declares **no** `security` scheme [spec]. Authentication is outside this map.
- Every operation declares `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content`, `500 Internal Server Error`, `501 Not Implemented`, all with body `ErrorResponse` [spec]. `createMandate` additionally declares `429 Too many requests` (header `Retry-After`) and rate-limit headers on its 200 [spec]. **No operation declares 404 or 409** [spec]. Below, "Errors: standard" means exactly this 400/403/422/500/501 set.
- `ErrorResponse` = `{ details: string, message: string, status: string, traceId: string }` [spec]. `status` is a **string** holding the HTTP code. The one worked PayTo example: `{"message":"NOT_FOUND: CUS.API.100522 - Creditor account details incorrect (M900 - No matching record found)","details":"Please refer to the API documentation or contact Shaype for more info with the traceId.","status":"422","traceId":"9b8fa212-d655-487e-bf91-4406957bb584"}` [docs:payto-staging-testing-suite]. So a "not found"-class failure is surfaced as **HTTP 422** with a `NOT_FOUND:`-prefixed message.
- `GenericMessage` = `{ message: string }` [spec]. Known values: `"Mandate resolved successfully."` (resolveMandateByPayer) [docs:payto-staging-testing-suite]; all other success messages are undocumented (see §7).
- The spec contains **zero** `example`/`examples` keys under any PayTo path or schema [spec]. All example values in this map are from `[docs:payto-staging-testing-suite]`.
- Mandate IDs are UUIDs; the action schemas constrain both `mandateIdentification` and `actionIdentification` to **UUID version 1** (`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-1[a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$`) [spec]; all documented example mandate IDs are v1 (e.g. `1212c23a-255c-11ee-9a8e-5d3239591cd9`) [docs:payto-staging-testing-suite]. The MMS-side representation is the same UUID **without hyphens** (32 hex) [spec: `CreateStubForMandateSearchPaymentInstructionsRequestBody.mandateIdentification`, `GenerateMandateNotificationMandateDetailsDto.mandateId`].
- Roles: the client can act as **Initiator** (creditor side; `/v1/payto/initiator/...`) or **Payer** (debtor side; `/v1/payto/payer/...`); `/v1/payto/mandates...` is shared. Operation descriptions say "(For use by Initiator only)" / "(For use by Payer only)" [spec]. How Shaype decides which role a caller has (403 vs 422 when the wrong role calls) is not stated [open, §7].
- A spec quirk to reproduce faithfully: several enums in the `GetMandateActions*` schemas are encoded as a **single comma-joined string** (e.g. `"enum": ["COMPLETED,DECLINED,PENDING,RECALLED,TIMED_OUT"]`) [spec]. Values listed in this map are split on the comma; the intended values are unambiguous from the accompanying descriptions.

## 1. Operations

Operation count for tag "PayTo API": **22** (verified with the `ops.json` filter). Listed in `ops.json` order.

### GET /v1/payto/initiator/mandates (getMandateIdsByInitiator)

- Purpose: "Returns all Mandate IDs for a Shaype Account ID." — "Caller must be owner of the account and BSB." [spec]. Not deprecated.
- Query params [spec]:
  - `creditorAccountId` — string (uuid), **required**, "Creditor's Shaype Account ID".
- Request body: none.
- Response `200 Success`: JSON **array of string (uuid)** — bare list of mandate IDs, no wrapper object [spec]. Errors: standard.
- Behaviour:
  - Returns every mandate whose `creditorDetails.accountId` equals `creditorAccountId` [inferred from summary + param description].
  - Ownership check: "Caller must be owner of the account and BSB" [spec]. An account not belonging to the caller → error; code not stated (403 is declared; `[inferred]` 403 or 422).
  - Whether cancelled mandates are included, and ordering, are not stated [open, §7]. `[inferred]`: include all statuses; the summary says "all Mandate IDs".
  - Read-only; no webhook.

### POST /v1/payto/initiator/mandates (createMandate)

- Purpose: "Create Mandate" — "(For use by Initiator only) Create a mandate and send via MMS to Payer for authorisation." [spec]. Not deprecated.
- Path/query params: none.
- Request body (required): `CreateMandateRequestBody` — "Body of a request to add mandate." [spec]
  - `required`: `["creditorDetails","debtorDetails","idempotencyKey","paymentTerms","purposeCode","validityStartDate"]` [spec].

  | field | type | required | constraints / enum (verbatim) | notes |
  |---|---|---|---|---|
  | `creditorDetails` | object `CreateCreditorDetailsDto` | yes | see below | |
  | `debtorDetails` | object `CreateDebtorDetailsDto` | yes | see below | |
  | `description` | string | no | `minLength: 0`, `maxLength: 140` | "A mandate description." |
  | `idempotencyKey` | string (uuid) | yes | | "Idempotency key generated by the client of the API. Used for request duplication check." |
  | `paymentTerms` | object `CreatePaymentTermsDto` | yes | see below | |
  | `purposeCode` | string | yes | enum `["MORTGAGE","UTILITY","LOAN","DEPENDANT","GAMBLING","RETAIL","SALARY","PERSONAL","GOVERNMENT","PENSION","TAX","OTHER"]` | "The purpose of this mandate." |
  | `resolutionRequestedBy` | string | no | no format/pattern in schema | "Date time in UTC format yyyy-MM-dd'T'hh:mm:ss.sss'Z' e.g. 2023-09-10T10:00:00.000Z (Optional)." Informational only — "does not affect the expiry time imposed by the MMS" [spec: action schemas]. |
  | `transferArrangement` | string | no | | "Indication of future transfer date, conditions of sale and requirement to hold funds." |
  | `validityEndDate` | string (date) | no | | "The date when the mandate stops being valid." |
  | `validityStartDate` | string (date) | yes | | "The date when the mandate becomes valid." |

  `CreateCreditorDetailsDto` — "Describes creditor account details." `required: ["accountId"]` [spec]:

  | field | type | required | constraints / enum | notes |
  |---|---|---|---|---|
  | `accountAliasIdentification` | string | no | | "The identifier of account alias." |
  | `accountAliasType` | string | no | enum `["AUSTRALIAN_BUSINESS_NUMBER","EMAIL_ADDRESS","ORGANISATION_ID","PHONE_NUMBER"]` | "Creditor alias type." |
  | `accountId` | string (uuid) | **yes** (spec) | | "The identifier of the creditor account." **Docs contradict**: "instead of providing `account_id` to identify creditor or debtor, an alias might be used instead" and show a create request with only `accountAliasIdentification` + `accountAliasType` for the creditor [docs:payto-staging-testing-suite]. See §7. |
  | `partyReference` | string | no | `pattern: ^[ -~]{1,35}$` | "Reference associated with the mandate as provided by party. Specifies a character string with a maximum length of 35 ASCII printable characters." Used as `endToEndId` for scheduled payments [docs:payto-staging-testing-suite]. |
  | `partyType` | string | no | enum `["ORGANISATION","PERSON"]` | |
  | `ultimatePartyName` | string | no | | "Creditor's ultimate party name. Optional, overrides platform creditor's name" |

  `CreateDebtorDetailsDto` — "Describes debtor account details." No `required` list [spec]:

  | field | type | required | constraints / enum | notes |
  |---|---|---|---|---|
  | `accountAliasIdentification` | string | no | | "The identifier of account alias." |
  | `accountAliasType` | string | no | enum `["AUSTRALIAN_BUSINESS_NUMBER","EMAIL_ADDRESS","ORGANISATION_ID","PHONE_NUMBER"]` | "Debtor alias type." |
  | `accountId` | string (uuid) | no | | "The identifier of the debtor account." (a Shaype platform account — used when the debtor is also on the platform) |
  | `accountNumber` | string | no | `minLength: 11`, `maxLength: 15` | "BSB (Bank State Branch) of Account, 6 digits in length combined with account number, 5-9 digits in length." (external debtor) |
  | `partyName` | string | no | | "Debtor party name." |
  | `partyReference` | string | no | `pattern: ^[ -~]{1,35}$` | as creditor |
  | `partyType` | string | no | enum `["ORGANISATION","PERSON"]` | |
  | `ultimatePartyName` | string | no | | "Debtor ultimate party name." |

  `CreatePaymentTermsDto` — "Describes how payments for a mandate should happen." `required: ["frequency","type"]` [spec]:

  | field | type | required | constraints / enum | notes |
  |---|---|---|---|---|
  | `amount` | object `CurrencyAmount` | no | `{amount: number (required), currency: string enum ISO-4217 (required)}` | fixed per-payment amount |
  | `countPerPeriod` | **string** | no | | "Qualifies payment count per period" — docs examples use `"7"`, `"2"`, `"10"` |
  | `firstPayment` | object `PaymentDto` | no | `{amount: CurrencyAmount, date: string (date)}` | "Describes a payment happening on a given day." |
  | `frequency` | string | yes | enum `["ADHOC","DAILY","FORTNIGHTLY","INTRA_DAY","SEMI_ANNUAL","MONTHLY","QUARTERLY","WEEKLY","ANNUAL"]` | |
  | `lastPayment` | object `PaymentDto` | no | | |
  | `maximumAmount` | object `CurrencyAmount` | no | | "Maximum amount that may be paid from the debtor's account, per instruction." [spec: utils DTO wording] |
  | `pointInTime` | string | no | `minLength: 2`, `maxLength: 2` | "Qualifies payment frequency" — example `"09"` |
  | `type` | string | yes | enum `["BALLOON","FIXED","USAGE_BASED","VARIABLE"]` | "BALLOON: Payment amount is fixed with large final payment amount. FIXED: Payment amount is fixed. USAGE_BASED: Payment amount is based on usage. VARIABLE: Payment amount is variable." |

  `CurrencyAmount` — `required: ["amount","currency"]`; `amount`: number "Amount of the transaction to 2 decimal places"; `currency`: string, enum of 160 ISO-4217 codes including `"AUD"` [spec]. Every documented example uses `"AUD"` [docs:payto-staging-testing-suite].

- Response `200 Success`: `CreateMandateResponseBody` = `{ mandateId: string (uuid) }` — "Details of created mandate." [spec]. Example `{"mandateId":"1212c423-262b-11ee-844d-95ee6a0c000c"}` [docs:payto-staging-testing-suite]. 200 carries headers `RateLimit-Limit` (int, "Number of requests in the time-windows."), `RateLimit-Remaining`, `RateLimit-Reset` (seconds) [spec]. Errors: standard + `429 Too many requests` with `Retry-After` (int seconds) [spec]. Rate-limit values are not stated [open, §7].
- Behaviour:
  - Creates the mandate in the central MMS and sends it to the Payer for authorisation [spec description]. In production the new mandate is in status **`CREATED`** ("On production, mandates initially are in status CREATED") [docs:payto-staging-testing-suite]; it becomes `ACTIVE` only when the Payer accepts (MMS notification `MCRC` to the Initiator) [docs:payto-staging-testing-suite]; is declined by the Payer (`MCRD`) [docs:payto-notifications]; or expires — "When no action is taken by Payer, then after 6 days mandate should be automatically rejected and set into CANCELED status by MMS ... Initiator then receives a notification that the action has expired" (`MCRX`) [docs:payto-staging-testing-suite].
  - Creating a mandate also creates a mandate **action** of `type: CREATE`, `bilateral: true`, `status: PENDING` with an `expiryTime` (visible via getMandateActions*) [inferred from the action schema: "For a bilateral mandate creation ... this will contain the timestamp at which the action will expire if no resolution is provided"].
  - On acceptance of a non-ADHOC mandate, Shaype schedules the next payment ("Scheduling of a payment is done when information about successful mandate creation is received by the system") [docs:payto-staging-testing-suite].
  - Recommended pre-check: call `checkBsbIsSupportedByPayTo` for the debtor's BSB first [docs:payto].
  - Validation/errors: system rejection is returned synchronously as **422** `ErrorResponse` with `message` `"NOT_FOUND: CUS.API.100522 - Creditor account details incorrect (M900 - No matching record found)"` when the creditor account cannot be matched [docs:payto-staging-testing-suite]. Malformed body (missing required, bad enum, `description` > 140, `partyReference` not matching `^[ -~]{1,35}$`) → 400 `[inferred]`.
  - Idempotency: `idempotencyKey` is required and "Used for request duplication check" [spec]; the docs add "it accepts any UUID" [docs:payto-staging-testing-suite]. Response to a replayed key is not documented [open, §7].
  - Debtor identification: either `debtorDetails.accountId` (platform account), `debtorDetails.accountNumber` (BSB+account, external), or alias (`accountAliasIdentification` + `accountAliasType`) [spec fields; docs:payto-staging-testing-suite "Aliases (PayID)"]. Which combinations are valid is not stated [open, §7].
- Webhooks: `MANDATE` events with triggers `MCRC` (create confirmed), `MCRD` (create declined), `MCRX` (create expired), `MCRR` (create recalled) arrive later to the Initiator [docs:payto-notifications]; `MCRT` ("Mandate Requires Authorisation") to the Payer [docs:payto-notifications]. `MANDATE_ACTION_EXPIRATION` exists in the webhook spec (see §2) but the docs do not tie it to an operation.

### PUT /v1/payto/initiator/mandates/{mandateId} (amendMandateByInitiator)

- Purpose: "Amend Mandate by Initiator" — "(For use by Initiator only) Amend the bank details of a mandate. Must be an account belonging to the same holder. The amend will be processed immediately without Payer authorisation being required. Allowed fields: Creditor Account ID (Shaype platform ID). This will change the target for mandate funds to another account in the Shaype platform. / Ultimate party name of the Creditor. To change payment details, use Amend Mandate payment terms." [spec]. Not deprecated.
- Path params: `mandateId` — string (uuid), required, "Mandate identifier" [spec].
- Request body (required): `AmendMandateByInitiatorRequestBody`, `required: ["creditorAccountId"]` [spec]:

  | field | type | required | notes |
  |---|---|---|---|
  | `creditorAccountId` | string (uuid) | yes | "The identifier of the creditor account." |
  | `ultimatePartyName` | string | no | "Creditor's ultimate party name. Optional, overrides platform creditor's name." |

- Response `200 Success`: `GenericMessage` [spec]. Errors: standard.
- Behaviour:
  - Unilateral amendment: applied immediately, no Payer authorisation [spec]. Creates an action `type: AMEND`, `bilateral: false`, `status: COMPLETED` [inferred from action-status description "A unilateral action has been performed"].
  - Preconditions [docs:payto-staging-testing-suite]: the new creditor account "should be in `ACTIVE` status and belong to the same account holder. Otherwise, an error will be returned that data validation hasn't passed." Exact code/message not given (`[inferred]` 422).
  - After success, "Provided data should be reflected when information about the mandate Creditor is fetched" (getMandate) [docs:payto-staging-testing-suite].
  - Mandate status precondition is not stated [open, §7].
- Webhooks: the Payer receives `MAMN` ("Mandate Amended") for unilateral amendments [docs:payto-notifications table lists MAMN → Initiator; the mock Payer trigger list also includes `MAMN`]. `[inferred]` counterparty gets `MAMN`.

### GET /v1/payto/initiator/mandates/{mandateId}/actions (getMandateActionsByInitiator)

- Purpose: "Get Mandate Actions by Initiator" — "Retrieve a selection of the actions performed on a mandate" [spec]. Not deprecated.
- Path params: `mandateId` — string (uuid), required, "Mandate ID".
- Query params [spec]:
  - `pendingOnly` — boolean, optional, "Whether only pending actions will be included in the result".
  - `from` — string, optional, pattern = strict ISO-8601 UTC datetime `YYYY-MM-DDThh:mm:ss[.sss]Z` (regex in spec validates real calendar dates incl. leap years); "Optional timestamp defining the start of the time period of action history to be included in the result. If omitted, then this time defaults to the moment of mandate creation. If provided, then this must not be a time in the future. An ISODateTime whereby all time zoned values are UTC."
  - `to` — same pattern, optional; "...defaults to the current moment in time. If provided, then this must not be a time in the future."
- Request body: none.
- Response `200 Success`: `GetMandateActionsResponseBody` = `{ actions: GetMandateActionsActionDto[] }` — "List of actions for the requested history period." Full entity in §2 ("MandateAction"). Errors: standard.
- Behaviour:
  - Filter: actions with `creationEvent.time` in `[from, to]` [inferred]; `pendingOnly=true` → only `status: PENDING` [inferred from param description].
  - `from`/`to` in the future → error (400 `[inferred]`).
  - Read-only; no webhook.

### PATCH /v1/payto/initiator/mandates/{mandateId}/cancel (cancelMandateByInitiator)

- Purpose: "Cancel Mandate by Initiator" — "(For use by Initiator only) Cancel a mandate. Changes status to CNCD in the central Mandate Management Service." [spec]. Not deprecated.
- Path params: `mandateId` — string (uuid), required.
- Request body (**required** per spec, but has no required fields): `CancelMandateRequestBody` — "Body of a request to cancel mandate" [spec]:

  | field | type | required | enum (verbatim) |
  |---|---|---|---|
  | `reasonCode` | string | no | `["AC02","AC04","AC05","AC06","AC13","AG01","AG03","AM03","AM12","AM14","CTAM","CTCA","CTEX","MCFC","MCOC","MD07","MD08","MD09","MD16","MD17","MD20","MD21","MS02","MS03","MSUC","NARR","NOAS","RR04","SL01","SL11","SL12"]` — meanings in §2 "StatusChangeReasonCode" |
  | `reasonDescription` | string | no | "Mandate cancellation reason description." |

- Response `200 Success`: `GenericMessage`. Errors: standard.
- Behaviour:
  - Sets mandate `status` → `CANCELLED` (MMS `CNCD`) [spec]. Creates an action `type: STATUS_CHANGE`, `details.statusChange.change: CANCEL`, `status: COMPLETED` [inferred from action schema].
  - Allowed from-states: "Mandates can be cancelled from any other status they're in but canceling a mandate from `CREATED` status is not done by the Initiator" [docs:payto-staging-testing-suite] → Initiator may cancel from `ACTIVE` or `SUSPENDED`; from `CREATED` use `resolveMandateByInitiator` (recall) instead [inferred]. Cancelling an already-`CANCELLED` mandate: not stated [open, §7].
  - Non-existent `mandateId` → error ("To fail cancelation of a mandate, simply provide an ID of a mandate that doesn't exist") [docs:payto-staging-testing-suite]; code not shown (`[inferred]` 422 with `NOT_FOUND:` message, matching the one documented error shape).
  - Terminal: no operation moves a mandate out of `CANCELLED` [inferred — none is documented].
- Webhooks: `MSCH` ("Mandate Status Changed") to Payer & Initiator [docs:payto-notifications; docs:payto-staging-testing-suite "status changes to mandates should send a notifications to both Initiator and Payer with specific MSCH trigger"].

### GET /v1/payto/initiator/mandates/{mandateId}/instructions/{instructionId}/status (getMandatePaymentStatus)

- Purpose: "Get Payment instruction status by Mandate ID and Payment instruction ID" — "Get the status of a mandate payment initiation that was performed previously." [spec]. Not deprecated.
- Path params [spec]: `mandateId` — string (uuid), required, "Mandate ID"; `instructionId` — string, required, "Payment instruction ID" (the `instructionId` returned by makeAdhocPayment, e.g. `ANNCAU22XXXI20230801000000000079280`).
- Request body: none.
- Response `200 Success`: `GetMandatePaymentStatusResponseBody`, `required: ["transactionStatus","transactionStatusReasonCode"]` [spec]:

  | field | type | required | enum (verbatim) |
  |---|---|---|---|
  | `transactionStatus` | string, `minLength: 1` | yes | `["RECEIVED","UNDELIVERED","SENT","STORE_AND_FORWARD","ACCEPTED_FOR_CLEARANCE","SETTLEMENT_ABORTED","ACCEPTED_AND_SETTLED","REJECTED","PENDING"]` |
  | `transactionStatusReasonCode` | string, `minLength: 1` | yes | "Reject reason code, defining the reason for the transaction status." (ISO/NPP code such as `AB01`; see §2 "PaymentReasonCode") |

  Documented example responses show only `{"transactionStatus":"UNDELIVERED"}` / `{"transactionStatus":"REJECTED"}` — i.e. `transactionStatusReasonCode` **absent** despite being `required` [docs:payto-staging-testing-suite]. Treat it as optional in practice [inferred].
- Errors: standard.
- Behaviour:
  - Polling endpoint for non-final statuses [docs:payto-payment; docs:status-transitions "Further action" column].
  - Availability window: "This is only available for 15 days from the instruction date after which point the payment instruction will be archived by the MMS." [docs:payto-payment]. Behaviour after 15 days is not stated [open, §7].
  - Unknown `instructionId`/`mandateId` pair → error; code not stated (`[inferred]` 422 `NOT_FOUND:`).
  - Read-only; no webhook.

### PATCH /v1/payto/initiator/mandates/{mandateId}/payment_terms (amendMandatePaymentTerms)

- Purpose: "Amend Mandate payment terms" — "(For use by Initiator only)" [spec]. Not deprecated.
- Path params: `mandateId` — string (uuid), required.
- Request body (required): `AmendMandatePaymentTermsRequestBody` — "Body of a request to amend mandate payment terms." No `required` list [spec]:

  | field | type | required | notes |
  |---|---|---|---|
  | `paymentTerms` | object `CreatePaymentTermsDto` | no | same shape as in createMandate (its own `required: ["frequency","type"]` applies when present) |
  | `resolutionRequestedBy` | string | no | "Date time in UTC format yyyy-MM-dd'T'hh:mm:ss.sss'Z' e.g. 2023-09-10T10:00:00.000Z (Optional)." |
  | `validityEndDate` | string (date) | no | "The date when the mandate stops being valid." |

- Response `200 Success`: `GenericMessage`. Errors: standard.
- Behaviour:
  - **Bilateral** amendment requiring Payer authorisation: the spec's `resolveMandateByPayer` is "Authorise an amend that has been requested by an Initiator" and `resolveMandateByInitiator` "Recalls a new mandate or mandate amendment that has not yet been authorised by the Payer" [spec]; docs: "Amend PayTo agreements (including obtaining authorisation from the Debtor if necessary)" [docs:payto]; "For a bilateral amend action..." [docs:payto-notifications]. Creates an action `type: AMEND`, `bilateral: true`, `status: PENDING`, with `expiryTime` [inferred from action schema]. Payer `ACCEPT` → action `COMPLETED`, terms applied (`MAMC` to Initiator); `REJECT` → `DECLINED` (`MAMD`); no answer → `TIMED_OUT` (`MAMX` to both) [docs:payto-notifications].
  - Effect on schedule: "If there is an uninitiated scheduled payment for a mandate where payment terms have been amended then that scheduled payment is replaced by a new one which bases its content on new data" — triggered when the `MAMC` (amend confirmed) notification is received [docs:payto-staging-testing-suite].
  - Mandate status precondition and whether `frequency`/`type` may change are not stated [open, §7].
  - Whether the mandate's `paymentTerms` shown by getMandate change before the Payer accepts is not stated; `[inferred]` no — the pending action's `details.amendment` holds the proposed values until `COMPLETED`.
- Webhooks: Payer gets `MAMP` ("Mandate Amend Proposed"); Initiator later gets `MAMC` / `MAMD`; both get `MAMX` on expiry [docs:payto-notifications].

### PATCH /v1/payto/initiator/mandates/{mandateId}/payments/amount (setScheduledPaymentInitiationRequestAmount)

- Purpose: "Set amount of Scheduled Payment Initiation Request by Initiator" — "Allows to set Scheduled Payment Initiation Request amount for USAGE_BASED and VARIABLE mandates." [spec]. Not deprecated.
- Path params: `mandateId` — string (uuid), required.
- Request body (required): `SetScheduledPaymentInitiationAmountRequestBody` — "Body of a request to set mandate scheduled payment amount." `required: ["amount","notificationId"]` [spec]:

  | field | type | required | notes |
  |---|---|---|---|
  | `amount` | object `CurrencyAmount` | yes | `{amount: number, currency: string}` |
  | `notificationId` | string (uuid) | yes | "Notification identifier." — matches `MandateDuePaymentEventDto.notificationId` from the `MANDATE_DUE_PAYMENT` webhook [webhook-spec; link inferred from the shared field name] |

- Response `200 Success`: `GenericMessage`. Errors: standard.
- Behaviour:
  - Only meaningful for mandates with `paymentTerms.type` `USAGE_BASED` or `VARIABLE` [spec]. Other types → error (`[inferred]` 422).
  - Flow `[inferred]` from field names: Shaype schedules the next payment for a non-ADHOC `ACTIVE` mandate → sends `MANDATE_DUE_PAYMENT` `{mandateId, notificationId, paymentDateTimeUtc}` → client sets the amount for that scheduled PIR via this endpoint before `paymentDateTimeUtc` → Shaype initiates the PIR automatically at the due time. Lead time, what happens if no amount is set, and whether `amount` must be ≤ `paymentTerms.maximumAmount` are not stated [open, §7].
  - Not exercised by the staging mocks (no doc section) [docs:payto-staging-testing-suite].
- Webhooks: none stated. The eventual payment produces `MANDATE_PAYMENT` [docs:payto-notifications "sent for all payment instructions when the final status is known"].

### PATCH /v1/payto/initiator/mandates/{mandateId}/release (releaseMandateByInitiator)

- Purpose: "Release Mandate by Initiator" — "(For use by Initiator only) Unsuspend a mandate" [spec]. Not deprecated.
- Path params: `mandateId` — string (uuid), required.
- Request body: none [spec].
- Response `200 Success`: `GenericMessage`. Errors: standard.
- Behaviour:
  - Precondition: mandate `status` must be `SUSPENDED`; otherwise error with message `Validation of the request for releasing mandate with id: {mandate_id} failed. To release a mandate it must be in suspended status.` [docs:payto-staging-testing-suite]. HTTP code not shown (`[inferred]` 422).
  - State change: `SUSPENDED` → `ACTIVE` [docs:payto-staging-testing-suite "mandates can be released only when suspended"; target state inferred from "Unsuspend"]. Creates action `type: STATUS_CHANGE`, `change: RELEASE`, `status: COMPLETED` [inferred].
  - Whether an Initiator can release a mandate suspended **by the Payer** (cx status `PAUSED_BY_CUSTOMER`) is not stated [open, §7].
- Webhooks: `MSCH` to Payer & Initiator [docs:payto-notifications].

### PATCH /v1/payto/initiator/mandates/{mandateId}/resolve (resolveMandateByInitiator)

- Purpose: "Resolve Mandate by Initiator" — "(For use by Initiator only) Recalls a new mandate or mandate amendment that has not yet been authorised by the Payer" [spec]. Not deprecated. **No `resolution` query param** (unlike the Payer variant) [spec].
- Path params: `mandateId` — string (uuid), required.
- Request body: none.
- Response `200 Success`: `GenericMessage`. Errors: standard.
- Behaviour:
  - "This endpoint serves to recall a bilateral action which hasn't been yet confirmed by Payer (is pending)" [docs:payto-staging-testing-suite]. Target: the mandate's `PENDING` bilateral action (`CREATE` or `AMEND`) → `status: RECALLED` [inferred from action-status enum "RECALLED: Action has been recalled"].
  - Recalling a `CREATE` action: resulting mandate `status` is not documented (`CANCELLED` `[inferred]` — the cx status enum has `CANCELLED_BY_PAYMENT_INITIATOR`) [open, §7]. Recalling an `AMEND`: mandate keeps its current terms [inferred].
  - No pending action → error; code/message not stated (`[inferred]` 422).
  - Which action is recalled when both a pending CREATE and AMEND exist is undefined (a `CREATED` mandate presumably cannot have an amend pending) [open, §7].
- Webhooks: `MCRR` (create recalled) or `MAMR` (amend recalled) to the Payer [docs:payto-staging-testing-suite "Actions which are available for recall right now on production are respectively mandate creation (trigger: MCRR) and bilateral amendment (trigger: MAMR)"].

### GET /v1/payto/initiator/mandates/{mandateId}/search (searchPaymentsInstructions)

- Purpose: "Search payments instructions by Mandate ID" (no description) [spec]. Not deprecated.
- Path params: `mandateId` — string (uuid), required, "Mandate identifier".
- Query params: **none** — no date range, status or paging filters [spec].
- Request body: none.
- Response `200 Success`: `PaymentInstructionsSummaryResponseBody` = `{ paymentInstructions: PaymentInstruction[] }` — "Payments instructions data." [spec]. `PaymentInstruction` — "Details of payment instruction", no required list:

  | field | type | enum / notes |
  |---|---|---|
  | `amount` | number | "The value of payment instruction amount" |
  | `creationDateTime` | string (date-time) | "DateTime in UTC format of payment instruction creation" |
  | `endToEndId` | string | "End to end payment instruction identification" |
  | `id` | string | "Unique identifier of the payment instruction" (= `instructionId`) |
  | `transactionStatus` | string | enum `["RECEIVED","UNDELIVERED","SENT","STORE_AND_FORWARD","ACCEPTED_FOR_CLEARANCE","SETTLEMENT_ABORTED","ACCEPTED_AND_SETTLED","REJECTED","PENDING"]` |
  | `transactionStatusReasonCode` | string | "Status Reason Information Reason Code. Reject reason code, defining the reason for the transaction status." |

  Example: `{"paymentInstructions":[{"id":"ANNCAU22XXXI20231129000000000093410","amount":1.28,"creationDateTime":"2023-11-29T12:33:59.833Z","transactionStatus":"RECEIVED","transactionStatusReasonCode":"AB01","endToEndId":"NET-1724"}]}` [docs:payto-staging-testing-suite].
- Errors: standard.
- Behaviour:
  - Lists all payment instructions (adhoc and scheduled) of the mandate — "Client can also use Search payments instructions by Mandate ID - especially for fixed frequency payments" [docs:payto-payment].
  - The underlying MMS data uses 4-letter codes (`RECV`,`UNDV`,`SENT`,`SAFD`,`ACCP`,`ACSP`,`ACSC`,`RJCT`) which the API maps to the long enum (`RECV`→`RECEIVED`) [docs:payto-staging-testing-suite stub example; spec `PaymentInstructionSummary`]. Mapping table in §4.
  - `endToEndId` defaults to `"Not provided"` when the client gave none [docs:payto-staging-testing-suite].
  - Ordering and the 15-day MMS archive window are not stated for this endpoint [open, §7].
  - Read-only; no webhook.

### PATCH /v1/payto/initiator/mandates/{mandateId}/suspend (suspendMandateByInitiator)

- Purpose: "Suspend Mandate by Initiator" — "(For use by Initiator only) Suspends a mandate - places it on pause so cannot be actioned. Can be unsuspended using Release Mandate by Initiator." [spec]. Not deprecated.
- Path params: `mandateId` — string (uuid), required.
- Request body (**required**, no required fields): `SuspendMandateRequestBody` — "Body of a request to suspend mandate" [spec]:

  | field | type | required | enum |
  |---|---|---|---|
  | `reasonCode` | string | no | same 31-value list as `CancelMandateRequestBody.reasonCode` (verbatim identical enum) |
  | `reasonDescription` | string | no | "Mandate suspension reason description." |

- Response `200 Success`: `GenericMessage`. Errors: standard.
- Behaviour:
  - Precondition: `status` must be `ACTIVE`; otherwise message `Validation of the request for suspension mandate with id: {mandate_id}: To suspend a mandate it must be in active status.` [docs:payto-staging-testing-suite]. Code not shown (`[inferred]` 422).
  - State change: `ACTIVE` → `SUSPENDED`; action `STATUS_CHANGE`/`SUSPEND`/`COMPLETED` [inferred].
  - "places it on pause so cannot be actioned" [spec] → makeAdhocPayment on a `SUSPENDED` mandate should fail, and scheduled payments should not fire [inferred].
- Webhooks: `MSCH` to Payer & Initiator [docs:payto-notifications].

### GET /v1/payto/mandates (getMandates)

- Purpose: "Get Mandates by debtor account numbers" — "(For use by Payer only) Uses underlying Cuscal Search Mandates mechanism. This is a mandate cache and doesn't call the MMS directly. Cuscal restricts data to the Payer only - so not possible for Initiator to use this. Only mandates where the debtor party has one of the provided account numbers will be returned" [spec]. Not deprecated.
- Query params [spec]:
  - `accountIds` — array of string, **required**, "Account numbers". Despite the name, the description and summary say account **numbers** (BSB+account, cf. `debtorDetails.accountNumber`), not platform UUIDs [spec wording; exact format open, §7]. Serialisation style not declared (OpenAPI default `form`/`explode=true` → `accountIds=x&accountIds=y`) [spec default].
  - `statuses` — array of string, optional, items enum `["CREATED","ACTIVE","SUSPENDED","CANCELLED"]`, "Mandate status".
  - `pageNumber` — integer (int32), **required**, `minimum: 1`, "Page number" (1-based).
  - `pageSize` — integer (int32), **required**, `minimum: 1`, `maximum: 50`, "Page size".
- Request body: none.
- Response `200 Success`: `GetMandatesResponseBody`, `required: ["result","totalCount"]` = `{ result: GetMandateSummaryDto[] ("List of mandates on the given page."), totalCount: integer int32 ("Count of all matching mandates.") }` [spec]. `GetMandateSummaryDto` — "Details of a mandate.", `required: ["mandateId","paymentTerms","purposeCode","status"]`:

  | field | type | required | enum / notes |
  |---|---|---|---|
  | `debtorAccountId` | string (uuid) | no | "The system identifier of the debtor account, if determined." |
  | `description` | string | no | |
  | `mandateId` | string (uuid) | yes | |
  | `paymentTerms` | object `GetPaymentTermsSummaryDto` | yes | `{amount?: CurrencyAmount, frequency: enum (required), maximumAmount?: CurrencyAmount}` — **no `type`** in the summary |
  | `purposeCode` | string | yes | 12-value enum as createMandate |
  | `status` | string | yes | enum `["CREATED","ACTIVE","SUSPENDED","CANCELLED"]` |
  | `validityEndDate` | string (date) | no | |

- Errors: standard.
- Behaviour:
  - Payer-only; an Initiator caller is refused [spec] (code `[inferred]` 403).
  - Filter: `debtorDetails.accountNumber ∈ accountIds` AND (if given) `status ∈ statuses` [spec description]; paginate; `totalCount` = count before paging [spec].
  - Served from a cache, not the MMS — may lag getMandate [spec]. Ordering not stated [open, §7].
  - Read-only; no webhook.

### GET /v1/payto/mandates/{mandateId} (getMandate)

- Purpose: "Get Mandate by ID" — "Can be used by either Initiator or Payer, as long as they are party to the mandate (either created the mandate or authorised it as debtor) Direct MMS Get Mandate call. Only supports one Mandate ID per call. NPPA doesn't recommend caching data in applications as it may end up out of date - client should call this endpoint each time the mandate data needs to be displayed." [spec]. Not deprecated.
- Path params: `mandateId` — string (uuid), required, "Mandate ID".
- Request body: none.
- Response `200 Success`: `GetMandateResponseBody` — full entity in §2 ("Mandate"). `required: ["debtorDetails","mandateId","paymentTerms","registrationDateTime","status","validityStartDate"]` [spec]. Errors: standard.
- Behaviour:
  - Authorisation: caller must be a party (creditor-side creator or debtor) [spec]; otherwise error (`[inferred]` 403).
  - Unknown id → error (`[inferred]` 422 `NOT_FOUND:` per the documented error shape).
  - Reflects unilateral amendments immediately [docs:payto-staging-testing-suite].
  - Read-only; no webhook.

### PUT /v1/payto/payer/mandates/{mandateId} (amendMandateByPayer)

- Purpose: "Amend Mandate by Payer" — "(For use by Payer only) Amend the bank details of a mandate. Must be an account belonging to the same holder. The amend will be processed immediately without Initiator authorisation being required. Allowed fields: Debtor Account ID (Shaype platform ID). This will change the source of mandate payments to another account in the Shaype platform." [spec]. Not deprecated.
- Path params: `mandateId` — string (uuid), required.
- Request body (required): `AmendMandateByPayerRequestBody`, `required: ["debtorAccountId"]` = `{ debtorAccountId: string (uuid) "The identifier of the debtor account." }` [spec].
- Response `200 Success`: `GenericMessage`. Errors: standard.
- Behaviour [docs:payto-staging-testing-suite]:
  - "the only thing that is allowed is to amend it to change account from which payment amount is debited".
  - Preconditions: new account "must belong to same account holder of previous account"; "new account must be in `ACTIVE` status within the platform"; "the mandate itself must be in either `ACTIVE` or `SUSPENDED` status". Violations → error (message/code not given; `[inferred]` 422).
  - Unilateral: applied immediately; action `AMEND`/`bilateral: false`/`COMPLETED` [inferred].
- Webhooks: Initiator receives `MAMN` ("Mandate Amended") [docs:payto-notifications table: MAMN → Initiator].

### GET /v1/payto/payer/mandates/{mandateId}/actions (getMandateActionsByPayer)

- Purpose: "Get Mandate Actions by Payer" — "Retrieve a selection of the actions performed on a mandate" [spec]. Not deprecated.
- Path/query params, response, behaviour: **identical to getMandateActionsByInitiator** (`mandateId`; `pendingOnly`, `from`, `to`; `GetMandateActionsResponseBody`) [spec — the two operation objects differ only in path and operationId]. Role check differs: caller must be the debtor party [inferred].

### PATCH /v1/payto/payer/mandates/{mandateId}/cancel (cancelMandateByPayer)

- Purpose: "Cancel Mandate by Payer" — "(For use by Payer only) Cancel a mandate. Changes status to CNCD in the central Mandate Management Service." [spec]. Not deprecated.
- Path params: `mandateId`; Request body (required): `CancelMandateRequestBody` (same as Initiator variant) [spec].
- Response `200`: `GenericMessage`. Errors: standard.
- Behaviour: "This endpoint works using the same principles as those for cancelation of a mandate from the Initiator's side." [docs:payto-staging-testing-suite]. Whether a Payer may cancel from `CREATED` (i.e. decline via cancel rather than `resolveMandateByPayer?resolution=REJECT`) is not stated [open, §7]. Status → `CANCELLED`; action `STATUS_CHANGE`/`CANCEL` [inferred]. Cx status `CANCELLED` (vs `CANCELLED_BY_PAYMENT_INITIATOR` for the Initiator variant) [inferred from the cx enum].
- Webhooks: `MSCH` to both parties [docs:payto-notifications]; docs:payto-notifications also lists "PayTo agreement status changes made by the Debtor (suspended, released, cancelled)" as notifications the Initiator receives.

### PATCH /v1/payto/payer/mandates/{mandateId}/release (releaseMandateByPayer)

- Purpose: "Release Mandate by Payer" — "(For use by Payer only) Unsuspend a mandate." [spec]. Not deprecated.
- Path params: `mandateId`. Request body: none.
- Response `200`: `GenericMessage`. Errors: standard.
- Behaviour: "release can be called only for mandates in `SUSPENDED` status. Doing so for mandates with different status will result in an error, in line with the production environment." [docs:payto-staging-testing-suite]. Message `[inferred]` same text as the Initiator variant. `SUSPENDED` → `ACTIVE` [inferred]. Whether the Payer can release a suspension made by the Initiator (`PAUSED_BY_PAYMENT_INITIATOR`) is not stated [open, §7].
- Webhooks: `MSCH` to both [docs:payto-notifications].

### PATCH /v1/payto/payer/mandates/{mandateId}/resolve (resolveMandateByPayer)

- Purpose: "Resolve Mandate pending action by Payer" — "(For use by Payer only) Authorise an amend that has been requested by an Initiator." [spec]. Docs widen it: "this action is used by Payer to confirm either mandate creation or bilateral amendment of a mandate" and it is used to "simulate a reject action taken by Payer" on a `CREATED` mandate [docs:payto-staging-testing-suite]. Not deprecated.
- Path params: `mandateId` — string (uuid), required.
- Query params: `resolution` — string, **required**, enum `["ACCEPT","REJECT"]` — "Mandate resolution: ACCEPT: Mandate accepted / REJECT: Mandate rejected" [spec]. "Do not confuse this endpoint with the one used for mandate action recall, as this one requires query parameter to be added in the URL." [docs:payto-staging-testing-suite].
- Request body: none.
- Response `200 Success`: `GenericMessage` — documented value `{"message":"Mandate resolved successfully."}` [docs:payto-staging-testing-suite]. Errors: standard; "it can be used on a non-existing mandate to check if expected error is returned" [docs:payto-staging-testing-suite] (code not shown; `[inferred]` 422 `NOT_FOUND:`).
- Behaviour:
  - Resolves the mandate's `PENDING` bilateral action [spec + docs]:
    - `ACCEPT` on a `CREATE` action → action `COMPLETED`, mandate `CREATED` → `ACTIVE`, next payment scheduled for non-ADHOC mandates; Initiator notified `MCRC` [docs:payto-staging-testing-suite "when mandate creation proposal is accepted by the other party, the mandate status is switched to ACTIVE and a new scheduled payment is created"].
    - `REJECT` on a `CREATE` action → action `DECLINED`; Initiator notified `MCRD` / `PCRD` [docs:payto-notifications; docs:payto-staging-testing-suite]. Resulting mandate status not documented (`CANCELLED` `[inferred]`).
    - `ACCEPT` on an `AMEND` action → `COMPLETED`, new terms applied, Initiator `MAMC`, uninitiated scheduled payment replaced [docs:payto-staging-testing-suite].
    - `REJECT` on an `AMEND` action → `DECLINED`, Initiator `MAMD` [docs:payto-notifications].
  - `resolutionEvent.reasonCode` (bilateral resolution reason, 17-value enum in §2) may be recorded on the action, but this endpoint offers no way to supply one [spec]. 
  - No pending action → error (`[inferred]` 422).
- Webhooks: `MCRC`/`MCRD`/`MAMC`/`MAMD` to the Initiator [docs:payto-notifications]; `MSCH` if the status changes [inferred].

### PATCH /v1/payto/payer/mandates/{mandateId}/suspend (suspendMandateByPayer)

- Purpose: "Suspend Mandate by Payer" — "(For use by Payer only) Suspend (pause) a mandate without cancelling it" [spec]. Not deprecated.
- Path params: `mandateId`. Request body (required): `SuspendMandateRequestBody` (same as Initiator variant) [spec].
- Response `200`: `GenericMessage`. Errors: standard.
- Behaviour: "Only mandates in `ACTIVE` status can be suspended. Validations for mock solutions are same as production environments and trying to suspend mandate with a status other than `ACTIVE` will return an error." [docs:payto-staging-testing-suite]. `ACTIVE` → `SUSPENDED`; cx status `PAUSED_BY_CUSTOMER` [inferred from cx enum].
- Webhooks: `MSCH` to both [docs:payto-notifications].

### POST /v1/payto/payments/adhoc (makeAdhocPayment)

- Purpose: "Make Adhoc Payment" — "(For use by Initiator only) Trigger a Payment Initiation Request to the Payer side. Currently in Staging this does not result in a transaction, the client should just check for a 200 response (but will receive a RJCT PSR notification)" [spec]. "AdHoc payments only – scheduled payments will be initiated automatically by Shaype" [docs:payto-payment]. Not deprecated.
- Path/query params: none.
- Request body (required): `MakeAdhocPaymentRequestBody` — "Body of a request to make adhoc payment." `required: ["idempotencyKey","mandateId"]` [spec]:

  | field | type | required | constraints | notes |
  |---|---|---|---|---|
  | `amount` | object `CurrencyAmount` | no (spec) | `{amount: number, currency: enum}` | every documented example supplies it [docs:payto-staging-testing-suite]; behaviour when absent not stated [open, §7] |
  | `description` | string | no | | "Payment description." |
  | `endToEndId` | string | no | `minLength: 1`, `maxLength: 35` | "End to end payment identification." Defaults to `"Not provided"` when omitted [docs:payto-staging-testing-suite] |
  | `idempotencyKey` | string (uuid) | yes | | "Idempotency key generated by the client of the API. Used for request duplication check." |
  | `mandateId` | string (uuid) | yes | | "Mandate identifier" |

- Response `200 Success`: `MakeAdhocPaymentResponseBody` — "Adhoc payment response.", `required: ["instructionId","mandateId","message","transactionStatus","transactionStatusDisplay"]` [spec]:

  | field | type | required | notes |
  |---|---|---|---|
  | `instructionId` | string, `minLength: 1` | yes | "Payment instruction identifier" — e.g. `ANNCAU22XXXI20230718000000000077240` (format in §4) |
  | `mandateId` | string (uuid) | yes | |
  | `message` | string | yes | documented value `"Adhoc payment executed successfully."` (returned even when `transactionStatus` is `REJECTED`) [docs:payto-staging-testing-suite] |
  | `statusIsFinal` | boolean | no | "Transaction status final flag" |
  | `transactionStatus` | string | yes | enum `["RECEIVED","UNDELIVERED","SENT","STORE_AND_FORWARD","ACCEPTED_FOR_CLEARANCE","SETTLEMENT_ABORTED","ACCEPTED_AND_SETTLED","REJECTED","PENDING"]` |
  | `transactionStatusDisplay` | string | yes | "Transaction status display value" — documented pairs: `SENT`→`"Sent"`, `STORE_AND_FORWARD`→`"Store & Forward"`, `RECEIVED`→`"Received"`, `REJECTED`→`"Rejected"` [docs:payto-staging-testing-suite] |

  Example: `{"mandateId":"1212c23a-255c-11ee-9a8e-5d3239591cd9","instructionId":"ANNCAU22XXXI20230718000000000077240","transactionStatus":"SENT","transactionStatusDisplay":"Sent","statusIsFinal":false,"message":"Adhoc payment executed successfully."}` [docs:payto-staging-testing-suite].
- Errors: standard.
- Behaviour [docs:payto-payment]:
  1. Client sends the Mandate Payment Initiation Request (MAPAIN) — "This step is for Ad Hoc payments only".
  2. "Shaype confirms the request is consistent with the PayTo agreement in the MMS." Which checks (mandate `ACTIVE`, `frequency == ADHOC`, `amount ≤ maximumAmount`, within validity dates, currency AUD) are not enumerated [open, §7].
  3. PIR sent to the Debtor's bank via NPP; the Debtor bank responds by sending an NPP payment to the creditor account.
  4. "Shaype returns this outcome to the Initiator client in the Make Adhoc Payment endpoint response. Most of the time it is 'final'. It may also show a 'non-final' status."
  5. Non-final → poll getMandatePaymentStatus (15-day window), or searchPaymentsInstructions, or wait for the `MANDATE_PAYMENT` webhook.
  - Synchronous wait: the call blocks up to **15 seconds**; on the staging timeout scenario the response arrives "after a 15 second timeout" as `REJECTED`, `statusIsFinal: true` with underlying reason `RJCT AB01` ("Clearing process aborted due to timeout") [docs:payto-staging-testing-suite].
  - Ledger effect: the resulting NPP credit lands on the creditor account as a transaction with `originType: MANDATE_PAYMENT` and `mandatePaymentDetails {mandateId, instructionId, initiatingPartyName}` [webhook-spec `TransactionEventDto`; spec `FinancialTransaction.originType`]. When the debtor is also a platform account, the debit is a separate NPP outbound transaction (staging simulates it with RAPAIN `ACCP`, "amount is extracted in the same step") [docs:payto-staging-testing-suite]. `MandatePaymentEventDto.transactionHayId` is "null" when the payment status is rejected [webhook-spec].
  - Idempotency: `idempotencyKey` required, "Used for request duplication check" [spec]; replay behaviour undocumented [open, §7].
- Webhooks: `MANDATE_PAYMENT` ("Mandate Payment Event ... includes payment instruction ID, Mandate ID and final status. It is sent for all payment instructions when the final status is known") [docs:payto-notifications]; and a `TRANSACTION` event "with transaction event object that contain mandateId and Payment InstructionId" [docs:payto-payment].

### GET /v1/payto/supported-bsbs/{bsbNumber} (checkBsbIsSupportedByPayTo)

- Purpose: "Check if BSB supports PayTo" — "Use to check if a target Payer supports PayTo, before mandate creation" [spec]. Rationale: partial industry roll-out; "It is recommended that you check this for your target debtor customer before sending a mandate creation request." [docs:payto]. Not deprecated.
- Path params: `bsbNumber` — string, required, `pattern: ^\d{6}$`, "BSB Number" [spec].
- Request body: none.
- Response `200 Success`: `CheckPayToBsbSupportResponseBody` = `{ supported: boolean }` — "Informs if given BSB number is supported by PayTo." [spec]. Errors: standard.
- Behaviour:
  - Pure lookup, no state change, no webhook.
  - Non-6-digit path → 400 `[inferred]` (pattern violation).
  - Staging fixture: BSB `000000` ("000 000" in the docs) returns `{"supported": false}`; "For the debtor, any BSB can be used when creating a mandate" — createMandate does **not** enforce this check [docs:payto-staging-testing-suite].
