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
