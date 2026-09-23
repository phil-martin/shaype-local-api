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
