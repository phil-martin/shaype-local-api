# cards

Domain: Shaype B2B Operations API, tag **"Cards API"** ("Set of APIs related to managing Cards" [spec]). 19 operations.

Source labels used throughout: `[spec]` = `b2b-operations-api.json`; `[webhook-spec]` = `notification-webhooks.json`; `[ext-auth-spec]` = `external-balance.yaml`; `[docs:<slug>]` = `https://developer.shaype.com/docs/<slug>` (or `page/<slug>`, `reference/<slug>`); `[inferred]` = my reading, not stated anywhere.

Conventions common to every Cards API operation [spec]:
- Path parameter `cardId` — `string`, `format: uuid`, required, "Unique identifier (UUID) of the Card". Present on all 18 `/v0/cards/{cardId}/...` operations; `POST /v0/cards/create` has no path params.
- No query parameters on any Cards API operation.
- Error responses declared on **every** operation: `400` "Bad Request", `403` "Forbidden", `422` "Unprocessable Content", `500` "Internal Server Error", `501` "Not Implemented" — all with schema `ErrorResponse`. Only `rewards` adds `201` and `429`.
- **No operation declares `404` or `409`.** The spec never says what an unknown `cardId` returns (see §7).
- `ErrorResponse` = `{ details: string, message: string, status: string ("HTTP response status"), traceId: string }`. No example error message text exists anywhere in the spec or docs.
- `GenericMessage` = `{ message: string ("Message indicating operation result") }`. No example value given.
- The spec declares no `securitySchemes` and no top-level `security`; servers = `http://localhost:8080` ("Generated server url"). Auth is out of scope for this map.
- No Cards API operation is marked `deprecated` [spec].

## 1. Operations

### POST /v0/cards/create (createHayCard)

**Purpose:** "Create Card for Customer" — issue a new card (physical or virtual) for a customer on an account [spec]. Not deprecated.

**Path/query params:** none.

**Request body:** `CreateHayCardRequestBody` (required) — "Body of a request to issue a card for a customer" [spec].

| field | type | required | constraints / enum | notes [spec unless stated] |
|---|---|---|---|---|
| `accountId` | string (uuid) | yes | | "Unique identifier (UUID) of the Account" |
| `customerHayId` | string (uuid) | yes | | "Unique identifier (UUID) of the Customer (cardholder)" |
| `idempotencyKey` | string (uuid) | yes | | "Unique value (UUID) used to identify this request and used to recognise any subsequent retries" |
| `firstName` | string | yes | minLength 1 | "First name of the Customer" |
| `lastName` | string | yes | minLength 1 | "Last name of the Customer" |
| `email` | string | yes | minLength 1 | "Email address of the Customer" (no `format: email`) |
| `phoneNumber` | `PhoneNumber` object | yes | see below | |
| `deliveryAddress` | `Address` object | yes | see below | Required even for VIRTUAL cards [docs:card-creation] |
| `pin` | string | yes | minLength 1 | "Card PIN, typically 4 digits but supports 4-12 digits" (no pattern in schema) |
| `cardType` | string enum | no | `PHYSICAL`, `VIRTUAL` | "Type of card to create. Can convert virtual to physical card at a later time"; **default `PHYSICAL`** |
| `cardSubDesign` | string enum | no | `SUB_DESIGN_1` … `SUB_DESIGN_100` (all 100 values, verbatim `SUB_DESIGN_<n>` for n=1..100) | "Card design, applicable to multiple Card designs for product. Mapping of designs will be provided"; **default `SUB_DESIGN_1`** |
| `deliveryMethod` | string enum | no | `STANDARD`, `REGISTERED`, `COURIER`, `EXPRESS` | **default `STANDARD`**. Docs gloss: REGISTERED = registered post, requires signature; COURIER = overnight courier, includes tracking; EXPRESS = express post, includes tracking [docs:card-creation] |
| `nameOnCard` | string | no | minLength 0, maxLength 23 | "Cardholder name as printed on the Card" |
| `nameOnCardLine2` | string | no | minLength 0, maxLength 23 | "Additional line printed on the Card along side nameOnCard" |
| `title` | string | no | | "Title of the Customer" |

`Address` [spec] — required: `countryCodeIso`, `line1`.

| field | type | required | constraints |
|---|---|---|---|
| `line1` | string | yes | minLength 0, maxLength 120 |
| `countryCodeIso` | string | yes | minLength 3, maxLength 3 ("three letter code as per ISO 3166") |
| `line2` | string | no | minLength 0, maxLength 120 |
| `townOrCity` | string | no | minLength 0, maxLength 120 |
| `postcode` | string | no | minLength 0, maxLength 10 |
| `administrativeRegion` | string | no | minLength 1, maxLength 3 ("Second part of ISO 3166-2 region code") |

Spec example for `Address`: `{"administrativeRegion":"SA","countryCodeIso":"AUS","line1":"9 Fifth Ave","line2":"Woodville Gardens","postcode":"5012","townOrCity":"Adelaide"}`.

`PhoneNumber` [spec] — required: `countryCodePrefix` (string, minLength 1), `numberAfterPrefix` (string, minLength 1).

**Response:** `200` → `HayCard` (full field list in §2). `400/403/422/500/501` → `ErrorResponse`.

**Behaviour:**
- Creates a brand-new card with "new details such as PAN, expiry date and CVV. This does not cancel any existing card." [docs:card-operations]. A customer may therefore hold several cards concurrently [inferred from the previous sentence].
- Card is linked to one customer (`customerHayId`) and one account (`accountId`, "individual or joint/business") [docs:card-creation].
- `cardType = PHYSICAL` (or omitted) → card created with `cardStatus = AWAITING_ACTIVATION` [docs:card-creation][docs:card-operations][docs:cards]. `cardType = VIRTUAL` → created `ACTIVE` [same].
- Lifecycle diagram [docs:card-lifecycle-stauts]: newly created Virtual card = `ACTIVE`, `cardEnabled: true`; newly created Physical = `AWAITING_ACTIVATION`, `cardEnabled: false`.
- "Card types must be agreed with Shaype at the initiation phase ... If it is not agreed and an unsupported card type is chosen an error will occur." [docs:card-creation] — status code not documented.
- Card designs / sub-designs are agreed with the CSM; `cardSubDesign` selects among them [docs:card-creation]. Note: `cardSubDesign` is **not** echoed back in `HayCard` [spec].
- **Cardholder (billing) address** is *not* taken from the request: "When creating a new card, we use the address stored against the customer linked to the card" (used for Visa AVS checks) [docs:card-creation]. `deliveryAddress` is a separate, request-supplied address used only for shipping [docs:card-creation]. Neither address is exposed on `HayCard` [spec].
- Virtual cards "still require a delivery address ... virtual cards are always created with the ability to convert to physical in the future" [docs:card-creation].
- `deliveryMethod` omitted → `STANDARD` [spec][docs:card-creation][page:create-card].
- **Default name-on-card logic** when `nameOnCard` omitted [docs:card-creation]: "If smaller than 23 characters combined => card name = first name + ' ' + last name. Otherwise => card name = initial of first name + ' ' + last name." If supplied, `nameOnCard`/`nameOnCardLine2` override the default; `nameOnCardLine2` omitted → nothing extra printed [page:create-card].
- Default payment preferences after creation [spec `CardPaymentPreferences` descriptions]: `cardEnabled=true`, `mobileWalletPaymentsEnabled=true`, `cardNotPresentEnabled=false`, `cashWithdrawalEnabled=false`, `contactlessEnabled=false`, `magneticStripeEnabled=false`. Docs add: "To enable card preferences by default during the card creation, please contact our CSM" [docs:card-operations] — i.e. per-client configurable, not via API.
- `idempotencyKey` "used to recognise any subsequent retries" [spec]. What a retry with the same key returns (same `HayCard`? 200? conflict?) is **not documented** (§7).
- Validation the local implementation must apply [spec]: presence of the 9 required fields; `minLength`/`maxLength` above; `format: uuid` on `accountId`, `customerHayId`, `idempotencyKey`; enum membership for `cardType`, `cardSubDesign`, `deliveryMethod`. Which failing condition maps to 400 vs 422 is **not documented** [spec lists both without conditions].
- Cross-domain preconditions (account/customer must exist and be in a usable status) — nothing in the cards docs states which account/customer statuses permit card creation (§5, §7).

**Webhooks:** Not stated explicitly for creation. `CardStatusChangeEventDto.cardStatus` includes `AWAITING_ACTIVATION` ("Card is awaiting activation") [webhook-spec], so a `CARD_STATUS_CHANGE` notification on creation is plausible [inferred]. The Apple Pay "haven't started card provisioning" reminders `APPLE_PAY_ADD_TO_WALLET_REMINDER_30_DAYS` / `_60_DAYS` / `_90_DAYS` are described as fired "When the card is created but customer haven't started provisioning the card to wallet" [docs:apple-and-google-pay-notifications] — i.e. a scheduled reminder keyed off card creation.

---

### GET /v0/cards/{cardId} (getCard)

**Purpose:** "Get Card by ID" [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** none.

**Response:** `200` → `HayCard`. `400/403/422/500/501` → `ErrorResponse`.

**Behaviour:** Read-only. "Each card is generated with a unique card ID. You can use this ID to retrieve the card's details." [docs:card-operations]. No `404` is declared — response for an unknown id is undocumented (§7). Example `HayCard` payload shown in [page:create-card] (see §2).

**Webhooks:** none.

---

### POST /v0/cards/{cardId}/activate (activateCard)

**Purpose:** "Activate Card" — "This action is only valid for cards with a status of AWAITING_ACTIVATION." [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** none.

**Response:** `200` → `GenericMessage`. `400/403/422/500/501` → `ErrorResponse`.

**Behaviour:**
- Precondition: `cardStatus == AWAITING_ACTIVATION` [spec][docs:card-operations]. Any other status → error; the code is not documented (422 "Unprocessable Content" is the natural fit [inferred]).
- State change: `cardStatus` → `ACTIVE`; "Move the card into a status that allows the customer to start carrying out transactions." [docs:card-operations]. Diagram: `cardEnabled` becomes `true` on activation (Physical `AWAITING_ACTIVATION / cardEnabled: false` → Activated `ACTIVE / cardEnabled: true`) [docs:card-lifecycle-stauts].
- Side effect when the card being activated is a **renewal** card: "Once the new card is received and activated, the old card is disabled" [docs:card-operations]; diagram shows the old card as `INACTIVE`, `cardEnabled: true` ("old card after activation of new card") [docs:card-lifecycle-stauts]. So activating card B where some card A has `renewedIntoCardId == B` must set A.`cardStatus = INACTIVE` [inferred from the two sources combined].
- Applies to physical cards created via `createHayCard`, `reissueHayCard`, `renewCard`, and to cards converted via `convertCard` (all of which land in `AWAITING_ACTIVATION`) [docs:card-operations].
- Idempotency: not documented; a second call would fail the precondition (status now `ACTIVE`) [inferred].

**Webhooks:** `CARD_STATUS_CHANGE` with `cardStatusChangeEvent.cardStatus = ACTIVE` ("Card has been activated") [webhook-spec enum description]. Emission on activation is [inferred] from that enum text; the cards docs do not list it explicitly.

---

### POST /v0/cards/{cardId}/block (blockCard)

**Purpose:** "Block Card" [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** `BlockCardRequestBody` (**optional** — `requestBody.required` absent) — "Body of a request to block a card." Fields: `note` (string, optional, "Note or explanation for reason block is applied") [spec].

**Response:** `200` → `GenericMessage`. `400/403/422/500/501` → `ErrorResponse`.

**Behaviour:**
- "Stops the use of the card for any type of payment. The customer must get in touch with the relevant support. Used in instances that require investigation into the use of the card." [docs:card-operations]
- State change: `cardStatus` → `BLOCKED`; reversible via `unblockCard` [docs:card-operations]. Diagram: Activated (`ACTIVE`) → Blocked (`BLOCKED`, `cardEnabled: false`) [docs:card-lifecycle-stauts].
- `HayCard.blockedBy` should be set to `CLIENT` ("The card was blocked by the Client") when blocked through this API [inferred from the enum description]; `PLATFORM` is reserved for Shaype-initiated blocks [spec enum description].
- Precondition: the diagram only draws `block` from the Activated (`ACTIVE`) state [docs:card-lifecycle-stauts]. Whether `AWAITING_ACTIVATION` cards can be blocked is undocumented (§7).
- The `note` is not exposed on any response schema [spec].
- Transactions on a blocked card are refused with `cardPreferenceOutcome = CARD_BLOCKED` / processor response `REFUSED_CARD_BLOCKED` [webhook-spec enums; mapping is inferred from names].

**Webhooks:** `CARD_STATUS_CHANGE` with `cardStatus = BLOCKED` ("Card has been blocked") [webhook-spec]; `actionOwner = CLIENT` [inferred from `NotificationDto.actionOwner` description].

---

### POST /v0/cards/{cardId}/cancel (cancelCard)

**Purpose:** "Cancel Card" [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** none.

**Response:** `200` → `GenericMessage`. `400/403/422/500/501` → `ErrorResponse`.

**Behaviour:**
- "Deactivate your card to prevent future use. It will move card status to `INACTIVE`" [docs:card-operations].
- "`INACTIVE` is a final state and cannot be reverted once Canceled" [docs:card-operations] — terminal.
- `HayCard.voidDateTimeUtc` ("DateTime in UTC format when the Card was cancelled / voided") should be set [inferred from field description].
- Diagram: Activated → Cancelled (`INACTIVE`, `cardEnabled: false`) [docs:card-lifecycle-stauts]. Whether cancel is allowed from `AWAITING_ACTIVATION` or `BLOCKED` is undocumented (§7).
- Digital wallets: docs state wallets are disabled when the old card is cancelled during re-issue [docs:card-operations]; by extension cancellation disables wallet tokens [inferred].
- Idempotency / repeat call on an already-`INACTIVE` card: undocumented.

**Webhooks:** `CARD_STATUS_CHANGE` with `cardStatus = INACTIVE` ("Card has been cancelled") [webhook-spec].

---

### POST /v0/cards/{cardId}/convert (convertCard)

**Purpose:** "Convert Card" — "Action providing the capability to convert a card from Virtual to Physical" [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** `ConvertCardRequestBody` (**optional**) — "Body of a request to convert a virtual card to a physical card". Fields: `deliveryAddress` (`Address`, optional; shape as in createHayCard) [spec].

**Response:** `200` → `HayCard` (the same card, now `cardType = PHYSICAL` [inferred: "card details and design will remain unchanged"]). `400/403/422/500/501` → `ErrorResponse`.

**Behaviour:**
- Precondition: `cardType == VIRTUAL`. "Only converting from virtual to physical is possible." [docs:card-operations]; "physical cards cannot be converted into virtual cards this can only be achieved by creating a new card with a new PAN" [docs:cards]. Error code for a PHYSICAL card: undocumented.
- "When converting a card, the card details and design will remain unchanged." [docs:card-operations] → same `cardHayId`, PAN, `cardToken`, `expiryDate`, `lastFourDigits`, design [inferred from that sentence].
- "the physical card will be temporarily inactive during shipment. It is at the customer's discretion to activate the card" [docs:card-operations]. Diagram: Virtual (`ACTIVE`, `cardEnabled: true`) --convert--> Physical (`AWAITING_ACTIVATION`, `cardEnabled: false`) [docs:card-lifecycle-stauts]; convert image: Virtual Card → Convert Card API → Physical Card (Awaiting Activation) → Activate Card → Physical Card (Activated) [docs:card-operations image]. So `cardStatus` goes `ACTIVE` → `AWAITING_ACTIVATION` and `cardType` → `PHYSICAL`.
- "if the customer has added the card to their digital wallet, it will remain accessible even while the physical card is inactive" [docs:card-operations] — wallet tokens survive conversion.
- If `deliveryAddress` is omitted, which address is used (the create-time `deliveryAddress`, or the customer's stored address) is undocumented (§7).
- Precondition on status (must the virtual card be `ACTIVE`, or may a `BLOCKED` virtual card be converted?): undocumented.

**Webhooks:** `CARD_STATUS_CHANGE` with `cardStatus = AWAITING_ACTIVATION` is plausible [inferred]; not stated in docs.

---

### GET /v0/cards/{cardId}/cvv/status (getCardCvvStatus)

**Purpose:** "Get Card CVV Status" [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** none.

**Response:** `200` → `CardCvvStatus` = `{ cvvRemainingTries: integer (int32) — "Number of remaining tries for the Card CVV. When the number reaches 0, the CVV is blocked." }` [spec]. `400/403/422/500/501` → `ErrorResponse`.

**Behaviour:** Read-only. Initial/maximum value is 3 [inferred from unblockCardCvv: "Blocking of a card's CVV occurs after the cardholder has incorrectly entered their card CVV 3 times" [spec]]. The counter is decremented by the card processor on failed CVV checks during transactions (`cardProcessorResponse` values `CVV_FAIL`, `CVV2_FAILURE` exist [webhook-spec]) — there is no B2B API to decrement it, so the local implementation needs a test hook (§7).

**Webhooks:** none.

---

### POST /v0/cards/{cardId}/cvv/unblock (unblockCardCvv)

**Purpose:** "Unblock Card CVV" — "Action providing the capability to unblock a card CVV so that the cardholder is able to attempt to enter their CVV again. Blocking of a card's CVV occurs after the cardholder has incorrectly entered their card CVV 3 times." [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** none.

**Response:** `200` → `GenericMessage`. `400/403/422/500/501` → `ErrorResponse`.

**Behaviour:** Resets `cvvRemainingTries` so the cardholder can retry; the back-office equivalent is labelled "Reset CVV Retries" [page:card-unblock-cvv], suggesting the counter is reset to its maximum (3) [inferred]. Whether calling it when the CVV is not blocked is an error or a no-op: undocumented. Does not change `cardStatus` [inferred — nothing says it does].

**Webhooks:** none documented.

---

### GET /v0/cards/{cardId}/digital-wallets (getDigitalWalletDetails)

**Purpose:** "Get wallets by Card ID" — "This endpoint allows to retrieve digital wallet tokens and primaryAccountIdentifier to determine if a card has been digitally provisioned on a devices wallet." [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** none.

**Response:** `200` → `DigitalWalletDetails` [spec]:

| field | type | notes |
|---|---|---|
| `primaryAccountIdentifier` | string | "Identifier of the first wallet's (if more than one) creator PAN reference, as returned by wallet provider." |
| `wallets` | array of `ApiDigitalWallet` | "List of the digital wallets" |

`ApiDigitalWallet` [spec]:

| field | type | notes |
|---|---|---|
| `createdAt` | string (date-time) | "DateTime in UTC format when the wallet was activated" |
| `digitalWalletStatus` | string (**no enum in schema**) | "Wallet status. Possible values: * **ACTIVE_TOKEN**: Wallet that has card token linked and is active for use" — only one documented value |
| `expiresAt` | string (date) | "DateTime in UTC format when the wallet will expire (card expiry date)" |
| `reference` | string | "The Digitiser's (i.e. the created of the token) unique reference to this token" |
| `type` | string (**no enum in schema**) | "The wallet provider i.e. APPLE, GOOGLE etc." |

`400/403/422/500/501` → `ErrorResponse`.

**Behaviour:** Read-only. Wallets are created by the customer's device provisioning flow, not by any B2B API; the platform notifies the client via `CARD_ADDED_TO_WALLET` [docs:apple-and-google-pay-notifications]. Wallet `expiresAt` = card `expiryDate` [spec]. On re-issue "All digital wallets (apple pay, google pay) will be disabled when the old card is cancelled and will need to be created on the new card"; on renew "Digital wallets will be automatically updated with the new card information" [docs:card-operations]. Value vocabulary mismatch: this schema says `type` is "APPLE, GOOGLE etc." while the webhook `walletType` enum is `DEFAULT_WALLET | APPLE_WALLET | ANDROID_WALLET | SAMSUNG_WALLET` [webhook-spec] (§7).

**Webhooks:** none from this read.

---

### GET /v0/cards/{cardId}/oem-provisioning-data (getOemProvisioningData)

**Purpose:** "Get provisioning data by Card ID" — "This endpoints allows to retrieve encrypted OEM provisioning data used with wallet push provisioning and card details SDKs." [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** none.

**Response:** `200` → `OemProvisioningData` — "Card details required for wallet provisioning." [spec]:

| field | type | notes |
|---|---|---|
| `cardHolderName` | string | "Cardholder name as printed on the Card" |
| `cardToken` | string | "Public token of the Card" |
| `expiryDate` | string (no `format`) | "Expiry date of the Card (date of the last day of the expiry month and year)" |
| `otp` | string | "One-time password for wallet provisioning, 6 digits in length" |

`400/403/422/500/501` → `ErrorResponse`.

**Behaviour:** Read with a side effect — generates a fresh 6-digit `otp` per call [inferred from "One-time password"]. Data is described as "encrypted" in the operation description but the schema fields are plain strings; the encryption scheme is undocumented (§7). "you can test all card features (except push provisioning) using pre-created mock data" on Staging [docs:card-operations] — so this endpoint has no working staging counterpart.

**Webhooks:** none.

---

## 2. Entities and fields
## 3. State machines
## 4. Invariants and calculations
## 5. Cross-domain dependencies
## 6. Error catalogue
## 7. Open questions
