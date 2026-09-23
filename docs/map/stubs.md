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
