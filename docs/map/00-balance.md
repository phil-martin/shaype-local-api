# 00 — Unified balance model (consistency critic across domain maps)

Reconciles every mention of `totalBalance` / `availableBalance` / `heldBalance` / `lockedBalance` / `stacksBalance` / `overdraftBalance` / `overdraftLimit` / `technicalOverdraftBalance` / `homeCurrencyBalanceEquivalent` / max balance in the maps `accounts`, `transactions-holds`, `groups-stacks`, `utilities`, `de-dd-scheduled`, `bpay`, `payid-npp`.

Source labels: `[spec]` = `b2b-operations-api.json` (verified with jq), `[webhook-spec]` = `notification-webhooks.json` (jq), `[ext-auth-spec]` = `external-balance.yaml` (jq), `[docs:<slug>]` = `https://developer.shaype.com/<slug>.md`, `[map:<key>]` = a domain map, `[inferred]`, `[decision]` = recommended default for the local implementation, `[open]` = cannot be settled from the sources.

`payid-npp` contains no balance content: "No monetary balances, limits or counters live in this domain" [map:payid-npp]; PayID transfers reach balances only through `makeTransferV0/V1` (`transferType: PAY_ID`) and are covered by the transfer rows below.

---

## 0. Field inventory (what the API exposes)

### `HayAccount` balance fields [spec — descriptions verbatim]

| field | spec description | sign per spec |
|---|---|---|
| `totalBalance` | "Total value of all funds on the Account (this amount will also include unused overdraft limit and Stacks, held and locked value). Value to 2 decimal places." | signed |
| `availableBalance` | "Total balance available for use on Account. Funds that are held, locked and allocated to a Stack will not be available. Value to 2 decimal places." | signed |
| `heldBalance` | "Total value of all authorised but not yet cleared transactions for all Cards on Account. Positive value to 2 decimal places." | ≥ 0 |
| `lockedBalance` | "The value that has been locked and unavailable for use, typically as a result of an operations team action. Positive value to 2 decimal places." | ≥ 0 |
| `stacksBalance` | "Total value current held against any Stack(s) on the Account. Positive value to 2 decimal places." | ≥ 0 |
| `overdraftLimit` | "Total value of the overdraft limit applied to Account. Positive value to 2 decimal places." | ≥ 0 |
| `overdraftBalance` | "Total value of overdraft used where an overdraft limit exists on the Account. Positive value to 2 decimal places." | ≥ 0 |
| `technicalOverdraftBalance` | "Total value that is in a negative position beyond the total deposits / overdraft limit on the Account. Value to 2 decimal places." | unstated → **≥ 0 magnitude** [decision, see §1] |
| `homeCurrencyBalanceEquivalent` | `HomeCurrencyBalanceEquivalent` = `{ currency: ISO-4217 enum ("Home currency code"), totalBalance, availableBalance, heldBalance }` — "expressed in the client's home currency" | as the native fields |

### Other places the same quantities appear

| surface | shape | source |
|---|---|---|
| Webhook `TransactionEventDto.accountBalances` | `AccountBalancesDto { totalBalance, heldBalance, lockedBalance, stacksBalance, availableBalance }` each `CurrencyAmount` — **no overdraft fields** | [webhook-spec] jq-verified |
| Webhook `TransactionEventDto.updatedBalance` | `CurrencyAmount`, undescribed | [webhook-spec] |
| `FinancialTransaction.rollingAccountBalance` | number, "Total Account balance after the transaction posted to Account" | [spec] |
| `HayStack.balance` | number, "Total balance available for use on Stack" | [spec] |
| External-auth callback `Account.balance` | "Balance of the Account immediately before this transaction was applied. Money held in stacks is not included" | [ext-auth-spec] |
| docs `legacyAvailableBalance` in some `docs:payments` samples | not in `AccountBalancesDto` — do not emit | [map:accounts] |
| Limit API | `ExternalLimitAmounts { type, accountLimit, productLimit, effectiveLimit }`; `type` enum (16, jq-verified): `MAX_BALANCE, MIN_BALANCE, TOTAL_SPEND_PER_YEAR, ATM_WITHDRAWAL_PER_DAY, TOP_UP_PER_DAY, CARD_TOP_UP_PER_DAY, BPAY_TOP_UP_PER_DAY, BANK_TRANSFER_TOP_UP_PER_DAY, PAYMENT_TO_ACCOUNT_NUMBER, PAYMENT_TO_PAY_ID, CARD_PAYMENTS_DAILY, SINGLE_CARD_TRANSACTION, MIN_STACK_BALANCE, DIRECT_DEBIT_PER_DAY, OVERDRAFT_PRODUCT_LIMIT, BPAY_DAILY_LIMIT` | [spec] |
| `UpdateMaxBalanceLimitRequestBody.maxBalanceLimit` | number, `minimum 0, exclusiveMinimum true`, "cannot exceed maximum balance limit applied to the Product" | [spec] |
| `UpdateOverdraftLimitRequestBody.overdraftLimit` | number, no min/max, "cannot exceed overdraft limit applied to the Product. Positive value" | [spec] |
| `ClosureCheckerError.type` (8, jq-verified) | `ACCOUNT_BALANCE_TOTAL, ACCOUNT_BALANCE_STACKS, ACCOUNT_BALANCE_HELD, ACCOUNT_BALANCE_LOCKED, ACCOUNT_BALANCE_OVERDRAFT, ACCOUNT_BALANCE_TECHNICAL_OVERDRAFT, INFLIGHT_OUTBOUND_DIRECT_DEBITS, CHILD_ACCOUNT_STATUS` | [spec] |

Nothing in the B2B spec writes `lockedBalance` (operations-team action only) [spec; map:accounts]. No API field carries an overdraft expiry date although `docs:account-status` mentions one [map:accounts].

---

## 1. (a) ONE consistent set of formulas

### 1.1 The two source statements and why they cannot be used literally

`docs:account-balances` (verbatim):

> **Available Balance** = Account Balance + (Overdraft Limit + Overdraft Balance) + Technical Overdraft Balance + Held Balance + Stacks balance
> **Total Balance** = Total Available Balance + (Overdraft Limit + Overdraft Balance) + Technical Overdraft Balance + Stacks Balance

with value ranges: Account Balance "$0 or Positive"; Held Balance "$0 or Negative"; Overdraft Balance "$0 or Negative"; Technical Overdraft Balance "$0 or Negative"; Stack Balance "$0 or Positive"; Available / Total "$0 or Positive value, with exceptional of negative if a technical overdraft is applied".

Problems (agreed by every map that quotes it — [map:accounts §4], [map:transactions-holds §4.1], [map:groups-stacks §4], [map:utilities §4], [map:bpay "Payment validation formulas"]):
1. The docs use **signed** quantities (Held, Overdraft Balance, Technical Overdraft ≤ 0); the API returns them as **positive** magnitudes [spec `HayAccount`] and every webhook sample carries `heldBalance` positive (8.4, 9.5, 166.64, 3124.11, 4114.8) [docs:card-transactions; docs:payments].
2. "+ Stacks balance" in the Available formula contradicts the spec: "Funds that are held, locked and allocated to a Stack will not be available" [spec], and `docs:stack`: "No drawdown will occur from the various Stacks".
3. The Total formula is defined in terms of Available and re-adds the overdraft/technical-overdraft/stack terms already inside Available (double count) — [map:transactions-holds Q31] calls the two "cannot be reconciled".
4. `lockedBalance` is absent from both formulas although the spec puts it in both `totalBalance` ("held and locked value") and outside `availableBalance`.

### 1.2 Unified model [decision — inferred from spec descriptions, docs value ranges and all consistent webhook samples]

State kept per account (all magnitudes ≥ 0 except `ledger`):

| symbol | meaning | how it changes |
|---|---|---|
| `ledger` | net of all **settled** postings — cash actually on deposit (negative when overdrawn). Includes money earmarked in stacks. | credits `+`, settlements/debits `−` (§2) |
| `held` | Σ open **card** authorisation holds (`heldBalance`) | hold events (§2) |
| `locked` | ops-team lock (`lockedBalance`) | no API — constant 0 locally [decision] |
| `stacks` | Σ `HayStack.balance` over the account's stacks (`stacksBalance`) — CLOSED stacks are swept to 0 so summing OPEN stacks is equivalent [map:groups-stacks] | stack transfers / closeStack (§2) |
| `odLimit` | `overdraftLimit` | `updateOverdraftLimit` only |

Derived fields, in this order:

```
overdraftBalance          = max(0, min(-ledger, odLimit))                 -- overdraft actually drawn
technicalOverdraftBalance = max(0, -ledger - odLimit)                     -- overdrawn beyond the limit
totalBalance              = ledger + odLimit                              -- spec: total "will also include unused overdraft limit and Stacks, held and locked value"
availableBalance          = totalBalance - heldBalance - lockedBalance - stacksBalance
                                                                          -- spec: "held, locked and allocated to a Stack will not be available"
homeCurrencyBalanceEquivalent = { currency: HOME, totalBalance, availableBalance, heldBalance } × cachedRate(accountCurrency → HOME)
rollingAccountBalance (on the posted FinancialTransaction) = totalBalance after the posting
webhook updatedBalance    = availableBalance after the event
status ACTIVE_IN_ARREARS  ⇔ technicalOverdraftBalance > 0  (else ACTIVE once any posting has occurred)
```

Equivalent in the docs' own vocabulary (Account Balance `D = max(0, ledger)`, unused overdraft `U = odLimit − overdraftBalance`, technical overdraft `T`):
`totalBalance = D + U − T` and `availableBalance = D + U − T − held − locked − stacks`. That is the docs' Available formula with the docs' signs applied (Held, Overdraft Balance, Technical Overdraft negative), the "+ Stacks" read as "− Stacks" (per the spec sentence), and "− Locked" added; the docs' Total formula collapses to `Available + held + locked + stacks` (no re-added overdraft terms).

Why this and not the alternatives:
- It satisfies **every** webhook sample in the sources (all have overdraft 0, so `totalBalance = ledger`): `11.13 − 8.4 = 2.73`, `10.87 − 9.5 = 1.37`, `10.87 − 9 = 1.87`, `66049.69 − 3124.11 = 62925.58`, `5182.41 − 4114.8 = 1067.61`, `3144.69 − 0 = 3144.69`, `151087.66 − 0 = 151087.66` [docs:card-transactions; docs:payments; docs:direct-debits; docs:bpay].
- It satisfies the spec sentence that `totalBalance` includes the **unused** overdraft limit: ledger 100 / limit 50 → total 150; ledger −30 / limit 50 → drawn 30, total 20 (= unused), available 20; ledger −60 / limit 50 → drawn 50, technical 10, total −10 (the docs' "negative if a technical overdraft is applied") [inferred arithmetic].
- It is the model already written in [map:accounts §4] and is consistent with the "practical invariant" in [map:groups-stacks §4] (`availableBalance = totalBalance − stacksBalance − heldBalance − lockedBalance (± overdraft terms)` — the "± overdraft terms" are zero because the overdraft already sits inside `totalBalance`) and with [map:utilities §4] (`totalBalance = availableBalance + heldBalance + lockedBalance + stacksBalance`, the same identity rearranged). [map:transactions-holds Q31]'s double-counting objection applies to combining the *docs* formula with the spec sentence, not to this model; see §4 C1.

Sign conventions carried by the model [decision]:
- All `HayAccount` magnitudes are returned **positive** (spec), including `technicalOverdraftBalance` (spec is silent; docs say ≤ 0; positive keeps it parallel to `overdraftBalance` and to the `ClosureCheckerError` "must be zero" checks). [open — confirm with Shaype; map:accounts Q9 / map:transactions-holds Q28].
- Webhook and `FinancialTransaction.currencyAmount.amount` is **signed**: negative for debits/holds/settlements (−8.40, −20.00, −457.12), positive for credits/refunds/hold releases (+5.99, +0.50, +2000.00) [docs samples; ext-auth-spec `CurrencyAmount`: "Positive when crediting customer account and negative when debiting"]. Request `amount` on create-credit/debit/transfer/BPAY is a positive magnitude, the endpoint fixes the direction [map:transactions-holds §4.3, inferred]; card mock `amount` must be `< 0` and DE/NPP mock `amount` `> 0` [spec `exclusiveMaximum 0` / `exclusiveMinimum 0`; map:utilities §4].
- Hold-update webhooks report the **cumulative** hold on increase (−19.00 for a 9→19 hold) and the **positive delta** on decrease (+0.5000) [docs:card-transactions §2–3; map:utilities].

### 1.3 Derived quantities used by limit checks [decision]

| quantity | formula | used by |
|---|---|---|
| `depositsForMaxBalance` | `ledger` (includes stack money; excludes the unused overdraft limit) — "Any funds that reside in a Stack will form part of the total account's max balance limit" [docs:stack]; comparing `totalBalance` would let an unused overdraft limit consume `MAX_BALANCE` headroom, which no source suggests [inferred; open] | `MAX_BALANCE` |
| `spendable` | `availableBalance` (so overdraft funds are spendable: "which would include both cash deposits and overdraft funds" [docs:account-balances]) | insufficient-funds check on every debit, hold, stack transfer-in, BPAY, transfer |
| ext-auth `account.balance` | `totalBalance − stacksBalance` — the only exclusion the spec names is stacks ("Money held in stacks is not included") [ext-auth-spec]; [map:groups-stacks §5] and [map:accounts §4] read it the same way | external-authorisation callbacks (out of scope of the seven maps) |
| aggregate for multi-currency limits | Σ over the parent + FX-child hierarchy of the quantity converted to the home currency at the **margin-free cached rate**; applies to `MAX_BALANCE` and the "Aggregated? = Yes" daily/single limits, not to `MIN_BALANCE`, `MIN_STACK_BALANCE`, `DIRECT_DEBIT_PER_DAY`, `BPAY_PER_DAY` [docs:page/limits-1] | limit checks on FX wallets |
| `homeCurrencyBalanceEquivalent` | same cached rate; populated on **every** account (equal to native on a home-currency account) [decision; map:accounts Q25 open] | `getHayAccount` etc. |

### 1.4 Closure checks (jq-verified `ClosureCheckerError.type`) [decision on the exact predicates]

| type | predicate that must hold to close | source |
|---|---|---|
| `ACCOUNT_BALANCE_TOTAL` | `ledger == 0` (i.e. `totalBalance − overdraftLimit == 0`) — docs: "only appropriate to close an account when no negative or positive balances are held"; sample message "Account has 17.78 total balance." | docs:account-closure; predicate on `ledger` rather than `totalBalance` is [decision] so that an unused overdraft limit does not block closure (`ACCOUNT_BALANCE_OVERDRAFT` covers the drawn part) |
| `ACCOUNT_BALANCE_HELD` | `heldBalance == 0` — "Account has 17.78 held balance." | docs:account-closure |
| `ACCOUNT_BALANCE_STACKS` | `stacksBalance == 0` | spec enum; [map:groups-stacks §5] |
| `ACCOUNT_BALANCE_LOCKED` | `lockedBalance == 0` | spec enum |
| `ACCOUNT_BALANCE_OVERDRAFT` | `overdraftBalance == 0` | spec enum |
| `ACCOUNT_BALANCE_TECHNICAL_OVERDRAFT` | `technicalOverdraftBalance == 0` | spec enum |
| `INFLIGHT_OUTBOUND_DIRECT_DEBITS` | no `createDirectDebit` request in a non-terminal status (`RECEIVED/ACCEPTED/SUBMITTED`) | spec enum; docs:account-closure; [map:de-dd-scheduled] |
| `CHILD_ACCOUNT_STATUS` | every FX child already `CLOSED` [inferred] | spec enum; [map:accounts Q25 open] |

---

## 2. (b) Balance movements per operation / mock generator

Column key — **fields moved** names the stored quantity (`ledger`, `held`, `stacks`, `odLimit`, stack `balance`) and the visible `HayAccount` fields that change as a result; `a` = request amount magnitude; `h` = current (updated) hold amount at settlement. `total`/`avail`/`held` abbreviate `totalBalance`/`availableBalance`/`heldBalance`. **when** = the lifecycle point at which the movement is applied. Every row that emits a `TRANSACTION` webhook carries `accountBalances` = the post-event values and `updatedBalance` = post-event `availableBalance` [decision, §1.2].

### 2.1 B2B API operations

| operation (operationId) | balance fields moved | direction | when | source |
|---|---|---|---|---|
| `createCreditTransactionV0/V1` (`GENERAL_CREDIT`) | `ledger +a` → `total +a`, `avail +a`; `held` unchanged | credit | **settlement** — posted immediately, `isPending: false`, `clearingTimeUtc = now` | [map:transactions-holds §4.2, inferred]; `FinancialTransaction.type` enum has `GENERAL_CREDIT` [spec] |
| `createDebitTransactionV0/V1` (`GENERAL_DEBIT`) | `ledger −a` → `total −a`, `avail −a` | debit | settlement — immediate | [map:transactions-holds §4.2, inferred] |
| `makeTransferV0/V1`, `transferType: INTERNAL` (or `ACCOUNT` resolved to a Shaype BSB) | sender `ledger −a` (`total −a`, `avail −a`); recipient `ledger +a` (`total +a`, `avail +a`) | debit sender / credit recipient | settlement — immediate, both legs atomic; webhooks `INTRABANK_TRANSFER_OUT` + `INTRABANK_TRANSFER_IN` | [map:accounts makeTransferV1 "Balance effects on ACCEPTED", inferred]; docs:payments sample `+2000.00 → total 3144.69` |
| `makeTransferV0/V1`, `ACCOUNT` (NPP/DE) or `PAY_ID` | sender `ledger −a` (`total −a`, `avail −a`) | debit | settlement — immediate on `ACCEPTED`; webhook `INTERBANK_TRANSFER_OUT`, `isPending: false` | [map:accounts]; docs:payments sample `−0.01 → 9568.52` |
| Return / reversal of an outbound `INTERBANK_TRANSFER_OUT` | sender `ledger +a` (`total +a`, `avail +a`) | credit (reversal) | **reversal** — asynchronous, when the receiving bank returns the payment; webhook carries `returnReason`; `FinancialTransaction.type` `INTERBANK_TRANSFER_OUT_REVERSAL` exists [spec jq]; the webhook `transactionType` value of the same name is marked "NOT CURRENTLY IN USE" [webhook-spec] and the docs:payments reversal sample uses `transactionType: INTERBANK_TRANSFER_OUT` with a **positive** `+212.38` | [map:accounts "Reversal webhooks include returnReason"]; [decision] emit `INTERBANK_TRANSFER_OUT` with positive amount + `returnReason`, as the docs sample does |
| `makeBpayPayment` (`BPAY_TRANSFER_OUT`) | `ledger −a` (`total −a`, `avail −a`); no hold | debit | settlement — immediate on `ACCEPTED`; webhook `isPending: false`, `currencyAmount −20.00` | [map:bpay item 8]; docs:bpay sample `updatedBalance = total = avail = 151087.66` |
| BPAY post-acceptance gateway rejection (Cuscal result file, codes 100–199) | `ledger +a` (reversing credit) | credit (reversal) | reversal — asynchronous after the 1 PM / 5 PM submission window | [map:bpay Q15 open]; [decision] emit a `TRANSACTION` webhook with `outcome: REFUSED_BPAY_REJECTED` and reverse the debit; no source specifies the mechanism |
| `createDirectDebitV0/V1` (outbound DD = Shaype pulls from an external account) | **none at creation**; at `COMPLETE`: sender (Shaype) account `ledger +a` (`total +a`, `avail +a`) | credit | settlement — "After two working days the requested customer account is credited" → `COMPLETE`; `RETURNED` before crediting → no movement; return after crediting → manual case (no reversal status defined) | [map:de-dd-scheduled 4.3 / status table]; docs:direct-debits |
| Scheduled payment occurrence (`originType: SCHEDULED_PAYMENT`) | as `makeTransfer` (ACCOUNT recipient) or `makeBpayPayment` (BPAY recipient) on the account | debit | settlement — at each scheduled execution; refused occurrences move nothing | [map:de-dd-scheduled 4.5, inferred] |
| `accountToStackTransfer` (`transfer-in`) | `stacks +a`, stack `balance +a` → `avail −a`, `stacksBalance +a`; `total` **unchanged**; `ledger` unchanged | earmark (account → stack) | settlement — immediate; creates `HayStackTransaction` `type: STANDARD` (enum `STANDARD, ROUND_UP` [spec jq]); no `TRANSACTION` webhook, no `FinancialTransaction` | [map:groups-stacks]; docs:stack |
| `stackToAccountTransfer` (`transfer-out`) | `stacks −a`, stack `balance −a` → `avail +a`, `stacksBalance −a`; `total` unchanged | release (stack → account) | settlement — immediate | [map:groups-stacks] |
| `stackToStackTransfer` | account fields **unchanged** (`stacksBalance`, `avail`, `total`); source stack `balance −a`, destination `balance +a`; two `HayStackTransaction`s linked by `counterpartTransactionId` | internal to stacks | settlement — immediate | [map:groups-stacks] |
| `closeStack` | `stacks −b`, stack `balance → 0` → `avail +b`, `stacksBalance −b`; `total` unchanged (`b` = stack balance) | release | at close; "If the stack holds any balance, the funds will be transferred to the account's main balance" | docs:stack; [map:groups-stacks] |
| `updateOverdraftLimit` | `odLimit := new` → `total` and `avail` shift by `(new − old)`; `overdraftBalance`, `technicalOverdraftBalance` recomputed; status → `ACTIVE_IN_ARREARS` if `technicalOverdraftBalance > 0`, back to `ACTIVE` when it returns to 0 | limit change (no posting) | immediate | [map:accounts updateOverdraftLimit]; docs:account-status; docs:account-balances ("would include both cash deposits and overdraft funds") |
| `updateMaxBalanceLimit`, `setAccountLimit`, `deleteAccountLimit`, `changeAccountRiskLevel` | **no balance field moves** — only `ExternalLimitAmounts.accountLimit` / effective limits / risk level | — | — | [map:accounts] |
| `executeConversion` (FX, `CONVERSION_OUT` / `CONVERSION_IN`) | parent/child `ledger` −sell / +buy amounts | debit one currency account, credit the other | settlement — immediate on `ACCEPTED` | webhook `transactionType` enum has `CONVERSION_IN`, `CONVERSION_OUT` [webhook-spec jq]; outside the seven maps — listed for completeness only |
| PayID register / update / deregister, `getPendingHolds`, `getHayAccount`, search, liquidity reads | none (read-only or no monetary effect) | — | — | [map:payid-npp]; [map:accounts] |

### 2.2 Utilities (staging mock generators) — [docs:simulates-card-transaction-on-staging], [docs:card-transactions "Balance Update"], [map:utilities §4], [map:transactions-holds §4.2]

| mock generator (operationId) | balance fields moved | direction | when | source |
|---|---|---|---|---|
| `generateAtmTransaction` | `ledger −abs(a)` → `total −abs(a)`, `avail −abs(a)`; `held` unchanged (no hold step) | debit | settlement — "treated as already settled", single `CARD_TRANSACTION` webhook `isPending: false`, `cardUsageDetails.isAtmWithdrawal: true` | [map:utilities]; [map:transactions-holds "ATM stand-in"] |
| `generateAuthHold` | `held +abs(a)` → `heldBalance +abs(a)`, `avail −abs(a)`; **`total` unchanged**; `ledger` unchanged | hold | **hold** — immediate; stays pending indefinitely (no settlement) | docs:card-transactions §1 sample (total 11.13 / held 8.4 / avail 2.73 after a −8.40 hold); [map:utilities] |
| `generateCardTransaction` (hold + settlement) | step 1 as `generateAuthHold`; step 2 after `settlementDelayInSeconds` (5–300): `held −h`, `ledger −h` → `heldBalance −h`, `total −h`, `avail` **unchanged** | hold then debit | hold, then **settlement**; webhooks `CARD_TRANSACTION isPending:true` then `CARD_TRANSACTION_SETTLED isPending:false` with new `transactionHayId`, `holdHayId` = hold | docs:card-transactions §1 (11.13/8.4/2.73 → 2.73/0/2.73); [map:utilities]; [map:transactions-holds] |
| `generateHoldAndUpdateHoldTransactions` — increase (`updateHoldAmount < 0`) | `held +abs(u)` → `heldBalance +abs(u)`, `avail −abs(u)`; `total` unchanged (docs §2 sample shows total 232.64 → 241.64, treated as unreliable by both [map:utilities Q12] and [map:transactions-holds]) | hold increment | hold (incremental authorisation, re-runs all checks for the increment); webhook `CARD_TRANSACTION isPending:true`, cumulative amount, same `transactionHayId` | [map:utilities]; [map:transactions-holds] |
| — decrease / partial or full reversal (`updateHoldAmount > 0`) | `held −u` → `heldBalance −u`, `avail +u`; `total` unchanged | hold release | **reversal** of held funds (not a posting); webhook `CARD_TRANSACTION_REFUND isPending:true`, positive delta, same `transactionHayId` | docs:card-transactions §3 (10.87/9.5/1.37 → 10.87/9/1.87 after +0.50) |
| — settlement after `settlementDelayInSeconds` | `held −h`, `ledger −h` where `h` = original + increases − decreases → `heldBalance −h`, `total −h`, `avail` unchanged | debit | settlement (of the **updated** hold: −19.00 after 9→19; −4.50 after 5−0.50) | [map:utilities "Settlement amount"]; [map:transactions-holds] (its §4.2 row generalises to a settled amount `s ≠ h`: `total −s`, `held −h`, `avail −s + h` — [decision] mock always settles `s = h`) |
| `generateRefundTransaction` | `ledger +abs(a)` → `total +abs(a)`, `avail +abs(a)`; `held` unchanged; not linked to a prior purchase | credit | **refund** — settled inline, `CARD_TRANSACTION_REFUND isPending:false`, own `transactionHayId`, no `holdHayId` | docs:card-transactions §4 (total 5.99 / avail 5.99 after +5.99); [map:utilities] |
| `generateInboundDeTransaction` `recordType: DIRECT, transactionType: CREDIT` | recipient (`recipientBsb`/`recipientAccountNumber`) `ledger +a` → `total +a`, `avail +a` | credit | settlement — immediate; webhook `INTERBANK_TRANSFER_IN` | [map:utilities, inferred]; docs:direct-debits sample (+200.00 → 66049.69 / held 3124.11 / avail 62925.58) |
| — `DIRECT` + `DEBIT` (inbound direct debit pulling from the Shaype account) | `ledger −a` → `total −a`, `avail −a` | debit | settlement — immediate; webhook `DIRECT_DEBIT_TRANSFER` | [map:utilities]; docs:direct-debits sample (−457.12 → 3197.26) |
| — `RETURN` (external bank returns a prior outbound DD) | if the matched outbound DD was already credited: `ledger −a` (reversal); if still in flight: none, status → `RETURNED` | reversal | reversal | [map:utilities Q13 open — matching rule unstated]; [decision] match by amount + sender BSB/account to the most recent non-terminal or COMPLETE DD |
| — `REFUSAL` | none documented | — | — | [map:utilities, open] |
| `generateInboundNppTransaction` (v1) / `generateInboundNppTransactionV2` | receiver `ledger +a` → `total +a`, `avail +a` | credit | settlement — immediate; `INTERBANK_TRANSFER_IN`; v2 with `paymentReturnInformation.returnReasonCode` set = reversal of a prior outbound (which one is [open]) | [map:utilities] |
| `generateReceiveAPaymentInstruction` (PayTo RAP) / RAPAIN | debtor `ledger −instructedAmount` → `total`, `avail` down | debit | settlement — immediate on `ACCP` | [map:utilities §4 "PayTo staging ad-hoc flow ordering"] |

### 2.3 Movement summary by lifecycle point [decision — the rule set the local ledger implements]

| lifecycle point | `ledger` | `held` | `total` | `avail` | applies to |
|---|---|---|---|---|---|
| **hold** (auth / increment) | — | `+x` | — | `−x` | card mocks only (`heldBalance` is card-only per spec) |
| **hold reversal / decrease** | — | `−x` | — | `+x` | hold update, full cancel |
| **settlement of a hold** (`h`) | `−h` | `−h` | `−h` | — | card hold+settle; hold+update; (partial settlement `s ≠ h` not producible by any mock — [open]) |
| **settlement without hold** (credit) | `+x` | — | `+x` | `+x` | general credit, transfer-in, inbound DE/NPP, refund, DD `COMPLETE`, reward |
| **settlement without hold** (debit) | `−x` | — | `−x` | `−x` | general debit, transfer-out, BPAY, ATM, inbound DD, PayTo RAP |
| **reversal / return** of a settled item | opposite sign of the original | — | opposite | opposite | outbound transfer returned, BPAY gateway reject, DE `RETURN` after credit |
| **refund** | `+x` | — | `+x` | `+x` | card refund (independent transaction) |
| **stack earmark / release** | — | — | — | `∓x` (with `stacks ±x`) | stack transfers, closeStack |
| **overdraft limit change** | — | — | `+(new−old)` | `+(new−old)` | `updateOverdraftLimit` |

Non-card `AuthorisationHold.type` values (`INTRABANK_TRANSFER_IN/OUT`, `INTERBANK_TRANSFER_IN/OUT`, `DIRECT_DEBIT_TRANSFER`, `GENERAL_CREDIT/DEBIT`, `BPAY_TRANSFER_OUT/IN`, … — enum jq-verified, identical to `FinancialTransaction.type`) exist in the schema, but `heldBalance` is defined as card-only and every payment map posts immediately (`isPending: false`); [decision] the local implementation never creates non-card holds ([map:bpay item 8] asks the same question).

---

## 3. (c) Limit checks and the outcome codes they produce

### 3.1 The outcome enums (jq-verified, verbatim order)

| schema | values |
|---|---|
| `TransactionOutcome.outcome` (21) — `makeTransferV0/V1`, `createCredit/DebitTransactionV0/V1` [spec] | `ACCEPTED, INTERNAL_ERROR, REFUSED_LIMIT_BREACH, REFUSED_FRAUD, REFUSED_CUSTOMER_PREFERENCE, REFUSED_INSUFFICIENT_FUNDS, REFUSED_ACCOUNT_BLOCKED, REFUSED_RECIPIENT_ACCOUNT_BLOCKED, REFUSED_ACCOUNT_CLOSED, REFUSED_RECIPIENT_ACCOUNT_CLOSED, REFUSED_INVALID_PAY_ID, UNKNOWN, REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED, REFUSED_MAX_BALANCE_EXCEEDED, REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED, REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED, REFUSED_TOTAL_NET_VISA_DAILY_LIMIT_BREACHED, REFUSED_TOTAL_NON_SCHEME_DAILY_LIMIT_BREACHED, REFUSED_SENDER_ACCOUNT_NOT_VERIFIED, REFUSED_CAPABILITY_NOT_ENABLED, REFUSED_QUOTE_EXPIRED` |
| `ConversionExecuteResponse.outcome` (21) [spec] | identical to `TransactionOutcome.outcome` |
| `BpayPaymentResponseBody.outcome` (14) — `makeBpayPayment` [spec] | `ACCEPTED, INVALID_PAYMENT, REFUSED_INSUFFICIENT_FUNDS, INTERNAL_ERROR, REFUSED_DAILY_BPAY_LIMIT_BREACHED, REFUSED_BPAY_INVALID_BILLER_CODE, REFUSED_BPAY_INVALID_REFERENCE, REFUSED_BPAY_INVALID_PAYMENT, REFUSED_BPAY_REJECTED, REFUSED_ACCOUNT_BLOCKED, REFUSED_RECIPIENT_ACCOUNT_BLOCKED, REFUSED_ACCOUNT_CLOSED, REFUSED_RECIPIENT_ACCOUNT_CLOSED, REFUSED_CAPABILITY_NOT_ENABLED` |
| `StackTransactionResponse.outcome` = `StackToStackTransactionOutcome.outcome` (4) [spec] | `ACCEPTED, INTERNAL_ERROR, REFUSED_INSUFFICIENT_FUNDS, UNKNOWN` |
| `TransactionEventDto.outcome` (41) — every `TRANSACTION` webhook [webhook-spec] | `ACCEPTED, REFUSED_CARD_PREFERENCE, REFUSED_ACCOUNT_PREFERENCE, REFUSED_FRAUD, REFUSED_AML, REFUSED_MAX_BALANCE_EXCEEDED, REFUSED_NOT_ENOUGH_FUNDS, REFUSED_DAILY_LIMIT_EXCEEDED, INTERNAL_ERROR, REFUSED_ACCOUNT_NOT_FOUND_FOR_CARD_TOKEN, REFUSED_UNDETERMINED_BALANCE_FOR_ACCOUNT, REFUSED_ACCOUNT_NOT_FOUND_FOR_CURRENCY, REFUSED_UNDETERMINED_SPENDING_FOR_ACCOUNT, REFUSED_UNDETERMINED_TOP_UPS_FOR_ACCOUNT, REFUSED_UNDETERMINED_ATM_WITHDRAWALS_FOR_ACCOUNT, REFUSED_ANNUAL_SPENDING_LIMIT_BREACHED, REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED, REFUSED_DAILY_TOP_UP_LIMIT_BREACHED, REFUSED_ACCOUNT_BLOCKED, REFUSED_ACCOUNT_CLOSED, REFUSED_RECIPIENT_ACCOUNT_BLOCKED, REFUSED_RECIPIENT_ACCOUNT_CLOSED, REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED, REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED, REFUSED_RULES, REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED, REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED, REFUSED_TOTAL_NET_VISA_DAILY_LIMIT_BREACHED, REFUSED_TOTAL_NON_SCHEME_DAILY_LIMIT_BREACHED, REFUSED_BPAY_INVALID_BILLER_CODE, REFUSED_BPAY_INVALID_REFERENCE, REFUSED_BPAY_INVALID_PAYMENT, REFUSED_BPAY_REJECTED, REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED, REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED, REFUSED_SANCTIONS, REFUSED_UNABLE_TO_VALIDATE, REFUSED_INSUFFICIENT_DATA, REFUSED_SENDER_ACCOUNT_NOT_VERIFIED, REFUSED_CAPABILITY_NOT_ENABLED, REFUSED_QUOTE_EXPIRED` |
| ext-auth `Response.errorCode` (3) — client's HTTP 470 [ext-auth-spec] | `REFUSED_MAX_BALANCE_EXCEEDED, REFUSED_NOT_ENOUGH_FUNDS, REFUSED_SENDER_ACCOUNT_NOT_VERIFIED` |
| `LiquidityThreshold.type` (4) [spec] | `TOTAL_DAILY_INBOUND_DIRECT_DEBIT, TOTAL_DAILY_NET_NON_SCHEME, TOTAL_DAILY_NET_VISA, TOTAL_DAILY_OUTBOUND_BPAY` |

Facts that shape the mapping:
- Refusals are **HTTP 200 + `outcome`**, never 4xx [spec schema shape; map:accounts, map:transactions-holds, map:bpay, map:groups-stacks all agree].
- v0 credit/debit: "If a limit is breached, REFUSED_LIMIT_BREACH outcome will be returned. To get the detailed limit that has been breached please use V1 of this endpoint. That will return one of the below outcomes instead of REFUSED_LIMIT_BREACH: REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED, REFUSED_MAX_BALANCE_EXCEEDED." [spec `createCreditTransactionV0.description`, jq-verified].
- The sync enums and the webhook enum name the funds check differently: `REFUSED_INSUFFICIENT_FUNDS` (sync, all three schemas) vs `REFUSED_NOT_ENOUGH_FUNDS` (webhook, docs) [spec, webhook-spec]. Likewise BPAY daily: `REFUSED_DAILY_BPAY_LIMIT_BREACHED` (BPAY sync) vs `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED` (`TransactionOutcome`, webhook, docs) [map:bpay Q2].
- `docs:account-limits` shows a breach as `"outcome": "LIMIT_BREACH", "detailedOutcome": "REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED"` — neither `LIMIT_BREACH` nor `detailedOutcome` exists in any spec schema [spec jq]; [decision] ignore that shape.
- Values docs list as "not currently in use" (never emit): `REFUSED_ACCOUNT_PREFERENCE, REFUSED_DAILY_LIMIT_EXCEEDED, REFUSED_AML, REFUSED_ACCOUNT_NOT_FOUND_FOR_CARD_TOKEN, REFUSED_UNDETERMINED_BALANCE_FOR_ACCOUNT, REFUSED_ACCOUNT_NOT_FOUND_FOR_CURRENCY, REFUSED_UNDETERMINED_SPENDING_FOR_ACCOUNT, REFUSED_UNDETERMINED_TOP_UPS_FOR_ACCOUNT, REFUSED_UNDETERMINED_ATM_WITHDRAWALS_FOR_ACCOUNT` [docs:payment-transaction-outcome].
- Webhook for a refusal: `docs:page/limits-1` shows a refused inbound credit producing a `transactionEvent.outcome: REFUSED_MAX_BALANCE_EXCEEDED` webhook; [map:bpay Q3] notes three BPAY sync outcomes have no webhook counterpart. [decision] emit a `TRANSACTION` webhook for a refusal only when the outcome exists in the webhook enum (map sync→webhook per the table); otherwise none.

### 3.2 Check → outcome table

Order of evaluation [decision, following docs:external-authorisation-and-balance "Platform Limit Checks … will reject the transaction without performing a balance check"]: (1) schema → 400/422; (2) account status; (3) capability / rails; (4) rules & card preferences; (5) limits (per-transaction, daily rolling 24 h, annual, max balance); (6) funds; (7) fraud (never triggered locally). `effectiveLimit = accountLimit ?? productLimit`; daily window = **rolling 24 h** including the current transaction [docs:account-limits]; risk level `HIGH` ⇒ every limit reads 0 [docs:account-limits].

| # | check | applies to (debit/credit direction) | condition (refuse when) | sync outcome (schema) | webhook outcome | source / notes |
|---|---|---|---|---|---|---|
| S1 | account `LOCKED` | every movement on the account, both directions; stack ops too | `status == LOCKED` | `REFUSED_ACCOUNT_BLOCKED` (TransactionOutcome, Bpay); stack ops have no status value in their enum → [decision] HTTP 422 `ErrorResponse` | `REFUSED_ACCOUNT_BLOCKED` | docs:account-status "will block all transactions and transfers"; [map:accounts]; [map:bpay]; [map:groups-stacks "account status gating"] |
| S2 | account `CLOSED` | as S1 | `status == CLOSED` | `REFUSED_ACCOUNT_CLOSED` | `REFUSED_ACCOUNT_CLOSED` | docs:payment-transaction-outcome |
| S3 | INTERNAL recipient `LOCKED` / `CLOSED` | transfer credit leg | recipient status | `REFUSED_RECIPIENT_ACCOUNT_BLOCKED` / `_CLOSED` | same | docs: "This occurs when transferring funds between Shaype accounts" — [decision] never emitted by BPAY although present in its enum [map:bpay] |
| S4 | FX child on a domestic rail | `makeTransfer` non-INTERNAL from a child; BPAY / DD / PayID on a child | account has `parentAccountId` | `REFUSED_CAPABILITY_NOT_ENABLED` [inferred] | same | docs:multi-currency…; [map:accounts] |
| F1 | **insufficient funds** (`MIN_BALANCE` floor) | every debit: general debit, transfer-out, BPAY, ATM, card hold / increment, inbound DD, PayTo RAP, DD `DEBIT` mock; stack transfer-in | `spendable < a` where `spendable = availableBalance` (§1.3) — stacks never draw down [docs:stack]; overdraft funds do count; `MIN_BALANCE` (Shaype-only, default 0) is the floor on `ledger + odLimit` ⇒ same test | `REFUSED_INSUFFICIENT_FUNDS` (TransactionOutcome, Bpay, Stack) | `REFUSED_NOT_ENOUGH_FUNDS` — docs: "would exceed the account's maximum balance MIN_BALANCE limit" (sic) | [map:transactions-holds], [map:accounts], [map:bpay item 4], [map:groups-stacks], [map:utilities §4] — all four choose the sync name by enum membership and the webhook name by docs |
| F2 | stack has too little | `stackToAccountTransfer`, `stackToStackTransfer` | stack `balance < a` (`MIN_STACK_BALANCE` enforcement point [open]) | `REFUSED_INSUFFICIENT_FUNDS` | none (no webhook for stack ops) | [map:groups-stacks] |
| L1 | **`MAX_BALANCE`** | every credit: general credit, transfer-in (INTERNAL recipient), inbound DE/NPP, refund, DD `COMPLETE`, reward, conversion-in | `depositsForMaxBalance + a > effectiveLimit(MAX_BALANCE)` aggregated across the FX hierarchy at the cached margin-free rate; stack money counts | v1: `REFUSED_MAX_BALANCE_EXCEEDED`; v0 credit/transfer: `REFUSED_LIMIT_BREACH` | `REFUSED_MAX_BALANCE_EXCEEDED` | docs:payment-transaction-outcome; docs:page/limits-1 (AUD 150 credit onto aggregate 500 with limit 600 → refused); docs:stack; [map:accounts], [map:transactions-holds], [map:de-dd-scheduled 4.6], [map:utilities] |
| L2 | **daily transfers out** | outbound cash transfers: `INTRABANK_TRANSFER_OUT`, `INTERBANK_TRANSFER_OUT` (ACCOUNT / PAY_ID), `GENERAL_DEBIT` (the v0/v1 debit endpoints name this outcome), scheduled ACCOUNT payments; **not** BPAY (own limit), not card, not stack moves ("Available Balance to Stack or Stack to Stack" exempt) | `Σ(matching debits, last 24 h) + a > limit` | v1: `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED`; v0: `REFUSED_LIMIT_BREACH` | `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED` | docs:payment-transaction-outcome "daily limit for outgoing transfers"; **no `TRANSFERS_OUT_PER_DAY` in the spec limit-type enum** although docs:page/limits-1 lists it as aggregated — [decision] hidden product-level limit, not settable/readable via `ExternalLimitAmounts` [map:accounts Q14 open] |
| L3 | `PAYMENT_TO_ACCOUNT_NUMBER` (per-transfer max) | `makeTransfer` ACCOUNT/INTERNAL/PAY_ID, scheduled ACCOUNT payments | `a > effectiveLimit` | `REFUSED_LIMIT_BREACH` [inferred — no dedicated value] | no dedicated value → no webhook [decision] | spec: "Maximum value of individual outgoing cash transfer"; [map:accounts]; ext-auth doc lists it among platform pre-checks |
| L4 | `TOTAL_SPEND_PER_YEAR` | every outbound transfer/payment (transfers, BPAY, card?) — spec: "Maximum value of outgoing transfers / payments on Account in a year" | `Σ(outbound, trailing 365 d) + a > limit` [window inferred] | `REFUSED_LIMIT_BREACH` [inferred] | `REFUSED_ANNUAL_SPENDING_LIMIT_BREACHED` (webhook-only) | docs:payment-transaction-outcome; [map:transactions-holds]; [map:de-dd-scheduled 4.6] |
| L5 | `BPAY_DAILY_LIMIT` | `makeBpayPayment`, scheduled BPAY | `Σ(BPAY_TRANSFER_OUT, 24 h) + a > limit` — docs: "$100 limit, $101 payment → rejected" | `REFUSED_DAILY_BPAY_LIMIT_BREACHED` (Bpay schema — the only schema-valid value on that endpoint) | `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED` — docs: "total daily BPAY_DAILY_LIMIT limit for outbound BPAY transactions" | docs:bpay; docs:account-limits; [map:bpay Q2 — decision matches its suggestion] |
| L6 | `DIRECT_DEBIT_PER_DAY` | **inbound** direct debits that debit the account (`DIRECT_DEBIT_TRANSFER`, DE `DEBIT` mock, PayTo RAPAIN?) per docs: "outgoing cash from inbound direct debit requests"; spec says "outgoing direct debit transfers" — [decision] follow the docs; `createDirectDebit` (a credit to the account) is not checked [map:de-dd-scheduled Q10 open] | `Σ(DD debits, 24 h) + a > limit` | n/a (no sync endpoint returns a DD-debit outcome) | `REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED` (webhook-only) | docs:payment-transaction-outcome; [map:de-dd-scheduled 4.6]; [map:utilities DE DEBIT] |
| L7 | `TOP_UP_PER_DAY` / `BANK_TRANSFER_TOP_UP_PER_DAY` ("Maximum value of inbound cash transfers") | inbound credits: inbound DE/NPP, INTERNAL transfer-in, general credit [inferred set] | `Σ(inbound credits, 24 h) + a > limit` | v0: `REFUSED_LIMIT_BREACH`; v1 credit: no dedicated value → `REFUSED_LIMIT_BREACH` [decision; map:transactions-holds Q23] | `REFUSED_DAILY_TOP_UP_LIMIT_BREACHED` (webhook-only) | docs:payment-transaction-outcome; [map:utilities NPP inbound] — which of the two types governs which rail is [open]; `CARD_TOP_UP_PER_DAY`, `BPAY_TOP_UP_PER_DAY`, `PAYMENT_TO_PAY_ID` are "Not currently used" [spec, docs] |
| L8 | `ATM_WITHDRAWAL_PER_DAY` | `generateAtmTransaction` | `Σ(ATM, 24 h) + a > limit` (docs example: $900 then $101 against $1000 → refused) | n/a (mock returns `GenericMessage`) | `REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED` | docs:account-limits; [map:utilities] |
| L9 | `CARD_PAYMENTS_DAILY` | all card mocks (hold, increment, ATM) | `Σ(card, 24 h) + a > limit` | n/a | `REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED` | docs:payment-transaction-outcome |
| L10 | `SINGLE_CARD_TRANSACTION` | card mocks (per-transaction; on increment the **incremental** amount [map:utilities]) | `a > limit` | n/a | `REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED` | docs:payment-transaction-outcome |
| L11 | client liquidity totals `TOTAL_DAILY_INBOUND_DIRECT_DEBIT` / `TOTAL_DAILY_OUTBOUND_BPAY` / `TOTAL_DAILY_NET_VISA` / `TOTAL_DAILY_NET_NON_SCHEME` | client-wide daily aggregates | thresholds only **alert by email** at 50/75/90 % — "do not refuse transactions" [map:bpay]; the matching `REFUSED_TOTAL_*_DAILY_LIMIT_BREACHED` outcomes exist in both enums | `REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_NET_VISA_DAILY_LIMIT_BREACHED` ("client scheme transactions are currently blocked"), `REFUSED_TOTAL_NON_SCHEME_DAILY_LIMIT_BREACHED` | same | docs:liquidity-monitoring-and-alerting-1; docs:payment-transaction-outcome; [map:transactions-holds Q30] — [decision] never emitted locally unless a client-level hard cap is configured |
| L12 | risk level `HIGH` | all inbound and outbound | every limit = 0 ⇒ first limit check fails | sync: the outcome of the first failing limit (`REFUSED_MAX_BALANCE_EXCEEDED` for credits, `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED` / `REFUSED_LIMIT_BREACH` for debits) [decision; map:accounts Q23] | corresponding | docs:account-limits: "HIGH risk level set all limits to 0 … prevent all outbound and inbound transactions"; `RiskLevelResponse.riskLevel` values `LOW`/`HIGH` by description [spec] |
| R1 | account rules (`MERCHANT_CODE_BLOCK` etc.) | card mocks | rule matches merchant | n/a | `REFUSED_RULES` (+ `ruleDetails.ruleId`) | docs:payment-transaction-outcome; [map:accounts] |
| R2 | card preferences | card mocks | preference disallows | n/a | `REFUSED_CARD_PREFERENCE` (+ `cardPreferenceOutcome`) | [map:transactions-holds] |
| R3 | `REFUSED_CUSTOMER_PREFERENCE` | in `TransactionOutcome` only; no doc defines a trigger | — | never emitted [decision] | not in webhook enum | [map:transactions-holds open] |
| X1 | ext-auth client refuses (HTTP 470) | clients holding balances externally | `errorCode` | `REFUSED_NOT_ENOUGH_FUNDS` → `REFUSED_INSUFFICIENT_FUNDS`; `REFUSED_MAX_BALANCE_EXCEEDED` → same; `REFUSED_SENDER_ACCOUNT_NOT_VERIFIED` or anything else / 10 s timeout → `INTERNAL_ERROR` ("only the following two error codes are supported") | webhook-enum equivalents; `accountBalances`/`updatedBalance` **not populated** for such clients | docs:external-authorisation-and-balance; [map:bpay item 11]; [map:transactions-holds] |

### 3.3 Limit-setting checks (HTTP errors, not outcomes)

| operation | condition | result | source |
|---|---|---|---|
| `setAccountLimit` (11 settable types, jq: `MAX_BALANCE, TOTAL_SPEND_PER_YEAR, ATM_WITHDRAWAL_PER_DAY, TOP_UP_PER_DAY, BANK_TRANSFER_TOP_UP_PER_DAY, PAYMENT_TO_ACCOUNT_NUMBER, PAYMENT_TO_PAY_ID, CARD_PAYMENTS_DAILY, SINGLE_CARD_TRANSACTION, DIRECT_DEBIT_PER_DAY, BPAY_DAILY_LIMIT`) | `limitAmount > productLimit` | 422 `ErrorResponse` [inferred]; "An account level limit cannot exceed the Product level" | docs:account-limits; spec `limitAmount` `exclusiveMinimum 0` |
| `updateMaxBalanceLimit` | `maxBalanceLimit > productLimit(MAX_BALANCE)`; `≤ 0` | 422 / 400 [inferred] | spec description; [decision] writes the same `accountLimit(MAX_BALANCE)` slot as `setAccountLimit` [map:accounts Q11 open] |
| `updateOverdraftLimit` | `overdraftLimit > productLimit(OVERDRAFT_PRODUCT_LIMIT)`; overdraft facility not enabled for the client | 422 [inferred] | spec description; docs:account-limits; `0` accepted = overdraft removed [decision; map:accounts Q10 open] |
| `deleteAccountLimit` on a non-settable type (`MIN_BALANCE, MIN_STACK_BALANCE, OVERDRAFT_PRODUCT_LIMIT, CARD_TOP_UP_PER_DAY, BPAY_TOP_UP_PER_DAY`) | type present in the delete enum but never settable | [decision] `success: false`, no error [map:accounts Q13 open] | spec enums |
| `closeAccount` | any §1.4 predicate fails | 422 `CloseAccountResponse { result: FAILURE, errors: ClosureCheckerError[] }` | docs:account-closure; spec |

---

## 4. (d) Explicit contradictions between maps (both sides quoted)

"Contradiction" = two maps state incompatible rules or give incompatible readings of the same source. Cases where maps merely leave different things open are listed at the end as gaps.

### C1 — Whether `overdraftLimit` belongs inside `totalBalance` (accounts vs transactions-holds)

- [map:accounts §4]: "`totalBalance` = `ledger` + `overdraftLimit` (spec: total "will also include unused overdraft limit and Stacks, held and locked value")." and "`availableBalance` = `totalBalance` − `heldBalance` − `lockedBalance` − `stacksBalance`".
- [map:transactions-holds §4.1 / Q31]: "With overdraft, no formula is given here: the docs formula (Available = Account Balance + (Overdraft Limit + Overdraft Balance) + …) and the spec `totalBalance` description ("will also include unused overdraft limit") cannot be reconciled — adding `overdraftLimit` to `totalBalance` would double-count it"; "The two cannot be combined into one `availableBalance` formula without double-counting the limit."
- [map:groups-stacks §4] sits between them: "`availableBalance = totalBalance - stacksBalance - heldBalance - lockedBalance (± overdraft terms)`".
- **Resolution [decision]**: accounts' model (§1.2). The double count only arises if one *also* adds the docs' `(Overdraft Limit + Overdraft Balance)` on top of a `totalBalance` that already contains the unused limit; the docs' "Account Balance" is the deposit-only figure `D`, not `totalBalance`. No sample has a non-zero overdraft, so this stays [open] for confirmation with Shaype.

### C2 — Meaning of webhook `updatedBalance` (bpay vs transactions-holds / utilities)

- [map:bpay "Payment validation formulas"]: "Post-acceptance balance effect: `updatedBalance = previousBalance + currencyAmount.amount` where `currencyAmount.amount` is negative for the debit (`-20.00`)" and item 8: "`updatedBalance` = `accountBalances.totalBalance` = `accountBalances.availableBalance`".
- [map:transactions-holds §2 / §4.1]: "`updatedBalance` … equals `accountBalances.availableBalance` in the scenario-1 and scenario-3 samples … [inferred] emit `updatedBalance` = post-event `availableBalance`"; [map:utilities §4]: "`updatedBalance` in the transaction webhook equals `accountBalances.availableBalance` after the event in the consistent samples".
- Incompatible for a **settlement**: bpay's running-balance rule would give `2.73 − 8.40 = −5.67` for the docs:card-transactions settlement whose `updatedBalance` is `2.73` (available unchanged by settlement). The rules coincide only when `held = locked = stacks = 0`, as in the BPAY sample.
- **Resolution [decision]**: `updatedBalance = availableBalance after the event` (§1.2). The docs samples that disagree with *both* rules (§2 incremental-auth `5066/5065/5075` against available `66.00/65.00/75`; refund `3305.99` against `5.99`) are treated as unreliable by all three maps.

### C3 — Which transactions consume the daily transfers-out limit (accounts vs transactions-holds)

- [map:accounts makeTransferV1 preconditions]: "daily transfers-out limit → `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED` [docs:payment-transaction-outcome]" — attached to `makeTransferV1` only; and Q14: "no spec enum equivalent for `TRANSFERS_OUT_PER_DAY` (outcome `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED` exists). Decide whether a hidden daily transfers-out limit exists at product level."
- [map:transactions-holds createDebitTransactionV0]: "Limits (debit direction): `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED` "Transaction declined because the daily limit for outgoing transfers has been exceeded" [docs:payment-transaction-outcome] — v0 collapses this to `REFUSED_LIMIT_BREACH` [spec]" — attached to the **general debit** endpoint.
- Not strictly incompatible (both can be true) but each map's per-op list omits the other's operation. The spec's v0 credit/debit description names `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED` as a detailed outcome of *that* endpoint family, so general debits must count.
- **Resolution [decision]**: L2 in §3.2 — `GENERAL_DEBIT` + `INTRABANK_TRANSFER_OUT` + `INTERBANK_TRANSFER_OUT` + scheduled ACCOUNT payments share one hidden product-level daily cap; BPAY, card and stack moves are excluded.

### C4 — Does the incremental-authorisation sample support "total unchanged" on a hold increase (utilities internal, vs transactions-holds' evidence)

- [map:utilities generateHoldAndUpdateHoldTransactions]: "Sample: hold −9.00 (`total 232.64, held 166.64, avail 66.00`) → increment webhook … (`total 241.64, held 176.64, avail 65.00` — sample's `total` changes by +9, which contradicts "total unchanged"; treat the sample as unreliable" and Q12 "implement total-unchanged".
- [map:transactions-holds §4.2]: "Hold increase by d (hold total becomes a+d) | — | +d | −d" — states the rule with no mention of the contradicting sample, and its sample table (§4.1) silently omits the scenario-2 rows.
- Same rule, different disclosure. **Resolution**: rule as stated (`total` unchanged); the scenario-2 sample is excluded from the evidence set (§1.2).

### C5 — Is the scenario-3 settlement sample usable evidence (utilities vs transactions-holds)

- [map:utilities "Settlement amount"]: "Settlement amount = current (updated) hold amount at settlement time: original hold + increases − decreases [docs samples: −9 → −19 → settle −19; −5 → +0.50 → settle −4.50]" and in the op: "`held` ↓ updated hold, `total` ↓ updated hold, `available` unchanged [docs:card-transactions samples; arithmetic inferred]".
- [map:transactions-holds §4.2]: "The scenario-3 settlement sample (hold 5.00, reversed 0.50, settled −4.50) shows total 10.87 → 1.87 (−9.00) and held 9.00 → 0, i.e. it is not self-consistent with a 4.50 settlement (the remaining 4.50 of held funds also disappears); it cannot be used to verify settlement arithmetic".
- The sample's `−9.00` movement equals the whole held balance, not the 4.50 settled; utilities cites it as support, transactions-holds rejects it. **Resolution**: rule unchanged (`held −h`, `total −h`, `avail` unchanged with `h` = updated hold); only scenario-1 (`11.13/8.4/2.73 → 2.73/0/2.73`) is arithmetic evidence.

### C6 — Scope of `DIRECT_DEBIT_PER_DAY` (de-dd-scheduled vs utilities, both citing spec vs docs)

- [map:de-dd-scheduled 4.6 / Q10]: "`DIRECT_DEBIT_PER_DAY`: spec "Maximum value of outgoing direct debit transfers"; docs "The maximum total value of outgoing cash from inbound direct debit requests …" … Whether that limit is applied to *this* (outbound-DD, credit-to-customer) flow or only to inbound DDs that debit the customer is contradictory between the two sources".
- [map:utilities generateInboundDeTransaction DIRECT+DEBIT]: "an *inbound direct debit* … Platform limit outcomes that exist for this: `REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED`, `REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED`" — applies the limit to the inbound-DD debit without qualification.
- **Resolution [decision]**: L6 — follow the docs (and utilities): the limit caps money **leaving** the account through inbound DD requests; `createDirectDebit` (money arriving) is not checked. de-dd's question stays [open] for Shaype.

### C7 — Sync outcome for a funds shortfall on `makeTransfer` (accounts vs transactions-holds wording)

- [map:accounts]: "`availableBalance < amount` → `REFUSED_INSUFFICIENT_FUNDS` [inferred — spec enum value chosen by name; docs:payment-transaction-outcome describes `REFUSED_NOT_ENOUGH_FUNDS`, which is webhook-enum-only]".
- [map:transactions-holds createDebitTransactionV0]: "Which string the HTTP response uses is therefore ambiguous (open question); `REFUSED_INSUFFICIENT_FUNDS` is the only one valid against the HTTP schema."
- [map:bpay item 4]: "`REFUSED_INSUFFICIENT_FUNDS` [inferred from enum name; no source maps this rule to that outcome]"; [map:utilities §4]: "refusals surface as `outcome` values … e.g. `REFUSED_NOT_ENOUGH_FUNDS`" (webhook context).
- Not a real conflict — all pick the schema-valid value per channel — but accounts presents it as settled and transactions-holds as open. **Resolution [decision]**: F1 — sync `REFUSED_INSUFFICIENT_FUNDS`, webhook `REFUSED_NOT_ENOUGH_FUNDS`.

### C8 — Whether `heldBalance` can hold non-card items (accounts/transactions-holds vs bpay's question, and the spec against itself)

- [map:accounts getPendingHolds]: "Sum of open holds is the account's `heldBalance` ("Total value of all authorised but not yet cleared transactions for all Cards on Account")" while its `AuthorisationHold.type` list (jq-verified) includes `INTRABANK_TRANSFER_IN/OUT`, `INTERBANK_TRANSFER_IN/OUT`, `DIRECT_DEBIT_TRANSFER`, `GENERAL_CREDIT`, `GENERAL_DEBIT`, `BPAY_TRANSFER_OUT`, `BPAY_TRANSFER_IN`.
- [map:bpay item 8]: "the account balance is debited immediately — the `TRANSACTION` webhook example shows `isPending: false` … Whether the platform first creates an authorisation hold (spec `AuthorisationHold.type` includes `BPAY_TRANSFER_OUT`) is not stated".
- [map:transactions-holds §4.2] and [map:utilities §4] model holds for card events only; every payment map posts immediately.
- **Resolution [decision]**: card-only holds (§2.3 note). The non-card hold types are a schema artefact (the enum is a copy of `FinancialTransaction.type`).

### C9 — Overdraft funds and stack transfer-in (groups-stacks open vs accounts model)

- [map:groups-stacks Q12]: "Overdraft into stacks: can `accountToStackTransfer` use overdraft funds (availableBalance includes overdraft limit)?" and in the op: "Whether overdraft funds can be moved into a stack is undefined [open]."
- [map:accounts §4]: `availableBalance` includes the unused overdraft limit (via `totalBalance`), and "internal account↔stack moves are not counted in daily transfer limits" — no exception for overdraft.
- **Resolution [decision]**: the only check on `accountToStackTransfer` is F1 (`availableBalance ≥ a`), so overdraft funds *can* be earmarked; flagged [open] because it lets a customer park borrowed money in a savings stack.

### C10 — Which balance `ACCOUNT_BALANCE_TOTAL` closes on (accounts vs the overdraft model)

- [map:accounts §4]: "Closure requires `totalBalance == 0` and `heldBalance == 0` [docs:account-closure]".
- Under the same map's own model `totalBalance = ledger + overdraftLimit`, an account with an unused overdraft limit and zero deposits has `totalBalance > 0` and could never close, yet the spec has a separate `ACCOUNT_BALANCE_OVERDRAFT` check.
- **Resolution [decision]**: §1.4 — `ACCOUNT_BALANCE_TOTAL` tests `ledger == 0`; `ACCOUNT_BALANCE_OVERDRAFT` tests `overdraftBalance == 0`. [open]: whether Shaype also requires `overdraftLimit == 0` before closure.

### Gaps (left open by every map that touches them — no map contradicts another)

| gap | maps | status |
|---|---|---|
| Sign of `technicalOverdraftBalance` in API responses (spec silent, docs ≤ 0) | accounts Q9, transactions-holds Q28 | [decision] positive magnitude; [open] |
| `updateMaxBalanceLimit` vs `setAccountLimit(MAX_BALANCE)` storage | accounts Q11 | [decision] same slot |
| `MIN_STACK_BALANCE` enforcement point | groups-stacks Q13 | [decision] not enforced (Shaype-only limit, default 0) |
| Webhook emission for sync-refused payments | bpay Q3, accounts Q27 | [decision] only when the value exists in the webhook enum (§3.1) |
| Whether refused mocks still return HTTP 200 | utilities | [decision] 200 `GenericMessage`; refusal visible only in the webhook |
| Scope of `REFUSED_TOTAL_*_DAILY_LIMIT_BREACHED` (client-wide vs per-account) | transactions-holds Q30, de-dd 4.6, bpay | [decision] client-wide, never emitted locally by default (L11) |
| Partial settlement (`s ≠ h`) | transactions-holds Q10, utilities Q9 | not producible by any mock; rule in §2.2 kept general |
| `homeCurrencyBalanceEquivalent` on home-currency accounts | accounts Q25 | [decision] always populated |
| Overdraft expiry date | accounts Q10 | no API field → ignored locally |

---

## 5. Decision register (everything marked [decision] above, one line each)

1. Store `ledger, held, locked, stacks, odLimit`; derive `overdraftBalance = max(0, min(−ledger, odLimit))`, `technicalOverdraftBalance = max(0, −ledger − odLimit)`, `totalBalance = ledger + odLimit`, `availableBalance = totalBalance − held − locked − stacks`.
2. All `HayAccount` magnitudes positive (incl. technical overdraft); webhook/transaction amounts signed (credit +, debit −); hold-increase webhook amount cumulative, hold-decrease amount positive delta.
3. `updatedBalance` = post-event `availableBalance`; `rollingAccountBalance` = post-posting `totalBalance`; `accountBalances` always the post-event snapshot (omitted for external-balance clients).
4. `ACTIVE_IN_ARREARS` ⇔ `technicalOverdraftBalance > 0`; `APPROVED → ACTIVE` on the first posting (stack moves included [open]).
5. Holds are card-only; every non-card payment posts immediately; hold settlement always settles the current (updated) hold amount.
6. `MAX_BALANCE` compares `ledger` (deposits incl. stacks, excl. unused overdraft) + amount, aggregated across the FX hierarchy at the cached margin-free rate.
7. Funds check on every debit/hold/stack-in: `availableBalance ≥ amount` (overdraft spendable, stacks never drawn); sync `REFUSED_INSUFFICIENT_FUNDS`, webhook `REFUSED_NOT_ENOUGH_FUNDS`.
8. Hidden product-level daily transfers-out cap over `GENERAL_DEBIT` + `INTRABANK_TRANSFER_OUT` + `INTERBANK_TRANSFER_OUT` + scheduled ACCOUNT payments; BPAY/card/stack excluded; v1 `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED`, v0 `REFUSED_LIMIT_BREACH`.
9. Limits with no dedicated sync value (`PAYMENT_TO_ACCOUNT_NUMBER`, `TOTAL_SPEND_PER_YEAR`, top-ups on v1 credit, risk `HIGH` on debits) → `REFUSED_LIMIT_BREACH`; BPAY daily → sync `REFUSED_DAILY_BPAY_LIMIT_BREACHED`, webhook `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`.
10. `DIRECT_DEBIT_PER_DAY` caps inbound-DD debits (docs), not `createDirectDebit`; liquidity `TOTAL_*` outcomes never emitted by default.
11. Refusal webhooks only when the outcome exists in the 41-value webhook enum; `docs:account-limits`' `LIMIT_BREACH`/`detailedOutcome` shape ignored; "not currently in use" values never emitted.
12. Closure: `ledger == 0`, `held == 0`, `stacks == 0`, `locked == 0`, `overdraftBalance == 0`, `technicalOverdraftBalance == 0`, no in-flight outbound DD, all FX children closed.
13. `updateOverdraftLimit` accepts 0 (removes overdraft); `updateMaxBalanceLimit` and `setAccountLimit(MAX_BALANCE)` write the same account-limit slot; deleting a non-settable limit type returns `success: false`.
14. Ext-auth callback `account.balance` = `totalBalance − stacksBalance`; client 470 `REFUSED_NOT_ENOUGH_FUNDS` → sync `REFUSED_INSUFFICIENT_FUNDS`, `REFUSED_MAX_BALANCE_EXCEEDED` → same, anything else → `INTERNAL_ERROR`.
15. `homeCurrencyBalanceEquivalent` populated on every account at the cached rate (identity on home-currency accounts); `lockedBalance` constant 0 (no API writes it).
