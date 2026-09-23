# payid-npp

Domain: PayID API (8 operations) + NPP API (1 operation) = **9 operations**. Source key: `[spec]` = `b2b-operations-api.json`; `[docs:payid]`, `[docs:payments]`, `[docs:multi-bsb-routing]`, `[docs:payment-transaction-outcome]` = developer.shaype.com pages; `[docs:payid-image]` = the NPP state-model diagram embedded in docs/payid; `[webhooks]` = `notification-webhooks.json`; `[inferred]` = my reading, not stated anywhere.

Shared shapes used by every operation below [spec]:

- `ErrorResponse` (all 400/403/422/500/501 responses): `{ details: string, message: string, status: string (HTTP status as a string, e.g. "422"), traceId: string }`. All fields optional in the spec.
- `GenericMessage` (200 for the three mutating PayID ops): `{ message: string }` — "Message indicating operation result". No documented message text.
- `payIdType` enum, verbatim and in spec order everywhere it appears: `["EMAIL","TELEPHONE","INDIVIDUAL_AUSTRALIAN_BUSINESS","ORGANISATION"]`.
- `reason` enum, verbatim and in spec order: `["FROD","CUST","DECD","LEGL","PART"]` — CUST: Customer initiated, DECD: Customer deceased, FROD: Fraud suspected, LEGL: Legal reasons, PART: NPP participant initiated.
- PayID `status` / `payIdStatus` enum, verbatim and in spec order: `["ACTIVE","DEREGISTERED","DISABLED","PORTABLE"]`.
- Every op declares responses 200, 400 "Bad Request", 403 "Forbidden", 422 "Unprocessable Content", 500 "Internal Server Error", 501 "Not Implemented" [spec]. No 404 and no 409 is declared on any op in this domain [spec]. No op has a `description`, `deprecated` flag, or `security` block [spec]; no header parameters are declared [spec].
- Staging-only: the docs describe a `callFlags: BSB=<6 digits>` request header used by the mock PayID service to decide which BSB "owns" the PayID; when absent, the client's own assigned BSB is used [docs:payid]. Not in the spec.

## 1. Operations

### GET /v0/payids/{payId} (getPayId)

- Purpose: return account details + PayID details for a PayID registered under the caller's own BSB [spec summary "Get PayID details", docs:payid]. Not deprecated [spec].
- Path/query params [spec]:
  - `payId` (path, string, required) — "PayID".
  - `payIdType` (query, string, **required**, enum `["EMAIL","TELEPHONE","INDIVIDUAL_AUSTRALIAN_BUSINESS","ORGANISATION"]`).
- Request body: none.
- Response 200 `PayIdResponse` [spec]:
  - `accountDetails: PayIdAccountDetails` → `{ accountNumber: string ("Account number, 5-9 digits in length"), branchNumber: string ("BSB ... 6 digits in length"), ownerName: string }`
  - `payIdDetails: PayIdDetailsResponse` → `{ lastResolutionDateTimeUtc: date-time, lastUpdatedDateTimeUtc: date-time, payIdName: string, payIdType: enum, payIdValue: string, reason: enum, registrationDateTimeUtc: date-time, status: enum }`
  - 400/403/422/500/501 → `ErrorResponse`.
- Behaviour:
  - Ownership check: "you can only retrieve details of PayID's if the account belongs to you. You will not get the details of PayID registered externally" and "you can only retrieve the status and statusDetails of PayID's registered by you" [docs:payid]. On staging the ownership check compares the PayID's BSB with the `callFlags` BSB (or the client's BSB) [docs:payid]. Which HTTP status is returned when the PayID is not owned is **not documented** — 403 is declared and is the natural fit, 422 is also declared [inferred].
  - Read-only; no state change [inferred].
  - `payIdType` is required here but optional on `availability` and `resolve` — the tuple (payId value, payIdType) is the identity of a PayID [inferred from the spec's parameter shapes].
  - Idempotent (GET) [inferred].
- Webhooks: none documented.

### GET /v0/payids/{payId}/availability (getPayIdAvailability)

- Purpose: check whether a PayID value is available to be registered [spec summary "Check PayID availability", docs:payid]. Not deprecated.
- Params [spec]:
  - `payId` (path, string, required).
  - `payIdType` (query, string, **optional**, enum `["EMAIL","TELEPHONE","INDIVIDUAL_AUSTRALIAN_BUSINESS","ORGANISATION"]`). No default declared.
- Request body: none.
- Response 200 `PayIdAvailabilityDetailsResponse` [spec] — "Response for the PayID availability inquiry":
  - `availability: boolean` — true: "PayID is available to be registered to an Account"; false: "PayID is not available to be registered to an Account".
  - `lastResolutionDateTimeUtc: string(date-time)` — when last resolved.
  - `lastUpdatedDateTimeUtc: string(date-time)` — when last updated.
  - `reason: string` enum `["FROD","CUST","DECD","LEGL","PART"]` — "Reason for current PayID status".
  - `registrationDateTimeUtc: string(date-time)` — when registered.
  - `servicer: string` — "Where PayID is currently registered contains the Business Identifier Code (BIC11) of the financial institution with which it is registered".
  - No field is marked required [spec].
  - 400/403/422/500/501 → `ErrorResponse`.
- Behaviour:
  - "If it is not available for registration this indicates it is held against another account. The customer will need to contact the financial institution where the account that it's currently linked resides and either de-register or make portable the PayID to make it available for registration elsewhere" [docs:payid]. So `availability=false` while the PayID is ACTIVE or DISABLED at any FI; deregistering or making PORTABLE makes it available [docs:payid]; a DEREGISTERED PayID "can be re-registered again with the same or different account at any point" [docs:payid].
  - Whether a PayID that has never been registered returns `availability=true` with the other fields absent/null is **not documented** [inferred: yes, since there is no record to describe].
  - No ownership check is described for this endpoint (it is a lookup against the NPP Addressing Service, which spans all FIs) [inferred from docs:payid "Check PayID Availability" text].
  - Read-only; idempotent [inferred].
- Webhooks: none documented.

### GET /v0/payids/{payId}/deregister-history (getPayIdDeregisterHistory)

- Purpose: "retrieve the de-registration details for a given PayID" [docs:payid]; spec summary "Get PayID de-register history". Not deprecated.
- Params [spec]: `payId` (path, string, required) only. **No `payIdType` parameter** [spec] — see open questions.
- Request body: none.
- Response 200: `array` of `PayIdDeregisterDetailsResponse` [spec] — "Response for the PayID de-registration request":
  - `lastUpdatedDateTimeUtc: string(date-time)`
  - `payIdName: string` — alias/nickname.
  - `reason: string` enum `["FROD","CUST","DECD","LEGL","PART"]`
  - `registrationDateTimeUtc: string(date-time)`
  - 400/403/422/500/501 → `ErrorResponse`.
- Behaviour:
  - One array element per past deregistration of this PayID value [inferred from "history" + array shape]. Whether the array is empty (200 `[]`) or an error when the PayID has never been deregistered is **not documented**.
  - Ownership scope (own-BSB registrations only vs. all FIs) is **not documented**; the staging note says "Some of the PayID endpoints include an ownership check" without naming them [docs:payid].
  - Read-only; idempotent [inferred].
- Webhooks: none documented.

### POST /v0/payids/{payId}/details (updatePayIdDetails)

- Purpose: update the registered owner name and/or the nickname (`payIdName`) of a PayID [docs:payid: "allows the registered name against the PayID to be updated as well as value that can be assigned for use as a 'nickname'"]. Not deprecated.
- Params [spec]: `payId` (path, string, required).
- Request body (required) `UpdatePayIdDetailsRequestBody` [spec] — "Request body for PayID details update":
  - `ownerName: string`, nullable, optional — "Name of the individual or legal entity that is registered as the account holder".
  - `payIdName: string`, nullable, optional — alias/nickname.
  - `payIdType: string`, **required**, enum `["EMAIL","TELEPHONE","INDIVIDUAL_AUSTRALIAN_BUSINESS","ORGANISATION"]`.
  - No min/max/pattern constraints declared [spec].
- Response 200 `GenericMessage { message: string }`; 400/403/422/500/501 `ErrorResponse` [spec].
- Behaviour:
  - Updates `ownerName` (surfaced as `accountDetails.ownerName` on getPayId/resolvePayId) and `payIdName` [docs:payid + spec field descriptions]. Whether an omitted/null field is left unchanged or cleared is **not documented** [inferred: unchanged].
  - Should bump `lastUpdatedDateTimeUtc` [inferred from the field's description "when the PayID was last updated"].
  - Allowed statuses are **not documented**. A DEREGISTERED PayID is "no longer linked to any bank account" and "cannot have its status updated" [docs:payid]; by extension its details are presumably not updatable either [inferred].
  - Ownership check presumably applies (mutation of a PayID registered under the caller's BSB) [inferred]; failure code not documented.
  - Not idempotent by declaration; no idempotency key field [spec]. Repeating the same body is naturally idempotent [inferred].
- Webhooks: none documented.

### GET /v0/payids/{payId}/resolve (resolvePayId)

- Purpose: look up any PayID in the NPP Addressing Service and return the linked bank account [docs:payid "PayID Resolution"]; spec summary "Resolve PayID to bank account". Not deprecated.
- Params [spec]:
  - `payId` (path, string, required).
  - `payIdType` (query, string, **optional**, enum `["EMAIL","TELEPHONE","INDIVIDUAL_AUSTRALIAN_BUSINESS","ORGANISATION"]`).
- Request body: none.
- Response 200 `PayIdResolveResponse` [spec] — "Response for the PayID lookup request":
  - `accountDetails: PayIdAccountDetails { accountNumber: string, branchNumber: string, ownerName: string }`
  - `payIdName: string`
  - `payIdType: string` enum (as above)
  - `payIdValue: string` — "PayID"
  - 400/403/422/500/501 → `ErrorResponse`.
- Behaviour:
  - Works for PayIDs registered at any participating FI, unlike getPayId [docs:payid "Resolve PayID differences"].
  - Clients must resolve before every PAY_ID transfer (mandatory confirmation step) and must show only the PayID and the name, never `accountDetails` [docs:payid]. The docs call the name field `payIdOwnerCommonName`; **that property does not exist in the spec** — the spec's name field is `accountDetails.ownerName` [spec vs docs:payid; discrepancy].
  - Should bump `lastResolutionDateTimeUtc` on the PayID record [inferred from that field's description "when the PayID was last resolved"].
  - Resolvability by status: ACTIVE "is able to receive payments"; PORTABLE "still being able to receive payments"; DISABLED "cannot be used to make payments to the bank account"; DEREGISTERED "cannot receive Payments and is no longer linked to any bank account" [docs:payid]. Therefore resolve should succeed for ACTIVE and PORTABLE and fail for DISABLED/DEREGISTERED/unknown [inferred]; the failure status code is **not documented** (422 or 403 are the declared candidates; makeTransfer separately reports `REFUSED_INVALID_PAY_ID` [spec `TransactionOutcome`]).
  - Read-only apart from the resolution timestamp; idempotent [inferred].
- Webhooks: none documented.

### PATCH /v0/payids/{payId}/status (updatePayIdStatus)

- Purpose: move a registered PayID between statuses [docs:payid "Allows a previously registered PayID status to be updated. Refer to the PayID state model"]. Not deprecated.
- Params [spec]: `payId` (path, string, required).
- Request body (required) `UpdatePayIdStatusRequestBody` [spec] — "Request body for PayID status update":
  - `payIdStatus: string`, **required**, enum `["ACTIVE","DEREGISTERED","DISABLED","PORTABLE"]` — ACTIVE: "Activate PayID to allow it to be used"; DISABLED: "Disable PayID and prevent it from being used or transferred"; DEREGISTERED: "De-register PayID from current Account"; PORTABLE: "Place PayID in transferable state allowing it to be registered to a different Account while still being used".
  - `payIdType: string`, **required**, enum `["EMAIL","TELEPHONE","INDIVIDUAL_AUSTRALIAN_BUSINESS","ORGANISATION"]`.
  - `reason: string`, optional, nullable, enum `["FROD","CUST","DECD","LEGL","PART"]`.
- Response 200 `GenericMessage`; 400/403/422/500/501 `ErrorResponse` [spec].
- Behaviour:
  - Allowed transitions are those in section 3 (from the NPP diagram) [docs:payid-image]. "A PayID in a DEREGISTERED state cannot have its status updated, the PayID must be registered again for it to be useable" [docs:payid]. The HTTP status for an illegal transition is **not documented** (422 is the declared candidate) [inferred].
  - Side effects [docs:payid]: DISABLED keeps the account link but blocks incoming payments; PORTABLE keeps receiving payments and lets another FI register it within 14 days, after which it auto-reverts to ACTIVE; DEREGISTERED unlinks the account, makes the value available for re-registration, and the NPP Addressing Service purges the record after 90 days.
  - Stores `reason` and `status` on the PayID record (returned by getPayId / getPayIdsForAccount / availability) and appends a `PayIdDeregisterDetailsResponse` entry when the new status is DEREGISTERED [inferred from the response shapes]. Should bump `lastUpdatedDateTimeUtc` [inferred].
  - Ownership check presumably applies [inferred]; failure code not documented.
  - Setting the current status again (e.g. ACTIVE → ACTIVE) is **not documented**; no idempotency key [spec].
- Webhooks: none documented.

### GET /v1/accounts/{accountId}/payids (getPayIdsForAccount)

- Purpose: "Returns all PayIDs and details associated with a particular customer's account" [docs:payid]; spec summary "Get PayIDs by Account ID". Not deprecated.
- Params [spec]: `accountId` (path, string, format uuid, required) — "Unique identifier (UUID) of the Account".
- Request body: none.
- Response 200: `array` of `PayIdDetailsResponse` [spec] — "Details of the PayID":
  - `lastResolutionDateTimeUtc: string(date-time)`
  - `lastUpdatedDateTimeUtc: string(date-time)`
  - `payIdName: string`
  - `payIdType: string` enum `["EMAIL","TELEPHONE","INDIVIDUAL_AUSTRALIAN_BUSINESS","ORGANISATION"]`
  - `payIdValue: string`
  - `reason: string` enum `["FROD","CUST","DECD","LEGL","PART"]`
  - `registrationDateTimeUtc: string(date-time)`
  - `status: string` enum `["ACTIVE","DEREGISTERED","DISABLED","PORTABLE"]`
  - No field is marked required [spec].
  - 400/403/422/500/501 → `ErrorResponse`.
- Behaviour:
  - Multiple PayIDs per account are allowed ("can assist where multiple PayIDs registered against the same Account" [spec `payIdName` description]).
  - Whether DEREGISTERED PayIDs are included is **not documented** (they are "no longer linked to any bank account" [docs:payid], so exclusion is the natural reading) [inferred].
  - Unknown `accountId`: no 404 is declared; the natural mapping is 422 or an empty array [inferred]. Account belonging to another client: 403 [inferred].
  - Read-only; idempotent [inferred].
- Webhooks: none documented.

### POST /v1/accounts/{accountId}/payids/{payId}/register (postPayIdRegister)

- Purpose: "Allows the registration of a PayID with a particular customer's account" [docs:payid]; spec summary "Register PayID". Not deprecated.
- Params [spec]:
  - `accountId` (path, string, format uuid, required).
  - `payId` (path, string, required) — the PayID value being registered.
- Request body (required) `PayIdRegisterRequestBody` [spec] — "Request body for PayID registration"; required: `["ownerName","payIdName","payIdType"]`:
  - `ownerName: string`, required, minLength 1 — "Name of the individual or legal entity that is registered as the account holder".
  - `payIdName: string`, required, minLength 1 — alias/nickname.
  - `payIdType: string`, required, enum `["EMAIL","TELEPHONE","INDIVIDUAL_AUSTRALIAN_BUSINESS","ORGANISATION"]`.
- Response 200 `GenericMessage`; 400/403/422/500/501 `ErrorResponse` [spec].
- Behaviour:
  - Preconditions [docs:payid]: account must be NPP enabled ("PayIDs can only be registered against accounts that are NPP enabled"); the PayID value must be available ("A single PayID can only be linked to one account at a time ... cannot be registered to multiple accounts"); the value must be clearly associated with the customer (2FA-confirmed phone/email, or a business number registered to that business) — the latter is a client obligation, not a platform validation.
  - `ownerName` "**must** be reflective of the account holder name as this information will be visible and used by customers as a validation check when sending funds from another financial institution" [docs:payid]. Whether the platform validates it against the customer record is **not documented**.
  - Format rules per type [docs:payid PayID Types table]: TELEPHONE = `+` + country code (1–3 chars) + `-` + a digit 1–9 + any digits (example `+61-423765879`); EMAIL = max 256 chars, lower case, must contain `@` with leading/trailing characters, no whitespace (example `test@email.com`); INDIVIDUAL_AUSTRALIAN_BUSINESS = 9–11 digit ABN/ACN/ARBN/ARSN (example `601428737`); ORGANISATION = company/organisation name plus business description and/or location (examples `aardvark plumbing mosman nsw`, `snackspotvending 10shelley lvl08 sydney nsw`). ORGANISATION is "largely unused in the industry"; AUBN is best practice for businesses [docs:payid]. The status code for a format violation is not documented (422 [inferred]).
  - State effects [docs:payid + docs:payid-image]: creates the PayID record in status ACTIVE ("AliasRegistration": Initial → ACTV) linked to `accountId`, sets `registrationDateTimeUtc` [inferred: now], stores `ownerName`, `payIdName`, `payIdType`, `payIdValue`. A DEREGISTERED value "can be re-registered again with the same or different account at any point" [docs:payid]; a value in PORTABLE at another FI can be registered "within 14 days" of being made portable [docs:payid].
  - Registering a value that is ACTIVE/DISABLED elsewhere must fail; the HTTP status is **not documented** (no 409 is declared; 422 is the declared candidate) [inferred].
  - No idempotency key [spec]. Re-registering an already-ACTIVE value to the same account: behaviour not documented.
- Webhooks: none documented.

### GET /v1/npp/eligibility/branch-identifiers/{branchIdentifier} (verifyBranchIdentifier)

- Purpose: "Check if a Branch Identifier is eligible for NPP payments" [spec summary]; tag "NPP API" — "APIs for NPP related operations" [spec]. Not deprecated.
- Params [spec]: `branchIdentifier` (path, string, required, pattern `^\d{6}$`, example `636636`) — "Target Branch Identifier" (a BSB).
- Request body: none.
- Response 200 `NppEligibilityCheckResponse` [spec] — "Response Body of a NPP (New Payments Platform) eligibility check"; description "Branch Identifier eligibility check completed":
  - `enabled: boolean` — "Describes whether a NPP (New Payments Platform) is enabled for the subject of the request".
  - Spec examples: "Branch Identifier supports NPP payments" → `{"enabled": true}`; "Branch Identifier does not support NPP payments" → `{"enabled": false}`.
- Response 422 `ErrorResponse` — description "Branch Identifier format is invalid"; spec example "Invalid Branch Identifier format":
  ```json
  {"message": "branchIdentifier format is not correct.", "details": "Please refer to the API documentation or contact Shaype for more info with the traceId.", "status": "422", "traceId": "97e1bc06-ba16-4718-9bdd-d6d78ecdc3ea"}
  ```
- Responses 400/403/500/501 → `ErrorResponse` [spec].
- Behaviour:
  - Validation: `branchIdentifier` must match `^\d{6}$`, otherwise 422 with the message above [spec].
  - The answer is a property of the BSB (target FI branch) — the same signal the transfer engine uses: for `transferType` ACCOUNT, "the platform verifies whether the recipient account is enabled for NPP. If it is, the payment will be executed via NPP; otherwise, it will be executed via DE" [docs:payments]. A local implementation needs a BSB → NPP-enabled lookup table [inferred].
  - Read-only; idempotent [inferred]. No documented relation to the staging multi-BSB brand BSBs (636383/636385 → 636380, DE only) [docs:multi-bsb-routing].
- Webhooks: none documented.

## 2. Entities and fields

The spec has no `example` values on any PayID/NPP schema or property [spec]; examples below come from the docs pages or the spec's response examples where noted. The spec models the PayID as a set of response views over one underlying record; the fields are consolidated first, then each schema is listed verbatim.

### PayID (underlying record; not a named spec schema)

Identity is the pair (`payIdValue`, `payIdType`) [inferred from the parameter shapes]. Created by `postPayIdRegister`; read by `getPayId`, `getPayIdsForAccount`, `getPayIdAvailability`, `resolvePayId`, `getPayIdDeregisterHistory`; updated by `updatePayIdDetails` (ownerName, payIdName), `updatePayIdStatus` (status, reason) and, per the docs, by timers (14-day PORTABLE revert, 90-day DEREGISTERED purge, 10-year inactivity disable) [docs:payid, docs:payid-image].

| field | type | nullable | notes | source |
|---|---|---|---|---|
| `payIdValue` | string | — | the alias itself; path param `payId`; docs examples `+61-423765879`, `test@email.com`, `601428737` | [spec], [docs:payid] |
| `payIdType` | string enum `["EMAIL","TELEPHONE","INDIVIDUAL_AUSTRALIAN_BUSINESS","ORGANISATION"]` | — | | [spec] |
| `status` | string enum `["ACTIVE","DEREGISTERED","DISABLED","PORTABLE"]` | — | see section 3 | [spec] |
| `reason` | string enum `["FROD","CUST","DECD","LEGL","PART"]` | nullable on write | reason for current status | [spec] |
| `payIdName` | string | nullable on update; minLength 1 on register | nickname/alias for the registration | [spec] |
| `ownerName` | string | nullable on update; minLength 1 on register | account-holder name; surfaced as `accountDetails.ownerName` | [spec] |
| `accountDetails.accountNumber` | string | — | 5–9 digits; from the linked account | [spec] |
| `accountDetails.branchNumber` | string | — | 6-digit BSB of the linked account | [spec] |
| linked account id | uuid | — | the `accountId` used on register; not returned by any PayID response | [spec], [inferred] |
| `servicer` | string | — | BIC11 of the FI where the PayID is registered (availability view only) | [spec] |
| `registrationDateTimeUtc` | string(date-time) | — | when registered | [spec] |
| `lastUpdatedDateTimeUtc` | string(date-time) | — | when last updated | [spec] |
| `lastResolutionDateTimeUtc` | string(date-time) | — | when last resolved | [spec] |

Note: `HayAccount` (accounts domain) carries `bsb` and `accountNumber` [spec]; `PayIdAccountDetails` calls the BSB `branchNumber` [spec] — same value, different property name.

### PayIdResponse [spec] — "Details of the PayID"
`{ accountDetails: PayIdAccountDetails, payIdDetails: PayIdDetailsResponse }`. Read by getPayId.

### PayIdDetailsResponse [spec] — "Details of the PayID"
`lastResolutionDateTimeUtc` date-time; `lastUpdatedDateTimeUtc` date-time; `payIdName` string; `payIdType` enum; `payIdValue` string; `reason` enum; `registrationDateTimeUtc` date-time; `status` enum. Nothing required. Returned by getPayId (nested) and getPayIdsForAccount (array).

### PayIdAccountDetails [spec] — "Details of Account registered to PayID"
`accountNumber` string ("Account number, 5-9 digits in length"); `branchNumber` string ("BSB (Bank State Branch) of Account, 6 digits in length"); `ownerName` string. Nothing required. Returned by getPayId and resolvePayId. Confidential on client UIs [docs:payid].

### PayIdResolveResponse [spec] — "Response for the PayID lookup request"
`accountDetails` PayIdAccountDetails; `payIdName` string; `payIdType` enum; `payIdValue` string. Returned by resolvePayId. Does **not** include `status` or `reason` [spec].

### PayIdAvailabilityDetailsResponse [spec] — "Response for the PayID availability inquiry"
`availability` boolean; `lastResolutionDateTimeUtc` date-time; `lastUpdatedDateTimeUtc` date-time; `reason` enum; `registrationDateTimeUtc` date-time; `servicer` string (BIC11). Returned by getPayIdAvailability. Does **not** include `status` [spec].

### PayIdDeregisterDetailsResponse [spec] — "Response for the PayID de-registration request"
`lastUpdatedDateTimeUtc` date-time; `payIdName` string; `reason` enum; `registrationDateTimeUtc` date-time. One per historical deregistration; returned as an array by getPayIdDeregisterHistory. Created implicitly when a PayID becomes DEREGISTERED [inferred].

### PayIdRegisterRequestBody [spec] — "Request body for PayID registration"
required `["ownerName","payIdName","payIdType"]`; `ownerName` string minLength 1; `payIdName` string minLength 1; `payIdType` enum. Consumed by postPayIdRegister.

### UpdatePayIdDetailsRequestBody [spec] — "Request body for PayID details update"
required `["payIdType"]`; `ownerName` string nullable; `payIdName` string nullable; `payIdType` enum. Consumed by updatePayIdDetails.

### UpdatePayIdStatusRequestBody [spec] — "Request body for PayID status update"
required `["payIdStatus","payIdType"]`; `payIdStatus` enum `["ACTIVE","DEREGISTERED","DISABLED","PORTABLE"]`; `payIdType` enum; `reason` enum nullable. Consumed by updatePayIdStatus.

### NppEligibilityCheckResponse [spec] — "Response Body of a NPP (New Payments Platform) eligibility check"
`enabled` boolean. Examples `{"enabled": true}` / `{"enabled": false}` [spec]. Returned by verifyBranchIdentifier. Underlying entity: a BSB → NPP-enabled flag (not a spec schema) [inferred].

### GenericMessage [spec] — "Message response"
`message` string. Returned by updatePayIdDetails, updatePayIdStatus, postPayIdRegister.

### ErrorResponse [spec] — "An error response."
`details` string; `message` string; `status` string; `traceId` string. Example (verifyBranchIdentifier 422) in section 6.

### Cross-domain shapes that reference PayID (owned by the transfers domain, listed for completeness)
- `PayIdTransfer` [spec] — "Details of a transfer to Account using PayID": required `["payId","recipientName"]`; `payId` string minLength 1 ("PayID of Account receiving the transfer"); `recipientName` string 1–140; `reference` string 0–35 **deprecated**; `senderName` string 0–140. Referenced only by `TransferOutRequestBody.payIdTransfer` (used by makeTransferV0 `POST /v0/accounts/{accountId}/transfer` and makeTransferV1 `POST /v1/accounts/{accountId}/transfer`) with `transferType: "PAY_ID"` ("requires payIdTransfer object to be provided") [spec]. Note it carries no `payIdType` [spec].
- `NppLiquidity` [spec]: required `["inbound","outbound","total"]`, all `number`; referenced only by `NonSchemeLiquidity.npp` (liquidity/reporting domain).
- `GenerateInboundNppTransactionRequestBody` [spec] (Utilities API `POST /v0/utils/generate-npp-inbound`, generateInboundNppTransaction): required amount (>0), description (minLength 1), idempotencyKey (uuid), receiverAccountNumber `[0-9]{8}`, receiverBsb `[0-9]{6}`, receiverName, senderAccountNumber `[0-9]{6,9}`, senderBsb `[0-9]{6}`, senderName; optional `reference`. v2 (`/v0/utils/generate-inbound-npp-transaction-v2`, generateInboundNppTransactionV2) takes `GenerateRapRequestBody`. Both return `GenericMessage`. Neither addresses by PayID [spec].

## 3. State machines

### PayID `status`
Values (verbatim, spec order): `ACTIVE`, `DEREGISTERED`, `DISABLED`, `PORTABLE` [spec]. The NPP diagram labels them ACTV/DISA/PORT/DERG and adds two pseudo-states, "Initial" and "Archived", which the API never returns [docs:payid-image].

| from | to | via | source |
|---|---|---|---|
| (none / Initial) | ACTIVE | `postPayIdRegister` ("AliasRegistration") | [docs:payid-image], [docs:payid] |
| DEREGISTERED (record still present, < 90 days) or Archived | ACTIVE | `postPayIdRegister` — "can be re-registered again with the same or different account at any point" | [docs:payid] |
| ACTIVE | DISABLED | `updatePayIdStatus` payIdStatus=DISABLED ("AliasDisabling") | [docs:payid-image], [spec] |
| ACTIVE | DISABLED | timer: "10 years no activity" (NPP-side, not an API call) | [docs:payid-image] |
| DISABLED | ACTIVE | `updatePayIdStatus` payIdStatus=ACTIVE ("AliasEnabling") | [docs:payid-image], [spec] |
| ACTIVE | PORTABLE | `updatePayIdStatus` payIdStatus=PORTABLE ("AliasPorting") | [docs:payid-image], [spec] |
| PORTABLE | ACTIVE | timer: "14 days no registration" — "If the PayID isn't registered with this period it will automatically return to an Active state" | [docs:payid-image], [docs:payid] |
| PORTABLE | DISABLED | `updatePayIdStatus` payIdStatus=DISABLED ("AliasDisabling") | [docs:payid-image] |
| PORTABLE | (registered at another FI) | the other FI's registration within 14 days; from this platform's view the value is no longer linked here | [docs:payid] |
| ACTIVE | DEREGISTERED | `updatePayIdStatus` payIdStatus=DEREGISTERED ("AliasDeregistration") | [docs:payid-image], [spec] |
| DISABLED | DEREGISTERED | `updatePayIdStatus` payIdStatus=DEREGISTERED | [docs:payid-image] |
| PORTABLE | DEREGISTERED | `updatePayIdStatus` payIdStatus=DEREGISTERED | [docs:payid-image] |
| DEREGISTERED | Archived (record removed) | timer: "90 days" — "The NPP Addressing Service will automatically remove a PayID record after the record has been in deregistered state for 90 days" | [docs:payid-image], [docs:payid] |

Transitions **not** in the diagram (treat as rejected): PORTABLE → ACTIVE via API ("AliasEnabling" is drawn only from DISABLED); DISABLED → PORTABLE; DEREGISTERED → anything via `updatePayIdStatus` ("A PayID in a DEREGISTERED state cannot have its status updated") [docs:payid-image], [docs:payid]. Whether PORTABLE → ACTIVE via `updatePayIdStatus` is accepted by Shaype is **not documented** — see open questions.

Terminal states: DEREGISTERED is terminal for `updatePayIdStatus`; the record leaves DEREGISTERED only by `postPayIdRegister` (new registration) or by the 90-day purge [docs:payid].

### PayID `reason`
`["FROD","CUST","DECD","LEGL","PART"]` [spec]. Not a state machine; a label written by `updatePayIdStatus.reason` (nullable) and echoed on PayIdDetailsResponse, PayIdAvailabilityDetailsResponse and PayIdDeregisterDetailsResponse. No documented restriction on which reason goes with which status.

### `availability` (derived boolean, not a stored status)
`true` when the value can be registered to an account; `false` when "held against another account" [docs:payid]. Derivation from status is [inferred]: no record → true; DEREGISTERED → true; PORTABLE → true (portability exists precisely to let another account register it, within 14 days); ACTIVE or DISABLED → false.

### NPP eligibility (`enabled`)
Boolean per BSB; no transitions are exposed by the API [spec].

## 4. Invariants and calculations

- **Uniqueness**: "A single PayID can only be linked to one account at a time, it cannot be shared between financial institutions and cannot be registered to multiple accounts" [docs:payid]. Locally: at most one non-DEREGISTERED record per (`payIdValue`, `payIdType`) [inferred].
- **Many PayIDs per account** are allowed [spec `payIdName` description].
- **NPP-enabled accounts only**: "PayIDs can only be registered against accounts that are NPP enabled" [docs:payid]. No account-level NPP flag exists in the spec; the transfer engine treats NPP capability as a property of the BSB [docs:payments], so locally "account's BSB is NPP-enabled" is the check [inferred].
- **Transfers by PayID always go via NPP**: "any transfer using a PayID will only be sent via NPP" [docs:payid]; for `transferType` PAY_ID "the platform will resolve the PayID (to get the BSB and account number) and send the payment request via NPP" [docs:payments].
- **Format rules per `payIdType`** [docs:payid]: TELEPHONE `+<cc 1–3 chars>-<1-9><digits...>`; EMAIL ≤ 256 chars, lower case, contains `@` with chars either side, no whitespace; INDIVIDUAL_AUSTRALIAN_BUSINESS 9–11 digits (ABN/ACN/ARBN/ARSN); ORGANISATION free text containing the organisation name plus description and/or location. Regexes are not given; the docs description of TELEPHONE is [inferred] equivalent to `^\+\d{1,3}-[1-9]\d*$`.
- **Timers** [docs:payid, docs:payid-image]: PORTABLE → ACTIVE after 14 days without registration elsewhere; DEREGISTERED record removed after 90 days; ACTIVE → DISABLED after 10 years without activity.
- **Timestamps**: all `*DateTimeUtc` fields are ISO-8601 `date-time` in UTC [spec]. `registrationDateTimeUtc` set on register; `lastUpdatedDateTimeUtc` on details/status change; `lastResolutionDateTimeUtc` on resolve [inferred from descriptions].
- **ID / value formats** [spec]: `accountId` UUID; `branchIdentifier` and `branchNumber` 6 digits (`^\d{6}$` on the NPP op; description-only on PayIdAccountDetails); `accountNumber` 5–9 digits (description-only); `servicer` BIC11 (11-character BIC); `traceId` UUID in the example.
- **No monetary balances, limits or counters** live in this domain [spec]. NPP liquidity totals (`NppLiquidity.inbound/outbound/total`) belong to the liquidity report; `total` is presumably `inbound + outbound` or net — **not stated** [spec].
- **Staging `callFlags` header**: `callFlags: BSB=<value>`; determines which BSB the mock service treats as owning the PayID; absent → the client's assigned BSB; a different BSB simulates the ownership-check failure [docs:payid].
- **Owner-name display rule**: only the PayID value and the owner name may be shown to end users; `accountDetails` is confidential [docs:payid]. Not enforceable server-side; noted for the implementer's fixtures.

## 5. Cross-domain dependencies

- **Accounts** (reads): `accountId` (UUID) on getPayIdsForAccount / postPayIdRegister must be an existing account; the PayID's `accountDetails.branchNumber` / `accountNumber` come from `HayAccount.bsb` / `HayAccount.accountNumber` [spec]. Which `HayAccount.status` values (`["PENDING_APPROVAL","APPROVED","ACTIVE","LOCKED","DORMANT","CLOSED","ACTIVE_IN_ARREARS"]` [spec]) permit registration is **not documented**.
- **Customers** (reads, implicit): `ownerName` "must be reflective of the account holder name" [docs:payid]; no spec-level link to `HayCustomer`.
- **Transfers** (reads PayID): makeTransferV0/makeTransferV1 with `transferType: "PAY_ID"` and `payIdTransfer: PayIdTransfer` resolve the PayID and pay via NPP [docs:payments]; outcome enum on `TransactionOutcome` includes `REFUSED_INVALID_PAY_ID` [spec]. `transferType: "ACCOUNT"` uses the BSB's NPP eligibility (the same signal as verifyBranchIdentifier) to choose NPP vs DE, after first converting Shaype-BSB recipients to INTERNAL [docs:payments]. Docs recommend, and the UX rules require, `resolvePayId` before every PAY_ID transfer [docs:payid].
- **Transactions / webhooks** (writes indirectly): NPP payments surface as `FinancialTransaction.type` `INTERBANK_TRANSFER_IN` / `INTERBANK_TRANSFER_OUT` ("Cash transfer into/out of Account via Direct Credit or NPP") with `transactionChannel` `CUSCAL_NPP_TRANSFER_IN` / `CUSCAL_NPP_TRANSFER_OUT` / `NPP_RETURN_IN` [spec], and as `TRANSACTION` webhooks with `transactionType` `INTERBANK_TRANSFER_IN` / `INTERBANK_TRANSFER_OUT` [docs:payments, webhooks]. `reference` is "only applicable to NPP transactions, maximum 35 alphanumeric characters" [spec FinancialTransaction].
- **Utilities** (staging): generateInboundNppTransaction / generateInboundNppTransactionV2 create mock inbound NPP transactions by BSB + account number, not by PayID [spec].
- **Liquidity**: `NonSchemeLiquidity.npp: NppLiquidity` [spec].
- **Multi-BSB routing** [docs:multi-bsb-routing]: applies to inbound **DE** payments only (brand BSBs 636383/636385 → account BSB 636380 on staging); no PayID/NPP behaviour is described.
- **External authorisation** (`external-balance.yaml`): contains no PayID or NPP content [spec grep].
- **Payment outcomes**: `docs/payment-transaction-outcome` lists transaction outcomes; none is PayID-specific. `REFUSED_INVALID_PAY_ID` appears only in the spec's `TransactionOutcome` enum and is not described in that page [spec, docs:payment-transaction-outcome].

## 6. Error catalogue

Documented verbatim:

| op | status | condition | message / details | source |
|---|---|---|---|---|
| verifyBranchIdentifier | 422 | `branchIdentifier` does not match `^\d{6}$` | message `branchIdentifier format is not correct.`; details `Please refer to the API documentation or contact Shaype for more info with the traceId.`; status `"422"`; traceId UUID | [spec example] |

Declared on every op with no documented condition or message [spec]: 400 "Bad Request", 403 "Forbidden", 422 "Unprocessable Content", 500 "Internal Server Error", 501 "Not Implemented". No op declares 404 or 409.

Conditions the docs/spec establish but whose status code and message are **not documented** (proposed mapping is [inferred] and must be decided — see section 7):

| condition | ops | proposed |
|---|---|---|
| Missing required query `payIdType` | getPayId | 400 |
| Malformed / missing body, missing required body field (`payIdType`; `payIdStatus`; `ownerName`/`payIdName`), enum value not in list, minLength 1 violated | updatePayIdDetails, updatePayIdStatus, postPayIdRegister | 400 |
| `accountId` not a UUID | getPayIdsForAccount, postPayIdRegister | 400 |
| PayID value violates the format for its `payIdType` | postPayIdRegister (and possibly the lookups) | 422 |
| PayID not registered under the caller's BSB (ownership check) | getPayId, updatePayIdDetails, updatePayIdStatus (and possibly getPayIdDeregisterHistory) | 403 or 422 |
| PayID does not exist | getPayId, updatePayIdDetails, updatePayIdStatus, resolvePayId | 422 (no 404 declared) |
| PayID exists but is DISABLED / DEREGISTERED | resolvePayId | 422 |
| PayID value already ACTIVE/DISABLED at this or another FI | postPayIdRegister | 422 (no 409 declared) |
| Target account not NPP enabled / account not found / account belongs to another client | postPayIdRegister, getPayIdsForAccount | 422 / 422 / 403 |
| Status update on a DEREGISTERED PayID ("cannot have its status updated") | updatePayIdStatus | 422 |
| Transition not in the state model (e.g. DISABLED → PORTABLE) | updatePayIdStatus | 422 |

Related outcome outside this domain: makeTransfer with `transferType: "PAY_ID"` returns 200 `TransactionOutcome.outcome = "REFUSED_INVALID_PAY_ID"` when the PayID cannot be used [spec enum; behaviour text not documented].

## 7. Open questions

1. **Ownership-check failure code**: 403 vs 422 for getPayId / updatePayIdDetails / updatePayIdStatus when the PayID is registered under another BSB. Docs only say "will only return a response if the PayID belongs to an account under your BSB" [docs:payid].
2. **Not-found code**: no 404 is declared anywhere in the domain; decide between 422 and 400 for unknown PayID / unknown account.
3. **Registration conflict code**: no 409 declared; decide 422 (declared) vs 409 (conventional) when the value is already linked elsewhere.
4. **`getPayIdDeregisterHistory` has no `payIdType`**: how a value shared across types (e.g. the same digits as TELEPHONE and INDIVIDUAL_AUSTRALIAN_BUSINESS) is disambiguated, and whether results are merged across types.
5. **Optional `payIdType` on availability/resolve**: when omitted, is the type inferred from the value's shape, or are all types searched? Not documented.
6. **`resolvePayId` on DISABLED / DEREGISTERED / PORTABLE**: error vs 200; docs imply PORTABLE still resolves and DISABLED/DEREGISTERED do not, but the response is not specified. Also whether resolve covers PayIDs registered locally but not yet at the NPP (all-local implementation can ignore).
7. **`payIdOwnerCommonName`** is named in the docs but absent from the spec; the spec's field is `accountDetails.ownerName`. Implement the spec; note the docs discrepancy.
8. **`getPayIdsForAccount` inclusion of DEREGISTERED records** (and of the record after a PORTABLE PayID has been ported away).
9. **PORTABLE → ACTIVE via `updatePayIdStatus`**: the NPP diagram shows only the 14-day timer path; whether Shaype accepts an explicit re-activation is unknown.
10. **Same-status update** (ACTIVE → ACTIVE) and **repeat registration of an already-ACTIVE value to the same account**: 200 no-op vs error.
11. **`updatePayIdDetails` null semantics**: whether `null`/omitted `ownerName`/`payIdName` clears the field or leaves it unchanged; whether details can be updated while DISABLED/PORTABLE.
12. **Whether the platform validates `ownerName` against the account holder's name** at registration, or merely relies on the client ("must be reflective of the account holder name").
13. **Server-side enforcement of the per-type format rules** and the exact regex for each; EMAIL lower-casing (reject vs normalise).
14. **Account preconditions for registration**: which `HayAccount.status` values allow it; how "NPP enabled" is represented (spec has no account/product flag; only BSB eligibility exists).
15. **`availability` derivation** for PORTABLE, DEREGISTERED-but-not-purged, and never-seen values, and what the other availability fields hold when there is no record.
16. **Timers in a local implementation**: whether to simulate the 14-day PORTABLE revert, 90-day purge and 10-year disable (probably as manual/clock-advance hooks).
17. **`GenericMessage.message` text** for the three mutating ops — no documented values.
18. **verifyBranchIdentifier data source**: which BSBs are NPP-enabled locally (seed table); whether the client's own Shaype BSB returns `enabled: true`; relation to staging brand BSBs 636383/636385/636380.
19. **Reason/status pairing**: any restriction on which `reason` codes are valid for which `payIdStatus` (none documented).
20. **Webhooks**: the webhook spec defines no PayID event type (`NotificationDto.type` has no PAYID value) [webhooks]; decide whether the local implementation emits nothing for PayID changes (recommended, to match the spec).
