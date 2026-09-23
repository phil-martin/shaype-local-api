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
- `ErrorResponse` = `{ details: string, message: string, status: string, traceId: string }` [spec]. The one worked example is `{"message":"PERMISSION_DENIED: Account cannot be created for customer with id eed1e718-b1ca-4b94-a508-3d2d41c2e96b as their status is currently BLOCKED","details":"Please refer to the API documentation or contact Shaype for more info with the traceId.","status":"422","traceId":"b24daeb7-4242-4ff1-ba50-9825d5deedd8"}` [spec]. Note `status` is a **string** containing the HTTP code.
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
  - `tier` ← `customerTier`; `customData` stored verbatim and returned by `getHayCustomerById` [docs:custom-data-for-customer-creation].
  - Sample shows `phoneNumber.countryCodePrefix` sent as `"+61"` and returned as `"61"` (leading `+` stripped) and `gender` defaulting to `"OTHER"` and `deviceId` defaulting to `"NOT_SPECIFIED"` when not supplied [docs:sample-requests-responses]; whether these are guaranteed normalisations is `[inferred]`.
  - Two creation modes distinguished by `skipKyc` (default `false`) [docs:customer-creation-1]:
    - **Shaype KYC** (`skipKyc` false): client first calls KYC `POST /v1/kyc/identity-verification/cases` (`createCase`) and passes `scanCase.id` as `identityVerificationCaseId`; "The customer will become active automatically when the KYC is successful" — platform moves `PENDING_APPROVAL → ACTIVE` [docs:customer-creation-1]. Reduced KYC: `onlySanctionsCheck: true` runs only sanctions screening; "If a customer fails a check they will be referred to an operational colleague" (i.e. `REFERRED`) [docs:flexible-kyc-checks].
    - **Client KYC** (`skipKyc` true, or client not on Shaype KYC): customer stays `PENDING_APPROVAL` until client calls `changeHayCustomerStatus` with `ACTIVE` [docs:customer-creation-1].
  - `skipKyc` and `onlySanctionsCheck` are mutually exclusive [spec]; error code when both true is not stated `[open]`.
  - **Duplicate checks** — "The Shaype platform does not support creating a customer with the same details under a single client"; checks on: Email Address; Phone Number; Combination of Document Type and Number; Combination of First Name, Last Name and DOB. "If a duplicate is found, customer creation will fail." "If a customer is INACTIVE, they will be excluded from duplicate checks." Checks can be disabled per client by Shaype [docs:customer-creation-1]. Exception: an INACTIVE customer whose last account was closed with `reason` `SUSPICIOUS` or `DECEASED` **stays included** in duplicate checks; `CUSTOMER`/`OPERATIONAL` are excluded [docs:account-closure]. HTTP status for a duplicate is not stated `[open]`; the webhook `OnboardingFailedEventDto.state` enum includes `DUPLICATE_CHECK`, so in the KYC flow a duplicate may surface asynchronously as `ONBOARDING_FAILED` `[inferred]`.
  - **Address validation** [docs:international-address]: validation depends on `countryCodeIso` (the doc calls it `countryIsoCode`; the schema property is `countryCodeIso`). `AUS` → "the same validation and mandatory data rules currently required" (the exact AUS-mandatory field list is only in an image; `[inferred]`: `line1`, `townOrCity`, `administrativeRegion`, `postcode`, `countryCodeIso` — this is what every AUS sample carries). Non-AUS → `line1` and a valid 3-letter `countryCodeIso` required, everything else optional; `administrativeRegion`, if provided, is validated against ISO 3166-2.
  - Phone "must be a mobile not a landline" (used for 2FA, SMS, 3DS) [docs:customer-creation-1]; enforcement/error not stated.
  - `idempotencyKey` is "used to recognise any subsequent retries" [spec]; the effect of a retry (same key) is not stated `[open]`. `[inferred]`: return the originally created customer.
  - Webhooks (Shaype → client, all on `POST /api/hay/v0/communications/notification`) [docs:customer-creation-1][webhook-spec]: `ONBOARDING_PASSED` and `ONBOARDING_FAILED` (KYC outcome; `onboardingFailedEvent: { state, submissionFailure }` — the docs sample uses the key `isSubmissionFailure` while the webhook schema says `submissionFailure`); `CUSTOMER_STATUS_UPDATED` when the platform activates the customer `[inferred]` (docs only show it for client-driven status changes, but the sample payload for it has `actionOwner: "CLIENT"`, and `actionOwner` has a `PLATFORM` value).

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
  - Creates a `HayAccount` with `accountHolderType: "CUSTOMER"`, `accountHolderId: <customerHayId>`, platform-generated `accountHayId`, `accountNumber` ("5-9 digits"), `bsb` (6 digits), all balances `0` [spec][docs:sample-requests-responses]. Initial status: the `HayAccount.status` description says "Accounts created through this API are automatically set as APPROVED" [spec], but the documented `/v1/accounts` sample response shows `"status": "PENDING_APPROVAL"` [docs:sample-requests-responses] — conflict `[open, §7]`.
  - Account risk level defaults to `HIGH` (all limits 0, funds movement blocked) until `changeAccountRiskLevel` sets `LOW` [docs:accounts-overview][docs:customer-creation-1] — Accounts domain.
  - `idempotencyKey` recognises retries [spec]; retry semantics unstated.
  - Webhook: `ACCOUNT_STATUS_CHANGE` with `accountStatusChangeEvent: { accountHayId, accountStatus }` (docs sample shows `accountStatus: "APPROVED"`, `actionOwner: "PLATFORM"`) [docs:customer-creation-1].

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

- Purpose: "Get Customer by ID" [spec]. Not deprecated. Note the path param here is `customerId`, while the account/cards sub-resources use `customerHayId` — same value [spec].
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
- Request body (required): `BlockCustomerRequestBody` — "Body of a request to block a customer."; `required: ["note"]`; `note` string `minLength: 1`, "Note or explanation for reason block is applied" [spec].
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
- Request body (required): `UnblockCustomerRequestBody` — "Body of a request to unblock a customer."; `required: ["note"]`; `note` string `minLength: 1`, "Note or explanation for reason unblock is applied" [spec].
- Response `200 Success`: `GenericMessage` `{ message }` [spec]. Errors 400/403/422/500/501 [spec].
- Behaviour:
  - "Unblock a blocked customer using their unique customerId. Unblock customer will change the customer status to ACTIVE and sends a webhook event with the type CUSTOMER_STATUS_UPDATED." [docs:customer-creation-1]. Precondition therefore: status `BLOCKED` `[inferred]`; error code otherwise unstated `[open]`.
  - Always lands on `ACTIVE` (not the pre-block status) [docs:customer-creation-1]. Clears `blockedBy` `[inferred]`.
  - Whether a client may unblock a customer with `blockedBy: PLATFORM` is unstated; the Accounts `blockAccount` schema mentions "customer not blocked due to permission issues", implying permission gating exists on the customer side `[inferred, open]`.
  - Webhook: `CUSTOMER_STATUS_UPDATED`, `customerStatus: "ACTIVE"`, `actionOwner: "CLIENT"` [docs:customer-creation-1][webhook-spec].
