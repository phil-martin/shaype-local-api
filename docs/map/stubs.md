# stubs

Domain map for the **stub-only** tags of the Shaype B2B Operations API (spec title "B2B Operations API", version "0.0.1"): **Click to Pay API** (3 ops), **Merchant Category Codes API** (1), **Tokens API** (2), **Products API** (1), **FX API** (8), **Liquidity API** (4), **Perks API** (8) — **27 operations**. Source labels: `[spec]` = b2b-operations-api.json, `[webhook-spec]` = notification-webhooks.json, `[ext-auth-spec]` = external-balance.yaml, `[docs:<slug>]` = developer.shaype.com page (`docs/product`, `page/click-to-pay`, `docs/liquidity-monitoring-and-alerting-1`, `page/indicative-rates-api`, plus the FX pages linked from those: `page/multi-currency-wallets-feature-guide`, `page/multi-currency-wallets-conversion-quote`, `page/multi-currency-wallets-conversions`, `page/multi-currency-card-authorisation`, `page/margins-and-quote-locking`, `page/minimum-conversion-rounding-logic`, `page/quote-expiration-observability`, `page/multi-currency`), `[inferred]` = not stated anywhere; implementer's reasonable reading.

Tag descriptions [spec]: Click to Pay API = "Set of APIs related to Click to Pay enrolment"; Merchant Category Codes API = "Reference API for Merchant Category Codes (MCCs)"; Tokens API = "Set of APIs related to exchanging external tokens for Shaype tokens to interact with our GraphQL APIs"; Products API = "Set of APIs related to managing products"; FX API = "APIs for foreign exchange operations"; Liquidity API = "Set of APIs related to managing Client Liquidity"; Perks API = "Customer value-added services (top-ups, gift cards, bill pay)".

Conventions used below:
- **Common error responses** (declared on every one of the 27 operations): `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content`, `500 Internal Server Error`, `501 Not Implemented`, all with body `ErrorResponse` [spec]. `ErrorResponse` = `{ details: string ("Error details"), message: string ("Error description"), status: string ("HTTP response status"), traceId: string ("TraceID that can be used by HAY for troubleshooting the request") }`, no field required [spec]. The spec never says which condition yields 400 vs 422 for any operation in this domain; no docs page gives message text for this domain.
- **404** is declared only on `getOperatorById` and `getProductById`, and there its declared body schema is `OperatorSummary` / `ProductSummary` respectively (not `ErrorResponse`) — a spec quirk [spec]. No `409` is declared anywhere in this domain [spec].
- `GenericMessage` = `{ message: string ("Message indicating operation result") }` [spec]; the message text is never documented.
- No `security` block and no `components.securitySchemes` exist in the spec [spec]; auth is out of scope. `servers` = `http://localhost:8080` (generated) [spec].
- **Currency enum**: every currency-typed property in this domain (12 enum sites: `CurrencyAmount.currency`, `ConversionQuoteRequest.buyCurrency`, `FxRateEntry.buyCurrency`/`sellCurrency`, `LiquidityConversionRequest.buyCurrency`/`sellCurrency`, `LiquidityConversion.buyCurrency`/`sellCurrency`/`depositCurrency`, `LiquidityDetailedRate.clientBuyCurrency`/`clientSellCurrency`/`depositCurrency`, and the `buyCurrency`/`sellCurrency` query params of `getLiquidityDetailedRates`) uses one identical **162-value ISO 4217 list**, given verbatim once in §2 under `CurrencyAmount` and referred to as `<ISO-162>` elsewhere. Verified identical by jq. Note the perk `Money.currency` / `MonetaryValue.currency` are plain strings (no enum) [spec].
- **No request or response examples** exist at operation level for any of the 27 operations [spec, verified]; only property-level `example` values, which are quoted in §2.
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
- Behaviour: idempotent no-op success when not enrolled [spec]; "keyed by the platform card identifier, resolves the Thredd customer reference internally"; "backs operational, bulk and client-initiated removal" [docs:click-to-pay]; the platform also calls this path automatically when a card moves to a terminal state (`inactive` or `expired`) [docs:click-to-pay].
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
- Behaviour: read-only; the list contents are not in the spec or docs — the implementer must seed an ISO 18245 table [inferred]. MCCs are consumed elsewhere as `RuleDetails.merchantCategoryCode` for `MERCHANT_CODE_BLOCK` transaction rules and as `ExternalMerchantDetails.merchantCategoryCode` / `MerchantDetails.merchantCategoryCode` on transactions [spec] (see §5).
- Webhooks: none.

### Tokens API

Context: these two operations mint credentials for Shaype's **GraphQL APIs**, which are outside the B2B Operations spec [spec tag description]. The customer-facing auth API documents the analogous flow with snake_case names: `POST /exchange` "Provided valid Bearer token will be exchanged with a pair of our Access and Refresh tokens" → `TokenExchangeResponse { access_token, access_expires_utc (integer), installation_handle }` [docs:reference/postexchangerequest]; `POST /elevate` "Provides the elevation header needed for elevated access APIs. Requires a valid Bearer token. Also requires an elevated external token which passed in the X-Authorization-StepUp header." → `TokenElevationResponse { elevation_header }` [docs:reference/postelevaterequest]. Those pages describe a different API; the B2B shapes below are the ones to implement.

### POST /v0/tokens/exchange (exchangeExternalToken)

- Purpose: "Exchange External Token for a Shaype token to be used when calling our GraphQL APIs" [spec]. Not deprecated. No description.
- Path/query params: none.
- Request body (required): `ExchangeExternalTokenRequestBody` (description "Body of a request to exchange an external token for a hay token")
  - `externalAccessToken` — string, **required**, `minLength: 1`, "External Access Token" [spec].
- Response: `200 Success` → `ExchangeExternalTokenResponse` = `{ accessExpiresUtc: integer int64, accessToken: string, installationHandle: string }`, none required, no descriptions [spec]. Common error responses.
- Behaviour: validation of the external token and the token format are unspecified [spec]; `accessExpiresUtc` unit (epoch seconds vs milliseconds) is not stated [inferred: epoch seconds, matching the customer API's `access_expires_utc`]; for the stub, any non-empty `externalAccessToken` may be accepted and an opaque `accessToken` issued [inferred].
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
- Behaviour: sell currency = currency of `sellAccountId`; that account "must be funded before requesting a quote" [docs:multi-currency-wallets-feature-guide] (the docs say "`accountId` in the request path" — stale; the spec puts it in the body as `sellAccountId` [spec]); the quoted `rate` = live market rate with the margin applied — default margin configured via CSM, or `marginPercentage` per request "overrides the default for that quote" [docs:margins-and-quote-locking]; `expiresAtUtc` = "the timestamp the quotation was recorded and the configured quote expiration" (client-configurable window, set via CSM) [docs:quote-expiration-observability][docs:multi-currency-wallets-feature-guide]; the `quoteId` "fixes both legs of the trade, the sell amount, the buy amount, and the rate between them" [docs:margins-and-quote-locking]; requires a multi-currency product and CSM agreement [spec][docs:multi-currency]; a blocked Currency Account cannot be used "for card spend or conversions" [docs:multi-currency]; idempotency: `idempotencyKey` is "used to recognise any subsequent retries" [spec], the retry result (same quote returned vs. error) is unspecified [inferred: return the original quote]; no balance is moved by quoting [inferred from docs: only execution "applies the balance changes"]; whether a quote is refused when the sell account balance is below the sell amount is not stated [inferred: not checked at quote time — checked at execute, see `REFUSED_INSUFFICIENT_FUNDS`].
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
- Behaviour: indicative only, never HTTP-fails per pair [spec]; "currently limited to AUD pairs but we can extend this to the broader supported data set in upcoming releases" [docs:indicative-rates-api] (→ non-AUD pair ⇒ `CURRENCY_NOT_SUPPORTED` [inferred]); rates come from the short-lived cache "refreshed periodically (currently every 30 minutes)" that card authorisation also uses [docs:multi-currency-card-authorisation]; `homeCurrencyBalanceEquivalent` on accounts is computed "using margin adjusted cached rates" [docs:multi-currency-wallets-feature-guide] — the same source [inferred]; pair parsing: exactly 6 uppercase letters, first 3 = sell, last 3 = buy, else `MALFORMED_PAIR`; a well-formed code not in ISO list ⇒ `UNKNOWN_CURRENCY` [inferred from reason names].
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
- Response: `200 Success` → `LiquidityConversionResponse` (description "The account a conversion was made within, and the conversion itself") = `{ conversion: LiquidityConversion, target: enum ("The account the conversion was made within") }` [spec]. `LiquidityConversion` ("A Currency Cloud conversion, returned as-is") has 31 optional fields — full list in §2; key ones: `conversionId` uuid ("Currency Cloud's conversion identifier"), `shortReference` (example `"20260821-ABCDEF"`), `status` string ("Current conversion status, as returned by Currency Cloud", example `"awaiting_funds"`), `currencyPair` (example `"AUDUSD"`), `clientRate`, `coreRate`, `midMarketRate`, `partnerRate`, `buyAmount`, `sellAmount`, `settlementDate`, `conversionDate`, `uniqueRequestId` ("The idempotency key echoed back by Currency Cloud") [spec]. Common error responses.
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
- Response: `200 Success` → `OperatorSummary`. `404` declared, described "Not Found", **with schema `OperatorSummary`** (spec quirk) [spec]. Common error responses.
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
- Response: `200 Success` → `ProductSummary`. `404` declared, "Not Found", **with schema `ProductSummary`** (spec quirk) [spec]. Common error responses.
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
- Behaviour: which optional groups are mandatory is data-driven by the product's `requiredBeneficiaryFields`, `requiredSenderFields`, `requiredCreditPartyIdentifierFields`, `requiredDebitPartyIdentifierFields`, `requiredStatementIdentifierFields`, `requiredAdditionalIdentifierFields` — each an array of alternative field-name combinations, "provide all fields of one combination" [spec]; for ranged products (`RANGED_VALUE_*`) `calculationMode` is required and exactly one of `source`/`destination` is the fixed amount, which must lie within the product's `MonetaryValue.min`/`max` [spec descriptions; range check inferred]; for fixed products the amount is the product's `MonetaryValue.amount` [inferred]; `externalId` must be unique per order [spec] — duplicate ⇒ status unspecified [inferred: 422, or idempotent replay of the original order]; unknown `productId` ⇒ unspecified [inferred: 422]; the order is created in a non-final state and the final `status` (`COMPLETED` | `DECLINED` | `REVERSED`) arrives via webhook [webhook-spec]; **how the order is funded from a Shaype account is not stated anywhere** — there is no `accountId`/`customerId` in the request (see §7); `pinCode`/`pinSerial`/`redemption` are populated only for PIN-based products, on completion [spec][webhook-spec].
- Webhooks: `PERK_ORDER_UPDATE` on the v1 notification stream (`POST /api/hay/v1/communications/notification`): `NotificationDtoV1 { idempotencyKey (uuid, required), type: "PERK_ORDER_UPDATE" (required), createdTimeUtc, actionOwner: CLIENT|PLATFORM, eventDetails: PerkOrderUpdateEventDto }`; `PerkOrderUpdateEventDto` = `EventDetailsDto { eventType: "PERK_ORDER_UPDATE" }` + `{ orderExternalId: uuid ("The externalId the perk order was created with."), status: enum ["COMPLETED","DECLINED","REVERSED"] ("Final order status."), pinCode ("PIN code, for PIN-based products."), pinSerial ("PIN serial, for PIN-based products."), confirmedTimeUtc: date-time ("DateTime of when the order was confirmed."), redemption: RedemptionDto { usageInfo: string[], terms: string (Markdown), validity: ValidityDto { unit: string (example "DAY"), quantity: int32 ("Unit count; -1 unlimited, null unknown.", example 365) } } }` [webhook-spec].
