# Shaype B2B Operations API — cross-cutting conventions

Ground truth for the local cleanroom re-implementation. Every claim is tagged `[spec]` (b2b-operations-api.json, OpenAPI 3.0.1, info.version 0.0.1), `[spec:webhooks]` (notification-webhooks.json), `[spec:ext-balance]` (external-balance.yaml), `[docs:<slug>]` (developer.shaype.com page) or `[inferred]`. Names and enums are verbatim from the source. Where the spec is silent, this file says so rather than guessing.

Spec facts used throughout `[spec]`: 169 operations, 253 component schemas, 23 tags, one server `http://localhost:8080` ("Generated server url"), no top-level `security`, no `components.securitySchemes`, one vendor extension at the root (`x-explorer-enabled`).

---

## 1. Error envelope

### 1.1 `ErrorResponse` schema `[spec]`

`jq '.components.schemas.ErrorResponse'`:

```json
{
  "type": "object",
  "properties": {
    "details": { "type": "string", "description": "Error details" },
    "message": { "type": "string", "description": "Error description" },
    "status":  { "type": "string", "description": "HTTP response status" },
    "traceId": { "type": "string", "description": "TraceID that can be used by HAY for troubleshooting the request" }
  },
  "description": "An error response."
}
```

- No `required` list — all four fields optional in the contract. `[spec]`
- `status` is a **string**, not an integer. The spec does not say whether it is `"400"` or `"BAD_REQUEST"`; see §1.5. `[spec]`
- `traceId` also appears on `DirectDebitResponse` / `DirectDebitResponseV1` as "Unique identifier (UUID) of the request used by Shaype to troubleshoot" — the only hint that a traceId is a UUID. `[spec]`

### 1.2 Status-code usage across all 169 operations `[spec]`

Counts from `jq` over every operation's `responses` keys:

| Code | Ops | Description(s) (verbatim, with counts) | Body schema |
|---|---|---|---|
| 200 | 166 | 163× `Success`; 1× `Card was already enrolled.` (rewards); 1× `Branch Identifier eligibility check completed` (checkBsbIsSupportedByPayTo); 1× `Success (response may include per-pair errors)` (getFxRates) | per-op |
| 201 | 2 | `Card successfully enrolled.` (rewards); `Created` (createOrder) | per-op |
| 202 | 1 | `Accepted` (closeAccount) | per-op |
| 204 | 1 | `Success` (updateBpayBiller) | none |
| 400 | 169 | 168× `Bad Request`; 1× `Invalid request - tag validation failed, list is empty, or operation is missing` | `ErrorResponse` (169/169) |
| 403 | 169 | `Forbidden` | `ErrorResponse` (169/169) |
| 404 | 2 | `Operator not found` (getOperatorById); `Product not found` (getProductById) | `OperatorSummary` / `ProductSummary` (**not** ErrorResponse — almost certainly a generator artefact) |
| 409 | 1 | `Conflict` (createBPayBiller) | `ErrorResponse` |
| 422 | 169 | 163× `Unprocessable Content`; 3× `Unprocessable Entity`; 1× `Invalid Input`; 1× `Branch Identifier format is invalid`; 1× `One or more accounts in scope could not be blocked` | `ErrorResponse` (166/169); `BlockAccountResponse`, `CloseAccountResponse`, `DirectDebitResponse` on the three exceptions listed in §1.3 |
| 429 | 2 | `Too many requests` (rewards → `CardRewardsStatusBody`; createMandate → `ErrorResponse`) | see left |
| 500 | 169 | `Internal Server Error` | `ErrorResponse` (169/169) |
| 501 | 169 | `Not Implemented` | `ErrorResponse` (169/169) |

**Reading:** every operation carries the identical five-code boilerplate `400/403/422/500/501 → ErrorResponse`. The spec does not distinguish *when* 400 vs 422 is raised; the response `description` is the only differentiator and it is boilerplate. No operation declares 401. `[spec]`

Implementer default `[inferred]`: 400 for malformed JSON / schema violations, 422 for semantically invalid requests (business-rule rejections), 403 for a missing/invalid bearer token (the spec declares no 401 anywhere), 404 for unknown path IDs even though only two ops declare it, 500 for unexpected failures. Treat 501 as "declared but never expected".

### 1.3 Operations whose 4xx bodies are *not* `ErrorResponse` `[spec]`

Filled in §1.3a below.

### 1.4 Example error bodies

- The B2B spec contains **no** `example`/`examples` on any 4xx/5xx response. `[spec]`
- No fetched docs page shows an error body with `traceId`/`status`/`message`/`details`; see §1.5 for the search performed. `[docs]`

### 1.5 What is unknown about errors

Filled in §11.

---

## 2. Authentication and connectivity

### 2.1 What the B2B spec says `[spec]`

Nothing. `jq '.security, .components.securitySchemes'` → `null, null`. No operation has a `security` array and no `header` parameter is declared on any operation (`jq` over all parameters with `in=="header"` returns 0 rows). Authentication is entirely out-of-band to the OpenAPI document.

### 2.2 Legacy setup `[docs:page/api-connectivity]`

> "In our legacy setup, we provide you with a long-living authentication token that you will need to pass as an Authentication: Bearer HTTP header."

(The page literally says `Authentication: Bearer`; the curl example in the gateway section uses `Authorization: Bearer`. Treat the doc's "Authentication" as a typo for `Authorization` `[inferred]`.) Connectivity is AWS PrivateLink or site-to-site VPN; IP allow-listing exists in staging only.

### 2.3 API Gateway setup — OAuth2 client-credentials via AWS Cognito `[docs:page/api-connectivity]`

Verbatim curl from the page:

```
curl --location --request POST <cognito-url>/oauth2/token \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode client_id=<client-id> \
  --data-urlencode client_secret=<client-secret> \
  --data-urlencode grant_type=client_credentials
```

- Token endpoint: `POST {cognito-url}/oauth2/token`, body `application/x-www-form-urlencoded` with `client_id`, `client_secret`, `grant_type=client_credentials`. Per-client Cognito URL, protected by IP allow-list. `[docs]`
- Lifetime: "An access token will be returned by Cognito, this allows access to the Shaype API gateway for 60 mins. Once this token expires please repeat the process above to obtain an updated access token." `[docs]`
- Use: `curl --location 'https://staging.api.au.shaype.com/v1/products' --header 'Authorization: Bearer <<access-token>>'` `[docs]`
- The page does not show the Cognito token response body. Standard Cognito client-credentials returns `{"access_token","expires_in","token_type":"Bearer"}` `[inferred — AWS Cognito behaviour, not from Shaype docs]`.
- Different Cognito endpoints, gateway endpoints and client credentials per environment. `[docs]`

### 2.4 Base URLs `[docs:page/api-connectivity]`

| Environment | Host (verbatim) |
|---|---|
| Staging | `staging.api.au.shaype.com` |
| Production | `prod. api.au.shaype.com` (sic — stray space in the doc table; `[inferred]` `prod.api.au.shaype.com`) |

Paths in the spec are absolute (`/v0/...`, `/v1/...`) and the example call is `https://staging.api.au.shaype.com/v1/products`, so the gateway host is the origin with **no path prefix**. `[spec]+[docs]`

### 2.5 What an unauthenticated call returns

**Unknown.** Neither the spec nor any fetched page documents the status/body for a missing or expired token. The spec declares 403 `Forbidden` (ErrorResponse) on every operation and never 401. `[spec]` Implementer default: 403 with an `ErrorResponse` `[inferred]`; see §11.

### 2.6 Related auth material for the *outbound* direction (Shaype → client)

See §7.3 (`Shaype-*` headers, RSA signatures, JWKS at `https://auth.{staging,prod}.hay.co/.well-known/jwks.json`). `[docs:external-authorisation-and-balance]`

---
