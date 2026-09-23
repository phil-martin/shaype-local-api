# 00-transactions — unified TRANSACTION model (consistency critique)

Scope: one model of "a transaction" reconciled across the six domain maps `transactions-holds`, `utilities`, `payid-npp`, `bpay`, `de-dd-scheduled`, `groups-stacks`, checked against the B2B spec (`b2b-operations-api.json`), the webhook spec (`notification-webhooks.json`) and the developer docs.

Labels: `[spec]` B2B spec via jq · `[spec:webhooks]` webhook spec via jq · `[docs:<slug>]` developer.shaype.com/<slug>.md · `[map:<key>]` a domain map · `[inferred]` my reconstruction · `[decision]` recommended default for the local implementation.

Every enum below was re-read with jq from the spec files before printing (`jq '.components.schemas.<S>.properties.<f>.enum'`); counts are jq `length`.

---

## 1. Enum catalogue (verified with jq)

### 1.1 Ledger entity enums — `FinancialTransaction` and `AuthorisationHold` [spec]

The two entities share **identical** `type` (15) and `transactionChannel` (62) enums (jq: both `.type.enum` arrays and both `.transactionChannel.enum` arrays compare equal). Only the descriptions differ — `AuthorisationHold.type` documents just the 5 card values, and `AuthorisationHold.transactionChannel` documents 21 `*_DOMESTIC/_INTERNATIONAL` names that are **not** in its own enum (see §6 C1).

**`type` (15, verbatim order)** [spec]:
`CARD_PRESENT_PAYMENT`, `CARD_NOT_PRESENT_PAYMENT`, `INTRABANK_TRANSFER_IN`, `INTRABANK_TRANSFER_OUT`, `INTERBANK_TRANSFER_IN`, `INTERBANK_TRANSFER_OUT`, `DIRECT_DEBIT_TRANSFER`, `ATM_WITHDRAWAL`, `CARD_PAYMENT_REVERSAL`, `INTERBANK_TRANSFER_OUT_REVERSAL`, `GENERAL_CREDIT`, `GENERAL_DEBIT`, `ORIGINAL_CREDIT`, `BPAY_TRANSFER_OUT`, `BPAY_TRANSFER_IN`

| value | spec meaning (FinancialTransaction.type description, verbatim) | in use? |
|---|---|---|
| `ATM_WITHDRAWAL` | Cash withdrawal from ATM | yes |
| `BPAY_TRANSFER_IN` | (not currently in use) | **no** |
| `BPAY_TRANSFER_OUT` | BPAY payment made out of Account | yes |
| `CARD_NOT_PRESENT_PAYMENT` | Payment online using card details, Apple Pay or Google Pay | yes |
| `CARD_PAYMENT_REVERSAL` | Refund for previous card payment | yes |
| `CARD_PRESENT_PAYMENT` | Payment using physical card, Apple device or Android device at physical terminal | yes |
| `DIRECT_DEBIT_TRANSFER` | Cash transfer out of Account via Direct Debit | yes |
| `INTERBANK_TRANSFER_IN` | Cash transfer into Account via Direct Credit or NPP | yes |
| `INTERBANK_TRANSFER_OUT` | Cash transfer out of Account via Direct Credit or NPP | yes |
| `INTRABANK_TRANSFER_IN` | Cash transfer into Account via ShaypePay | yes |
| `INTRABANK_TRANSFER_OUT` | Cash transfer out of Account via ShaypePay | yes |
| `INTERBANK_TRANSFER_OUT_REVERSAL` | (not currently in use) | **no** |
| `GENERAL_CREDIT` | General purpose credit on Account | yes |
| `GENERAL_DEBIT` | General purpose debit on Account | yes |
| `ORIGINAL_CREDIT` | Cash transfer to card via Visa OCT payment | yes |

**`transactionChannel` (62, verbatim order)** [spec]:
`HAY_TO_HAY_TRANSFER_IN`, `HAY_TO_HAY_TRANSFER_OUT`, `HAAS_TRANSFER_EXTERNAL_IN`, `HAAS_TRANSFER_EXTERNAL_OUT`, `HAAS_TRANSFER_INTERNAL_IN`, `HAAS_TRANSFER_INTERNAL_OUT`, `CURRENCY_CLOUD_CLIENT_CONVERSION_IN`, `CURRENCY_CLOUD_CLIENT_CONVERSION_OUT`, `CURRENCY_CLOUD_CARD_CONVERSION_IN`, `CURRENCY_CLOUD_CARD_CONVERSION_OUT`, `VISA_CARD_NOT_PRESENT`, `VISA_CARD_NOT_PRESENT_INTERNATIONAL`, `VISA_CARD_PRESENT`, `VISA_CARD_PRESENT_INTERNATIONAL`, `VISA_REFUND_DOMESTIC`, `VISA_REFUND_INTERNATIONAL`, `VISA_OCT_DOMESTIC`, `VISA_OCT_INTERNATIONAL`, `VISA_CONTACTLESS`, `VISA_CONTACTLESS_INTERNATIONAL`, `VISA_ATM`, `VISA_ATM_INTERNATIONAL`, `VISA_OTHER`, `APPLE_PAY_CARD_NOT_PRESENT`, `APPLE_PAY_CARD_NOT_PRESENT_INTERNATIONAL`, `APPLE_PAY_CARD_PRESENT`, `APPLE_PAY_CARD_PRESENT_INTERNATIONAL`, `GOOGLE_PAY_CARD_NOT_PRESENT`, `GOOGLE_PAY_CARD_NOT_PRESENT_INTERNATIONAL`, `GOOGLE_PAY_CARD_PRESENT`, `GOOGLE_PAY_CARD_PRESENT_INTERNATIONAL`, `CUSCAL_DE_DEBIT_IN`, `CUSCAL_DE_DEBIT_OUT`, `CUSCAL_DE_CREDIT_IN`, `CUSCAL_DE_CREDIT_OUT`, `DE_DEBIT_RETURN_IN`, `CUSCAL_RTGS_TRANSFER_IN`, `CUSCAL_NPP_TRANSFER_IN`, `CUSCAL_NPP_TRANSFER_OUT`, `NPP_RETURN_IN`, `CUSCAL_BPAY_TRANSFER_IN`, `CUSCAL_BPAY_TRANSFER_OUT`, `BPAY_IN_REJECT`, `MANUAL_ADJUSTMENT`, `VALUE_TRANSFER`, `APPLE_REWARD`, `ACCOUNT_ADJUSTMENT`, `INTEREST_ADJUSTMENT`, `LOAN_ADJUSTMENT`, `LOAN_REPAYMENT`, `SERVICE_FEE`, `VISA_LEGACY`, `VISA_REFUNDS_LEGACY`, `FAT_ZEBRA_TRANSFER_IN`, `CARD_REFUNDS`, `CUSCAL_LEGACY`, `CUSCAL_DE_TRANSFER_IN`, `CUSCAL_DE_TRANSFER_OUT`, `CUSCAL_NPP_SOLICITED_RETURN`, `CUSCAL_DE_TRANSFER_OUT_RETURN`, `NPP_RETURN_OUT`, `HAY_CREDIT`

Spec groups (from the `FinancialTransaction.transactionChannel` description) [spec]:
- **Shaype-operated** (platform sets them): `HAAS_TRANSFER_EXTERNAL_IN/OUT`, `HAAS_TRANSFER_INTERNAL_IN/OUT`, `CURRENCY_CLOUD_CLIENT_CONVERSION_IN/OUT`, `CURRENCY_CLOUD_CARD_CONVERSION_IN/OUT`, `CUSCAL_DE_CREDIT_IN/OUT`, `CUSCAL_DE_DEBIT_IN/OUT`, `DE_DEBIT_RETURN_IN`, `CUSCAL_NPP_TRANSFER_IN/OUT`, `NPP_RETURN_IN`, `CUSCAL_BPAY_TRANSFER_OUT`, `BPAY_IN_REJECT`, `VISA_ATM(_INTERNATIONAL)`, `VISA_CARD_NOT_PRESENT(_INTERNATIONAL)`, `VISA_CARD_PRESENT(_INTERNATIONAL)`, `VISA_CONTACTLESS(_INTERNATIONAL)`, `VISA_OCT_DOMESTIC/INTERNATIONAL`, `VISA_OTHER`, `VISA_REFUND_DOMESTIC/INTERNATIONAL`, `APPLE_PAY_*` (4), `GOOGLE_PAY_*` (4).
- **Client-settable** (= exactly the `CreateTransactionRequestBody.transactionChannel` enum, 7, verbatim order `LOAN_REPAYMENT`, `MANUAL_ADJUSTMENT`, `INTEREST_ADJUSTMENT`, `LOAN_ADJUSTMENT`, `ACCOUNT_ADJUSTMENT`, `SERVICE_FEE`, `APPLE_REWARD`) [spec].
- **Shaype-internal**: `HAY_TO_HAY_TRANSFER_IN/OUT`, `VALUE_TRANSFER`.
- **Not in use**: `HAY_CREDIT`, `CUSCAL_BPAY_TRANSFER_IN`, `CUSCAL_DE_TRANSFER_IN/OUT`, `CUSCAL_DE_TRANSFER_OUT_RETURN`, `CARD_REFUNDS`, `CUSCAL_LEGACY`, `CUSCAL_NPP_SOLICITED_RETURN`, `FAT_ZEBRA_TRANSFER_IN`, `NPP_RETURN_OUT`, `VISA_LEGACY`, `VISA_REFUNDS_LEGACY`.
- **In the enum but in no group**: `CUSCAL_RTGS_TRANSFER_IN` [spec; noted by map:transactions-holds].

**`originType`** — three different enums in the spec [spec]:
| schema | values (verbatim) | n |
|---|---|---|
| `FinancialTransaction.originType`, `HayStackTransaction.originType`, webhook `TransactionEventDto.originType` | `CUSTOMER`, `SCHEDULED_PAYMENT`, `HAAS_OPERATIONS`, `OPERATIONS`, `MANDATE_PAYMENT`, `DIRECT_DEBIT`, `TRANSACTION` | 7 |
| `CreateTransactionRequestBody.originType`, `SearchTransactionsRequestBody.originType` | `CUSTOMER`, `SCHEDULED_PAYMENT`, `HAAS_OPERATIONS`, `OPERATIONS`, `DIRECT_DEBIT` | 5 |

So a client can create/search with 5 values but read 7; `MANDATE_PAYMENT` (PayTo) and `TRANSACTION` ("initiated by another transaction" [spec:webhooks]) are platform-only.

**`originChannel`** (3, on `FinancialTransaction`, `CreateTransactionRequestBody`, `SearchTransactionsRequestBody`) [spec]: `ATM_CASH`, `POS_DEBIT`, `VENUE` — "only applicable if specifically used by Client".

**Card-only field enums** [spec]: `countryOfExpenditure` (249 country names; card transactions only) — not reprinted here, see map:transactions-holds §2.

### 1.2 Request/response "outcome" enums (one-shot results, not states) [spec]

| schema.field | values (verbatim order) | n |
|---|---|---|
| `TransactionOutcome.outcome` (returned by createCredit/DebitTransactionV0/V1, makeTransferV0/V1) | `ACCEPTED`, `INTERNAL_ERROR`, `REFUSED_LIMIT_BREACH`, `REFUSED_FRAUD`, `REFUSED_CUSTOMER_PREFERENCE`, `REFUSED_INSUFFICIENT_FUNDS`, `REFUSED_ACCOUNT_BLOCKED`, `REFUSED_RECIPIENT_ACCOUNT_BLOCKED`, `REFUSED_ACCOUNT_CLOSED`, `REFUSED_RECIPIENT_ACCOUNT_CLOSED`, `REFUSED_INVALID_PAY_ID`, `UNKNOWN`, `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED`, `REFUSED_MAX_BALANCE_EXCEEDED`, `REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_NET_VISA_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_NON_SCHEME_DAILY_LIMIT_BREACHED`, `REFUSED_SENDER_ACCOUNT_NOT_VERIFIED`, `REFUSED_CAPABILITY_NOT_ENABLED`, `REFUSED_QUOTE_EXPIRED` | 21 |
| `BpayPaymentResponseBody.outcome` (makeBpayPayment) | `ACCEPTED`, `INVALID_PAYMENT`, `REFUSED_INSUFFICIENT_FUNDS`, `INTERNAL_ERROR`, `REFUSED_DAILY_BPAY_LIMIT_BREACHED`, `REFUSED_BPAY_INVALID_BILLER_CODE`, `REFUSED_BPAY_INVALID_REFERENCE`, `REFUSED_BPAY_INVALID_PAYMENT`, `REFUSED_BPAY_REJECTED`, `REFUSED_ACCOUNT_BLOCKED`, `REFUSED_RECIPIENT_ACCOUNT_BLOCKED`, `REFUSED_ACCOUNT_CLOSED`, `REFUSED_RECIPIENT_ACCOUNT_CLOSED`, `REFUSED_CAPABILITY_NOT_ENABLED` | 14 |
| `StackTransactionResponse.outcome` (accountToStackTransfer, stackToAccountTransfer) and `StackToStackTransactionOutcome.outcome` (stackToStackTransfer) | `ACCEPTED`, `INTERNAL_ERROR`, `REFUSED_INSUFFICIENT_FUNDS`, `UNKNOWN` | 4 |
| `DirectDebitResponse.outcome` / `DeTransactionDetails.outcome` (v0 DD) | `ACCEPTED`, `REJECTED`, `SUBMITTED`, `RETURNED` | 4 |
| `DirectDebitResponseV1.outcome` / `DeTransactionDetailsV1.outcome` / `DirectEntryStatusResponseV1.status` / webhook `DirectEntryEventDto.status` (v1 DD / DE) | `RECEIVED`, `ACCEPTED`, `REJECTED`, `SUBMITTED`, `RETURNED`, `COMPLETE`, `INCOMPLETE` | 7 |

Notes: the BPAY description lists `INSUFFICIENT_FUNDS` but the enum value is `REFUSED_INSUFFICIENT_FUNDS`; `INVALID_PAYMENT` exists alongside `REFUSED_BPAY_INVALID_PAYMENT` [spec]. The v0 create-transaction ops say a limit breach returns the coarse `REFUSED_LIMIT_BREACH`; v1 returns `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED` / `REFUSED_MAX_BALANCE_EXCEEDED` instead [spec op description].

### 1.3 Secondary transaction-type enums [spec]

| schema.field | values | n | notes |
|---|---|---|---|
| `HayStackTransaction.type` | `STANDARD`, `ROUND_UP` | 2 | STANDARD "Movement of fund to, from or between stacks triggered by customer or ops"; ROUND_UP "Account to Stack transfer triggered by RoundUp functionality" |
| `DeTransactionDetails.type` / `DeTransactionDetailsV1.type` | `CREDIT`, `DEBIT` | 2 | description says "Possible values: **DEBIT**" only |
| `GenerateInboundDeRequestBody.transactionType` | `CREDIT`, `DEBIT` | 2 | CREDIT "Move money from sender account to recipient account"; DEBIT the reverse |
| `GenerateInboundDeRequestBody.recordType` | `DIRECT`, `RETURN`, `REFUSAL` | 3 | |
| `GenerateInboundDeRequestBody.returnReason` | `INVALID_BSB_NUMBER`, `PAYMENT_STOPPED`, `ACCOUNT_CLOSED`, `CUSTOMER_DECEASED`, `NO_ACCOUNT_OR_INCORRECT_ACCOUNT_NUMBER`, `REFER_TO_CUSTOMER`, `INVALID_USER_ID`, `TECHNICAL_INVALID` | 8 | required for `RETURN` |
| `GenerateInboundDeRequestBody.refusalReason` | `RETURN_RECEIVED_OUT_OF_TIME`, `INSUFFICIENT_INFORMATION_TO_APPLY`, `REVERSAL_OF_DUPLICATED_ITEM`, `NO_ARRANGEMENT`, `TECHNICALLY_INVALID` | 5 | required for `REFUSAL` |
| `TransferOutRequestBody.transferType` | `ACCOUNT`, `INTERNAL`, `PAY_ID` | 3 | |
| `Generate*Hold*RequestBody.cardUsage` | `MAGNETIC_STRIPE`, `CONTACTLESS`, `CARD_PRESENT` | 3 | hold-based card mocks only |
| `Generate*Hold*RequestBody.declineReason` | `CARD_EXPIRED`, `WRONG_CVV`, `CVV_BLOCKED`, `INCORRECT_PIN`, `ALLOWED_PIN_RETRIES_EXCEEDED`, `INVALID_MERCHANT`, `CARD_IS_NOT_ACTIVE`, `RESTRICTED_CARD` | 8 | hold-based card mocks only |
| `HayScheduledPayment.status` | `ACTIVE`, `CANCELLED`, `DELETED`, `FAILED`, `REJECTED`, `COMPLETED`, `REPLACED` | 7 | schedule, not transaction |
| `ScheduledPaymentRecipient.recipientType` | `ACCOUNT`, `BPAY` | 2 | |

### 1.4 Webhook enums [spec:webhooks]

**`TransactionEventDto.transactionType` (17, verbatim order)**: `CARD_TRANSACTION`, `CARD_TRANSACTION_REFUND`, `CARD_TRANSACTION_SETTLED`, `INTRABANK_TRANSFER_IN`, `INTRABANK_TRANSFER_OUT`, `INTERBANK_TRANSFER_IN`, `INTERBANK_TRANSFER_OUT`, `DIRECT_DEBIT_TRANSFER`, `HAY_TOP_UP`, `INTERBANK_TRANSFER_OUT_REVERSAL`, `REWARD`, `GENERAL_CREDIT`, `GENERAL_DEBIT`, `ORIGINAL_CREDIT`, `BPAY_TRANSFER_OUT`, `CONVERSION_IN`, `CONVERSION_OUT`

Mapping to the ledger `type` enum (15) [inferred from the descriptions of both]:
| webhook `transactionType` | ledger `type` | note |
|---|---|---|
| `CARD_TRANSACTION` (`isPending: true`) | *(hold — no FinancialTransaction yet)* | `AuthorisationHold.type` ∈ CARD_PRESENT_PAYMENT / CARD_NOT_PRESENT_PAYMENT / ATM_WITHDRAWAL |
| `CARD_TRANSACTION` (`isPending: false`) | `ATM_WITHDRAWAL` (stand-in) | [docs:simulates-card-transaction-on-staging] |
| `CARD_TRANSACTION_SETTLED` | `CARD_PRESENT_PAYMENT` / `CARD_NOT_PRESENT_PAYMENT` / `ATM_WITHDRAWAL` | `relatedHoldHayId` set |
| `CARD_TRANSACTION_REFUND` (`isPending: false`) | `CARD_PAYMENT_REVERSAL` | |
| `CARD_TRANSACTION_REFUND` (`isPending: true`) | *(hold decrease — no FinancialTransaction)* | |
| `INTRABANK_TRANSFER_IN/OUT`, `INTERBANK_TRANSFER_IN/OUT`, `DIRECT_DEBIT_TRANSFER`, `GENERAL_CREDIT`, `GENERAL_DEBIT`, `ORIGINAL_CREDIT`, `BPAY_TRANSFER_OUT`, `INTERBANK_TRANSFER_OUT_REVERSAL` | same name | 1:1 |
| `HAY_TOP_UP`, `REWARD`, `CONVERSION_IN`, `CONVERSION_OUT` | **no ledger equivalent** | webhook-only names; `REWARD` ≈ `GENERAL_CREDIT` + channel `APPLE_REWARD` [inferred]; `CONVERSION_*` ≈ channel `CURRENCY_CLOUD_*` [inferred] |
| — | `BPAY_TRANSFER_IN` | ledger-only (not in use) |

**`TransactionEventDto.outcome`** (41 values) — superset of `TransactionOutcome.outcome`; card-authorisation refusals live only here (`REFUSED_NOT_ENOUGH_FUNDS`, `REFUSED_CARD_PREFERENCE`, `REFUSED_RULES`, `REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED`, `REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED`, `REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED`, …). Full list in map:transactions-holds §2 (verified equal to jq output, 41). Note the HTTP name is `REFUSED_INSUFFICIENT_FUNDS` while the webhook name is `REFUSED_NOT_ENOUGH_FUNDS` [spec vs spec:webhooks].

**`DirectEntryEventDto`**: `type` = [`DEBIT`] (1), `direction` = [`OUTBOUND`] (1), `status` = the 7-value DE list above [spec:webhooks].

**`NotificationDto.type`** values relevant here: `TRANSACTION`, `DIRECT_ENTRY`, `SCHEDULED_PAYMENT`, `MANDATE_PAYMENT` (17 total) [spec:webhooks].

---

## 2. The unified model — what "a transaction" is

There is **no single transaction entity**. Money movement is exposed through four record families plus one webhook projection; the maps agree on this split [map:transactions-holds §3; map:groups-stacks §2; map:de-dd-scheduled §2.7; map:bpay §3].

| family | schema | id field | has status? | listed by | notes |
|---|---|---|---|---|---|
| **Posted ledger entry** | `FinancialTransaction` | `transactionHayId` | **no** — exists only once posted (`clearingTimeUtc`); immutable except `tags` | `POST /v0/transactions/search`, `GET /v1/transactions/{id}` | every accepted money movement on an account (card settlement/refund/ATM, NPP, DE, DD, BPAY, internal, general, PayTo, FX) [spec; map:transactions-holds §3.2] |
| **Pending card authorisation** | `AuthorisationHold` | `holdHayId` | **no** field; internal state AUTHORISED→SETTLED/REVERSED/CANCELLED [map:transactions-holds §3.1] | `GET /v0/accounts/{id}/holds` (pending only), `GET /v1/holds/{holdId}` | card only in practice; enum also allows BPAY/transfer types (see §6 C9) |
| **Stack ledger entry** | `HayStackTransaction` | `hayId` | no | `GET …/stacks/transactions`, `GET …/stacks/{stackId}/transactions` | separate ledger; **not** a `FinancialTransaction` [map:groups-stacks; map:transactions-holds §5] |
| **Direct-entry instruction** | `DeTransactionDetailsV1` (+ `DirectEntryStatusResponseV1`) | client-supplied `transactionId` (inner `transactionHayId`) | **yes** — 7-state DE lifecycle | `GET /v1/direct-debits`, `GET /v1/direct-debits/{id}`, `GET /v1/direct-entry/{id}/status` | the *request*; the money movement is a separate `FinancialTransaction` at COMPLETE [map:de-dd-scheduled §3.2] |
| **Event projection** | webhook `TransactionEventDto` | `transactionHayId` (+ `holdHayId`) | `isPending` + `transactionType` + `outcome` | pushed | the only place refusals, hold updates and `returnReason`/`bpayDetails` are visible [spec:webhooks] |

Cross-cutting field semantics agreed by all maps:
- **Ids**: all UUID. Naming drifts to preserve: `transactionHayId` (entity, paths, webhook) vs `transactionId` (`TransactionOutcome`, `BpayPaymentResponseBody`, `StackTransactionResponse`, DD); `holdHayId` (entity/webhook) vs `holdId` (path) vs `relatedHoldHayId` (`FinancialTransaction`); `accountHayId` (entity/create) vs `accountId` (search/paths) [spec; map:transactions-holds §4.5].
- **Sign**: stored/emitted `currencyAmount.amount` is negative for debits, holds, settlements; positive for credits, refunds, hold decreases, returns [docs:card-transactions; docs:payments; docs:bpay; docs:direct-debits samples]. Request `amount` on create/transfer/BPAY/stack/DD ops is a positive magnitude (`exclusiveMinimum 0` where declared) [spec]; the card mocks require a **negative** `amount` (`exclusiveMaximum 0`), including the refund mock [spec; map:utilities §4].
- **Timestamps**: `transactionTimeUtc` = initiated/authorised; `clearingTimeUtc` = posted; UTC, microsecond `Z` samples [spec; docs].
- **`rollingAccountBalance`** = `totalBalance` after posting [spec; inferred].
- **`tags`** always present (`[]`), only on posted entries [docs:draft-transaction-tagging via map:transactions-holds].

---

## 3. Transaction-kind table

Column key: **type** = `FinancialTransaction.type` / `AuthorisationHold.type` [spec]; **channel** = `transactionChannel` [spec] — where the docs never state which channel a flow carries, the value is the only enum member whose name fits and is marked [inferred]; **webhook** = `TransactionEventDto.transactionType` / `isPending` [spec:webhooks + docs]; **balance** columns use the invariant `available = total − held − locked − stacks` (§5). `a` = absolute amount.

| # | kind | ledger `type` | `transactionChannel` | webhook `transactionType` / `isPending` | status lifecycle | fields populated (beyond the common set) | balance moves (total / held / available) | created by |
|---|---|---|---|---|---|---|---|---|
| 1 | **Card hold** (authorisation) | *(no FinancialTransaction)*; `AuthorisationHold.type` ∈ `CARD_PRESENT_PAYMENT` \| `CARD_NOT_PRESENT_PAYMENT` \| `ATM_WITHDRAWAL` [spec] | `VISA_CARD_PRESENT`, `VISA_CONTACTLESS`, `VISA_CARD_NOT_PRESENT`, `VISA_ATM`, `APPLE_PAY_*`, `GOOGLE_PAY_*` (+`_INTERNATIONAL`) [spec enum; assignment per `cardUsage`/wallet inferred] | `CARD_TRANSACTION` / `true`; `transactionHayId == holdHayId` [docs:card-transactions; docs:simulates-card-transaction-on-staging] | internal AUTHORISED (re-entered on update) → SETTLED \| REVERSED \| CANCELLED [map:transactions-holds §3.1]; refused ⇒ no hold, webhook `outcome REFUSED_*` [inferred, both maps] | `AuthorisationHold`: `holdHayId`, `accountHayId`, `cardId`, `customerId`, `currencyAmount` (−a), `originalCurrencyAmount` (FX), `merchantDetails`, `category` (from MCC), `description`, `transactionTimeUtc`; webhook adds `cardUsageDetails`, `merchantId`, `counterpartName`=merchant, `cardPreferenceOutcome`, `cardProcessorResponse` | 0 / **+a** / **−a** [docs:card-transactions "increasing held balance … reduce the available balance"] | Visa auth (prod); `POST /v0/utils/generate-auth-hold`; step 1 of `generate-card-transaction`, `generate-update-auth-hold` [spec; docs] |
| 2a | **Hold increase** (incremental auth) | *(none)* | as hold | `CARD_TRANSACTION` / `true`; same `transactionHayId`; `currencyAmount` = **new cumulative total** (−(a+d)) [docs:card-transactions §2; docs:simulates…] | AUTHORISED → AUTHORISED | as hold; `currencyAmount` updated in place on the `AuthorisationHold` [inferred] | 0 / **+d** / **−d** | `generate-update-auth-hold` with `updateHoldAmount < 0` [spec] |
| 2b | **Hold decrease / partial reversal** | *(none)* | as hold | `CARD_TRANSACTION_REFUND` / `true`; same `transactionHayId`; `currencyAmount` = **+released delta** (sample `+0.50`) [docs:card-transactions §3] | AUTHORISED → AUTHORISED | as hold | 0 / **−r** / **+r** | `generate-update-auth-hold` with `updateHoldAmount > 0` |
| 2c | **Full reversal / cancel** | *(none)* | as hold | `CARD_TRANSACTION_REFUND` / `true` [docs:card-transactions "partial or full reversal"]; console cancel: undocumented [map:transactions-holds Q11] | AUTHORISED → REVERSED \| CANCELLED (terminal) | hold disappears from `getPendingHolds` [inferred] | 0 / **−h** / **+h** | `updateHoldAmount == a`; Shaype console (no API) |
| 3 | **Settlement** (presentment/clearing) | `CARD_PRESENT_PAYMENT` \| `CARD_NOT_PRESENT_PAYMENT` \| `ATM_WITHDRAWAL` (matches the hold) [spec; inferred] | as hold | `CARD_TRANSACTION_SETTLED` / `false`; **new** `transactionHayId`; `holdHayId` = hold [docs] | hold AUTHORISED → SETTLED; ledger entry posted (single state) | + `relatedHoldHayId`, `clearingTimeUtc`, `rollingAccountBalance`, `cardId`, `countryOfExpenditure`, `externalIdentifiers`, `counterpartDetails.merchantDetails` [spec field descriptions] | **−s** / **−h** / **−s + h** (= 0 when s = h) [docs:card-transactions "lifts the block … deducts the transaction amount"; docs:simulates… "funds are removed from the total balance"] | Visa presentment; `generate-card-transaction` after `settlementDelayInSeconds`; `generate-update-auth-hold` step 3 (settles the **updated** amount) [docs:simulates…] |
| 4 | **ATM stand-in** (no hold) | `ATM_WITHDRAWAL` [spec] | `VISA_ATM` / `VISA_ATM_INTERNATIONAL` [spec; inferred] | `CARD_TRANSACTION` / `false`; `isAtmTransaction true`, `cardUsageDetails.isAtmWithdrawal true`; no `holdHayId` [docs:simulates…] | posted directly | card fields as row 3, **no** `relatedHoldHayId` | **−a** / 0 / **−a** [docs:simulates… "settled in-line"] | `POST /v0/utils/generate-atm-transaction` [spec]. (Prod ATM may also be hold-based — `AuthorisationHold.type` lists `ATM_WITHDRAWAL` [spec]) |
| 5 | **Card refund** (merchant, post-settlement) | `CARD_PAYMENT_REVERSAL` ("Refund for previous card payment") [spec] | `VISA_REFUND_DOMESTIC` / `VISA_REFUND_INTERNATIONAL` [spec; inferred] | `CARD_TRANSACTION_REFUND` / `false`; own `transactionHayId`; **not linked** to the purchase [docs:simulates…] | posted directly | card fields; `currencyAmount` **+a**; no `relatedHoldHayId` | **+a** / 0 / **+a** [docs:card-transactions §4 sample] | `POST /v0/utils/generate-refund-transaction` (request `amount` must be < 0 although the effect is a credit — see §6 C6) [spec] |
| 6 | **NPP in** (incl. PayTo receipt) | `INTERBANK_TRANSFER_IN` ("via Direct Credit or NPP") [spec] | `CUSCAL_NPP_TRANSFER_IN` [spec; inferred] | `INTERBANK_TRANSFER_IN` / `false` [docs:payments sample] | posted directly; PayTo instruction has its own 9-state `transactionStatus` (`RECEIVED`, `UNDELIVERED`, `SENT`, `STORE_AND_FORWARD`, `ACCEPTED_FOR_CLEARANCE`, `SETTLEMENT_ABORTED`, `ACCEPTED_AND_SETTLED`, `REJECTED`, `PENDING`) [spec `PaymentInstruction.transactionStatus`] | `reference` (NPP only), `description`, `counterpartDetails.name` (+ `basicAccountNumber` suppressed by default on read [docs:payments note]), `category "BANK_TRANSFER"` [docs sample]; PayTo: `originType MANDATE_PAYMENT`, webhook `mandatePaymentDetails` (ledger `mandatePaymentDetails` "no data will be provided at present" [spec]) | **+a** / 0 / **+a** | prod NPP; `POST /v0/utils/generate-npp-inbound` (v1), `POST /v0/utils/generate-inbound-npp-transaction-v2` (RAP) [spec; map:utilities] |
| 6r | **NPP return in** (outbound payment returned) | `INTERBANK_TRANSFER_OUT` per the docs sample (positive amount + `returnReason`) — `INTERBANK_TRANSFER_OUT_REVERSAL` is "(not currently in use)" [docs:payments "Return Transfer Sample"; spec] | `NPP_RETURN_IN` [spec; inferred] | `INTERBANK_TRANSFER_OUT` / `false`, `currencyAmount` **+212.38**, `returnReason {code, message}` [docs:payments] | posted directly | webhook `returnReason.code` ∈ `ACCOUNT_BLOCKED`, `ACCOUNT_CLOSED`, `ACCOUNT_INVALID`, `AMOUNT_INVALID`, `CANCELLED`, `CURRENCY_INVALID`, `CUSTOMER_REQUEST`, `DUPLICATE`, `FRAUD`, `OTHER` [spec:webhooks]; **`FinancialTransaction` has no `returnReason` field** [spec] | **+a** / 0 / **+a** | prod; `generate-inbound-npp-transaction-v2` with `paymentReturnInformation.returnReasonCode` [spec; map:utilities] |
| 7 | **NPP out** | `INTERBANK_TRANSFER_OUT` [spec] | `CUSCAL_NPP_TRANSFER_OUT` [spec; inferred] | `INTERBANK_TRANSFER_OUT` / `false` [docs:payments sample] | sync `TransactionOutcome.outcome`; `ACCEPTED` ⇒ posted immediately (no pending state documented) [docs sample `isPending false`] | `reference` (≤35), `description`, `category`, `counterpartDetails {name, basicAccountNumber}`, `originType` (request) | **−a** / 0 / **−a** | `POST /v1/accounts/{id}/transfer` (`makeTransferV1`; v0 deprecated) with `transferType PAY_ID`, or `ACCOUNT` when recipient BSB is non-Shaype and NPP-enabled [docs:payments routing]; scheduled payment occurrence (`originType SCHEDULED_PAYMENT`) [map:de-dd-scheduled §4.5] |
| 8 | **DE in** (direct credit) | `INTERBANK_TRANSFER_IN` [spec] | `CUSCAL_DE_CREDIT_IN` [spec; inferred] | `INTERBANK_TRANSFER_IN` / `false` [docs:direct-debits sample] | posted directly | as row 6 minus `reference` | **+a** / 0 / **+a** | prod BECS; `POST /v0/utils/generate-de-inbound` `{recordType DIRECT, transactionType CREDIT}` [spec] |
| 8o | **DE out** (direct credit sent) | `INTERBANK_TRANSFER_OUT` [spec] | `CUSCAL_DE_CREDIT_OUT` [spec; inferred] | `INTERBANK_TRANSFER_OUT` / `false` | as row 7 | as row 7 | **−a** / 0 / **−a** | `makeTransferV1` `transferType ACCOUNT` when recipient is neither Shaype nor NPP-enabled [docs:payments; docs:direct-debits] |
| 9a | **Direct debit — inbound** (external biller pulls from customer) | `DIRECT_DEBIT_TRANSFER` ("Cash transfer out of Account via Direct Debit") [spec] | `CUSCAL_DE_DEBIT_IN` [spec; inferred] | `DIRECT_DEBIT_TRANSFER` / `false`, amount **−457.12** [docs:direct-debits sample "external bank account pull funds from customer account"] | posted directly; refusals `REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED`, `REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED` (webhook) [spec:webhooks; docs:payment-transaction-outcome] | `counterpartDetails.name`, `category "BANK_TRANSFER"`, `description`; `originType DIRECT_DEBIT` [inferred] | **−a** / 0 / **−a** | prod BECS; `generate-de-inbound` `{DIRECT, DEBIT}` [spec; map:utilities] |
| 9b | **Direct debit — outbound** (client pulls external funds into customer) | request record `DeTransactionDetailsV1.type DEBIT`; ledger `type` at COMPLETE **undocumented** — see §6 C4 (decision: `DIRECT_DEBIT_TRANSFER`, positive) | `CUSCAL_DE_DEBIT_OUT` [spec; inferred]; return: `DE_DEBIT_RETURN_IN` | `DIRECT_ENTRY` webhook per status (`DirectEntryEventDto {type DEBIT, direction OUTBOUND, status}`); `TRANSACTION`/`DIRECT_DEBIT_TRANSFER` "for the actual transaction" [docs:direct-debits] | **RECEIVED → ACCEPTED → SUBMITTED → COMPLETE \| RETURNED \| INCOMPLETE**; RECEIVED → REJECTED. RECEIVED+ACCEPTED synchronous; SUBMITTED at next batch; COMPLETE after 2 working days [docs:direct-debits; map:de-dd-scheduled §3.2]. v0 exposes only `ACCEPTED, REJECTED, SUBMITTED, RETURNED` [spec] | DD record: `amount`, `description` (≤18), sender/recipient BSB+account+name, `processingDate`, `outcome`, `transactionHayId`; **no** accountId/customer/currency on the record [spec] | at creation **0 / 0 / 0** (nothing reserved) [map:de-dd-scheduled §4.3]; at COMPLETE **+a** / 0 / **+a** on the *sender* (Shaype) account [docs:direct-debits] | `POST /v1/direct-debits` (`createDirectDebitV1`; v0 deprecated) [spec]; return simulated by `generate-de-inbound` `{RETURN, DEBIT, returnReason}` [spec; map:utilities] |
| 10 | **BPAY out** | `BPAY_TRANSFER_OUT` [spec] (`BPAY_TRANSFER_IN` not in use) | `CUSCAL_BPAY_TRANSFER_OUT` [spec; inferred]; late Cuscal rejection: `BPAY_IN_REJECT` credit [spec enum; mechanism undocumented, map:bpay §3] | `BPAY_TRANSFER_OUT` / `false` [docs:bpay sample] | sync `BpayPaymentResponseBody.outcome` (14); `ACCEPTED` ⇒ posted immediately; async Cuscal batch 1 PM / 5 PM, results ~2:45 / ~6:15 PM AEST/AEDT [docs:bpay]; no status field | `counterpartDetails.name` = payer nickname (`name`), `category`, `description`; **`bpayDetails {billerCode, billerReference, billerName, billerImage}` only on the webhook** — `ExternalCounterpartDetails` has no `bpayDetails` [spec vs spec:webhooks; map:bpay] | **−a** / 0 / **−a** [docs:bpay sample] | `POST /v1/accounts/{id}/payments/bpay` (`makeBpayPayment`) [spec]; scheduled payment `recipientType BPAY` [spec] |
| 11 | **Transfer between Shaype accounts** (ShaypePay / intrabank) | sender `INTRABANK_TRANSFER_OUT`, recipient `INTRABANK_TRANSFER_IN` ("via ShaypePay") [spec] — **two** ledger entries, one per account [docs:direct-debits "both the sender and receiver will receive a webhook"; inferred for ledger] | `HAAS_TRANSFER_INTERNAL_OUT` / `HAAS_TRANSFER_INTERNAL_IN` [spec; inferred] (`HAY_TO_HAY_TRANSFER_*` are "Shaype internal use only") | `INTRABANK_TRANSFER_OUT` (sender) and `INTRABANK_TRANSFER_IN` (recipient) / `false` [docs:payments samples] | sync `TransactionOutcome`; `REFUSED_RECIPIENT_ACCOUNT_BLOCKED/CLOSED` apply "when transferring funds between Shaype accounts" [docs:payment-transaction-outcome] | `counterpartDetails {accountId, customerId, name}`, `category`, `description`; `reference` not applicable (NPP only) [spec] | sender **−a** / 0 / **−a**; recipient **+a** / 0 / **+a** | `makeTransferV1` `transferType INTERNAL` (`internalTransfer.recipientAccountHayId`), or `ACCOUNT` with a Shaype-BSB recipient ("automatically converted to an INTERNAL") [docs:payments] |
| 12 | **Stack transfer** (account↔stack, stack↔stack) | *(not a FinancialTransaction)* — `HayStackTransaction.type` `STANDARD` (API) \| `ROUND_UP` (platform feature, no API) [spec] | n/a | **none documented**; no stack value in the webhook `transactionType` enum [spec:webhooks; map:groups-stacks] | sync `StackTransactionResponse.outcome` / `StackToStackTransactionOutcome.outcome` (`ACCEPTED`, `INTERNAL_ERROR`, `REFUSED_INSUFFICIENT_FUNDS`, `UNKNOWN`); no pending state [map:groups-stacks §3] | `hayId`, `accountHayId`, `stackHayId`, `stack`, `amount` (sign unstated), `customerId`, `notes` (= request `description`), `originType`, `originId`, `type`, `transactionTimeUtc`; stack→stack: two records cross-linked by `counterpartTransactionId` [spec] | **0 / 0 / ∓a** with `stacksBalance ±a` (account→stack: available −a, stacks +a; reverse for stack→account; stack→stack: account unchanged) [docs:account-balances; docs:stack via map:groups-stacks §4] | `POST …/stacks/{stackId}/transfer-in` (`accountToStackTransfer`), `…/transfer-out` (`stackToAccountTransfer`), `POST …/stacks/transactions` (`stackToStackTransfer`) [spec] |
| 13 | **General credit / debit** | `GENERAL_CREDIT` / `GENERAL_DEBIT` [spec] | request-supplied, one of the 7 client channels: `LOAN_REPAYMENT`, `MANUAL_ADJUSTMENT`, `INTEREST_ADJUSTMENT`, `LOAN_ADJUSTMENT`, `ACCOUNT_ADJUSTMENT`, `SERVICE_FEE`, `APPLE_REWARD` [spec] | `GENERAL_CREDIT` / `GENERAL_DEBIT` / `false` [spec:webhooks enum; emission inferred — never stated, map:transactions-holds Q5] (`REWARD`, `HAY_TOP_UP` are webhook-only names) | sync `TransactionOutcome` (v0 collapses limit breaches to `REFUSED_LIMIT_BREACH`); `ACCEPTED` ⇒ posted immediately with `transactionTimeUtc == clearingTimeUtc` [inferred] | everything copied from the request: `accountHayId`, `amount`, `counterpartName` (deprecated field) → also `counterpartDetails.name` [inferred], `description`, `category`, `originChannel`, `originId`, `originType` (5-value subset), `reference`, `transactionChannel`; no card/NPP fields | credit **+a** / 0 / **+a**; debit **−a** / 0 / **−a** [inferred] | `POST /v1/transactions/credit`, `POST /v1/transactions/debit` (`createCreditTransactionV1`/`createDebitTransactionV1`; v0 `…/credit/create`, `…/debit/create` deprecated) [spec] |
| 14 | *(for completeness)* **Visa OCT** push-to-card credit | `ORIGINAL_CREDIT` [spec] | `VISA_OCT_DOMESTIC` / `VISA_OCT_INTERNATIONAL` [spec] | `ORIGINAL_CREDIT` / `false` | posted directly | card fields | **+a** / 0 / **+a** | no B2B or utilities op [spec] |
| 15 | *(for completeness)* **FX conversion legs** | no ledger `type` — channels `CURRENCY_CLOUD_CLIENT_CONVERSION_IN/OUT`, `CURRENCY_CLOUD_CARD_CONVERSION_IN/OUT` [spec] | as left | `CONVERSION_IN` / `CONVERSION_OUT` (webhook-only names) [spec:webhooks] | FX domain (`ConversionExecuteResponse.outcome` = the 21-value `TransactionOutcome` list) [spec] | `originalCurrencyAmount` | per leg | FX domain ops (out of scope here) |

Common set on every `FinancialTransaction` [spec; inferred population]: `transactionHayId`, `accountHayId`, `customerId`, `productId`, `currencyAmount {amount, currency}`, `type`, `transactionChannel`, `transactionTimeUtc`, `clearingTimeUtc`, `rollingAccountBalance`, `description`, `category`, `originType`, `tags []`, `reportedFraudulent` ("NOT CURRENTLY IN USE").

---

## 4. Status lifecycles (unified)

### 4.1 Where "status" actually lives

| surface | what it is | values |
|---|---|---|
| `FinancialTransaction` | **no status** — a posted entry is a single terminal state; corrections are new entries (`CARD_PAYMENT_REVERSAL`, `NPP_RETURN_IN`, `DE_DEBIT_RETURN_IN`, `BPAY_IN_REJECT`) [spec; map:transactions-holds §3.2] | — |
| `AuthorisationHold` | **no status field**; existence in `getPendingHolds` = pending [spec; map:transactions-holds §3.1] | internal: AUTHORISED → SETTLED \| REVERSED \| CANCELLED [inferred] |
| sync `outcome` (create/transfer/BPAY/stack) | one-shot result; `ACCEPTED` ⇒ posted, anything else ⇒ nothing posted [spec; map:transactions-holds §3.3; map:bpay §3; map:groups-stacks §3] | §1.2 |
| webhook `isPending` | `true` for hold + hold updates; `false` for everything posted [docs] | boolean |
| webhook `outcome` | authorisation result incl. card refusals [spec:webhooks] | 41 values |
| DD / DE instruction | real 7-state machine [spec; docs:direct-debits] | §4.3 |
| PayTo payment instruction | real 9-state machine (`PaymentInstruction.transactionStatus`) / 8 ISO codes (`PaymentInstructionSummary.transactionStatus`: `RECV`, `UNDV`, `SENT`, `SAFD`, `ACCP`, `ACSP`, `ACSC`, `RJCT`) / webhook `MandatePaymentEventDto.paymentStatus` (9 `MANDATE_PAYMENT_*`) [spec; spec:webhooks] | PayTo domain |
| Scheduled payment | schedule status, not the occurrence: `ACTIVE`, `CANCELLED`, `DELETED`, `FAILED`, `REJECTED`, `COMPLETED`, `REPLACED` [spec] | schedule domain |

### 4.2 Card lifecycle (the only pending→posted flow)

```
                 refused (webhook outcome REFUSED_*, no hold)
                /
(auth request) ──> AUTHORISED ──increase──> AUTHORISED   [CARD_TRANSACTION / true, cumulative amount]
                     │   └────decrease────> AUTHORISED   [CARD_TRANSACTION_REFUND / true, +delta]
                     ├──full reversal / cancel──> REVERSED / CANCELLED   [CARD_TRANSACTION_REFUND / true]
                     └──presentment──> SETTLED  +  FinancialTransaction{relatedHoldHayId}   [CARD_TRANSACTION_SETTLED / false, new id]

(ATM stand-in) ──> FinancialTransaction ATM_WITHDRAWAL            [CARD_TRANSACTION / false, no hold]
(merchant refund) ──> FinancialTransaction CARD_PAYMENT_REVERSAL  [CARD_TRANSACTION_REFUND / false, unlinked]
```
Sources: [docs:card-transactions §1–4; docs:simulates-card-transaction-on-staging; map:transactions-holds §3.1; map:utilities §3.1]. Undocumented: hold expiry (merchant windows "up to 28 days" / "7-10 days" are stated but no auto-release) [docs:card-transactions; both maps open]; partial settlement (s ≠ h) arithmetic [map:transactions-holds Q10]; console-cancel webhook [map:transactions-holds Q11].

### 4.3 Direct-entry instruction lifecycle (outbound DD) [spec; docs:direct-debits; map:de-dd-scheduled §3.2]

```
create ──> RECEIVED ──> ACCEPTED ──(next DE batch)──> SUBMITTED ──(≈2 working days)──> COMPLETE  (+ credit posted)
              │                                          ├──> RETURNED  (recipient FI returns; terminal)
              └──> REJECTED (validation/authorisation)   └──> INCOMPLETE (crediting failed; terminal)
```
RECEIVED and ACCEPTED "sent synchronously"; SUBMITTED and COMPLETE "arrive later" [docs:direct-debits]. One `DIRECT_ENTRY` webhook per status [docs]. v0 read model collapses to `ACCEPTED, REJECTED, SUBMITTED, RETURNED` and its list filter to `ACCEPTED, SUBMITTED, RETURNED` [spec] — rendering of RECEIVED/COMPLETE/INCOMPLETE through v0 is undocumented [map:de-dd-scheduled]. The utilities mock `generate-de-inbound {RETURN}` is the only way to drive SUBMITTED → RETURNED locally, and the matching rule is undocumented [map:utilities §3.5].

### 4.4 Everything else: sync outcome → posted

NPP out, DE out, intrabank, BPAY, general credit/debit, stack transfers: the create call returns `outcome`; `ACCEPTED` means the ledger entry (or stack entry) exists and balances have moved; every documented webhook sample for these has `isPending: false` [docs:payments; docs:bpay; docs:direct-debits]. No map found evidence of a pending/hold phase for any non-card flow [map:bpay §3 "Whether the platform first creates an authorisation hold … is not stated"; map:groups-stacks §3 "no pending state exists for stack movements"].

---

## 5. Balance arithmetic (unified)

**Working invariant** (all maps converge on it; see §6 A1): with `heldBalance`, `lockedBalance`, `stacksBalance` stored **positive** [spec `HayAccount` "Positive value"; webhook samples]:

`availableBalance = totalBalance − heldBalance − lockedBalance − stacksBalance` (no overdraft) [map:transactions-holds §4.1; map:utilities §4; map:groups-stacks §4; map:de-dd-scheduled §4.2 (partial); map:bpay §4 (degenerate case)]

The docs formula — "Available Balance = Account Balance + (Overdraft Limit + Overdraft Balance) + Technical Overdraft Balance + Held Balance + Stacks balance" with Held "$0 or Negative" and Stack "$0 or Positive" [docs:account-balances] — is not usable as written (it *adds* a positive stack balance to available, contradicting the spec's "Funds that are held, locked and allocated to a Stack will not be available"); every map rejects it in favour of the sample-derived invariant. Overdraft terms remain unresolved [map:transactions-holds Q31].

| event | Δ total | Δ held | Δ available | Δ stacks | source |
|---|---|---|---|---|---|
| card hold a | 0 | +a | −a | 0 | docs:card-transactions |
| hold increase d | 0 | +d | −d | 0 | docs:card-transactions §2 (sample's `total` also moves +9 — treated as unreliable by both maps) |
| hold decrease r | 0 | −r | +r | 0 | docs:card-transactions §3 |
| full reversal / cancel (h) | 0 | −h | +h | 0 | inferred |
| settlement (hold h, settled s) | −s | −h | −s + h | 0 | docs:card-transactions; s = h in every usable sample |
| ATM stand-in a | −a | 0 | −a | 0 | docs:simulates… |
| card refund a | +a | 0 | +a | 0 | docs:card-transactions §4 |
| NPP/DE in a | +a | 0 | +a | 0 | docs:payments / docs:direct-debits samples |
| NPP/DE out a, intrabank out a, BPAY a, general debit a | −a | 0 | −a | 0 | docs samples |
| intrabank in a, general credit a | +a | 0 | +a | 0 | docs samples / inferred |
| inbound DD (customer debited) a | −a | 0 | −a | 0 | docs:direct-debits sample |
| outbound DD at COMPLETE a | +a | 0 | +a | 0 | docs:direct-debits; nothing at creation |
| NPP return in a | +a | 0 | +a | 0 | docs:payments return sample |
| account → stack a | 0 | 0 | −a | +a | docs:stack via map:groups-stacks |
| stack → account a | 0 | 0 | +a | −a | same |
| stack → stack a | 0 | 0 | 0 | 0 | same (two stack records) |

Webhook `updatedBalance`: equals post-event `availableBalance` in every internally consistent sample (card scenarios 1 & 3; BPAY; DD; intrabank) and is inconsistent in the card scenario-2 and refund samples [docs:card-transactions; map:transactions-holds Q29; map:utilities §4]. `rollingAccountBalance` on the ledger entry = post-event `totalBalance` [spec description; inferred].

Limits touching the ledger (rolling 24 h window [docs:account-limits]): `MAX_BALANCE` (credits), `SINGLE_CARD_TRANSACTION`, `CARD_PAYMENTS_DAILY`, `ATM_WITHDRAWAL_PER_DAY`, `TOP_UP_PER_DAY`, `PAYMENT_TO_ACCOUNT_NUMBER`, `TOTAL_SPEND_PER_YEAR`, `BPAY_DAILY_LIMIT`, `DIRECT_DEBIT_PER_DAY`, plus client-level liquidity thresholds `TOTAL_DAILY_INBOUND_DIRECT_DEBIT`, `TOTAL_DAILY_NET_NON_SCHEME`, `TOTAL_DAILY_NET_VISA`, `TOTAL_DAILY_OUTBOUND_BPAY` [spec enums; docs:account-limits; map:transactions-holds §4.4]. Stack movements are exempt from daily transfer limits but count toward `MAX_BALANCE` [docs:stack via map:groups-stacks]. General credit/debit: "only minimum balance validation is applied" [docs:payments] — see §6 C7.

---

## 6. Disagreements and gaps

### 6.1 Agreements worth recording (no action)

- **A1 balance invariant** — all six maps land on `available = total − held − locked − stacks` (map:de-dd-scheduled only verifies `total − held` because its samples have zero locked/stacks). No map adopts the docs:account-balances signed formula.
- **A2 hold-update webhook amounts** — map:transactions-holds ("`currencyAmount` = new total (original + increase)" / "+reversed portion (sample `+0.50`)") and map:utilities ("the increase webhook's `currencyAmount` is the **cumulative** hold … the decrease webhook's `currencyAmount` is the **positive delta**") agree.
- **A3 stack transactions are not FinancialTransactions** — map:groups-stacks and map:transactions-holds §5 ("Stack transactions are a separate API … and not `FinancialTransaction`s here") agree; both leave the stack webhook undefined.
- **A4 insufficient-funds naming** — map:transactions-holds Q3 and map:bpay both note HTTP `REFUSED_INSUFFICIENT_FUNDS` vs webhook/docs `REFUSED_NOT_ENOUGH_FUNDS`.
- **A5 `PIN_BLOCKED`** — map:transactions-holds §5 and map:utilities both flag it as docs-only (not in the spec `declineReason` enum; jq confirms 8 values without it).
- **A6 NPP/DE/PayTo share `INTERBANK_TRANSFER_IN`** — map:payid-npp (`CUSCAL_NPP_TRANSFER_IN`) and map:utilities (`INTERBANK_TRANSFER_IN` for DE credit and RAP) agree the ledger `type` is shared and only `transactionChannel` distinguishes rails.

### 6.2 Contradictions between maps (quoting both)

| # | topic | map A says | map B says | resolution |
|---|---|---|---|---|
| **C1** | Which ledger `type` the **outbound-DD credit** carries | map:de-dd-scheduled §3.2: "SUBMITTED → COMPLETE … sender account balance += amount … + TRANSACTION (DIRECT_DEBIT_TRANSFER) webhook at COMPLETE [inferred]"; Q9: "the spec describes `DIRECT_DEBIT_TRANSFER` as 'Cash transfer out of Account via Direct Debit', whereas an outbound DD *credits* the sender at COMPLETE" | map:utilities (generate-de-inbound `DIRECT`+`DEBIT`): "an external biller pulls funds from the Shaype account — an *inbound direct debit*. Production webhook: `TRANSACTION` / `transactionType: DIRECT_DEBIT_TRANSFER` ('when external bank account pull funds from customer account using Direct Debit')"; map:transactions-holds §1 quotes the spec meaning "Cash transfer out of Account via Direct Debit" | Both readings are of the same enum value in opposite directions; the spec meaning is *outflow*. No ledger `type` names an inbound DD credit. [decision] outbound-DD credit posts `type: DIRECT_DEBIT_TRANSFER`, `transactionChannel: CUSCAL_DE_DEBIT_OUT`, **positive** `currencyAmount`, `originType: DIRECT_DEBIT`, `originId` = DD `transactionId`; inbound DD debit posts `DIRECT_DEBIT_TRANSFER` / `CUSCAL_DE_DEBIT_IN` / negative. Flag as a spec gap. |
| **C2** | Whether `DIRECT_DEBIT_PER_DAY` governs **outbound** DD creation or **inbound** DDs | map:de-dd-scheduled §1 (createDirectDebitV1): "Whether that limit is applied to *this* (outbound-DD, credit-to-customer) flow or only to inbound DDs that debit the customer is contradictory between the two sources" (spec: "Maximum value of outgoing direct debit transfers"; docs:account-limits: "outgoing cash from inbound direct debit requests") | map:utilities (`DIRECT`+`DEBIT`): "Platform limit outcomes that exist for this: `REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED`, `REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED`" — i.e. applied to the inbound DD that debits the customer | [decision] apply `DIRECT_DEBIT_PER_DAY` to inbound DDs (customer debited) and to nothing on `createDirectDebitV1`; the outbound DD credit is limit-checked only by `MAX_BALANCE` at COMPLETE (→ `INCOMPLETE`). |
| **C3** | Outcome name for a **BPAY daily-limit breach** | map:bpay §1 rule 3: "Outcome: `REFUSED_DAILY_BPAY_LIMIT_BREACHED` per this endpoint's enum [spec]; but the outcome catalogue names `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED` … and that value is what the webhook `outcome` enum and the generic `TransactionOutcome` schema carry" | map:transactions-holds §4.4: "`BPAY_DAILY_LIMIT` → `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`" (single mapping, no sync/webhook split) | jq: `BpayPaymentResponseBody.outcome` has `REFUSED_DAILY_BPAY_LIMIT_BREACHED` and **not** `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`; `TransactionEventDto.outcome` has the reverse. [decision] sync response → `REFUSED_DAILY_BPAY_LIMIT_BREACHED`; webhook (if emitted for refusals) → `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`. |
| **C4** | Ledger `type` for an **NPP payment return** | map:transactions-holds §3.2: "corrections are new transactions (refund, `DE_DEBIT_RETURN_IN`, `NPP_RETURN_IN` channels, `CARD_PAYMENT_REVERSAL` type)" and §1: `INTERBANK_TRANSFER_OUT_REVERSAL` "(not currently in use)" — implying a distinct reversal type is not available | map:utilities (RAP `paymentReturnInformation`): "production shows this as a `TRANSACTION` with `returnReason {code, message}` on the `INTERBANK_TRANSFER_OUT` reversal … the sample's `returnReason` = `{code: CUSTOMER_REQUEST …}`, `isPending false`, `outcome ACCEPTED`, and its `currencyAmount` is **positive** (`+212.38`)" | Not strictly contradictory but the maps never reconcile: the return is emitted under the *outbound* type with a positive amount. [decision] post `type: INTERBANK_TRANSFER_OUT`, `transactionChannel: NPP_RETURN_IN`, positive amount, `originType: TRANSACTION`, `originId` = original outbound `transactionHayId`; `returnReason` only on the webhook (`FinancialTransaction` has no such field — spec gap). |
| **C5** | Reliability of the **card scenario-3 settlement sample** | map:transactions-holds §4.2 / Q10: "it is not self-consistent with a 4.50 settlement (the remaining 4.50 of held funds also disappears); it cannot be used to verify settlement arithmetic" | map:utilities §4: "Settlement amount = current (updated) hold amount at settlement time … [docs samples: −9 → −19 → settle −19; −5 → +0.50 → settle −4.50]" and its delta table states settlement = "−h, −h, 0" | Both are right about different things: utilities uses the sample's `currencyAmount` (−4.50, correct); transactions-holds rejects its `accountBalances` (held 9 → 0, total −9). [decision] settle the current hold amount; `Δtotal = −s`, `Δheld = −h`, with s = h unless a future partial-settlement rule is documented. |
| **C6** | **Refund mock amount sign** | map:utilities: "`amount` — number, required, `maximum 0`, `exclusiveMaximum true` (**amount < 0, even though a refund credits the account**). The refund webhook sample shows a **positive** `currencyAmount.amount: 5.99`" | map:transactions-holds §4.3: "staging mock card endpoints say 'Pass a negative value as transaction will deduct the account balance' [docs:simulates…] but that is a different endpoint family" (does not cover the refund case) | jq confirms `GenerateCardTransactionRequestBody.amount` is shared by ATM and refund with `exclusiveMaximum 0`. [decision] the refund mock credits `abs(amount)`; validation still rejects `amount >= 0` to match the spec. |
| **C7** | **Which checks apply to general credit/debit** | map:transactions-holds §1: "a credit that would push the balance over `MAX_BALANCE` ⇒ `REFUSED_MAX_BALANCE_EXCEEDED` … Daily limits are evaluated over a rolling 24h window" and Q6 asks which other limits apply; the spec v0 description promises "`REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED`, `REFUSED_MAX_BALANCE_EXCEEDED`" | docs:payments (not cited by any map): "Transactions performed using the General Credit and Debit endpoints do not involve any movement of funds and are treated as manual balance adjustments … These transactions are not considered outbound transactions; **only minimum balance validation is applied**" | Docs contradict the spec's own v0 description. [decision] debit: refuse `REFUSED_INSUFFICIENT_FUNDS` when `available < a` (MIN_BALANCE = 0); credit: apply `MAX_BALANCE` → `REFUSED_MAX_BALANCE_EXCEEDED` (keeps the spec-promised outcome reachable); no daily-transfer limits; account `LOCKED`/`CLOSED` → `REFUSED_ACCOUNT_BLOCKED`/`_CLOSED`. |
| **C8** | **`originType` of an outbound-DD credit / DD-initiated entries** | map:de-dd-scheduled §2.9 quotes the webhook enum `DIRECT_DEBIT` = "Transaction initiated by direct debit" and Q9 asks "`originType` (`DIRECT_DEBIT`?)" | map:transactions-holds §1 lists `DIRECT_DEBIT` among the **client-settable** request values on `CreateTransactionRequestBody.originType` ("DIRECT_DEBIT: by Direct Debit") | jq: `CreateTransactionRequestBody.originType` = 5 values incl. `DIRECT_DEBIT`; so a client may stamp a general credit as DD-originated. Not contradictory, but neither map says which flows the platform stamps. [decision] platform stamps `DIRECT_DEBIT` on both DD legs; clients may also pass it on general credits (accepted as-is). |
| **C9** | **Do non-card flows ever hold?** | map:bpay §1 rule 8: "Whether the platform first creates an authorisation hold (spec `AuthorisationHold.type` includes `BPAY_TRANSFER_OUT`) is not stated → §7" | map:transactions-holds §3.1 models holds as card-only ("Created by: Visa authorisation … staging Utilities generateAuthHold…") and §3.4 "all non-card transactions … `false` directly" | jq: `AuthorisationHold.type` is the full 15-value enum (identical to `FinancialTransaction.type`) — a schema-reuse artefact, not evidence of BPAY holds. [decision] holds exist only for card kinds (rows 1–3); `getPendingHolds` never lists BPAY/transfer/DD entries. |
| **C10** | **Webhook for a refused authorisation** | map:transactions-holds §3.1: "(none) → refused (no hold created) … [inferred] that a refused authorisation still emits a webhook" | map:utilities §3.1: "(none) → DECLINED … `TRANSACTION` with refused `outcome` and/or `cardProcessorResponse` [mapping open]" | Same inference, but utilities additionally treats `declineReason` (processor decline) as a separate path whose webhook fields are open. Neither path is documented. [decision] (low confidence) emit one `TRANSACTION` / `CARD_TRANSACTION` / `isPending false`, `currencyAmount` = requested, balances unchanged: platform refusals carry the matching `outcome` (`REFUSED_NOT_ENOUGH_FUNDS`, `REFUSED_CARD_PREFERENCE` + `cardPreferenceOutcome`, `REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED`, …); a `declineReason` carries `outcome: INTERNAL_ERROR` and `cardProcessorResponse` mapped by name (`CARD_EXPIRED`→`EXPIRED_CARD`, `WRONG_CVV`→`CVV_FAIL`, `CVV_BLOCKED`→`CVV2_FAILURE`, the other five verbatim). |
| **C11** | **`counterpartDetails` shape on read vs webhook** | map:bpay §2: "`FinancialTransaction.counterpartDetails` is `ExternalCounterpartDetails` {`accountId`, `basicAccountNumber`, `customerId`, `merchantDetails`, `name`} — **no `bpayDetails`** field, unlike the webhook's `CounterpartDetails`" | map:transactions-holds §2 lists webhook `counterpartDetails` as "{`accountId`, `customerId`, `name`, `bpayDetails`, `basicAccountNumber`}" and `ExternalCounterpartDetails` separately, without noting the asymmetry (webhook lacks `merchantDetails`; API lacks `bpayDetails`) | jq confirms both. Spec-internal gap, maps consistent. [decision] store both `merchantDetails` and `bpayDetails` internally; project per surface. |
| **C12** | **Sign of `HayStackTransaction.amount`** | map:groups-stacks §2: "`amount` … (sign convention not stated [open])" | no other map covers it; map:transactions-holds §4.3 gives the ledger convention "credits positive, debits negative" | [decision] apply the ledger convention *from the stack's perspective*: deposit to stack `+a`, withdrawal from stack `−a`; stack→stack yields `−a` (withdrawal record) and `+a` (deposit record) cross-linked by `counterpartTransactionId`. |

### 6.3 Spec-internal inconsistencies surfaced by the maps (verified with jq)

- **S1** `AuthorisationHold.transactionChannel` description lists 21 `*_DOMESTIC`/`*_INTERNATIONAL` names of which 8 (`APPLE_PAY_CARD_NOT_PRESENT_DOMESTIC`, `APPLE_PAY_CARD_PRESENT_DOMESTIC`, `GOOGLE_PAY_CARD_NOT_PRESENT_DOMESTIC`, `GOOGLE_PAY_CARD_PRESENT_DOMESTIC`, `VISA_ATM_DOMESTIC`, `VISA_CARD_NOT_PRESENT_DOMESTIC`, `VISA_CARD_PRESENT_DOMESTIC`, `VISA_CONTACTLESS_DOMESTIC`) are **not** in the enum; the enum's domestic spelling is the bare name (`VISA_CARD_PRESENT`) [map:transactions-holds Q24; jq].
- **S2** `TransactionOutcome.outcome` description lists 18 values, enum has 21 (`REFUSED_SENDER_ACCOUNT_NOT_VERIFIED`, `REFUSED_CAPABILITY_NOT_ENABLED`, `REFUSED_QUOTE_EXPIRED` enum-only) [map:transactions-holds; jq].
- **S3** `BpayPaymentResponseBody.outcome` description says `INSUFFICIENT_FUNDS`; enum says `REFUSED_INSUFFICIENT_FUNDS`; enum also carries `REFUSED_ACCOUNT_BLOCKED`, `REFUSED_RECIPIENT_ACCOUNT_*`, `REFUSED_CAPABILITY_NOT_ENABLED` not in the description [map:bpay; jq].
- **S4** `DeTransactionDetails(.V1).type` enum `CREDIT, DEBIT`, description "Possible values: **DEBIT**" [map:de-dd-scheduled; jq].
- **S5** `originType`: 7 values on read entities and webhook, 5 on create/search bodies — `MANDATE_PAYMENT` and `TRANSACTION` are unsearchable [map:transactions-holds §1; jq].
- **S6** `CUSCAL_RTGS_TRANSFER_IN` is in the channel enum but in no description group [map:transactions-holds; jq].
- **S7** `FinancialTransaction.mandatePaymentDetails` — "no data will be provided at present" [spec description] while the webhook populates `mandatePaymentDetails` for PayTo [docs:payto-payment via map:utilities].
- **S8** webhook `transactionType` has 4 names with no ledger `type` (`HAY_TOP_UP`, `REWARD`, `CONVERSION_IN`, `CONVERSION_OUT`); ledger has 1 with no webhook name (`BPAY_TRANSFER_IN`, unused) [jq both specs].
- **S9** `GenerateInboundDeRequestBody` property examples have `recipientBsb: "35022223"` (8 digits) and `recipientAccountNumber: "522843"` — swapped relative to the request examples [map:utilities; jq].
- **S10** DE/NPP BSB and account patterns (`\d{6}`, `\d{5,9}`, `[0-9]{8}`) are unanchored [map:utilities §4; map:de-dd-scheduled §1].

### 6.4 Docs-internal inconsistencies the maps rely on

- **D1** docs:card-transactions scenario-2 hold-increase sample changes `totalBalance` by +9.00 (232.64 → 241.64) although a hold must not move total [map:utilities; map:transactions-holds].
- **D2** docs:card-transactions scenario-3 settlement sample (see C5).
- **D3** docs:card-transactions `updatedBalance` equals `availableBalance` in scenarios 1 & 3 but not in scenario 2 (5066/5065/5075 vs 66/65/75) nor the refund (3305.99 vs 5.99) [map:transactions-holds Q29].
- **D4** docs:payments places the "In reversal transfer webhook you will receive returnReason object" sentence and its sample under the `INTRABANK_TRANSFER_OUT` heading while the sample's `transactionType` is `INTERBANK_TRANSFER_OUT` [map:utilities].
- **D5** docs:simulates-card-transaction-on-staging says "Two webhooks are emitted in sequence" for hold+update and then lists three [map:utilities].
- **D6** docs:account-limits defines daily limits as a "rolling 24h window" and then says "rejected until the next calendar day" [map:transactions-holds §4.4; map:bpay §4].
- **D7** docs:account-balances signed-balance formula vs spec positive `heldBalance` (A1).

---

## 7. Recommended defaults for the local implementation [decision]

1. **One internal ledger table** keyed by `transactionHayId` holding every `FinancialTransaction` field plus internal-only columns: `kind` (rows 1–15), `holdState` (for card holds: `AUTHORISED|SETTLED|REVERSED|CANCELLED`), `bpayDetails`, `returnReason`, `mandatePaymentDetails`, `isPending`. Holds live in the same table with `isPending = true` and are projected to `AuthorisationHold` (pending only) or excluded from `FinancialTransaction` reads; settlement inserts a **new** row with `relatedHoldHayId` and flips the hold's `holdState`.
2. **`type`/`channel` assignment**: table §3. Card: `cardUsage` `CARD_PRESENT`/`MAGNETIC_STRIPE` → `CARD_PRESENT_PAYMENT` + `VISA_CARD_PRESENT`; `CONTACTLESS` → `CARD_PRESENT_PAYMENT` + `VISA_CONTACTLESS`; null → `CARD_NOT_PRESENT_PAYMENT` + `VISA_CARD_NOT_PRESENT`; ATM → `ATM_WITHDRAWAL` + `VISA_ATM`; refund → `CARD_PAYMENT_REVERSAL` + `VISA_REFUND_DOMESTIC`; `currency ≠ AUD` → `_INTERNATIONAL` variant + `originalCurrencyAmount` + `countryOfExpenditure` from merchant address (else `AUSTRALIA`).
3. **Balances**: keep `heldBalance`, `lockedBalance`, `stacksBalance` positive; enforce `available = total − held − locked − stacks` after every event (table §5); ignore overdraft. `rollingAccountBalance` = new `totalBalance`; webhook `updatedBalance` = new `availableBalance`.
4. **Signs**: store credits `+`, debits `−`; hold rows store `−a`; hold-decrease webhook carries `+r`, hold-increase webhook carries the cumulative `−(a+d)`; refund/return rows `+a`.
5. **Statuses**: no status column on posted rows; DD instructions get their own table with the 7-state machine, transitions driven by a scheduler (`ACCEPTED`→`SUBMITTED` at next simulated batch, →`COMPLETE` after a configurable delay, default seconds not days) and by `generate-de-inbound {RETURN}` matched on (senderBsb, senderAccountNumber, amount, oldest SUBMITTED) → `RETURNED`.
6. **Outcome naming per surface**: sync `TransactionOutcome` uses `REFUSED_INSUFFICIENT_FUNDS`; BPAY sync uses `REFUSED_DAILY_BPAY_LIMIT_BREACHED`; webhooks use `REFUSED_NOT_ENOUGH_FUNDS` / `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`. v0 create ops collapse `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED` and `REFUSED_MAX_BALANCE_EXCEEDED` to `REFUSED_LIMIT_BREACH`.
7. **Webhooks**: emit `TRANSACTION` for every row in §3 rows 1–11 and 13 (both legs of an intrabank transfer, to each account's customer); `DIRECT_ENTRY` per DD status; nothing for stack transfers (row 12); one `TRANSACTION` with refused `outcome` and unchanged balances for refused card authorisations.
8. **Idempotency**: `idempotencyKey` (create, transfer, BPAY, DD, NPP-inbound mock) — replay returns the original response body (same `transactionId`/`outcome`), same key + different body → 422.
9. **Unknown ids** → 422 `ErrorResponse` (no 404 is declared anywhere in the spec).
10. **Search**: filter and sort on `clearingTimeUtc` (`sortBy CLEARING_TIME`, default) or `transactionTimeUtc`; inclusive `from`, exclusive `to`; descending; bare array; posted rows only.
