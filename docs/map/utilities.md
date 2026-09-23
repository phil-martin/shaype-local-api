# utilities

Domain: Shaype B2B Operations API (spec `info.title` "B2B Operations API", `info.version` "0.0.1"), tag **"Utilities API"** — "Set of assorted Utility APIs allowing creation of mock transactions" [spec]. 13 operations (verified by jq against ops.json).

Scope of these endpoints: staging-only mock/utility APIs that "mimic the messages that Shaype would normally receive from Visa during a real cardholder transaction" and from Cuscal/NPP/DE rails; "They are not exposed in production. Any attempt to call them in production will fail." [docs:simulates-card-transaction-on-staging]. The PayTo utilities exist because on staging "some parts of the process have been replaced by mocks as to not work on actual payments rails" [docs:payto-staging-testing-suite].

Source labels used below: `[spec]` = b2b-operations-api.json; `[spec:webhooks]` = notification-webhooks.json; `[spec:external-balance]` = external-balance.yaml; `[docs:<slug>]` = developer.shaype.com page; `[inferred]` = my reading, not stated anywhere; `[open]` = not stated in any source; listed in §7 for the implementer to decide.

Conventions shared by every operation in this domain [spec]:
- No `security` requirement and no `securitySchemes` are declared anywhere in the spec (`security: null`, `components.securitySchemes` absent). Docs say "A staging access with valid API credentials" is needed [docs:simulates-card-transaction-on-staging]; the auth mechanism is out of scope of this map.
- Every operation declares responses `200`, `400` (Bad Request), `403` (Forbidden), `422` (Unprocessable Content), `500` (Internal Server Error), `501` (Not Implemented). No operation declares `404` or `409`.
- All non-200 responses use `ErrorResponse` (`application/json`): `details` string ("Error details"), `message` string ("Error description"), `status` string ("HTTP response status"), `traceId` string ("TraceID that can be used by HAY for troubleshooting the request"). None are marked required.
- Every 200 (except `createStubForMandateSearchPaymentInstructions`, which declares no body) uses `GenericMessage`: `message` string ("Message indicating operation result").
- Request bodies are `application/json` and `required: true` for all 13 operations.
- No operation is marked `deprecated` in the spec.
- The spec gives **no** description of which failing condition maps to which status code for any of these operations; the mapping in "Behaviour" sections below is therefore [inferred] unless labelled otherwise.

## 1. Operations

### PATCH /v0/utils/cards/{cardId}/expiry-date (changeCardExpiryDate)

- Purpose: "Utility endpoint to change a card's expiry date." [spec]. Summary "Change Card Expiry Date". Not deprecated.
- Path params:
  - `cardId` — string, format `uuid`, required. "Unique identifier (UUID) of the Card" [spec].
- Query params: none.
- Request body: `ChangeCardExpiryDateRequestBody` ("Request to change a card's expiry date") [spec]
  - `expiryDate` — string, format `date`, **required**. "New card expiry date. Please use ISO date standard of YYYY-MM-DD". Example `"2027-09-30"`.
- Response: `200` `GenericMessage` `{ message }`. Errors 400/403/422/500/501 `ErrorResponse` [spec]. Message text on success: not given anywhere.
- Behaviour:
  - Writes `HayCard.expiryDate` of the card identified by `cardId` [spec description, entity field in §2]. `HayCard.expiryDate` is documented as "Expiry date of the Card (date of the last day of the expiry month and year)" [spec]; whether this endpoint normalises a mid-month input to month-end is not stated [open].
  - Whether setting a past date transitions `HayCard.cardStatus` to `EXPIRED` (or emits a `CARD_STATUS_CHANGE` webhook) is not stated anywhere [open]. Presumed use: testing card-expiry flows (`declineReason: CARD_EXPIRED` on the hold mocks, `CARD_EXPIRY_*` reminders in `NotificationDto.reminderType` [spec:webhooks]) [inferred].
  - Unknown `cardId`: no 404 declared; expect 422 or 400 [inferred]. Malformed uuid / non-date `expiryDate`: 400 [inferred].
  - Idempotent by nature (PATCH sets an absolute value) [inferred].
- Webhooks: none documented.

### POST /v0/utils/create-stub-search-payment-instructions (createStubForMandateSearchPaymentInstructions)

- Purpose: "Create stub for search payment instructions for a mandate." [spec summary; no description]. Registers the canned result that the PayTo endpoint `GET /v1/payto/initiator/mandates/{mandateId}/search` (`searchPaymentsInstructions`) will return for that mandate on staging [docs:payto-staging-testing-suite "Testing end-to-end identification of a payment", steps 3–4].
- Path/query params: none.
- Request body: `CreateStubForMandateSearchPaymentInstructionsRequestBody` ("Body of a request to create stub for mandate search payment instructions.") [spec]
  - `mandateIdentification` — string, **required**, pattern `^[0-9a-fA-F]{32}$`. "ID of the mandate related to the payment instruction expressed as Unique identifier (UUID) version 1 format without the 4 hyphen separators."
  - `paymentInstructionSummaries` — array, **required**, `minItems: 1`, items `PaymentInstructionSummary` ("Payment instruction list"):
    - `creationDateTime` — string, **required**, pattern `^(?:[1-9]\d{3}-(?:(?:0[1-9]|1[0-2])-(?:0[1-9]|1\d|2[0-8])|(?:0[13-9]|1[0-2])-(?:29|30)|(?:0[13578]|1[02])-31)|(?:[1-9]\d(?:0[48]|[2468][048]|[13579][26])|(?:[2468][048]|[13579][26])00)-02-29)T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.[0-9]{1,3})?(?:Z)$`. "Date and time at which the message was created, UTC expressed without offset, i.e. YYYY-MM-DDThh:mm:ss.sssZ".
    - `instructedAmount` — number, **required**. "Instructed amount".
    - `instructionIdentification` — string, **required**, pattern `^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}[A-Z0-9]{3}I[0-9]{8}00[0-9]{12}[0-9a-zA-Z]$`. "Payment instruction identification."
    - `transactionStatus` — string, **required**, enum verbatim: `RECV`, `UNDV`, `SENT`, `SAFD`, `ACCP`, `ACSP`, `ACSC`, `RJCT`. Spec description: "RECV: Received; UNDV: Undelivered; SENT: Sent; SAFD: Store & Forward; ACCP: Accepted for clearance by Receiver; ACSP: Settlement aborted by NPP BI; ACSC: Accepted & Settled; RJCT: Rejected".
    - `transactionStatusReasonCode` — string, optional, minLength 1, maxLength 4. "Reject reason code, defining the reason for the transaction status".
- Response: `200` "Success" with **no content schema declared** [spec]. Docs show the actual body `{"message": "Stub mapping for search payment instruction request created."}` [docs:payto-staging-testing-suite]. Errors 400/403/422/500/501 `ErrorResponse`.
- Behaviour:
  - Docs worked example [docs:payto-staging-testing-suite]: create ad-hoc mandate → `makeAdhocPayment` (response `instructionId` `ANNCAU22XXXI20231129000000000093410`, `endToEndId` `NET-1724` in the request) → call this stub with `mandateIdentification` = mandate id without hyphens (`121204288eb311ee8d7cc9dd305f4280` for mandate `12120428-8eb3-11ee-8d7c-c9dd305f4280`), one summary `{creationDateTime "2023-11-29T12:33:59.833Z", instructedAmount 1.28, instructionIdentification "ANNCAU22XXXI20231129000000000093410", transactionStatus "RECV", transactionStatusReasonCode "AB01"}` → `GET /v1/payto/initiator/mandates/{mandateId}/search` returns `{"paymentInstructions":[{"id":"ANNCAU22XXXI20231129000000000093410","amount":1.28,"creationDateTime":"2023-11-29T12:33:59.833Z","transactionStatus":"RECEIVED","transactionStatusReasonCode":"AB01","endToEndId":"NET-1724"}]}`.
  - So the search endpoint maps stub fields: `instructionIdentification`→`id`, `instructedAmount`→`amount`, `creationDateTime`→`creationDateTime`, `transactionStatus` 4-letter code→long form (`RECV`→`RECEIVED`), `transactionStatusReasonCode` passthrough; `endToEndId` is **not** part of the stub — it is joined from the platform's own record of the ad-hoc payment (`makeAdhocPayment.endToEndId`) [docs example; join mechanism inferred].
  - No state change to balances or mandates [inferred: it is a "stub mapping" for a mock server]. The word "mapping" and the docs' description of mocks being static suggest a second call for the same mandate replaces the earlier stub, but this is not stated [open].
  - Validation failures (pattern/minItems/enum/required) → 400 [inferred]. Whether the mandate must already exist on the platform is not stated [open].
- Webhooks: none documented.

### POST /v0/utils/generate-atm-transaction (generateAtmTransaction)

- Purpose: "Triggers a mock transaction request for a ATM card transaction without authorisation hold (i.e. a visa stand in)." [spec]. Summary "Trigger mock ATM card transaction".
- Path/query params: none.
- Request body: `GenerateCardTransactionRequestBody` ("Body of a request to insert a card transaction.") [spec] — shared with `generateRefundTransaction`.
  - `amount` — number, **required**, `maximum: 0`, `exclusiveMaximum: true` (i.e. **amount < 0**). "Transaction amount." Docs: "Pass a negative value as transaction will deduct the account balance." [docs:simulates-card-transaction-on-staging].
  - `cardToken` — string, **required**. "Public card token to use." = `HayCard.cardToken` ("Public token of the Card, maximum 9 digits in length") [spec]; "Use the token returned by Create Card for Customer or Get Card by ID" [docs:simulates-card-transaction-on-staging].
  - `currency` — string, optional, `nullable: true`, enum = the 162-value ISO 4217 list in §2 ("Currency"). "Transaction currency. Defaults to AUD if not provided."
  - `merchantDetails` — object `MerchantDetails` ("Details of the merchant"), optional:
    - `merchantCategoryCode` — string, nullable, pattern `^\d{4}$`. "Merchant Category Code (MCC) as four digit code as per ISO 18245".
    - `merchantId` — string, nullable. "Merchant ID, alphanumeric / special characters maximum 15 characters in length" (description only; no `maxLength` constraint in schema).
    - `merchantName` — string, nullable. "Merchant name".
  - Note: this body has **no** `cardUsage` and **no** `declineReason` (those exist only on the hold-based bodies) [spec]; the docs' field table confirms `cardUsage`/`declineReason` apply only to Hold, Hold+Settlement and Hold+Update [docs:simulates-card-transaction-on-staging].
- Response: `200` `GenericMessage`; errors 400/403/422/500/501 `ErrorResponse` [spec]. Success message text not documented.
- Behaviour [docs:simulates-card-transaction-on-staging unless noted]:
  - Preconditions: "A test customer with an active card issued in staging"; "A linked account with sufficient balance … If the balance is too low, the platform will decline the simulated authorisation, exactly as it would in production."
  - "Generates a mock ATM cash withdrawal against a card … a card transaction that arrives at the platform without a separate authorisation hold step and is treated as already settled."
  - "A single transaction is created and immediately reflected on the account. The Shaype platform performs the same internal balance, limit, rule, and fraud checks it would for a live transaction, derives a transaction outcome, and emits a webhook".
  - Balance effect [inferred from "settled in-line" + §4 formulas]: `totalBalance` and `availableBalance` both decrease by |amount|; `heldBalance` unchanged.
  - Decline: the platform "derives a transaction outcome" — a refused outcome (e.g. `REFUSED_NOT_ENOUGH_FUNDS`, `REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED`, `REFUSED_CARD_PREFERENCE` with `cardPreferenceOutcome: CASH_WITHDRAWAL_DISABLED`; full list in §2 `TransactionEventDto.outcome`) is reported in the webhook [docs + spec:webhooks]. Whether a declined mock still returns HTTP 200 (with the decline visible only in the webhook) is not stated [open; likely 200 — inferred from "emits a webhook with … outcome"].
  - Amount ≥ 0, unknown `cardToken`, bad MCC pattern, unknown currency → 400/422 [inferred; mapping not documented].
  - Idempotency: no idempotency key in the body; each call creates a new transaction [inferred].
- Webhooks [docs:simulates-card-transaction-on-staging]: one `NotificationDto` `type: TRANSACTION` with `transactionEvent.transactionType: CARD_TRANSACTION`, `isAtmTransaction: true`, `cardUsageDetails.isAtmWithdrawal: true`, `isPending: false` ("settled in-line, no separate _SETTLED event"). Merchant details "You will receive these merchant details in webhook" (`merchantName`, `merchantId`; `counterpartName` carries the merchant name in the samples on [docs:card-transactions]).

### POST /v0/utils/generate-auth-hold (generateAuthHold)

- Purpose: "Endpoint that triggers a mock authorisation hold transaction request." [spec]. Summary "Trigger mock card Hold". "Simulates the first half of a typical card transaction lifecycle — the moment a merchant requests approval and Shaype ring-fences the funds — without a subsequent settlement." [docs:simulates-card-transaction-on-staging].
- Path/query params: none.
- Request body: `GenerateCardHoldTransactionRequestBody` ("Body of a request to generate mock card authorisation hold transaction.") [spec]
  - `amount` — number, **required**, `maximum: 0`, `exclusiveMaximum: true` (amount < 0). "Transaction amount."
  - `cardToken` — string, **required**. "Public card token to use."
  - `cardUsage` — string, optional, nullable, enum verbatim: `MAGNETIC_STRIPE`, `CONTACTLESS`, `CARD_PRESENT`. "How the card was used for this transaction." Docs: "Useful for testing logic that branches on the card-usage flag in the resulting webhook" → maps to `cardUsageDetails.isMagneticStripePayment` / `isContactless` / `isCardPresent` [spec:webhooks field names; mapping inferred].
  - `currency` — string, optional, nullable, enum = Currency (§2). "Transaction currency. Defaults to AUD if not provided."
  - `declineReason` — string, optional, nullable, enum verbatim: `CARD_EXPIRED`, `WRONG_CVV`, `CVV_BLOCKED`, `INCORRECT_PIN`, `ALLOWED_PIN_RETRIES_EXCEEDED`, `INVALID_MERCHANT`, `CARD_IS_NOT_ACTIVE`, `RESTRICTED_CARD`. "The reason for which the card transaction was automatically declined by the payment processor." Docs: "When set, the simulated transaction is automatically declined by the payment processor with the given reason" and list additionally `PIN_BLOCKED`, which is **not** in the spec enum [docs:simulates-card-transaction-on-staging vs spec — discrepancy].
  - `merchantDetails` — `MerchantDetails` (see generateAtmTransaction), optional.
- Response: `200` `GenericMessage`; errors 400/403/422/500/501 [spec].
- Behaviour [docs:simulates-card-transaction-on-staging unless noted]:
  - Preconditions: active card; linked account with sufficient available balance (else decline, as in production).
  - "The Shaype platform runs its standard authorisation pipeline (balance check, limits, rules, fraud) and, if approved, increases the held balance and decreases the available balance on the account." `totalBalance` is unchanged by a hold (sample on [docs:card-transactions]: before/after hold `totalBalance 11.13`, `heldBalance 8.4`, `availableBalance 2.73` for a `-8.40` hold) [docs:card-transactions sample; arithmetic inferred].
  - The hold stays pending indefinitely — no settlement is generated by this endpoint. Hold expiry ("merchants have up to 7-10 days to request settlement") is production Visa behaviour [docs:card-transactions]; whether staging auto-expires mock holds is not stated [open].
  - `declineReason` set → transaction declined "by the payment processor" (i.e. simulating a Visa/processor decline, not a platform outcome). Which webhook fields carry it is not stated; `TransactionEventDto.cardProcessorResponse` is the field whose enum contains processor reasons (`INCORRECT_PIN`, `RESTRICTED_CARD`, `INVALID_MERCHANT`, `ALLOWED_PIN_RETRIES_EXCEEDED`, `CARD_IS_NOT_ACTIVE`, `EXPIRED_CARD`, `CVV_FAIL`, `CVV2_FAILURE`, …) [spec:webhooks]; note the request enum (`CARD_EXPIRED`, `WRONG_CVV`, `CVV_BLOCKED`) does **not** match those webhook values one-for-one, so the mapping is [open].
  - If the client uses External Authorisation, a hold triggers Shaype → client `POST /holds` (`authoriseHold`) with `Hold {holdId, accountId, cardId, customerId, amount{amount,currency}, merchantDetails{merchantId,name,merchantCategoryCode,terminalId,cardAcceptorLocation,address}}`; the client may refuse with HTTP `470` + `Response {errorCode ∈ REFUSED_MAX_BALANCE_EXCEEDED | REFUSED_NOT_ENOUGH_FUNDS | REFUSED_SENDER_ACCOUNT_NOT_VERIFIED, reason}` [spec:external-balance; linkage to this mock inferred].
  - Errors: amount ≥ 0 / bad enum / missing cardToken → 400 [inferred]; unknown cardToken → 422 or 400 [open].
  - Idempotency: none (no key); each call creates a new hold [inferred].
- Webhooks [docs:simulates-card-transaction-on-staging]: one `TRANSACTION` notification: `transactionType: CARD_TRANSACTION`, `isPending: true`, "`holdHayId` and `transactionHayId` set to the same value (the original hold ID)". Sample payload (hold) in [docs:card-transactions] §1: `currencyAmount {AUD, -8.40}`, `updatedBalance {AUD, 2.73}`, `outcome ACCEPTED`, `accountBalances {totalBalance 11.13, heldBalance 8.4, lockedBalance 0, stacksBalance 0, availableBalance 2.73}`, `cardUsageDetails {isMagneticStripePayment null, isContactless null, isCardPresent true, isMobileWalletPayment false, isAtmWithdrawal false}`, `isAtmTransaction false`, `counterpartName "IGA (Mt Cotton)"`, `merchantId "000009493578577"`, `merchantName null`, `category null`, `mandatePaymentDetails null`, `returnReason null`.

### POST /v0/utils/generate-card-transaction (generateCardTransaction)

- Purpose: "Triggers a mock authorisation hold followed by an auth hold settling transactions." [spec]. Summary "Trigger mock card Hold and Settlement". "The most common card transaction flow … a normal merchant purchase that completes successfully end-to-end." [docs:simulates-card-transaction-on-staging].
- Path/query params: none.
- Request body: `GenerateCardHoldAndSettleTransactionRequestBody` ("Body of a request to insert a card authorisation, followed by a settlement.") [spec]
  - `amount` — number, **required**, < 0 (`maximum 0`, `exclusiveMaximum true`).
  - `cardToken` — string, **required**.
  - `cardUsage` — optional, nullable, enum `MAGNETIC_STRIPE`, `CONTACTLESS`, `CARD_PRESENT`.
  - `currency` — optional, nullable, enum Currency (§2); default AUD.
  - `declineReason` — optional, nullable, enum `CARD_EXPIRED`, `WRONG_CVV`, `CVV_BLOCKED`, `INCORRECT_PIN`, `ALLOWED_PIN_RETRIES_EXCEEDED`, `INVALID_MERCHANT`, `CARD_IS_NOT_ACTIVE`, `RESTRICTED_CARD`.
  - `merchantDetails` — `MerchantDetails`, optional.
  - `settlementDelayInSeconds` — integer (`int32`), optional, `minimum 5`, `maximum 300`. "Number of seconds to delay the settlement by. Has to be between 5 and 300 seconds." Default when omitted: not stated [open].
- Response: `200` `GenericMessage`; errors 400/403/422/500/501 [spec]. The 200 is returned when the hold is created; settlement happens asynchronously after the delay [inferred from "delay the settlement"].
- Behaviour [docs:simulates-card-transaction-on-staging + docs:card-transactions §1]:
  - Step 1 hold: as generateAuthHold (checks; `heldBalance` ↑ |amount|, `availableBalance` ↓ |amount|; `totalBalance` unchanged).
  - Step 2 settlement after `settlementDelayInSeconds`: "The hold is released and the funds are removed from the total balance" — `heldBalance` ↓ |amount|, `totalBalance` ↓ |amount|, `availableBalance` unchanged (sample: hold `total 11.13/held 8.4/avail 2.73` → settled `total 2.73/held 0/avail 2.73`) [docs:card-transactions sample].
  - Settlement amount equals the hold amount [inferred from samples; the endpoint has no separate settlement amount field].
  - `declineReason` set → the hold is declined; whether a settlement is then still attempted is not stated [open; presumably not — inferred].
  - `settlementDelayInSeconds` outside 5..300 → 400 [inferred from schema min/max].
  - External Authorisation: hold → client `POST /holds`; settlement has no callback in external-balance.yaml [spec:external-balance; inferred].
  - Idempotency: none.
- Webhooks [docs:simulates-card-transaction-on-staging]: two `TRANSACTION` notifications in sequence: (1) hold `transactionType: CARD_TRANSACTION`, `isPending: true`; (2) settlement `transactionType: CARD_TRANSACTION_SETTLED`, `isPending: false`. "The hold and settlement carry different `transactionHayId` values, but the settlement's `holdHayId` references the original hold so they can be tied together." Settlement sample [docs:card-transactions]: `transactionHayId 888858f5-…`, `holdHayId 44449ce6-…` (= hold's id), `currencyAmount -8.40`, `isPending false`, `outcome ACCEPTED`, `accountBalances {total 2.73, held 0, locked 0, stacks 0, available 2.73}`. `holdHayId` "is also referred to as `relatedHoldHayId` when `isPending` flag is `false`" [spec:webhooks].

### POST /v0/utils/generate-de-inbound (generateInboundDeTransaction)

- Purpose: "Generate mock inbound DE request." [spec summary; no description]. Simulates a Direct Entry (BECS) file item arriving at Shaype from an external bank: a direct credit, a direct debit, a return, or a refusal-of-return [spec field descriptions; framing inferred]. No docs page covers this endpoint; the DE product page [docs:direct-debits] describes the production webhooks only.
- Path/query params: none.
- Request body: `GenerateInboundDeRequestBody` ("Body of an inbound DE request.") [spec]
  - `amount` — number, **required**, `minimum 0`, `exclusiveMinimum true` (amount > 0). "Transaction amount." Example `147.23`.
  - `description` — string, optional. "Transaction description." Example `"Invoice 123456"`.
  - `idempotencyKey` — string, format `uuid`, **optional**. "Idempotency key to uniquely represent this request and prevent duplication." Example `"79ac5cce-3349-42ed-aa67-9764c8a35d31"`.
  - `recipientAccountNumber` — string, **required**, pattern `\d{5,9}`. "Recipient account number." Example `"522843"`.
  - `recipientBsb` — string, **required**, pattern `\d{6}`. "Recipient account BSB." Example `"35022223"` (**the spec's example is 8 digits and violates its own `\d{6}` pattern — the account-number and BSB examples appear swapped** [spec]).
  - `recipientName` — string, optional. "Recipient name." Example `"Han Solo"`.
  - `recordType` — string, **required**, enum verbatim: `DIRECT`, `RETURN`, `REFUSAL`. "Direct entry record type. Possible values: DIRECT: Money transfer request; RETURN: Return money transfer request with a reason; REFUSAL: Refuse to accept return of request with a reason".
  - `refusalReason` — string, optional (but "Required for record type REFUSAL"), enum verbatim: `RETURN_RECEIVED_OUT_OF_TIME`, `INSUFFICIENT_INFORMATION_TO_APPLY`, `REVERSAL_OF_DUPLICATED_ITEM`, `NO_ARRANGEMENT`, `TECHNICALLY_INVALID`. "Reason of refusing return. Required for record type REFUSAL."
  - `returnReason` — string, optional (but "Required for record type RETURN"), enum verbatim: `INVALID_BSB_NUMBER`, `PAYMENT_STOPPED`, `ACCOUNT_CLOSED`, `CUSTOMER_DECEASED`, `NO_ACCOUNT_OR_INCORRECT_ACCOUNT_NUMBER`, `REFER_TO_CUSTOMER`, `INVALID_USER_ID`, `TECHNICAL_INVALID`. "Reason of returning request. Required for record type RETURN."
  - `senderAccountNumber` — string, **required**, pattern `\d{5,9}`. "Sender account number." Example `"112836327"`.
  - `senderBsb` — string, **required**, pattern `\d{6}`. "Sender BSB." Example `"302227"`.
  - `senderName` — string, optional. "Sender name." Example `"Darth Vader"`.
  - `transactionType` — string, **required**, enum verbatim: `CREDIT`, `DEBIT`. "Direct entry transaction type. Possible values: CREDIT: Move money from sender account to recipient account; DEBIT: Move money from recipient account to sender account".
  - Spec request examples (verbatim) [spec]:
    - "Inbound Direct Credit request": `{"recordType":"DIRECT","transactionType":"CREDIT","amount":11.98,"recipientAccountNumber":"35022223","recipientBsb":"522843","senderAccountNumber":"112836327","senderBsb":"302227"}`
    - "Inbound Direct Debit request": `{"recordType":"DIRECT","transactionType":"DEBIT","amount":11.98,"recipientAccountNumber":"35022223","recipientBsb":"522843","senderAccountNumber":"112836327","senderBsb":"302227"}`
    - "Refuse return of inbound direct debit request": `{"recordType":"REFUSAL","refusalReason":"RETURN_RECEIVED_OUT_OF_TIME","transactionType":"DEBIT","amount":11.98,"recipientAccountNumber":"35022223","recipientBsb":"522843","senderAccountNumber":"112836327","senderBsb":"302227"}`
    - "Return outbound direct debit request": `{"recordType":"RETURN","returnReason":"ACCOUNT_CLOSED","transactionType":"DEBIT","amount":11.98,"recipientAccountNumber":"112836327","recipientBsb":"302227","senderAccountNumber":"35022223","senderBsb":"522843"}` (sender/recipient swapped relative to the other three: the Shaype-side account `35022223`/`522843` is now the sender, i.e. the party that originated the outbound DD being returned).
    - In these examples the Shaype account is `522843` (BSB) / `35022223` (account) — consistent with `HayAccount.bsb` "6 digits" and `HayAccount.accountNumber` "5-9 digits" [spec]; the property-level examples are the ones that are swapped.
- Response: `200` `GenericMessage`; errors 400/403/422/500/501 [spec]. Success message text not documented.
- Behaviour (all [inferred] from field descriptions + [docs:direct-debits] production semantics, since no docs describe the mock):
  - `DIRECT`+`CREDIT`: money moves sender→recipient. Recipient is resolved as the Shaype `HayAccount` with `bsb = recipientBsb` and `accountNumber = recipientAccountNumber`; it is credited by `amount` (`totalBalance` and `availableBalance` ↑). Production webhook for "customer account receives funds from an external bank" is `TRANSACTION` / `transactionType: INTERBANK_TRANSFER_IN` with `counterpartName`, `counterpartDetails.name`, `category "BANK_TRANSFER"`, `description` [docs:direct-debits sample]; `counterpartDetails.basicAccountNumber {accountNumber, branchNumber}` exists in the schema [spec:webhooks `CounterpartDetails`] but is not shown in the inbound sample [inferred whether the mock populates it] — the mock is presumed to emit the same [inferred].
  - `DIRECT`+`DEBIT`: money moves recipient→sender, i.e. an external biller pulls funds from the Shaype account (`recipientBsb`/`recipientAccountNumber`) — an *inbound direct debit*. Production webhook: `TRANSACTION` / `transactionType: DIRECT_DEBIT_TRANSFER` ("when external bank account pull funds from customer account using Direct Debit") [docs:direct-debits]. Platform limit outcomes that exist for this: `REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED`, `REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED` [spec:webhooks outcome enum; docs:payment-transaction-outcome]. `authorisationTransactionType: DIRECT_DEBIT_TRANSFER` is also one of the External Authorisation `POST /transactions` types [spec:external-balance].
  - `RETURN`: simulates the external bank returning a previously sent DE item with `returnReason`. Given the example name "Return outbound direct debit request" and sender=Shaype account, this targets an outbound DD created via `POST /v1/direct-debits` (`createDirectDebitV1`) [docs:direct-debits: "Shaype will monitor over 2 working days to catch if a Direct Debit is returned"]. Expected effects: `DIRECT_ENTRY` webhook with `directEntryEvent.status: RETURNED` (`DirectEntryEventDto.status` enum `RECEIVED, ACCEPTED, REJECTED, SUBMITTED, RETURNED, COMPLETE, INCOMPLETE`; `type: DEBIT`; `direction: OUTBOUND`) and/or a reversing `TRANSACTION` with `returnReason {code, message}` [spec:webhooks; linkage inferred]. How the mock matches the returned item to the original outbound DD (by amount + BSB/account? by `idempotencyKey`?) is not stated [open]. Mapping of the request `returnReason` enum to webhook `ReturnReason.code` (`ACCOUNT_BLOCKED, ACCOUNT_CLOSED, ACCOUNT_INVALID, AMOUNT_INVALID, CANCELLED, CURRENCY_INVALID, CUSTOMER_REQUEST, DUPLICATE, FRAUD, OTHER`) is not stated [open].
  - `REFUSAL`: "Refuse to accept return of request with a reason" — the external bank refuses a return that Shaype sent (example: "Refuse return of inbound direct debit request"), i.e. after Shaype returned an inbound DD, the originator refuses that return. Effects on the platform are undocumented [open].
  - Validation [inferred]: `recordType RETURN` without `returnReason`, or `REFUSAL` without `refusalReason` → 400/422; amount ≤ 0, bad BSB/account patterns → 400; no Shaype account matching recipient (for DIRECT) → 422 or 400 [open].
  - Idempotency: `idempotencyKey` is optional; a repeat with the same key is presumably rejected or ignored ("prevent duplication") — response code unknown [open]; without a key every call creates a new item [inferred].
- Webhooks: none documented for the mock; production equivalents as above ([docs:direct-debits]): `TRANSACTION` with `INTERBANK_TRANSFER_IN` / `DIRECT_DEBIT_TRANSFER`, and `DIRECT_ENTRY` (`DirectEntryEventDto`) whose spec says "Currently only the `DEBIT` type is supported" and "Currently only the `OUTBOUND` direction is supported" [spec:webhooks].

### POST /v0/utils/generate-inbound-npp-transaction-v2 (generateInboundNppTransactionV2)

- Purpose: "Generate mock NPP inbound transaction v2." [spec summary]. Simulates Cuscal's **Receive A Payment (RAP)** message — an NPP credit arriving at a Shaype account, optionally as the PayTo payment for a mandate, or as an inbound *payment return* [spec schema descriptions + docs:payto-staging-testing-suite step 5].
- Path/query params: none.
- Request body: `GenerateRapRequestBody` ("Encapsulates payment data for payment initiated by the payer directly into payee's account") [spec]
  - `creditorInformation` — **required**, `GenerateRapCreditorInformation` ("Mandate payment creditor party information."):
    - `accountIdentification` — string, **required**, minLength 0, maxLength 34. "Creditor's account identifier i.e. BSB and Account number". Docs sample `"63610027487941"` (= BSB `636100` + account `27487941`, concatenated) [docs:payto-staging-testing-suite].
    - `accountIdentificationTypeCode` — string, **required**, minLength 4, maxLength 4. "Creditor's account's scheme". Docs sample `"BBAN"`.
    - `ultimatePartyName` — string, optional, 0..140. "Ultimate Creditor Name Must be populated when there is value against unique_superannuation_identification or unique_superannuation_code". Docs sample `"JOE BLOGGS"`.
  - `debtorInformation` — **required**, `GenerateRapDebtorInformation` ("Mandate payment debtor party information."):
    - `accountIdentification` — string, **required**, 0..34. "Debtor account identifier i.e. BSB and Account number". Docs sample `"63610079412687"`.
    - `accountIdentificationTypeCode` — string, **required**, len 4. "Debtor account scheme." Docs sample `"BBAN"`.
    - `partyName` — string, **required**, 0..140. "Debtor name Debtor Agent records (may be different from the Debtor's legal name)". Docs sample `"JOHN MAXIMILLIAN DOE"`.
  - `initgPtyIdOrgId` — string, **required**, pattern `^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}[A-Z0-9]{3}$` (BIC11). "InitgPtyIdOrgId is the BIC11 of the client sending the payment instruction to Cuscal. Please note this value will be provided to you by Cuscal as part of on-boarding". Docs sample `"NPBOAU21XXX"`.
  - `mandateInformation` — optional, `GenerateRapMandateInformation` ("Information on the mandate associated with the payment request."):
    - `initiatingPartyName` — string, optional, pattern `^[ -~]{1,140}$`. "Initiating Party Name. Must be populated for mandate payments".
    - `instructionIdentification` — string, optional, pattern `^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}[A-Z0-9]{3}I[0-9]{8}00[0-9]{12}[01]$`. "Unique mandate payment instruction identification assigned by the instructing party. Must be populated for mandate payments". Docs: "should be the same as the ID generated when triggering ad-hoc payment" (`makeAdhocPayment.instructionId`, e.g. `ANNCAU22XXXI20230718000000000077240`).
    - `mandateIdentification` — string, **required** (within this object), pattern `^[a-f0-9]{12}1[a-f0-9]{3}[89ab][a-f0-9]{15}$` (lower-case UUID v1 without hyphens). "Mandate ID associated to the transaction. Must be populated for mandate payments. … For example: '00000000000010008000000000000000' instead of '00000000-0000-1000-8000-000000000000'".
  - `paymentId` — string, **required**, pattern `^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}[A-Z0-9]{3}[0-9]{23}$`. "paymentId is the unique Payment Transaction ID of a payment that has been previously submitted to Cuscal." Docs sample `"ANNCAU22XXX20230718000000000077240"`.
  - `paymentInformation` — **required**, `GenerateRapPaymentInformation` ("Mandate payment initiation information."):
    - `categoryPurposeCode` — string, optional, len 4. "Payment Category code … '4-CategoryPurpose' tab … \"EPAY\", \"SALA\", \"SUPP\", \"PENS\", \"TAXS\"" (examples only, not an enum). Docs sample `"SALA"`.
    - `endToEndIdentification` — string, **required**, 0..35. "End to End identifier. This is the Debtor's (customer) reference for the Payment to be provided to Creditor (customer). … If the payer does not populate, the default value will apply."
    - `instructedAmount` — string, **required**, pattern `^(?=.{1,19}$)[0-9]{0,18}(?:\.[0-9]{0,2})?$` (decimal string, ≤2 dp). "Instructed amount". Docs sample `"2"`.
    - `originalMessageIdentification` — string, **required**, minLength 34, maxLength 34. "The original messageID of the incoming payment." Docs sample `"ANNCAU22XXX20230718000000000077240"`.
    - `remittanceInformationUnstructured` — string, optional, 0..280. "Payment Description For category_purpose_code = SALA, Comments relating to specific employee information will be provided in this field." Example `"This is a payment for invoice number 123456."`.
    - `transactionIdentification` — string, **required**, pattern `^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}[A-Z0-9]{3}N[0-9]{8}00[0-9]{12}[01]$`. "A unique Payment Transaction Identifier generated by the sending client. … 1 to 11 clients BIC11 - 12 fixed value 'N' - 13 to 20 YYYYMMDD - 21 to 22 fixed value '00' - 23 to 34 sequence number starting from 000000000001 - 35 retry counter, always set to 0 unless its a retry, retries start at 1." Example `"BANKNTSTXXXN20180501000000000000010"`.
    - `uniqueSuperannuationCode` — string, optional. "For category_purpose_code = PENS, Comments relating to USI code …".
  - `paymentReturnInformation` — optional, `GenerateRapPaymentReturnInformation` ("Encapsulates payment data for payment initiated by the payer directly into payee's account."):
    - `originalTransactionIdentification` — string, optional, minLength 35, maxLength 35. "Original payment transaction ID. It will be present if a genuine response is received from BI." Example `"BANKNTSTXXXN20180511CT0000458203590"`.
    - `returnAmount` — string, optional, decimal pattern as above. "Interbank settlement amount. It will be present if a genuine response is received from BI." Example `"100.0"`.
    - `returnReasonCode` — string, optional, len 4. "Payment return reason code. If this field is populated, then this is a inbound payment return ".
- Response: `200` `GenericMessage`; docs sample `{"message": "Receive A Payment generated."}` [docs:payto-staging-testing-suite]. Errors 400/403/422/500/501 [spec].
- Behaviour:
  - PayTo creditor leg [docs:payto-staging-testing-suite step 5]: "To simulate a process of receiving a payment and assigning correct amount of resources to creditor's account, RAP needs to be manually initiated" — the creditor Shaype account (resolved from `creditorInformation.accountIdentification` = BSB+account [docs sample; resolution inferred]) is credited by `paymentInformation.instructedAmount` [inferred: "assigning correct amount of resources to creditor's account"].
  - Docs notes on IDs [docs:payto-staging-testing-suite]: `instructionIdentification` = the ad-hoc payment's `instructionId`; "`PaymentID` and `originalMessageIdentification` should have the same ID as `instructionIdentification` but after first part of the ID that indicates Business Identifier Code (BIC - ANNCAU22XXXI2) should be removed"; "`OriginalMessageIdentification` should contain additional letter N after BIC code". **The docs sample contradicts the last note**: it uses `originalMessageIdentification "ANNCAU22XXX20230718000000000077240"` (no `N`) and `transactionIdentification "ANNCAU22XXXN20230718000000000077240"` (with `N`). Pattern-wise `originalMessageIdentification` is just any 34-char string, so both satisfy the spec [open which the mock expects].
  - Docs sample mandate id `"12125151256111ee9a8e4b632ff6f510"` vs mandate `1212c23a-255c-…` used earlier — sample values are not internally consistent; treat as illustrative [docs].
  - Non-mandate use: `mandateInformation` is optional, so a plain inbound NPP credit can be generated [spec]; in that case the production webhook would be `TRANSACTION` / `INTERBANK_TRANSFER_IN` ("when customer account receives funds from an external bank") with `counterpartDetails.name`, `category "BANK_TRANSFER"`, `description` [docs:payments sample] [inferred that the mock emits it].
  - Mandate use: the transaction webhook additionally carries `transactionEvent.mandatePaymentDetails {mandateId, instructionId, initiatingPartyName}` [spec:webhooks `MandatePaymentDetails`; docs:payto-payment "webhook notification of the payment with transaction event object that contain mandateId and Payment InstructionId"] and `originType: MANDATE_PAYMENT` [spec:webhooks enum; inferred]. Whether a `MANDATE_PAYMENT` notification (`MandatePaymentEventDto {instructionId, mandateId, paymentStatus, reasonCode, transactionHayId, isFinal, originId, originType}`) is also emitted by the mock is not stated [open].
  - Payment return (`paymentReturnInformation.returnReasonCode` populated → "this is a inbound payment return") [spec]: models an outbound NPP payment coming back; production shows this as a `TRANSACTION` with `returnReason {code, message}` on the `INTERBANK_TRANSFER_OUT` reversal ("In reversal transfer webhook you will receive returnReason object") [docs:payments]. Which outbound transaction is reversed (matched by `originalTransactionIdentification`?) is not stated [open].
  - External Authorisation: an inbound credit maps to client `POST /transactions` with `authorisationTransactionType: INBOUND_PAYMENT` [spec:external-balance; linkage inferred].
  - Errors: pattern/length violations → 400 [inferred]; creditor account not found → 422 [inferred; docs' only 422 sample (quoted in §6) is from `createMandate` with `description: mandate_rejected` [docs:payto-staging-testing-suite §2.2]; no 422 body for a Utilities op is documented [open]].
  - Idempotency: no idempotency key; `paymentId`/`transactionIdentification` are described as unique but no dedup behaviour is stated [open].
- Webhooks: see above — `TRANSACTION` (`INTERBANK_TRANSFER_IN`, with `mandatePaymentDetails` when a mandate is referenced) [docs:payments, docs:payto-payment, spec:webhooks; emission by the mock inferred].

### POST /v0/utils/generate-mandate-notification-initiator (generateMandateNotificationForInitiator)

- Purpose: "Generate mock Mandate notification for Initiator." [spec summary]. Simulates the notification that the Mandate Management System (MMS, via Cuscal) sends to Shaype about a mandate action, delivered to the client in its **Initiator** role [docs:payto-staging-testing-suite; docs:payto-notifications].
- Path/query params: none.
- Request body: `GenerateInitiatorMandateNotificationRequestBody` ("Body of a request to notify initiator about mandate operation preformed.") [spec]
  - `actionDetails` — **required**, `GenerateMandateNotificationActionDetailsDto` ("Details of an action performed on a mandate."):
    - `actionId` — string, **required**, pattern `^[0-9a-fA-F]{32}$`. "Identifier of the action performed expressed as Unique identifier (UUID) version 1 format without the 4 hyphen separators." Docs sample `"34927ba11a6811ee84e91d8ebf04eef2"`.
  - `mandateDetails` — **required**, `GenerateMandateNotificationMandateDetailsDto` ("Mandate details"), required sub-fields `debtorInformation`, `mandateId`, `paymentInformation`, `validityStartDate`:
    - `creditorInformation` — optional, `GenerateMandateNotificationCreditorInformationDto`: `accountIdentification` string, **required**, minLength 7, maxLength 34, "Creditor account identification in BBAN format." Docs sample `"63663630855474"`.
    - `debtorInformation` — **required**, `GenerateMandateNotificationDebtorInformationDto`: `accountIdentification` string, **required**, 7..34, "Debtor account identification in BBAN format." Docs sample `"63663672104323"`.
    - `description` — string, optional, 1..140. "Reason for the mandate setup as narrative text."
    - `mandateId` — string, **required**, pattern `^[0-9a-fA-F]{32}$`. "Identifier of the mandate affected by action expressed as Unique identifier (UUID) version 1 format without the 4 hyphen separators." Docs sample `"1212c423262b11ee844d95ee6a0c000c"` for mandate `1212c423-262b-11ee-844d-95ee6a0c000c`.
    - `paymentInformation` — **required**, `GenerateMandateNotificationPaymentInformationDto` ("Set of characteristics detailing mandate payment information."), required sub-field `paymentFrequency`:
      - `amount` — string, optional, pattern `^(?=.{1,19}$)[0-9]{0,18}(?:\.[0-9]{0,2})?$`. "Fixed amount to be debited from the debtor's account."
      - `countPerPeriod` — string, optional, pattern `^(?=.{1,19}$)[0-9]{0,19}(?:\.[0-9]{0,18})?$`. "Qualifies the frequency in terms of the number of instructions to be created and processed during the specified period."
      - `firstPaymentAmount` — string, optional, decimal pattern. "Amount different from the payment amount, as it includes the costs associated with the first debited amount."
      - `firstPaymentDate` — string, optional, date pattern (YYYY-MM-DD with leap-year rules). "Date of the first payment predefined in mandate expressed in YYYY-MM-DD format."
      - `lastPaymentAmount` — string, optional, decimal pattern. "Last payment amount different to the payment amount."
      - `lastPaymentDate` — string, optional, date pattern.
      - `maximumAmount` — string, optional, decimal pattern. "Maximum amount that may be paid from the debtor's account, per instruction."
      - `paymentAmountType` — string, optional, **no enum in schema**; description lists `BALN` (Balloon), `FIXE` (Fixed), `USGB` (Usage Based), `VARI` (Variable).
      - `paymentFrequency` — string, **required**, **no enum in schema**; description lists `ADHO` (Adhoc), `DAIL` (Daily), `FRTN` (Fortnightly), `INDA` (IntraDay), `MIAN` (SemiAnnual), `MNTH` (Monthly), `QURT` (Quarterly), `WEEK` (Weekly), `YEAR` (Annual).
      - `pointInTime` — string, optional, pattern `^[0-9]{2}$`. "Qualifies the frequency in terms of an exact point in time or moment within the specified period."
    - `shortDescription` — string, optional, 1..35. "Short description of the reason for mandate setup as narrative text."
    - `validityEndDate` — string, optional, date pattern. "End date of the validity of the mandate expressed in YYYY-MM-DD format.. If specified, the mandate is valid until 23:59:59.999 Australia Sydney time on this date."
    - `validityStartDate` — string, **required**, date pattern. "Start date of the validity of the mandate expressed in YYYY-MM-DD format.. The mandate is valid as of 00:00:00.000 Australia Sydney time on this date."
  - `trigger` — string, **required**, minLength 4, maxLength 4. Spec `enum` is **malformed**: a single value `"MCRC,MCRD,MCRX,MAMC,MAMD,MAMN,MAMX,MPOF,MPOT,MPOX,MSCH"` (one comma-joined string). Intended values per the description: `MCRC` Mandate Create Confirmed, `MCRD` Mandate Create Declined, `MCRX` Mandate Create Expired, `MAMC` Mandate Amend Confirmed, `MAMD` Mandate Amend Declined, `MAMN` Mandate Amended, `MAMX` Mandate Amend Expired, `MPOF` Mandate Port Finalised, `MPOT` Mandate Ported, `MPOX` Mandate Port Expired, `MSCH` Mandate Status Changed [spec]. Docs additionally send `"trigger": "PCRD"` to this endpoint ("Payer mandate create declined" in the webhook enum) [docs:payto-staging-testing-suite §2.1 step 3] — not in the spec list; the mock evidently accepts at least that value.
  - Docs sample request (MCRX) [docs:payto-staging-testing-suite]: `{"trigger":"MCRX","actionDetails":{"actionId":"34927ba11a6811ee84e91d8ebf04eef2"},"mandateDetails":{"mandateId":"1212c423262b11ee844d95ee6a0c000c","creditorInformation":{"accountIdentification":"63663630855474"},"debtorInformation":{"accountIdentification":"63663672104323"},"paymentInformation":{"amount":"1.00","countPerPeriod":"1","firstPaymentAmount":"2.00","firstPaymentDate":"2023-06-15","lastPaymentAmount":"3.00","lastPaymentDate":"2024-06-15","maximumAmount":"4.00","paymentAmountType":"VARI","paymentFrequency":"DAIL","pointInTime":"10"},"validityStartDate":"2023-06-15","validityEndDate":"2024-06-15"}}`.
- Response: `200` `GenericMessage`; docs sample `{"message": "Mandate Notification for Initiator generated."}` [docs:payto-staging-testing-suite]. Errors 400/403/422/500/501 [spec].
- Behaviour [docs:payto-staging-testing-suite unless noted]:
  - Mock mandates are static: "trying to change a mandate status will not actually change it - mocks identify their data based on a pattern in the mandate ID." Status is fixed at creation by the mandate `description` (`status:created|active|suspended|cancelled`, default active). Therefore this endpoint does **not** change `Mandate.status` [inferred from the above].
  - Side effects by trigger:
    - `MCRC`: "Scheduling of a payment is done when information about successful mandate creation is received by the system. To schedule a payment based on a mandate on mocks, simply send notification with `MCRC` trigger" — creates the scheduled payment initiation request for a non-ad-hoc (fixed frequency) mandate ("Currently, only the next upcoming payment is scheduled").
    - `MAMC`: "If there is an uninitiated scheduled payment for a mandate where payment terms have been amended then that scheduled payment is replaced by a new one which bases its content on new data … To simulate replacement of uninitiated scheduled payment, call the endpoint … with `MAMC` trigger".
    - `MCRD`: "To test a scenario where mandate creation has been rejected, simply create a mandate with the status `Created` and then use [this endpoint] with reason code `MCRD`".
    - `MCRX`: "after 6 days mandate should be automatically rejected and set into `CANCELED` status by MMS … Initiator then receives a notification that the action has expired. To simulate this behaviour, simply create a mandate in `CREATED` status, then manually trigger a notification to Initiator … with `MCRX` trigger."
    - `MSCH`: "On production, status changes to mandates should send a notifications to both Initiator and Payer with specific `MSCH` trigger. To simulate this behaviour use following endpoints while providing described trigger".
    - `PCRD` (docs only): "generate a notification with `PCRD` trigger which simulates a received response about a mandate being rejected by Payer".
    - Recall triggers `MCRR` / `MAMR`: "Current endpoints for notification creation doesn't allow to use this trigger."
  - Delivered to the client as a `NotificationDto` `type: MANDATE` with `mandateEventDto` (`MandateEventDto {mandateId uuid, actionId uuid, description, trigger}`) [spec:webhooks; that the mock emits exactly this is inferred — docs say only "Initiator then receives a notification"]. Also possibly `MANDATE_ACTION_EXPIRATION` for `MCRX`/`MAMX` [spec:webhooks `NotificationDto.type`; inferred].
  - The `mandateDetails` payload (payment terms, dates, parties) is what the MMS would carry; whether the mock persists it (e.g. updates stored payment terms on `MAMN`) is not stated [open].
  - Errors: bad pattern / missing required → 400 [inferred]; trigger not in accepted set → 400/422 [inferred]; mandate not found → 422 [inferred].
  - Idempotency: none stated; `actionId` is an identifier but no dedup is described [open].
- Webhooks: `MANDATE` (`MandateEventDto.trigger` = the request trigger) [inferred as above].

### POST /v0/utils/generate-mandate-notification-payer (generateMandateNotificationForPayer)

- Purpose: "Generate mock Mandate notification for Payer." [spec summary]. Same as the Initiator variant but for the client's **Payer** (debtor-side) role [docs:payto-staging-testing-suite "For Payer"].
- Path/query params: none.
- Request body: `GeneratePayerMandateNotificationRequestBody` ("Body of a request to notify payer about mandate operation preformed.") [spec]
  - `actionDetails` — **required**, `GenerateMandateNotificationActionDetailsDto` (`actionId` 32-hex, required) — identical to Initiator variant.
  - `mandateDetails` — **required**, `GenerateMandateNotificationMandateDetailsDto` — identical to Initiator variant (see above for all sub-fields).
  - `trigger` — string, **required**, minLength 4, maxLength 4. Spec `enum` again malformed: single value `"MCRX,MCRT,MCRP,MAMN,MAMP,MAMR,MAMX,MSCH"`. Intended values per description: `MCRX` Mandate Create Expired, `MCRT` Mandate Created, `MCRP` Mandate Create Proposed, `MAMN` Mandate Amended, `MAMP` Mandate Amend Proposed, `MAMR` Mandate Amended Recalled, `MAMX` Mandate Amend Expired, `MSCH` Mandate Status Changed [spec].
- Response: `200` `GenericMessage`; errors 400/403/422/500/501 [spec]. Success text not shown in docs; by analogy "Mandate Notification for Payer generated." [inferred].
- Behaviour:
  - Docs only reference it for `MSCH` ("For Payer: Generate mock Mandate notification for Payer") [docs:payto-staging-testing-suite]. Production semantics of the triggers [docs:payto-notifications]: `MCRT` "Mandate Requires Authorisation" (Payer), `MAMP` "Mandate Amend Proposed" (Payer), `MSCH` "Mandate Status Changed" (Payer & Initiator), `MAMX`/`MCRX` expiry (Payer and Initiator).
  - No state change to the mock mandate [inferred, same reasoning as Initiator]. No scheduling side effects are documented for the Payer side [docs silent].
  - Delivered as `NotificationDto` `type: MANDATE` / `MandateEventDto` [spec:webhooks; inferred].
  - Errors / idempotency: as Initiator variant [inferred].
- Webhooks: `MANDATE` [inferred].

### POST /v0/utils/generate-npp-inbound (generateInboundNppTransaction)

- Purpose: "Generate mock NPP inbound transaction." [spec summary; no description]. Simple (v1) inbound NPP credit to a Shaype account by BSB/account number; superseded for PayTo flows by `generateInboundNppTransactionV2` (the docs use only v2) but **not** marked deprecated [spec; docs:payto-staging-testing-suite]. No docs page describes this endpoint.
- Path/query params: none.
- Request body: `GenerateInboundNppTransactionRequestBody` ("Body of a request to insert an inbound NPP transaction.") [spec] — all of the following are **required** except `reference`:
  - `amount` — number, **required**, `minimum 0`, `exclusiveMinimum true` (amount > 0). "Transaction amount."
  - `description` — string, **required**, minLength 1. "Transaction description."
  - `idempotencyKey` — string, format `uuid`, **required**. "Idempotency key to uniquely represent this request and prevent duplication."
  - `receiverAccountNumber` — string, **required**, pattern `[0-9]{8}`. "Receiving customer account number." (Note: exactly 8 digits here, whereas `HayAccount.accountNumber` is "5-9 digits" and the DE mock accepts `\d{5,9}` [spec].)
  - `receiverBsb` — string, **required**, pattern `[0-9]{6}`. "Receiving customer BSB."
  - `receiverName` — string, **required**, minLength 1. "Receiving customer name."
  - `reference` — string, optional. "Optional transaction reference."
  - `senderAccountNumber` — string, **required**, pattern `[0-9]{6,9}`. "Sender account number."
  - `senderBsb` — string, **required**, pattern `[0-9]{6}`. "Sender BSB."
  - `senderName` — string, **required**, minLength 1. "Sender name."
- Response: `200` `GenericMessage`; errors 400/403/422/500/501 [spec]. Success text not documented.
- Behaviour (no docs; [inferred] from schema + production NPP page):
  - Resolves the Shaype `HayAccount` with `bsb = receiverBsb`, `accountNumber = receiverAccountNumber`; credits `amount` (`totalBalance`, `availableBalance` ↑).
  - Emits `TRANSACTION` / `transactionType: INTERBANK_TRANSFER_IN` with `counterpartName = senderName`, `counterpartDetails {name: senderName, basicAccountNumber {accountNumber: senderAccountNumber, branchNumber: senderBsb}}`, `description`, `reference`, `category "BANK_TRANSFER"`, `isPending false`, `outcome ACCEPTED` [docs:payments INTERBANK_TRANSFER_IN sample; field mapping inferred]. Note [docs:payments]: Search/Get Transaction APIs "do not return the `basicAccountNumber` within `counterPartyDetails` for inbound transactions" by default (regulatory) — so `counterpartDetails.basicAccountNumber` may be absent when the transaction is read back.
  - Platform checks that can refuse an inbound credit: `REFUSED_MAX_BALANCE_EXCEEDED`, `REFUSED_ACCOUNT_BLOCKED`, `REFUSED_ACCOUNT_CLOSED`, `REFUSED_DAILY_TOP_UP_LIMIT_BREACHED` [spec:webhooks outcome enum; docs:payment-transaction-outcome; applicability inferred].
  - External Authorisation: client `POST /transactions` with `authorisationTransactionType: INBOUND_PAYMENT` [spec:external-balance; inferred].
  - Idempotency: `idempotencyKey` is required, so a repeat with the same key must not create a second transaction; whether it returns 200 (replay) or an error is not stated [open].
  - Errors: pattern violations → 400; receiver account not found → 422/400 [inferred].
- Webhooks: `TRANSACTION` (`INTERBANK_TRANSFER_IN`) [inferred].

### POST /v0/utils/generate-receive-a-payment-instruction (generateReceiveAPaymentInstruction)

- Purpose: "Generate mock Receive A Payment Instruction (RAPAIN)." [spec summary]. Simulates Cuscal sending Shaype the **RAPAIN** for a mandate payment — the debtor-side leg of a PayTo payment where the client is the Payer/debtor's bank: "On production, Cuscal sends an instruction to the mandate manager for sending a payment (RAPAIN), which is later carried by it to the payment manager. For mocks, such instruction must be manually triggered by user" [docs:payto-staging-testing-suite step 4].
- Path/query params: none.
- Request body: `GenerateRapainRequestBody` (no description) [spec]; all five top-level objects **required**:
  - `creditorInformation` — `GenerateRapainCreditorInformation` ("Mandate payment creditor party information."):
    - `accountIdentification` — string, **required**, pattern `^[ -~]{1,34}$`. "Creditor account identification." Docs sample `"63610027487941"` (BSB+account).
    - `partyName` — string, **required**, pattern `^[ -~]{1,140}$`. "Creditor Name. Name by which creditor party is known and which is usually used to identify that party." Docs sample `"JOE BLOGGS"`.
  - `debtorInformation` — `GenerateRapainDebtorInformation` ("Mandate payment debtor party information."):
    - `accountIdentification` — string, **required**, pattern `^[ -~]{1,34}$`. "Debtor account identification." Docs sample `"63610079412687"`.
    - `partyName` — string, **required**, pattern `^[ -~]{1,140}$`. "Debtor Name. Name of the Debtor party." Docs sample `"JOHN MAXIMILLIAN DOE"`.
  - `mandateInformation` — `GenerateRapainMandateInformation` ("Information on the mandate associated with the payment request."):
    - `initiatingPartyName` — string, **required**, pattern `^[ -~]{1,140}$`. "The party that initiates the credit transfer on behalf of the debtor." Docs sample `"string"`.
    - `mandateIdentification` — string, **required**, pattern `^[a-f0-9]{12}1[a-f0-9]{3}[89ab][a-f0-9]{15}$`. "ID of mandate related to payment instruction. Universally Unique IDentifier (UUID) version 1 … without the 4 hyphen separators." Docs: "`MandateIdentification` field should include a mandate ID without hyphens" (sample `"1212c23a255c11ee9a8e5d3239591cd9"`).
  - `paymentInformation` — `GenerateRapainPaymentInformation` ("Mandate payment initiation information."):
    - `instructedAmount` — string, **required**, pattern `^(?=.{1,19}$)[0-9]{0,18}(?:\.[0-9]{0,2})?$`. "Amount of money to be moved between the debtor and creditor, before deduction of charges, expressed in the currency as ordered by the initiating party." Docs sample `"2"`.
    - `instructionIdentification` — string, **required**, pattern `^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}[A-Z0-9]{3}I[0-9]{8}00[0-9]{12}[01]$`. "Instruction identification." Docs sample `"ANNCAU22XXXI20230718000000000077240"` (= `makeAdhocPayment.instructionId`).
    - `remittanceInformationUnstructured` — string, optional, minLength 1, maxLength 280. "Information supplied to enable the matching/reconciliation of an entry with the items that the payment is intended to settle …".
  - `transactionStatusInformation` — `GenerateRapainTransactionStatusInformation` ("Details of initial response to mandate payment request by Cuscal."):
    - `transactionStatus` — string, **required**. Spec `enum` malformed: single value `"ACCP,RJCT"`; intended `ACCP` (Accepted) and `RJCT` (Rejected) per description. Docs: "Such request should have `ACCP` transaction status."
- Response: `200` `GenericMessage`; docs sample `{"message": "Receive A Payment Instruction generated."}` [docs:payto-staging-testing-suite]. Errors 400/403/422/500/501 [spec].
- Behaviour [docs:payto-staging-testing-suite step 4 + notes]:
  - "Later in the process, Cuscal should automatically generate make a payment (MAP) and retract money from debtor account but for mocks, amount is extracted in the same step." → the debtor Shaype account (resolved from `debtorInformation.accountIdentification` = BSB+account [sample; resolution inferred]) is **debited by `paymentInformation.instructedAmount`** immediately.
  - "`InstructedAmount` can be different from amount given in ad-hoc payment initialisation"; "`instructedAmount` will be used for resource extraction but on production it should be the same amount as initial payment amount, and so we advise to do the same."
  - Prerequisites [docs]: "Accounts for both debtor and creditor have been previously created in the platform, they have been activated and they should contain money on those accounts"; "Cuscal configuration must be set up on staging to use `external-services-mock` (Shaype action)". The mandate must exist (created via `createMandate`) and, for ad-hoc, `makeAdhocPayment` has been called first to obtain `instructionId` [docs flow].
  - `transactionStatus: RJCT`: behaviour not documented [open]; presumably no debit and a rejected status [inferred].
  - Webhook: a `TRANSACTION` for the debit on the debtor account with `mandatePaymentDetails {mandateId, instructionId, initiatingPartyName}` and `originType: MANDATE_PAYMENT` [spec:webhooks; inferred]. `transactionType` for the debtor-side PayTo debit is not documented (candidates in the enum: `INTERBANK_TRANSFER_OUT`) [open]. A `MANDATE_PAYMENT` event with `paymentStatus` (`MANDATE_PAYMENT_*`) may also be emitted [spec:webhooks; open].
  - Insufficient funds / blocked account → platform refusal outcome (`REFUSED_NOT_ENOUGH_FUNDS`, …) in the webhook rather than an HTTP error [inferred from card-mock behaviour; open].
  - External Authorisation: client `POST /transactions` with `authorisationTransactionType: OUTBOUND_PAYMENT` (or `DIRECT_DEBIT_TRANSFER`) [spec:external-balance; open which].
  - Errors: pattern violations → 400; unknown mandate/account → 422 [inferred].
  - Idempotency: none declared; `instructionIdentification` is the natural key but no dedup is stated [open].
- Webhooks: `TRANSACTION` with `mandatePaymentDetails` [inferred]; possibly `MANDATE_PAYMENT` [open].

### POST /v0/utils/generate-refund-transaction (generateRefundTransaction)

- Purpose: "Triggers a mock refund card transaction." [spec]. Summary "Trigger mock refund card transaction". "Generates a mock merchant-initiated refund crediting funds back to the cardholder. Unlike a hold reversal (which releases ring-fenced funds before settlement), a refund is a separate, post-settlement transaction that returns money to a customer who has already been charged." [docs:simulates-card-transaction-on-staging].
- Path/query params: none.
- Request body: `GenerateCardTransactionRequestBody` — **same schema as generateAtmTransaction** [spec]:
  - `amount` — number, **required**, `maximum 0`, `exclusiveMaximum true` (**amount < 0, even though a refund credits the account**). The refund webhook sample shows a **positive** `currencyAmount.amount: 5.99` [docs:card-transactions §4], so the mock presumably applies |amount| as a credit [inferred; open].
  - `cardToken` — string, **required**.
  - `currency` — optional, nullable, enum Currency (§2); default AUD.
  - `merchantDetails` — `MerchantDetails`, optional.
  - No `cardUsage`, no `declineReason` [spec].
- Response: `200` `GenericMessage`; errors 400/403/422/500/501 [spec].
- Behaviour [docs:simulates-card-transaction-on-staging; docs:card-transactions §4]:
  - "A single webhook is emitted: `transactionType: CARD_TRANSACTION_REFUND`, `isPending: false` (the refund settles immediately — there is no separate hold). The refund carries its own `transactionHayId` it is not linked to a prior purchase by Shaype." — i.e. no `holdHayId`, no reference to an earlier settlement; the refund does not require a prior mock purchase [inferred from "not linked"].
  - Balance effect: `totalBalance` and `availableBalance` ↑ |amount|; `heldBalance` unchanged [inferred; refund sample `accountBalances {total 5.99, held 0, available 5.99}` after a 5.99 refund on an empty account, docs:card-transactions].
  - Platform checks on credits (e.g. `REFUSED_MAX_BALANCE_EXCEEDED`) may apply [inferred].
  - Idempotency: none.
- Webhooks: one `TRANSACTION` / `CARD_TRANSACTION_REFUND`, `isPending: false` [docs]. Sample [docs:card-transactions §4]: `currencyAmount {AUD, 5.99}`, `updatedBalance {AUD, 3305.99}`, `counterpartName "IGA (Piedimonte's Fitzroy North)"`, `outcome ACCEPTED`, `isAtmTransaction false`, `cardUsageDetails {isCardPresent false, isMobileWalletPayment false, isAtmWithdrawal false}`, `merchantId "000009391315129"`.

### POST /v0/utils/generate-update-auth-hold (generateHoldAndUpdateHoldTransactions)

- Purpose: "Triggers a mock authorisation hold with the requested amount, followed by an update hold (increase/decrease) and settlement transaction." [spec]. Summary "Trigger mock card Hold and Hold Update". "This covers real-world scenarios common in hospitality, car rental, fuel, and hotel transactions." [docs:simulates-card-transaction-on-staging].
- Path/query params: none.
- Request body: `GenerateUpdateHoldTransactionRequestBody` ("Body of a request to generate and update hold card authorisation") [spec]; required: `amount`, `cardToken`, `updateHoldAmount`.
  - `amount` — number, **required**, < 0. "Transaction amount." (initial hold)
  - `cardToken` — string, **required**.
  - `cardUsage` — optional, nullable, enum `MAGNETIC_STRIPE`, `CONTACTLESS`, `CARD_PRESENT`.
  - `currency` — optional, nullable, enum Currency (§2); default AUD.
  - `declineReason` — optional, nullable, enum `CARD_EXPIRED`, `WRONG_CVV`, `CVV_BLOCKED`, `INCORRECT_PIN`, `ALLOWED_PIN_RETRIES_EXCEEDED`, `INVALID_MERCHANT`, `CARD_IS_NOT_ACTIVE`, `RESTRICTED_CARD`.
  - `merchantDetails` — `MerchantDetails`, optional.
  - `settlementDelayInSeconds` — integer int32, optional, 5..300. "Number of seconds to delay the settlement by. Has to be between 5 and 300 seconds." Docs: "Seconds to wait before settling the (updated) hold."
  - `updateHoldAmount` — number, **required**, no min/max. "Amount to increase/reverse hold by. Use positive amount for hold decrease/reversal and negative amount for hold increase." Docs: "use a **positive** value for a **hold decrease/reversal**, and a **negative** value for a **hold increase**."
  - `updateHoldDelayInSeconds` — integer int32, optional, 5..300. "Number of seconds to delay the update hold by. Has to be between 5 and 300 seconds." Docs: "Seconds to wait between the initial hold and the update."
  - Defaults for the two delays when omitted: not stated [open]. Whether `settlementDelayInSeconds` counts from the initial hold or from the update: docs say "before settling the (updated) hold" → from the update [inferred].
- Response: `200` `GenericMessage`; errors 400/403/422/500/501 [spec]. The update and settlement are asynchronous after the delays [inferred].
- Behaviour [docs:simulates-card-transaction-on-staging; docs:card-transactions §2–§3]:
  - Step 1 initial hold of |amount|: as generateAuthHold (`held` ↑, `available` ↓, `total` unchanged).
  - Step 2 update after `updateHoldDelayInSeconds`:
    - Increase (`updateHoldAmount` < 0): "incremental authorisation"; "It follows the same process as the first authorisation, where the platform performs all necessary checks for the incremental amount." `heldBalance` ↑ |updateHoldAmount|, `availableBalance` ↓ |updateHoldAmount| ("Authorization Hold Request and Hold with Increment Transaction: held balance increases, available balance decreases accordingly"). Sample: hold −9.00 (`total 232.64, held 166.64, avail 66.00`) → increment webhook `currencyAmount −19.00` (= updated total hold) (`total 241.64, held 176.64, avail 65.00` — sample's `total` changes by +9, which contradicts "total unchanged"; treat the sample as unreliable [docs:card-transactions]).
    - Decrease / reversal (`updateHoldAmount` > 0): "partial/full reversal"; `heldBalance` ↓ `updateHoldAmount`, `availableBalance` ↑ `updateHoldAmount` ("Hold with Reversal Transaction: held balance decreases, available balance increases accordingly"). Sample: hold −5.00 (`total 10.87, held 9.5, avail 1.37`) → reversal webhook `currencyAmount +0.5000` (`total 10.87, held 9, avail 1.87`).
    - Full reversal = `updateHoldAmount` equal to |amount| ("May be equal to the total hold amount in which case reverses the whole transaction" [spec:external-balance, `PATCH /holds/{holdId}` (`updateHoldAmount` operation) description; applicability to the B2B `updateHoldAmount` field inferred]); whether a settlement of 0 then follows is not stated [open].
  - Step 3 settlement after `settlementDelayInSeconds`: settles the **updated** hold amount (samples: −19.00 after increase; −4.50 after 0.50 reversal of −5.00) — `held` ↓ updated hold, `total` ↓ updated hold, `available` unchanged [docs:card-transactions samples; arithmetic inferred].
  - `declineReason` applies to the initial hold; whether the increment can be independently declined is not stated [open].
  - External Authorisation: hold → client `POST /holds`; update → client `PATCH /holds/{holdId}` with `{amount {amount, currency}, customerId, rawExternalProcessorRequest}` [spec:external-balance; linkage inferred].
  - Errors: delays outside 5..300 → 400; `updateHoldAmount` = 0 → unknown [open]; decrease larger than the hold → unknown [open].
- Webhooks [docs:simulates-card-transaction-on-staging] (the page says "Two webhooks are emitted in sequence" but then lists three):
  1. Initial hold: `transactionType: CARD_TRANSACTION`, `isPending: true`, `transactionHayId == holdHayId`.
  2. Hold update: increase → `transactionType: CARD_TRANSACTION`, `isPending: true`, "The webhook reports the updated total hold amount (original + increase). Both events share the same `transactionHayId`." Decrease → `transactionType: CARD_TRANSACTION_REFUND`, `isPending: true`, same `transactionHayId`; `currencyAmount` is the positive released amount [docs:card-transactions §3 sample].
  3. Settlement: `transactionType: CARD_TRANSACTION_SETTLED`, `isPending: false`, "carries its own `transactionHayId` and references the original hold via `holdHayId`."

## 2. Entities and fields

Legend: R = required, O = optional, N = `nullable: true` in schema. Ops: C = created/written by, R = read by. Field names are the spec's exact JSON property names.

### 2.1 Response envelopes [spec]

**GenericMessage** ("Message response") — returned 200 by all ops except createStub (which declares no body but returns the same shape per docs).
| field | type | req | notes |
|---|---|---|---|
| `message` | string | O | "Message indicating operation result". Known values [docs:payto-staging-testing-suite]: `"Receive A Payment Instruction generated."` (RAPAIN), `"Receive A Payment generated."` (NPP inbound v2), `"Mandate Notification for Initiator generated."`, `"Stub mapping for search payment instruction request created."` |

**ErrorResponse** ("An error response.") — 400/403/422/500/501 on every op.
| field | type | req | notes |
|---|---|---|---|
| `details` | string | O | "Error details". Docs sample: `"Please refer to the API documentation or contact Shaype for more info with the traceId."` |
| `message` | string | O | "Error description". Docs sample: `"NOT_FOUND: CUS.API.100522 - Creditor account details incorrect (M900 - No matching record found)"` |
| `status` | string | O | "HTTP response status". Docs sample: `"422"` (a string) |
| `traceId` | string | O | "TraceID that can be used by HAY for troubleshooting the request". Docs sample: `"9b8fa212-d655-487e-bf91-4406957bb584"` |

### 2.2 Card-mock request bodies [spec]

Four schemas share a field set; ✓ = present in that schema. Ops: `GenerateCardTransactionRequestBody` → generateAtmTransaction, generateRefundTransaction; `GenerateCardHoldTransactionRequestBody` → generateAuthHold; `GenerateCardHoldAndSettleTransactionRequestBody` → generateCardTransaction; `GenerateUpdateHoldTransactionRequestBody` → generateHoldAndUpdateHoldTransactions.

| field | type / constraints | req | N | CardTx | Hold | Hold+Settle | Hold+Update |
|---|---|---|---|---|---|---|---|
| `amount` | number, `maximum 0`, `exclusiveMaximum true` (< 0) | R | – | ✓ | ✓ | ✓ | ✓ |
| `cardToken` | string ("Public card token to use.") | R | – | ✓ | ✓ | ✓ | ✓ |
| `currency` | string, enum Currency (§2.3); "Defaults to AUD if not provided." | O | N | ✓ | ✓ | ✓ | ✓ |
| `merchantDetails` | object `MerchantDetails` | O | – | ✓ | ✓ | ✓ | ✓ |
| `cardUsage` | string enum `MAGNETIC_STRIPE`, `CONTACTLESS`, `CARD_PRESENT` | O | N | – | ✓ | ✓ | ✓ |
| `declineReason` | string enum `CARD_EXPIRED`, `WRONG_CVV`, `CVV_BLOCKED`, `INCORRECT_PIN`, `ALLOWED_PIN_RETRIES_EXCEEDED`, `INVALID_MERCHANT`, `CARD_IS_NOT_ACTIVE`, `RESTRICTED_CARD` | O | N | – | ✓ | ✓ | ✓ |
| `settlementDelayInSeconds` | integer int32, min 5, max 300 | O | – | – | – | ✓ | ✓ |
| `updateHoldAmount` | number (positive = decrease/reversal, negative = increase) | R | – | – | – | – | ✓ |
| `updateHoldDelayInSeconds` | integer int32, min 5, max 300 | O | – | – | – | – | ✓ |

**MerchantDetails** ("Details of the merchant") — all optional, all nullable:
| field | type | constraints |
|---|---|---|
| `merchantCategoryCode` | string | pattern `^\d{4}$`; "Merchant Category Code (MCC) as four digit code as per ISO 18245" |
| `merchantId` | string | "Merchant ID, alphanumeric / special characters maximum 15 characters in length" (no schema maxLength) |
| `merchantName` | string | "Merchant name" |

**ChangeCardExpiryDateRequestBody** — `expiryDate` string, format `date`, R, example `"2027-09-30"`. Op: changeCardExpiryDate.

### 2.3 Currency enum [spec]

Identical 162-value list on every `currency` property in this domain and on `HayAccount.currency` (verified by jq). Verbatim:

`AED, AFN, ALL, AMD, ANG, AOA, ARS, AUD, AWG, AZN, BAM, BBD, BDT, BGN, BHD, BIF, BMD, BND, BOB, BOV, BRL, BSD, BTN, BWP, BYN, BZD, CAD, CDF, CHF, CLP, CNH, CNY, COP, CRC, CUC, CUP, CVE, CZK, DJF, DKK, DOP, DZD, EGP, ERN, ETB, EUR, FJD, FKP, GBP, GEL, GHS, GIP, GMD, GNF, GTQ, GYD, HKD, HNL, HRK, HTG, HUF, IDR, ILS, INR, IQD, IRR, ISK, JMD, JOD, JPY, KES, KGS, KHR, KMF, KPW, KRW, KWD, KYD, KZT, LAK, LBP, LKR, LRD, LSL, LYD, MAD, MDL, MGA, MKD, MMK, MNT, MOP, MRU, MUR, MVR, MWK, MXN, MYR, MZN, NAD, NGN, NIO, NOK, NPR, NZD, OMR, PAB, PEN, PGK, PHP, PKR, PLN, PYG, QAR, RON, RSD, RUB, RWF, SAR, SBD, SCR, SDG, SEK, SGD, SHP, SLE, SLL, SOS, SRD, SSP, STN, SVC, SYP, SZL, THB, TJS, TMT, TND, TOP, TRY, TTD, TWD, TZS, UAH, UGX, USD, UYU, UZS, VES, VND, VUV, WST, XAF, XCD, XCG, XOF, XPF, YER, ZAR, ZMW, ZWG, ZWL`

### 2.4 DE / NPP mock request bodies [spec]

**GenerateInboundDeRequestBody** — op generateInboundDeTransaction. (Full descriptions and the four spec examples are in §1.)
| field | type / constraints | req | example |
|---|---|---|---|
| `amount` | number, > 0 (`minimum 0`, `exclusiveMinimum true`) | R | `147.23` |
| `description` | string | O | `"Invoice 123456"` |
| `idempotencyKey` | string uuid | O | `"79ac5cce-3349-42ed-aa67-9764c8a35d31"` |
| `recipientAccountNumber` | string, pattern `\d{5,9}` | R | `"522843"` (swapped with BSB in spec) |
| `recipientBsb` | string, pattern `\d{6}` | R | `"35022223"` (violates pattern — swapped) |
| `recipientName` | string | O | `"Han Solo"` |
| `recordType` | enum `DIRECT`, `RETURN`, `REFUSAL` | R | |
| `refusalReason` | enum `RETURN_RECEIVED_OUT_OF_TIME`, `INSUFFICIENT_INFORMATION_TO_APPLY`, `REVERSAL_OF_DUPLICATED_ITEM`, `NO_ARRANGEMENT`, `TECHNICALLY_INVALID` | O ("Required for record type REFUSAL") | |
| `returnReason` | enum `INVALID_BSB_NUMBER`, `PAYMENT_STOPPED`, `ACCOUNT_CLOSED`, `CUSTOMER_DECEASED`, `NO_ACCOUNT_OR_INCORRECT_ACCOUNT_NUMBER`, `REFER_TO_CUSTOMER`, `INVALID_USER_ID`, `TECHNICAL_INVALID` | O ("Required for record type RETURN") | |
| `senderAccountNumber` | string, pattern `\d{5,9}` | R | `"112836327"` |
| `senderBsb` | string, pattern `\d{6}` | R | `"302227"` |
| `senderName` | string | O | `"Darth Vader"` |
| `transactionType` | enum `CREDIT`, `DEBIT` | R | |

**GenerateInboundNppTransactionRequestBody** — op generateInboundNppTransaction.
| field | type / constraints | req |
|---|---|---|
| `amount` | number, > 0 | R |
| `description` | string, minLength 1 | R |
| `idempotencyKey` | string uuid | R |
| `receiverAccountNumber` | string, pattern `[0-9]{8}` | R |
| `receiverBsb` | string, pattern `[0-9]{6}` | R |
| `receiverName` | string, minLength 1 | R |
| `reference` | string | O |
| `senderAccountNumber` | string, pattern `[0-9]{6,9}` | R |
| `senderBsb` | string, pattern `[0-9]{6}` | R |
| `senderName` | string, minLength 1 | R |

**GenerateRapRequestBody** — op generateInboundNppTransactionV2. Required: `creditorInformation`, `debtorInformation`, `initgPtyIdOrgId`, `paymentId`, `paymentInformation`.
| field | type / constraints | req |
|---|---|---|
| `creditorInformation` | `GenerateRapCreditorInformation` | R |
| `debtorInformation` | `GenerateRapDebtorInformation` | R |
| `initgPtyIdOrgId` | string, pattern `^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}[A-Z0-9]{3}$` (BIC11) | R |
| `mandateInformation` | `GenerateRapMandateInformation` | O |
| `paymentId` | string, pattern `^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}[A-Z0-9]{3}[0-9]{23}$` | R |
| `paymentInformation` | `GenerateRapPaymentInformation` | R |
| `paymentReturnInformation` | `GenerateRapPaymentReturnInformation` | O |

| sub-schema | field | type / constraints | req |
|---|---|---|---|
| GenerateRapCreditorInformation | `accountIdentification` | string 0..34 | R |
| | `accountIdentificationTypeCode` | string len 4 (docs: `"BBAN"`) | R |
| | `ultimatePartyName` | string 0..140 | O |
| GenerateRapDebtorInformation | `accountIdentification` | string 0..34 | R |
| | `accountIdentificationTypeCode` | string len 4 | R |
| | `partyName` | string 0..140 | R |
| GenerateRapMandateInformation | `initiatingPartyName` | string, pattern `^[ -~]{1,140}$` | O ("Must be populated for mandate payments") |
| | `instructionIdentification` | string, pattern `^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}[A-Z0-9]{3}I[0-9]{8}00[0-9]{12}[01]$` | O ("Must be populated for mandate payments") |
| | `mandateIdentification` | string, pattern `^[a-f0-9]{12}1[a-f0-9]{3}[89ab][a-f0-9]{15}$` | R |
| GenerateRapPaymentInformation | `categoryPurposeCode` | string len 4 (examples `EPAY`, `SALA`, `SUPP`, `PENS`, `TAXS`; not an enum) | O |
| | `endToEndIdentification` | string 0..35 | R |
| | `instructedAmount` | string, pattern `^(?=.{1,19}$)[0-9]{0,18}(?:\.[0-9]{0,2})?$` | R |
| | `originalMessageIdentification` | string len 34 | R |
| | `remittanceInformationUnstructured` | string 0..280 | O |
| | `transactionIdentification` | string, pattern `^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}[A-Z0-9]{3}N[0-9]{8}00[0-9]{12}[01]$`, example `"BANKNTSTXXXN20180501000000000000010"` | R |
| | `uniqueSuperannuationCode` | string | O |
| GenerateRapPaymentReturnInformation | `originalTransactionIdentification` | string len 35, example `"BANKNTSTXXXN20180511CT0000458203590"` | O |
| | `returnAmount` | string decimal pattern, example `"100.0"` | O |
| | `returnReasonCode` | string len 4 ("If this field is populated, then this is a inbound payment return") | O |

**GenerateRapainRequestBody** — op generateReceiveAPaymentInstruction. All five objects required.
| sub-schema | field | type / constraints | req |
|---|---|---|---|
| GenerateRapainCreditorInformation | `accountIdentification` | string, pattern `^[ -~]{1,34}$` | R |
| | `partyName` | string, pattern `^[ -~]{1,140}$` | R |
| GenerateRapainDebtorInformation | `accountIdentification` | string, pattern `^[ -~]{1,34}$` | R |
| | `partyName` | string, pattern `^[ -~]{1,140}$` | R |
| GenerateRapainMandateInformation | `initiatingPartyName` | string, pattern `^[ -~]{1,140}$` | R |
| | `mandateIdentification` | string, pattern `^[a-f0-9]{12}1[a-f0-9]{3}[89ab][a-f0-9]{15}$` | R |
| GenerateRapainPaymentInformation | `instructedAmount` | string decimal pattern | R |
| | `instructionIdentification` | string, pattern `^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}[A-Z0-9]{3}I[0-9]{8}00[0-9]{12}[01]$` | R |
| | `remittanceInformationUnstructured` | string 1..280 | O |
| GenerateRapainTransactionStatusInformation | `transactionStatus` | string; spec enum literal `["ACCP,RJCT"]` (malformed) → intended `ACCP` Accepted, `RJCT` Rejected | R |

### 2.5 PayTo mandate-notification / stub bodies [spec]

**GenerateInitiatorMandateNotificationRequestBody** / **GeneratePayerMandateNotificationRequestBody** — identical except `trigger`. Required: `actionDetails`, `mandateDetails`, `trigger`.
| field | type / constraints | req |
|---|---|---|
| `actionDetails` | `GenerateMandateNotificationActionDetailsDto` → `actionId` string, pattern `^[0-9a-fA-F]{32}$`, R | R |
| `mandateDetails` | `GenerateMandateNotificationMandateDetailsDto` (below) | R |
| `trigger` | string minLength 4 maxLength 4. Initiator spec enum literal `["MCRC,MCRD,MCRX,MAMC,MAMD,MAMN,MAMX,MPOF,MPOT,MPOX,MSCH"]`; Payer spec enum literal `["MCRX,MCRT,MCRP,MAMN,MAMP,MAMR,MAMX,MSCH"]` (both malformed single-string enums; intended as comma-separated lists). Docs also send `PCRD` to the Initiator endpoint. | R |

**GenerateMandateNotificationMandateDetailsDto** ("Mandate details") — required: `debtorInformation`, `mandateId`, `paymentInformation`, `validityStartDate`.
| field | type / constraints | req |
|---|---|---|
| `creditorInformation` | `GenerateMandateNotificationCreditorInformationDto` → `accountIdentification` string 7..34 ("BBAN format"), R | O |
| `debtorInformation` | `GenerateMandateNotificationDebtorInformationDto` → `accountIdentification` string 7..34 ("BBAN format"), R | R |
| `description` | string 1..140 | O |
| `mandateId` | string, pattern `^[0-9a-fA-F]{32}$` | R |
| `paymentInformation` | `GenerateMandateNotificationPaymentInformationDto` (below) | R |
| `shortDescription` | string 1..35 | O |
| `validityEndDate` | string, YYYY-MM-DD pattern; valid until 23:59:59.999 Australia/Sydney | O |
| `validityStartDate` | string, YYYY-MM-DD pattern; valid from 00:00:00.000 Australia/Sydney | R |

**GenerateMandateNotificationPaymentInformationDto** — required: `paymentFrequency`.
| field | type / constraints | req |
|---|---|---|
| `amount` | string, pattern `^(?=.{1,19}$)[0-9]{0,18}(?:\.[0-9]{0,2})?$` | O |
| `countPerPeriod` | string, pattern `^(?=.{1,19}$)[0-9]{0,19}(?:\.[0-9]{0,18})?$` | O |
| `firstPaymentAmount` | string decimal pattern | O |
| `firstPaymentDate` | string YYYY-MM-DD pattern | O |
| `lastPaymentAmount` | string decimal pattern | O |
| `lastPaymentDate` | string YYYY-MM-DD pattern | O |
| `maximumAmount` | string decimal pattern | O |
| `paymentAmountType` | string, **no enum**; documented values `BALN`, `FIXE`, `USGB`, `VARI` | O |
| `paymentFrequency` | string, **no enum**; documented values `ADHO`, `DAIL`, `FRTN`, `INDA`, `MIAN`, `MNTH`, `QURT`, `WEEK`, `YEAR` | R |
| `pointInTime` | string, pattern `^[0-9]{2}$` | O |

**CreateStubForMandateSearchPaymentInstructionsRequestBody** — op createStubForMandateSearchPaymentInstructions.
| field | type / constraints | req |
|---|---|---|
| `mandateIdentification` | string, pattern `^[0-9a-fA-F]{32}$` | R |
| `paymentInstructionSummaries` | array of `PaymentInstructionSummary`, minItems 1 | R |

**PaymentInstructionSummary** ("Payment instruction list")
| field | type / constraints | req |
|---|---|---|
| `creationDateTime` | string, UTC `YYYY-MM-DDThh:mm:ss[.sss]Z` pattern | R |
| `instructedAmount` | number | R |
| `instructionIdentification` | string, pattern `^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}[A-Z0-9]{3}I[0-9]{8}00[0-9]{12}[0-9a-zA-Z]$` | R |
| `transactionStatus` | enum `RECV`, `UNDV`, `SENT`, `SAFD`, `ACCP`, `ACSP`, `ACSC`, `RJCT` | R |
| `transactionStatusReasonCode` | string 1..4 (e.g. `AB01`) | O |

### 2.6 Platform entities touched (other domains) [spec]

**HayCard** ("Details of a card") — R by all card mocks (lookup by `cardToken`); `expiryDate` written by changeCardExpiryDate.
| field | type | N | notes |
|---|---|---|---|
| `accountHayId` | string uuid | – | account the card is linked to (the account whose balances the mocks move) |
| `blockedBy` | enum `CLIENT`, `PLATFORM` | – | |
| `cardHayId` | string uuid | – | = `cardId` path param; appears as `cardHayId` in `TransactionEventDto` |
| `cardStatus` | enum `ACTIVE`, `AWAITING_ACTIVATION`, `BLOCKED`, `INACTIVE`, `EXPIRED` | – | docs require an "active card" for the mocks |
| `cardToken` | string | – | "Public token of the Card, maximum 9 digits in length" — the `cardToken` used by the mocks |
| `cardType` | enum `PHYSICAL`, `VIRTUAL` | – | |
| `customerHayId` | string uuid | – | |
| `deliveryMethod` | enum `STANDARD`, `REGISTERED`, `COURIER`, `EXPRESS` | – | |
| `expiryDate` | string date | – | "date of the last day of the expiry month and year" |
| `issuedDateTimeUtc` | string date-time | – | |
| `lastFourDigits` | string | – | |
| `nameOnCard`, `nameOnCardLine2` | string | – | |
| `renewedIntoCardId` | string uuid | N | |
| `voidDateTimeUtc` | string date-time | N | |

**HayAccount** — balances read/written by every money-moving mock; matched by `bsb` + `accountNumber` for DE/NPP/RAP/RAPAIN mocks [inferred].
| field | type | notes |
|---|---|---|
| `accountHayId` | string uuid | |
| `accountHolderId` | string uuid | |
| `accountHolderType` | enum `CUSTOMER`, `GROUP` | |
| `accountNumber` | string | "Account number, 5-9 digits in length" |
| `bsb` | string | "BSB (Bank State Branch) of Account, 6 digits in length" |
| `currency` | enum Currency (§2.3) | |
| `status` | enum `PENDING_APPROVAL`, `APPROVED`, `ACTIVE`, `LOCKED`, `DORMANT`, `CLOSED`, `ACTIVE_IN_ARREARS` | |
| `blockedBy` | enum `CLIENT`, `PLATFORM` | |
| `availableBalance` | number | "Total balance available for use on Account. Funds that are held, locked and allocated to a Stack will not be available. Value to 2 decimal places." |
| `heldBalance` | number | "Total value of all authorised but not yet cleared transactions for all Cards on Account. Positive value to 2 decimal places." |
| `lockedBalance` | number | "The value that has been locked and unavailable for use, typically as a result of an operations team action. Positive value" |
| `stacksBalance` | number | "Total value current held against any Stack(s) on the Account. Positive value" |
| `overdraftBalance` | number | "Total value of overdraft used where an overdraft limit exists on the Account. Positive value" |
| `overdraftLimit` | number | "Total value of the overdraft limit applied to Account. Positive value" |
| `technicalOverdraftBalance` | number | "Total value that is in a negative position beyond the total deposits / overdraft limit on the Account." |
| `totalBalance` | number | "Total value of all funds on the Account (this amount will also include unused overdraft limit and Stacks, held and locked value). Value to 2 decimal places." |
| `customData` | object (required, nullable) | |
| `parentAccountId` | string uuid, nullable | |
| `productId` | string uuid | |
| `creationDateTimeUtc`, `closedDateTimeUtc` | string date-time | |
| `homeCurrencyBalanceEquivalent` | ref `HomeCurrencyBalanceEquivalent` | |

### 2.7 Webhook entities produced (Notification Webhooks spec) [spec:webhooks]

**NotificationDto** — required `customerHayId` (uuid), `idempotencyKey` (uuid), `type`. `type` enum verbatim: `ACCOUNT_STATUS_CHANGE`, `CUSTOMER_STATUS_UPDATED`, `CARD_ADDED_TO_WALLET`, `CARD_STATUS_CHANGE`, `CUSTOMER_DETAILS_CHANGE`, `ONBOARDING_PASSED`, `ONBOARDING_FAILED`, `REMINDER`, `SCHEDULED_PAYMENT`, `TRANSACTION`, `DIRECT_ENTRY`, `MANDATE`, `MANDATE_DUE_PAYMENT`, `MANDATE_PAYMENT`, `APPLE_PAY_REWARD_FOR_CUSTOMER`, `MANDATE_ACTION_EXPIRATION`, `DELEGATED_OTP_NOTIFICATION`. Other fields: `firebaseDeviceToken` string, `actionOwner` enum `CLIENT`, `PLATFORM`, `cardHayId` uuid N, `productId` uuid, and one event object per type: `transactionEvent`, `directEntryEvent`, `mandateEventDto`, `mandatePaymentEventDto`, `mandateDuePaymentEventDto`, `mandateActionExpirationEvent`, `accountStatusChangeEvent`, `customerStatusUpdatedEvent`, `cardStatusChangeEvent`, `customerDetailsChangeEvent`, `cardAdditionToWalletEvent`, `scheduledPaymentEvent`, `onboardingFailedEvent`, `applePayRewardForCustomerEvent`, `cardExpiryReminderEvent`, `delegatedOtpNotificationEvent`, `reminderType`. **Note**: the spec property names are `mandateEventDto` / `mandatePaymentEventDto` / `mandateDuePaymentEventDto`, whereas the docs' JSON samples use `mandateEvent` / `mandatePaymentEvent` / `mandateDuePaymentEvent` [docs:card-transactions samples] — discrepancy to resolve when emitting.

**TransactionEventDto** ("provided when the type is `TRANSACTION`") — the payload every card/DE/NPP mock ultimately produces.
| field | type | notes |
|---|---|---|
| `transactionHayId` | uuid | |
| `holdHayId` | uuid | "Unique identifier (UUID) of the Hold associated with the event (only applicable to card transactions). This is also referred to as `relatedHoldHayId` when `isPending` flag is `false`." |
| `accountHayId` | uuid | |
| `currencyAmount` | `CurrencyAmount {currency, amount}` | negative = debit, positive = credit (samples) |
| `originalCurrencyAmount` | `CurrencyAmount` | FX original |
| `updatedBalance` | `CurrencyAmount` | equals `accountBalances.availableBalance` in the consistent samples |
| `isPending` | boolean | true for holds/hold updates, false for settled/ATM/refund/inbound |
| `counterpartName` | string | merchant name in card samples |
| `outcome` | enum (below) | |
| `transactionTimeUtc` | date-time | |
| `cardPreferenceOutcome` | enum `CARD_FROZEN`, `CARD_NOT_PRESENT_DISABLED`, `CASH_WITHDRAWAL_DISABLED`, `CONTACTLESS_DISABLED`, `OVERSEAS_SPENDING_DISABLED`, `MAGNETIC_STRIPE_PAYMENT_DISABLED`, `MOBILE_WALLET_PAYMENT_DISABLED`, `OK`, `CARD_BLOCKED` | |
| `cardProcessorResponse` | enum (below) | candidate carrier of `declineReason` |
| `merchantName` | string | |
| `isAtmTransaction` | boolean, **deprecated** | still emitted (`true` for ATM mock per docs) |
| `transactionType` | enum `CARD_TRANSACTION`, `CARD_TRANSACTION_REFUND`, `CARD_TRANSACTION_SETTLED`, `INTRABANK_TRANSFER_IN`, `INTRABANK_TRANSFER_OUT`, `INTERBANK_TRANSFER_IN`, `INTERBANK_TRANSFER_OUT`, `DIRECT_DEBIT_TRANSFER`, `HAY_TOP_UP`, `INTERBANK_TRANSFER_OUT_REVERSAL`, `REWARD`, `GENERAL_CREDIT`, `GENERAL_DEBIT`, `ORIGINAL_CREDIT`, `BPAY_TRANSFER_OUT`, `CONVERSION_IN`, `CONVERSION_OUT` | `INTERBANK_TRANSFER_OUT_REVERSAL` "(NOT CURRENTLY IN USE)" |
| `cardUsageDetails` | `CardUsageDetails {isMagneticStripePayment, isContactless, isCardPresent, isMobileWalletPayment, isAtmWithdrawal}` (all boolean) | |
| `accountBalances` | `AccountBalancesDto {totalBalance, heldBalance, lockedBalance, stacksBalance, availableBalance}` (each `CurrencyAmount`) | |
| `cardHayId`, `customerHayId` | uuid | |
| `ruleDetails` | `RuleDetails` | |
| `counterpartDetails` | `CounterpartDetails {accountId, customerId, name, bpayDetails, basicAccountNumber {accountNumber, branchNumber}}` | |
| `originId` | uuid | |
| `originType` | enum `CUSTOMER`, `SCHEDULED_PAYMENT`, `HAAS_OPERATIONS`, `OPERATIONS`, `MANDATE_PAYMENT`, `DIRECT_DEBIT`, `TRANSACTION` | |
| `category` | string | `"BANK_TRANSFER"` in DE/NPP samples |
| `merchantId` | string | "maximum 15 characters" |
| `description`, `reference` | string | |
| `mandatePaymentDetails` | `MandatePaymentDetails {mandateId uuid, instructionId, initiatingPartyName}` | set for PayTo payments |
| `returnReason` | `ReturnReason {code, message}` (both required); `code` enum `ACCOUNT_BLOCKED`, `ACCOUNT_CLOSED`, `ACCOUNT_INVALID`, `AMOUNT_INVALID`, `CANCELLED`, `CURRENCY_INVALID`, `CUSTOMER_REQUEST`, `DUPLICATE`, `FRAUD`, `OTHER` | set on reversals/returns |
| `externalIdentifiers` | array `ExternalIdentifierDto` | "e.g. VISA trace lifecycle" |

`TransactionEventDto.outcome` enum verbatim:
`ACCEPTED, REFUSED_CARD_PREFERENCE, REFUSED_ACCOUNT_PREFERENCE, REFUSED_FRAUD, REFUSED_AML, REFUSED_MAX_BALANCE_EXCEEDED, REFUSED_NOT_ENOUGH_FUNDS, REFUSED_DAILY_LIMIT_EXCEEDED, INTERNAL_ERROR, REFUSED_ACCOUNT_NOT_FOUND_FOR_CARD_TOKEN, REFUSED_UNDETERMINED_BALANCE_FOR_ACCOUNT, REFUSED_ACCOUNT_NOT_FOUND_FOR_CURRENCY, REFUSED_UNDETERMINED_SPENDING_FOR_ACCOUNT, REFUSED_UNDETERMINED_TOP_UPS_FOR_ACCOUNT, REFUSED_UNDETERMINED_ATM_WITHDRAWALS_FOR_ACCOUNT, REFUSED_ANNUAL_SPENDING_LIMIT_BREACHED, REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED, REFUSED_DAILY_TOP_UP_LIMIT_BREACHED, REFUSED_ACCOUNT_BLOCKED, REFUSED_ACCOUNT_CLOSED, REFUSED_RECIPIENT_ACCOUNT_BLOCKED, REFUSED_RECIPIENT_ACCOUNT_CLOSED, REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED, REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED, REFUSED_RULES, REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED, REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED, REFUSED_TOTAL_NET_VISA_DAILY_LIMIT_BREACHED, REFUSED_TOTAL_NON_SCHEME_DAILY_LIMIT_BREACHED, REFUSED_BPAY_INVALID_BILLER_CODE, REFUSED_BPAY_INVALID_REFERENCE, REFUSED_BPAY_INVALID_PAYMENT, REFUSED_BPAY_REJECTED, REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED, REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED, REFUSED_SANCTIONS, REFUSED_UNABLE_TO_VALIDATE, REFUSED_INSUFFICIENT_DATA, REFUSED_SENDER_ACCOUNT_NOT_VERIFIED, REFUSED_CAPABILITY_NOT_ENABLED, REFUSED_QUOTE_EXPIRED`

`TransactionEventDto.cardProcessorResponse` enum verbatim:
`INCORRECT_PIN, REFUSED_CARD_BLOCKED, RESTRICTED_CARD, ALL_GOOD, REFER_TO_ISSUER, INVALID_MERCHANT, CAPTURE_CARD, DO_NOT_HONOR, UNSPECIFIED_ERROR, HONOR_WITH_IDENTIFICATION, PARTIAL_APPROVAL, INVALID_TRANSACTION, INVALID_AMOUNT, INVALID_CARD_NUMBER, CARD_SCHEME_NETWORK_CANNOT_CONNECT_TO_THREDD, CUSTOMER_CANCELLATION, FATAL_ERROR, PARTIAL_REVERSAL, EXPIRED_CARD_CAP, SUSPECTED_FRAUD, LOST_CARD_CAP, STOLEN_CARD_CAP, CLOSED_ACCOUNT, INSUFFICIENT_FUNDS, EXPIRED_CARD, TRANSACTION_NOT_PERMITTED_TO_HOLDER, TRANSACTION_NOT_PERMITTED_TO_TERMINAL, EXCEEDED_WITHDRAW_AMOUNT_LIMIT, SECURITY_VIOLATION, EXCEEDED_WITHDRAWAL_FREQUENCY_LIMIT, RESPONSE_RECEIVED_TOO_LATE, HOLDER_TO_CONTACT_ISSUER, ALLOWED_PIN_RETRIES_EXCEEDED, ALLOWED_NUMBER_OF_PIN_TRIES_EXCEEDED, ISSUER_DOES_NOT_PARTICIPATE_IN_THE_SERVICE, CARD_IS_NOT_ACTIVE, UNACCEPTABLE_PIN, DOMESTIC_DEBIT_TRANSACTION_NOT_ALLOWED, TIMEOUT_AT_IEM, APPROVED_NON_FINANCIAL_OR_HOLD, PIN_VALIDATION_NOT_POSSIBLE, PURCHASE_AMOUNT_ONLY_NO_CASHBACK_ALLOWED, CRYPTOGRAPHIC_FAILURE, AUTHENTICATION_FAILURE, ISSUER_INOPERATIVE, CANT_ROUTE, VIOLATION_OF_LAW, DUPLICATE_TRANSMISSION, SYSTEM_MALFUNCTION, CVV_FAIL, FORCE_STIP, APPROVE_LOAD, VERIFICATION_DATA_FAILED, STRONG_CUSTOMER_AUTHENTICATION, SCA_REQUIRED, CVV2_FAILURE, UNKNOWN_REASON`

**MandateEventDto** ("provided when the type is `MANDATE`") — `mandateId` uuid, `actionId` uuid, `description` string, `trigger` enum verbatim:
`MAMN, MAMP, MAMR, MAMX, MCRP, MCRR, MCRT, MCRX, MPOF, MPOT, MPOX, MSCH, CSCH, PAMC, PAMD, PAMN, PCRC, PCRD, PPOT, PSCH, PPOI, PPOR, MCRC, MCRD, MAMC, MAMD, CCRR, IAMN, ISCH, IAMP, IAMR, ICRR`

Trigger meanings [spec:webhooks]: CCRR Cuscal mandate create recalled; CSCH Cuscal mandate status changed; IAMN Initiator mandate amended; IAMP Initiator mandate amend proposed; IAMR Initiator mandate amend recalled; ICRR Initiator mandate create recalled; ISCH Initiator mandate status changed; MAMC Mandate amend confirmed; MAMD Mandate amend declined; MAMN Mandate amended; MAMP Mandate amend proposed; MAMR Mandate amend recalled; MAMX Mandate amend expired; MCRC Mandate create confirmed; MCRD Mandate create declined; MCRP Mandate create proposed; MCRR Mandate create recalled; MCRT Mandate created; MCRX Mandate create expired; MPOF Mandate port finalised; MPOT Mandate ported; MPOX Mandate port expired; MSCH Mandate status changed; PAMC Payer mandate amend confirmed; PAMD Payer mandate amend declined; PAMN Payer mandate amended; PCRC Payer mandate create confirmed; PCRD Payer mandate create declined; PPOI Payer mandate port initiated; PPOR Payer mandate port recalled; PPOT Payer mandate ported; PSCH Payer mandate status changed.

**MandatePaymentEventDto** ("provided when the type is `MANDATE_PAYMENT`") — `instructionId` string, `mandateId` uuid, `paymentStatus` enum `MANDATE_PAYMENT_ACCEPTED`, `MANDATE_PAYMENT_ACCEPTED_FOR_CLEARANCE`, `MANDATE_PAYMENT_PENDING`, `MANDATE_PAYMENT_RECEIVED`, `MANDATE_PAYMENT_REJECTED`, `MANDATE_PAYMENT_SENT`, `MANDATE_PAYMENT_SETTLEMENT_ABORTED`, `MANDATE_PAYMENT_STORE_AND_FORWARD`, `MANDATE_PAYMENT_UNDELIVERED`; `reasonCode` string (NPP codes, e.g. `AB01` "Clearing process aborted due to timeout"); `transactionHayId` uuid ("When payment status is rejected, transaction identifier is null"); `isFinal` boolean; `originId` uuid; `originType` enum as above.

**DirectEntryEventDto** ("provided when the type is `DIRECT_ENTRY`") — `transactionId` uuid; `type` enum `DEBIT` ("Currently only the `DEBIT` type is supported."); `direction` enum `OUTBOUND` ("Currently only the `OUTBOUND` direction is supported."); `status` enum `RECEIVED`, `ACCEPTED`, `REJECTED`, `SUBMITTED`, `RETURNED`, `COMPLETE`, `INCOMPLETE`.

### 2.8 External Authorisation entities (Shaype → client) [spec:external-balance]

Relevant only when the client holds balances externally. Headers on every callback: `Shaype-Version` (e.g. `2023-01-30`), `Shaype-Trace-Id`, `Shaype-Idempotency-Key`, `Shaype-Timestamp` (RFC-3339), `Shaype-Signature` ("Signature hash of the request body with the shared secret"), `Shaype-Key-Id`.
- `POST /holds` (authoriseHold) body **Hold**: `holdId` uuid R, `accountId` uuid R, `cardId` uuid R, `customerId` uuid, `amount` `CurrencyAmount {amount string, currency string}` R ("Positive when crediting customer account and negative when debiting"), `merchantDetails` **Merchant** `{merchantId 1..15, name ≤40, merchantCategoryCode 1..4, terminalId 1..8, cardAcceptorLocation 1..101, address {street ≤80, city ≤40, state ≤3, postcode ≤20, country len 3}}`, `rawExternalProcessorRequest` string.
- `PATCH /holds/{holdId}` (updateHoldAmount) body: `amount` `CurrencyAmount`, `customerId` uuid, `rawExternalProcessorRequest`. "May be equal to the total hold amount in which case reverses the whole transaction."
- `POST /transactions` (authoriseTransaction) body **Transaction**: `transactionId` uuid R, `authorisationTransactionType` enum `BPAY_TRANSFER_OUT`, `DIRECT_DEBIT_TRANSFER`, `GENERAL_CREDIT`, `GENERAL_DEBIT`, `INBOUND_PAYMENT`, `OUTBOUND_PAYMENT` R, `accountId` uuid R, `amount` R, `counterpartDetails {name, basicAccountNumber {accountNumber, branchNumber}}`, `description`, `reference`, `account {id, balance, holder {id, type CUSTOMER|GROUP}, statistics {txn_count_last_10m, txn_sum_last_24h}}`, `customer {id, details {dateOfBirth, firstName, lastName, middleName}, address {...}, tenure_days}`, `transactionTimeUtc`.
- Responses: `200` OK; `470` **Response** `{errorCode enum REFUSED_MAX_BALANCE_EXCEEDED, REFUSED_NOT_ENOUGH_FUNDS, REFUSED_SENDER_ACCOUNT_NOT_VERIFIED; reason string}`; `500`.

## 3. State machines

### 3.1 Mock card transaction lifecycle (per hold / transaction) [docs:simulates-card-transaction-on-staging; docs:card-transactions]

States are my labels for the observable webhook sequence [inferred]; the platform exposes them only through `transactionType` + `isPending`.

| from | to | via | webhook emitted |
|---|---|---|---|
| (none) | HELD (`CARD_TRANSACTION`, `isPending true`) | generateAuthHold; step 1 of generateCardTransaction; step 1 of generateHoldAndUpdateHoldTransactions | `TRANSACTION` / `CARD_TRANSACTION`, `transactionHayId == holdHayId` |
| (none) | DECLINED | any hold mock with `declineReason`, or platform refusal (`outcome` ≠ `ACCEPTED`) | `TRANSACTION` with refused `outcome` and/or `cardProcessorResponse` [mapping open] |
| HELD | HELD (increased) | generateHoldAndUpdateHoldTransactions, `updateHoldAmount` < 0, after `updateHoldDelayInSeconds` | `CARD_TRANSACTION`, `isPending true`, same `transactionHayId`, amount = original + increase |
| HELD | HELD (decreased) / REVERSED (full) | generateHoldAndUpdateHoldTransactions, `updateHoldAmount` > 0 | `CARD_TRANSACTION_REFUND`, `isPending true`, same `transactionHayId`, positive amount |
| HELD (any) | SETTLED (`CARD_TRANSACTION_SETTLED`, `isPending false`) — **terminal** | generateCardTransaction after `settlementDelayInSeconds`; generateHoldAndUpdateHoldTransactions after update + `settlementDelayInSeconds` | new `transactionHayId`, `holdHayId` = original hold |
| (none) | SETTLED (ATM stand-in) — terminal | generateAtmTransaction | `CARD_TRANSACTION`, `isPending false`, `isAtmTransaction true` |
| (none) | REFUNDED (`CARD_TRANSACTION_REFUND`, `isPending false`) — terminal | generateRefundTransaction | own `transactionHayId`, no link to prior purchase |

Terminal: SETTLED, REFUNDED, DECLINED. A bare HELD from generateAuthHold has no documented exit on staging [open].

### 3.2 HayCard.cardStatus [spec enum; transitions from docs are out of this domain]

Values: `ACTIVE`, `AWAITING_ACTIVATION`, `BLOCKED`, `INACTIVE`, `EXPIRED`. Only interaction with this domain: mocks require `ACTIVE` [docs]; `changeCardExpiryDate` sets `expiryDate` but no transition to `EXPIRED` is documented [open].

| from | to | via |
|---|---|---|
| ACTIVE | EXPIRED? | changeCardExpiryDate with a past date — **not documented** [open] |

### 3.3 PayTo payment-instruction status (`PaymentInstructionSummary.transactionStatus`) [spec + docs:payto-staging-testing-suite]

Values: `RECV`, `UNDV`, `SENT`, `SAFD`, `ACCP`, `ACSP`, `ACSC`, `RJCT`. Long forms used by `makeAdhocPayment` / `getMandatePaymentStatus` / search responses [docs]: `RECV`→`RECEIVED`, `SENT`→`SENT`, `SAFD`→`STORE_AND_FORWARD`, `UNDV`→`UNDELIVERED`, `RJCT`→`REJECTED`; `statusIsFinal` false for RECEIVED/SENT/STORE_AND_FORWARD, true for REJECTED. Webhook equivalents: `MANDATE_PAYMENT_RECEIVED`, `_UNDELIVERED`, `_SENT`, `_STORE_AND_FORWARD`, `_ACCEPTED_FOR_CLEARANCE` (ACCP), `_SETTLEMENT_ABORTED` (ACSP), `_ACCEPTED` (ACSC), `_REJECTED`, `_PENDING` [spec:webhooks].

On staging the trajectory is fixed by the **mandate description** at `createMandate`, not by any utilities op [docs]:
| from (initial, returned by makeAdhocPayment) | to (returned by getMandatePaymentStatus) | via (mandate `description`) |
|---|---|---|
| (not shown in docs) [inferred] | (success path) | `paymentstatus:safd` ("To test a scenario when payment is successful") [docs:payto-staging-testing-suite] |
| RJCT (after 15 s timeout, `transactionStatusReasonCode AB01`) | REJECTED, final | `paymentstatus:timeout_rjct` |
| SENT | UNDELIVERED | `paymentstatus:sent&undv` |
| STORE_AND_FORWARD | UNDELIVERED | `paymentstatus:safd&undv` |
| RECEIVED | REJECTED | `paymentstatus:recv&rjct` |
| (no description) | "Settlement aborted" (ACSP) | default: "If no description is provided … default status 'Settlement aborted' is returned at the moment." |

`createStubForMandateSearchPaymentInstructions` does not transition anything; it sets the status values that `searchPaymentsInstructions` will report. Final states per `MandatePaymentEventDto` semantics: `ACSC`/ACCEPTED ("Settlement completed"), `RJCT`, `UNDV` ("Client should retry initiation") [spec:webhooks].

### 3.4 Mock mandate status [docs:payto-staging-testing-suite]

Values (mock): `CREATED`, `ACTIVE`, `SUSPENDED`, `CANCELLED` — set by `description` = `status:created` / `status:active` / `status:suspended` / `status:cancelled` at `createMandate`; default `ACTIVE` ("On production, mandates initially are in status `CREATED`, but for mock solution they're always set as `ACTIVE` unless specified"). "Due to the fact mocks are static, trying to change a mandate status will not actually change it - mocks identify their data based on a pattern in the mandate ID."

| from | to | via (production) | how simulated on staging |
|---|---|---|---|
| CREATED | ACTIVE | Payer accepts → Initiator gets `MCRC`; scheduled payment created | generateMandateNotificationForInitiator `trigger: MCRC` (creates the scheduled payment; status unchanged) |
| CREATED | (rejected) | Payer declines → `MCRD` / `PCRD` | generateMandateNotificationForInitiator `trigger: MCRD` (or `PCRD`) after `resolveMandateByPayer` |
| CREATED | CANCELED (by MMS after 6 days) | expiry → `MCRX` | generateMandateNotificationForInitiator `trigger: MCRX` |
| ACTIVE | SUSPENDED | suspendMandateByInitiator / suspendMandateByPayer ("Only mandates that are in `ACTIVE` status can be successfully suspended") | PayTo op validates; status does not actually change; `MSCH` via either notification mock |
| SUSPENDED | ACTIVE | releaseMandateByInitiator / releaseMandateByPayer ("mandates can be released only when suspended") | as above |
| any (except CREATED by Initiator) | CANCELLED | cancelMandateByInitiator / cancelMandateByPayer | as above; "To fail cancelation of a mandate, simply provide an ID of a mandate that doesn't exist." |
| ACTIVE (terms) | ACTIVE (amended terms; scheduled payment replaced) | amendMandatePaymentTerms → `MAMC` | generateMandateNotificationForInitiator `trigger: MAMC` |

Terminal: CANCELLED / CANCELED.

### 3.5 Direct Entry request status (`DirectEntryEventDto.status`) [spec:webhooks; docs:direct-debits]

Values: `RECEIVED`, `ACCEPTED`, `REJECTED`, `SUBMITTED`, `RETURNED`, `COMPLETE`, `INCOMPLETE`. Production (outbound DD): RECEIVED and ACCEPTED "sent synchronously", SUBMITTED and COMPLETE "arrive later"; a return within 2 working days → RETURNED [docs:direct-debits]. Utilities relevance: `generateInboundDeTransaction` with `recordType: RETURN` is the only mock that could drive SUBMITTED→RETURNED [inferred]; no docs confirm.

| from | to | via |
|---|---|---|
| SUBMITTED | RETURNED | generateInboundDeTransaction `recordType RETURN` (presumed) [inferred] |
| SUBMITTED | COMPLETE | time (2 working days) — not a utilities op |

## 4. Invariants and calculations

- **Sign conventions** [spec]: card mocks (`amount`) must be **< 0** (`exclusiveMaximum 0`), including the refund mock; DE/NPP inbound (`amount`) must be **> 0** (`exclusiveMinimum 0`); RAP/RAPAIN `instructedAmount` and mandate amounts are **decimal strings** (`^(?=.{1,19}$)[0-9]{0,18}(?:\.[0-9]{0,2})?$`, max 2 dp); `updateHoldAmount` positive = decrease/reversal, negative = increase. Webhook `currencyAmount.amount` is negative for debits/holds and positive for credits/refunds/reversals [docs samples].
- **Balance identity** (from consistent webhook samples) [docs:card-transactions; inferred formula]: `totalBalance = availableBalance + heldBalance + lockedBalance + stacksBalance` (e.g. 11.13 = 2.73 + 8.4 + 0 + 0; 10.87 = 1.37 + 9.5). The official statement uses signed balances [docs:account-balances]: "Available Balance = Account Balance + (Overdraft Limit + Overdraft Balance) + Technical Overdraft Balance + Held Balance + Stacks balance" with Held/Overdraft/Technical-Overdraft "$0 or Negative"; and "Total Balance = Total Available Balance + (Overdraft Limit + Overdraft Balance) + Technical Overdraft Balance + Stacks Balance". In the B2B API and webhooks, `heldBalance` is reported as a **positive** number [spec HayAccount; samples].
- **Balance deltas per mock** (abs(a) = absolute value of `amount`) [docs:simulates-card-transaction-on-staging; docs:card-transactions "Balance Update"; arithmetic inferred]:
  | event | totalBalance | heldBalance | availableBalance |
  |---|---|---|---|
  | hold (auth) | 0 | +abs(a) | −abs(a) |
  | hold increase (`updateHoldAmount` u<0) | 0 | +abs(u) | −abs(u) |
  | hold decrease/reversal (u>0) | 0 | −u | +u |
  | settlement of hold h | −h | −h | 0 |
  | ATM stand-in | −abs(a) | 0 | −abs(a) |
  | refund | +abs(a) | 0 | +abs(a) |
  | inbound credit (DE CREDIT, NPP v1/v2, RAP) | +amount | 0 | +amount |
  | inbound DE DEBIT / RAPAIN debit | −amount | 0 | −amount |
- **Settlement amount** = current (updated) hold amount at settlement time: original hold + increases − decreases [docs samples: −9 → −19 → settle −19; −5 → +0.50 → settle −4.50].
- **Hold update reporting**: the increase webhook's `currencyAmount` is the **cumulative** hold (original + increase), not the delta [docs]; the decrease webhook's `currencyAmount` is the **positive delta** released [docs sample 0.5000].
- **`updatedBalance`** in the transaction webhook equals `accountBalances.availableBalance` after the event in the consistent samples [docs:card-transactions §1, §3] (the §2 sample's 5066/5065/5075 values are inconsistent — ignore).
- **ID relationships** [docs]: hold: `transactionHayId == holdHayId`; hold update: same `transactionHayId` as the hold; settlement: new `transactionHayId`, `holdHayId` = hold; ATM/refund: own `transactionHayId`, no `holdHayId`.
- **Delays**: `settlementDelayInSeconds`, `updateHoldDelayInSeconds` ∈ [5, 300] seconds when supplied [spec]; defaults unknown [open].
- **Currency**: default `AUD` when `currency` omitted/null [spec]. Non-AUD → `originalCurrencyAmount` in the webhook [spec:webhooks; inferred].
- **Limits/rules/fraud** are evaluated on every mock exactly as in production ("same internal balance, limit, rule, and fraud checks") [docs]; refusals surface as `outcome` values (§2.7), e.g. `REFUSED_NOT_ENOUGH_FUNDS`, defined as "Transaction declined as it would exceed the account's maximum balance MIN_BALANCE limit" [docs:payment-transaction-outcome]; the condition `availableBalance < |amount|` is [inferred].
- **Account matching for DE/NPP mocks**: `HayAccount.bsb` (6 digits) + `HayAccount.accountNumber` (5–9 digits) [spec]; NPP v1 mock requires exactly 8-digit `receiverAccountNumber` [spec]; RAP/RAPAIN `accountIdentification` = BSB and account concatenated (`"63610027487941"` = `636100` + `27487941`) with `accountIdentificationTypeCode "BBAN"` [docs sample]; mandate-notification `accountIdentification` "in BBAN format", 7..34 chars [spec].
- **ID formats** [spec]:
  - Mandate id in utilities bodies: UUID v1 **without hyphens** — loose `^[0-9a-fA-F]{32}$` (notifications, stub) or strict v1 `^[a-f0-9]{12}1[a-f0-9]{3}[89ab][a-f0-9]{15}$` (RAP/RAPAIN). Docs: `1212c23a-255c-11ee-9a8e-5d3239591cd9` ↔ `1212c23a255c11ee9a8e5d3239591cd9`. Mock mandate ids start `1212…` in every docs sample [docs; "mocks identify their data based on a pattern in the mandate ID"].
  - `instructionIdentification`: BIC11 + `I` + `YYYYMMDD` + `00` + 12-digit sequence + retry digit (`[01]`; stub allows `[0-9a-zA-Z]`), e.g. `ANNCAU22XXXI20230718000000000077240`.
  - `transactionIdentification`: BIC11 + `N` + `YYYYMMDD` + `00` + 12-digit sequence + retry `[01]`.
  - `paymentId`: BIC11 + 23 digits; `originalMessageIdentification`: exactly 34 chars; `originalTransactionIdentification`: exactly 35 chars; `initgPtyIdOrgId`: BIC11 (`^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}[A-Z0-9]{3}$`), docs `NPBOAU21XXX` / `ANNCAU22XXX`.
  - `actionId`: 32 hex. `cardToken`: ≤ 9 digits. `cardId`/`transactionHayId`/`holdHayId`: UUID.
- **Dates** [spec]: `expiryDate` ISO `YYYY-MM-DD` (card expiry = last day of month); mandate `validityStartDate`/`validityEndDate`, `firstPaymentDate`/`lastPaymentDate` `YYYY-MM-DD` interpreted in Australia/Sydney; `creationDateTime` UTC `YYYY-MM-DDThh:mm:ss[.sss]Z`; webhook `transactionTimeUtc` ISO date-time UTC.
- **PayTo staging ad-hoc flow ordering** [docs:payto-staging-testing-suite]: createMandate (ACTIVE) → makeAdhocPayment (returns `instructionId`, `transactionStatus`) → generateReceiveAPaymentInstruction (`ACCP`; debits debtor by `instructedAmount`) → generateInboundNppTransactionV2 (credits creditor). Fixed-frequency: createMandate → generateMandateNotificationForInitiator `MCRC` (schedules payment) → same two utilities. "Current mock solution is supported for mandates with 'ad-hoc' frequency."
- **Search stub join**: `searchPaymentsInstructions` response `endToEndId` comes from `makeAdhocPayment.endToEndId` (default `'Not provided'` when omitted), not from the stub [docs].

## 5. Cross-domain dependencies

| this domain | reads | writes / side effects | other-domain ops involved |
|---|---|---|---|
| card mocks (ATM, hold, hold+settle, hold+update, refund) | `HayCard` by `cardToken` (must be `ACTIVE` [docs]); `HayCard.accountHayId` → `HayAccount` balances, limits, rules, card preferences; `HayAccount.status` | creates card transactions (visible via `searchTransactions` / `getTransactionById` [inferred]); moves `heldBalance`/`availableBalance`/`totalBalance`; consumes daily card/ATM limits [inferred from outcome enum] | `createHayCard`, `getCard` (token); `activateCard`; `createCreditTransactionV0/V1` (top-up: "To top up a staging account, use Create Credit Transaction for Account" [docs]); `updatePaymentPreferences` (card preference outcomes) |
| changeCardExpiryDate | `HayCard` by `cardId` | `HayCard.expiryDate` | Cards API `getCard` to observe |
| generateInboundDeTransaction | `HayAccount` by `bsb`+`accountNumber` [inferred]; outbound DDs from `createDirectDebitV1` for `RETURN`/`REFUSAL` [inferred] | credits/debits account; DE request status (`DirectEntryEventDto`) [inferred] | Direct Debits API (`createDirectDebitV1`, `getDirectDebitV1`), Direct Entry API (`getDirectEntryStatusV1`), Transactions API |
| generateInboundNppTransaction / V2 | `HayAccount` by BSB+account [inferred]; mandate by `mandateIdentification` (V2) | credits account; transaction with `mandatePaymentDetails` (V2 mandate case) | NPP API (`verifyBranchIdentifier`), PayTo API (`createMandate`, `makeAdhocPayment`), Transactions API |
| generateReceiveAPaymentInstruction | mandate (`mandateIdentification`), debtor `HayAccount` | debits debtor by `instructedAmount` [docs] | PayTo API (`createMandate`, `makeAdhocPayment`, `getMandatePaymentStatus`) |
| generateMandateNotificationForInitiator / ForPayer | mandate by `mandateId` (static mock; status by id pattern) | `MCRC`: creates scheduled payment initiation request; `MAMC`: replaces uninitiated scheduled payment [docs]; emits `MANDATE` webhook [inferred] | PayTo API (`createMandate`, `amendMandatePaymentTerms`, `setScheduledPaymentInitiationRequestAmount`, `resolveMandateByPayer`, `getMandateActionsByInitiator`) |
| createStubForMandateSearchPaymentInstructions | — | stub consumed by `searchPaymentsInstructions` | PayTo API `searchPaymentsInstructions`, `makeAdhocPayment` (`endToEndId`) |
| all money-moving mocks | client External Authorisation endpoint, if configured | Shaype → client `POST /holds`, `PATCH /holds/{holdId}`, `POST /transactions`; client `470` refuses [spec:external-balance; linkage inferred] | External authorisation API |
| all mocks | — | webhooks: `TRANSACTION`, `MANDATE`, possibly `MANDATE_PAYMENT`, `DIRECT_ENTRY`, `MANDATE_ACTION_EXPIRATION` [docs/inferred] | Communications API (webhook consumer) — "A working webhook consumer, since the mock endpoints exercise the standard webhook delivery pipeline" [docs] |

Preconditions stated in docs: staging credentials; test customer with active card; linked account with sufficient balance; working webhook consumer [docs:simulates-card-transaction-on-staging]; for PayTo: debtor and creditor accounts "created in the platform, they have been activated and they should contain money"; "Cuscal configuration must be set up on staging to use `external-services-mock`" [docs:payto-staging-testing-suite].

## 6. Error catalogue

| condition | status | message / notes | source |
|---|---|---|---|
| Generic, every op | 400 | "Bad Request" — `ErrorResponse` | [spec] |
| Generic, every op | 403 | "Forbidden" — `ErrorResponse` | [spec] |
| Generic, every op | 422 | "Unprocessable Content" — `ErrorResponse` | [spec] |
| Generic, every op | 500 | "Internal Server Error" | [spec] |
| Generic, every op | 501 | "Not Implemented" | [spec] |
| Calling any utility in production | (unspecified) | "Any attempt to call them in production will fail." | [docs:simulates-card-transaction-on-staging] |
| Schema violations: `amount` ≥ 0 on card mocks; `amount` ≤ 0 on DE/NPP; delay outside 5..300; bad pattern/length/enum; missing required field | 400 | not documented; standard bean-validation → 400 | [inferred] |
| `recordType RETURN` without `returnReason`; `REFUSAL` without `refusalReason` | 400 or 422 | "Required for record type …" (spec description only) | [spec] / [inferred] |
| Unknown `cardToken` / `cardId` / account (BSB+number) / mandate | 422 (no 404 declared) | docs' only 422 sample is from `createMandate` with `description: mandate_rejected` [docs:payto-staging-testing-suite §2.2] — a mandate-creation rejection, not a Utilities op or a not-found lookup: `{"message":"NOT_FOUND: CUS.API.100522 - Creditor account details incorrect (M900 - No matching record found)","details":"Please refer to the API documentation or contact Shaype for more info with the traceId.","status":"422","traceId":"…"}`; no 422 body for a Utilities op is documented [open] | [docs:payto-staging-testing-suite §2.2] / status [inferred] |
| Insufficient balance / limit / rule / fraud / card-preference refusal on a card mock | 200 + webhook `outcome` ≠ `ACCEPTED` (e.g. `REFUSED_NOT_ENOUGH_FUNDS`, `REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED`, `REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED`, `REFUSED_CARD_PREFERENCE` + `cardPreferenceOutcome`, `REFUSED_RULES`, `REFUSED_FRAUD`, `REFUSED_ACCOUNT_BLOCKED`, `REFUSED_ACCOUNT_CLOSED`) | "the platform will decline the simulated authorisation, exactly as it would in production" | [docs] / [spec:webhooks] / HTTP code [inferred] |
| `declineReason` supplied on a hold mock | 200 + declined transaction | "automatically declined by the payment processor with the given reason" | [docs] |
| External-authorisation client refusal | client returns 470 `{errorCode, reason}` → transaction refused | `REFUSED_MAX_BALANCE_EXCEEDED` / `REFUSED_NOT_ENOUGH_FUNDS` / `REFUSED_SENDER_ACCOUNT_NOT_VERIFIED` | [spec:external-balance] |
| Duplicate `idempotencyKey` (DE optional, NPP v1 required) | unknown | "prevent duplication" | [spec] / [open] |
| PayTo ops exercised alongside these mocks (other domain, shown here because the docs give the exact text): suspend non-ACTIVE mandate | error | "Validation of the request for suspension mandate with id: {mandate_id}: To suspend a mandate it must be in active status." | [docs:payto-staging-testing-suite] |
| release non-SUSPENDED mandate | error | "Validation of the request for releasing mandate with id: {mandate_id} failed. To release a mandate it must be in suspended status." | [docs:payto-staging-testing-suite] |
| `makeAdhocPayment` on `paymentstatus:timeout_rjct` mandate | 200 after 15 s | `transactionStatus "REJECTED"`, `statusIsFinal true`, mock log `transactionStatus: RJCT, transactionStatusReasonCode: AB01` | [docs:payto-staging-testing-suite] |
| `checkBsbIsSupportedByPayTo` with BSB `000000` | 200 `{"supported": false}` | | [docs:payto-staging-testing-suite] |

## 7. Open questions

1. **HTTP status for platform declines** on card mocks (insufficient funds, limits, `declineReason`): 200 with the decline only in the webhook, or 4xx? Docs imply 200 + webhook; not stated.
2. **`declineReason` → webhook mapping**: which field (`cardProcessorResponse`? `outcome`?) and which values (request has `CARD_EXPIRED`/`WRONG_CVV`/`CVV_BLOCKED`; webhook enum has `EXPIRED_CARD`/`CVV_FAIL`/`CVV2_FAILURE`/`ALLOWED_PIN_RETRIES_EXCEEDED`…). Docs also list `PIN_BLOCKED`, absent from the spec enum — accept it or reject with 400?
3. **Default delays** when `settlementDelayInSeconds` / `updateHoldDelayInSeconds` are omitted (immediate? 5 s?). And is `settlementDelayInSeconds` measured from the update or from the initial hold?
4. **Refund amount sign**: spec requires `amount < 0` for `generateRefundTransaction`, webhook shows a positive credit. Implement as credit of |amount|.
5. **Success `message` text** for changeCardExpiryDate, ATM, hold, hold+settle, hold+update, refund, DE inbound, NPP inbound v1, payer notification — undocumented.
6. **404 vs 422 vs 400** for unknown card/account/mandate — spec declares no 404 anywhere.
7. **changeCardExpiryDate**: month-end normalisation? transition to `cardStatus EXPIRED` when date is past? `CARD_STATUS_CHANGE` webhook?
8. **Bare holds** (generateAuthHold): do they ever auto-expire/release on staging?
9. **Full reversal** (`updateHoldAmount == |amount|`): is a `CARD_TRANSACTION_SETTLED` of 0 still emitted? `updateHoldAmount == 0` or decrease > hold: error or clamp?
10. **Hold+update webhook count**: docs say "Two webhooks" then list three (hold, update, settlement) — implement three.
11. **Can the incremental authorisation be declined independently** of the initial hold (limits re-checked "for the incremental amount")? Outcome reporting for that case.
12. **Sample inconsistency**: incremental-auth sample shows `totalBalance` changing on a hold increase (232.64 → 241.64) contrary to "total unchanged" elsewhere — implement total-unchanged.
13. **generateInboundDeTransaction** semantics: no docs. Which webhooks (`INTERBANK_TRANSFER_IN` for CREDIT? `DIRECT_DEBIT_TRANSFER` for DEBIT? `DIRECT_ENTRY` status for RETURN/REFUSAL?), how RETURN/REFUSAL are matched to a prior outbound DD, mapping of `returnReason` → `ReturnReason.code`, effect of `REFUSAL`, behaviour when no account matches, `idempotencyKey` duplicate response. Also the spec's swapped BSB/account examples.
14. **generateInboundNppTransaction (v1)** semantics: undocumented; presumed `INTERBANK_TRANSFER_IN` credit. Duplicate `idempotencyKey` → 200 replay or error? Why exactly 8-digit `receiverAccountNumber`?
15. **generateInboundNppTransactionV2**: `originalMessageIdentification` — with or without `N` (docs note vs sample disagree)? Is `MANDATE_PAYMENT` also emitted? What is emitted when `paymentReturnInformation.returnReasonCode` is set (reversal of which outbound transaction)? Are `paymentId`/`transactionIdentification` deduplicated? Is `initgPtyIdOrgId` validated against the client's configured BIC?
16. **generateReceiveAPaymentInstruction**: `transactionType` of the debtor-side debit; behaviour for `transactionStatus: RJCT`; insufficient debtor funds (HTTP error vs refused outcome); does it emit `MANDATE_PAYMENT`; must `instructionIdentification` match a prior `makeAdhocPayment`?
17. **Mandate notification mocks**: exact accepted trigger set (spec enums are malformed single strings; docs use `PCRD` on the Initiator endpoint); does the mock validate that `mandateId` exists; is `mandateDetails` persisted (e.g. `MAMN` updating stored terms); is `MANDATE_ACTION_EXPIRATION` emitted for `MCRX`/`MAMX`; response text for the Payer variant.
18. **createStub**: does a second stub for the same mandate replace or append? Must the mandate exist? Is the stub scoped per client?
19. **Idempotency** in general: none of the card mocks, RAP, RAPAIN, notifications or stub carry a key — treat every call as a new event.
20. **Webhook property naming**: spec `mandateEventDto`/`mandatePaymentEventDto` vs docs samples `mandateEvent`/`mandatePaymentEvent` — pick one (docs samples reflect real payloads).
21. **`HayAccount.status` gating**: which account statuses allow mocks (docs say accounts must be "activated"); is `LOCKED`/`DORMANT` refused with `REFUSED_ACCOUNT_BLOCKED`?
22. **Authentication** for `/v0/utils/*` — spec declares no security scheme; docs require staging credentials.
