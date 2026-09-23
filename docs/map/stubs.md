# stubs

Domain map for the **stub-only** tags of the Shaype B2B Operations API (spec title "B2B Operations API", version "0.0.1"): **Click to Pay API** (3 ops), **Merchant Category Codes API** (1), **Tokens API** (2), **Products API** (1), **FX API** (8), **Liquidity API** (4), **Perks API** (8) — **27 operations**. Source labels: `[spec]` = b2b-operations-api.json, `[webhook-spec]` = notification-webhooks.json, `[ext-auth-spec]` = external-balance.yaml, `[docs:<slug>]` = developer.shaype.com page (`docs/product`, `page/click-to-pay`, `docs/liquidity-monitoring-and-alerting-1`, `page/indicative-rates-api`, plus the FX pages linked from those: `page/multi-currency-wallets-feature-guide`, `page/multi-currency-wallets-conversion-quote`, `page/multi-currency-wallets-conversions`, `page/multi-currency-card-authorisation`, `page/margins-and-quote-locking`, `page/minimum-conversion-rounding-logic`, `page/quote-expiration-observability`, `page/multi-currency`), `[inferred]` = not stated anywhere; implementer's reasonable reading.

Tag descriptions [spec]: Click to Pay API = "Set of APIs related to Click to Pay enrolment"; Merchant Category Codes API = "Reference API for Merchant Category Codes (MCCs)"; Tokens API = "Set of APIs related to exchanging external tokens for Shaype tokens to interact with our GraphQL APIs"; Products API = "Set of APIs related to managing products"; FX API = "APIs for foreign exchange operations"; Liquidity API = "Set of APIs related to managing Client Liquidity"; Perks API = "Customer value-added services (top-ups, gift cards, bill pay)".

Conventions used below:
- **Common error responses** (declared on every one of the 27 operations): `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content`, `500 Internal Server Error`, `501 Not Implemented`, all with body `ErrorResponse` [spec]. `ErrorResponse` = `{ details: string ("Error details"), message: string ("Error description"), status: string ("HTTP response status"), traceId: string ("TraceID that can be used by HAY for troubleshooting the request") }`, no field required [spec]. The spec never says which condition yields 400 vs 422 for any operation in this domain; no docs page gives message text for this domain.
- **404** is declared only on `getOperatorById` ("Operator not found") and `getProductById` ("Product not found"), and there its declared body schema is `OperatorSummary` / `ProductSummary` respectively (not `ErrorResponse`) — a spec quirk [spec]. No `409` is declared anywhere in this domain [spec].
- `GenericMessage` = `{ message: string ("Message indicating operation result") }` [spec]; the message text is never documented.
- No `security` block and no `components.securitySchemes` exist in the spec [spec]; auth is out of scope. `servers` = `http://localhost:8080` (generated) [spec].
- **Currency enum**: every currency-typed property in this domain (14 enum sites: `CurrencyAmount.currency`, `ConversionQuoteRequest.buyCurrency`, `FxRateEntry.buyCurrency`/`sellCurrency`, `LiquidityConversionRequest.buyCurrency`/`sellCurrency`, `LiquidityConversion.buyCurrency`/`sellCurrency`/`depositCurrency`, `LiquidityDetailedRate.clientBuyCurrency`/`clientSellCurrency`/`depositCurrency`, and the `buyCurrency`/`sellCurrency` query params of `getLiquidityDetailedRates`) uses one identical **162-value ISO 4217 list**, given verbatim once in §2 under `CurrencyAmount` and referred to as `<ISO-162>` elsewhere. Verified identical by jq. Note the perk `Money.currency` / `MonetaryValue.currency` are plain strings (no enum) [spec].
- **No request or response examples** exist at operation level for any of the 27 operations [spec, verified]; only schema-property-level and query-parameter-level `example` values (the latter on `getFxRates.currencyPairs`, `getLiquidityBalances.target`, and every `getLiquidityDetailedRates` query param), which are quoted in §1/§2.
- Perks list endpoints share the pagination params `limit` (integer int32, `minimum: 1`, `maximum: 100`, `default: 20`, "Maximum results to return (page size); defaults to 20, max 100") and `offset` (integer int32, `minimum: 0`, `default: 0`, "Number of results to skip; defaults to 0") [spec]; `getOrders` adds "must be a multiple of limit" to `offset` [spec]. No total-count header or envelope is declared: responses are bare JSON arrays [spec].
- `PerkType` (inline enum reused on 4 query params and `OrderSummary.perkType`; description "A customer perk (value-added service): MOBILE_TOP_UP (mobile airtime/data), UTILITIES (bill payments), GIFT_CARDS, ESIM.") = `["MOBILE_TOP_UP","UTILITIES","GIFT_CARDS","ESIM"]` [spec].
- `fixedSide` everywhere = `["BUY","SELL"]` [spec]. `target` (liquidity account selector) everywhere = `["CLIENT_HOUSE","TREASURY_RECON_SUB"]`, described as "**CLIENT_HOUSE**: your own House Account, held in your Currency Cloud tenant / **TREASURY_RECON_SUB**: your reconciliation sub-account, held by Shaype" [spec].

## 1. Operations

### Click to Pay API

Context [docs:click-to-pay]: Click to Pay (C2P) is delivered through Thredd; behaviour is set per client in product configuration by `enabled` (flag) and `mode` (`AUTO` | `MANUAL`), giving three effective states — **Auto** (cards enrolled automatically at creation plus a one-off migration of existing cards), **Manual** (nothing enrolled off platform events; client calls the dedicated endpoints), **Disabled** (default; no C2P processing). The docs page (dated 2026-07-31) lists the manual *enrol* endpoint as "Not raised" and the unenrol endpoint as "Deployed"; the spec now carries both, so the spec is the newer source. The enrolment flag lives internally on the card ("ground truth for whether the platform believes a card is enrolled"; no polling of Thredd) [docs:click-to-pay] and is **not exposed on `HayCard`** (verified: `HayCard` has no C2P field) [spec].

### POST /v0/cards/{cardId}/ctp (enrolCard)

- Purpose: "Enroll card to Click To Pay". Description verbatim: "Registers the card with Click to Pay, registering the cardholder first when this is their first enrolled card. Cards that are already enrolled are a no-op success. An email supplied in the body is sent to Click to Pay in place of the email held for the customer, updating their Click to Pay registration when they are already registered. It is never stored against the customer." [spec]. Not deprecated.
- Path params: `cardId` — string, `format: uuid`, required, "Unique identifier (UUID) of the Card" [spec].
- Request body (**not** marked required): `EnrolCardToClickToPayRequestBody` (description "**Body of a request to enrol a card to Click to Pay.**")
  - `email` — string, `format: email`, optional, `minLength: 0`, `maxLength: 255`, "Email address sent to Click to Pay instead of the one held for the customer. Never stored. Omit to use the held email." [spec]
- Response: `200 Success` → `GenericMessage`. Common error responses.
- Behaviour: idempotent — already-enrolled card is a no-op success [spec]; first card for a cardholder registers the cardholder and the card together, a subsequent card is added to the existing enrolment [spec][docs:click-to-pay]; `email` overrides the customer's held email for the Thredd call only and must never be persisted on the customer [spec]; only meaningful for Manual-mode clients ("Manual mode is a secondary mechanism. It is not offered to clients in Auto mode or to clients with C2P disabled") [docs:click-to-pay] — which error a Disabled/Auto client gets is not stated [inferred: 403 or 422]; card-status preconditions (e.g. must not be `inactive`/`expired`) are not stated [inferred: reject terminal-state cards, since deactivation triggers unenrolment].
- Webhooks: none documented.

### DELETE /v0/cards/{cardId}/ctp (unenrolCard)

- Purpose: "Unenroll card from Click To Pay". Description verbatim: "Removes the card's Click to Pay registration. Cards that are not currently enrolled are a no-op success." [spec]. Not deprecated.
- Path params: `cardId` — string, `format: uuid`, required, "Unique identifier (UUID) of the Card" [spec].
- Request body: none.
- Response: `200 Success` → `GenericMessage`. Common error responses.
- Behaviour: idempotent no-op success when not enrolled [spec]; "keyed by the platform card identifier, resolves the Thredd customer reference internally"; "backs operational, bulk and client-initiated removal" [docs:click-to-pay]; the platform itself removes the registration when a card moves to a terminal state (`inactive` or `expired`) [docs:click-to-pay]; whether that goes through this endpoint is not stated [inferred].
- Webhooks: none documented.

### DELETE /v0/customers/{customerId}/ctp (unenrolCustomer)

- Purpose: "Unenroll customer from Click To Pay". Description verbatim: "Removes the customer's Click to Pay cardholder registration and every card linked to it. Customers that are not currently enrolled are a no-op success." [spec]. Not deprecated.
- Path params: `customerId` — string, `format: uuid`, required, "Unique identifier (UUID) of the Customer" [spec].
- Request body: none.
- Response: `200 Success` → `GenericMessage`. Common error responses.
- Behaviour: cascades to every enrolled card of the customer [spec]; idempotent no-op success when the customer is not enrolled [spec]; not triggered automatically by customer offboarding ("Cardholder unenrolment on customer offboarding is out of scope") [docs:click-to-pay].
- Webhooks: none documented.

### Merchant Category Codes API

### GET /v0/mccs (getAllMerchantCategoryCodes)

- Purpose: "Get all Merchant Category Codes" — reference list [spec]. Not deprecated. No description.
- Path/query params: none.
- Request body: none.
- Response: `200 Success` → array of `HayMerchantCategoryCode` (description "Details of the Merchant Category Code (MCC).") = `{ code: integer int32 ("Merchant Category Code (MCC) as four digit code as per ISO 18245"), description: string ("Description of the Merchant Category Code (MCC)") }`, neither required [spec]. Common error responses.
- Behaviour: read-only; the list contents are not in the spec or docs — the implementer must seed an ISO 18245 table [inferred]. MCCs are consumed elsewhere as `RuleDetails.blockedMerchantCategoryCodes` (array of integer int32, `uniqueItems: true`; "Blocked Merchant Category Code (MCC) as four digit code as per ISO 18245 (required for Rule type: MERCHANT_CODE_BLOCK).") for `MERCHANT_CODE_BLOCK` transaction rules — reached via `ExternalAddTransactionRuleRequest.ruleDetails` only; `ExternalTransactionRuleResponse.rule` is the untyped `Rule` schema ("Contains detail of the Rule", no properties declared) with no MCC field — and as `ExternalMerchantDetails.merchantCategoryCode` / `MerchantDetails.merchantCategoryCode` on transactions [spec] (see §5).
- Webhooks: none.

### Tokens API

Context: these two operations mint credentials for Shaype's **GraphQL APIs**, which are outside the B2B Operations spec [spec tag description]. The customer-facing auth API documents the analogous flow with snake_case names: `POST /exchange` "Provided valid Bearer token will be exchanged with a pair of our Access and Refresh tokens" → `TokenExchangeResponse { access_token, access_expires_utc (integer), installation_handle }` [docs:reference/postexchangerequest]; `POST /elevate` "Provides the elevation header needed for elevated access APIs. Requires a valid Bearer token. Also requires an elevated external token which passed in the X-Authorization-StepUp header." → `TokenElevationResponse { elevation_header }` [docs:reference/postelevaterequest]. Those pages describe a different API; the B2B shapes below are the ones to implement.

### POST /v0/tokens/exchange (exchangeExternalToken)

- Purpose: "Exchange External Token for a Shaype token to be used when calling our GraphQL APIs" [spec]. Not deprecated. No description.
- Path/query params: none.
- Request body (required): `ExchangeExternalTokenRequestBody` (description "Body of a request to exchange an external token for a hay token")
  - `externalAccessToken` — string, **required**, `minLength: 1`, "External Access Token" [spec].
- Response: `200 Success` → `ExchangeExternalTokenResponse` = `{ accessExpiresUtc: integer int64, accessToken: string, installationHandle: string }`, none required, no descriptions [spec]. Common error responses.
- Behaviour: validation of the external token and the token format are unspecified [spec]; `accessExpiresUtc` unit (epoch seconds vs milliseconds) is not stated in the B2B spec [spec]; epoch seconds per the analogous `access_expires_utc` field ("Access token expiration date and time (as UNIX epoch in seconds)") [docs:reference/postexchangerequest]; applicability to the B2B field [inferred]; for the stub, any non-empty `externalAccessToken` may be accepted and an opaque `accessToken` issued [inferred].
- Webhooks: none.

### POST /v0/tokens/elevate (elevateExternalToken)

- Purpose: "Retrieve an elevation header to be used for GraphQL APIs that require step up access" [spec]. Not deprecated. No description.
- Path/query params: none.
- Request body (required): `ElevateExternalTokenRequestBody` (description "Body of a request to elevate access")
  - `externalAccessToken` — string, **required**, `minLength: 1`, "External Access Token" [spec].
  - `externalStepUpToken` — string, **required**, `minLength: 1`, "External Step Up Token" [spec].
- Response: `200 Success` → `ElevateExternalTokenResponse` = `{ elevationHeader: string }`, not required, no description [spec]. Common error responses.
- Behaviour: no relationship to `exchangeExternalToken` is stated (whether the exchange must precede elevation is unknown) [spec]; the customer API says elevation "Requires a valid Bearer token" and the step-up token in header `X-Authorization-StepUp` [docs:reference/postelevaterequest] — in this API both arrive in the body [spec]. Stub may return any opaque string [inferred].
- Webhooks: none.

### Products API

### GET /v1/products (getAllProducts)

- Purpose: "Gets all products" [spec]. Not deprecated. No description.
- Path/query params: none.
- Request body: none.
- Response: `200 Success` → array of **`ProductSummary`** — the *perk* product schema (`countryIsoCode`, `operatorId`, `perkSubType`, `type: FIXED_VALUE_RECHARGE…`, `required*Fields`, `source`/`destination` `MonetaryValue`, `redemption`; full field list in §2) [spec]. Common error responses.
- Behaviour: the docs describe this endpoint as returning the client's *banking* products: "This API will return all the products configured for your environment. The `productId` will be the unique value that can be passed when opening accounts." [docs:product]; "A product hosts the business rules and processing logic for your customer's accounts … Every product we create on the Shaype Platform is assigned a unique `productId` … we will create a `productId` to serve as the default product for your environments" [docs:product]. The spec binds it to the perk `ProductSummary` (the only schema named like a product; no `HayProduct`/`Product` schema exists — verified) — a **spec/docs conflict**, see §7. Read-only either way. Cross-domain: `CreateAccountRequestBody.productId` (required, "Unique value (UUID) of the product used for this account.") and `HayAccount.productId` ("Unique identifier (UUID) of the Product") consume the id [spec]; multi-currency is a per-product feature ("Request Multi Currency as a feature when confirming your product requirements with your CSM to ensure accounts created have the correct internal `productId` applied") [docs:multi-currency].
- Webhooks: none.

### FX API

Context: two layers — Currency Cloud is the underlying FX provider ("prices on live market conditions … The quote is therefore indicative only"); Shaype wraps it with **quote locking** (margin + expiry window) so the customer gets "a firm rate and amount, locked if converted before expiration" [docs:margins-and-quote-locking]. Customer-facing conversions are a two-step flow: `generateConversionQuote` then `executeConversion`, between a Home Currency Account (AUD) and a Currency Account, or between two Currency Accounts [docs:multi-currency-wallets-feature-guide]. The three `/v1/fx/liquidity/*` operations act on the client's **liquidity (treasury) accounts at Currency Cloud**, not on customer ledgers, and all "Require multi-currency wallets to be enabled for the client" [spec]. Supported Currency Account currencies: USD, EUR, GBP, AED, CAD, CHF, CZK, DKK, HKD, HUF, ILS, JPY, NOK, NZD, PLN, RON, SAR, SEK, SGD, THB, TRY, ZAR; holdable-only: BHD, CNH, KES, KWD, MXN, OMR, QAR, UGX [docs:multi-currency-wallets-feature-guide]. The spec enums are the full `<ISO-162>` list regardless.

### POST /v1/fx/quotes (generateConversionQuote)

- Purpose: "Create Conversion Quote". Description verbatim: "Get a detailed FX quote for converting between the account's currency and another currency. To use this endpoint please contact your CSM, this functionality requires agreement to be used." [spec]. Not deprecated.
- Path/query params: none.
- Request body (required): `ConversionQuoteRequest` (description "Request for FX conversion quote"), `required: ["amount","buyCurrency","fixedSide","idempotencyKey","sellAccountId"]`
  - `amount` — number, **required**, `minimum: 0`, `exclusiveMinimum: true`, "Amount to convert in fixed side currency", example `1000` [spec].
  - `buyCurrency` — string, **required**, enum `<ISO-162>`, "Currency to buy (ISO 3-letter code)", example `"AUD"` [spec].
  - `fixedSide` — string, **required**, enum `["BUY","SELL"]`, "The side of the trade to be fixed in value. Possible values: **BUY**: The buy side is fixed, sell amount variable / **SELL**: The sell side is fixed, buy amount variable" [spec].
  - `idempotencyKey` — string, **required**, `format: uuid`, "Unique value (UUID) used to identify this request and used to recognise any subsequent retries" [spec].
  - `marginPercentage` — number, optional, `nullable: true`, "Optional margin percentage override (e.g. 1.5 for 1.5%). When absent, the configured default margin is applied.", example `1.5` [spec].
  - `sellAccountId` — string, **required**, `format: uuid`, "The account ID to sell from (will be debited)" [spec].
- Response: `200 Success` → `ConversionQuoteResponse` (description "FX conversion quote with buy/sell amounts") = `{ buyAmount: CurrencyAmount, expiresAtUtc: string date-time ("Timestamp when the quote expires (UTC)"), quoteId: string uuid ("Unique quote identifier"), rate: number ("Exchange rate for the conversion"), sellAmount: CurrencyAmount }`, none required [spec]. `CurrencyAmount` = `{ amount: number ("Amount of the transaction to 2 decimal places"), currency: <ISO-162> }`, both required [spec]. Common error responses.
- Behaviour: sell currency = currency of `sellAccountId`; that account "must be funded before requesting a quote" [docs:multi-currency-wallets-feature-guide] ("The customer must fund this account prior to making a trade" [docs:multi-currency-wallets-conversion-quote]) (the docs say "`accountId` in the request path" — stale; the spec puts it in the body as `sellAccountId` [spec]); the quoted `rate` = live market rate with the margin applied — default margin configured via CSM, or `marginPercentage` per request "overrides the default for that quote" [docs:margins-and-quote-locking]; `expiresAtUtc` = "the timestamp the quotation was recorded and the configured quote expiration" (client-configurable window, set via CSM — "You can specify the expiration window required with our customer support managers") [docs:quote-expiration-observability][docs:multi-currency-wallets-feature-guide][docs:multi-currency-wallets-conversion-quote]; the `quoteId` "fixes both legs of the trade, the sell amount, the buy amount, and the rate between them" [docs:margins-and-quote-locking]; requires a multi-currency product and CSM agreement [spec][docs:multi-currency]; a blocked Currency Account cannot be used "for card spend or conversions" [docs:multi-currency]; idempotency: `idempotencyKey` is "used to recognise any subsequent retries" [spec], the retry result (same quote returned vs. error) is unspecified [inferred: return the original quote]; no balance is moved by quoting [inferred from docs: only execution "applies the balance changes"]; whether a quote is refused when the sell account balance is below the sell amount is not stated [inferred: not checked at quote time — checked at execute, see `REFUSED_INSUFFICIENT_FUNDS`].
- Webhooks: none documented.

### POST /v1/fx/conversions (executeConversion)

- Purpose: "Execute Conversion". Description verbatim: "Execute a currency conversion using a previously created quote." [spec]. Not deprecated.
- Path/query params: none.
- Request body (required): `ConversionExecuteRequest` (description "Request to execute an FX conversion"), `required: ["idempotencyKey","quoteId"]`
  - `idempotencyKey` — string, **required**, `format: uuid`, "Unique value (UUID) used to identify this execution and used to recognise any subsequent retries" [spec].
  - `quoteId` — string, **required**, `format: uuid`, "The ID of the quote to execute" [spec].
- Response: `200 Success` → `ConversionExecuteResponse` (description "FX conversion execution result") = `{ buyAmount: CurrencyAmount, conversionId: string uuid ("Unique conversion identifier"), creditTransactionId: string uuid ("ID of the credit transaction"), debitTransactionId: string uuid ("ID of the debit transaction"), outcome: string enum, quoteId: string uuid ("Quote ID that was executed"), sellAmount: CurrencyAmount }`, none required [spec]. `outcome` ("Outcome of the conversion execution") enum verbatim: `["ACCEPTED","INTERNAL_ERROR","REFUSED_LIMIT_BREACH","REFUSED_FRAUD","REFUSED_CUSTOMER_PREFERENCE","REFUSED_INSUFFICIENT_FUNDS","REFUSED_ACCOUNT_BLOCKED","REFUSED_RECIPIENT_ACCOUNT_BLOCKED","REFUSED_ACCOUNT_CLOSED","REFUSED_RECIPIENT_ACCOUNT_CLOSED","REFUSED_INVALID_PAY_ID","UNKNOWN","REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED","REFUSED_MAX_BALANCE_EXCEEDED","REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED","REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED","REFUSED_TOTAL_NET_VISA_DAILY_LIMIT_BREACHED","REFUSED_TOTAL_NON_SCHEME_DAILY_LIMIT_BREACHED","REFUSED_SENDER_ACCOUNT_NOT_VERIFIED","REFUSED_CAPABILITY_NOT_ENABLED","REFUSED_QUOTE_EXPIRED"]` [spec]. Common error responses.
- Behaviour: "Submitting the `quoteId` … immediately books the conversion and applies the balance changes from the quotation to both accounts. The sell currency account is debited and the buy currency account is credited with the exact amounts from the quote." [docs:multi-currency-wallets-feature-guide]; "Executing the conversion books the `quoteId`; it does not re-price" [docs:margins-and-quote-locking]; the buy-side account is the customer's Currency Account in `buyCurrency` [inferred from docs — no `buyAccountId` is in the request; `ConversionDetailsResponse.buyAccountId` reports which was used]; expired quote → "the terms of that trade are no longer available … redirected to creating a new quotation" [docs:multi-currency-wallets-conversions] → `outcome: REFUSED_QUOTE_EXPIRED` [spec]; whether refusals come back as HTTP 200 with a `REFUSED_*` outcome or as 4xx is not stated [inferred: 200 + outcome, since the enum lives on the 200 body]; "If a conversion against a Currency Account would exceed the maximum balance limit, the request is rejected" [docs:multi-currency] (→ `REFUSED_MAX_BALANCE_EXCEEDED` [inferred]); "Manual currency conversions are processed immediately and cannot be cancelled, reversed, or amended once confirmed" [docs:multi-currency-wallets-feature-guide]; the two ledger movements are `FinancialTransaction`s with `transactionChannel` `CURRENCY_CLOUD_CLIENT_CONVERSION_OUT` (debit) / `CURRENCY_CLOUD_CLIENT_CONVERSION_IN` (credit) [spec enum names; the pairing to client-initiated conversions is inferred — `CURRENCY_CLOUD_CARD_CONVERSION_IN/OUT` exist for composite-auth conversions]; idempotency: `idempotencyKey` recognises retries [spec], and executing the same `quoteId` twice with different keys is unspecified [inferred: second attempt refused — a quote is booked once]; FX-provider minimum: conversions below the 1 GBP-equivalent floor are rounded up on the *liquidity* side with a 1% buffer while the customer ledger keeps the original amount [docs:minimum-conversion-rounding-logic] (no customer-visible effect).
- Webhooks: the newer docs say "A webhook is emitted for each account involved in the conversion once those balances are modified (both the debit and credit sides). The `conversionId` of the conversion can be found in each webhook notification." [docs:multi-currency-wallets-feature-guide]; the older page says "In the current release we are not providing a notification webhook for the outcome of the conversion" [docs:multi-currency-wallets-conversions]. In the webhook spec, `TransactionEventDto.transactionType` includes `CONVERSION_IN` ("Currency conversion buy (credit)") and `CONVERSION_OUT` ("Currency conversion sell (debit)") [webhook-spec], but **no `conversionId` property exists on `TransactionEventDto`** (verified) — see §7.

### GET /v1/fx/conversions/{conversionId} (getConversion)

- Purpose: "Get Conversion Details". Description verbatim: "Retrieve details of a previously executed FX conversion." [spec]. Not deprecated.
- Path params: `conversionId` — string, `format: uuid`, required, no description [spec].
- Request body: none.
- Response: `200 Success` → `ConversionDetailsResponse` (description "FX conversion details"), no required fields [spec]:
  - `buyAccountId` — string uuid, "Account ID to which funds were bought".
  - `buyAmount` — `CurrencyAmount`.
  - `conversionId` — string uuid, "Unique conversion identifier".
  - `conversionRate` — number, "Conversion rate executed".
  - `conversionTimestampUtc` — string date-time, "Timestamp when the conversion was executed (UTC)".
  - `creditTransactionId` — string uuid, "Transaction ID for credit".
  - `debitTransactionId` — string uuid, "Transaction ID for debit".
  - `fixedSide` — string enum `["BUY","SELL"]`, "Which side of the conversion was fixed (BUY or SELL)".
  - `quoteId` — string uuid, "Quote identifier used for this conversion".
  - `quoteMarginAdjustedRate` — number, "Quote rate including margin".
  - `quoteTimestampUtc` — string date-time, "Timestamp when the quote was created (UTC)".
  - `quoteUnadjustedRate` — number, "Quote rate excluding margin".
  - `sellAccountId` — string uuid, "Account ID from which funds were sold".
  - `sellAmount` — `CurrencyAmount`.
  Common error responses; **no 404 declared**.
- Behaviour: read-only; "The margin percentile equates to the difference between these two values" (`quoteMarginAdjustedRate` vs `quoteUnadjustedRate`) [docs:multi-currency]; also returns conversions produced by composite card authorisation ("for each conversion you can retrieve the market rate, the margin-adjusted rate, the executed rate, both currency amounts, the fixed side, timestamps, and the accounts involved") [docs:multi-currency-card-authorisation]; unknown `conversionId` → status unspecified [inferred: 404 with `ErrorResponse`, or 400 per the declared set].
- Webhooks: none.

### POST /v1/fx/conversions/search (searchConversions)

- Purpose: "Search FX Conversions By Transaction". Description verbatim: "Searches FX conversions linked to a given card-spend transaction." [spec]. Not deprecated.
- Path/query params: none.
- Request body (required): `SearchConversionsRequestBody` (description "Request to search FX conversions linked to a card-spend transaction"), `required: ["transactionId"]`
  - `transactionId` — string, **required**, `format: uuid`, "Card-spend transaction identifier whose linked conversions are sought" [spec].
- Response: `200 Success` → array of `ConversionDetailsResponse` (fields as in getConversion) [spec]. Common error responses.
- Behaviour: "A single card spend can produce one or more conversions — on the original authorisation, on increases, and on reversals. Each is individually linked back to the spend … The link is recorded when the hold is created, increased, and settled." [docs:multi-currency-card-authorisation]; "For settled transactions, use `transactionId` with Search Conversions" [docs:multi-currency-wallets-feature-guide]; composite-auth conversions fix the **BUY** side ("The platform buys the exact amount of target currency required to fund the shortfall") and use the card-spend margin and cached rates [docs:multi-currency-card-authorisation]; result for a transaction with no linked conversions is unspecified [inferred: empty array, 200].
- Webhooks: none (the linked conversions themselves emit the credit/debit transaction notifications described under executeConversion) [docs:multi-currency-card-authorisation].

### GET /v1/fx/rates (getFxRates)

- Purpose: "Get FX Indicative Rates". Description verbatim: "Returns indicative FX rates for one or more currency pairs — reference values for display or estimation, not tradeable. Each pair returns three rates: the raw mid-market rate (naked), the card-channel margin-adjusted rate, and the wallet-channel margin-adjusted rate. For a binding rate that can be transacted on, use POST /v1/fx/quotes + POST /v1/fx/conversions. Pairs are 6-character codes (sell + buy, e.g. 'AUDGBP'). Partial-success returns HTTP 200 with per-pair errors in the body; omitting currencyPairs returns an empty result." [spec]. Not deprecated.
- Query params: `currencyPairs` — array of string, optional, `nullable: true`, example `"AUDGBP,GBPAUD"`, "Comma-separated list of 6-char currency pairs (sell + buy) using uppercase ISO 4217 codes, e.g. 'AUDGBP,GBPAUD'. Duplicates are de-duplicated; malformed entries appear in the failures list. Omit to receive an empty result." [spec]. No `style`/`explode` declared, so OpenAPI default (`form`, exploded = repeated `currencyPairs=` params) applies formally while the description says comma-separated [spec]; accept both [inferred].
- Request body: none.
- Response: `200 "Success (response may include per-pair errors)"` → `FxRatesResponse` (description "Indicative FX rates response. May contain a mix of successes and failures.") = `{ failures: FxRateFailure[] ("Per-pair failures, one entry per requested pair that could not be resolved."), successes: FxRateEntry[] ("Successfully resolved rates, one entry per requested pair that was found.") }` [spec].
  - `FxRateEntry` (description "Indicative rate data for a single currency pair."), `required: ["bidRate","buyCurrency","lastRefreshedAtUtc","sellCurrency"]`: `bidRate` number ("Naked (unadjusted) bid rate."); `buyCurrency` `<ISO-162>` (example `"GBP"`); `cardMarginAdjustedBidRate` number nullable ("Bid rate adjusted for card-authorisation margin."); `lastRefreshedAtUtc` string date-time ("UTC timestamp at which the upstream cache last refreshed this rate.", example `"2026-05-20T01:23:45Z"`); `sellCurrency` `<ISO-162>` (example `"AUD"`); `walletMarginAdjustedBidRate` number nullable ("Bid rate adjusted for wallet-to-wallet margin.") [spec].
  - `FxRateFailure` (description "Per-pair failure context for a currency pair that could not be resolved."): `currencyPair` string ("Original pair string as supplied by the caller.", example `"XYZABC"`); `reason` string enum `["MALFORMED_PAIR","UNKNOWN_CURRENCY","CURRENCY_NOT_SUPPORTED"]` ("Machine-readable failure reason.") [spec].
  Common error responses.
- Behaviour: indicative only, never HTTP-fails per pair [spec]; "currently limited to AUD pairs but we can extend this to the broader supported data set in upcoming releases" [docs:indicative-rates-api] (→ non-AUD pair ⇒ `CURRENCY_NOT_SUPPORTED` [inferred]); rates are served from an upstream cache [spec: `lastRefreshedAtUtc` = "UTC timestamp at which the upstream cache last refreshed this rate."]; that it is the same short-lived cache card authorisation uses, "refreshed periodically (currently every 30 minutes)" [docs:multi-currency-card-authorisation], is [inferred] — that page never mentions the indicative rates API; `homeCurrencyBalanceEquivalent` on accounts is computed "using margin adjusted cached rates" [docs:multi-currency-wallets-feature-guide] — the same source [inferred]; pair parsing: exactly 6 uppercase letters, first 3 = sell, last 3 = buy, else `MALFORMED_PAIR`; a well-formed code not in ISO list ⇒ `UNKNOWN_CURRENCY` [inferred from reason names].
- Webhooks: none.

### GET /v1/fx/liquidity/balances (getLiquidityBalances)

- Purpose: "Get Liquidity Account Balances". Description verbatim: "Returns the available balance per currency held in the target liquidity account. Requires multi-currency wallets to be enabled for the client." [spec]. Not deprecated.
- Query params: `target` — string, **required**, enum `["CLIENT_HOUSE","TREASURY_RECON_SUB"]`, example `"TREASURY_RECON_SUB"`, "The account to read. Possible values: **CLIENT_HOUSE**: your own House Account, held in your Currency Cloud tenant / **TREASURY_RECON_SUB**: your reconciliation sub-account, held by Shaype" [spec].
- Request body: none.
- Response: `200 Success` → `LiquidityBalancesResponse` (description "The account the balances were read from, and the balances themselves") = `{ balances: CurrencyAmount[] ("The Currency Cloud balances, returned as-is: one entry per currency held, as the available amount in that currency's native precision. Empty when the account holds no funds.", example `[{"amount":1250.75,"currency":"AUD"},{"amount":99.1,"currency":"USD"}]`), target: enum as above ("The account the balances were read from") }` [spec]. Common error responses.
- Behaviour: pass-through read of Currency Cloud; not multi-currency-enabled client → error status unspecified [inferred: 403 or 422 `ErrorResponse`]; the liquidity account is where composite-auth conversions and the rounding surplus land ("The extra USD that Currencycloud delivered sits in the treasury position") [docs:minimum-conversion-rounding-logic].
- Webhooks: none.

### POST /v1/fx/liquidity/conversions (createLiquidityConversion)

- Purpose: "Create Liquidity Conversion". Description verbatim: "Converts one currency to another within the target liquidity account. Requires multi-currency wallets to be enabled for the client." [spec]. Not deprecated.
- Path/query params: none.
- Request body (required): `LiquidityConversionRequest` (description "Converts one currency to another within a single liquidity account. Passed straight through to Currency Cloud: no rate is quoted first and nothing is recorded against the Shaype ledger."), `required: ["amount","buyCurrency","fixedSide","idempotencyKey","sellCurrency","target"]`
  - `amount` — number, **required**, `minimum: 0`, `exclusiveMinimum: true`, "Amount to convert, in the fixed side's currency.", example `10000` [spec].
  - `buyCurrency` — string, **required**, `<ISO-162>`, "Currency to buy, as an ISO 4217 three-letter code.", example `"USD"` [spec].
  - `fixedSide` — string, **required**, enum `["BUY","SELL"]`, example `"SELL"`, "**BUY**: the buy side is fixed, the sell amount varies / **SELL**: the sell side is fixed, the buy amount varies" [spec].
  - `idempotencyKey` — string, **required**, `format: uuid`, "Unique value (UUID) used to identify this request and to recognise any subsequent retries." [spec].
  - `sellCurrency` — string, **required**, `<ISO-162>`, "Currency to sell, as an ISO 4217 three-letter code.", example `"AUD"` [spec].
  - `target` — string, **required**, enum `["CLIENT_HOUSE","TREASURY_RECON_SUB"]`, example `"CLIENT_HOUSE"`, "The account to convert within. …" [spec].
- Response: `200 Success` → `LiquidityConversionResponse` (description "The account a conversion was made within, and the conversion itself") = `{ conversion: LiquidityConversion, target: enum ("The account the conversion was made within") }` [spec]. `LiquidityConversion` ("A Currency Cloud conversion, returned as-is") has 29 optional fields — full list in §2; key ones: `conversionId` uuid ("Currency Cloud's conversion identifier"), `shortReference` (example `"20260821-ABCDEF"`), `status` string ("Current conversion status, as returned by Currency Cloud", example `"awaiting_funds"`), `currencyPair` (example `"AUDUSD"`), `clientRate`, `coreRate`, `midMarketRate`, `partnerRate`, `buyAmount`, `sellAmount`, `settlementDate`, `conversionDate`, `uniqueRequestId` ("The idempotency key echoed back by Currency Cloud") [spec]. Common error responses.
- Behaviour: no quote step, no margin, no Shaype ledger entry — treasury-only [spec]; `uniqueRequestId` = the request's `idempotencyKey` [spec]; Currency Cloud rejects conversions below its minimum (`conversion_below_limit`) [docs:minimum-conversion-rounding-logic] — how that surfaces here is unspecified [inferred: 422 `ErrorResponse`]; `status` values are Currency Cloud's and not enumerated (only `awaiting_funds` is shown) [spec].
- Webhooks: none documented.

### GET /v1/fx/liquidity/detailed-rates (getLiquidityDetailedRates)

- Purpose: "Get Liquidity Detailed Rate". Description verbatim: "Gets a detailed Currency Cloud rate for the target liquidity account. Rates can differ per target, as each quotes from its own tenant. Requires multi-currency wallets to be enabled for the client." [spec]. Not deprecated.
- Query params (all required except `conversionDate`) [spec]:
  - `target` — string, required, enum `["CLIENT_HOUSE","TREASURY_RECON_SUB"]`, example `"CLIENT_HOUSE"`, "The account to quote for. …".
  - `buyCurrency` — string, required, `<ISO-162>`, example `"USD"`, "Currency to buy, as an ISO 4217 three-letter code.".
  - `sellCurrency` — string, required, `<ISO-162>`, example `"AUD"`, "Currency to sell, as an ISO 4217 three-letter code.".
  - `fixedSide` — string, required, enum `["BUY","SELL"]`, example `"SELL"`, "The side of the trade to be fixed in value.".
  - `amount` — number, required, `minimum: 0`, `exclusiveMinimum: true`, example `10000`, "Amount to quote for, in the fixed side's currency.".
  - `conversionDate` — string `format: date`, optional, `nullable: true`, example `"2026-09-01"`, "Requested value date. When absent, Currency Cloud quotes for its earliest available date.".
- Request body: none.
- Response: `200 Success` → `LiquidityDetailedRatesResponse` (description "The account a rate was quoted for, and the rate itself") = `{ rate: LiquidityDetailedRate, target: enum ("The account the rate was quoted for") }` [spec]. `LiquidityDetailedRate` ("A Currency Cloud detailed rate, returned as-is"), all optional: `buyAmount` number ("Amount that would be bought"); `clientBuyCurrency` `<ISO-162>` ("Currency that would be bought"); `clientRate` number ("The rate that would be applied to a conversion"); `clientSellCurrency` `<ISO-162>` ("Currency that would be sold"); `coreRate` number ("The market rate"); `currencyPair` string (example `"AUDUSD"`, "Concatenated pair of currencies quoted"); `depositAmount` number ("The deposit amount that would be required"); `depositCurrency` `<ISO-162>` ("Currency the deposit is shown in"); `depositRequired` boolean ("Whether a deposit would be required"); `fixedSide` enum `["BUY","SELL"]` ("Which side of the trade is fixed in value"); `midMarketRate` number ("The mid point between the buy and sell rates"); `partnerRate` number ("The market rate plus Currency Cloud's commission, where applicable"); `sellAmount` number ("Amount that would be sold"); `settlementCutOffTime` string date-time ("When funds must be available for a trade at this rate to settle") [spec]. Common error responses.
- Behaviour: read-only, indicative, no locking (Currency Cloud "returns a quote and it books a conversion based on market conditions at the time of request") [docs:margins-and-quote-locking]; per-target tenant difference [spec].
- Webhooks: none.

### Liquidity API

Context [docs:liquidity-monitoring-and-alerting-1]: "Shaype provides Liquidity Monitoring & Alerting, where client-specific limits are configured, and daily liquidity is measured against these limits. Alert thresholds are set at 50%, 75%, and 90% of the limit. If a transaction causes the daily liquidity value to exceed one of these thresholds, an email notification is sent to the designated recipients." Alerts are **emails** to the address given at onboarding, not webhooks. Four threshold types; each "can be configured either as a specific amount or as a percentage of the relevant limit"; each has an `active` flag.

### GET /v1/liquidity (getClientLiquidity)

- Purpose: "Get client Liquidity" — "retrieve client liquidity for a specific date, including both scheme and non-scheme liquidity details" [spec][docs:liquidity-monitoring-and-alerting-1]. Not deprecated. No description.
- Query params: `date` — string, `format: date`, optional, `nullable: true`, "Optional date to retrieve Liquidity for" [spec]. Default when absent is not stated [inferred: today, in the platform's business-day timezone].
- Request body: none.
- Response: `200 Success` → `ClientLiquidity`, `required: ["clientReference","date","nonScheme","scheme"]` [spec]:
  - `clientReference` — string.
  - `date` — string `format: date`.
  - `nonScheme` — `NonSchemeLiquidity`, `required: ["bpay","directEntry","haas","npp","total"]` = `{ bpay: BPayLiquidity, directEntry: DirectEntryLiquidity, haas: HaasLiquidity, npp: NppLiquidity, total: number }`.
    - `BPayLiquidity`, `HaasLiquidity`, `NppLiquidity`, `DirectCreditLiquidity`, `DirectDebitLiquidity` each = `{ inbound: number, outbound: number, total: number }`, all three required.
    - `DirectEntryLiquidity` = `{ credit: DirectCreditLiquidity, debit: DirectDebitLiquidity, total: number }`, all required.
  - `scheme` — `SchemeLiquidity`, `required: ["domestic","international","total"]` = `{ domestic: number, international: number, total: number }`.
  No field has a description [spec]. Common error responses.
- Behaviour: read-only aggregate of the day's flows per channel [docs:liquidity-monitoring-and-alerting-1]; sign convention and the formula for each `total` (sum vs. net of `inbound`/`outbound`) are not stated anywhere — see §4/§7; which transaction channels feed `haas`, `npp`, `directEntry`, `bpay`, and `scheme.domestic`/`international` is not stated [inferred: `FinancialTransaction.transactionChannel` families `HAAS_TRANSFER_*`, `CUSCAL_NPP_*`, `CUSCAL_DE_*`, `CUSCAL_BPAY_*`, and `VISA_*`/`APPLE_PAY_*`/`GOOGLE_PAY_*` split by the `_INTERNATIONAL` suffix].
- Webhooks: none.

### GET /v1/liquidity/thresholds (getClientLiquidityThresholds)

- Purpose: "Get all liquidity alerting Thresholds" — "retrieve all active or inactive liquidity alerting thresholds created through the Create Liquidity Threshold API" [spec][docs:liquidity-monitoring-and-alerting-1]. Not deprecated.
- Query params: `active` — boolean, optional, `nullable: true`, "Determines whether to retrieve only active thresholds" [spec]. Semantics of `active=false` (only inactive vs. all) are not stated [inferred: filter `active == value`; absent ⇒ all].
- Request body: none.
- Response: `200 Success` → array of `LiquidityThreshold` (§2). Common error responses.
- Behaviour: read-only; "By default each of the payment channel will be set with 3 thresholds enabled at: 50%, 75% and 90%" [docs:liquidity-monitoring-and-alerting-1] — so a fresh client lists 12 percental thresholds [inferred]; whether platform defaults are flagged by `external: false` is not stated (see §7).
- Webhooks: none.

### POST /v1/liquidity/thresholds (createLiquidityThreshold)

- Purpose: "Create liquidity alerting Threshold" [spec]. Not deprecated. No description.
- Path/query params: none.
- Request body (required): `CreateThresholdRequestBody` (description "Body of a request to create a liquidity threshold alert."), `required: ["id","type"]` [spec]
  - `active` — boolean, optional, "Determines whether the threshold is active. If set to **false**,the threshold will not be checked and won't raise an alert in case of a breach."
  - `amount` — number, optional, `nullable: true`, `minimum: 1`, "Absolute monetary value for the threshold. Required if `percental` is set to **false**."
  - `id` — string, **required**, `format: uuid`, "Unique identifier (UUID) for the threshold." (client-supplied).
  - `percent` — integer int32, optional, `nullable: true`, `minimum: 1`, `maximum: 100`, "Relative percentage value for the threshold. Required if `percental` is set to **true**."
  - `percental` — boolean, optional, "Calculation method for the threshold: **true**: Threshold is set as a percentage of corresponding limit. When set to **true**, the `percent` field needs to be set. / **false**: Threshold is set as an absolute value. When set to **false**, the `amount` field needs to be set."
  - `type` — string, **required**, enum `["TOTAL_DAILY_INBOUND_DIRECT_DEBIT","TOTAL_DAILY_NET_NON_SCHEME","TOTAL_DAILY_NET_VISA","TOTAL_DAILY_OUTBOUND_BPAY"]`, "Liquidity threshold type: **TOTAL_DAILY_INBOUND_DIRECT_DEBIT**: Total daily inbound Direct Debits threshold / **TOTAL_DAILY_NET_NON_SCHEME**: Total daily non-scheme payments threshold / **TOTAL_DAILY_NET_VISA**: Total daily Visa card payments threshold / **TOTAL_DAILY_OUTBOUND_BPAY**: Total daily outbound BPAY payments threshold".
- Response: `200 Success` (not 201) → `LiquidityThreshold` [spec]. Common error responses.
- Behaviour / validation [docs:liquidity-monitoring-and-alerting-1]: "Between **0 and 10 max** different thresholds can be set" per type; percentage ⇒ "only values between **1 and 100**"; amount ⇒ "only positive values … **AND** whole amount **AND** must be between" 1 and the channel max (`TOTAL_DAILY_NET_NON_SCHEME`: Non-Scheme Float Account Cash Balance + Non-Scheme CM Liquidity Account Cash Balance; `TOTAL_DAILY_OUTBOUND_BPAY`: `BPAY_DAILY_LIMIT`; `TOTAL_DAILY_INBOUND_DIRECT_DEBIT`: `DIRECT_DEBIT_PER_DAY`; `TOTAL_DAILY_NET_VISA`: `CARD_PAYMENTS_DAILY`); "To use a fixed amount, set `percental = false` and specify the desired amount value, e.g., `$1000.`"; `percental=true` without `percent`, or `percental=false` without `amount` ⇒ validation error [spec descriptions] (status unspecified; [inferred] 400); `percental` absent ⇒ unspecified [inferred: treat as `true`, the "preferred configuration method"]; `active` absent ⇒ unspecified [inferred: `true`]; duplicate `id` ⇒ unspecified (no 409 declared) [inferred: 400/422]; exceeding 10 per type ⇒ unspecified [inferred: 422]; `clientReference` in the response is set from the caller's identity [inferred]. Idempotency: client-supplied `id` makes an exact retry detectable [inferred].
- Webhooks: none (alerts are emails).

### PUT /v1/liquidity/thresholds/{thresholdId} (updateLiquidityThreshold)

- Purpose: "Update liquidity alerting Threshold" — "modifies an existing liquidity threshold's value, type, or status to align with updated monitoring requirements" [spec][docs:liquidity-monitoring-and-alerting-1]. Not deprecated.
- Path params: `thresholdId` — string, `format: uuid`, required, "Threshold ID" [spec].
- Request body (required): `UpdateThresholdRequestBody` (description "Body of a request to update a liquidity threshold alert."), no required fields [spec]
  - `active` — boolean, optional, same description as create.
  - `amount` — number, optional, `nullable: true`, `minimum: 1`; description is a spec copy-paste error: "Relative percentage value for the threshold. Required if `percental` is set to **true**." (read as: absolute value, required if `percental` is false — matching create) [spec].
  - `percent` — integer int32, optional, `nullable: true`, `minimum: 1`, `maximum: 100`, same description as create.
  - `percental` — boolean, optional, same description as create.
  - **No `type` field** — the docs' "type" cannot be changed through this body [spec].
- Response: `200 Success` → `LiquidityThreshold` (the updated record) [spec]. Common error responses; **no 404 declared**.
- Behaviour: PUT with all-optional body — whether omitted fields are left unchanged (PATCH-like) or reset is not stated [inferred: unchanged]; same percent/amount rules as create [docs]; unknown `thresholdId` ⇒ unspecified [inferred: 404 `ErrorResponse`]; whether the platform default thresholds can be updated is not stated.
- Webhooks: none.

### Perks API

Context [spec tag]: "Customer value-added services (top-ups, gift cards, bill pay)". Catalogue reads (countries → operators → products) are cached upstream data ("matched to the cached operators" [spec]); ordering is asynchronous with a final status delivered by the `PERK_ORDER_UPDATE` webhook [webhook-spec]. No docs page exists for Perks beyond the reference pages, which are the spec verbatim (verified).

### GET /v1/perks/countries (getCountries)

- Purpose: "Gets the countries where perks are available (optionally filtered by perkType)" [spec]. Not deprecated.
- Query params: `perkType` (optional, enum `["MOBILE_TOP_UP","UTILITIES","GIFT_CARDS","ESIM"]`, "PerkType to filter by; omit to return all countries"); `limit`; `offset` (see Conventions) [spec].
- Request body: none.
- Response: `200 Success` → array of `CountrySummary` (description "A country where perks are available.") = `{ isoCode: string ("ISO 3166-1 alpha-3 country code", example "SGP"), name: string ("Country name", example "Singapore"), regions: RegionSummary[] ("Regions or states within the country") }`; `RegionSummary` ("A region or state within a country.") = `{ code: string ("Region code"), name: string ("Region name") }` [spec]. Common error responses.
- Behaviour: read-only catalogue; ordering unspecified [inferred: by `name`].
- Webhooks: none.

### GET /v1/perks/operators (getOperators)

- Purpose: "Gets the operators available as perks (optionally filtered by perkType and country)" [spec]. Not deprecated.
- Query params: `perkType` (optional, enum as above, "PerkType to filter by; omit to return all operators"); `country` (string, optional, "Country ISO 3166-1 alpha-3 code to filter by; omit for all countries"); `limit`; `offset` [spec].
- Request body: none.
- Response: `200 Success` → array of `OperatorSummary` (description "An operator (mobile/utility provider) whose products are available as perks.") = `{ countryIsoCode: string ("ISO 3166-1 alpha-3 country code", example "IDN"), id: string uuid ("Operator identifier", example "3f2504e0-4f89-41d3-9a0c-0305e82c3301"), name: string ("Operator name", example "Telkomsel"), regions: RegionSummary[] ("Regions or states the operator serves") }` [spec]. Common error responses.
- Behaviour: read-only catalogue; an operator's perk type is not a field on `OperatorSummary`, so `perkType` filtering must be derived from the operator's products [inferred].
- Webhooks: none.

### GET /v1/perks/operators/{id} (getOperatorById)

- Purpose: "Gets a single perk operator by its id" [spec]. Not deprecated.
- Path params: `id` — string, `format: uuid`, required, no description [spec].
- Request body: none.
- Response: `200 Success` → `OperatorSummary`. `404` declared, described "Operator not found", **with schema `OperatorSummary`** (spec quirk) [spec]. Common error responses.
- Behaviour: read-only; unknown id ⇒ 404 [spec]; body on 404 [inferred: `ErrorResponse`, since `OperatorSummary` on a 404 is almost certainly a generator artefact].
- Webhooks: none.

### POST /v1/perks/operators/by-mobile-number (lookupOperators)

- Purpose: "Looks up the operators for a mobile number, matched to the cached operators" [spec]. Not deprecated.
- Path/query params: none.
- Request body (required): `MobileNumberLookupRequestBody` (description "Request to look up operators for a given mobile number."), `required: ["mobileNumber"]`
  - `mobileNumber` — string, **required**, `minLength: 1`, `pattern: ^\+[1-9][0-9]{6,14}$`, "Mobile number in E.164 format", example `"+6591234567"` [spec].
- Response: `200 Success` → array of `MobileNumberOperatorSummary` (description "An operator returned by a mobile-number lookup, flagged when it is the identified match.") = `{ identified: boolean ("Whether this operator was identified as the direct match for the mobile number", example true), operator: OperatorSummary }` [spec]. Common error responses.
- Behaviour: pattern violation ⇒ validation error [spec] (status [inferred] 400); result semantics — the operator detected for the number carries `identified: true`, other operators in the number's country carry `false` [inferred from the description]; no match ⇒ unspecified [inferred: empty array].
- Webhooks: none.

### GET /v1/perks/products (getProducts)

- Purpose: "Gets the products available as perks (optionally filtered by perkType, country and operator)" [spec]. Not deprecated.
- Query params: `perkType` (optional, enum as above, "PerkType to filter by; omit to return all products"); `country` (string, optional, "Country ISO 3166-1 alpha-3 code to filter by; omit for all countries"); `operatorId` (string uuid, optional, "Operator id to filter by; omit for all operators"); `limit`; `offset` [spec].
- Request body: none.
- Response: `200 Success` → array of `ProductSummary` (full field list in §2; enums: `type` ∈ `["FIXED_VALUE_RECHARGE","RANGED_VALUE_RECHARGE","FIXED_VALUE_PIN_PURCHASE","RANGED_VALUE_PIN_PURCHASE","RANGED_VALUE_PAYMENT"]`, `perkSubType` ∈ `["AIRTIME","BUNDLE","DATA","ELECTRICITY","WATER","GAS","INTERNET","LANDLINE","TELEVISION","VOIP","RETAIL","GAMING","CASH_CARDS","FOOD","ENTERTAINMENT","TRAVEL_AND_TRANSPORT","ESIM"]`) [spec]. Common error responses.
- Behaviour: read-only catalogue; `ProductSummary` has no `perkType` field — the `perkType` filter must map from `perkSubType` [inferred: AIRTIME/BUNDLE/DATA → MOBILE_TOP_UP; ELECTRICITY/WATER/GAS/INTERNET/LANDLINE/TELEVISION/VOIP → UTILITIES; RETAIL/GAMING/CASH_CARDS/FOOD/ENTERTAINMENT/TRAVEL_AND_TRANSPORT → GIFT_CARDS; ESIM → ESIM — grouping not stated anywhere].
- Webhooks: none.

### GET /v1/perks/products/{id} (getProductById)

- Purpose: "Gets a single perk product by its id" [spec]. Not deprecated.
- Path params: `id` — string, `format: uuid`, required [spec].
- Request body: none.
- Response: `200 Success` → `ProductSummary`. `404` declared, described "Product not found", **with schema `ProductSummary`** (spec quirk) [spec]. Common error responses.
- Behaviour: read-only; unknown id ⇒ 404 [spec]; body [inferred: `ErrorResponse`].
- Webhooks: none.

### GET /v1/perks/orders (getOrders)

- Purpose: "Gets perk orders (last 24h unless filtered by externalId or a from/to window of max 24h)" [spec]. Not deprecated.
- Query params (all optional) [spec]: `perkType` (enum as above, "PerkType to filter by"); `country` (string, "Country ISO 3166-1 alpha-3 code to filter by"); `operatorId` (string uuid, "Operator id to filter by"); `externalId` (string uuid, "External reference an order was created with"); `productType` (string — **no enum declared**, "Product type to filter by, e.g. FIXED_VALUE_RECHARGE"); `fromDate` (string — no format, "Created-from timestamp (ISO 8601); window to toDate max 24h"); `toDate` (string, "Created-to timestamp (ISO 8601)"); `limit`; `offset` (int32, min 0, default 0, "Number of results to skip; defaults to 0, must be a multiple of limit").
- Request body: none.
- Response: `200 Success` → array of `OrderSummary` (§2) [spec]. Common error responses.
- Behaviour: default window = last 24 hours from now, unless `externalId` given (exact match, no window) or a `fromDate`/`toDate` window ≤ 24h [spec summary]; window > 24h ⇒ error, status unspecified [inferred: 400]; `offset` not a multiple of `limit` ⇒ error [spec], status unspecified [inferred: 400]; `fromDate` without `toDate` (or vice versa) ⇒ unspecified [inferred: open end clamped to 24h]; `productType` values are `ProductSummary.type` values [inferred from the example]; ordering unspecified [inferred: `createdAt` desc].
- Webhooks: none.

### POST /v1/perks/orders (createOrder)

- Purpose: "Places an order for a perk product, delivered to the given beneficiary" [spec]. Not deprecated.
- Path/query params: none.
- Request body (required): `CreateOrderRequestBody` (description "Request to place a perk order."), `required: ["externalId","productId"]` [spec]
  - `beneficiary` — `Party`, optional.
  - `calculationMode` — string, optional, enum `["SOURCE_AMOUNT","DESTINATION_AMOUNT"]` (also `pattern: SOURCE_AMOUNT|DESTINATION_AMOUNT`), "Required for ranged products".
  - `creditPartyIdentifier` — `PartyIdentifier`, optional.
  - `debitPartyIdentifier` — `PartyIdentifier`, optional.
  - `destination` — `Money`, optional.
  - `externalId` — string, **required**, `format: uuid`, "Caller-specified external reference; must be unique per order".
  - `productId` — string, **required**, `format: uuid`, "Product identifier to order".
  - `purchaserId` — string, optional, `format: uuid`, "Purchaser id; see product requiredAdditionalIdentifierFields".
  - `sender` — `Party`, optional.
  - `source` — `Money`, optional.
  - `statementIdentifier` — `StatementIdentifier`, optional.
  - Nested shapes [spec]: `Party` ("A person taking part in the order.") = `{ addressCity, addressCountryIsoCode ("Address country ISO 3166-1 alpha-3 code"), addressPostalCode, addressText ("Street address"), email, firstName, lastName, middleName, mobileNumber (pattern ^\+[1-9][0-9]{6,14}$, "Mobile number in E.164 format"), nationalityCountryIsoCode ("Nationality ISO 3166-1 alpha-3 code") }`, all strings, none required. `PartyIdentifier` ("An account taking part in the order.") = `{ accountNumber ("Account number"), accountQualifier ("Account qualifier, when the operator requires one"), mobileNumber (same pattern, example "+6591234567") }`, none required. `Money` ("A monetary amount.") = `{ amount: number double (example 5), currency: string ("ISO currency code", example "USD") }`, both required. `StatementIdentifier` ("A bill or statement reference.") = `{ dueDate: string ("Statement due date (ISO 8601 date)"), reference: string ("Statement or bill reference") }`, none required.
- Response: **`201 Created`** → `OrderSummary` (§2) [spec]. Common error responses (no 409).
- Behaviour: which optional groups are mandatory is data-driven by the product's `requiredBeneficiaryFields`, `requiredSenderFields`, `requiredCreditPartyIdentifierFields`, `requiredDebitPartyIdentifierFields`, `requiredStatementIdentifierFields`, `requiredAdditionalIdentifierFields` — each an array of alternative field-name combinations, "provide all fields of one combination" [spec]; for ranged products (`RANGED_VALUE_*`) `calculationMode` is required and exactly one of `source`/`destination` is the fixed amount, which must lie within the product's `MonetaryValue.min`/`max` [spec descriptions; range check inferred]; for fixed products the amount is the product's `MonetaryValue.amount` [inferred]; `externalId` must be unique per order [spec] — duplicate ⇒ status unspecified [inferred: 422, or idempotent replay of the original order]; unknown `productId` ⇒ unspecified [inferred: 422]; the order is created in a non-final state and the final `status` (`COMPLETED` | `DECLINED` | `REVERSED`) arrives via webhook [webhook-spec]; **how the order is funded from a Shaype account is not stated anywhere** — there is no `accountId`/`customerId` in the request (see §7); `pinCode`/`pinSerial`/`redemption` are populated only for PIN-based products [spec][webhook-spec]; populated on `COMPLETED` [inferred — neither spec says when; the webhook carries them alongside a `status` that may be COMPLETED, DECLINED or REVERSED].
- Webhooks: `PERK_ORDER_UPDATE` on the v1 notification stream (`POST /api/hay/v1/communications/notification`): `NotificationDtoV1 { idempotencyKey (uuid, required), type: "PERK_ORDER_UPDATE" (required), createdTimeUtc, actionOwner: CLIENT|PLATFORM, eventDetails: PerkOrderUpdateEventDto }`; `PerkOrderUpdateEventDto` = `EventDetailsDto { eventType: "PERK_ORDER_UPDATE" }` + `{ orderExternalId: uuid ("The externalId the perk order was created with."), status: enum ["COMPLETED","DECLINED","REVERSED"] ("Final order status."), pinCode ("PIN code, for PIN-based products."), pinSerial ("PIN serial, for PIN-based products."), confirmedTimeUtc: date-time ("DateTime of when the order was confirmed."), redemption: RedemptionDto { usageInfo: string[], terms: string (Markdown), validity: ValidityDto { unit: string (example "DAY"), quantity: int32 ("Unit count; -1 unlimited, null unknown.", example 365) } } }` [webhook-spec].

## 2. Entities and fields

All types below are from `components.schemas` [spec] unless marked `[webhook-spec]`. "req" = listed in the schema's `required` array; everything else is optional and, absent `nullable: true`, the spec does not say whether it is omitted or `null` when unset. Examples are the spec's property-level `example` values.

### CurrencyAmount (shared value object)
Description "Monetary value and currency". Used by: `ConversionQuoteResponse`, `ConversionExecuteResponse`, `ConversionDetailsResponse`, `LiquidityBalancesResponse.balances[]`.

| field | type | req | notes |
|---|---|---|---|
| `amount` | number | yes | "Amount of the transaction to 2 decimal places" |
| `currency` | string enum `<ISO-162>` | yes | "Currency as three letter code as per ISO 4217" |

`<ISO-162>` verbatim (162 values, verified identical at all 14 sites in this domain): `AED, AFN, ALL, AMD, ANG, AOA, ARS, AUD, AWG, AZN, BAM, BBD, BDT, BGN, BHD, BIF, BMD, BND, BOB, BOV, BRL, BSD, BTN, BWP, BYN, BZD, CAD, CDF, CHF, CLP, CNH, CNY, COP, CRC, CUC, CUP, CVE, CZK, DJF, DKK, DOP, DZD, EGP, ERN, ETB, EUR, FJD, FKP, GBP, GEL, GHS, GIP, GMD, GNF, GTQ, GYD, HKD, HNL, HRK, HTG, HUF, IDR, ILS, INR, IQD, IRR, ISK, JMD, JOD, JPY, KES, KGS, KHR, KMF, KPW, KRW, KWD, KYD, KZT, LAK, LBP, LKR, LRD, LSL, LYD, MAD, MDL, MGA, MKD, MMK, MNT, MOP, MRU, MUR, MVR, MWK, MXN, MYR, MZN, NAD, NGN, NIO, NOK, NPR, NZD, OMR, PAB, PEN, PGK, PHP, PKR, PLN, PYG, QAR, RON, RSD, RUB, RWF, SAR, SBD, SCR, SDG, SEK, SGD, SHP, SLE, SLL, SOS, SRD, SSP, STN, SVC, SYP, SZL, THB, TJS, TMT, TND, TOP, TRY, TTD, TWD, TZS, UAH, UGX, USD, UYU, UZS, VES, VND, VUV, WST, XAF, XCD, XCG, XOF, XPF, YER, ZAR, ZMW, ZWG, ZWL`.

### FX quote — `ConversionQuoteResponse`
Description "FX conversion quote with buy/sell amounts". Created by `generateConversionQuote`; consumed (by `quoteId`) by `executeConversion`; its rates are echoed on `ConversionDetailsResponse.quote*`. No status field; expiry is implicit via `expiresAtUtc`.

| field | type | req | notes |
|---|---|---|---|
| `quoteId` | string uuid | no | "Unique quote identifier" |
| `rate` | number | no | "Exchange rate for the conversion" (margin-adjusted [docs:margins-and-quote-locking]) |
| `buyAmount` | `CurrencyAmount` | no | |
| `sellAmount` | `CurrencyAmount` | no | |
| `expiresAtUtc` | string date-time | no | "Timestamp when the quote expires (UTC)" |

Stored-but-unexposed inputs the stub must keep against the quote to serve later operations: `sellAccountId`, `buyCurrency`, `fixedSide`, `amount`, `marginPercentage`/effective margin, unadjusted rate, `idempotencyKey`, created timestamp [inferred from `ConversionDetailsResponse` fields].

### FX conversion — `ConversionExecuteResponse` (create result) and `ConversionDetailsResponse` (read model)
Created by `executeConversion` (customer-initiated) and by composite card authorisation (platform-initiated) [docs:multi-currency-card-authorisation]; read by `getConversion`, `searchConversions`.

`ConversionExecuteResponse` ("FX conversion execution result"):

| field | type | req | notes |
|---|---|---|---|
| `conversionId` | string uuid | no | "Unique conversion identifier" |
| `quoteId` | string uuid | no | "Quote ID that was executed" |
| `outcome` | string enum | no | `ACCEPTED, INTERNAL_ERROR, REFUSED_LIMIT_BREACH, REFUSED_FRAUD, REFUSED_CUSTOMER_PREFERENCE, REFUSED_INSUFFICIENT_FUNDS, REFUSED_ACCOUNT_BLOCKED, REFUSED_RECIPIENT_ACCOUNT_BLOCKED, REFUSED_ACCOUNT_CLOSED, REFUSED_RECIPIENT_ACCOUNT_CLOSED, REFUSED_INVALID_PAY_ID, UNKNOWN, REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED, REFUSED_MAX_BALANCE_EXCEEDED, REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED, REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED, REFUSED_TOTAL_NET_VISA_DAILY_LIMIT_BREACHED, REFUSED_TOTAL_NON_SCHEME_DAILY_LIMIT_BREACHED, REFUSED_SENDER_ACCOUNT_NOT_VERIFIED, REFUSED_CAPABILITY_NOT_ENABLED, REFUSED_QUOTE_EXPIRED` (21 values, verbatim order) |
| `buyAmount` / `sellAmount` | `CurrencyAmount` | no | |
| `debitTransactionId` | string uuid | no | "ID of the debit transaction" |
| `creditTransactionId` | string uuid | no | "ID of the credit transaction" |

`ConversionDetailsResponse` ("FX conversion details") — 14 fields, none required: `conversionId` uuid; `quoteId` uuid; `sellAccountId` uuid ("Account ID from which funds were sold"); `buyAccountId` uuid ("Account ID to which funds were bought"); `sellAmount`, `buyAmount` `CurrencyAmount`; `fixedSide` enum `BUY|SELL`; `conversionRate` number ("Conversion rate executed"); `quoteUnadjustedRate` number ("Quote rate excluding margin"); `quoteMarginAdjustedRate` number ("Quote rate including margin"); `quoteTimestampUtc` date-time; `conversionTimestampUtc` date-time; `debitTransactionId`, `creditTransactionId` uuid. Linkage to a card-spend `transactionId` (for `searchConversions`) is stored but not exposed on this model [spec].

### Indicative rates — `FxRatesResponse`, `FxRateEntry`, `FxRateFailure`
Read-only, produced by `getFxRates` from the rate cache. `FxRatesResponse` = `{ successes: FxRateEntry[], failures: FxRateFailure[] }`.

| entity.field | type | req | notes |
|---|---|---|---|
| `FxRateEntry.sellCurrency` | `<ISO-162>` | yes | example `AUD` |
| `FxRateEntry.buyCurrency` | `<ISO-162>` | yes | example `GBP` |
| `FxRateEntry.bidRate` | number | yes | "Naked (unadjusted) bid rate." |
| `FxRateEntry.cardMarginAdjustedBidRate` | number, nullable | no | "Bid rate adjusted for card-authorisation margin." |
| `FxRateEntry.walletMarginAdjustedBidRate` | number, nullable | no | "Bid rate adjusted for wallet-to-wallet margin." |
| `FxRateEntry.lastRefreshedAtUtc` | string date-time | yes | example `2026-05-20T01:23:45Z` |
| `FxRateFailure.currencyPair` | string | no | "Original pair string as supplied by the caller.", example `XYZABC` |
| `FxRateFailure.reason` | string enum | no | `MALFORMED_PAIR, UNKNOWN_CURRENCY, CURRENCY_NOT_SUPPORTED` |

### Liquidity (treasury) account — `LiquidityBalancesResponse`, `LiquidityConversion`, `LiquidityDetailedRate`
Currency Cloud pass-through models; the stub needs a per-`target` (`CLIENT_HOUSE` | `TREASURY_RECON_SUB`) multi-currency balance table. Read by `getLiquidityBalances`, `getLiquidityDetailedRates`; written by `createLiquidityConversion` (and, in the real platform, by composite-auth conversions and the rounding surplus [docs:minimum-conversion-rounding-logic]).

`LiquidityBalancesResponse` = `{ target: enum, balances: CurrencyAmount[] }` (example `[{"amount":1250.75,"currency":"AUD"},{"amount":99.1,"currency":"USD"}]`; "Empty when the account holds no funds").

`LiquidityConversionResponse` = `{ target: enum ("The account the conversion was made within"), conversion: LiquidityConversion }`. `LiquidityConversion` ("A Currency Cloud conversion, returned as-is"), 29 fields, none required:

| field | type | notes |
|---|---|---|
| `conversionId` | string uuid | "Currency Cloud's conversion identifier" |
| `shortReference` | string | "Human readable trade identifier", example `20260821-ABCDEF` |
| `accountId` | string uuid | "Currency Cloud identifier of the account the conversion belongs to" |
| `creatorContactId` | string uuid | "Currency Cloud identifier of the contact that requested the conversion" |
| `status` | string | "Current conversion status, as returned by Currency Cloud", example `awaiting_funds` (no enum) |
| `currencyPair` | string | "Concatenated pair of currencies traded", example `AUDUSD` |
| `buyCurrency` / `sellCurrency` | `<ISO-162>` | "Currency bought" / "Currency sold" |
| `buyAmount` / `sellAmount` | number | "Amount bought" / "Amount sold" |
| `fixedSide` | enum `BUY|SELL` | "Which side of the trade was fixed in value" |
| `clientRate` | number | "The rate applied to the conversion" |
| `coreRate` | number | "The market rate" |
| `midMarketRate` | number | "The mid point between the buy and sell rates" |
| `partnerRate` | number | "The market rate plus Currency Cloud's commission, where applicable" |
| `partnerBuyAmount` / `partnerSellAmount` | number | "Partner-side amount bought" / "… sold" |
| `conversionDate` | string date-time | "The date the conversion is made" |
| `settlementDate` | string date-time | "When funds must be available for the trade to settle" |
| `createdAt` / `updatedAt` | string date-time | "When the conversion was created" / "… last updated" |
| `depositRequired` | boolean | "Whether a deposit is required for the conversion" |
| `depositAmount` | number | "The deposit amount required" |
| `depositCurrency` | `<ISO-162>` | "Currency the deposit is shown in" |
| `depositRequiredAt` | string date-time | "When the deposit is required by" |
| `depositStatus` | string | "Current status of the deposit" (no enum) |
| `paymentIds` | string[] | "Identifiers of any payments related to the conversion" |
| `unallocatedFunds` | number | "Funds not yet allocated to the conversion" |
| `uniqueRequestId` | string | "The idempotency key echoed back by Currency Cloud" |

`LiquidityDetailedRatesResponse` = `{ target: enum, rate: LiquidityDetailedRate }`; `LiquidityDetailedRate` fields (14, none required) are listed under `getLiquidityDetailedRates` in §1.

### Client liquidity snapshot — `ClientLiquidity`
Read-only, produced by `getClientLiquidity` for one `date`. All numbers, no descriptions, everything required [spec].

| path | type | req |
|---|---|---|
| `clientReference` | string | yes |
| `date` | string date | yes |
| `scheme.domestic`, `scheme.international`, `scheme.total` | number | yes |
| `nonScheme.total` | number | yes |
| `nonScheme.bpay.{inbound,outbound,total}` | number | yes |
| `nonScheme.haas.{inbound,outbound,total}` | number | yes |
| `nonScheme.npp.{inbound,outbound,total}` | number | yes |
| `nonScheme.directEntry.total` | number | yes |
| `nonScheme.directEntry.credit.{inbound,outbound,total}` | number | yes |
| `nonScheme.directEntry.debit.{inbound,outbound,total}` | number | yes |

### LiquidityThreshold
Created by `createLiquidityThreshold`, updated by `updateLiquidityThreshold`, listed by `getClientLiquidityThresholds`. `required: ["clientReference","id","type"]`. No field descriptions on this schema (descriptions come from the request bodies in §1).

| field | type | req | notes |
|---|---|---|---|
| `id` | string uuid | yes | client-supplied on create |
| `clientReference` | string, `minLength: 1` | yes | set by platform [inferred] |
| `type` | string enum | yes | `TOTAL_DAILY_INBOUND_DIRECT_DEBIT, TOTAL_DAILY_NET_NON_SCHEME, TOTAL_DAILY_NET_VISA, TOTAL_DAILY_OUTBOUND_BPAY` |
| `active` | boolean | no | |
| `percental` | boolean | no | true ⇒ `percent` used; false ⇒ `amount` used |
| `percent` | integer int32, nullable, 1–100 | no | |
| `amount` | number, nullable, `minimum: 1` | no | |
| `external` | boolean | no | **undocumented** — not in either request body; [inferred] `true` for client-created thresholds vs. platform defaults |

Example (docs, prose): `percental = false`, amount `$1000` [docs:liquidity-monitoring-and-alerting-1].

### Perk catalogue — `CountrySummary`, `RegionSummary`, `OperatorSummary`, `MobileNumberOperatorSummary`, `ProductSummary`, `MonetaryValue`, `RedemptionDetails`, `RedemptionValidity`
Read-only reference data (seeded by the stub). Read by `getCountries`, `getOperators`, `getOperatorById`, `lookupOperators`, `getProducts`, `getProductById`, `getAllProducts`.

| entity.field | type | notes / example |
|---|---|---|
| `CountrySummary.isoCode` | string | "ISO 3166-1 alpha-3 country code", `SGP` |
| `CountrySummary.name` | string | `Singapore` |
| `CountrySummary.regions` | `RegionSummary[]` | "Regions or states within the country" |
| `RegionSummary.code` / `.name` | string | "Region code" / "Region name" |
| `OperatorSummary.id` | string uuid | `3f2504e0-4f89-41d3-9a0c-0305e82c3301` |
| `OperatorSummary.name` | string | `Telkomsel` |
| `OperatorSummary.countryIsoCode` | string | `IDN` |
| `OperatorSummary.regions` | `RegionSummary[]` | "Regions or states the operator serves" |
| `MobileNumberOperatorSummary.identified` | boolean | example `true` |
| `MobileNumberOperatorSummary.operator` | `OperatorSummary` | |
| `ProductSummary.id` | string uuid | `3f2504e0-4f89-41d3-9a0c-0305e82c3301` |
| `ProductSummary.name` | string | `Telkomsel 5000` |
| `ProductSummary.description` | string | "Product description" |
| `ProductSummary.type` | enum | `FIXED_VALUE_RECHARGE, RANGED_VALUE_RECHARGE, FIXED_VALUE_PIN_PURCHASE, RANGED_VALUE_PIN_PURCHASE, RANGED_VALUE_PAYMENT`; example `FIXED_VALUE_RECHARGE` |
| `ProductSummary.perkSubType` | enum | `AIRTIME, BUNDLE, DATA, ELECTRICITY, WATER, GAS, INTERNET, LANDLINE, TELEVISION, VOIP, RETAIL, GAMING, CASH_CARDS, FOOD, ENTERTAINMENT, TRAVEL_AND_TRANSPORT, ESIM`; example `AIRTIME` |
| `ProductSummary.countryIsoCode` | string | `IDN` |
| `ProductSummary.operatorId` | string uuid | |
| `ProductSummary.operatorName` | string | `Telkomsel` |
| `ProductSummary.source` / `.destination` | `MonetaryValue` | what the purchaser pays / what the beneficiary receives [inferred from names] |
| `ProductSummary.redemption` | `RedemptionDetails` | |
| `ProductSummary.requiredBeneficiaryFields`, `.requiredSenderFields`, `.requiredCreditPartyIdentifierFields`, `.requiredDebitPartyIdentifierFields`, `.requiredStatementIdentifierFields`, `.requiredAdditionalIdentifierFields` | `string[][]` | "<group> fields required to order; provide all fields of one combination" |
| `MonetaryValue.amount` | number double | "Fixed amount; null for ranged products" |
| `MonetaryValue.min` / `.max` | number double | "Range lower bound; null for fixed products" / "Range upper bound; null for fixed products" |
| `MonetaryValue.currency` | string (no enum) | "ISO currency code", `USD` |
| `RedemptionDetails.terms` | string | "Restrictions and terms; Markdown formatted" |
| `RedemptionDetails.usageInfo` | string[] | "Instructions on how to redeem the PIN" |
| `RedemptionDetails.validity` | `RedemptionValidity` | |
| `RedemptionValidity.quantity` | integer int32 | "Unit count; -1 unlimited, null unknown", example `365` |
| `RedemptionValidity.unit` | string | "Time unit", example `DAY` |

Note `ProductSummary` has **no `perkType`** field, and `OperatorSummary`/`CountrySummary` have no perk-type field either, although all three list endpoints filter by `perkType` [spec].

### Perk order — `OrderSummary` (+ `Money`, `Party`, `PartyIdentifier`, `StatementIdentifier`)
Created by `createOrder` (201), listed by `getOrders`, finalised by the `PERK_ORDER_UPDATE` webhook. 15 fields, none required.

| field | type | notes / example |
|---|---|---|
| `externalId` | string uuid | "Caller-specified external reference of the order", `3f2504e0-4f89-41d3-9a0c-0305e82c3301`; the only order identifier exposed (there is no platform `orderId`) |
| `productId` | string uuid | |
| `productName` | string | `Telkomsel 5000` |
| `operatorId` | string uuid | |
| `countryIsoCode` | string | `IDN` |
| `perkType` | enum | `MOBILE_TOP_UP, UTILITIES, GIFT_CARDS, ESIM` |
| `source` / `destination` | `Money` | |
| `status` | string (**no enum**) | "Order status", example `COMPLETED` |
| `statusClass` | string (**no enum**) | "Order status class", example `COMPLETED` |
| `createdAt` | string (no format) | "When the order was created (ISO 8601)" |
| `confirmedAt` | string (no format) | "When the order was confirmed (ISO 8601)" |
| `pinCode` / `pinSerial` | string | "PIN code, for PIN-based products" / "PIN serial, for PIN-based products" |
| `redemption` | `RedemptionDetails` | |

`Money` = `{ amount: number double (req, example 5), currency: string (req, "ISO currency code", example "USD") }`. `Party`, `PartyIdentifier`, `StatementIdentifier` field lists are under `createOrder` in §1; they are request-only and not echoed on `OrderSummary` [spec].

### HayMerchantCategoryCode
Read-only reference row for `getAllMerchantCategoryCodes`: `code` integer int32 ("Merchant Category Code (MCC) as four digit code as per ISO 18245"), `description` string. Neither required.

### Token responses
`ExchangeExternalTokenResponse` = `{ accessToken: string, accessExpiresUtc: integer int64, installationHandle: string }`; `ElevateExternalTokenResponse` = `{ elevationHeader: string }`. No descriptions, nothing required, nothing persisted by contract (a stub may keep issued tokens to make `elevate` validate `externalAccessToken` [inferred]).

### Request-only bodies
`EnrolCardToClickToPayRequestBody`, `ExchangeExternalTokenRequestBody`, `ElevateExternalTokenRequestBody`, `ConversionQuoteRequest`, `ConversionExecuteRequest`, `SearchConversionsRequestBody`, `LiquidityConversionRequest`, `CreateThresholdRequestBody`, `UpdateThresholdRequestBody`, `MobileNumberLookupRequestBody`, `CreateOrderRequestBody` — every field, constraint and enum is spelled out under the owning operation in §1.

### Common — `GenericMessage`, `ErrorResponse`
See Conventions.

### Webhook DTOs `[webhook-spec]`
- `NotificationDtoV1` ("Details of event the v1 notification"), `required: ["idempotencyKey","type"]`: `idempotencyKey` uuid ("Idempotency key (UUID) to uniquely represent this request and prevent duplication."); `type` enum `["BATCH_COMPLETED","PERK_ORDER_UPDATE"]`; `createdTimeUtc` date-time; `actionOwner` enum `["CLIENT","PLATFORM"]` ("**CLIENT**: Client executed an action which triggered the event. **PLATFORM**: Shaype executed an action which triggered the event."); `eventDetails` oneOf `BatchCompletedEventDto` | `PerkOrderUpdateEventDto`, discriminated by `EventDetailsDto.eventType` (same enum).
- `PerkOrderUpdateEventDto` ("Details of the **Perk Order Update** event; provided when the type is `PERK_ORDER_UPDATE`."): `orderExternalId` uuid; `status` enum `["COMPLETED","DECLINED","REVERSED"]` ("Final order status."); `pinCode`; `pinSerial`; `confirmedTimeUtc` date-time; `redemption: RedemptionDto { usageInfo: string[], terms: string, validity: ValidityDto { unit: string (example "DAY"), quantity: int32 (example 365, "-1 unlimited, null unknown") } }`.

## 3. State machines

This domain exposes very few status fields. Everything below that is not `[spec]`/`[webhook-spec]` is implicit lifecycle the stub must model internally.

### Perk order `status` (`OrderSummary.status` — free string; final values from `PerkOrderUpdateEventDto.status` `[webhook-spec]`)
Values documented: `COMPLETED`, `DECLINED`, `REVERSED` ("Final order status.") [webhook-spec]. The initial (non-final) value written by `createOrder` is **not documented anywhere**; `OrderSummary.statusClass` ("Order status class", example `COMPLETED`) is a second free string whose relationship to `status` is undocumented.

| from | to | via |
|---|---|---|
| — | *(initial, undocumented)* | `createOrder` (201) [spec] |
| *(initial)* | `COMPLETED` | platform; `PERK_ORDER_UPDATE` webhook, `confirmedTimeUtc`/`pinCode`/`pinSerial`/`redemption` populated; `OrderSummary.confirmedAt` set [webhook-spec][inferred mapping] |
| *(initial)* | `DECLINED` | platform; `PERK_ORDER_UPDATE` webhook [webhook-spec] |
| `COMPLETED` | `REVERSED` | platform; `PERK_ORDER_UPDATE` webhook [webhook-spec]; that it follows `COMPLETED` is [inferred] |

Terminal: `DECLINED`, `REVERSED`; `COMPLETED` is "final" per the webhook but can still be reversed [inferred]. No client operation changes an order's status [spec].

### Liquidity threshold `active` (`LiquidityThreshold.active`, boolean `[spec]`)

| from | to | via |
|---|---|---|
| — | `true` / `false` | `createLiquidityThreshold` (`active` in body; default when omitted undocumented) [spec] |
| `true` | `false` | `updateLiquidityThreshold` `{ "active": false }` — "the threshold will not be checked and won't raise an alert" [spec] |
| `false` | `true` | `updateLiquidityThreshold` `{ "active": true }` [spec] |

No terminal state; no delete operation exists [spec].

### FX quote (implicit; no status field)

| from | to | via |
|---|---|---|
| — | ISSUED | `generateConversionQuote` [spec] |
| ISSUED | EXECUTED | `executeConversion` with `outcome: ACCEPTED` before `expiresAtUtc` [spec][docs:quote-expiration-observability] |
| ISSUED | EXPIRED | clock passes `expiresAtUtc`; a later `executeConversion` yields `REFUSED_QUOTE_EXPIRED` [spec][docs:margins-and-quote-locking] |
| ISSUED | ISSUED | `executeConversion` refused for another reason (`REFUSED_*`) — whether the quote stays executable is unspecified [inferred: yes, until expiry] |

Terminal: EXECUTED (a quote books once [docs:margins-and-quote-locking]), EXPIRED.

### FX conversion (`ConversionExecuteResponse.outcome` — terminal at creation)
`outcome` is set once by `executeConversion` and never changes; manual conversions "cannot be cancelled, reversed, or amended once confirmed" [docs:multi-currency-wallets-feature-guide]. Composite-auth conversions are "unwound" on hold reversal by booking further conversions [docs:multi-currency-card-authorisation]; that the original conversion record is left unchanged is [inferred]. `LiquidityConversion.status` / `depositStatus` are Currency Cloud strings (only `awaiting_funds` shown) and are not enumerated [spec].

### Click to Pay enrolment (internal flag on the card; never exposed `[docs:click-to-pay]`)

| from | to | via |
|---|---|---|
| NOT_ENROLLED | ENROLLED | `enrolCard` (Manual mode) [spec]; card creation / one-off migration (Auto mode) [docs:click-to-pay] |
| ENROLLED | ENROLLED | `enrolCard` again — "no-op success" (email in body may still update the C2P registration) [spec] |
| ENROLLED | NOT_ENROLLED | `unenrolCard` [spec]; `unenrolCustomer` (all the customer's cards) [spec]; card → `inactive`/`expired` (platform) [docs:click-to-pay] |
| NOT_ENROLLED | NOT_ENROLLED | `unenrolCard` / `unenrolCustomer` — "no-op success" [spec] |

Docs' `inactive`/`expired` = `HayCard.cardStatus` `INACTIVE` / `EXPIRED` [spec] (enum: `["ACTIVE","AWAITING_ACTIVATION","BLOCKED","INACTIVE","EXPIRED"]`); `BLOCKED` is not a terminal state and is not mentioned by the docs as an unenrol trigger [docs:click-to-pay].

Customer-level: registered with C2P when their first card enrols; removed by `unenrolCustomer` [spec]. No terminal state.

## 4. Invariants and calculations

**FX quote maths** [docs:margins-and-quote-locking] — margin is "a percentage added to the live market rate to produce the rate the customer is quoted. It adjusts the rate the customer receives; it is not a separate charge." Worked example (AUD→USD, `fixedSide: BUY`, `amount: 300`, margin 1%, market 0.70460): quoted rate 0.69755; sell amount 430.08 AUD (vs. 425.77 AUD at market; 4.31 AUD difference). From these figures: `quotedRate = marketRate × (1 − margin/100)` with the rate expressed as buy-currency per unit of sell-currency (0.70460 × 0.99 = 0.69755) [inferred from the example]; `sellAmount = buyAmount / quotedRate` when `BUY` is fixed (300 / 0.69755 = 430.08); `buyAmount = sellAmount × quotedRate` when `SELL` is fixed [inferred]. Margin source: `marginPercentage` on the request if present, else the client's configured default [spec][docs]. `getConversion` exposes both: `quoteUnadjustedRate` (market) and `quoteMarginAdjustedRate`; "The margin percentile equates to the difference between these two values" [docs:multi-currency]. `conversionRate` ("Conversion rate executed") — for a locked quote this equals the margin-adjusted rate [inferred]. Amounts are to 2 decimal places (`CurrencyAmount.amount`) [spec]; rounding mode unspecified [inferred: half-up].

**Quote expiry** — `expiresAtUtc` = quote-recorded timestamp + client-configured expiration window (set via CSM; can differ per environment) [docs:quote-expiration-observability][docs:multi-currency]; execution "received by Shaype before `expiresAtUtc`" is honoured at exactly the quoted amounts [docs:quote-expiration-observability]; the window has no documented default.

**Conversion ledger effect** — `executeConversion` (ACCEPTED): debit `sellAccountId` by `sellAmount`, credit the buy account by `buyAmount`, "the exact amounts from the quote" [docs:multi-currency-wallets-feature-guide]; two `FinancialTransaction`s are created (`debitTransactionId`, `creditTransactionId`) [spec]; balance definitions (`availableBalance`, `heldBalance`, stacks) are the accounts domain's; "Currency Account Available Balance … is the operational figure used when the customer initiates a manual currency conversion" [docs:multi-currency-wallets-feature-guide]. Nothing moves at quote time [inferred]. Max-balance limit on the buy Currency Account is enforced on execution [docs:multi-currency].

**Indicative rates** — three rates per pair: `bidRate` (naked), `cardMarginAdjustedBidRate`, `walletMarginAdjustedBidRate` [spec]; from an upstream cache stamped as `lastRefreshedAtUtc` [spec]; that it is the card-authorisation cache "refreshed periodically (currently every 30 minutes)" [docs:multi-currency-card-authorisation] is [inferred]; pair = `sellCurrency + buyCurrency`, 6 uppercase chars, e.g. `AUDGBP` [spec]; duplicates de-duplicated; currently AUD pairs only [docs:indicative-rates-api].

**FX-provider minimum** [docs:minimum-conversion-rounding-logic] — Currency Cloud rejects conversions below a 1 GBP-equivalent floor (`conversion_below_limit`); the platform retries at the minimum that clears "adds a 1% buffer to absorb rounding"; the *customer* ledger keeps the original amounts and the surplus stays in the liquidity account, flagged with marker `CCW0003`. Worked example: USD 1.00 spend, AUD→USD sell ≈1.44 AUD (0.75 GBP equiv) rejected → retry sell 1.94 AUD at 0.7076 → treasury −1.94 AUD / +1.37 USD, customer −1.44 AUD / +1.00 USD, +0.37 USD surplus. Only relevant if the stub models liquidity balances alongside composite auth.

**Liquidity thresholds** [docs:liquidity-monitoring-and-alerting-1] — per type: 0–10 thresholds; `percent` integer 1–100; `amount` positive whole number ≥ 1 and ≤ the channel's limit (`TOTAL_DAILY_NET_NON_SCHEME`: Non-Scheme Float Account Cash Balance + Non-Scheme CM Liquidity Account Cash Balance; `TOTAL_DAILY_OUTBOUND_BPAY`: `BPAY_DAILY_LIMIT`; `TOTAL_DAILY_INBOUND_DIRECT_DEBIT`: `DIRECT_DEBIT_PER_DAY`; `TOTAL_DAILY_NET_VISA`: `CARD_PAYMENTS_DAILY`); defaults: 50%, 75%, 90% per channel, enabled. Trigger conditions (verbatim):

| Threshold Type | Amount ($) Trigger Condition | Percentage (%) Trigger Condition |
|---|---|---|
| TOTAL_DAILY_NET_NON_SCHEME | If **amount ($) + Total Non-Scheme Running Balance** <= 0 | If (Non-Scheme Float Account Cash Balance + Non-Scheme CM Liquidity Account Cash Balance) × **percentage (%) + Total Non-Scheme Running Balance** <= 0 |
| TOTAL_DAILY_OUTBOUND_BPAY | If **amount ($) + Total Outbound BPAY Running Balance** <= 0 | If BPAY_DAILY_LIMIT × **percentage (%) + Total Outbound BPAY Running Balance** <= 0 |
| TOTAL_DAILY_INBOUND_DIRECT_DEBIT | If **amount ($) + Total Inbound Direct Debit Running Balance** <= 0 | If DIRECT_DEBIT_PER_DAY × **percentage (%) + Total Inbound Direct Debit Running Balance** <= 0 |
| TOTAL_DAILY_NET_VISA | If **amount ($) + Total Scheme Running Balance** <= 0 | If CARD_PAYMENTS_DAILY × **percentage (%) + Total Scheme Running Balance** <= 0 |

The "`+ Running Balance <= 0`" form implies running balances are **negative as the day's exposure grows** [inferred]. Breach ⇒ email alert (not a webhook) [docs]. How these running balances relate to `ClientLiquidity.*.total` and the `inbound`/`outbound` split is not stated.

**Perk order amounts** — fixed products: `MonetaryValue.amount` set, `min`/`max` null; ranged products: `min`/`max` set, `amount` null [spec]; for ranged products the caller supplies `calculationMode` (`SOURCE_AMOUNT` | `DESTINATION_AMOUNT`) and the corresponding `source`/`destination` `Money` [spec]; the amount must fall in `[min, max]` of that side [inferred]. `getOrders`: default window = last 24h; explicit `fromDate`/`toDate` window ≤ 24h; `externalId` filter bypasses the window; `offset % limit == 0`; `limit` ∈ [1,100] default 20 [spec].

**ID and format rules** [spec] — every id in this domain is a UUID (`cardId`, `customerId`, `conversionId`, `quoteId`, `thresholdId`, `sellAccountId`, `buyAccountId`, `debitTransactionId`, `creditTransactionId`, `transactionId`, operator/product `id`, `operatorId`, `productId`, `externalId`, `purchaserId`, `idempotencyKey`, threshold `id`); `idempotencyKey` and threshold `id` and order `externalId` are **client-generated**; MCC `code` is a 4-digit int32 (ISO 18245); mobile numbers match `^\+[1-9][0-9]{6,14}$` (E.164); countries are ISO 3166-1 alpha-3; `LiquidityConversion.shortReference` example `20260821-ABCDEF` (date + 6 chars [inferred]); `currencyPair` = 6 uppercase letters.

**Date handling** [spec] — `getClientLiquidity.date` and `conversionDate` are `format: date` (`YYYY-MM-DD`); quote/conversion timestamps are `date-time` UTC (`…Utc` suffix); `getOrders.fromDate`/`toDate` and `OrderSummary.createdAt`/`confirmedAt` are untyped strings described as ISO 8601; `ExchangeExternalTokenResponse.accessExpiresUtc` is an int64 (unit unspecified in the spec; epoch seconds per the analogous `access_expires_utc` [docs:reference/postexchangerequest], applicability to the B2B field [inferred]).

## 5. Cross-domain dependencies

- **Accounts** — `generateConversionQuote.sellAccountId` must be an existing, funded account of the customer; the buy side is the customer's account in `buyCurrency` (Home Currency Account = AUD parent; Currency Accounts = children with `HayAccount.parentAccountId`) [docs:multi-currency-wallets-feature-guide][spec]; `executeConversion` debits/credits those two accounts and their balances must reflect it in `getHayAccount` ("validate the balance adjustments via GET Account by ID") [docs:multi-currency-wallets-conversions]; `HayAccount.homeCurrencyBalanceEquivalent` is computed "using margin adjusted cached rates" — the same rate cache as `getFxRates` [docs][inferred]; a blocked account cannot convert ("place a block on the Currency Account via Block Account to prevent that account being used for card spend or conversions") [docs:multi-currency] → `REFUSED_ACCOUNT_BLOCKED` / `REFUSED_RECIPIENT_ACCOUNT_BLOCKED` [inferred mapping]; closed accounts → `REFUSED_ACCOUNT_CLOSED` / `REFUSED_RECIPIENT_ACCOUNT_CLOSED` [inferred]; max-balance limit → `REFUSED_MAX_BALANCE_EXCEEDED` [docs:multi-currency][inferred]; `blockAccount` cascades to FX child accounts [spec, accounts domain]; **Products**: `CreateAccountRequestBody.productId` (required) and `HayAccount.productId` reference the ids `getAllProducts` is documented to return [docs:product]; multi-currency is a product feature; `CreateAccountRequestBody.fx` (`AccountFxDataRequest { childAccounts, compliance: FxComplianceDataRequest }`) is how FX child accounts are opened [spec].
- **Transactions / holds** — each accepted conversion creates two `FinancialTransaction`s (`debitTransactionId`, `creditTransactionId`) [spec]; channel enum values exist for them: `CURRENCY_CLOUD_CLIENT_CONVERSION_IN` / `_OUT` (client/customer-initiated) and `CURRENCY_CLOUD_CARD_CONVERSION_IN` / `_OUT` (composite card authorisation) on `FinancialTransaction.transactionChannel` and `AuthorisationHold.transactionChannel` [spec]; the webhook `TransactionEventDto.transactionType` has `CONVERSION_IN` ("Currency conversion buy (credit)") and `CONVERSION_OUT` ("Currency conversion sell (debit)") [webhook-spec]; `searchConversions.transactionId` is a **card-spend** transaction id from the transactions domain [spec]; `getClientLiquidity` aggregates the day's transactions by channel family (BPAY, direct entry credit/debit, NPP, HaaS transfers, scheme domestic/international) [spec field names][inferred mapping].
- **Cards** — `enrolCard`/`unenrolCard` key on `cardId` [spec]; a card entering `inactive`/`expired` (= `HayCard.cardStatus` `INACTIVE` / `EXPIRED` [spec]; `BLOCKED` is not a trigger) must trigger the unenrol path; lost/stolen replacement unenrols the old card and (Auto mode) enrols the replacement [docs:click-to-pay] — documented intent only; the page marks this 'Not started' (NBB-3530) and leaves open "whether issuing the replacement already triggers enrolment or needs explicit wiring" [docs:click-to-pay]; composite card authorisation (cards/holds domain) creates conversions that `getConversion`/`searchConversions` must return, fixed side `BUY`, using the card margin and cached rates, linked on hold create/increase/settle [docs:multi-currency-card-authorisation]; `HayCard` carries no C2P field [spec].
- **Customers** — `unenrolCustomer` keys on `customerId` and cascades to all the customer's cards [spec]; customer name/email/phone updates propagate to C2P for customers with ≥1 enrolled card, billing address does not [docs:click-to-pay]; the `email` in `enrolCard` is never written to `HayCustomer.email` [spec].
- **Transaction rules / merchant data** — MCCs from `getAllMerchantCategoryCodes` are referenced by `RuleDetails.blockedMerchantCategoryCodes` (integer int32[], `uniqueItems: true`; "Blocked Merchant Category Code (MCC) as four digit code as per ISO 18245 (required for Rule type: MERCHANT_CODE_BLOCK).") reached via `ExternalAddTransactionRuleRequest.ruleDetails` only — `ExternalTransactionRuleResponse.rule` is the untyped `Rule` schema ("Contains detail of the Rule", no properties declared), so no MCC field exists on the response [spec] —, by `MerchantDetails.merchantCategoryCode` / `ExternalMerchantDetails.merchantCategoryCode` on transactions [spec], and by `Merchant.merchantCategoryCode` (string, 1–4 chars) in the client-facing authorisation callback [ext-auth-spec].
- **Limits (client configuration)** — threshold maxima reference the client limits `BPAY_DAILY_LIMIT`, `DIRECT_DEBIT_PER_DAY`, `CARD_PAYMENTS_DAILY` and the non-scheme float/liquidity cash balances [docs:liquidity-monitoring-and-alerting-1]; the four `REFUSED_TOTAL_*_DAILY_LIMIT_BREACHED` conversion outcomes mirror the four threshold types [spec enum names; the pairing to threshold types is inferred].
- **Webhooks** — `PERK_ORDER_UPDATE` on `POST /api/hay/v1/communications/notification` (`NotificationDtoV1`) finalises perk orders [webhook-spec]; conversion balance movements surface as transaction notifications with `CONVERSION_IN`/`CONVERSION_OUT` [webhook-spec][docs]; liquidity threshold breaches are emails, not webhooks [docs].
- **External authorisation callback** — contains nothing about FX, perks, liquidity, C2P or tokens (verified) [ext-auth-spec]; no source says conversions or perk orders are authorised via the client's callback.
- **GraphQL APIs** — the Tokens API mints credentials for them; they are entirely outside this spec [spec tag description].

## 6. Error catalogue

No message text for any error in this domain appears in the spec or the docs; every declared error body is `ErrorResponse { details, message, status, traceId }` [spec]. Statuses marked [inferred] are the implementer's choice within the declared set.

| # | Operation(s) | Condition | Status / code | Source |
|---|---|---|---|---|
| 1 | all 27 | declared error responses | `400`, `403`, `422`, `500`, `501` → `ErrorResponse` | [spec] |
| 2 | `getOperatorById`, `getProductById` | unknown `id` | `404` ("Operator not found" / "Product not found"; declared body schema is `OperatorSummary`/`ProductSummary` — quirk; use `ErrorResponse` [inferred]) | [spec] |
| 3 | `getConversion`, `updateLiquidityThreshold`, `enrolCard`, `unenrolCard`, `unenrolCustomer` | unknown path id | not declared; `404` `ErrorResponse` [inferred] | — |
| 4 | any POST/PUT | missing required body field, `minLength`/`minimum`/`maximum`/`pattern`/enum violation, body absent where required | `400` [inferred] | [spec constraints] |
| 5 | `generateConversionQuote`, `createLiquidityConversion`, `getLiquidityDetailedRates` | `amount <= 0` (`exclusiveMinimum`) | `400` [inferred] | [spec] |
| 6 | `generateConversionQuote` | client not entitled ("requires agreement"), or not a multi-currency product | `403`/`422` [inferred]; on execute the outcome `REFUSED_CAPABILITY_NOT_ENABLED` exists | [spec] |
| 7 | `executeConversion` | quote expired | `200` with `outcome: REFUSED_QUOTE_EXPIRED` [spec enum; HTTP status inferred] | [spec][docs:margins-and-quote-locking] |
| 8 | `executeConversion` | insufficient funds / blocked / closed / limit / max balance / fraud / customer preference / not verified / capability | `200` + `REFUSED_INSUFFICIENT_FUNDS`, `REFUSED_ACCOUNT_BLOCKED`, `REFUSED_RECIPIENT_ACCOUNT_BLOCKED`, `REFUSED_ACCOUNT_CLOSED`, `REFUSED_RECIPIENT_ACCOUNT_CLOSED`, `REFUSED_LIMIT_BREACH`, `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED`, `REFUSED_MAX_BALANCE_EXCEEDED`, `REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_NET_VISA_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_NON_SCHEME_DAILY_LIMIT_BREACHED`, `REFUSED_FRAUD`, `REFUSED_CUSTOMER_PREFERENCE`, `REFUSED_SENDER_ACCOUNT_NOT_VERIFIED`, `REFUSED_CAPABILITY_NOT_ENABLED`, `REFUSED_INVALID_PAY_ID`, `INTERNAL_ERROR`, `UNKNOWN` (enum shared with transfers; which apply to FX is unspecified) | [spec] |
| 9 | `executeConversion` | unknown `quoteId`, or quote already executed | not declared; `422` [inferred] | — |
| 10 | `getFxRates` | malformed pair / unknown currency / unsupported currency (non-AUD pair today) | `200` with `failures[].reason` = `MALFORMED_PAIR` / `UNKNOWN_CURRENCY` / `CURRENCY_NOT_SUPPORTED` | [spec][docs:indicative-rates-api] |
| 11 | `getLiquidityBalances`, `createLiquidityConversion`, `getLiquidityDetailedRates` | multi-currency wallets not enabled for client | `403`/`422` [inferred] | [spec] |
| 12 | `createLiquidityConversion` | below Currency Cloud minimum (`conversion_below_limit`) | `422` [inferred]; the platform marker `CCW0003` identifies rounded-up composite-auth cases | [docs:minimum-conversion-rounding-logic] |
| 13 | `createLiquidityThreshold`, `updateLiquidityThreshold` | `percental=true` without `percent`; `percental=false` without `amount`; `percent` ∉ [1,100]; `amount` < 1 or not whole or > channel limit | `400`/`422` [inferred] | [spec][docs:liquidity-monitoring-and-alerting-1] |
| 14 | `createLiquidityThreshold` | more than 10 thresholds for a `type`; duplicate `id` | `422` [inferred] (no `409` declared) | [docs][spec] |
| 15 | `getOrders` | `fromDate`/`toDate` window > 24h; `offset` not a multiple of `limit`; `limit` ∉ [1,100] | `400` [inferred] | [spec] |
| 16 | `createOrder` | duplicate `externalId`; unknown `productId`; missing a required field combination per `required*Fields`; ranged product without `calculationMode`/amount, or amount outside `[min,max]` | `422` [inferred] (no `409` declared) | [spec] |
| 17 | `lookupOperators` | `mobileNumber` fails E.164 pattern | `400` [inferred] | [spec] |
| 18 | `enrolCard` | client C2P disabled or in Auto mode; card in terminal state | `403`/`422` [inferred] | [docs:click-to-pay] |
| 19 | `exchangeExternalToken`, `elevateExternalToken` | invalid/unknown external token | `403` [inferred] | — |
| 20 | Perk order (async) | provider declines/reverses | webhook `PERK_ORDER_UPDATE` `status: DECLINED` / `REVERSED` — no reason field | [webhook-spec] |

## 7. Open questions

1. **`GET /v1/products` shape** — spec returns the perk `ProductSummary[]`; docs say it returns the client's banking products whose `productId` feeds `createAccount`. Decide: (a) follow the spec literally (perk products), (b) return banking products with at least `id`+`name` (fits `ProductSummary`'s property names, leaving perk-only fields absent), or (c) both. Test code integrating with Shaype will almost certainly call it for (b).
2. **Perk order initial `status`/`statusClass`** — undocumented free strings; only `COMPLETED`/`DECLINED`/`REVERSED` are known. Choose an initial value (and whether the stub auto-completes orders and fires `PERK_ORDER_UPDATE`, with what delay).
3. **How a perk order is funded** — no `accountId`/`customerId` on `CreateOrderRequestBody`; `debitPartyIdentifier` is an operator-side identifier. Whether a Shaype account is debited (and which) is unspecified; the stub must decide whether to touch balances at all.
4. **`perkType` filtering** — none of `CountrySummary`, `OperatorSummary`, `ProductSummary` carries `perkType`; the `perkSubType` → `perkType` grouping is unspecified.
5. **404 bodies** — declared with `OperatorSummary`/`ProductSummary` schemas; and no 404 at all on `getConversion`, `updateLiquidityThreshold`, the three C2P operations.
6. **HTTP status for `REFUSED_*` conversion outcomes** — 200 with `outcome`, or 4xx? Also whether a refused quote remains executable, and whether a `quoteId` can be executed twice with different `idempotencyKey`s.
7. **Idempotency replay semantics** — `idempotencyKey` on quote/execute/liquidity-conversion "recognise[s] any subsequent retries"; response on replay (same body vs. error) and on key reuse with a different body are unspecified.
8. **Quote-time balance checks** — is `sellAccountId` balance checked at quote time ("must be funded before requesting a quote") or only at execution (`REFUSED_INSUFFICIENT_FUNDS`)?
9. **Buy-account resolution** — no `buyAccountId` in the request; if the customer has no Currency Account in `buyCurrency` the behaviour (auto-create vs refuse, and with which outcome) is unspecified.
10. **Quote expiry default** and **default margin** — both "configured via CSM"; no numeric defaults anywhere. Also the exact rounding of `quotedRate` (5 dp in the example) and amounts (2 dp).
11. **Conversion webhooks** — docs disagree over time (none → per-account transaction events); `TransactionEventDto` has no `conversionId` field despite the docs saying it is included. Decide whether the stub emits `CONVERSION_IN`/`CONVERSION_OUT` transaction events and where `conversionId` goes.
12. **`getClientLiquidity`** — default `date`, timezone/day boundary, sign convention, and the formula for every `total` (sum vs. net of `inbound`/`outbound`); mapping of transaction channels to `haas`/`npp`/`directEntry`/`bpay`/`scheme.domestic`/`scheme.international`.
13. **`LiquidityThreshold.external`** — undocumented boolean absent from both request bodies.
14. **Threshold defaults** — are the 12 platform-default thresholds (50/75/90% × 4 types) pre-seeded and listable/updatable? Do defaults for omitted `active`/`percental` exist? Is `type` really immutable (docs say updatable, body has no `type`)?
15. **`updateLiquidityThreshold` PUT semantics** — partial (omitted fields unchanged) vs full replace; the `amount` description is a copy-paste of `percent`'s.
16. **`getFxRates.currencyPairs` serialisation** — comma-separated single param (description) vs repeated params (OpenAPI default for an un-styled array query param).
17. **`getOrders` edge cases** — one of `fromDate`/`toDate` supplied alone; `externalId` plus a window; `productType` accepted values (untyped).
18. **`getLiquidityBalances` / liquidity conversions** — whether the stub keeps a real per-target multi-currency treasury ledger (updated by `createLiquidityConversion` and composite-auth conversions, including the 1 GBP-minimum surplus) or returns canned data.
19. **Tokens** — validation of `externalAccessToken`/`externalStepUpToken`, token format/lifetime, unit of `accessExpiresUtc` (epoch s vs ms — the customer API's analogous `access_expires_utc` is documented as "UNIX epoch in seconds" [docs:reference/postexchangerequest]; applicability to the B2B field [inferred]), and whether `elevate` requires a prior `exchange`.
20. **Click to Pay** — behaviour for Disabled/Auto-mode clients calling the manual endpoints; whether terminal-state cards can be enrolled; whether the stub should model the enrolment flag at all (nothing reads it back except the no-op semantics).
21. **MCC seed data** — the ISO 18245 list is not supplied; the stub needs a source.
22. **`GenericMessage.message` text** for the three C2P responses — undocumented.
