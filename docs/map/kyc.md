# kyc

Domain map for the Shaype B2B Operations API tag **"KYC API"** — "Set of APIs related to managing KYC checks during onboarding" [spec tag description]. Operation count: **4** (verified with the `ops.json` filter). Ground truth for the local cleanroom re-implementation.

Sources and labels used below:

- `[spec]` — `b2b-operations-api.json` (OpenAPI 3.0.1, "B2B Operations API" 0.0.1). The four reference pages `developer.shaype.com/reference/{createcase,approveamlkyccheck,approvedocumentcheck,approvesanctioncheck}.md` were fetched and compared: each is a per-operation slice of this same spec, byte-identical in every operation and schema, so they add nothing beyond `[spec]`.
- `[webhook-spec]` — `notification-webhooks.json` (Shaype calling the client's `POST {clientBase}/api/hay/v0/communications/notification`).
- `[ext-auth-spec]` — `external-balance.yaml` (Shaype calling the client's authorisation service). Contains **nothing** KYC-related beyond the client-side refusal code `REFUSED_SENDER_ACCOUNT_NOT_VERIFIED`; not used further.
- `[docs:<slug>]` — `developer.shaype.com/docs/<slug>.md`. Slugs read: `flexible-kyc-checks`, `customer-creation-1`, `customer-status-flow`, `sample-requests-responses`, `customers`, `customer-removal`, `webhook-notification`. Also checked and found empty of KYC content: `status-transitions` (PayTo only), `page/multi-currency-onboarding-and-account-structure`.
- `[inferred]` — my reading of the above; not stated anywhere. Treat as a decision the implementer may overturn (§7).

General facts that apply to every operation in this domain:

- The spec declares **no** `security` / `securitySchemes` and a single server `http://localhost:8080` [spec]. Authentication is outside this map.
- Every operation declares responses `200 Success`, `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content`, `500 Internal Server Error`, `501 Not Implemented`; every non-200 body is `ErrorResponse` [spec]. **No operation declares 404 or 409** [spec].
- `ErrorResponse` = `{ details: string, message: string, status: string, traceId: string }` [spec]. No KYC operation has an example; the only `ErrorResponse` example in the whole spec (Accounts domain) has the shape `{"message":"PERMISSION_DENIED: ...","details":"Please refer to the API documentation or contact Shaype for more info with the traceId.","status":"422","traceId":"<uuid>"}` — note `status` is a **string** containing the HTTP code [spec].
- **No operation in this tag carries an `idempotencyKey`** and none of the four declares `deprecated` [spec].
- All IDs are UUID strings (`format: uuid`) [spec].
- **There is no read/list/get endpoint for a case or for a customer's check outcomes anywhere in the spec** — the only KYC-visible state is `HayCustomer.status` (Customers API) and the `ONBOARDING_*` webhooks [spec][webhook-spec]. Verified by grepping every path and schema for `kyc|case|onboard|sanction|aml|verif`.
- The KYC flow (Shaype-run KYC) end to end [docs:customer-creation-1]: (1) `createCase` → get `scanCase.id`, `webLink`, `mobileToken`; (2) the end user completes identity verification in the web client (`webLink`) or the mobile SDK (`mobileToken`); (3) client calls Customers `createHayCustomer` with `identityVerificationCaseId = scanCase.id`; (4) platform runs the onboarding checks and either activates the customer automatically ("The customer will become active automatically when the KYC is successful") or refers/rejects; (5) client receives `ONBOARDING_PASSED` / `ONBOARDING_FAILED` and `CUSTOMER_STATUS_UPDATED` webhooks. The three `approve*Check` operations are the manual override for a failed stage ("If a customer fails a check they will be referred to an operational colleague" [docs:flexible-kyc-checks]).

## 1. Operations

Listed in `ops.json` order.

### POST /v1/kyc/identity-verification/cases (createCase)

- Purpose: "Create new identity verification case and first submission" [spec summary]. "Create a case is the first step to onboard a customer on the platform when using Shaype KYC functionality" [docs:customer-creation-1]. Marked "(Required only with KYC)" — clients doing their own KYC (`skipKyc: true`) never call it [docs:customer-creation-1]. Not deprecated.
- Path/query params: none [spec].
- Request body: `UserConsentRequestBody` — "Represents the user's consent information along with their location details." The `requestBody` object itself is **not** flagged `required: true` (contrast the three approval ops), but the schema has `required: ["userLocationCountry"]` [spec]. The docs sample shows the request payload as literally `N/A` [docs:sample-requests-responses] — i.e. the sample predates or ignores the consent body; see §7.

  | field | type | required | constraints / enum (verbatim) | description (verbatim) |
  |---|---|---|---|---|
  | `consentObtained` | string, `nullable: true` | no | **no `enum` in the schema**; description says "can only be one of 'yes', 'no', or 'na'" (lowercase, quoted as written) | "Consent status, which can only be one of 'yes', 'no', or 'na'." |
  | `consentObtainedAt` | string (`date-time`), `nullable: true` | no | | "The date and time in UTC when consent was obtained." |
  | `userIp` | string, `nullable: true` | no | no pattern | "The IP address of the user providing consent." |
  | `userLocationCountry` | string | **yes** | no pattern/length in schema; description says ISO 3166-1 alpha-3 | "The country code of the user's location in ISO 3166-1 alpha-3 format." |
  | `userLocationState` | string, `nullable: true` | no | | "The state or region of the user's location." |

- Response `200 Success`: `CreateCaseExternalResponse` — "New case created" [spec].

  | field | type | description (verbatim) |
  |---|---|---|
  | `mobileToken` | string | "Mobile SDK token used to complete identity verification on mobile phone." |
  | `scanCase` | object `ExternalCase` | see below |
  | `webLink` | string | "HTTP link to a web client to complete identity verification process through a web browser." |

  `ExternalCase` — "Case" [spec]: `customerId` string (uuid) "Customer id."; `id` string (uuid) "Unique identifier."; `outcome` string enum **`["NOT_EXECUTED","REJECTED","WARNING","PASSED"]`** (descriptions verbatim: "NOT_EXECUTED - Outcome is unknown because customer didn't complete the identity verification or customer input processing isn't complete yet"; "REJECTED - Customer failed identity verification"; "WARNING - System is unable to make a definitive judgment. Requires" — the sentence is truncated in the spec; "PASSED - Customer passed identity verification"); `timestamp` string (`date-time`) "The date and time the case was created." No `required` list on the schema.

  Documented sample response [docs:sample-requests-responses]:
  ```json
  {
    "scanCase": {
      "id": "49645b93-2481-489e-a2d5-f704514e03f5",
      "timestamp": "2024-03-12T23:00:17.559Z",
      "outcome": "NOT_EXECUTED"
    },
    "webLink": "https://haasXY.web1.amer-1.jumio.ai/web1/v4/app?authorizationToken=eyJhbGciOiJIUzUxMiIsInppcCI6IkdaSVAifQ.<...>&locale=en-US",
    "mobileToken": "eyJhbGciOiJIUzUxMiIsInppcCI6IkdaSVAifQ.<...>"
  }
  ```
  Observations from the sample: `scanCase.customerId` is **absent** (the case is created before any customer exists); `outcome` is `NOT_EXECUTED` on creation; `timestamp` is UTC with millisecond precision and a `Z` suffix; `webLink` is a hosted Jumio web client whose `authorizationToken` query value equals `mobileToken`; both tokens are JWS-shaped (`HS512`, gzip-compressed payload, three base64url segments) [docs:sample-requests-responses]. Vendor identity (Jumio) is visible only in that URL — `[inferred]`, never named in prose.
- Errors: 400/403/422/500/501 `ErrorResponse` [spec]. No condition→code mapping is documented. `[inferred]`: missing/empty `userLocationCountry` → 400; `consentObtained` outside `yes|no|na` → 400 (or accept anything, since the schema has no enum — §7).
- Behaviour:
  - Creates a new identity-verification case with a platform-generated `scanCase.id` and `timestamp = now (UTC)`, `outcome = NOT_EXECUTED` [spec][docs:sample-requests-responses].
  - Returns the two end-user hand-off credentials (`webLink` for browser, `mobileToken` for the mobile SDK) [spec]. The end user's document capture happens outside the B2B API ("first submission" in the summary refers to the vendor case's first submission slot; the API itself accepts no document data) `[inferred]`.
  - "the field scanCase.id from the create case endpoint, should be sent to identityVerificationCaseId in the create customer request. This will link the id verification case to the customer creation request." [docs:customer-creation-1]. Until then the case has no `customerId` `[inferred from sample]`.
  - Not idempotent and has no idempotency key: each call creates a distinct case `[inferred]`.
  - No state change to any other entity. No preconditions stated (no customer needs to exist) [docs:customer-creation-1].
  - Webhooks: **none documented for case creation.** The later `ONBOARDING_PASSED` / `ONBOARDING_FAILED` events are keyed by `customerHayId` and therefore can only fire after `createHayCustomer` links the case [webhook-spec `NotificationDto.required` includes `customerHayId`] `[inferred]`.
  - Consent fields are stored with the case for audit; nothing documents any validation of `userIp`/`userLocationState` `[inferred]`.

### POST /v1/kyc/{customerId}/onboarding/amlKycCheck/approval (approveAmlKycCheck)

- Purpose: "Approve AML Check" [spec summary] — manually approves the AML/KYC stage of a customer's onboarding. Not deprecated. Not described in any docs page; the only prose about manual resolution is "If a customer fails a check they will be referred to an operational colleague" [docs:flexible-kyc-checks] and the `REFERRED` description "Shaype would look to resolve dispute with the customer" [docs:customer-status-flow].
- Path params [spec]: `customerId` — string (uuid), **required**, "Unique identifier (UUID) of the Customer". Query params: none.
- Request body (**`required: true`**): `OnboardingStageApprovalBody` — "Details of the onboarding stage approval." No `required` list, so `{}` is a valid body [spec].

  | field | type | required | description (verbatim) |
  |---|---|---|---|
  | `comments` | string | no | "Note / comment to be captured with approval" |

- Response `200 Success`: `ConfirmationResponse` — "A confirmation response." — `{ message: string }` ("A confirmation message.") [spec]. No example text for `message` anywhere in spec or docs.
- Errors: 400/403/422/500/501 `ErrorResponse` [spec]. No condition→code mapping is documented.
- Behaviour (all `[inferred]` unless cited — the spec and docs say nothing about preconditions or effects):
  - Stage identity: by path name this approves the stage the webhook calls `KYC_AML_SCAN` ("KYC / AML check") [webhook-spec `OnboardingFailedEventDto.state`] `[inferred by name]`.
  - Precondition: customer exists, was created with Shaype KYC (not `skipKyc`), and this stage is currently failed / awaiting manual review (customer `REFERRED`, or `PENDING_APPROVAL` with a `WARNING`-type outcome) `[inferred]`. What happens when called on an `ACTIVE`, `REJECTED`, `INACTIVE` or `skipKyc` customer is undocumented (§7).
  - Effect: records the approval (with `comments`) against the stage; if this was the last outstanding stage, the platform completes onboarding → customer `ACTIVE`, `approvedDateTimeUtc` set, `ONBOARDING_PASSED` + `CUSTOMER_STATUS_UPDATED {customerStatus: ACTIVE}` webhooks with `actionOwner: CLIENT` `[inferred]` — chained from "The customer will become active automatically when the KYC is successful" [docs:customer-creation-1] and the webhook catalogue [webhook-spec].
  - Idempotency: unspecified. `[inferred]`: approving an already-approved stage returns 200 again (no-op) rather than an error.
  - Does not touch accounts, cards or balances (no account exists yet — "An account can only be opened if the customer is in `ACTIVE` status" [docs:customer-status-flow]).
- Webhook events: none named for this operation in the docs. See §5 for the `[inferred]` chain.

### POST /v1/kyc/{customerId}/onboarding/documentCheck/approval (approveDocumentCheck)

- Purpose: "Approve Document Check" [spec summary] — manually approves the document / identity-verification stage of a customer's onboarding. Not deprecated. Not described in any docs page (same prose as above applies).
- Path params [spec]: `customerId` — string (uuid), **required**, "Unique identifier (UUID) of the Customer". Query params: none.
- Request body (**`required: true`**): `OnboardingStageApprovalBody` — identical to `approveAmlKycCheck`: optional `comments` string "Note / comment to be captured with approval"; no `required` list [spec].
- Response `200 Success`: `ConfirmationResponse` `{ message: string }` [spec]. Errors: 400/403/422/500/501 `ErrorResponse` [spec]; no conditions documented.
- Behaviour (`[inferred]` unless cited):
  - Stage identity: the stage the webhook calls `DOCUMENT_SCAN` ("Document and identity check") [webhook-spec] `[inferred by name]`. This is the stage fed by the `createCase` identity-verification case: a `scanCase.outcome` of `REJECTED` or `WARNING` ("System is unable to make a definitive judgment. Requires" — truncated) [spec] is what this endpoint overrides `[inferred]`.
  - Only meaningful for **Standard KYC**; under Reduced KYC (`onlySanctionsCheck: true`) "The customer will only be taken through Sanctions Screening" [docs:flexible-kyc-checks], so there is no document stage to approve — behaviour when called anyway is undocumented (§7).
  - Preconditions, effects, idempotency and side effects: as for `approveAmlKycCheck`, substituting the document stage.
- Webhook events: none named for this operation in the docs.

### POST /v1/kyc/{customerId}/onboarding/sanctionCheck/approval (approveSanctionCheck)

- Purpose: "Approve Sanctions Check" [spec summary] — manually approves the sanctions-screening stage of a customer's onboarding. Not deprecated. Not described in any docs page.
- Path params [spec]: `customerId` — string (uuid), **required**, "Unique identifier (UUID) of the Customer". Query params: none.
- Request body (**`required: true`**): `OnboardingStageApprovalBody` — optional `comments` string; no `required` list [spec].
- Response `200 Success`: `ConfirmationResponse` `{ message: string }` [spec]. Errors: 400/403/422/500/501 `ErrorResponse` [spec]; no conditions documented.
- Behaviour (`[inferred]` unless cited):
  - Stage identity: the stage the webhook calls `SANCTIONS_SCAN` ("Sanctions check") [webhook-spec] `[inferred by name]`. Sanctions screening runs under **both** Standard and Reduced KYC — it is the only check in Reduced KYC [docs:flexible-kyc-checks]. A PEP flag is given as an example of failing a step [docs:customer-status-flow "flagged as a PEP"].
  - Under Reduced KYC this is the only stage, so approving it completes onboarding → `ACTIVE` `[inferred]`.
  - Preconditions, effects, idempotency and side effects: as for `approveAmlKycCheck`, substituting the sanctions stage.
- Webhook events: none named for this operation in the docs.
