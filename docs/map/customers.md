# customers

Domain map for the Shaype B2B Operations API tag **"Customers API"** (11 operations). Ground truth for the local cleanroom re-implementation.

Sources and labels used below:

- `[spec]` — `b2b-operations-api.json` (OpenAPI 3.0.1, title "B2B Operations API", version 0.0.1). The 11 reference pages under `developer.shaype.com/reference/<operationId>.md` were fetched and diffed against this file: every operation and every referenced schema is byte-identical, so the reference pages add nothing beyond `[spec]`.
- `[webhook-spec]` — `notification-webhooks.json` (Shaype calling the client).
- `[ext-auth-spec]` — `external-balance.yaml` (Shaype calling the client's authorisation service).
- `[docs:<slug>]` — `developer.shaype.com/docs/<slug>.md` or `.../page/<slug>.md`. Slugs read: `customers`, `customer-creation-1`, `custom-data-for-customer-creation`, `customer-status-flow`, `international-address`, `sample-requests-responses`, `customer-removal`, plus (for cross-domain behaviour) `flexible-kyc-checks`, `webhook-notification`, `groups`, `account-status`, `account-closure`, `accounts-overview`, `account`, `card-creation`, `cards`, `account-and-customer-context-in-external-authorisation`.
- `[inferred]` — my reading of the above; not stated anywhere. Treat as a decision the implementer may overturn.

General facts that apply to every operation in this domain:

- The spec declares **no** `security` / `securitySchemes` and a single server `http://localhost:8080` [spec]. Authentication is outside this map (a separate `authentication-api.json` exists in the scratchpad; not read).
- Every operation declares responses `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content` (one op says "Unprocessable Entity"), `500 Internal Server Error`, `501 Not Implemented`, all with body `ErrorResponse` [spec]. **No operation declares 404 or 409** [spec]. Which code is used for "customer not found" is therefore undefined — see §7.
- `ErrorResponse` = `{ details: string, message: string, status: string, traceId: string }` [spec]. One of three worked examples in the spec (the other two: the group-member example quoted in §6, and `branchIdentifier format is not correct.` on a non-customer op, NPP `verifyBranchIdentifier`) is `{"message":"PERMISSION_DENIED: Account cannot be created for customer with id eed1e718-b1ca-4b94-a508-3d2d41c2e96b as their status is currently BLOCKED","details":"Please refer to the API documentation or contact Shaype for more info with the traceId.","status":"422","traceId":"b24daeb7-4242-4ff1-ba50-9825d5deedd8"}` [spec]. Note `status` is a **string** containing the HTTP code.
- All IDs are UUID strings (`format: uuid`) [spec].
- Request-body `required` flags and constraints below are verbatim from the schema; `[spec]` unless stated.

## 1. Operations

Operation count for tag "Customers API": **11** (verified with the `ops.json` filter). Listed in `ops.json` order.

### GET /v0/customers (getAllCustomers)

- Purpose: "Get all Customers" — returns a page of all customers belonging to the calling client [spec summary][docs:customer-creation-1 "retrieves a list of all customers belongs to the client"]. Not deprecated.
- Query params (both **required**) [spec]:
  - `offset` — integer (int32), "Offset used for paging results". No min/max/default.
  - `limit` — integer (int32), "List fetch limit". No min/max/default stated for this op (contrast `searchCustomers`, whose `limit` says 1–1000).
- Request body: none.
- Response `200 Success`: JSON **array** of `HayCustomer` (see §2) [spec]. Errors: 400/403/422/500/501 `ErrorResponse` [spec].
- Behaviour:
  - Offset/limit paging [spec]. Sort order is not stated [open, §7].
  - Whether `INACTIVE` / `REJECTED` customers are included is not stated [open, §7]. `[inferred]`: include all statuses — the docs describe it as "a list of all customers".
  - Read-only; no state change, no webhook.
  - Missing/invalid `offset`/`limit` → `400` `[inferred]` (required query params; spec lists 400 "Bad Request").

### POST /v0/customers/create (createHayCustomer)

- Purpose: "Create Customer" — creates a customer record; "Customer is the entry point for a user in the Shaype platform, it allows you to then create accounts and cards" [docs:customer-creation-1]. Not deprecated. Field `journeyId` inside the body **is** deprecated [spec].
- Path/query params: none.
- Request body (required): `CreateHayCustomerRequestBody` — "Body of a request to create a customer" [spec].
  - `required`: `["address","customerDetails","customerTier","email","idempotencyKey","phoneNumber"]` [spec].

  | field | type | required | constraints / enum (verbatim) | notes |
  |---|---|---|---|---|
  | `address` | object `Address` | yes | see `Address` below | "Address of the Customer" |
  | `customData` | object, `nullable: true` | no | free-form JSON object | "Custom data associated with customer"; any key/value pairs [docs:custom-data-for-customer-creation] |
  | `customerDetails` | object `CustomerDetails` | yes | see below | |
  | `customerTier` | string | yes | enum `["FOUNDER","STANDARD","PREMIUM"]` | "will be STANDARD unless additional tiers have been agreed as part of the product offering" |
  | `email` | string | yes | `minLength: 1` | |
  | `externalCustomerId` | string | no | `minLength: 0`, `maxLength: 64` | "Only applicable to Clients using their own Auth solution. This value will be included in the subject on the token which in turn will be used by Shaype to represent the customer Id on the external system." Not echoed in `HayCustomer` [spec]. |
  | `idempotencyKey` | string (uuid) | yes | | "Unique value (UUID) used to identify this request and used to recognise any subsequent retries" |
  | `identityDocumentCardNumber` | string | no | `pattern: ^[a-zA-Z0-9]{6,10}$` | "Should be specified for Driver's Licenses that provide it." |
  | `identityDocumentExpiry` | string (date), `nullable: true` | no | ISO-8601 `YYYY-MM-DD`; example `2030-06-15` | |
  | `identityDocumentIssuingCountry` | string | no | "three-letter ISO country code" (no pattern in schema) | |
  | `identityDocumentNumber` | string | no | | |
  | `identityDocumentRegion` | string | no | `pattern: NSW\|QLD\|SA\|TAS\|VIC\|WA\|ACT\|NT` (**unanchored** in the spec) | "one of: NSW, QLD, SA, TAS, VIC, WA, ACT, NT. (uppercase only) Should be specified for Driver's Licenses." |
  | `identityDocumentType` | string | no | enum `["DRIVING_LICENSE","PASSPORT"]` | |
  | `identityVerificationCaseId` | string (uuid), `nullable: true` | no | | "Optional Identity Verification ID for the identity check". Value = `scanCase.id` returned by KYC `createCase` [docs:customer-creation-1]. |
  | `journeyId` | string (uuid), `nullable: true`, **`deprecated: true`** | no | | "Please do not use this field for customer creation, please refer to identityVerificationCaseId" |
  | `onlySanctionsCheck` | boolean | no | | "Applicable only to clients using our Sanctions-Check-Only KYC functionality... This flag cannot be used at the same time as skipKyc." |
  | `phoneNumber` | object `PhoneNumber` | yes | see below | |
  | `skipKyc` | boolean | no | default `false` [docs:customer-creation-1] | "Only applicable to Clients using Shaype KYC solution. Used to bypass KYC checks... This flag cannot be used at the same time as onlySanctionsCheck." |
  | `taxObligations` | array of `TaxObligation` | no | | "Captures any foreign (outside Australia) tax obligations for the Customer" |

  Nested shapes (expanded; all `[spec]`):
  - `Address` — `required: ["countryCodeIso","line1"]`; `administrativeRegion` string 1–3 chars ("Second part of ISO 3166-2 region code"); `countryCodeIso` string exactly 3 chars ("three letter code as per ISO 3166"); `line1` string 0–120; `line2` string 0–120; `postcode` string 0–10; `townOrCity` string 0–120. Schema example: `{"administrativeRegion":"SA","countryCodeIso":"AUS","line1":"9 Fifth Ave","line2":"Woodville Gardens","postcode":"5012","townOrCity":"Adelaide"}`.
  - `CustomerDetails` — `required: ["dateOfBirth","firstName","lastName"]`; `dateOfBirth` string (date, `YYYY-MM-DD`); `firstName` string `minLength: 1`; `gender` string, **no enum in schema**, description lists `MALE`, `FEMALE`, `OTHER`; `lastName` string `minLength: 1`; `middleName` string; `preferredName` string; `title` string.
  - `PhoneNumber` — `required: ["countryCodePrefix","numberAfterPrefix"]`; both strings `minLength: 1`.
  - `TaxObligation` — no required list; `country` string (ISO 3166 alpha-3); `noTaxIdNumberReason` string enum `["NOT_APPLICABLE","NOT_ISSUED","DISCLOSURE_NOT_REQUIRED"]`; `taxIdNumber` string ("Must NOT provide Australian Tax File Number (TFN) in this field.").
- Response `200 Success`: `HayCustomer` (§2). Errors 400/403/422/500/501 `ErrorResponse` [spec].
  - Documented sample response [docs:sample-requests-responses]: `{"customerDetails":{"firstName":"John","middleName":"Bryan","lastName":"Smith","dateOfBirth":"1996-02-25","gender":"OTHER"},"customerHayId":"d177961c-68a6-45fa-af8d-d571d274b111","email":"hello123@gmail.com","address":{...},"phoneNumber":{"countryCodePrefix":"61","numberAfterPrefix":"43740788666"},"deviceId":"NOT_SPECIFIED","tier":"STANDARD","status":"PENDING_APPROVAL","creationDateTimeUtc":"2024-03-12T22:59:48.357089Z"}` — the request in that sample sent `"skipKyc": "true"` (string!), `customerTier: "STANDARD"`, `countryCodePrefix: "+61"`, and no `gender`.
- Behaviour:
  - Creates a `HayCustomer` with platform-generated `customerHayId` and `creationDateTimeUtc`; initial `status` is `PENDING_APPROVAL` [docs:customer-creation-1 "The default the customer status would be PENDING_APPROVAL"][docs:sample-requests-responses].
  - `tier` ← `customerTier` [docs:sample-requests-responses]; `customData` stored verbatim and returned by `getHayCustomerById` [docs:custom-data-for-customer-creation].
  - Sample shows `phoneNumber.countryCodePrefix` sent as `"+61"` and returned as `"61"` (leading `+` stripped) and `gender` defaulting to `"OTHER"` and `deviceId` defaulting to `"NOT_SPECIFIED"` when not supplied [docs:sample-requests-responses]; whether these are guaranteed normalisations is `[inferred]`.
  - Two creation modes distinguished by `skipKyc` (default `false`) [docs:customer-creation-1]:
    - **Shaype KYC** (`skipKyc` false): client first calls KYC `POST /v1/kyc/identity-verification/cases` (`createCase`) and passes `scanCase.id` as `identityVerificationCaseId`; "The customer will become active automatically when the KYC is successful" — platform moves `PENDING_APPROVAL → ACTIVE` [docs:customer-creation-1]. Reduced KYC: `onlySanctionsCheck: true` runs only sanctions screening; "If a customer fails a check they will be referred to an operational colleague" (status `REFERRED` `[inferred]` from the wording) [docs:flexible-kyc-checks].
    - **Client KYC** (`skipKyc` true, or client not on Shaype KYC): customer stays `PENDING_APPROVAL` until client calls `changeHayCustomerStatus` with `ACTIVE` [docs:customer-creation-1].
  - `skipKyc` and `onlySanctionsCheck` are mutually exclusive [spec]; error code when both true is not stated `[open]`.
  - **Duplicate checks** — "The Shaype platform does not support creating a customer with the same details under a single client"; checks on: Email Address; Phone Number; Combination of Document Type and Number; Combination of First Name, Last Name and DOB. "If a duplicate is found, customer creation will fail." "If a customer is INACTIVE, they will be excluded from duplicate checks." Checks can be disabled per client by Shaype [docs:customer-creation-1]. Exception: an INACTIVE customer whose last account was closed with `reason` `SUSPICIOUS` or `DECEASED` **stays included** in duplicate checks; `CUSTOMER`/`OPERATIONAL` are excluded [docs:account-closure]. HTTP status for a duplicate is not stated `[open]`; the webhook `OnboardingFailedEventDto.state` enum includes `DUPLICATE_CHECK`, so in the KYC flow a duplicate may surface asynchronously as `ONBOARDING_FAILED` `[inferred]`.
  - **Address validation** [docs:international-address]: validation depends on `countryCodeIso` (the doc calls it `countryIsoCode`; the schema property is `countryCodeIso`). `AUS` → "the same validation and mandatory data rules currently required" (the exact AUS-mandatory field list is only in an image; `[inferred]`: `line1`, `townOrCity`, `administrativeRegion`, `postcode`, `countryCodeIso` — this is what every AUS sample carries). Non-AUS → `line1` and a valid 3-letter `countryCodeIso` required, everything else optional; `administrativeRegion`, if provided, is validated against ISO 3166-2.
  - Phone "must be a mobile not a landline" (used for 2FA, SMS, 3DS) [docs:customer-creation-1]; enforcement/error not stated.
  - `idempotencyKey` is "used to recognise any subsequent retries" [spec]; the effect of a retry (same key) is not stated `[open]`. `[inferred]`: return the originally created customer.
  - Webhooks (Shaype → client, all on `POST /api/hay/v0/communications/notification` [webhook-spec][docs:webhook-notification]; sample payloads [docs:customer-creation-1]; the webhook spec also declares a v1 endpoint `POST /api/hay/v1/communications/notification` carrying `NotificationDtoV1` — see §2): `ONBOARDING_PASSED` and `ONBOARDING_FAILED` (KYC outcome; `onboardingFailedEvent: { state, submissionFailure }` — the docs sample uses the key `isSubmissionFailure` while the webhook schema says `submissionFailure`); `CUSTOMER_STATUS_UPDATED` when the platform activates the customer `[inferred]` (docs only show it for client-driven status changes, but the sample payload for it has `actionOwner: "CLIENT"`, and `actionOwner` has a `PLATFORM` value).

### POST /v0/customers/search (searchCustomers)

- Purpose: "Search Customers" by criteria [spec][docs:customer-creation-1]. Not deprecated.
- Query params (both **required**) [spec]:
  - `limit` — integer (int32), "List fetch limit, value between 1 and 1000".
  - `offset` — integer (int32), "Offset used for paging results".
- Request body (required): `SearchCustomersRequestBody` — "Body of a request to search customers". **No `required` list** (all criteria optional) [spec].

  | field | type | constraints / enum (verbatim) |
  |---|---|---|
  | `customerIds` | array of string (uuid) | `minItems: 1`, `maxItems: 2147483647` |
  | `dateOfBirth` | string (date) | `YYYY-MM-DD` |
  | `email` | string | `minLength: 1`, `maxLength: 2147483647` |
  | `firstName` | string | `minLength: 1`, `maxLength: 2147483647` |
  | `lastName` | string | `minLength: 1`, `maxLength: 2147483647` |
  | `phoneNumber` | object `PhoneNumber` | `countryCodePrefix` + `numberAfterPrefix` both required inside the object |
  | `status` | string | enum `["ACTIVE","INACTIVE","REJECTED","BLOCKED","PENDING_APPROVAL","REFERRED"]` |
- Response `200 Success`: JSON **array** of `HayCustomer` [spec]. Errors 400/403/422/500/501 [spec].
- Behaviour:
  - Read-only; no webhook.
  - Combination semantics (AND vs OR), exact vs partial/case-insensitive matching, behaviour of an empty body `{}`, and sort order are all unstated `[open, §7]`. `[inferred]`: AND of all supplied criteria, exact match, empty body = list all.
  - `limit` outside 1–1000 → `400` `[inferred]` from the description.

### POST /v0/customers/{customerHayId}/account (createHayAccount)

- Purpose: "Create Account for Customer - (To be DEPRECATED - Use POST /v1/accounts instead)" — creates a personal account owned by the customer [spec]. **Deprecation notice in the summary** (the op does not carry `deprecated: true`) [spec]. Replacement: `POST /v1/accounts` (`createAccount`, Accounts API) with `accountHolderType: "CUSTOMER"`, `accountHolderId: <customerHayId>`, `productId`, `idempotencyKey` [spec][docs:customer-creation-1].
- Path param: `customerHayId` — string (uuid), required, "Unique identifier (UUID) of the Customer" [spec].
- Request body (required): `CreateHayAccountRequest` — "Body of a request to create a personal account owned by a customer"; `required: ["idempotencyKey"]` [spec].
  - `idempotencyKey` — string (uuid), required.
  - `customData` — object, `nullable: true`, "Contains custom metadata stored with the Account".
  - **No `productId`, `currency`, or `accountNumber`** in this legacy body (all exist on `CreateAccountRequestBody` for `/v1/accounts`) — which product the account gets is unstated `[open, §7]`.
- Response `200 Success`: `HayAccount` (§2 lists fields). Errors: 400/403/**422 "Unprocessable Entity"**/500/501 `ErrorResponse` [spec].
  - 422 example "Not enough permissions" [spec]: `{"message":"PERMISSION_DENIED: Account cannot be created for customer with id eed1e718-b1ca-4b94-a508-3d2d41c2e96b as their status is currently BLOCKED","details":"Please refer to the API documentation or contact Shaype for more info with the traceId.","status":"422","traceId":"b24daeb7-4242-4ff1-ba50-9825d5deedd8"}`.
- Behaviour:
  - Precondition: "An account can only be opened if the customer is in `ACTIVE` status" [docs:customer-status-flow]; "Active customer allows for an account to be created" [docs:customer-status-flow]. Any non-ACTIVE status → `422` with `PERMISSION_DENIED: Account cannot be created for customer with id <id> as their status is currently <STATUS>` `[inferred]` from the BLOCKED example.
  - Creates a `HayAccount` with `accountHolderType: "CUSTOMER"`, `accountHolderId: <customerHayId>`, platform-generated `accountHayId`, `accountNumber` ("5-9 digits"), `bsb` (6 digits), all balances `0` [spec][docs:sample-requests-responses, createAccount /v1/accounts sample]; that sample is for `POST /v1/accounts`, and its applicability to this legacy op is `[inferred]`. Initial status: the `HayAccount.status` description says "Accounts created through this API are automatically set as APPROVED" [spec], but the documented `/v1/accounts` sample response shows `"status": "PENDING_APPROVAL"` [docs:sample-requests-responses] — conflict `[open, §7]`.
  - Account risk level defaults to `HIGH` (all limits 0, funds movement blocked) until `changeAccountRiskLevel` sets `LOW` [docs:accounts-overview][docs:customer-creation-1] — Accounts domain.
  - `idempotencyKey` recognises retries [spec]; retry semantics unstated.
  - Webhook: `ACCOUNT_STATUS_CHANGE` with `accountStatusChangeEvent: { accountHayId, accountStatus }` [webhook-spec]; docs sample shows `accountStatus: "APPROVED"`, `actionOwner: "PLATFORM"` [docs:customer-creation-1] (listed under a generic "Webhook Events" heading); that account creation emits it is `[inferred]`.

### GET /v0/customers/{customerHayId}/accounts (getAccountsForCustomerId)

- Purpose: "Get Account by Customer ID" — lists accounts for a customer [spec]. Not deprecated.
- Path param: `customerHayId` — string (uuid), required [spec].
- Request body: none.
- Response `200 Success`: JSON **array** of `HayAccount` [spec]. Errors 400/403/422/500/501 [spec].
- Behaviour:
  - Read-only; no webhook.
  - Whether GROUP-held accounts the customer is a member of are included, and whether `CLOSED` accounts are included, is unstated `[open, §7]`. `[inferred]`: personal accounts (`accountHolderType: CUSTOMER`, `accountHolderId = customerHayId`) in all statuses.
  - Unknown customer → error code unstated (no 404 declared) `[open]`.

### GET /v0/customers/{customerHayId}/cards (getCardsForCustomerId)

- Purpose: "Get Cards by Customer ID" [spec]. Not deprecated.
- Path param: `customerHayId` — string (uuid), required [spec].
- Request body: none.
- Response `200 Success`: JSON **array** of `HayCard` (§2) [spec]. Errors 400/403/422/500/501 [spec].
- Behaviour:
  - Read-only; no webhook. Cards are linked to "an individual customer `customerHayId` and to an account `accountId` (individual or joint/business)" [docs:card-creation], so cards on group accounts issued to this customer are the customer's cards `[inferred]`.
  - Inclusion of `INACTIVE`/`EXPIRED` cards unstated `[open]`; `[inferred]`: all statuses.

### GET /v0/customers/{customerId} (getHayCustomerById)

- Purpose: "Get Customer by ID" [spec]. Not deprecated. Note the path param here is `customerId`, while the account/cards sub-resources use `customerHayId` — both described as "Unique identifier (UUID) of the Customer" [spec]; treated as the same value `[inferred]`.
- Path param: `customerId` — string (uuid), required, "Unique identifier (UUID) of the Customer" [spec].
- Request body: none.
- Response `200 Success`: `HayCustomer` [spec]. Errors 400/403/422/500/501 [spec].
- Behaviour: read-only; returns `customData` set at creation [docs:custom-data-for-customer-creation]. Unknown ID → code unstated (no 404 declared) `[open, §7]`.

### PATCH /v0/customers/{customerId} (updateCustomer)

- Purpose: "Update Customer details" — partial update of the record "except customer status" [spec][docs:customer-creation-1]. Not deprecated.
- Path param: `customerId` — string (uuid), required [spec].
- Request body (required): `UpdateCustomerRequestBody` — "Describes the changes to be applied to Customer record. Only the provided information will be updated. Address and Phone Number will be replaced as a whole (no partial updates are possible)." **No `required` list** [spec].

  | field | type | constraints / enum (verbatim) | semantics [spec] |
  |---|---|---|---|
  | `address` | object `Address` | `required: countryCodeIso, line1` inside | replaced as a whole |
  | `dateOfBirth` | string (date) | `YYYY-MM-DD` | |
  | `documentData` | object `DocumentData` | `required: ["identityDocumentIssuingCountry","identityDocumentNumber","identityDocumentType"]`; `identityDocumentCardNumber` pattern `^[a-zA-Z0-9]{6,10}$`; `identityDocumentExpiry` date; `identityDocumentRegion` pattern `NSW\|QLD\|SA\|TAS\|VIC\|WA\|ACT\|NT`; `identityDocumentType` enum `["DRIVING_LICENSE","PASSPORT"]` | "When provided will be updated as a whole, setting the not provided fields to null." |
  | `email` | string | | |
  | `firstName` | string | | |
  | `gender` | string | no enum; description lists `MALE`, `FEMALE`, `OTHER` | |
  | `lastName` | string | | |
  | `middleName` | string | | |
  | `phoneNumber` | object `PhoneNumber` | both sub-fields required inside | replaced as a whole |
  | `preferredName` | string | | |
  | `skipPayIdUpdate` | boolean | `default: false` | "Updating a customer's name will also update the payIDs of the linked accounts. If this flag is set to true, the payId update will be skipped." |
  | `taxObligations` | array of `TaxObligation` | | "Overrides existing list with a new provided. Setting to [] (empty array) deletes all existing items from the list" |
  | `title` | string | | |

  Note the flat name/DOB fields here map onto `HayCustomer.customerDetails.*` and `documentData.*` maps onto the flat `HayCustomer.identityDocument*` fields [spec, by name].
- Response `200 Success`: `HayCustomer` (updated) [spec]. Errors 400/403/422/500/501 [spec].
- Behaviour:
  - Only supplied fields change; `address`/`phoneNumber`/`documentData` are whole-object replacements; `taxObligations` is a list replacement with `[]` = clear [spec].
  - Cannot change `status` [docs:customer-creation-1].
  - Side effect on PayID domain: a name change updates the PayIDs of the customer's linked accounts unless `skipPayIdUpdate: true` [spec].
  - Side effect on Cards domain: the customer's stored address is used as the cardholder (billing/AVS) address for new, replaced and renewed cards, so an address update changes what later card operations use [docs:card-creation].
  - Sets `lastUpdatedDateTimeUtc` `[inferred]` from the field's description.
  - Whether duplicate checks (email/phone/document/name+DOB) are re-run on update is unstated `[open, §7]`.
  - Which statuses permit update (e.g. can an `INACTIVE` customer be updated?) is unstated `[open]`.
  - Webhook: `CUSTOMER_DETAILS_CHANGE` with `customerDetailsChangeEvent: { phoneNumberChanged: boolean, customerNameChanged: boolean, emailAddressChanged: boolean, addressChanged: boolean }` [docs:customer-creation-1][webhook-spec]. Whether a no-op PATCH still emits it is unstated.

### POST /v0/customers/{customerId}/block (blockCustomer)

- Purpose: "Block Customer" [spec]. Not deprecated.
- Path param: `customerId` — string (uuid), required, "Unique identifier (UUID) of the customer" [spec].
- Request body (required): `BlockCustomerRequestBody` — "**Body of a request to block a customer.**" (markdown bold markers are in the spec string); `required: ["note"]`; `note` string `minLength: 1`, "Note or explanation for reason block is applied" [spec].
- Response `200 Success`: `GenericMessage` = `{ message: string }` ("Message indicating operation result") [spec]. Message text is not documented. Errors 400/403/422/500/501 [spec].
- Behaviour:
  - "Blocking will change the customer status to BLOCKED and sends a webhook event with the type CUSTOMER_STATUS_UPDATED. Requesting client to handle the blocking scenario at their end." [docs:customer-creation-1]
  - `HayCustomer.blockedBy` ← `CLIENT` `[inferred]` (enum `CLIENT`/`PLATFORM`; this endpoint is the client).
  - "This status does not impact the account or cards and transactions are still allowed. Separate calls to account status and card status should be used in the event transactions need to be blocked." [docs:customer-status-flow]
  - While BLOCKED, account creation for the customer fails with 422 `PERMISSION_DENIED ... status is currently BLOCKED` [spec example on createHayAccount].
  - Which prior statuses may be blocked (only `ACTIVE`? also `PENDING_APPROVAL`?), whether the `note` is stored/exposed anywhere, and the error for blocking an already-BLOCKED or INACTIVE customer are all unstated `[open, §7]`.
  - Webhook: `CUSTOMER_STATUS_UPDATED`, `customerStatusUpdatedEvent.customerStatus: "BLOCKED"`, `actionOwner: "CLIENT"` [docs:customer-creation-1][webhook-spec].

### PATCH /v0/customers/{customerId}/status (changeHayCustomerStatus)

- Purpose: "Update Customer status" [spec]. Not deprecated. Primary documented use: activate a non-KYC customer (`PENDING_APPROVAL → ACTIVE`) [docs:customer-creation-1].
- Path param: `customerId` — string (uuid), required [spec].
- Request body (required): `ChangeHayCustomerStatusRequestBody` — "Body of a request to set a customer status."; `required: ["newStatus"]` [spec].
  - `newStatus` — string, enum **`["ACTIVE","INACTIVE","REJECTED","BLOCKED","PENDING_APPROVAL","REFERRED"]`** [spec]. The field description ("Allowed Customer status. Possible values") lists only `ACTIVE`, `INACTIVE`, `PENDING_APPROVAL`, `REFERRED`, `REJECTED` — **`BLOCKED` is in the enum but not in the prose** [spec]. Whether `BLOCKED` is accepted here (vs. only via `blockCustomer`) is `[open, §7]`.
  - The docs sample request body also carries `"customerId": "..."` alongside `newStatus` [docs:sample-requests-responses]; it is not in the schema — treat as ignored extra property `[inferred]`.
- Response `200 Success`: `HayCustomer` with the new `status` [spec]; sample response [docs:sample-requests-responses] shows `"status": "ACTIVE"` and otherwise the same shape as the create response.
- Behaviour:
  - Sets `HayCustomer.status` to `newStatus` [spec]. Transition rules are only given as an image on the status page; the text says only that `PENDING_APPROVAL` "can be 'Withdrawn' by the client at this stage" and describes each status [docs:customer-status-flow] — see §3.
  - `approvedDateTimeUtc` set when moving to `ACTIVE`; `closedDateTimeUtc` set when moving to `INACTIVE` `[inferred]` from field descriptions on `HayCustomer`.
  - `statusReason` (enum `SUSPICIOUS`/`DECEASED`/`CUSTOMER`/`OPERATIONAL`) cannot be supplied on this endpoint — it is only set via the Accounts `closeAccount` `reason` "if customer is closed along with its last open account" [spec CloseAccountRequestBody.reason].
  - Webhook: `CUSTOMER_STATUS_UPDATED` with `customerStatusUpdatedEvent.customerStatus = newStatus`, `actionOwner: "CLIENT"` [docs:customer-creation-1][webhook-spec].
  - No-op (same status) behaviour and invalid-transition error code are unstated `[open]`.

### POST /v0/customers/{customerId}/unblock (unblockCustomer)

- Purpose: "Unblock Customer" [spec]. Not deprecated.
- Path param: `customerId` — string (uuid), required [spec].
- Request body (required): `UnblockCustomerRequestBody` — "**Body of a request to unblock a customer.**" (markdown bold markers are in the spec string); `required: ["note"]`; `note` string `minLength: 1`, "Note or explanation for reason unblock is applied" [spec].
- Response `200 Success`: `GenericMessage` `{ message }` [spec]. Errors 400/403/422/500/501 [spec].
- Behaviour:
  - "Unblock a blocked customer using their unique customerId. Unblock customer will change the customer status to ACTIVE and sends a webhook event with the type CUSTOMER_STATUS_UPDATED." [docs:customer-creation-1]. Precondition therefore: status `BLOCKED` `[inferred]`; error code otherwise unstated `[open]`.
  - Always lands on `ACTIVE` (not the pre-block status) [docs:customer-creation-1]. Clears `blockedBy` `[inferred]`.
  - Whether a client may unblock a customer with `blockedBy: PLATFORM` is unstated; the Accounts `blockAccount` schema mentions "customer not blocked due to permission issues", implying permission gating exists on the customer side `[inferred, open]`.
  - Webhook: `CUSTOMER_STATUS_UPDATED`, `customerStatus: "ACTIVE"`, `actionOwner: "CLIENT"` [docs:customer-creation-1][webhook-spec].

## 2. Entities and fields

### HayCustomer — "Details of a customer" [spec]

No `required` list on the schema (every field may be absent). Property names verbatim. "Nullable" = `nullable: true` in the schema; otherwise absence is the only documented way a value is missing.

| field | type | nullable | enum (verbatim) | description / example | set by |
|---|---|---|---|---|---|
| `customerHayId` | string (uuid) | — | | "Unique identifier (UUID) of the Customer"; e.g. `d177961c-68a6-45fa-af8d-d571d274b111` [docs:sample-requests-responses] | platform on `createHayCustomer` |
| `status` | string | — | `["ACTIVE","INACTIVE","REJECTED","BLOCKED","PENDING_APPROVAL","REFERRED"]` | "Current Customer status" — ACTIVE: Customer is active; BLOCKED: Customer is blocked; INACTIVE: Customer is not active (closed); PENDING_APPROVAL: Customer is awaiting approval; REFERRED: Customer is referred for further KYC checks; REJECTED: Customer has been rejected | create (`PENDING_APPROVAL`), `changeHayCustomerStatus`, `blockCustomer` (`BLOCKED`), `unblockCustomer` (`ACTIVE`), platform KYC (`ACTIVE`/`REFERRED`/`REJECTED`), Accounts `closeAccount`/`blockAccount`, Groups `removeCustomerFromGroup` |
| `statusReason` | string | — | `["SUSPICIOUS","DECEASED","CUSTOMER","OPERATIONAL"]` | "INACTIVE status reason" — SUSPICIOUS: concerns about their account conduct; DECEASED: confirmation received that they are deceased; CUSTOMER: customer request; OPERATIONAL: operational request | Accounts `closeAccount.reason` when the closure makes the customer INACTIVE [spec] |
| `blockedBy` | string | — | `["CLIENT","PLATFORM"]` | "The type of entity that is responsible for the blocked customer" | `blockCustomer` (CLIENT `[inferred]`), platform |
| `tier` | string | — | `["FOUNDER","STANDARD","PREMIUM"]` | "will be STANDARD unless additional tiers have been agreed"; sample `STANDARD` | create (`customerTier`) |
| `email` | string | — | | sample `hello123@gmail.com` | create, `updateCustomer` |
| `phoneNumber` | `PhoneNumber` | — | | sample `{"countryCodePrefix":"61","numberAfterPrefix":"43740788666"}` | create, `updateCustomer` (whole replace) |
| `address` | `Address` | — | | sample `{"line1":"395 Bourke St","townOrCity":"Melbourne","administrativeRegion":"VIC","postcode":"3000","countryCodeIso":"AUS"}` | create, `updateCustomer` (whole replace) |
| `customerDetails` | `CustomerDetails` | — | | sample `{"firstName":"John","middleName":"Bryan","lastName":"Smith","dateOfBirth":"1996-02-25","gender":"OTHER"}` | create, `updateCustomer` (flat fields) |
| `customData` | object | yes | | "Custom data associated with customer"; e.g. `{"external_id":"359916f3-10d2-437e-a0f0-ea83ac8fd9c2"}` [docs:custom-data-for-customer-creation] | create only (no update op in this domain) |
| `clientReference` | string | — | | "Client reference associated with customer". Not settable by any request body in this domain `[spec]` — origin unknown `[open]` | ? |
| `deviceId` | string | — | | "Customer's device ID, typically UUID though format controlled by mobile OS"; sample `NOT_SPECIFIED` | platform / mobile app (no B2B op sets it) |
| `deviceOs` | string | — | `["IOS","ANDROID"]` | "Customer's device operating system (if a mobile app is available)" | platform / mobile app |
| `firebaseToken` | string | — | | "Customer's device firebase token (if a mobile app is available)" | platform / mobile app; webhook `NotificationDto` carries a `firebaseDeviceToken` field [webhook-spec]; that it echoes `HayCustomer.firebaseToken` is `[inferred]` |
| `identityDocumentType` | string | — | `["DRIVING_LICENSE","PASSPORT"]` | | create, `updateCustomer.documentData` |
| `identityDocumentNumber` | string | — | | | create, `updateCustomer.documentData` |
| `identityDocumentCardNumber` | string | — | | "Between 6 to 10 characters ... numeric or alphanumeric" | create, `updateCustomer.documentData` |
| `identityDocumentExpiry` | string (date) | — | | ISO-8601 `YYYY-MM-DD`, example `2030-06-15` | create, `updateCustomer.documentData` |
| `identityDocumentIssuingCountry` | string | — | | "three-letter ISO country code" | create, `updateCustomer.documentData` |
| `identityDocumentRegion` | string | — | (pattern on request: `NSW\|QLD\|SA\|TAS\|VIC\|WA\|ACT\|NT`) | "one of: NSW, QLD, SA, TAS, VIC, WA, ACT, NT. (uppercase only)" | create, `updateCustomer.documentData` |
| `creationDateTimeUtc` | string (date-time) | — | | sample `2024-03-12T22:59:48.357089Z` (microsecond precision, `Z`) | platform on create |
| `approvedDateTimeUtc` | string (date-time) | — | | "when the customer has been approved" | platform when status → ACTIVE `[inferred]` |
| `closedDateTimeUtc` | string (date-time) | — | | "when the Customer was closed" | platform when status → INACTIVE `[inferred]` |
| `lastUpdatedDateTimeUtc` | string (date-time) | — | | "when the Customer was last updated" | platform on any update `[inferred]` |

Fields present in the create request but **absent from HayCustomer**: `externalCustomerId`, `idempotencyKey`, `identityVerificationCaseId`, `journeyId`, `onlySanctionsCheck`, `skipKyc`, `taxObligations` (tax obligations are writable via create/update but never returned) [spec]. Fields in `HayCustomer` absent from the docs sample responses: `approvedDateTimeUtc`, `blockedBy`, `clientReference`, `closedDateTimeUtc`, `customData`, `deviceOs`, `firebaseToken`, `identityDocument*`, `lastUpdatedDateTimeUtc`, `statusReason` — the samples omit rather than null them [docs:sample-requests-responses].

Read by: `getAllCustomers`, `searchCustomers`, `getHayCustomerById`; returned by `createHayCustomer`, `updateCustomer`, `changeHayCustomerStatus`.

### CustomerDetails — "Personal details of a customer" [spec]

`required: ["dateOfBirth","firstName","lastName"]`. `dateOfBirth` string(date) `YYYY-MM-DD`; `firstName` string minLength 1; `gender` string (no enum; prose: MALE / FEMALE / OTHER); `lastName` string minLength 1; `middleName` string; `preferredName` string; `title` string. Sample `title: "Mr."`, `preferredName: "Test Test"` [docs:flexible-kyc-checks].

### Address — "Address of the Customer" [spec]

`required: ["countryCodeIso","line1"]`. `administrativeRegion` 1–3 chars; `countryCodeIso` exactly 3 chars; `line1`, `line2`, `townOrCity` 0–120 chars; `postcode` 0–10 chars. The flexible-KYC sample request also sends `line3`, `line4`, `line5` (not in the schema) [docs:flexible-kyc-checks] — treat as ignored extras `[inferred]`. Same schema is reused as `CreateHayCardRequestBody.deliveryAddress` [spec].

### PhoneNumber — "Phone number of the Customer" [spec]

`required: ["countryCodePrefix","numberAfterPrefix"]`, both string minLength 1. Samples: `"+61"`/`"61"` and `"43740788666"`, `"5883924545"`.

### TaxObligation [spec]

No required list. `country` string (ISO 3166 alpha-3); `noTaxIdNumberReason` enum `["NOT_APPLICABLE","NOT_ISSUED","DISCLOSURE_NOT_REQUIRED"]`; `taxIdNumber` string ("Must NOT provide Australian Tax File Number (TFN)"). Write-only (never returned) [spec].

### DocumentData (request-only, `updateCustomer`) [spec]

`required: ["identityDocumentIssuingCountry","identityDocumentNumber","identityDocumentType"]`; other fields as on the create request. "When provided will be updated as a whole, setting the not provided fields to null."

### GenericMessage [spec]

`{ message: string }` — returned by `blockCustomer`, `unblockCustomer` (also by Accounts `unblockAccount`, Click-to-Pay `unenrolCustomer`). Text undocumented for customer ops; the only documented example of the shape is Accounts `{"message": "Risk level changed successfully."}` [docs:sample-requests-responses].

### ErrorResponse [spec]

`{ details: string, message: string, status: string (HTTP code as string), traceId: string }`. See §6 for known messages.

### HayAccount — returned by `createHayAccount`, `getAccountsForCustomerId` (owned by the Accounts domain; listed here because this domain returns it) [spec]

`required: ["customData"]` (the only required property!). Fields: `accountHayId` uuid; `accountHolderId` uuid; `accountHolderType` enum `["CUSTOMER","GROUP"]`; `accountNumber` string "5-9 digits" (v1 create request says "8-9 digits"); `availableBalance` number; `blockedBy` enum `["CLIENT","PLATFORM"]`; `bsb` string 6 digits; `closedDateTimeUtc` date-time; `creationDateTimeUtc` date-time; `currency` ISO-4217 enum (162 codes incl. `AUD`); `customData` object nullable; `heldBalance` number; `homeCurrencyBalanceEquivalent` object `{ availableBalance, currency, heldBalance, totalBalance }`; `lockedBalance` number; `overdraftBalance` number; `overdraftLimit` number; `parentAccountId` uuid nullable ("Only present for child (e.g. non-AUD FX) accounts"); `productId` uuid; `stacksBalance` number; `status` enum `["PENDING_APPROVAL","APPROVED","ACTIVE","LOCKED","DORMANT","CLOSED","ACTIVE_IN_ARREARS"]`; `technicalOverdraftBalance` number; `totalBalance` number. Sample [docs:sample-requests-responses]: `{"accountHayId":"7bd7479d-787a-9876-8a11-d8424f1ea078","accountHolderId":"997d394b-e22f-0000-a69d-0b209671baab","accountHolderType":"CUSTOMER","productId":"997d394b-e22f-8467-a69d-0b209671brre","accountNumber":"66090672","bsb":"636220","currency":"AUD","status":"PENDING_APPROVAL","totalBalance":0,"heldBalance":0,"availableBalance":0,"lockedBalance":0,"stacksBalance":0,"technicalOverdraftBalance":0,"creationDateTimeUtc":"2024-03-12T23:54:30.491966Z","overdraftBalance":0,"overdraftLimit":0}`.

### HayCard — returned by `getCardsForCustomerId` (owned by the Cards domain) [spec]

No required list. `accountHayId` uuid; `blockedBy` enum `["CLIENT","PLATFORM"]`; `cardHayId` uuid; `cardStatus` enum `["ACTIVE","AWAITING_ACTIVATION","BLOCKED","INACTIVE","EXPIRED"]`; `cardToken` string "maximum 9 digits"; `cardType` enum `["PHYSICAL","VIRTUAL"]`; `customerHayId` uuid ("cardholder"); `deliveryMethod` enum `["STANDARD","REGISTERED","COURIER","EXPRESS"]`; `expiryDate` date ("last day of the expiry month and year"); `issuedDateTimeUtc` date-time; `lastFourDigits` string; `nameOnCard` string; `nameOnCardLine2` string; `renewedIntoCardId` uuid nullable; `voidDateTimeUtc` date-time nullable.

### Webhook payload `NotificationDto` (Shaype → client `POST {clientBase}/api/hay/v0/communications/notification`) — customer-relevant subset [webhook-spec]

The webhook spec also declares `POST /api/hay/v1/communications/notification` (summary "Generic Notification - event") carrying `NotificationDtoV1` { actionOwner, createdTimeUtc, eventDetails, idempotencyKey (req), type (req) } — a newer generic format [webhook-spec]; the docs page only describes the v0 paths [docs:webhook-notification]. This map documents the v0 `NotificationDto` shape.

`required: ["customerHayId","idempotencyKey","type"]`. `customerHayId` uuid; `idempotencyKey` uuid ("prevent duplication"); `type` enum (full, verbatim) `["ACCOUNT_STATUS_CHANGE","CUSTOMER_STATUS_UPDATED","CARD_ADDED_TO_WALLET","CARD_STATUS_CHANGE","CUSTOMER_DETAILS_CHANGE","ONBOARDING_PASSED","ONBOARDING_FAILED","REMINDER","SCHEDULED_PAYMENT","TRANSACTION","DIRECT_ENTRY","MANDATE","MANDATE_DUE_PAYMENT","MANDATE_PAYMENT","APPLE_PAY_REWARD_FOR_CUSTOMER","MANDATE_ACTION_EXPIRATION","DELEGATED_OTP_NOTIFICATION"]`; `firebaseDeviceToken` string; `actionOwner` enum `["CLIENT","PLATFORM"]`; `cardHayId` uuid nullable; `productId` uuid; event sub-objects:
- `customerStatusUpdatedEvent` (`CustomerStatusUpdatedEventDto`): `{ customerStatus: enum ["ACTIVE","INACTIVE","REJECTED","BLOCKED","PENDING_APPROVAL","REFERRED"] }`.
- `customerDetailsChangeEvent` (`CustomerDetailsChangeEventDto`): `{ phoneNumberChanged: boolean, customerNameChanged: boolean, emailAddressChanged: boolean, addressChanged: boolean }`.
- `onboardingFailedEvent` (`OnboardingFailedEventDto`): `{ state: enum ["DOCUMENT_SCAN","SANCTIONS_SCAN","KYC_AML_SCAN","DUPLICATE_CHECK"], submissionFailure: boolean }` (docs sample uses `isSubmissionFailure`).
- `accountStatusChangeEvent` (`AccountStatusChangeEventDto`): `{ accountHayId: uuid, accountStatus: enum ["ACTIVE","BLOCKED","PENDING_APPROVAL","APPROVED","DORMANT","CLOSED","ACTIVE_IN_ARREARS"] }` [webhook-spec] — note `BLOCKED` here vs `LOCKED` on `HayAccount.status`; docs sample shows `APPROVED` [docs:customer-creation-1]. Accounts domain.
- `ONBOARDING_PASSED` carries no sub-object; docs sample: `{"customerHayId":"...","idempotencyKey":"...","type":"ONBOARDING_PASSED","firebaseDeviceToken":"..."}` [docs:customer-creation-1].
Client must answer 200; Shaype retries on 401/403/429/5XX, 18 times over up to 48 h with exponential backoff [docs:webhook-notification].

### External-authorisation `Customer` object (Shaype → client, `POST /transactions` in `external-balance.yaml`) [ext-auth-spec][docs:account-and-customer-context-in-external-authorisation]

`customer` (nullable): `{ id: uuid, details: { dateOfBirth, firstName, lastName, middleName }, address: { administrativeRegion, countryCodeIso, line1, line2, postcode, townOrCity }, tenure_days: int32 }`. Sent when the account holder type is `CUSTOMER`, or for a customer-initiated outbound payment (bank account / PayID / BPAY) from a group account; omitted for other group-account transactions. `address.line2` "is present only where one is held".

## 3. State machines

### Customer `status` (HayCustomer.status / newStatus / customerStatus) — values verbatim [spec]

`ACTIVE`, `INACTIVE`, `REJECTED`, `BLOCKED`, `PENDING_APPROVAL`, `REFERRED`.

Descriptions [docs:customer-status-flow]:
- `PENDING_APPROVAL` — initial state on entering onboarding; "It can be 'Withdrawn' by the client at this stage".
- `REFERRED` — evaluation concluded and the customer failed one or more steps (invalid ID, PEP flag); "Shaype would look to resolve dispute with the customer."
- `REJECTED` — "Shaype cannot open an account for the user as a result of the information provided."
- `ACTIVE` — "Active customer allows for an account to be created."
- `BLOCKED` — client-managed; "does not impact the account or cards and transactions are still allowed."
- `INACTIVE` — "Customer record is closed and can no longer access accounts or create new ones, unless successfully completing the process of re-onboarding." Re-onboarding = a **new** customer record with a new `customerHayId`; the old record stays INACTIVE for audit [docs:account-closure].

The only transition diagram is an image (not machine-readable). Transitions that the text/spec actually state:

| from | to | via | source |
|---|---|---|---|
| (none) | `PENDING_APPROVAL` | `createHayCustomer` | [docs:customer-creation-1][docs:sample-requests-responses] |
| `PENDING_APPROVAL` | `ACTIVE` | platform, on successful Shaype KYC (`ONBOARDING_PASSED`) | [docs:customer-creation-1] |
| `PENDING_APPROVAL` | `ACTIVE` | `changeHayCustomerStatus {newStatus: ACTIVE}` (client KYC / `skipKyc`) | [docs:customer-creation-1] |
| `PENDING_APPROVAL` | `REFERRED` | platform, KYC check failed (incl. reduced KYC) | [docs:customer-status-flow][docs:flexible-kyc-checks] (source state PENDING_APPROVAL `[inferred]`; docs describe only the REFERRED outcome) |
| `PENDING_APPROVAL` | `REJECTED` | platform, onboarding evaluation concluded negatively | [docs:customer-status-flow] |
| `PENDING_APPROVAL` | "Withdrawn" (target status not named; `INACTIVE` or `REJECTED` `[inferred]`) | client (`changeHayCustomerStatus`) | [docs:customer-status-flow] |
| `REFERRED` | `ACTIVE` / `REJECTED` | Shaype operations resolving the referral. KYC API exposes `approveAmlKycCheck`, `approveDocumentCheck`, `approveSanctionCheck` (`POST /v1/kyc/{customerId}/onboarding/{amlKycCheck\|documentCheck\|sanctionCheck}/approval`, body `OnboardingStageApprovalBody { comments }`, 200 `ConfirmationResponse`); none documents a resulting customer status [spec] | `[inferred]` from [docs:customer-status-flow] |
| (unstated; `ACTIVE` `[inferred]`) | `BLOCKED` | `blockCustomer` | [docs:customer-creation-1] |
| (unstated; `ACTIVE` `[inferred]`) | `BLOCKED` | Accounts `blockAccount` with `accountBlockStyle` absent or `ACCOUNT_AND_CUSTOMER` ("Both the account and customer(s) owning it will be blocked") | [spec BlockAccountRequestBody] |
| `BLOCKED` | `ACTIVE` | `unblockCustomer` ("will change the customer status to ACTIVE") | [docs:customer-creation-1] |
| any with open accounts | `INACTIVE` | Accounts `closeAccount` closing the customer's last non-CLOSED account ("Closing all the accounts for a customer ... will also change the customer status to INACTIVE"); `statusReason` ← `reason` | [docs:customer-status-flow][docs:account-closure][spec CloseAccountRequestBody] |
| any | `INACTIVE` | Groups `removeCustomerFromGroup` when the customer is then "linked only to accounts with a Closed status" | [docs:customer-removal] |
| any | any enum value | `changeHayCustomerStatus` — schema permits all six `newStatus` values; no matrix of legal from→to pairs is published | [spec] `[open, §7]` |

Terminal states: `INACTIVE` is effectively terminal ("unless successfully completing the process of re-onboarding", which creates a new record) [docs:customer-status-flow][docs:account-closure]. `REJECTED` is not explicitly terminal; nothing documents leaving it. `[inferred]` for the local implementation: treat `INACTIVE` and `REJECTED` as terminal for platform-driven changes, but let `changeHayCustomerStatus` set any enum value unless the implementer decides otherwise (§7).

### `statusReason` (INACTIVE reason) [spec]

Values `SUSPICIOUS`, `DECEASED`, `CUSTOMER`, `OPERATIONAL`. Not a state machine; written once when the customer becomes INACTIVE through account closure. Affects duplicate checks: SUSPICIOUS/DECEASED → still included; CUSTOMER/OPERATIONAL → excluded [docs:account-closure].

### `blockedBy` [spec]

`CLIENT` | `PLATFORM`. Set when status becomes `BLOCKED`; meaningful only while BLOCKED `[inferred]`.

### Related status enums this domain returns but does not own

- Account `status`: `PENDING_APPROVAL`, `APPROVED`, `ACTIVE`, `LOCKED`, `DORMANT`, `CLOSED`, `ACTIVE_IN_ARREARS` [spec]. Block → `LOCKED`; unblock → `ACTIVE`; close → `CLOSED` (final) [docs:accounts-overview][docs:account-status].
- Card `cardStatus`: `ACTIVE`, `AWAITING_ACTIVATION`, `BLOCKED`, `INACTIVE`, `EXPIRED` [spec]. Physical cards start `AWAITING_ACTIVATION`, virtual start `ACTIVE`; account closure → all linked cards `INACTIVE` [docs:cards][docs:account-closure].

## 4. Invariants and calculations

- **Identity**: `customerHayId` is a platform-generated UUID; the same value is accepted as `customerHayId` (accounts/cards sub-resources, `CreateHayCardRequestBody.customerHayId`, `HayGroup.customerHayIds`) and as `customerId` (GET/PATCH/block/status/unblock paths, `RemoveCustomerFromGroupRequestBody.customerId`, Stacks/Holds/Transactions `customerId`) [spec].
- **One customer per client per identity**: uniqueness (per client) over each of `email`, `phoneNumber`, (`identityDocumentType`,`identityDocumentNumber`), (`firstName`,`lastName`,`dateOfBirth`) among customers not excluded as INACTIVE [docs:customer-creation-1][docs:account-closure]. Exclusion rule: `status == INACTIVE && statusReason in {CUSTOMER, OPERATIONAL, (none)}` → excluded; `statusReason in {SUSPICIOUS, DECEASED}` → included `[inferred]` composition of the two docs pages (the docs only enumerate the four reasons; an INACTIVE customer with no reason is unaddressed).
- **Customer ↔ accounts**: "There must always be at least one Customer created to allow the generation of an Account" [docs:customers]; a customer can own many personal accounts (one-to-many) [docs:account]; an account can be created only while the customer is `ACTIVE` [docs:customer-status-flow]; group accounts require **all** members `ACTIVE` [spec createHayAccountForGroup 422 example "Not enough permissions" (POST /v0/groups/{groupHayId}/account)]. Customer becomes `INACTIVE` exactly when every account it is linked to is `CLOSED` (evaluated asynchronously after `closeAccount`, and on `removeCustomerFromGroup`) [docs:account-closure][docs:customer-removal]. Worked example: accounts {ACTIVE, ACTIVE} close one → customer stays ACTIVE; accounts {ACTIVE, CLOSED} close the ACTIVE one → customer INACTIVE [docs:account-closure].
- **Customer ↔ cards**: a card belongs to exactly one customer and one account [docs:cards]; cardholder (AVS) address = the customer's stored `address` at card creation/replacement/renewal [docs:card-creation]; default `nameOnCard` = `firstName + " " + lastName` if that is shorter than 23 characters, else `firstName[0] + " " + lastName` [docs:card-creation].
- **Customer ↔ PayID**: a name change via `updateCustomer` propagates to PayIDs of linked accounts unless `skipPayIdUpdate: true` (default `false`) [spec].
- **Dates**: `dateOfBirth`, `identityDocumentExpiry` are `YYYY-MM-DD`; `*DateTimeUtc` are ISO-8601 UTC with `Z`, samples at microsecond precision (`2024-03-12T22:59:48.357089Z`) [spec][docs:sample-requests-responses]. `tenure_days` (external auth) = whole days between customer creation date and the transaction date; created today ⇒ `0` [docs:account-and-customer-context-in-external-authorisation].
- **String constraints** [spec]: `externalCustomerId` ≤ 64; `identityDocumentCardNumber` `^[a-zA-Z0-9]{6,10}$`; `identityDocumentRegion` matches `NSW|QLD|SA|TAS|VIC|WA|ACT|NT` (unanchored in the spec — `[inferred]`: anchor it and accept only the eight uppercase codes, per the prose "uppercase only"); `Address.countryCodeIso` length 3; `Address.administrativeRegion` 1–3; `Address.line1/line2/townOrCity` ≤ 120; `Address.postcode` ≤ 10; `email`, `firstName`, `lastName`, `countryCodePrefix`, `numberAfterPrefix`, `note` minLength 1; `searchCustomers.limit` 1–1000.
- **Address validity** [docs:international-address]: `countryCodeIso == "AUS"` → Australian mandatory rules (list not in text); otherwise `line1` + valid `countryCodeIso` suffice; `administrativeRegion` if present must be a valid ISO 3166-2 subdivision for that country.
- **Phone normalisation**: sample strips leading `+` from `countryCodePrefix` on storage/return `[inferred]` from [docs:sample-requests-responses].
- **Defaults observed in samples** `[inferred]`: `gender` → `"OTHER"` when omitted; `deviceId` → `"NOT_SPECIFIED"` when no mobile app has registered a device; `tier` mirrors `customerTier`.
- **Balances** (on `HayAccount`, for completeness — Accounts domain owns the maths) [spec descriptions]: `availableBalance` = "Total balance available for use ... Funds that are held, locked and allocated to a Stack will not be available"; `totalBalance` = "Total value of all funds on the Account (this amount will also include unused overdraft limit and Stacks, held and locked value)"; `heldBalance`, `lockedBalance`, `stacksBalance`, `overdraftBalance`, `overdraftLimit`, `technicalOverdraftBalance` all "Positive value to 2 decimal places" (technicalOverdraft: "Value to 2 decimal places"). A new account has every balance `0` [docs:sample-requests-responses]. No explicit formula is published; `availableBalance = totalBalance − heldBalance − lockedBalance − stacksBalance` is the natural reading `[inferred]`.
- **Pagination**: `offset`/`limit` are required on both list endpoints; no maximum is stated for `getAllCustomers` [spec].
- **Idempotency**: `idempotencyKey` (UUID) is required on `createHayCustomer` and `createHayAccount` and "used to recognise any subsequent retries" [spec]; what a retry returns is unstated (§7). Webhook `idempotencyKey` is the client-side dedupe key [webhook-spec].

## 5. Cross-domain dependencies

What this domain **reads/writes elsewhere**:
- **Accounts**: `createHayAccount` creates a `HayAccount` (deprecated path; canonical is `POST /v1/accounts` with `accountHolderType: CUSTOMER`); `getAccountsForCustomerId` reads accounts by holder. `updateCustomer` (name) touches PayIDs on the customer's accounts [spec].
- **Cards**: `getCardsForCustomerId` reads `HayCard` by `customerHayId`. The customer's `address`, `firstName`/`lastName`, `email`, `phoneNumber` feed card creation defaults [docs:card-creation] (`CreateHayCardRequestBody` also takes them explicitly, `required: accountId, customerHayId, deliveryAddress, email, firstName, idempotencyKey, lastName, phoneNumber, pin` [spec]).
- **PayID**: name updates cascade unless `skipPayIdUpdate` [spec].
- **Webhooks**: emits `CUSTOMER_STATUS_UPDATED`, `CUSTOMER_DETAILS_CHANGE`, `ONBOARDING_PASSED`, `ONBOARDING_FAILED`, and (via account creation) `ACCOUNT_STATUS_CHANGE` [docs:customer-creation-1][webhook-spec].

What **other domains read/write on customers**:
- **Accounts `createAccount` / `createHayAccount`**: require customer `ACTIVE` (422 `PERMISSION_DENIED ... status is currently BLOCKED`) [spec createHayAccount 422 example][docs:customer-status-flow]; `/v1/accounts` `createAccount` declares no error example, so the same 422 there is `[inferred]`.
- **Groups `createHayAccountForGroup`** (`POST /v0/groups/{groupHayId}/account`): group account creation requires all members ACTIVE: 422 `PERMISSION_DENIED: Account cannot be created for group with id <id>, all members of the group should have an ACTIVE status` [spec createHayAccountForGroup 422 example "Not enough permissions" (POST /v0/groups/{groupHayId}/account)]; not declared on `createAccount` (`/v1/accounts`) or `createHayAccount` — applicability there is `[inferred]`.
- **Accounts `blockAccount`** (`POST /v0/accounts/{accountId}/block`, summary "Block Account and Customer"): "Blocks the account (and by default its owning customer(s))"; `accountBlockStyle` enum `ACCOUNT_ONLY` | `ACCOUNT_AND_CUSTOMER` (default when absent; deprecated, to be removed); "It returns SUCCESS in case of partial success (Account blocked, but customer not blocked due to permission issues)"; idempotent [spec]. ⇒ customer `BLOCKED`, `blockedBy` per actor `[inferred]`.
- **Accounts `unblockAccount`**: account → `ACTIVE` [docs:accounts-overview]; whether it also unblocks the customer is unstated `[open]`.
- **Accounts `closeAccount`** (`POST /v0/accounts/{accountId}/close`, 202 `CloseAccountResponse {result: SUCCESS|FAILURE, description, errors[]}`): asynchronously, if all the customer's linked accounts are then CLOSED → customer `INACTIVE`, `closedDateTimeUtc` set `[inferred]`, `statusReason` ← `reason` (`SUSPICIOUS|DECEASED|CUSTOMER|OPERATIONAL`, optional), all future notifications for the customer cancelled, linked cards → `INACTIVE` [docs:account-closure][spec].
- **Groups**: `createHayGroup` / `addCustomersToGroup` take `customerHayIds[]`; `removeCustomerFromGroup` takes `customerId`, cancels the customer's cards on group accounts, re-evaluates INACTIVE, and rejects removing the last member [docs:customer-removal][docs:groups][spec]. Group members need not hold cards to access the group account [docs:groups].
- **KYC API**: `createCase` (`POST /v1/kyc/identity-verification/cases`) returns `scanCase.id` used as `identityVerificationCaseId`; platform drives `PENDING_APPROVAL → ACTIVE/REFERRED/REJECTED` and emits `ONBOARDING_*` [docs:customer-creation-1][docs:sample-requests-responses]. KYC API exposes `approveAmlKycCheck`, `approveDocumentCheck`, `approveSanctionCheck` (`POST /v1/kyc/{customerId}/onboarding/{amlKycCheck|documentCheck|sanctionCheck}/approval`, body `OnboardingStageApprovalBody { comments }`, 200 `ConfirmationResponse`); none documents a resulting customer status [spec].
- **Click to Pay**: `DELETE /v0/customers/{customerId}/ctp` (`unenrolCustomer`) lives under the customers path but is tagged "Click to Pay API" — **not** one of the 11 ops here [spec].
- **Stacks / Holds / Transactions / Scheduled Payments**: carry `customerId`/`customerHayId` references (`AccountToStackTransferRequestBody`, `StackToAccountTransferRequestBody`, `StackToStackTransferRequestBody`, `AuthorisationHold`, `FinancialTransaction`, `HayStackTransaction`, `HayScheduledPayment`, `HayArchivedScheduledPayment`, `ExternalCase`, `ExternalCounterpartDetails`) [spec] — read-only references to `customerHayId`.
- **External authorisation** (Shaype → client): sends `customer { id, details, address, tenure_days }` snapshot with non-scheme transactions; `Hold.customerId` on card holds [ext-auth-spec].

## 6. Error catalogue

Declared on **every** one of the 11 operations [spec]: `400 Bad Request`, `403 Forbidden`, `422 Unprocessable Content` (createHayAccount: "Unprocessable Entity"), `500 Internal Server Error`, `501 Not Implemented`; body `ErrorResponse`. No 404/409 declared anywhere in the domain.

| condition | status | message / shape | source |
|---|---|---|---|
| Create account for a customer whose status is not ACTIVE (example: BLOCKED) | 422 | `PERMISSION_DENIED: Account cannot be created for customer with id <customerHayId> as their status is currently BLOCKED`; `details: "Please refer to the API documentation or contact Shaype for more info with the traceId."`; `status: "422"`; `traceId: <uuid>` | [spec createHayAccount 422 example "Not enough permissions"] |
| Create account for a group with a non-ACTIVE member | 422 | `PERMISSION_DENIED: Account cannot be created for group with id <groupHayId>, all members of the group should have an ACTIVE status` | [spec createHayAccountForGroup 422 example "Not enough permissions" (POST /v0/groups/{groupHayId}/account)]; not declared on `createAccount` (`/v1/accounts`) — applicability there `[inferred]` |
| Duplicate customer (email / phone / docType+docNumber / firstName+lastName+DOB) | unstated ("customer creation will fail") | unstated; async `ONBOARDING_FAILED` with `state: DUPLICATE_CHECK` exists for the KYC path | [docs:customer-creation-1][webhook-spec] |
| `skipKyc` and `onlySanctionsCheck` both true | unstated | "This flag cannot be used at the same time as ..." | [spec] |
| Missing required body field / minLength / pattern / enum violation (e.g. `note` empty, `newStatus` not in enum, `identityDocumentCardNumber` not `^[a-zA-Z0-9]{6,10}$`) | 400 `[inferred]` | unstated | [spec constraints] |
| Missing required query `offset`/`limit`; `searchCustomers.limit` outside 1–1000 | 400 `[inferred]` | unstated | [spec] |
| Non-UUID path id | 400 `[inferred]` | unstated | [spec format uuid] |
| Unknown customer id | unstated (no 404 declared; 400 or 422 `[inferred]`) | unstated | [spec] |
| Address fails country-specific mandatory rules / bad `administrativeRegion` | unstated (400 or 422 `[inferred]`) | unstated | [docs:international-address] |
| Unblock a customer that is not BLOCKED; block an INACTIVE customer; illegal status transition | unstated | unstated | — |
| Not authorised for the client / permission gating (e.g. platform-blocked customer) | 403 `[inferred]` (declared on every op) | unstated | [spec] |
| Webhook delivery: client responds 401/403/429/5XX | Shaype retries 18 times over ≤48 h (exponential backoff) | — | [docs:webhook-notification] |
| Webhook endpoint contract (client side) | 200 Success / 403 Unauthorised / 422 Invalid Input / 500 Internal error | — | [webhook-spec] |

## 7. Open questions

Decisions the implementer must make (nothing in spec/docs settles them):

1. **HTTP code for unknown `customerId`/`customerHayId`** — no 404 declared on any op. Choose 404 (REST-natural) or 422/400 (spec-declared).
2. **Legal `changeHayCustomerStatus` transitions** — schema allows all six values (incl. `BLOCKED`, which the prose omits). Decide: free-set, or enforce the graph in §3 (documented: PENDING_APPROVAL→ACTIVE/REFERRED/REJECTED, ACTIVE↔BLOCKED, any→INACTIVE via account closure/group removal; inferred: PENDING_APPROVAL→INACTIVE for Withdrawn, REFERRED→ACTIVE/REJECTED) and what error (422?) an illegal transition returns. Also whether same-status is a no-op 200 or an error, and whether a `CUSTOMER_STATUS_UPDATED` webhook fires on a no-op.
3. **What "Withdrawn" means** for a PENDING_APPROVAL customer — which target status (`INACTIVE`? `REJECTED`?).
4. **Duplicate-check failure code and message** on `createHayCustomer` (sync 4xx vs. async `ONBOARDING_FAILED`), and whether duplicate checks re-run on `updateCustomer`.
5. **Idempotent retry semantics** for `idempotencyKey` on create customer/account: return the original resource (200) vs. conflict (409 is not declared). Key scope (per client? global?) and TTL.
6. **`createHayAccount` product** — legacy body has no `productId`/`currency`; pick a default product (e.g. the client's single/first product, `AUD`). Initial account status: `APPROVED` (spec prose) vs `PENDING_APPROVAL` (docs sample).
7. **Australian address mandatory set** — only in an image; `[inferred]` `line1`, `townOrCity`, `administrativeRegion`, `postcode`, `countryCodeIso`. Whether `administrativeRegion` for AUS must be one of the 8 state codes.
8. **`searchCustomers` semantics** — AND vs OR across criteria; exact vs prefix/case-insensitive match on names/email; whether `{}` returns everything; `customerIds` combined with other criteria; sort order and stability of `offset` paging for both list ops.
9. **Which accounts `getAccountsForCustomerId` returns** — personal only, or also GROUP accounts the customer is a member of; include CLOSED?
10. **Which cards `getCardsForCustomerId` returns** — include INACTIVE/EXPIRED/voided cards?
11. **`blockCustomer` preconditions** — allowed from which statuses; `blockedBy` value; whether a client may `unblockCustomer` a `PLATFORM`-blocked customer; whether `note` is persisted/exposed; `GenericMessage.message` text for block/unblock.
12. **Whether Accounts `unblockAccount` also unblocks the owning customer** when it was blocked via `ACCOUNT_AND_CUSTOMER`.
13. **Timing of INACTIVE via account closure** — documented as asynchronous; the local implementation must decide sync vs. deferred, and whether `closedDateTimeUtc`/`statusReason` are set at that moment.
14. **`clientReference`** — appears on `HayCustomer` but no request sets it; leave null or map from `externalCustomerId`?
15. **`gender`** — free string in schema; enforce `MALE|FEMALE|OTHER`? default `OTHER` when omitted (as in the sample)?
16. **Phone/prefix normalisation** — strip leading `+`? validate mobile-ness? (docs require mobile).
17. **Response field presence** — samples omit unset fields (no explicit `null`s); decide omit-vs-null policy, especially for `customData` (schema `nullable`).
18. **`identityDocumentRegion` regex anchoring** — spec pattern is unanchored; anchor it?
19. **`skipKyc` given as the string `"true"`** in the docs sample — accept string booleans or reject with 400?
20. **KYC simulation** — with `skipKyc: false` the real platform moves status asynchronously; the local server needs a policy (auto-activate immediately, stay PENDING_APPROVAL until a test hook, or emit `ONBOARDING_PASSED`/`FAILED` on demand) and must decide whether `identityVerificationCaseId` is validated against KYC `createCase`.
21. **Which fields `updateCustomer` may touch for INACTIVE/REJECTED customers**, and whether `CUSTOMER_DETAILS_CHANGE` fires when nothing effectively changed.
22. **`tier` mutability** — no op updates `tier` after creation; confirm immutable.
23. **Auth/403** — the spec carries no security scheme; decide how the local server scopes customers per client (all four duplicate-check rules are "under a single client").
