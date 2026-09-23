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
