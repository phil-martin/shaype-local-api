# de-dd-scheduled

Domain: Direct Entry API, Direct Debits API, Scheduled Payments API of the Shaype B2B Operations API (spec title "B2B Operations API", version 0.0.1).

Source labels used throughout: `[spec]` = b2b-operations-api.json, `[spec:webhooks]` = notification-webhooks.json, `[spec:external-balance]` = external-balance.yaml, `[docs:<slug>]` = https://developer.shaype.com/docs/<slug>, `[inferred]` = my reading, not stated anywhere.

Global facts that apply to every operation below:

- The spec declares no `security` and no `securitySchemes`, and none of these operations declares header parameters [spec]. Auth is out of scope of this file (see the auth domain map).
- Every operation declares the same error set: `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content`, `500 Internal Server Error`, `501 Not Implemented`, all with body `ErrorResponse` [spec] — with one exception: `createDirectDebitV0` returns `DirectDebitResponse` on 422 ("Invalid Input") [spec]. **No operation declares a 404** [spec]; what happens for an unknown id is undefined (see section 7).
- The reference pages (developer.shaype.com/reference/<operationId>.md) for all 10 operations contain only the OpenAPI subset, no extra prose (verified by fetching each) — except `createdirectdebitv0`, which repeats the deprecation notice.
- Operation count in this domain: **10** (3 Scheduled Payments, 6 Direct Debits, 1 Direct Entry), verified with the ops.json filter.

## 1. Operations

### GET /v0/accounts/{accountId}/scheduledPayments (getScheduledPayments)

- Purpose: list every scheduled/recurring payment definition of an Account [spec]. Not deprecated.
- Tag: `Scheduled Payments API` ("Set of APIs related to managing Scheduled and Recurring Payments") [spec].
- Path params:
  - `accountId` — string, format `uuid`, required. "Unique identifier (UUID) of the Account" [spec].
- Query params: none [spec].
- Request body: none [spec].
- Response `200`: JSON **array** of `HayScheduledPayment` (full field list in section 2). Description "Success" [spec].
- Errors: 400 / 403 / 422 / 500 / 501 → `ErrorResponse` [spec].
- Behaviour:
  - Returns all schedules of the account "regardless of the status of the transaction" [docs:scheduled-payments] — i.e. CANCELLED / COMPLETED / DELETED / FAILED / REJECTED / REPLACED entries are included, not only ACTIVE [docs:scheduled-payments].
  - Read-only; no state change [inferred from method + docs].
  - No pagination, no filters [spec].
  - Response for an account with no schedules is presumably `[]` [inferred].
- Webhooks: none triggered [inferred — read-only].

### GET /v0/accounts/{accountId}/scheduledPayments/{paymentId} (getScheduledPaymentById)

- Purpose: fetch one scheduled/recurring payment definition by its id, scoped to an Account [spec]. Not deprecated.
- Path params:
  - `accountId` — string, format `uuid`, required. "Unique identifier (UUID) of the Account" [spec].
  - `paymentId` — string, format `uuid`, required. "Unique identifier (UUID) of the Scheduled Payment" [spec]. This is the `hayId` of `HayScheduledPayment` [inferred — `hayId` is described as "Unique identifier (UUID) of the payment schedule"].
- Query params: none. Request body: none [spec].
- Response `200`: `HayScheduledPayment` object [spec].
- Errors: 400 / 403 / 422 / 500 / 501 → `ErrorResponse` [spec]. No 404 declared [spec].
- Behaviour:
  - "retrieve payment details by paymentId for a specific accountId" [docs:scheduled-payments]. The `accountId` in the path is expected to match `HayScheduledPayment.accountId`; what is returned when it does not match is undefined (section 7).
  - Read-only [inferred].
- Webhooks: none [inferred].

### POST /v0/accounts/{accountId}/scheduledPayments/{paymentId}/cancel (cancelScheduledPayment)

- Purpose: cancel an existing scheduled/recurring payment definition [spec]. Not deprecated.
- Path params:
  - `accountId` — string, format `uuid`, required. NOTE: the spec's description for this param reads "Unique identifier (UUID) of the Scheduled Payment" — a copy/paste error; it is the Account id by path position and by analogy with the two GETs [spec, inferred].
  - `paymentId` — string, format `uuid`, required. "Unique identifier (UUID) of the Scheduled Payment" [spec].
- Query params: none. Request body: none [spec].
- Response `200`: `GenericMessage` — `{ "message": string }` ("Message indicating operation result"). The message text is not documented [spec].
- Errors: 400 / 403 / 422 / 500 / 501 → `ErrorResponse` [spec].
- Behaviour:
  - Sets the schedule's `status` to `CANCELLED`: the `status` enum description says CANCELLED is "triggered via 'Cancel Scheduled Payment' method" [spec].
  - "The transaction record will not be deleted, but a status will be applied to indicate it is no longer being used" [docs:scheduled-payments]. So the record remains visible via both GETs [docs:scheduled-payments].
  - Precondition: which statuses may be cancelled is not documented. Only `ACTIVE` is described as having outstanding future payments; cancelling a schedule already in a terminal status is undefined (section 7) [inferred].
  - No further payments are processed after cancellation [inferred from "no longer active" in the status description].
  - Idempotency: not documented [spec].
  - Side effects on balances: none — a schedule is a definition, not a transaction; already-processed transactions are unaffected [inferred].
- Webhooks: none documented for cancellation. The only scheduled-payment webhook type is `SCHEDULED_PAYMENT`, described as "Scheduled payment creation notification" [spec:webhooks].

### GET /v0/direct-debits (getDirectDebitsV0)

- Purpose: list outbound Direct Debit instructions by date range (v0 status model) [spec]. Not marked deprecated in the spec (only the v0 POST is), but v1 is the current model [spec, inferred].
- Tag: `Direct Debits API` ("Set of APIs related to managing outgoing Direct Debit instructions") [spec].
- Query params (all required unless stated) [spec]:
  - `fromUtc` — string, format `date`, required. "DateTime in UTC format for the start date range of the Transaction search" (description says DateTime, schema says `date`).
  - `toUtc` — string, format `date`, required. "DateTime in UTC format for the end date range of the Transaction search".
  - `offset` — integer (int32), required. "Offset used for paging results".
  - `limit` — integer (int32), required. "List fetch limit, value between 1 and 1000" (range stated in description only; no `minimum`/`maximum` in schema).
  - `status` — string, optional, enum `["ACCEPTED", "SUBMITTED", "RETURNED"]`. Description: "Status of the Direct Debits. Possible values: ACCEPTED: Direct Debit has been accepted and awaiting submission to next Direct Entry payment batch; RETURNED: Direct Debit has been Returned from recipient financial institution; SUBMITTED: Direct Debit has been accepted and submitted in Direct Entry payment batch". NOTE: `REJECTED` is a valid v0 outcome but is NOT an allowed filter value here [spec].
- Request body: none [spec].
- Response `200`: JSON array of `DeTransactionDetails` (v0 shape, section 2) [spec].
- Errors: 400 / 403 / 422 / 500 / 501 → `ErrorResponse` [spec].
- Behaviour:
  - Which date field the range is applied to (creation time vs `processingDate`) is not documented (section 7) [spec].
  - Whether `toUtc` is inclusive is not documented [spec].
  - Validation of `limit` outside 1..1000 and of `fromUtc > toUtc` → error code not documented; 400 or 422 [inferred].
  - Read-only [inferred].
- Webhooks: none [inferred].

### POST /v0/direct-debits (createDirectDebitV0)

- Purpose: initiate an outbound Direct Debit instruction (v0) [spec].
- **DEPRECATED**: `deprecated: true`; description "This endpoint is deprecated and will be removed in a future release. Use `/v1/direct-debits` instead." [spec]. Summary: "Create outbound Direct Debit (Deprecated)".
- Path/query params: none [spec].
- Request body (required): `CreateDirectDebitRequestBody` — identical to v1; see `createDirectDebitV1` below for the field table [spec].
- Response `200`: `DirectDebitResponse` (v0) [spec]:
  - `details` — string, optional. "Details of the outbound Direct Debit transfer".
  - `outcome` — string, **required**, enum `["ACCEPTED", "REJECTED", "SUBMITTED", "RETURNED"]`. Descriptions: ACCEPTED "accepted and awaiting submission to next Direct Entry payment batch"; REJECTED "has been rejected and has not been submitted in Direct Entry payment batch"; RETURNED "has been Returned from recipient financial institution"; SUBMITTED "accepted and submitted in Direct Entry payment batch".
  - `traceId` — string, optional. "Unique identifier (UUID) of the request used by Shaype to troubleshoot".
  - `transactionDetails` — `DeTransactionDetails` (v0), optional.
  - `transactionId` — string uuid, **required**. "Unique identifier (UUID) of the Transaction".
- Response `422` ("Invalid Input"): body is `DirectDebitResponse`, NOT `ErrorResponse` [spec]. So a validation failure on v0 is expected to come back as a `DirectDebitResponse` with `outcome: "REJECTED"` and `details` explaining why [inferred — the schema is the only thing stated].
- Errors: 400 / 403 / 500 / 501 → `ErrorResponse` [spec].
- Behaviour: same as v1 (below) except the outcome vocabulary is the 4-value v0 set [spec]. Implementer note: a cleanroom server should treat v0 as a thin facade over the v1 record, mapping v1 `RECEIVED` → ? and `COMPLETE`/`INCOMPLETE` → ? — no mapping is documented (section 7) [inferred].
- Webhooks: as v1 [docs:direct-debits].

### GET /v0/direct-debits/{transactionId} (getDirectDebitV0)

- Purpose: fetch one outbound Direct Debit by id (v0 shape) [spec]. Not marked deprecated in spec.
- Path params:
  - `transactionId` — string, format `uuid`, required. "Unique identifier (UUID) of the Transaction" [spec].
- Query: none. Body: none [spec].
- Response `200`: `DirectDebitResponse` (v0 — fields as in `createDirectDebitV0`) [spec].
- Errors: 400 / 403 / 422 / 500 / 501 → `ErrorResponse` [spec]. No 404 declared.
- Behaviour: read-only lookup by the `transactionId` that the client supplied at creation [spec, inferred]. Unknown id → error code undefined (section 7).
- Webhooks: none [inferred].

### GET /v1/direct-debits (getDirectDebitsV1)

- Purpose: list outbound Direct Debit instructions by date range (v1 status model) [spec]. Not deprecated. Docs: "API to retrieve the direct debit transaction details by date." [docs:direct-debits]
- Query params [spec]:
  - `fromUtc` — string, format `date`, required. "DateTime in UTC format for the start date range of the Transaction search".
  - `toUtc` — string, format `date`, required. "DateTime in UTC format for the end date range of the Transaction search".
  - `offset` — integer (int32), required. "Offset used for paging results".
  - `limit` — integer (int32), required. "List fetch limit, value between 1 and 1000" (description only).
  - `status` — string, optional, enum `["RECEIVED", "ACCEPTED", "REJECTED", "SUBMITTED", "RETURNED", "COMPLETE", "INCOMPLETE"]`. Descriptions verbatim: RECEIVED "Direct Debit request received for processing"; ACCEPTED "Direct Debit has been accepted and awaiting submission to next Direct Entry payment batch"; REJECTED "Direct Debit request failed validation or authorization and can't be executed"; SUBMITTED "Direct Debit has been accepted and submitted in Direct Entry payment batch"; RETURNED "Direct Debit request failed and was returned from the recipient financial institution. This direct debit cannot be executed"; COMPLETE "Direct Debit request was successful and customer account credited successfully"; INCOMPLETE "Direct Debit request was successful, but customer account crediting failed".
  - `senderAccountNumber` — string, optional. "Sender Account Number" (filter on the account to be credited) [spec].
- Request body: none [spec].
- Response `200`: JSON array of `DeTransactionDetailsV1` (section 2) [spec].
- Errors: 400 / 403 / 422 / 500 / 501 → `ErrorResponse` [spec].
- Behaviour: as `getDirectDebitsV0` — date field, inclusivity, limit validation undocumented [spec]. Read-only [inferred].
- Webhooks: none [inferred].

### POST /v1/direct-debits (createDirectDebitV1)

- Purpose: initiate an outbound Direct Debit instruction: pull funds from an external (recipient) BSB/account into a Shaype customer (sender) account via the Direct Entry/BECS system [spec, docs:direct-debits]. Not deprecated.
- Docs: "Leverage Create outbound Direct Debit API to initiate the Direct Debit with the sender and recipient account details." [docs:direct-debits]
- Path/query params: none [spec].
- Request body (required, `application/json`): `CreateDirectDebitRequestBody` — "A body of a request to initiate an outbound DD instruction." All 10 fields are **required** [spec]:

  | field | type | required | constraints | description (verbatim) |
  |---|---|---|---|---|
  | `amount` | number | yes | (none in schema; "to 2 decimal places") | "Value of the Direct Debit transfer, to 2 decimal places" |
  | `description` | string | yes | minLength 1, maxLength 18 | "Description on Direct Debit transfer, maximum 18 characters in length" |
  | `idempotencyKey` | string (uuid) | yes | format uuid | "Unique value (UUID) used to identify this request and used to recognise any subsequent retries" |
  | `recipientAccountNumber` | string | yes | pattern `\d{5,9}` | "Account Number of Account receiving Direct Debit instruction (account to be debited), 5-9 digits in length" |
  | `recipientBsb` | string | yes | pattern `\d{6}` | "BSB (Bank State Branch) of Account receiving Direct Debit instruction (account to be debited), 6 digits in length" |
  | `recipientName` | string | yes | minLength 1, maxLength 32 | "Name on the Account receiving Direct Debit instruction (account to be debited)" |
  | `senderAccountNumber` | string | yes | pattern `\d{5,9}` | "Account Number of Account sending Direct Debit instruction (account to be credited), 5-9 digits in length" |
  | `senderBsb` | string | yes | pattern `\d{6}` | "BSB (Bank State Branch) of Account sending Direct Debit instruction (account to be credited), 6 digits in length" |
  | `senderName` | string | yes | minLength 1, maxLength 16 | "Name on the Account sending Direct Debit instruction (account to be credited)" |
  | `transactionId` | string (uuid) | yes | format uuid | "Unique identifier (UUID) of the Transaction" |

  Direction semantics (important, and counter-intuitive): **sender = the account that will be CREDITED (the Shaype customer's account, addressed by BSB + account number, not by accountId); recipient = the external account that will be DEBITED** [spec descriptions]. The `transactionId` is **client-supplied** [spec]; the patterns are unanchored in the spec (`\d{5,9}`), so whether "1234567890" (10 digits) is rejected depends on anchoring — the description says "5-9 digits in length", so anchor them [spec, inferred].
- Response `200`: `DirectDebitResponseV1` — "Response of a request to create outbound Direct Debit instruction." [spec]:
  - `details` — string, optional. "Details of the outbound Direct Debit transfer".
  - `outcome` — string, **required**, enum `["RECEIVED", "ACCEPTED", "REJECTED", "SUBMITTED", "RETURNED", "COMPLETE", "INCOMPLETE"]` (same descriptions as the `status` filter above).
  - `traceId` — string, optional. "Unique identifier (UUID) of the request used by Shaype to troubleshoot".
  - `transactionDetails` — `DeTransactionDetailsV1`, optional (section 2).
  - `transactionId` — string uuid, **required**. "Unique identifier (UUID) of the Transaction".
- Errors: 400 / 403 / 422 / 500 / 501 → `ErrorResponse` [spec]. Unlike v0, 422 here is `ErrorResponse` ("Unprocessable Content") [spec].
- Behaviour:
  - Validation: field presence, lengths, digit patterns, uuid formats as in the table [spec]. Which failures produce HTTP 400 vs 422 vs a 200 with `outcome: "REJECTED"` is not documented (section 7). The REJECTED description ("failed validation or authorization and can't be executed") implies that at least some validation/authorisation failures surface as a 200 + REJECTED rather than an HTTP error [spec, inferred].
  - Immediately on creation the request is `RECEIVED`, then `ACCEPTED`; "A RECEIVED and ACCEPTED webhook will be sent synchronously" [docs:direct-debits]. So the 200 response `outcome` is expected to be `ACCEPTED` (or `REJECTED`) in the normal case [inferred from the synchronous wording].
  - Later, the instruction is placed in a Direct Entry batch → `SUBMITTED` ("SUBMITTED and COMPLETE status notification will arrive later") [docs:direct-debits].
  - "Shaype will monitor over 2 working days to catch if a Direct Debit is returned. A notification to the client will be sent making the transaction failure visible. Returns can be due to the external account being blocked or rejecting the request" → `RETURNED` [docs:direct-debits].
  - "After two working days the requested customer account is credited and a notification of the successful transaction is sent" → `COMPLETE`; the sender (Shaype) account balance is increased by `amount` at that point, not at creation [docs:direct-debits]. If the credit fails → `INCOMPLETE` ("customer account crediting failed") [spec].
  - "If DD is returned after crediting the account, then a case will be raised to investigate why this occurred and next steps communicated to the client." — no status is defined for this; manual process [docs:direct-debits].
  - "For outbound direct debits, there is a two-day period between the request and the transaction being credited to the customer's account." [docs:direct-debits]
  - Limits: the account limit type `DIRECT_DEBIT_PER_DAY` exists ("Maximum value of outgoing direct debit transfers" [spec]; "The maximum total value of outgoing cash from inbound direct debit requests that can be processed from an account in a single day" [docs:account-limits]) and the transaction outcome `REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED` ("Transaction declined as the daily direct debit DIRECT_DEBIT_PER_DAY limit has been exceeded") [docs:payment-transaction-outcome]. Whether that limit is applied to *this* (outbound-DD, credit-to-customer) flow or only to inbound DDs that debit the customer is contradictory between the two sources (section 7).
  - Idempotency: `idempotencyKey` is "used to recognise any subsequent retries" [spec]. Response for a retry with the same key (same 200 replayed? 409? new record?) is not documented (section 7). `transactionId` is also unique per transaction [spec]; behaviour on reuse of a `transactionId` with a different `idempotencyKey` is undocumented.
  - Account closure interaction: `closeAccount` (`POST /v0/accounts/{accountId}/close`) can fail with `ClosureCheckerError.type = INFLIGHT_OUTBOUND_DIRECT_DEBITS` [spec] — i.e. an account with outbound DDs not yet in a terminal state cannot be closed [inferred from the enum name; no description in spec].
- Webhooks [docs:direct-debits, spec:webhooks]:
  - `type: "DIRECT_ENTRY"` notification with `directEntryEvent: { transactionId, type: "DEBIT", direction: "OUTBOUND", status }` — one per status change; RECEIVED and ACCEPTED synchronously with the request, SUBMITTED and COMPLETE (and RETURNED / REJECTED / INCOMPLETE, by the statement "for each of the statuses in the diagram") later. "The DIRECT_ENTRY notification is about the request".
  - `type: "TRANSACTION"` notification with `transactionEvent.transactionType: "DIRECT_DEBIT_TRANSFER"` — "the DIRECT_DEBIT_TRANSFER is for the actual transaction with the transaction details". Note the docs' example for this event is described as "when external bank account pull funds from customer account using Direct Debit" with a negative `currencyAmount.amount` (-457.12), i.e. an *inbound* DD debiting the customer — the webhook for the credit leg of an *outbound* DD is not shown explicitly (section 7).

### GET /v1/direct-debits/{transactionId} (getDirectDebitV1)

- Purpose: fetch one outbound Direct Debit by id (v1 shape) [spec]. Not deprecated. Docs: "API to retrieve the direct debit transaction details by id." [docs:direct-debits]
- Path params:
  - `transactionId` — string, format `uuid`, required. "Unique identifier (UUID) of the Transaction" [spec].
- Query: none. Body: none [spec].
- Response `200`: `DirectDebitResponseV1` (fields as in `createDirectDebitV1`; `outcome` reflects the current status) [spec].
- Errors: 400 / 403 / 422 / 500 / 501 → `ErrorResponse` [spec]. No 404 declared.
- Behaviour: read-only; the `transactionId` is the one supplied by the client at creation [spec, inferred]. `transactionDetails.outcome` and top-level `outcome` are presumably always equal [inferred].
- Webhooks: none [inferred].

### GET /v1/direct-entry/{transactionId}/status (getDirectEntryStatusV1)

- Purpose: look up the status of a Direct Entry transaction by id [spec]. Not deprecated. Tag `Direct Entry API` ("Set of APIs related to Direct Entry transaction lookups") [spec]. This is the only operation in the Direct Entry tag.
- Path params:
  - `transactionId` — string, format `uuid`, required. "Unique identifier (UUID) of the Direct Entry Transaction" [spec].
- Query: none. Body: none [spec].
- Response `200`: `DirectEntryStatusResponseV1` — "Status response for a Direct Entry transaction lookup." [spec]:
  - `status` — string, **required**, enum `["RECEIVED", "ACCEPTED", "REJECTED", "SUBMITTED", "RETURNED", "COMPLETE", "INCOMPLETE"]`. Descriptions verbatim: RECEIVED "Direct Entry request received for processing"; ACCEPTED "Direct Entry has been accepted and awaiting submission to next Direct Entry payment batch"; REJECTED "Direct Entry request failed validation or authorisation and can't be executed"; SUBMITTED "Direct Entry has been accepted and submitted in Direct Entry payment batch"; RETURNED "Direct Entry request failed and was returned from the recipient financial institution. This Direct Entry cannot be executed"; COMPLETE "Direct Entry request was successful and customer account credited successfully"; INCOMPLETE "Direct Entry request was successful, but customer account crediting failed".
  - `transactionId` — string uuid, **required**. "Unique identifier (UUID) of the Direct Entry transaction".
- Errors: 400 / 403 / 422 / 500 / 501 → `ErrorResponse` [spec]. No 404 declared.
- Behaviour:
  - Read-only [inferred].
  - Scope of ids: the webhook DTO says "Currently only the `DEBIT` type is supported" and "Currently only the `OUTBOUND` direction is supported" [spec:webhooks], and the enum is byte-identical to the v1 Direct Debit outcome enum, so in practice the ids accepted here are the outbound-DD `transactionId`s created by `createDirectDebitV1`/`V0` [inferred]. Direct Credits are initiated via the Payments domain (`maketransferv1`, `transferType: ACCOUNT`) and are not covered by this lookup as far as the docs state [docs:direct-debits, inferred].
- Webhooks: none [inferred].

## 2. Entities and fields

All field names are the spec's exact JSON property names. "req" = listed in the schema's `required` array; everything else is optional/nullable as far as the spec states (no `nullable` flags are set on any schema in this domain) [spec]. The spec contains **no `example` values for any schema in this domain** (verified with jq); the only example payloads are the webhook samples in [docs:direct-debits], quoted in section 2.9.

### 2.1 HayScheduledPayment

"Details of the scheduled or recurring payment." Returned by `getScheduledPayments` (array) and `getScheduledPaymentById`; status mutated by `cancelScheduledPayment`; created/updated only via the GraphQL/UI portal mutations `createScheduledPayment` / `updateSchedulePayment` [spec, docs:scheduled-payments]. No field is marked required [spec].

| field | type | req | enum / format | description (verbatim) |
|---|---|---|---|---|
| `accountId` | string | no | uuid | "Unique identifier (UUID) of the Account" |
| `amount` | CurrencyAmount | no | — | (object, see 2.4) |
| `creationDateTimeUtc` | string | no | date-time | "DateTime in UTC format when a scheduled or recurring payment schedule has been created" |
| `customerHayId` | string | no | uuid | "Unique identifier (UUID) of the Customer (initiator of the transfer)" |
| `description` | string | no | — | "Description on the transaction" |
| `endDate` | string | no | date | "Recurring payment processing end date" |
| `frequency` | string | no | `["WEEKLY", "FORTNIGHTLY", "MONTHLY", "QUARTERLY"]` | "Payment frequency for recurring payments. Possible values: WEEKLY: Payment is processed every week, starting on the startDate; FORTNIGHTLY: Payment is processed every two weeks, starting on the startDate; MONTHLY: Payment is processed every month, starting on the startDate (payment triggered on next available date where invalid date is encountered in schedule i.e. 30th February); QUARTERLY: Payment is processed every quarter, starting on the startDate (payment triggered on next available date where invalid date is encountered in schedule i.e. 30th February)" |
| `hayId` | string | no | uuid | "Unique identifier (UUID) of the payment schedule" — this is the `paymentId` path parameter [inferred] |
| `lastProcessedDateTimeUtc` | string | no | date-time | "DateTime in UTC format when a scheduled or recurring payment has been last processed" |
| `numberOfPayments` | integer | no | int32 | "Total number of times a recurring payment will be processed" |
| `numberOfProcessedPayments` | integer | no | int32 | "Total number of times the payment has been processed" |
| `previousVersions` | array of HayArchivedScheduledPayment | no | — | "Any previous versions of this payment schedule that has subsequently been updated" |
| `recipient` | ScheduledPaymentRecipient | no | — | (object, see 2.3) |
| `reference` | string | no | — | "Reference to be included with the transfer" |
| `shouldCancelOnFailure` | boolean | no | — | "Indicates whether a recurring payment schedule should be cancelled if a payment fails (i.e. insufficient funds in Account or rejected by the receiving party)" |
| `startDate` | string | no | date | "First processing date for a recurring payment, or the processing date for a scheduled single payment" |
| `status` | string | no | `["ACTIVE", "CANCELLED", "DELETED", "FAILED", "REJECTED", "COMPLETED", "REPLACED"]` | see section 3.1 for the verbatim per-value descriptions |
| `type` | string | no | `["RECURRING", "ONE_TIME"]` | "Scheduled payment type. Possible values: RECURRING: Payment scheduled to be performed multiple times in the future; ONE_TIME: Payment scheduled to be performed once in the future" |

### 2.2 HayArchivedScheduledPayment

"Any previous versions of this payment schedule that has subsequently been updated" [spec]. Field-for-field identical to `HayScheduledPayment` **except it has no `previousVersions` field** (verified by jq: `HayScheduledPayment` has 18 properties; the archived schema has the other 17, byte-identical, without `previousVersions`) [spec]. Same enums for `frequency`, `status`, `type`. Only appears nested inside `HayScheduledPayment.previousVersions`; only readable via the two GETs [spec]. Archived versions are expected to carry `status: "REPLACED"` ("Payment schedule has been replaced with a newer version") [inferred from the status description].

### 2.3 ScheduledPaymentRecipient

"Details of the scheduled payment recipient" [spec]. No required fields.

| field | type | enum | description (verbatim) |
|---|---|---|---|
| `bpayDetails` | BpayDetails | — | (object, see 2.6) — populated when `recipientType` is `BPAY` [inferred] |
| `recipientAccountNumber` | BasicAccountNumber | — | (object, see 2.5) — populated when `recipientType` is `ACCOUNT` [inferred] |
| `recipientName` | string | — | "Name of Account receiving the transfer" |
| `recipientType` | string | `["ACCOUNT", "BPAY"]` | "Recipient type. Possible values: ACCOUNT: The recipient of the Scheduled Payment is an another cash Account, payment sent as cash transfer; BPAY: The recipient of the Scheduled Payment is a BPAY Biller, payment sent as BPAY payment" |

[docs:scheduled-payments] adds: "ACCOUNT: Use this type for regular transfers by BSB and Account Number. BPAY: Use this type for bill payments."

### 2.4 CurrencyAmount

"Monetary value and currency" [spec]. Shared component used by many domains.

| field | type | req | description |
|---|---|---|---|
| `amount` | number | **yes** | "Amount of the transaction to 2 decimal places" |
| `currency` | string | **yes** | "Currency as three letter code as per ISO 4217" — enum of 162 values, verbatim: "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNH", "CNY", "COP", "CRC", "CUC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HRK", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SLL", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XCG", "XOF", "XPF", "YER", "ZAR", "ZMW", "ZWG", "ZWL" |

### 2.5 BasicAccountNumber

"Details of the recipient account number" [spec]. No required fields, no patterns in schema (constraints are in descriptions only).

| field | type | description (verbatim) |
|---|---|---|
| `accountNumber` | string | "Account number, 5-9 digits in length" |
| `branchNumber` | string | "BSB (Bank State Branch) of Account, 6 digits in length" |

### 2.6 BpayDetails

"Details of the BPAY Biller" [spec]. No required fields.

| field | type | description (verbatim) |
|---|---|---|
| `billerCode` | string | "BPAY Biller Code, 3 to 10 digits in length" |
| `billerImage` | string | "URL to external image representing Biller's logo (if available)" |
| `billerName` | string | "Name of the BPAY Biller, 1 to 50 characters in length" |
| `billerReference` | string | "BPAY Customer Reference Number (CRN), 2 to 20 digits in length" |
| `category` | string | "Category assigned on the transaction" |

### 2.7 Outbound Direct Debit (CreateDirectDebitRequestBody / DirectDebitResponse / DirectDebitResponseV1 / DeTransactionDetails / DeTransactionDetailsV1)

There is no single "DirectDebit" entity schema; the record is created from `CreateDirectDebitRequestBody` (see the table under `createDirectDebitV1`) and read back as `DirectDebitResponse`(V1) wrapping `DeTransactionDetails`(V1). Created by `createDirectDebitV0`/`createDirectDebitV1`; read by `getDirectDebitV0`/`V1`, `getDirectDebitsV0`/`V1` (list of the inner details object), and (status only) `getDirectEntryStatusV1`; status mutated only by the platform's batch/return/credit processing [spec, docs:direct-debits].

`DeTransactionDetails` (v0) — "Details of the outbound Direct Debit transfer"; no required fields [spec]:

| field | type | format / enum | description (verbatim) |
|---|---|---|---|
| `amount` | number | — | "Value of the Direct Debit transfer, to 2 decimal places" |
| `description` | string | — | "Description on Direct Debit transfer, maximum 18 characters in length" |
| `outcome` | string | `["ACCEPTED", "REJECTED", "SUBMITTED", "RETURNED"]` | "Status of the Direct Debits." (v0 vocabulary; descriptions under `createDirectDebitV0`) |
| `processingDate` | string | date | "Date that the Direct Debit transfer takes effect" |
| `recipientAccountNumber` | string | — | "Account Number of Account receiving Direct Debit instruction (account to be debited), 5-9 digits in length" |
| `recipientBsb` | string | — | "BSB (Bank State Branch) of Account receiving Direct Debit instruction (account to be debited), 6 digits in length" |
| `recipientName` | string | — | "Name on the Account receiving Direct Debit instruction (account to be debited)" |
| `senderAccountNumber` | string | — | "Account Number of Account sending Direct Debit instruction (account to be credited), 5-9 digits in length" |
| `senderBsb` | string | — | "BSB (Bank State Branch) of Account sending Direct Debit instruction (account to be credited), 6 digits in length" |
| `senderName` | string | — | "Name on the Account sending Direct Debit instruction (account to be credited)" |
| `transactionHayId` | string | uuid | "Unique identifier (UUID) of the Transaction" |
| `type` | string | `["CREDIT", "DEBIT"]` | "Transaction type. Possible values: DEBIT" — note the enum lists both CREDIT and DEBIT but the description lists only DEBIT [spec] |

`DeTransactionDetailsV1` — same 12 fields, same descriptions, with these differences [spec]:
- `outcome` is **required** and its enum is `["RECEIVED", "ACCEPTED", "REJECTED", "SUBMITTED", "RETURNED", "COMPLETE", "INCOMPLETE"]`.

Naming note: the request carries `transactionId`, the wrapper response carries `transactionId`, but the inner details object carries `transactionHayId` [spec]. Whether `transactionHayId` equals the client-supplied `transactionId` or is a separate platform id is not documented (section 7).

Not present anywhere on the DD record [spec]: `idempotencyKey` (request-only), an `accountId`, a `customerHayId`, a creation timestamp, or a currency (amount is implicitly AUD [inferred — BECS is AUD-only]).

### 2.8 DirectEntryStatusResponseV1

"Status response for a Direct Entry transaction lookup." Both fields required [spec]. Read by `getDirectEntryStatusV1` only.

| field | type | req | enum |
|---|---|---|---|
| `status` | string | yes | `["RECEIVED", "ACCEPTED", "REJECTED", "SUBMITTED", "RETURNED", "COMPLETE", "INCOMPLETE"]` |
| `transactionId` | string (uuid) | yes | "Unique identifier (UUID) of the Direct Entry transaction" |

### 2.9 Webhook DTOs touching this domain [spec:webhooks]

Delivered to the client's `POST /api/hay/v0/communications/notification` (operationId `notifyNotification`) as a `NotificationDto` [spec:webhooks]. `NotificationDto` required fields: `customerHayId` (uuid), `idempotencyKey` (uuid, "to uniquely represent this request and prevent duplication"), `type`. Optional envelope fields seen in this domain's samples: `productId` (uuid), `firebaseDeviceToken`, `actionOwner` (`["CLIENT", "PLATFORM"]`).

- `type: "DIRECT_ENTRY"` ("Direct Entry notification") → `directEntryEvent`: **DirectEntryEventDto** — "Details of the Direct Entry event; provided when the type is DIRECT_ENTRY.":
  - `transactionId` — string uuid, "Unique identifier (UUID) of the Direct Entry Transaction associated with the event"
  - `type` — enum `["DEBIT"]`, "Transaction type; Currently only the DEBIT type is supported."
  - `direction` — enum `["OUTBOUND"]`, "Transaction direction; Currently only the OUTBOUND direction is supported."
  - `status` — enum `["RECEIVED", "ACCEPTED", "REJECTED", "SUBMITTED", "RETURNED", "COMPLETE", "INCOMPLETE"]`, "Transaction status."
  - Example [docs:direct-debits]: `{"customerHayId":"000d8874-f9c4-455e-b565-6d439fdd55ad","idempotencyKey":"5fcae09b-b2f1-3d6f-a60c-c02b8c842083","type":"DIRECT_ENTRY","directEntryEvent":{"transactionId":"7a70baa7-a4d4-4359-8cae-37e7bf971342","type":"DEBIT","direction":"OUTBOUND","status":"COMPLETE"}}`
- `type: "SCHEDULED_PAYMENT"` ("Scheduled payment creation notification") → `scheduledPaymentEvent`: **ScheduledPaymentEventDto** — "Details of the Scheduled Payment Created event; provided when the type is SCHEDULED_PAYMENT.":
  - `hayId` — string uuid, "Unique identifier (UUID) of the Scheduled Payment that has been created"
  - No sample payload in the docs. Fired on creation (via GraphQL/UI), which is outside the B2B API [spec:webhooks, docs:scheduled-payments].
- `type: "TRANSACTION"` → `transactionEvent`: **TransactionEventDto** with `transactionType: "DIRECT_DEBIT_TRANSFER"` ("Direct Debit") for the money movement of a DD, and `originType` enum `["CUSTOMER", "SCHEDULED_PAYMENT", "HAAS_OPERATIONS", "OPERATIONS", "MANDATE_PAYMENT", "DIRECT_DEBIT", "TRANSACTION"]` where `SCHEDULED_PAYMENT` = "Transaction initiated by a schedule" and `DIRECT_DEBIT` = "Transaction initiated by direct debit" [spec:webhooks]. The full TransactionEventDto belongs to the transactions domain; the DD sample from [docs:direct-debits] is:
  `{"customerHayId":"46db5ab0-8ee2-4cb9-b059-68a75b23b059","idempotencyKey":"8183131d-021b-49ae-a032-68a75b23b059","type":"TRANSACTION","productId":"8aa6879a-74d5-37a5-0174-68a75b23b059","transactionEvent":{"transactionHayId":"fd7a2acb-f906-415d-9378-68a75b23b059","accountHayId":"ac364762-56bd-41a2-a966-68a75b23b059","currencyAmount":{"currency":"AUD","amount":-457.12},"updatedBalance":{"currency":"AUD","amount":3197.26},"isPending":false,"counterpartName":"Andy","outcome":"ACCEPTED","transactionTimeUtc":"2024-06-21T12:21:54.689834Z","isAtmTransaction":false,"transactionType":"DIRECT_DEBIT_TRANSFER","accountBalances":{"totalBalance":{"currency":"AUD","amount":3197.26},"heldBalance":{"currency":"AUD","amount":0},"lockedBalance":{"currency":"AUD","amount":0},"stacksBalance":{"currency":"AUD","amount":0},"availableBalance":{"currency":"AUD","amount":3197.26}},"customerHayId":"46db5ab0-8ee2-4cb9-b059-68a75b23b059","counterpartDetails":{"name":"Andy"},"category":"BANK_TRANSFER","description":"Thanks for lunch"}}`
  The docs caption this sample "You will receive this event when external bank account pull funds from customer account using Direct Debit" (a debit of the customer, amount negative) [docs:direct-debits].

### 2.10 GenericMessage / ErrorResponse

- `GenericMessage` — "Message response": `message` string, "Message indicating operation result" [spec]. Returned by `cancelScheduledPayment`.
- `ErrorResponse` — "An error response.": `details` string ("Error details"), `message` string ("Error description"), `status` string ("HTTP response status"), `traceId` string ("TraceID that can be used by HAY for troubleshooting the request"). No field required [spec].

## 3. State machines

### 3.1 HayScheduledPayment.status

Values and verbatim descriptions [spec]:

- `ACTIVE`: "Payment schedule is active and has outstanding payments to be processed in the future"
- `CANCELLED`: "Payment schedule has been cancelled, the schedule is no longer active (triggered via 'Cancel Scheduled Payment' method)"
- `COMPLETED`: "All payments scheduled have been completed, the schedule is no longer active"
- `DELETED`: "Payment schedule has been deleted, the schedule is no longer active (triggered via UI exposed endpoint)"
- `FAILED`: "Payment has failed to be processed, any further scheduled payments will not be processed (only used for payments with the shouldCancelOnFailure flag set to true)"
- `REJECTED`: "Payment has been rejected by recipient, any further scheduled payments will not be processed (only used for payments with the shouldCancelOnFailure flag set to true)"
- `REPLACED`: "Payment schedule has been replaced with a newer version"

Transitions. No state diagram is provided for schedules (the flow image in [docs:scheduled-payments] is not readable as text); every row is derived from the status descriptions above and so is [spec]-described-endpoint but [inferred]-as-a-transition.

| from | to | via |
|---|---|---|
| (none) | ACTIVE | `createScheduledPayment` GraphQL mutation / UI portal (not B2B API) [docs:scheduled-payments]; fires webhook `SCHEDULED_PAYMENT` [spec:webhooks] |
| ACTIVE | CANCELLED | `cancelScheduledPayment` (this domain) [spec] |
| ACTIVE | DELETED | "UI exposed endpoint" — not B2B API [spec] |
| ACTIVE | REPLACED | `updateSchedulePayment` GraphQL mutation — the old version is archived into `previousVersions` of the new/updated record [spec description + inferred] |
| ACTIVE | COMPLETED | platform, when the last scheduled payment has been processed (`numberOfProcessedPayments` reaches `numberOfPayments`, or `endDate` passed, or the single ONE_TIME payment ran) [inferred] |
| ACTIVE | FAILED | platform, when a payment fails (e.g. insufficient funds) **and** `shouldCancelOnFailure == true` [spec] |
| ACTIVE | REJECTED | platform, when the recipient rejects a payment **and** `shouldCancelOnFailure == true` [spec] |
| ACTIVE | ACTIVE | platform, when a payment fails/rejects and `shouldCancelOnFailure == false` — schedule stays active [inferred from "only used for payments with the shouldCancelOnFailure flag set to true"] |

Terminal states: CANCELLED, DELETED, REPLACED, COMPLETED, FAILED, REJECTED — every value other than ACTIVE is described as "no longer active" / "further scheduled payments will not be processed" [spec]; no reactivation path is documented [inferred]. Whether `cancelScheduledPayment` on a non-ACTIVE schedule errors or is a no-op is undocumented (section 7).

### 3.2 Direct Debit / Direct Entry status (v1: DirectDebitResponseV1.outcome, DeTransactionDetailsV1.outcome, DirectEntryStatusResponseV1.status, DirectEntryEventDto.status)

All four enums are byte-identical: `["RECEIVED", "ACCEPTED", "REJECTED", "SUBMITTED", "RETURNED", "COMPLETE", "INCOMPLETE"]` (verified by jq) [spec, spec:webhooks]. The docs' state diagram is an image; transitions below combine the prose in [docs:direct-debits] with the enum descriptions.

| from | to | via |
|---|---|---|
| (none) | RECEIVED | `createDirectDebitV1` / `createDirectDebitV0` — "Direct Debit request received for processing"; DIRECT_ENTRY webhook sent synchronously [docs:direct-debits] |
| RECEIVED | ACCEPTED | platform validation/authorisation passes — "accepted and awaiting submission to next Direct Entry payment batch"; DIRECT_ENTRY webhook sent synchronously with the request [docs:direct-debits] |
| RECEIVED | REJECTED | platform — "request failed validation or authorization and can't be executed" [spec]; terminal |
| ACCEPTED | SUBMITTED | platform, at the next Direct Entry batch — "accepted and submitted in Direct Entry payment batch"; DIRECT_ENTRY webhook "will arrive later" [docs:direct-debits] |
| SUBMITTED | RETURNED | platform, when the recipient FI returns the debit within the ~2 working day monitoring window ("Returns can be due to the external account being blocked or rejecting the request"); "A notification to the client will be sent making the transaction failure visible" [docs:direct-debits]; terminal |
| SUBMITTED | COMPLETE | platform, "After two working days the requested customer account is credited and a notification of the successful transaction is sent" [docs:direct-debits]; sender account balance += amount; DIRECT_ENTRY (COMPLETE) + TRANSACTION (DIRECT_DEBIT_TRANSFER) webhooks; terminal |
| SUBMITTED | INCOMPLETE | platform, "request was successful, but customer account crediting failed" [spec]; terminal as far as documented |
| COMPLETE | (no status) | "If DD is returned after crediting the account, then a case will be raised to investigate why this occurred and next steps communicated to the client." — manual, no status value defined [docs:direct-debits] |

Terminal states: REJECTED, RETURNED, COMPLETE, INCOMPLETE [inferred from descriptions: "can't be executed", "cannot be executed", "successful"]. Whether ACCEPTED → RETURNED (without SUBMITTED) or ACCEPTED → REJECTED can occur is not stated [spec].

v0 vocabulary (`DirectDebitResponse.outcome`, `DeTransactionDetails.outcome`): `["ACCEPTED", "REJECTED", "SUBMITTED", "RETURNED"]`, and the v0 list filter allows only `["ACCEPTED", "SUBMITTED", "RETURNED"]` [spec]. Transitions are the subset ACCEPTED → SUBMITTED → RETURNED, plus REJECTED at creation. How a v0 read renders a record that is RECEIVED, COMPLETE or INCOMPLETE in the v1 model is undocumented (section 7).

### 3.3 DeTransactionDetails.type / DirectEntryEventDto.type / direction

- `DeTransactionDetails(.V1).type`: enum `["CREDIT", "DEBIT"]`; description lists only `DEBIT` [spec]. Not a state machine — a fixed classifier; always `DEBIT` for records created by this domain [inferred].
- `DirectEntryEventDto.type`: `["DEBIT"]`; `DirectEntryEventDto.direction`: `["OUTBOUND"]` [spec:webhooks].

## 4. Invariants and calculations

### 4.1 Identifiers
- Every id in this domain is a UUID string: `accountId`, `paymentId`/`hayId`, `customerHayId`, `transactionId`, `transactionHayId`, `idempotencyKey`, `traceId` [spec].
- Direct Debit `transactionId` is **supplied by the client** in `CreateDirectDebitRequestBody` and echoed as the required `transactionId` of the response; it is the key for `getDirectDebitV0/V1` and `getDirectEntryStatusV1` [spec, inferred]. `idempotencyKey` is a second client-supplied UUID "used to recognise any subsequent retries" [spec].
- Scheduled payment `hayId` is platform-generated (created via GraphQL/UI) and is what the B2B API calls `paymentId` [spec, inferred].

### 4.2 Amounts and currency
- `CurrencyAmount.amount` is a JSON number "to 2 decimal places"; `currency` is ISO 4217 [spec]. Scheduled payment samples elsewhere in the docs use `AUD`.
- Direct Debit `amount` is a bare number ("to 2 decimal places") with no currency field; positive value = the amount pulled from the recipient and credited to the sender [spec, inferred]. No `minimum` is declared; whether 0 or negative is rejected is undocumented (section 7).
- Webhook `TransactionEventDto.currencyAmount.amount` is signed: negative when the customer account is debited (DD sample: -457.12), positive when credited (INTERBANK_TRANSFER_IN sample: 200.00) [docs:direct-debits].
- Balance formula visible in the webhook samples (transactions/accounts domain, quoted for the credit leg): `availableBalance = totalBalance - heldBalance` (66049.69 - 3124.11 = 62925.58 in the INTERBANK_TRANSFER_IN sample; lockedBalance and stacksBalance are 0 in every sample so their sign in the formula is not determinable from this domain's docs) [docs:direct-debits, inferred].

### 4.3 Direct Debit timing
- Status timeline: RECEIVED and ACCEPTED are synchronous with the create call; SUBMITTED occurs at the next Direct Entry batch; the platform "will monitor over 2 working days to catch if a Direct Debit is returned"; "After two working days the requested customer account is credited" (COMPLETE) [docs:direct-debits].
- "there is a two-day period between the request and the transaction being credited to the customer's account" [docs:direct-debits]. "Working days" — Australian business days [inferred; BECS context].
- `processingDate` (date) = "Date that the Direct Debit transfer takes effect" [spec]. Its relation to the request time (same day? next batch day?) is undocumented (section 7).
- Background: BECS "settle their obligations through RBA Exchange Settlement Accounts (ESAs) six times each business day" [docs:direct-debits] — informational only; no API-visible batch time is documented.
- Credit to the sender account happens at COMPLETE, **not** at ACCEPTED/SUBMITTED; nothing is held or reserved on the sender account in the meantime as far as documented [docs:direct-debits, inferred].

### 4.4 Direct Debit list/date handling
- `fromUtc`/`toUtc` are `format: date` (YYYY-MM-DD) despite descriptions saying "DateTime in UTC format" [spec]. Which timestamp of the record they filter on, and inclusivity, are undocumented.
- `offset` and `limit` are both **required**; `limit` "value between 1 and 1000" [spec].

### 4.5 Scheduled payment schedule calculations [spec field descriptions]
- `startDate` = "First processing date for a recurring payment, or the processing date for a scheduled single payment".
- `frequency` cadence: WEEKLY = every week from `startDate`; FORTNIGHTLY = every two weeks; MONTHLY = every month; QUARTERLY = every quarter. For MONTHLY/QUARTERLY, when the computed day does not exist ("i.e. 30th February") the payment is "triggered on next available date".
- `endDate` = "Recurring payment processing end date"; `numberOfPayments` = "Total number of times a recurring payment will be processed"; `numberOfProcessedPayments` = "Total number of times the payment has been processed"; `lastProcessedDateTimeUtc` updated on each processing.
- Invariants [inferred]: `numberOfProcessedPayments <= numberOfPayments`; for `type == "ONE_TIME"` the schedule has a single processing on `startDate` (and `frequency`/`endDate`/`numberOfPayments` are presumably absent or 1); `status` becomes COMPLETED when the count is reached or `endDate` passes. Whether both `endDate` and `numberOfPayments` can be set, and which wins, is undocumented (section 7).
- `shouldCancelOnFailure`: when true, a failed payment ("insufficient funds in Account") moves the schedule to FAILED and a recipient rejection to REJECTED; when false, the schedule keeps running [spec, inferred].
- A processed occurrence produces a transaction in the transactions domain with `originType: "SCHEDULED_PAYMENT"` (and presumably `originId` = the schedule `hayId`) and `type` `INTERBANK_TRANSFER_OUT`/`INTRABANK_TRANSFER_OUT` for `recipientType: ACCOUNT` or `BPAY_TRANSFER_OUT` for `recipientType: BPAY` [spec enums; mapping inferred]. The GraphQL create mutation response includes "the transaction outcome" [docs:scheduled-payments].

### 4.6 Limits touching this domain
- Daily limits "are calculated on a rolling 24h window ... the limit checker will get all transactions from the past 24h for that account and check if the total (including the current transaction) would go over the limit" [docs:account-limits].
- `DIRECT_DEBIT_PER_DAY`: spec "Maximum value of outgoing direct debit transfers"; docs "The maximum total value of outgoing cash from inbound direct debit requests that can be processed from an account in a single day" [spec, docs:account-limits]. Breach outcome `REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED` [docs:payment-transaction-outcome].
- Liquidity threshold type `TOTAL_DAILY_INBOUND_DIRECT_DEBIT` (client-level, `CreateThresholdRequestBody.type` / `LiquidityThreshold.type`) with breach outcome `REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED` ("Transaction declined as the total daily limit for inbound direct debits has been exceeded") [spec, docs:payment-transaction-outcome].
- Scheduled payments to ACCOUNT recipients are subject to `PAYMENT_TO_ACCOUNT_NUMBER` ("Maximum value of individual outgoing cash transfer") and `TOTAL_SPEND_PER_YEAR`; BPAY recipients to `BPAY_DAILY_LIMIT` ("Maximum value of outgoing BPAY payments") with outcome `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`; `MAX_BALANCE` applies to the credit leg of a completed DD (`REFUSED_MAX_BALANCE_EXCEEDED`) [spec, docs:account-limits, docs:payment-transaction-outcome; applicability to this domain inferred].
- Risk level HIGH "set all limits to 0, which means setting an account to a HIGH risk level will prevent all outbound and inbound transactions" — would block scheduled payment occurrences and the DD credit leg [docs:account-limits, inferred].

## 5. Cross-domain dependencies

Reads from / writes to other domains:

- **Accounts**: `accountId` path param of the three scheduled-payment ops must be an existing Account [inferred]. A DD's sender is identified by `senderBsb` + `senderAccountNumber`, which the platform must resolve to a Shaype account (`HayAccount` BSB/account number) to credit it at COMPLETE [inferred]. Account status gating: the payment outcomes `REFUSED_ACCOUNT_BLOCKED` / `REFUSED_ACCOUNT_CLOSED` exist [docs:payment-transaction-outcome]; `HayAccount.status` enum is `["PENDING_APPROVAL", "APPROVED", "ACTIVE", "LOCKED", "DORMANT", "CLOSED", "ACTIVE_IN_ARREARS"]` [spec]. Which statuses allow a DD credit or a schedule occurrence is undocumented.
- **Account closure**: `closeAccount` (`POST /v0/accounts/{accountId}/close`, `CloseAccountResponse`) reports `ClosureCheckerError.type` including `INFLIGHT_OUTBOUND_DIRECT_DEBITS` (alongside `ACCOUNT_BALANCE_TOTAL`, `ACCOUNT_BALANCE_STACKS`, `ACCOUNT_BALANCE_HELD`, `ACCOUNT_BALANCE_LOCKED`, `ACCOUNT_BALANCE_OVERDRAFT`, `ACCOUNT_BALANCE_TECHNICAL_OVERDRAFT`, `CHILD_ACCOUNT_STATUS`) [spec]. So the accounts domain must be able to ask this domain "does account X have outbound DDs in a non-terminal status?" [inferred]. Whether ACTIVE scheduled payments block closure is not listed [spec].
- **Balances**: DD COMPLETE credits the sender account by `amount` and emits `TRANSACTION`/`DIRECT_DEBIT_TRANSFER` with `accountBalances` [docs:direct-debits]. Scheduled occurrences debit the account like any outbound transfer/BPAY [inferred].
- **Transactions**: `FinancialTransaction.originType` includes `SCHEDULED_PAYMENT` ("Transaction initiated by a schedule") and `DIRECT_DEBIT` ("Transaction initiated by Direct Debit"); `FinancialTransaction.originId` = "Additional identifier applied to Transaction related to origin of the request"; `FinancialTransaction.type` includes `DIRECT_DEBIT_TRANSFER` ("Cash transfer out of Account via Direct Debit"), `INTERBANK_TRANSFER_OUT` ("Cash transfer out of Account via Direct Credit or NPP"), `BPAY_TRANSFER_OUT` [spec]. `SearchTransactionsRequestBody.originType` and `CreateTransactionRequestBody.originType` also accept `SCHEDULED_PAYMENT` / `DIRECT_DEBIT` [spec].
- **Limits / liquidity thresholds**: `DIRECT_DEBIT_PER_DAY`, `BPAY_DAILY_LIMIT`, `PAYMENT_TO_ACCOUNT_NUMBER`, `MAX_BALANCE`, `TOTAL_SPEND_PER_YEAR` (account limits, `ExternalLimitAmounts.type`); `TOTAL_DAILY_INBOUND_DIRECT_DEBIT` (`LiquidityThreshold.type`) [spec] — see 4.6.
- **Payments (Direct Credit)**: Direct Credit is *not* in this domain: it goes through `maketransferv1` with `transferType: ACCOUNT`; the platform routes to INTERNAL (Shaype BSB) → NPP (if enabled) → DE otherwise, and emits `INTERBANK_TRANSFER_IN` / `INTERBANK_TRANSFER_OUT` TRANSACTION webhooks [docs:direct-debits].
- **BPAY**: scheduled payments with `recipientType: BPAY` carry `BpayDetails` (`billerCode`, `billerReference`, ...) and are executed as BPAY payments [spec]; BPAY validation outcomes (`REFUSED_BPAY_INVALID_BILLER_CODE`, `REFUSED_BPAY_INVALID_REFERENCE`, `REFUSED_BPAY_INVALID_PAYMENT`, `REFUSED_BPAY_REJECTED`) apply [docs:payment-transaction-outcome].
- **Webhooks**: emits `DIRECT_ENTRY` (per DD status), `TRANSACTION` (`DIRECT_DEBIT_TRANSFER`; scheduled occurrences as their own transactionType with `originType: SCHEDULED_PAYMENT`), `SCHEDULED_PAYMENT` (on creation via GraphQL) [spec:webhooks, docs:direct-debits]. Delivery: retried "18 times over a period of up to 48 hours" with exponential backoff on client responses 401, 403, 429, 5XX [docs:webhook-notification].
- **External authorisation (client-held balances)** [spec:external-balance]: `POST /transactions` (`authoriseTransaction`) is called by Shaype with `authorisationTransactionType` enum `["BPAY_TRANSFER_OUT", "DIRECT_DEBIT_TRANSFER", "GENERAL_CREDIT", "GENERAL_DEBIT", "INBOUND_PAYMENT", "OUTBOUND_PAYMENT"]`; the client may refuse with `errorCode` `["REFUSED_MAX_BALANCE_EXCEEDED", "REFUSED_NOT_ENOUGH_FUNDS", "REFUSED_SENDER_ACCOUNT_NOT_VERIFIED"]` (HTTP 470). Scheduled occurrences (`OUTBOUND_PAYMENT`/`BPAY_TRANSFER_OUT`) and DD money movement (`DIRECT_DEBIT_TRANSFER`) would pass through this callback for clients on that model [inferred].
- **GraphQL / UI portal (not in the B2B spec)**: `createScheduledPayment` (by `accountId`) and `updateSchedulePayment` (by `paymentId`) mutations are the only create/update paths [docs:scheduled-payments]. A cleanroom server needs a test-only seeding path for schedules (section 7).
- **PayTo mandates** (separate domain): `GetMandateActionsDetailsCreationDto.mandateType` has a `DIRECT_DEBIT` value [spec] — unrelated to BECS direct debits; do not conflate.

## 6. Error catalogue

No error `message`/`details` texts are shown anywhere in the spec or the three docs pages for this domain; the spec provides only status codes + `ErrorResponse` shape [spec]. Everything below is therefore "declared" (code exists on the op) or "inferred" (which condition maps to it).

| condition | HTTP | body | source |
|---|---|---|---|
| Malformed/invalid request (bad uuid in path, missing required query param, invalid JSON, schema violation) | 400 "Bad Request" | `ErrorResponse` | declared on all 10 ops [spec]; mapping inferred |
| Caller not permitted (account/schedule/DD not owned by the client, or auth failure) | 403 "Forbidden" | `ErrorResponse` | declared on all 10 ops [spec]; mapping inferred |
| Semantically invalid / business-rule failure (e.g. `limit` outside 1..1000, `fromUtc > toUtc`, cancelling a non-ACTIVE schedule, unknown id) | 422 "Unprocessable Content" | `ErrorResponse` | declared on 9 ops [spec]; mapping inferred |
| `createDirectDebitV0` invalid input | 422 "Invalid Input" | **`DirectDebitResponse`** (`outcome` presumably `REJECTED`, `details` explains) | [spec]; outcome value inferred |
| `createDirectDebitV1` validation/authorisation failure surfaced as a business outcome | 200 | `DirectDebitResponseV1` with `outcome: "REJECTED"` ("Direct Debit request failed validation or authorization and can't be executed") and `details` | [spec] |
| Server failure | 500 "Internal Server Error" | `ErrorResponse` | declared on all 10 ops [spec] |
| Not implemented | 501 "Not Implemented" | `ErrorResponse` | declared on all 10 ops [spec] |
| Resource not found | **not declared** (no 404 on any op) | — | [spec]; see section 7 |
| Conflict / duplicate `idempotencyKey` or `transactionId` | **not declared** (no 409 on any op) | — | [spec]; see section 7 |

`ErrorResponse` fields: `details`, `message`, `status` (string, "HTTP response status"), `traceId` [spec].

Transaction-level outcomes relevant to this domain (these appear as `outcome` on TRANSACTION webhooks / transaction records, not as HTTP errors) [docs:payment-transaction-outcome, verbatim descriptions]:
- `ACCEPTED`: "Transaction accepted by platform for further processing"
- `REFUSED_NOT_ENOUGH_FUNDS`: "Transaction declined as it would exceed the account's maximum balance MIN_BALANCE limit." (sic)
- `REFUSED_MAX_BALANCE_EXCEEDED`: "Transaction declined as it would exceed the account's maximum balance MAX_BALANCE limit."
- `REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED`: "Transaction declined as the daily direct debit DIRECT_DEBIT_PER_DAY limit has been exceeded."
- `REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED`: "Transaction declined as the total daily limit for inbound direct debits has been exceeded."
- `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED`: "Transaction declined because the daily limit for outgoing transfers has been exceeded."
- `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`: "Transaction declined because the total daily BPAY_DAILY_LIMIT limit for outbound BPAY transactions has been exceeded."
- `REFUSED_BPAY_INVALID_BILLER_CODE` / `REFUSED_BPAY_INVALID_REFERENCE` / `REFUSED_BPAY_INVALID_PAYMENT` / `REFUSED_BPAY_REJECTED`: BPAY validation/gateway refusals.
- `REFUSED_ACCOUNT_BLOCKED` / `REFUSED_ACCOUNT_CLOSED` / `REFUSED_RECIPIENT_ACCOUNT_BLOCKED` / `REFUSED_RECIPIENT_ACCOUNT_CLOSED`: account status refusals.
- `REFUSED_RULES`: "violation of predefined account rules"; `REFUSED_FRAUD`; `INTERNAL_ERROR`; `REFUSED_INSUFFICIENT_DATA`.
- Limit-breach shape shown in [docs:account-limits]: `"outcome": "LIMIT_BREACH", "detailedOutcome": "REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED"` (the `TransactionOutcome.outcome` enum in the spec spells the generic value `REFUSED_LIMIT_BREACH`) [spec, docs:account-limits].
- Full `TransactionEventDto.outcome` enum (41 values) is in the transactions/webhooks domain; verbatim list available via `jq '.components.schemas.TransactionEventDto.properties.outcome.enum' notification-webhooks.json`.

## 7. Open questions

Things the implementer must decide because neither spec nor docs define them:

1. **404 vs 422 vs 403 for unknown ids.** No op declares 404. Decide what `getScheduledPaymentById`, `cancelScheduledPayment`, `getDirectDebitV0/V1`, `getDirectEntryStatusV1` return for an unknown `accountId`/`paymentId`/`transactionId`, and for a `paymentId` that exists but belongs to a different `accountId` (403? 422? empty?).
2. **HTTP status for request validation failures.** Both 400 and 422 are declared everywhere; the split (JSON-schema failure vs business rule) is undocumented. Also whether `createDirectDebitV1` returns HTTP 4xx or `200 + outcome: "REJECTED"` for each class of failure (bad BSB, unknown sender account, limit breach, blocked account).
3. **Idempotency of `createDirectDebitV1`/`V0`.** Behaviour on a retry with the same `idempotencyKey` (replay the original 200? 409? new record?), on the same `transactionId` with a different `idempotencyKey`, and on the same `idempotencyKey` with a different body. No 409 is declared.
4. **Initial outcome returned by create.** Docs say RECEIVED and ACCEPTED webhooks are sent synchronously; the create response `outcome` is presumably `ACCEPTED` (or `REJECTED`), but `RECEIVED` is also a legal value. Decide.
5. **`transactionHayId` vs `transactionId`.** Whether `DeTransactionDetails(.V1).transactionHayId` equals the client-supplied `transactionId` or is a distinct platform id.
6. **v0 rendering of v1-only states.** How `getDirectDebitV0`/`getDirectDebitsV0` present records whose v1 status is `RECEIVED`, `COMPLETE` or `INCOMPLETE` (the v0 enum lacks them) — map COMPLETE→SUBMITTED? omit? Also the v0 list filter has no `REJECTED` value.
7. **Which date `fromUtc`/`toUtc` filter on** (request/creation date vs `processingDate` vs last status change) and inclusivity of `toUtc`; behaviour when `limit` is outside 1..1000 or `offset` negative.
8. **`processingDate` derivation** (request date? next batch business day?) and the exact "2 working days" clock (calendar used, cut-off time, timezone) for SUBMITTED → COMPLETE/RETURNED in a local simulator. Suggest an explicit test hook to advance DD state.
9. **Which transaction(s) the credit leg of an outbound DD produces.** The docs' `DIRECT_DEBIT_TRANSFER` sample is a *debit* of the customer ("external bank account pull funds from customer account"), and the spec describes `DIRECT_DEBIT_TRANSFER` as "Cash transfer out of Account via Direct Debit", whereas an outbound DD *credits* the sender at COMPLETE. Decide the `transactionType`, sign of `currencyAmount`, `originType` (`DIRECT_DEBIT`?) and `originId` for the credit, and whether a separate transaction is emitted for RETURNED/INCOMPLETE.
10. **Whether `DIRECT_DEBIT_PER_DAY` applies to this flow.** Spec ("outgoing direct debit transfers") and docs ("outgoing cash from inbound direct debit requests") disagree; decide whether outbound-DD creation is limit-checked at all, and against which account.
11. **Sender account resolution.** Must `senderBsb` be a Shaype BSB / must `senderBsb+senderAccountNumber` resolve to an existing Shaype account in an allowed status? What if it does not (REJECTED at create, or INCOMPLETE at credit time)? Which `customerHayId` receives the `DIRECT_ENTRY` webhook (the sender account's owner, inferred)?
12. **DD amount bounds**: is 0 or negative rejected; is there a maximum; decimal precision enforcement (>2 dp).
13. **Cancel semantics.** `cancelScheduledPayment` on a schedule already CANCELLED/COMPLETED/DELETED/FAILED/REJECTED/REPLACED: idempotent 200, or 422? The `GenericMessage.message` text. Whether an occurrence already "in flight" on the cancel day is still executed.
14. **Scheduled payment webhooks beyond creation.** Only `SCHEDULED_PAYMENT` ("creation notification") is defined; nothing for cancel/complete/fail. Decide whether the local server emits anything on cancel (recommend: nothing, matching the docs).
15. **Schedule creation/update/seeding.** Not in the B2B API (GraphQL only). The local server needs a test-only route or fixture loader to create `HayScheduledPayment` records, and rules for `previousVersions` on update (old copy with `status: "REPLACED"`, inferred).
16. **Schedule termination precedence** when both `endDate` and `numberOfPayments` are set; whether `ONE_TIME` schedules carry `frequency`/`numberOfPayments`; what `numberOfPayments` is when only `endDate` is set; whether COMPLETED is set immediately after the last occurrence or at the next evaluation.
17. **Ordering** of the arrays returned by `getScheduledPayments` and `getDirectDebitsV0/V1` (creation time? processingDate?) — undocumented.
18. **Account-status gating** for DD credit at COMPLETE (LOCKED / CLOSED / DORMANT → INCOMPLETE?) and for schedule occurrences (which `REFUSED_*` outcome and whether `shouldCancelOnFailure` treats a limit refusal as "failed").
19. **Does an ACTIVE schedule block account closure?** Only `INFLIGHT_OUTBOUND_DIRECT_DEBITS` is listed in `ClosureCheckerError.type`; decide what "in flight" means (any status other than REJECTED/RETURNED/COMPLETE/INCOMPLETE, inferred).
20. **`DeTransactionDetails.type`** — enum has `CREDIT` and `DEBIT` but description lists only `DEBIT`; decide whether the local server ever emits `CREDIT` (recommend: never).
21. **Post-COMPLETE returns** ("a case will be raised") have no status; decide whether to model at all (recommend: not modelled).
