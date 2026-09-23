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

## 2. Entities and fields

Only two KYC-owned schemas describe persisted state (`ExternalCase`, and the implied per-customer "onboarding stage" record that the three approval endpoints act on but which **no schema exposes**). The rest are request/response envelopes. KYC-relevant fields that live on Customers-domain schemas are listed at the end because the implementer must join them.

### ExternalCase — "Case" [spec]

Returned only inside `CreateCaseExternalResponse.scanCase`. **Created** by `createCase`. **Read** by nothing (no GET). **Updated** by the platform/vendor as the end user completes verification (`outcome`) and by `createHayCustomer` when it links the case (`customerId`) `[inferred]`. No `required` list.

| field | type | nullable | enum (verbatim) | example [docs:sample-requests-responses] | notes |
|---|---|---|---|---|---|
| `customerId` | string (uuid) | not flagged, but absent in the sample | | (absent) | "Customer id." Populated once linked via `identityVerificationCaseId` `[inferred]` |
| `id` | string (uuid) | no | | `49645b93-2481-489e-a2d5-f704514e03f5` | "Unique identifier." The value the client passes as `identityVerificationCaseId` [docs:customer-creation-1] |
| `outcome` | string | no | `NOT_EXECUTED`, `REJECTED`, `WARNING`, `PASSED` | `NOT_EXECUTED` | "Identity verification outcome" — see §3 |
| `timestamp` | string (date-time) | no | | `2024-03-12T23:00:17.559Z` | "The date and time the case was created." |

### CreateCaseExternalResponse — "New case created" [spec]

Response envelope of `createCase`. No `required` list.

| field | type | example [docs:sample-requests-responses] | notes |
|---|---|---|---|
| `mobileToken` | string | `eyJhbGciOiJIUzUxMiIsInppcCI6IkdaSVAifQ.<payload>.<sig>` | "Mobile SDK token used to complete identity verification on mobile phone." Same value as the `authorizationToken` query param inside `webLink` in the sample |
| `scanCase` | `ExternalCase` | see above | |
| `webLink` | string | `https://haasXY.web1.amer-1.jumio.ai/web1/v4/app?authorizationToken=<mobileToken>&locale=en-US` | "HTTP link to a web client to complete identity verification process through a web browser." |

### UserConsentRequestBody — request-only, `createCase` [spec]

`required: ["userLocationCountry"]`. Fields: `consentObtained` string nullable (prose-only domain `'yes'`, `'no'`, `'na'`; **no schema enum**); `consentObtainedAt` string date-time nullable; `userIp` string nullable; `userLocationCountry` string (ISO 3166-1 alpha-3 per description; no pattern); `userLocationState` string nullable. No examples anywhere (docs sample says `N/A`).

### OnboardingStageApprovalBody — request-only, all three `approve*Check` ops [spec]

"Details of the onboarding stage approval." No `required` list. Single field `comments` string — "Note / comment to be captured with approval". No examples.

### ConfirmationResponse — response of all three `approve*Check` ops [spec]

"A confirmation response." Single field `message` string — "A confirmation message." No example value anywhere.

### ErrorResponse [spec]

`details` string "Error details"; `message` string "Error description"; `status` string "HTTP response status"; `traceId` string "TraceID that can be used by HAY for troubleshooting the request". Shape example (Accounts domain, the only one in the spec): `{"message":"PERMISSION_DENIED: Account cannot be created for customer with id eed1e718-b1ca-4b94-a508-3d2d41c2e96b as their status is currently BLOCKED","details":"Please refer to the API documentation or contact Shaype for more info with the traceId.","status":"422","traceId":"b24daeb7-4242-4ff1-ba50-9825d5deedd8"}`.

### Onboarding stage record (implied; **no schema**) `[inferred]`

The three approval endpoints address stages `amlKycCheck`, `documentCheck`, `sanctionCheck` by path segment [spec]; the webhook names the failing stage with `OnboardingFailedEventDto.state` enum **`["DOCUMENT_SCAN","SANCTIONS_SCAN","KYC_AML_SCAN","DUPLICATE_CHECK"]`** (verbatim descriptions: `DOCUMENT_SCAN` "Document and identity check", `SANCTIONS_SCAN` "Sanctions check", `KYC_AML_SCAN` "KYC / AML check", `DUPLICATE_CHECK` "Duplicate customer check") [webhook-spec]. The docs list the Standard-KYC steps as "ID&V, Document Certification and Sanctions Screening" and Reduced KYC as "only ... Sanctions Screening" [docs:flexible-kyc-checks]. Name correspondence `[inferred]`:

| path segment | webhook `state` | docs step | runs under Standard | runs under Reduced (`onlySanctionsCheck`) | manual approval endpoint |
|---|---|---|---|---|---|
| `documentCheck` | `DOCUMENT_SCAN` | ID&V / Document Certification (which of the two is undetermined — §7) | yes | no | `approveDocumentCheck` |
| `amlKycCheck` | `KYC_AML_SCAN` | ID&V / Document Certification (the other one) or a separate AML data check | yes | no `[inferred]` | `approveAmlKycCheck` |
| `sanctionCheck` | `SANCTIONS_SCAN` | Sanctions Screening | yes | yes | `approveSanctionCheck` |
| (none) | `DUPLICATE_CHECK` | duplicate customer check (email / phone / docType+number / name+DOB) [docs:customer-creation-1] | yes | yes `[inferred]` | **none** — no approval endpoint exists |

Per-stage fields the local implementation needs (all `[inferred]`, names are the implementer's choice): stage name, result (pending / passed / failed), manual-approval flag, `comments`, approved-at timestamp.

### KYC-relevant fields on Customers-domain schemas (owned by `customers.md`; listed for the join) [spec]

- `CreateHayCustomerRequestBody`: `identityVerificationCaseId` string (uuid) nullable — "Optional Identity Verification ID for the identity check" (= `scanCase.id` [docs:customer-creation-1]); `journeyId` string (uuid) nullable **`deprecated: true`** — "Please do not use this field for customer creation, please refer to identityVerificationCaseId"; `skipKyc` boolean — "Only applicable to Clients using Shaype KYC solution. Used to bypass KYC checks for the Customer. Must only set as 'true' in agreed scenarios (i.e. permission to generate a dummy / test account has been granted). This flag cannot be used at the same time as onlySanctionsCheck." (default `false` [docs:customer-creation-1]); `onlySanctionsCheck` boolean — "Applicable only to clients using our Sanctions-Check-Only KYC functionality. Used to only perform sanctions check on the Customer as part of KYC checks. This flag cannot be used at the same time as skipKyc."; `identityDocumentType` enum `["DRIVING_LICENSE","PASSPORT"]`; `identityDocumentNumber`; `identityDocumentCardNumber` pattern `^[a-zA-Z0-9]{6,10}$`; `identityDocumentExpiry` date; `identityDocumentIssuingCountry`; `identityDocumentRegion` pattern `NSW|QLD|SA|TAS|VIC|WA|ACT|NT`.
- `HayCustomer`: `status` enum `["ACTIVE","INACTIVE","REJECTED","BLOCKED","PENDING_APPROVAL","REFERRED"]` (description of `REFERRED`: "Customer is referred for further KYC checks"); `approvedDateTimeUtc` date-time — "DateTime in UTC format when the customer has been approved"; the same `identityDocument*` fields as above; `statusReason` enum `["SUSPICIOUS","DECEASED","CUSTOMER","OPERATIONAL"]` (INACTIVE reasons, not KYC).
- `UpdateCustomerRequestBody.documentData` → `DocumentData` (`required: ["identityDocumentIssuingCountry","identityDocumentNumber","identityDocumentType"]`; "When provided will be updated as a whole, setting the not provided fields to null.") — lets a client correct identity-document data after creation; nothing says this re-triggers any check (§7).
- `ChangeHayCustomerStatusRequestBody.newStatus` — same six-value enum; the client-side alternative to platform activation ("If you are not using Shaype KYC, you will need to manually update the customer status to `ACTIVE`" [docs:customer-creation-1]).

### Webhook payload `NotificationDto` — KYC-relevant subset [webhook-spec]

Delivered to `POST {clientBase}/api/hay/v0/communications/notification` (client responds 200; Shaype retries on 401/403/429/5xx, **18 times over up to 48 hours** with exponential backoff [docs:webhook-notification]). `required: ["customerHayId","idempotencyKey","type"]`.

| field | type | enum / notes |
|---|---|---|
| `customerHayId` | string (uuid) | "Unique identifier (UUID) of the customer associated with the notification" |
| `idempotencyKey` | string (uuid) | "Idempotency key (UUID) to uniquely represent this request and prevent duplication." |
| `type` | string | full enum verbatim: `ACCOUNT_STATUS_CHANGE`, `CUSTOMER_STATUS_UPDATED`, `CARD_ADDED_TO_WALLET`, `CARD_STATUS_CHANGE`, `CUSTOMER_DETAILS_CHANGE`, `ONBOARDING_PASSED`, `ONBOARDING_FAILED`, `REMINDER`, `SCHEDULED_PAYMENT`, `TRANSACTION`, `DIRECT_ENTRY`, `MANDATE`, `MANDATE_DUE_PAYMENT`, `MANDATE_PAYMENT`, `APPLE_PAY_REWARD_FOR_CUSTOMER`, `MANDATE_ACTION_EXPIRATION`, `DELEGATED_OTP_NOTIFICATION`. KYC ones: `ONBOARDING_PASSED` "Customer onboarding completed successfully"; `ONBOARDING_FAILED` "Customer onboarding failed"; `CUSTOMER_STATUS_UPDATED` "Customer's status has been updated" |
| `actionOwner` | string | `CLIENT` "Client executed an action which triggered the event." / `PLATFORM` "Shaype executed an action which triggered the event." |
| `firebaseDeviceToken` | string | "Firebase token of the customer's device" — present in both `ONBOARDING_*` doc samples |
| `onboardingFailedEvent` | `OnboardingFailedEventDto` | `state` enum `["DOCUMENT_SCAN","SANCTIONS_SCAN","KYC_AML_SCAN","DUPLICATE_CHECK"]`; `submissionFailure` boolean (no description). "provided when the type is `ONBOARDING_FAILED`" |
| `customerStatusUpdatedEvent` | `CustomerStatusUpdatedEventDto` | `customerStatus` enum `["ACTIVE","INACTIVE","REJECTED","BLOCKED","PENDING_APPROVAL","REFERRED"]`. "provided when the type is `CUSTOMER_STATUS_UPDATED`" |

Documented sample payloads [docs:customer-creation-1] (verbatim keys):
```json
{"customerHayId":"42f5b631-edd5-00f0-9f17-cd17da0ca0d9","idempotencyKey":"42f5b631-edd5-00f0-9f17-cd17da0ca0d9","type":"ONBOARDING_PASSED","firebaseDeviceToken":"fD3Z...sdf234sd"}
{"customerHayId":"c1c476dd-6c1a-23dd-8e4f-a4229f9563bf","idempotencyKey":"3971e549-a178-23dd-9d76-737328a6ce40","type":"ONBOARDING_FAILED","firebaseDeviceToken":"dbRQ...sdfsZ","onboardingFailedEvent":{"state":"KYC_AML_SCAN","isSubmissionFailure":true}}
{"customerHayId":"74b7aaa9-dwe3-4a09-a618-f1bd405c3ead","idempotencyKey":"f7ec6a11-df3t-4eff-a5d9-31e948e8210f","type":"CUSTOMER_STATUS_UPDATED","actionOwner":"CLIENT","customerStatusUpdatedEvent":{"customerStatus":"ACTIVE"}}
```
Discrepancies: the docs sample uses **`isSubmissionFailure`** where the schema property is **`submissionFailure`** [docs vs webhook-spec]; the `ONBOARDING_*` samples carry **no `actionOwner`** (schema: optional); the sample UUIDs are not valid hex (`dwe3`, `df3t`) — treat as illustrative.

## 3. State machines

### `ExternalCase.outcome` — values verbatim [spec]

`NOT_EXECUTED`, `REJECTED`, `WARNING`, `PASSED`. No transitions are documented; the only statements are the enum descriptions and the sample's initial value. Reconstructed from those:

| from | to | via | source |
|---|---|---|---|
| (none) | `NOT_EXECUTED` | `createCase` | [docs:sample-requests-responses] (initial value in the sample); [spec] "Outcome is unknown because customer didn't complete the identity verification or customer input processing isn't complete yet" |
| `NOT_EXECUTED` | `PASSED` | platform/vendor, after the end user completes the web/mobile flow and processing succeeds | [spec] enum description; transition itself `[inferred]` |
| `NOT_EXECUTED` | `REJECTED` | platform/vendor, "Customer failed identity verification" | [spec]; transition `[inferred]` |
| `NOT_EXECUTED` | `WARNING` | platform/vendor, "System is unable to make a definitive judgment. Requires" (truncated — presumably manual review) | [spec]; transition `[inferred]` |
| `WARNING` / `REJECTED` | (unchanged) | `approveDocumentCheck` overrides the **stage**, not the case outcome — nothing says the case outcome is rewritten | `[inferred]` |

Terminal: `PASSED`, `REJECTED` `[inferred]`; `WARNING` is terminal for the case but non-terminal for onboarding `[inferred]`. **No API transitions exist** — every change is platform-side; the local implementation needs a test hook (§7).

### Onboarding stage result (implied, no schema) `[inferred]`

Per stage in {`DOCUMENT_SCAN`, `KYC_AML_SCAN`, `SANCTIONS_SCAN`, `DUPLICATE_CHECK`} [webhook-spec names]:

| from | to | via | source |
|---|---|---|---|
| (none) | pending | `createHayCustomer` with Shaype KYC (`skipKyc` false); stages present depend on `onlySanctionsCheck` | [docs:customer-creation-1][docs:flexible-kyc-checks]; representation `[inferred]` |
| pending | passed | platform runs the check | [docs:customer-creation-1] "automatically" |
| pending | failed | platform runs the check; emits `ONBOARDING_FAILED {state: <stage>}` | [webhook-spec][docs:customer-creation-1] |
| failed | approved (manual) | `approveDocumentCheck` / `approveAmlKycCheck` / `approveSanctionCheck` respectively | [spec] endpoint existence; effect `[inferred]` |
| failed (`DUPLICATE_CHECK`) | — | no endpoint; the customer stays failed | [spec] (absence) |

All stages passed/approved ⇒ onboarding complete ⇒ customer `ACTIVE`, `ONBOARDING_PASSED` `[inferred]` from [docs:customer-creation-1] "The customer will become active automatically when the KYC is successful".

### Customer `status` — the KYC-driven subset (full matrix in `customers.md` §3) [spec enum]

Values verbatim: `ACTIVE`, `INACTIVE`, `REJECTED`, `BLOCKED`, `PENDING_APPROVAL`, `REFERRED`. The docs' transition diagram is an image only; text-stated transitions relevant to KYC:

| from | to | via | source |
|---|---|---|---|
| (none) | `PENDING_APPROVAL` | `createHayCustomer` — "the initial state when a customer enters the onboarding phase" | [docs:customer-status-flow][docs:customer-creation-1] |
| `PENDING_APPROVAL` | `ACTIVE` | platform, all KYC checks pass ("The customer will become active automatically when the KYC is successful"); `actionOwner: PLATFORM` `[inferred]` | [docs:customer-creation-1] |
| `PENDING_APPROVAL` | `ACTIVE` | client `changeHayCustomerStatus {newStatus: ACTIVE}` (non-Shaype-KYC / `skipKyc`) | [docs:customer-creation-1] |
| `PENDING_APPROVAL` | `REFERRED` | platform, "the customer has failed one or more the of the steps such as provided an invalid ID or flagged as a PEP"; "If a customer fails a check they will be referred to an operational colleague" | [docs:customer-status-flow][docs:flexible-kyc-checks] |
| `PENDING_APPROVAL` | `REJECTED` | platform, "the onboarding evaluation has concluded that Shaype cannot open an account for the user as a result of the information provided" | [docs:customer-status-flow] |
| `PENDING_APPROVAL` | withdrawn (target status unnamed; `INACTIVE` `[inferred]`) | client — "It can be 'Withdrawn' by the client at this stage" | [docs:customer-status-flow] |
| `REFERRED` | `ACTIVE` | `approve*Check` clearing the last failed stage ("Shaype would look to resolve dispute with the customer") | `[inferred]` from [spec] endpoints + [docs:customer-status-flow] |
| `REFERRED` | `REJECTED` | Shaype operations (no B2B endpoint other than `changeHayCustomerStatus`) | `[inferred]` from [docs:customer-status-flow] |
| `INACTIVE` | (new record) `PENDING_APPROVAL` | "unless successfully completing the process of re-onboarding" — a fresh `createCase` + `createHayCustomer` | [docs:customer-status-flow]; new-record reading `[inferred]` |

Terminal for KYC purposes: `REJECTED` (nothing documents leaving it) and `INACTIVE` (re-onboarding creates a new customer) `[inferred]`. `BLOCKED`/`ACTIVE`/`INACTIVE` transitions unrelated to KYC are in `customers.md`.

### `OnboardingFailedEventDto.state` [webhook-spec]

Not a state machine — a label for which stage failed: `DOCUMENT_SCAN`, `SANCTIONS_SCAN`, `KYC_AML_SCAN`, `DUPLICATE_CHECK`. `submissionFailure` boolean is undescribed; the sample sets it `true` with `KYC_AML_SCAN` [docs:customer-creation-1]. `[inferred]`: `true` = the end user's submission itself failed/was unusable (e.g. unreadable document) vs. `false` = the submission was processed and the check failed on its merits.

## 4. Invariants and calculations

No balances, limits, counters or formulas exist in this domain. What is fixed:

- **ID formats** [spec]: `scanCase.id`, `scanCase.customerId`, path `customerId`, webhook `customerHayId`/`idempotencyKey` are all `format: uuid` strings. The docs sample case id `49645b93-2481-489e-a2d5-f704514e03f5` is a v4 UUID [docs:sample-requests-responses]. `[inferred]`: generate v4.
- **Case ↔ customer link**: `identityVerificationCaseId` (customer create) **must equal** a `scanCase.id` returned by `createCase` [docs:customer-creation-1]. Whether the platform rejects an unknown id, a reused id, or an id whose case is `NOT_EXECUTED` is unstated (§7). `journeyId` is the deprecated predecessor of the same field [spec].
- **Ordering**: `createCase` precedes `createHayCustomer` ("Create a case is the first step") [docs:customer-creation-1]; `createHayCustomer` precedes every `approve*Check` (they take `customerId`) [spec]; account creation requires `ACTIVE` ("An account can only be opened if the customer is in `ACTIVE` status") [docs:customer-status-flow].
- **Flag exclusivity**: `skipKyc` and `onlySanctionsCheck` "cannot be used at the same time" [spec]. Default `skipKyc = false` [docs:customer-creation-1]; default `onlySanctionsCheck` unstated (`[inferred]` false).
- **Check set** [docs:flexible-kyc-checks]: Standard KYC = ID&V + Document Certification + Sanctions Screening; Reduced KYC (`onlySanctionsCheck: true`) = Sanctions Screening only; `skipKyc: true` = no checks, customer stays `PENDING_APPROVAL` until the client sets `ACTIVE` [docs:customer-creation-1]. "There are no changes to how the platform processes either customers outcomes in either Standard or Reduced KYC" [docs:flexible-kyc-checks]. Duplicate check (`DUPLICATE_CHECK`) is an additional onboarding stage present in the failure enum [webhook-spec]; INACTIVE customers are excluded from it [docs:customer-creation-1].
- **Activation side effects** `[inferred]` from [spec HayCustomer]: on the transition to `ACTIVE` set `approvedDateTimeUtc = now (UTC)` and bump `lastUpdatedDateTimeUtc`.
- **Date handling** [spec]: `timestamp`, `consentObtainedAt`, `approvedDateTimeUtc` are RFC 3339 `date-time` in UTC; sample renders millisecond precision with `Z` (`2024-03-12T23:00:17.559Z`) [docs:sample-requests-responses]. `consentObtainedAt` is client-supplied and stored as given `[inferred]`.
- **Country codes**: `userLocationCountry` is ISO 3166-1 alpha-3 (e.g. `AUS`) [spec description]; no pattern is enforced by schema — `[inferred]`: validate `^[A-Z]{3}$`.
- **Consent domain**: `consentObtained ∈ {'yes','no','na'}` by prose only [spec]; `[inferred]`: enforce case-sensitively and reject others with 400.
- **Tokens** [docs:sample-requests-responses]: `mobileToken` is a JWS (`{"alg":"HS512","zip":"GZIP"}` header); `webLink` = `https://<tenant>.web1.<region>.jumio.ai/web1/v4/app?authorizationToken=<mobileToken>&locale=en-US`. The local implementation needs neither a real signature nor a real host — `[inferred]`: emit an opaque token and a link on the local server's own host that the test harness can drive (§7).
- **Webhook delivery** [docs:webhook-notification]: `idempotencyKey` per event; retries 18 times / ≤48 h with exponential backoff on client 401/403/429/5xx; client must answer 200. The `ONBOARDING_PASSED` sample reuses the `customerHayId` as `idempotencyKey`; the others use distinct UUIDs [docs:customer-creation-1] — `[inferred]`: always generate a fresh UUID.
- **No pagination, no search, no counters** in this domain [spec].

## 5. Cross-domain dependencies

Reads/writes into other domains (all by the platform-side onboarding pipeline that these endpoints steer):

- **Customers (`customers.md`)**
  - `createHayCustomer` **consumes** `scanCase.id` via `identityVerificationCaseId` and the flags `skipKyc` / `onlySanctionsCheck`; it is what instantiates the onboarding stages for a customer [docs:customer-creation-1][docs:flexible-kyc-checks].
  - KYC **writes** `HayCustomer.status` (`PENDING_APPROVAL → ACTIVE | REFERRED | REJECTED`) and `approvedDateTimeUtc` [docs:customer-creation-1][docs:customer-status-flow][spec].
  - `approve*Check` **reads** the customer by `customerId` (must exist) [spec path param] and, `[inferred]`, requires it to be `PENDING_APPROVAL`/`REFERRED` on Shaype KYC.
  - `changeHayCustomerStatus` is the client-side substitute for platform activation when Shaype KYC is not used [docs:customer-creation-1]; `updateCustomer.documentData` can rewrite the identity-document fields after creation [spec].
  - Duplicate checks (email / phone / doc type+number / name+DOB) surface in the KYC path as `ONBOARDING_FAILED {state: DUPLICATE_CHECK}` [webhook-spec][docs:customer-creation-1].
- **Accounts (`accounts.md`)**
  - Account creation is gated on customer `ACTIVE` [docs:customer-status-flow]; the Accounts-domain error example "Account cannot be created for customer with id ... as their status is currently BLOCKED" shows the gate is enforced with `422` and a `PERMISSION_DENIED:` message prefix [spec ErrorResponse example].
  - Account `riskLevel` defaults to `HIGH` ("accounts that didn't go through all regulatory checks yet") and blocks all fund movement until the client sets `LOW` — a separate, client-driven gate after KYC [docs:customer-creation-1].
- **Webhooks (`notification-webhooks.json`)** — KYC is the **producer** of `ONBOARDING_PASSED`, `ONBOARDING_FAILED` and (on activation/referral/rejection) `CUSTOMER_STATUS_UPDATED` [docs:customer-creation-1][webhook-spec]. Which `actionOwner` a manual approval produces is unstated (`[inferred]`: `CLIENT` for `approve*Check`, `PLATFORM` for automatic outcomes).
- **Cards, Groups, Transactions, Holds, Stacks, PayTo, BPAY, FX, Liquidity, Perks, Tokens, Utilities** — no dependency in either direction [spec].
- **External authorisation (`external-balance.yaml`)** — none. The client-side refusal code `REFUSED_SENDER_ACCOUNT_NOT_VERIFIED` is the client's own verification concept, not Shaype KYC [ext-auth-spec].

## 6. Error catalogue

The spec attaches the same five error responses to all four operations and documents **no** condition → code mapping and **no** message text for any of them [spec]. Everything below the first two rows is therefore `[inferred]`, patterned on the one `ErrorResponse` example in the spec (`status` as a string, `message` prefixed with an upper-snake code and a colon).

| condition | HTTP | `message` (verbatim if documented) | source |
|---|---|---|---|
| Declared for every op: "Bad Request" / "Forbidden" / "Unprocessable Content" / "Internal Server Error" / "Not Implemented" | 400 / 403 / 422 / 500 / 501 | none documented | [spec] |
| `ErrorResponse` body shape | any | `{details, message, status (string), traceId}` | [spec] |
| `createCase`: `userLocationCountry` missing or not a 3-letter code | 400 | unstated | `[inferred]` (schema `required`) |
| `createCase`: `consentObtained` not one of `yes` / `no` / `na` | 400 | unstated | `[inferred]` (prose-only domain) |
| `createCase`: `consentObtainedAt` not RFC 3339 | 400 | unstated | `[inferred]` |
| `createCase`: malformed JSON / wrong content type | 400 | unstated | `[inferred]` |
| `approve*Check`: `customerId` not a UUID | 400 | unstated | `[inferred]` |
| `approve*Check`: body missing (spec `requestBody.required: true`) | 400 | unstated | `[inferred]` — `{}` is valid |
| `approve*Check`: customer does not exist | **404 or 422 — undeclared** (no op declares 404) | unstated | `[inferred]`; §7 |
| `approve*Check`: customer created with `skipKyc: true` / client-KYC (no stages) | 422 | unstated | `[inferred]` |
| `approveDocumentCheck` / `approveAmlKycCheck` on a Reduced-KYC (`onlySanctionsCheck`) customer (stage does not exist) | 422 | unstated | `[inferred]` |
| `approve*Check`: customer `ACTIVE` / `REJECTED` / `INACTIVE` / `BLOCKED` (nothing to approve or terminal) | 422 (or 200 no-op) | unstated | `[inferred]`; §7 |
| `approve*Check`: stage already approved | 200 (idempotent no-op) | unstated | `[inferred]`; §7 |
| Caller not permitted (e.g. wrong client for this customer) | 403 | unstated | [spec] declares 403; condition `[inferred]` |
| Related, Customers domain: `skipKyc` and `onlySanctionsCheck` both `true` | unstated (400/422) | "This flag cannot be used at the same time as ..." (schema prose, not a message) | [spec] |
| Related, Customers domain: duplicate customer | unstated; async `ONBOARDING_FAILED {state: DUPLICATE_CHECK}` in the KYC path | none | [docs:customer-creation-1][webhook-spec] |
| Related, Accounts domain: create account for non-ACTIVE customer | 422 | `PERMISSION_DENIED: Account cannot be created for customer with id <uuid> as their status is currently <STATUS>` | [spec ErrorResponse example] |

Webhook-side (client → Shaype) responses that matter for the local simulator: Shaype retries on **401, 403, 429, 5XX** from the client, 18 attempts over ≤48 h [docs:webhook-notification].

## 7. Open questions

Decisions the implementer must make because the spec/docs are silent or contradictory:

1. **Case lifecycle simulation.** No endpoint or webhook ever exposes `ExternalCase.outcome` after creation, and no B2B call advances it. The local server needs a test hook (e.g. an admin route or a header on `createHayCustomer`) to set the case outcome (`PASSED` / `REJECTED` / `WARNING`) and to drive each stage's result, and a policy for the default (auto-pass immediately vs. stay `PENDING_APPROVAL` until driven). `customers.md` §7 item 20 raises the same point from the customer side.
2. **`identityVerificationCaseId` validation.** Must it reference an existing case? Can a case be linked to two customers? Is a case still `NOT_EXECUTED` acceptable at customer creation (the docs flow implies the end user may finish verification before or after)? Which error (400/422) for a bad id?
3. **Stage ↔ docs-step mapping.** Docs name three Standard-KYC steps (ID&V, Document Certification, Sanctions Screening) [docs:flexible-kyc-checks]; the API has `documentCheck`, `amlKycCheck`, `sanctionCheck`; the webhook has `DOCUMENT_SCAN`, `KYC_AML_SCAN`, `SANCTIONS_SCAN`, `DUPLICATE_CHECK`. Which of ID&V / Document Certification is `documentCheck` vs `amlKycCheck` is undetermined. Also whether `amlKycCheck` runs under Reduced KYC (docs say sanctions only, so presumably not).
4. **Effect of `approve*Check` on customer status.** Does approving the last failed stage move `REFERRED → ACTIVE` and emit `ONBOARDING_PASSED` + `CUSTOMER_STATUS_UPDATED`? With which `actionOwner`? Does approving one of several failed stages leave the customer `REFERRED`? Nothing is documented.
5. **Preconditions and error codes for `approve*Check`** when the customer is missing (404 vs 422 — no op declares 404), `ACTIVE`, `REJECTED`, `INACTIVE`, `BLOCKED`, created with `skipKyc`, or lacks that stage (Reduced KYC). Whether a repeat approval is a 200 no-op or a 422.
6. **`ConfirmationResponse.message` text** — no example anywhere. Pick a fixed string per endpoint.
7. **`ExternalCase.customerId` semantics** — absent in the sample; presumably filled when linked. Should `createCase` ever accept/return a `customerId` (e.g. re-onboarding an `INACTIVE` customer)?
8. **Consent body strictness.** The schema marks only `userLocationCountry` required and gives `consentObtained` no enum; the docs sample sends no body at all (`N/A`) and the spec's `requestBody` is not `required: true`. Decide whether an empty/absent body is 400 (schema) or accepted (sample).
9. **`WARNING` outcome handling.** The enum description is truncated ("Requires"). Assumed: manual review → customer `REFERRED` with `DOCUMENT_SCAN` failed → `approveDocumentCheck`. Confirm.
10. **Which status `ONBOARDING_FAILED` implies** — `REFERRED` (docs: failed checks are "referred to an operational colleague") or `REJECTED` (docs: "Shaype cannot open an account ... as a result of the information provided"), and for `DUPLICATE_CHECK` specifically (no approval endpoint exists, so likely `REJECTED`). Also whether a `CUSTOMER_STATUS_UPDATED` fires alongside every `ONBOARDING_*`.
11. **`submissionFailure` vs `isSubmissionFailure`** — schema says `submissionFailure`, docs sample says `isSubmissionFailure`. Emit the schema name (and optionally both).
12. **`DUPLICATE_CHECK` timing** — sync 4xx on `createHayCustomer` ("customer creation will fail") vs. async `ONBOARDING_FAILED`; both are documented. Decide per KYC mode (e.g. sync when `skipKyc`, async otherwise).
13. **Re-onboarding an `INACTIVE` customer** — new customer record (as `customers.md` reads it) vs. re-running checks on the same `customerHayId` via a new case. The `approve*Check` path takes an existing `customerId`, which is compatible with either.
14. **Does `updateCustomer.documentData` re-trigger `documentCheck`?** Unstated.
15. **Token/link realism** — whether tests need `webLink`/`mobileToken` to be parseable JWTs or just opaque strings; and whether `webLink` should point at a local page that lets the harness "complete" the case.
16. **403 semantics** — every op declares 403 but there is no auth model in the spec; decide whether the local server ever returns it (e.g. customer belongs to another client id).
