# cards

Domain: Shaype B2B Operations API, tag **"Cards API"** ("Set of APIs related to managing Cards" [spec]). 19 operations.

Source labels used throughout: `[spec]` = `b2b-operations-api.json`; `[webhook-spec]` = `notification-webhooks.json`; `[ext-auth-spec]` = `external-balance.yaml`; `[docs:<slug>]` = `https://developer.shaype.com/docs/<slug>` — except `[docs:create-card]`, `[docs:card-unblock-cvv]`, `[docs:card-unblock-pin]`, which live at `https://developer.shaype.com/page/<slug>`; `[inferred]` = my reading, not stated anywhere. **`[docs:card-lifecycle-stauts]` is a single image**, `https://files.readme.io/9abfc1e-Screenshot_2024-04-18_at_3.31.08_PM.png` (2176×1064) — the `.md` page has no text, so every state, edge and `cardEnabled` annotation attributed to it below is transcribed from that PNG. The convert diagram in `[docs:card-operations]` is `https://files.readme.io/2803552-Screenshot_2024-04-17_at_1.40.46_PM.png`.

Conventions common to every Cards API operation [spec]:
- Path parameter `cardId` — `string`, `format: uuid`, required, "Unique identifier (UUID) of the Card". Present on all 18 `/v0/cards/{cardId}/...` operations; `POST /v0/cards/create` has no path params.
- No query parameters on any Cards API operation.
- Error responses declared on **every** operation: `400` "Bad Request", `403` "Forbidden", `422` "Unprocessable Content", `500` "Internal Server Error", `501` "Not Implemented" — all with schema `ErrorResponse`. Only `rewards` adds `201` and `429`.
- **No operation declares `404` or `409`.** The spec never says what an unknown `cardId` returns (see §7).
- `ErrorResponse` = `{ details: string, message: string, status: string ("HTTP response status"), traceId: string }`. No Cards API operation carries an error example, but other endpoints in the same spec do, which fixes the real body shape [spec, `POST /v0/customers/{customerHayId}/account` 422 example]: `{"message":"PERMISSION_DENIED: Account cannot be created for customer with id eed1e718-b1ca-4b94-a508-3d2d41c2e96b as their status is currently BLOCKED","details":"Please refer to the API documentation or contact Shaype for more info with the traceId.","status":"422","traceId":"b24daeb7-4242-4ff1-ba50-9825d5deedd8"}` — `status` is a **string**, `message` is `<UPPER_SNAKE_CODE>: <sentence>`, `details` is boilerplate. A state-precondition failure ("status is currently BLOCKED") is returned as **422** there, which is the best available precedent for the cards precondition failures below [inferred].
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
- `deliveryMethod` omitted → `STANDARD` [spec][docs:card-creation][docs:create-card].
- **Default name-on-card logic** when `nameOnCard` omitted [docs:card-creation]: "If smaller than 23 characters combined => card name = first name + ' ' + last name. Otherwise => card name = initial of first name + ' ' + last name." If supplied, `nameOnCard`/`nameOnCardLine2` override the default; `nameOnCardLine2` omitted → nothing extra printed [docs:create-card].
- Default payment preferences after creation [spec `CardPaymentPreferences` descriptions]: `cardEnabled=true`, `mobileWalletPaymentsEnabled=true`, `cardNotPresentEnabled=false`, `cashWithdrawalEnabled=false`, `contactlessEnabled=false`, `magneticStripeEnabled=false`. Docs add: "To enable card preferences by default during the card creation, please contact our CSM or CI team. This approach is preferable to migrate your existing data to Shaype platform." [docs:card-operations] — i.e. per-client configurable, not via API [inferred].
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

**Behaviour:** Read-only. "Each card is generated with a unique card ID. You can use this ID to retrieve the card's details." [docs:card-operations]. No `404` is declared — response for an unknown id is undocumented (§7). Example `HayCard` payload shown in [docs:create-card] (see §2).

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
- Applies to physical cards created via `createHayCard` and `reissueHayCard`, and to cards converted via `convertCard` — all documented as landing in `AWAITING_ACTIVATION` [docs:card-operations]; also to physical cards from `renewCard` [inferred by analogy; docs say only "in transit ... received and activated"].
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
- `HayCard.blockedBy` should be set to `CLIENT` ("The card was blocked by the Client") when blocked through this API [inferred from the enum description]; `PLATFORM` = "The card was blocked by the Platform" [spec]; that this denotes a Shaype-initiated block with no client API is [inferred].
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

**Behaviour:** Read-only. Initial/maximum value is 3 [inferred from unblockCardCvv: "Blocking of a card's CVV occurs after the cardholder has incorrectly entered their card CVV 3 times" [spec]]. The counter is decremented by the card processor on failed CVV checks during transactions (`cardProcessorResponse` values `CVV_FAIL`, `CVV2_FAILURE` exist [webhook-spec]). No Cards API operation decrements CVV tries or blocks the PIN; the Utilities mock endpoints (`generateAuthHold`, `generateCardTransaction`, `generateHoldAndUpdateHoldTransactions`) accept `declineReason = WRONG_CVV / CVV_BLOCKED / INCORRECT_PIN / ALLOWED_PIN_RETRIES_EXCEEDED` [spec] — whether these mutate `cvvRemainingTries` / `CardPinStatus.enabled` is undocumented [inferred] (§5, §7).

**Webhooks:** none.

---

### POST /v0/cards/{cardId}/cvv/unblock (unblockCardCvv)

**Purpose:** "Unblock Card CVV" — "Action providing the capability to unblock a card CVV so that the cardholder is able to attempt to enter their CVV again. Blocking of a card's CVV occurs after the cardholder has incorrectly entered their card CVV 3 times." [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** none.

**Response:** `200` → `GenericMessage`. `400/403/422/500/501` → `ErrorResponse`.

**Behaviour:** Resets `cvvRemainingTries` so the cardholder can retry; the back-office equivalent is labelled "Reset CVV Retries" [docs:card-unblock-cvv], suggesting the counter is reset to its maximum (3) [inferred]. Whether calling it when the CVV is not blocked is an error or a no-op: undocumented. Does not change `cardStatus` [inferred — nothing says it does].

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

### GET /v0/cards/{cardId}/payment-preferences (getPaymentPreferences)

**Purpose:** "Get preferences by Card ID" [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** none.

**Response:** `200` → `CardPaymentPreferences` — "Card payment preferences." [spec]:

| field | type | default [spec description] | description [spec] |
|---|---|---|---|
| `cardEnabled` | boolean | `true` | "Physical card enablement status: true: enabled (unfrozen), allows physical card usage (default); false: disabled (frozen), prevents all physical card usage" |
| `cardNotPresentEnabled` | boolean | `false` | "Online card not present payment enablement status" |
| `cashWithdrawalEnabled` | boolean | `false` | "ATM cash withdrawal enablement status" |
| `contactlessEnabled` | boolean | `false` | "Physical card contactless payment enablement status" |
| `magneticStripeEnabled` | boolean | `false` | "Physical card magnetic stripe payment enablement status" |
| `mobileWalletPaymentsEnabled` | boolean | `true` | "Mobile wallet card payment enablement status" |

`400/403/422/500/501` → `ErrorResponse`.

**Behaviour:** Read-only. Docs glosses [docs:card-operations]: cardEnabled — "The physical card is enabled. Disabling the card prevents transactions from being processed using it, while the account remains active."; cardNotPresentEnabled — "customer can use card details to make online payments"; cashWithdrawalEnabled — "When disabled it will stops the card being used to withdraw cash from ATM"; contactlessEnabled — "payments to be made through contactless devices"; magneticStripeEnabled — "whether the card will be accepted when swiped through POS machine"; mobileWalletPaymentsEnabled — "payments using the digital wallet such as Apple Pay on IOS and Google Pay on Android devices". Lifecycle diagram shows `cardEnabled: false` for Physical `AWAITING_ACTIVATION`, `BLOCKED`, `INACTIVE` (cancelled/replaced), `EXPIRED`, and `true` for the renewed-then-inactive old card [docs:card-lifecycle-stauts] — so the value returned here may be status-derived in non-ACTIVE states (§7).

**Webhooks:** none.

---

### PATCH /v0/cards/{cardId}/payment-preferences (updatePaymentPreferences)

**Purpose:** "Update Card preferences" — "Endpoint providing the capability to update card payment preferences. This will not allow for the blocking/unblocking of Cards or PIN (blocking a card and unblocking a PIN is possible through other endpoints)." [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** `UpdatePaymentPreferencesRequestBody` (**required**) — "Payment preferences to be applied to the card. Only provided, non-null values will be modified." [spec]. Fields: the same six optional booleans as `CardPaymentPreferences` (`cardEnabled`, `cardNotPresentEnabled`, `cashWithdrawalEnabled`, `contactlessEnabled`, `magneticStripeEnabled`, `mobileWalletPaymentsEnabled`), none required, no other fields [spec].

**Response:** `200` → `CardPaymentPreferences` (the resulting full preference set [inferred]). `400/403/422/500/501` → `ErrorResponse`.

**Behaviour:**
- Partial update: "Only provided, non-null values will be modified" [spec]. An empty `{}` body is therefore a no-op returning current preferences [inferred].
- Precondition: "Card preferences can only be updated if the card is `ACTIVE`" [docs:card-operations]. Error code for other statuses: undocumented.
- Does **not** change `cardStatus`; cannot block/unblock card or PIN [spec].
- `cardEnabled=false` is the "freeze" transition in the lifecycle diagram (Activated `ACTIVE/cardEnabled:true` --freeze--> Frozen `ACTIVE/cardEnabled:false`; --unfreeze--> back) — status stays `ACTIVE` [docs:card-lifecycle-stauts].
- Override rule: "**cardEnabled** flag will override all other flags except **mobileWalletPaymentsEnabled** flag" [docs:card-operations] — i.e. with `cardEnabled=false` all physical/online usage is refused regardless of the other flags, but wallet payments still follow `mobileWalletPaymentsEnabled` [inferred reading].
- Allowed-by-card-type table, verbatim from [docs:card-operations] (columns: Virtual card "Allowed from point of creation" / Physical "Allowed before activation" / Physical "Allowed after activation"):

| preference | Virtual (from creation) | Physical (before activation) | Physical (after activation) |
|---|---|---|---|
| `cardEnabled` | YES | NO | YES |
| `mobileWalletPaymentsEnabled` | YES | YES | YES |
| `cardNotPresentEnabled` | YES | NO | YES |
| `contactlessEnabled` | NA | NO | NO |
| `cashWithdrawalEnabled` | NA | NO | YES |
| `magneticStripeEnabled` | NA | NO | NO |

  Note the table says `contactlessEnabled` and `magneticStripeEnabled` are "NO" even after activation, which conflicts with the six-flag update body; the docs give no explanation (§7). Only `mobileWalletPaymentsEnabled` is "YES" before activation, which is also the only flag apparently changeable while a physical card is `AWAITING_ACTIVATION` — this in turn conflicts with "can only be updated if the card is ACTIVE" (§7).
- Effect on transactions (other domain): a refused authorisation carries `outcome = REFUSED_CARD_PREFERENCE` ("Transaction declined due to any of card preference config not match" [docs:payment-transaction-outcome]) and `cardPreferenceOutcome` ∈ `CARD_FROZEN | CARD_NOT_PRESENT_DISABLED | CASH_WITHDRAWAL_DISABLED | CONTACTLESS_DISABLED | OVERSEAS_SPENDING_DISABLED | MAGNETIC_STRIPE_PAYMENT_DISABLED | MOBILE_WALLET_PAYMENT_DISABLED | OK | CARD_BLOCKED` [webhook-spec]. `OVERSEAS_SPENDING_DISABLED` has no corresponding card preference flag in this API (it is presumably an account-level preference [inferred]).

**Webhooks:** none documented for preference changes.

---

### PUT /v0/cards/{cardId}/pin (changeCardPin)

**Purpose:** "Change Card PIN" — "Action providing the capability to change a card PIN. To use this endpoint please contact your CSM, this functionality requires agreement to be used." [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** `ChangeCardPinRequestBody` (**required**) — "Body of a request to change a card's pin for a customer". Fields: `newPin` (string, **required**, `pattern: \d{4}`, "New card PIN, consists of 4 digits") [spec]. Note the create-card `pin` allows 4–12 digits but `newPin` here is fixed at 4 (§7).

**Response:** `200` → `GenericMessage`. `400/403/422/500/501` → `ErrorResponse`.

**Behaviour:**
- "Card PIN change requires an API token with specific privilege. To use this feature please contact CSM to get the approval." [docs:card-operations] → clients without the privilege get an error; `403 Forbidden` is the declared code that fits [inferred].
- "Only the user should have visibility of the new PIN chosen. We request that clients implement appropriate checks on their end" [docs:card-operations].
- Validation: `newPin` must match `\d{4}` (pattern is unanchored in the schema; treat as exactly 4 digits [inferred from the description]). Failure → 400 or 422 (undocumented which).
- No documented precondition on `cardStatus`.
- Does not change `cardStatus` or the PIN-blocked flag (PIN unblock is a separate endpoint [spec]) [inferred].

**Webhooks:** An email-channel event `CARD_PIN_CHANGE` exists: `EmailDto.type` enum includes `CARD_PIN_CHANGE` with `EmailDto.cardPinChangeEvent` = `CardPinChangeEventDto { cardHayId: uuid, cardLastFourDigits: string }` — "Details of the Card PIN Change event; provided when the type is `CARD_PIN_CHANGE`" [webhook-spec]. It is **not** in the main `NotificationDto.type` enum, so it arrives on the `/api/hay/v0/communications/email` webhook, not the notification webhook [webhook-spec].

---

### GET /v0/cards/{cardId}/pin/status (getCardPinStatus)

**Purpose:** "Get Card PIN status" — "Action providing the capability to view Card PIN status." [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** none.

**Response:** `200` → `CardPinStatus` — "Status of the Card PIN" = `{ enabled: boolean — "False indicates the Card PIN is blocked" }` [spec]. `400/403/422/500/501` → `ErrorResponse`.

**Behaviour:** Read-only. "view the Card PIN status, whether enabled or disabled" [docs:card-operations]. The PIN becomes blocked (`enabled=false`) "after the cardholder has incorrectly entered their card PIN **3 times**" [spec][docs:card-operations] — this happens at the processor during transactions (`cardProcessorResponse` values `INCORRECT_PIN`, `ALLOWED_PIN_RETRIES_EXCEEDED`, `ALLOWED_NUMBER_OF_PIN_TRIES_EXCEEDED` [webhook-spec]). No Cards API operation decrements CVV tries or blocks the PIN; the Utilities mock endpoints (`generateAuthHold`, `generateCardTransaction`, `generateHoldAndUpdateHoldTransactions`) accept `declineReason = WRONG_CVV / CVV_BLOCKED / INCORRECT_PIN / ALLOWED_PIN_RETRIES_EXCEEDED` [spec] — whether these mutate `cvvRemainingTries` / `CardPinStatus.enabled` is undocumented [inferred] (§5, §7). Unlike CVV, there is no remaining-tries counter exposed for PIN [spec].

**Webhooks:** none.

---

### POST /v0/cards/{cardId}/pin/unblock (unblockCardPin)

**Purpose:** "Unblock Card PIN" — "Action providing the capability to unblock a card PIN so that the cardholder is able to attempt to enter their PIN again. Blocking of a card's PIN occurs after the cardholder has incorrectly entered their card PIN 3 times." [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** none.

**Response:** `200` → `GenericMessage`. `400/403/422/500/501` → `ErrorResponse`.

**Behaviour:** Sets PIN status `enabled = true` [inferred from `CardPinStatus` semantics]. Back-office equivalent "UNBLOCK CARD PIN" [docs:card-unblock-pin]. Whether calling on an already-enabled PIN is an error or no-op: undocumented. Does not change `cardStatus` [spec: "blocking a card and unblocking a PIN is possible through other endpoints" — they are independent].

**Webhooks:** none documented.

---

### POST /v0/cards/{cardId}/re-issue (reissueHayCard)

**Purpose:** "Replace Card" — replace a lost / stolen / damaged card [spec schema description][docs:card-operations "Replace Card - Lost | Stolen"]. Not deprecated.

**Params:** `cardId` (path, uuid, required) — the **old** card.

**Request body:** `ReissueHayCardRequestBody` (**required**) — "Body of a request to re-issue a lost, stolen or damaged card for a customer. The card will be issued with the same configuration as the previous one - name on card, delivery address, phone number, design, and PIN." [spec].

| field | type | required | enum / constraints | notes [spec] |
|---|---|---|---|---|
| `idempotencyKey` | string (uuid) | **yes** | | "Unique value (UUID) used to identify this request and used to recognise any subsequent retries" |
| `cardType` | string enum | no | `PHYSICAL`, `VIRTUAL` | "PHYSICAL: Physical card has been issued; VIRTUAL: Card is virtual only. No physical card will be issued. If card type is not specified, it is set to PHYSICAL by default." |
| `deliveryAddress` | `Address` | no | see createHayCard | |
| `deliveryMethod` | string enum | no | `STANDARD` (default), `REGISTERED`, `COURIER`, `EXPRESS` | |

**Response:** `200` → `HayCard` — the **new** card [inferred; docs say "issues a new one"]. `400/403/422/500/501` → `ErrorResponse`.

**Behaviour:**
- "It marks the old card as inactive and issues a new one." [docs:card-operations] → old card `cardStatus = INACTIVE` (terminal), `voidDateTimeUtc` set [inferred from field description]; diagram: Activated --replaceLostOrStolen--> Replaced (`INACTIVE`, `cardEnabled: false`), then "create new card (done internally)" back to Created [docs:card-lifecycle-stauts].
- "This process generates a new PAN (Primary Account Number), CVV and expiry date." [docs:card-operations] → new `cardHayId`, new `lastFourDigits`, new `expiryDate`; a new `cardToken` is implied (token is the PAN's public token; contrast with renew where the diagram says "same token") [inferred].
- "All digital wallets (apple pay, google pay) will be disabled when the old card is cancelled and will need to be created on the new card" [docs:card-operations].
- New card status: "If the new card created is PHYSICAL, it will be issued AWAITING_ACTIVATION while it transit, and can then be activated once received. Virtual cards are automatically created and activated." [docs:card-operations].
- Configuration copied from the old card: "name on card, delivery address, phone number, design, and PIN" [spec]. Yet the body accepts `deliveryAddress`/`deliveryMethod`/`cardType` — presumably overrides [inferred]. The card-creation doc says "When cards are replaced or renewed, the delivery address used is the cardholder address stored in our system against the customer" [docs:card-creation], which contradicts both the schema description ("same ... delivery address") and the presence of a `deliveryAddress` body field (§7).
- `cardType` default PHYSICAL even when the old card was VIRTUAL [spec: "If card type is not specified, it is set to PHYSICAL by default"].
- Preconditions on the old card's status: undocumented (diagram draws it only from Activated/`ACTIVE`). Whether an `INACTIVE`/`EXPIRED` card can be re-issued: undocumented (§7).
- `idempotencyKey`: retry semantics undocumented (§7).
- The old card's `renewedIntoCardId` is **not** described as being set on re-issue (its description says "if this card has been renewed"); there is no "replacedByCardId" field [spec].

**Webhooks:** `CARD_STATUS_CHANGE` `INACTIVE` for the old card, and (plausibly) `AWAITING_ACTIVATION`/`ACTIVE` for the new one [inferred from webhook-spec enum; docs do not list].

---

### POST /v0/cards/{cardId}/renew (renewCard)

**Purpose:** "Renew Card" — "Action providing the capability to renew a card" [spec]; "Renew Card - on Expiry" [docs:card-operations]. Not deprecated.

**Params:** `cardId` (path, uuid, required) — the expiring card.

**Request body:** `RenewCardRequestBody` (**required**, though every field is optional) — "Body of a request to renew a card for a customer" [spec].

| field | type | required | enum / constraints | notes [spec] |
|---|---|---|---|---|
| `cardType` | string enum | no | `PHYSICAL` (default), `VIRTUAL` | "Type of card to renew into. Can convert virtual to physical card at a later time" |
| `deliveryAddress` | `Address` | no | see createHayCard | |
| `deliveryMethod` | string enum | no | `STANDARD` (default), `REGISTERED`, `COURIER`, `EXPRESS` | |

No `idempotencyKey` on this body (unlike create/re-issue) [spec].

**Response:** `200` → `HayCard` — the **new** card [inferred; "creates a new card"]. `400/403/422/500/501` → `ErrorResponse`.

**Behaviour:**
- "Renew card operation will renew the existing card into a new card with a later expiry date. This process creates a new card with a fresh expiry date, while keeping your existing PAN (Primary Account Number) the same." [docs:card-operations]. Diagram: "new card created with same token" [docs:card-lifecycle-stauts] → new `cardHayId`, same `cardToken`, same `lastFourDigits`, new `expiryDate`.
- Old card gets `renewedIntoCardId = <new cardHayId>` ("Unique ID of the new card, if this card has been renewed") [spec].
- "Digital wallets will be automatically updated with the new card information for seamless use." [docs:card-operations].
- "The old card will stay active while the new card is in transit. Once the new card is received and activated, the old card is disabled" [docs:card-operations]. Diagram: Activated --renew--> Renewed: "old card after activation of new card" = `INACTIVE`, `cardEnabled: true` [docs:card-lifecycle-stauts]. So renew itself does **not** change the old card's `cardStatus`; `activateCard` on the new card does.
- Precondition: "Renew can only be called within 2 months of the expiry date of the card" [docs:card-operations]. Error code otherwise: undocumented. Whether the card must be `ACTIVE` (vs `EXPIRED`/`BLOCKED`): undocumented (§7).
- New card status: PHYSICAL → `AWAITING_ACTIVATION`, VIRTUAL → `ACTIVE` [inferred by analogy with create/re-issue; docs say "in transit"]. If renewed into VIRTUAL there is no activation step, so when the old card is disabled is undocumented (§7).
- Delivery address: docs say the customer's stored cardholder address is used for renewals [docs:card-creation], but the body accepts `deliveryAddress` (§7).
- Staging: "For card operations such as expiration, reminders, and renewal testing on Staging, please contact Shaype to manually update a card data" [docs:card-operations]; the Utilities API also has `PATCH /v0/utils/cards/{cardId}/expiry-date` to move an expiry date [spec] (§5).

**Webhooks:** Expiry reminders precede renewal: `type = REMINDER`, `reminderType ∈ CARD_EXPIRY_MONTH_REMINDER | CARD_EXPIRY_2_WEEK_REMINDER | CARD_EXPIRY_DAY_REMINDER`, with `cardExpiryReminderEvent = CardExpiryReminderEventDto { cardId: uuid, expirationMonth: int32, expirationYear: int32 }` [webhook-spec]. On activation of the renewed card: `CARD_STATUS_CHANGE` `ACTIVE` (new) and `INACTIVE` (old) [inferred]. Expiry itself: `CARD_STATUS_CHANGE` with `cardStatus = EXPIRED` ("Card has been expired") [webhook-spec].

---

### POST /v0/cards/{cardId}/rewards (rewards)

**Purpose:** "Enrol card to rewards" — "Eligible card transactions will automatically count toward rewards provided by rewards platform" [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** `CardRewardsStatusBody` (**required**) — "Card rewards status body". Fields: `status` (string enum, **only value `ACTIVE`** — "Card is enrolled to rewards"; not in a `required` array) [spec]. Sample payload `{"status": "ACTIVE"}` [docs:rewards].

**Response** [spec]:
- `201` "Card successfully enrolled." → `CardRewardsStatusBody` (`{"status":"ACTIVE"}`).
- `200` "Card was already enrolled." → `CardRewardsStatusBody`.
- `429` "Too many requests" → **`CardRewardsStatusBody`** (not `ErrorResponse` — as declared).
- `400/403/422/500/501` → `ErrorResponse`.

Docs table [docs:rewards]: `200` = "The card is ACTIVE in PokitPal but the card was previously added"; `201` = "The card is now ACTIVE in PokitPal".

**Behaviour:**
- Enrols the card with the partner **PokitPal**: "You will be able to provide your customers CardId and we will manage sending the sensitive card information securely to PokitPal" [docs:rewards]. Requires CSM to enable the feature [docs:rewards] → presumably `403` otherwise [inferred].
- Idempotent by design: repeat enrolment returns `200` instead of `201` [spec][docs:rewards].
- No un-enrol endpoint exists in the Cards API [spec]. Rewards status is not exposed on `HayCard` [spec].
- No documented precondition on `cardStatus`.
- Related notification types exist for Apple Pay rewards (`APPLE_PAY_REWARD_FOR_CUSTOMER`, reminder types `APPLE_PAY_ADDITION_REWARD`, `APPLE_PAY_SPEND_REWARD`) [webhook-spec] — these concern Apple Pay usage rewards, not PokitPal, and are outside this endpoint [inferred].

**Webhooks:** none documented for PokitPal enrolment.

---

### POST /v0/cards/{cardId}/unblock (unblockCard)

**Purpose:** "Unblock Card" [spec]. Not deprecated.

**Params:** `cardId` (path, uuid, required).

**Request body:** `UnblockCardRequestBody` (**required**) — "Body of a request to unblock a card." Fields: `note` (string, **required**, minLength 1, "Note or explanation for reason unblock is applied") [spec]. (Asymmetric with block, where the body and `note` are optional.)

**Response:** `200` → `GenericMessage`. `400/403/422/500/501` → `ErrorResponse`.

**Behaviour:**
- "Unblock card is a reverse operation of Block Card. Upon unblocking the card, the card status would be ACTIVE" [docs:card-operations]. Diagram: Blocked --unblock--> Activated (`ACTIVE`, `cardEnabled: true`) [docs:card-lifecycle-stauts].
- Precondition: `cardStatus == BLOCKED` [inferred from "reverse operation"; docs:card-lifecycle-stauts]. Error code otherwise: undocumented.
- `blockedBy` presumably cleared (null) after unblock [inferred].
- Whether a client may unblock a card with `blockedBy = PLATFORM`: undocumented (§7).
- Validation: missing/empty `note` → 400 or 422 (undocumented which).

**Webhooks:** `CARD_STATUS_CHANGE` with `cardStatus = ACTIVE` [inferred from webhook-spec enum; "Card has been activated" is the only ACTIVE gloss].

---

## 2. Entities and fields

### HayCard — "Details of a card" [spec]

No `required` array on the schema: every field is nominally optional in responses. Only `renewedIntoCardId` and `voidDateTimeUtc` are marked `nullable: true`.

| field | type | nullable | enum (verbatim) | description [spec] | example [docs:create-card] |
|---|---|---|---|---|---|
| `cardHayId` | string (uuid) | – | | "Unique identifier (UUID) of the Card" | `3fa85f64-5717-4562-b3fc-2c963f66afa6` |
| `accountHayId` | string (uuid) | – | | "Unique identifier (UUID) of the Account" | `3fa85f64-5717-4562-b3fc-2c963f66afa6` |
| `customerHayId` | string (uuid) | – | | "Unique identifier (UUID) of the Customer (cardholder)" | `3fa85f64-5717-4562-b3fc-2c963f66afa6` |
| `cardStatus` | string | – | `ACTIVE`, `AWAITING_ACTIVATION`, `BLOCKED`, `INACTIVE`, `EXPIRED` | "ACTIVE: Card is active and available for use; AWAITING_ACTIVATION: Card is yet to be activated and unable to be used; BLOCKED: Card has been blocked; EXPIRED: Card has expired; INACTIVE: Card has been cancelled / voided and can no longer be used" | `ACTIVE` |
| `cardType` | string | – | `PHYSICAL`, `VIRTUAL` | "PHYSICAL: Physical card has been issued; VIRTUAL: Card is virtual only. No physical card has been issued" | `PHYSICAL` |
| `blockedBy` | string | – (absent/null when not blocked [inferred]) | `CLIENT`, `PLATFORM` | "The type of entity that is responsible for the blocked card. CLIENT: The card was blocked by the Client. PLATFORM: The card was blocked by the Platform" | `CLIENT` |
| `cardToken` | string | – | | "Public token of the Card, maximum 9 digits in length" | `"string"` |
| `lastFourDigits` | string | – | | "Last four digits of the Card number, also known as primary account number (PAN)" | `"string"` |
| `expiryDate` | string (date) | – | | "Expiry date of the Card (date of the last day of the expiry month and year)" | `2025-08-27` (example is not a month-end; treat the description as authoritative) |
| `issuedDateTimeUtc` | string (date-time) | – | | "DateTime in UTC format when the Card was issued" | `2025-08-27T12:28:24.096Z` |
| `voidDateTimeUtc` | string (date-time) | **yes** | | "DateTime in UTC format when the Card was cancelled / voided" | `2025-08-27T12:28:24.096Z` |
| `renewedIntoCardId` | string (uuid) | **yes** | | "Unique ID of the new card, if this card has been renewed" | `3fa85f64-5717-4562-b3fc-2c963f66afa6` |
| `deliveryMethod` | string | – | `STANDARD`, `REGISTERED`, `COURIER`, `EXPRESS` | "Card delivery method" | `STANDARD` |
| `nameOnCard` | string | – | | "Cardholder name as printed on the Card" | `M SMITH` |
| `nameOnCardLine2` | string | – | | "Additional line printed on the Card along side nameOnCard" | `Trading NAME` |

Fields accepted at creation but **not** present on `HayCard`: `cardSubDesign`, `deliveryAddress`, `phoneNumber`, `email`, `firstName`, `lastName`, `title`, `pin`, `idempotencyKey` [spec]. The re-issue description says design, delivery address, phone number and PIN are copied to the replacement card [spec], so the local store must persist them even though no API reads them back.

Operations: created by `createHayCard`, `reissueHayCard` (new card), `renewCard` (new card); read by `getCard`, plus cross-domain `getCardsForAccountId` (`GET /v0/accounts/{accountId}/cards` → `HayCard[]`) and `getCardsForCustomerId` (`GET /v0/customers/{customerHayId}/cards` → `HayCard[]`) [spec]; updated by `activateCard`, `blockCard`, `unblockCard`, `cancelCard`, `convertCard`, `reissueHayCard` (old card → INACTIVE), `renewCard` (old card `renewedIntoCardId`), `activateCard` of a renewal (old card → INACTIVE), platform expiry job, cross-domain `changeCardExpiryDate` (`expiryDate`).

### CardPaymentPreferences — "Card payment preferences." [spec]

Six booleans; full table under `getPaymentPreferences` (§1). Defaults [spec]: `cardEnabled=true`, `mobileWalletPaymentsEnabled=true`, others `false`. Created implicitly with the card; read by `getPaymentPreferences`; updated by `updatePaymentPreferences` (partial). `UpdatePaymentPreferencesRequestBody` has the identical six optional fields [spec].

### CardPinStatus — "Status of the Card PIN" [spec]

`enabled: boolean` — "False indicates the Card PIN is blocked". Read by `getCardPinStatus`; set true by `unblockCardPin`; set false by the processor after 3 wrong PIN entries [spec descriptions]. The PIN value itself is write-only (`createHayCard.pin`, `changeCardPin.newPin`) and copied on re-issue [spec].

### CardCvvStatus — "Card CVV status." [spec]

`cvvRemainingTries: integer (int32)` — "Number of remaining tries for the Card CVV. When the number reaches 0, the CVV is blocked." Read by `getCardCvvStatus`; reset by `unblockCardCvv`; decremented by processor CVV failures. Max 3 [inferred from "3 times"].

### DigitalWalletDetails / ApiDigitalWallet [spec]

`DigitalWalletDetails { primaryAccountIdentifier: string, wallets: ApiDigitalWallet[] }`; `ApiDigitalWallet { createdAt: date-time, digitalWalletStatus: string (documented value `ACTIVE_TOKEN`; no enum), expiresAt: date ("card expiry date"), reference: string, type: string ("APPLE, GOOGLE etc."; no enum) }`. Read by `getDigitalWalletDetails`. Created by device provisioning (outside this API), signalled by webhook `CARD_ADDED_TO_WALLET`; disabled by re-issue/cancel; carried over by renew; survive convert [docs:card-operations].

### OemProvisioningData — "Card details required for wallet provisioning." [spec]

`{ cardHolderName: string, cardToken: string, expiryDate: string, otp: string ("6 digits") }`. Read (and `otp` generated) by `getOemProvisioningData`.

### CardRewardsStatusBody — "Card rewards status body" [spec]

`{ status: enum [ACTIVE] — "Card is enrolled to rewards" }`. Request and response of `rewards`. Implies a per-card boolean "enrolled in PokitPal" the implementer must store [inferred].

### Request-only value objects [spec]

- `Address` (required `countryCodeIso`, `line1`; lengths in §1) — used by `createHayCard.deliveryAddress` (required), `convertCard.deliveryAddress`, `reissueHayCard.deliveryAddress`, `renewCard.deliveryAddress` (all optional).
- `PhoneNumber` (`countryCodePrefix`, `numberAfterPrefix`, both required, minLength 1) — `createHayCard.phoneNumber`.
- `BlockCardRequestBody { note? }`, `UnblockCardRequestBody { note! minLength 1 }`, `ChangeCardPinRequestBody { newPin! pattern \d{4} }`, `ConvertCardRequestBody { deliveryAddress? }`, `ReissueHayCardRequestBody { idempotencyKey!, cardType?, deliveryAddress?, deliveryMethod? }`, `RenewCardRequestBody { cardType?, deliveryAddress?, deliveryMethod? }`, `CreateHayCardRequestBody` (§1).

### Webhook DTOs touching cards [webhook-spec]

Envelope `NotificationDto` (POST `/api/hay/v0/communications/notification`, operationId `notifyNotification`): required `customerHayId` (uuid), `idempotencyKey` (uuid), `type`; optional `actionOwner` enum `CLIENT | PLATFORM`, `cardHayId` (uuid, "Unique identifier (UUID) of the Card associated with the event"), `productId` (uuid), `reminderType`, and one event-detail object per type:
- `type = CARD_STATUS_CHANGE` → `cardStatusChangeEvent: CardStatusChangeEventDto { cardHayId: uuid, accountHayId: uuid, cardStatus: enum [ACTIVE, BLOCKED, EXPIRED, INACTIVE, AWAITING_ACTIVATION], cardLastFourDigits: string }` — "ACTIVE: Card has been activated; BLOCKED: Card has been blocked; EXPIRED: Card has been expired; INACTIVE: Card has been cancelled; AWAITING_ACTIVATION: Card is awaiting activation". Also present on `SmsDto.cardStatusChangeEvent`.
- `type = CARD_ADDED_TO_WALLET` → `cardAdditionToWalletEvent: CardAdditionToWalletEventDto { cardHayId: uuid, cardLastFourDigits: string, walletType: enum [DEFAULT_WALLET, APPLE_WALLET, ANDROID_WALLET, SAMSUNG_WALLET], activationCode: string ("Payment-token activation code") }`. Docs example [docs:apple-and-google-pay-notifications]: `{"customerHayId":"e818093c-…","idempotencyKey":"7ed153c1-…","type":"CARD_ADDED_TO_WALLET","cardAdditionToWalletEvent":{"cardHayId":"b91826b8-…","cardLastFourDigits":"7927","walletType":"APPLE_WALLET"}}`.
- `type = REMINDER`, `reminderType ∈ CARD_EXPIRY_MONTH_REMINDER | CARD_EXPIRY_2_WEEK_REMINDER | CARD_EXPIRY_DAY_REMINDER` → `cardExpiryReminderEvent: CardExpiryReminderEventDto { cardId: uuid, expirationMonth: int32, expirationYear: int32 }`.
- `type = REMINDER`, wallet-provisioning reminders (top-level `cardHayId` + `reminderType`): `APPLE_PAY_ADD_TO_WALLET_REMINDER_30_DAYS`, `APPLE_PAY_ADD_TO_WALLET_REMINDER_60_DAYS`, `APPLE_PAY_ADD_TO_WALLET_REMINDER_90_DAYS`, `APPLE_PAY_REMINDER_24_HRS`, `APPLE_PAY_REMINDER_7_DAYS`, `APPLE_PAY_SPEND_REMINDER_7_DAYS`, `APPLE_PAY_SPEND_REMINDER_14_DAYS`, `GOOGLE_PAY_24_HRS_PARTIAL_PROVISIONING`, `GOOGLE_PAY_7_DAYS_PARTIAL_PROVISIONING`, `GOOGLE_PAY_7_DAYS_SPEND_REMINDER`, `GOOGLE_PAY_14_DAYS_SPEND_REMINDER`, `REMINDER_TO_PROVISION_DIGITAL_CARD` [webhook-spec enum; examples in docs:apple-and-google-pay-notifications]. On the notification channel the docs examples show `customerHayId`, `idempotencyKey`, `type`, `reminderType`, and (for the `ADD_TO_WALLET` reminders) `cardHayId` — the `APPLE_PAY_SPEND_REMINDER_7_DAYS` / `_14_DAYS` examples carry no `cardHayId` [docs:apple-and-google-pay-notifications]; the schema additionally allows `actionOwner`, `productId` and `firebaseDeviceToken` on any event, and has no `emailAddress` or `customerDetails` property [webhook-spec]. The docs examples that do carry `emailAddress` and `customerDetails {customerHayId, firstName, lastName, preferredName}` are **email-channel** payloads matching `EmailDto` (`POST /api/hay/v0/communications/email`; `EmailDto.type = REMINDER`, `EmailDto.reminderType`, `EmailDto.cardHayId`, `EmailDto.emailAddress`, `EmailDto.customerDetails → CustomerDetails`), not `NotificationDto` [webhook-spec].
- Email channel (`EmailDto.type`): `CARD_PIN_CHANGE` → `cardPinChangeEvent: CardPinChangeEventDto { cardHayId: uuid, cardLastFourDigits: string }`; `CARD_ADDED_TO_WALLET` → `cardAdditionToWalletEvent`.
- Transaction notifications (`type = TRANSACTION`, `transactionEvent: TransactionEventDto`) carry `cardHayId`, `cardPreferenceOutcome`, `cardProcessorResponse`, `cardUsageDetails { isMagneticStripePayment, isContactless, isCardPresent, isMobileWalletPayment, isAtmWithdrawal }` — transactions domain; listed here because they consume card state.

## 3. State machines

### `HayCard.cardStatus` — values `ACTIVE`, `AWAITING_ACTIVATION`, `BLOCKED`, `INACTIVE`, `EXPIRED` [spec]

Sources: lifecycle diagram [docs:card-lifecycle-stauts] (a PNG — URL in the header; states drawn: Created{Virtual, Physical}, Activated, Frozen, Blocked, Cancelled, Replaced, Expired, Renewed), [docs:card-operations], [docs:card-creation].

| from | to | via | source |
|---|---|---|---|
| (none) | `AWAITING_ACTIVATION` | `createHayCard` with `cardType=PHYSICAL` (or omitted) | [docs:card-creation] |
| (none) | `ACTIVE` | `createHayCard` with `cardType=VIRTUAL` ("virtual cards are issued already active") | [docs:card-creation][docs:card-lifecycle-stauts] |
| (none) | `AWAITING_ACTIVATION` / `ACTIVE` | `reissueHayCard` → new card (PHYSICAL / VIRTUAL) | [docs:card-operations] |
| (none) | `AWAITING_ACTIVATION` / `ACTIVE` | `renewCard` → new card (PHYSICAL / VIRTUAL) | [docs:card-operations] + [inferred for VIRTUAL] |
| `ACTIVE` (cardType VIRTUAL) | `AWAITING_ACTIVATION` (cardType → PHYSICAL) | `convertCard` | [docs:card-lifecycle-stauts][docs:card-operations "temporarily inactive during shipment"] |
| `AWAITING_ACTIVATION` | `ACTIVE` | `activateCard` | [spec][docs:card-operations][docs:card-lifecycle-stauts] |
| `ACTIVE` | `BLOCKED` (`blockedBy=CLIENT`) | `blockCard` | [docs:card-operations][docs:card-lifecycle-stauts]; `blockedBy` value [inferred] |
| `ACTIVE` | `BLOCKED` (`blockedBy=PLATFORM`) | Shaype-side block (no client API) | [inferred] — from the `blockedBy` enum gloss "The card was blocked by the Platform" [spec]; the diagram draws a single unattributed `block` edge |
| `BLOCKED` | `ACTIVE` | `unblockCard` | [docs:card-operations][docs:card-lifecycle-stauts] |
| `ACTIVE` | `INACTIVE` (terminal) | `cancelCard` | [docs:card-operations][docs:card-lifecycle-stauts] |
| `ACTIVE` | `INACTIVE` (terminal) | `reissueHayCard` on this (old) card | [docs:card-operations][docs:card-lifecycle-stauts "replaceLostOrStolen"] |
| `ACTIVE` | `INACTIVE` (terminal) | `activateCard` on the card named in this card's `renewedIntoCardId` | [docs:card-operations][docs:card-lifecycle-stauts "Renewed: old card after activation of new card"] |
| `ACTIVE` | `EXPIRED` | platform "scheduled job to retrieve expired cards" — no client API | [docs:card-lifecycle-stauts] |
| `ACTIVE` | `ACTIVE` (renew) | `renewCard` — old card unchanged, `renewedIntoCardId` set | [docs:card-operations][spec field] |

Terminal states: `INACTIVE` ("final state and cannot be reverted" [docs:card-operations]). `EXPIRED` has no outgoing edge in the diagram [docs:card-lifecycle-stauts] — treat as terminal unless renewal from EXPIRED is later confirmed (§7).

Undocumented transitions the implementer must decide (§7): `AWAITING_ACTIVATION → BLOCKED`, `AWAITING_ACTIVATION → INACTIVE` (cancel), `BLOCKED → INACTIVE` (cancel), `BLOCKED → EXPIRED`, `AWAITING_ACTIVATION → EXPIRED`, re-issue/renew from `BLOCKED`/`EXPIRED`/`AWAITING_ACTIVATION`, convert from non-ACTIVE.

### `HayCard.cardType` — `PHYSICAL`, `VIRTUAL` [spec]

| from | to | via | source |
|---|---|---|---|
| `VIRTUAL` | `PHYSICAL` | `convertCard` | [spec][docs:card-operations] |
| `PHYSICAL` | `VIRTUAL` | **not possible** ("can only be achieved by creating a new card") | [docs:cards] |

### Preferences "freeze" (`cardEnabled`) — not a `cardStatus` change [docs:card-lifecycle-stauts]

| from | to | via |
|---|---|---|
| `ACTIVE`, `cardEnabled=true` (Activated) | `ACTIVE`, `cardEnabled=false` (Frozen) | `updatePaymentPreferences {cardEnabled:false}` |
| Frozen | Activated | `updatePaymentPreferences {cardEnabled:true}` |

Diagram also annotates `cardEnabled` per lifecycle state: Physical-created `false`; Virtual-created `true`; Activated `true`; Frozen `false`; Blocked `false`; Cancelled `false`; Replaced `false`; Expired `false`; Renewed-old-card `true` [docs:card-lifecycle-stauts].

### `CardPinStatus.enabled` — `true`/`false`

| from | to | via | source |
|---|---|---|---|
| `true` | `false` | 3 incorrect PIN entries at the processor | [spec] |
| `false` | `true` | `unblockCardPin` | [spec] |

### `CardCvvStatus.cvvRemainingTries` — integer, blocked at 0

| from | to | via | source |
|---|---|---|---|
| n > 0 | n − 1 | incorrect CVV at the processor | [spec] |
| 0 (blocked) / any | 3 (max) | `unblockCardCvv` | [spec]; max value [inferred] |

### `CardRewardsStatusBody.status` — only `ACTIVE` [spec]

| from | to | via |
|---|---|---|
| not enrolled | `ACTIVE` (201) | `rewards` |
| `ACTIVE` | `ACTIVE` (200) | `rewards` again |

No un-enrol transition exists [spec].

### `ApiDigitalWallet.digitalWalletStatus` — documented value `ACTIVE_TOKEN` only [spec]; no transitions documented.

### `HayCard.blockedBy` — `CLIENT`, `PLATFORM` [spec]; set on block, presumably cleared on unblock [inferred].

## 4. Invariants and calculations

- **IDs:** `cardHayId`, `accountHayId`/`accountId`, `customerHayId`, `renewedIntoCardId`, `idempotencyKey` are all `format: uuid` [spec]. Docs examples use v4-style UUIDs.
- **`cardToken`:** "Public token of the Card, maximum 9 digits in length" [spec]. Preserved on renew ("new card created with same token") [docs:card-lifecycle-stauts]; new on re-issue [inferred, since the PAN changes]; unchanged on convert [docs:card-operations]. Used by Utilities mock-transaction endpoints (`cardToken` field) [spec].
- **`lastFourDigits`:** last 4 digits of the PAN [spec]; same on renew (same PAN) and convert; new on re-issue [docs:card-operations].
- **`expiryDate`:** "date of the last day of the expiry month and year" [spec] — i.e. always a month-end date. Expiry period length (years from issue) is **not documented**. `OemProvisioningData.expiryDate` and `ApiDigitalWallet.expiresAt` equal the card expiry date [spec].
- **Renew window:** allowed only "within 2 months of the expiry date of the card" [docs:card-operations] → `today >= expiryDate − 2 months` [inferred formalisation].
- **Expiry reminders:** sent at 1 month, 2 weeks, 1 day before expiry (`CARD_EXPIRY_MONTH_REMINDER`, `CARD_EXPIRY_2_WEEK_REMINDER`, `CARD_EXPIRY_DAY_REMINDER`) [webhook-spec names; exact schedule inferred from the names].
- **Expiry:** a platform scheduled job moves `ACTIVE` cards past `expiryDate` to `EXPIRED` [docs:card-lifecycle-stauts]. Staging: no automatic path except asking Shaype or using `PATCH /v0/utils/cards/{cardId}/expiry-date` [docs:card-operations][spec].
- **`nameOnCard` default** [docs:card-creation]: `len(firstName + " " + lastName) < 23` → `firstName + " " + lastName`; else `firstName[0] + " " + lastName`. Explicit `nameOnCard` (≤ 23 chars) overrides. Docs example shows upper-case `M SMITH` [docs:create-card] — casing rule undocumented.
- **`nameOnCardLine2`:** ≤ 23 chars; omitted → nothing printed [docs:create-card].
- **PIN:** create `pin` "typically 4 digits but supports 4-12 digits" (schema only enforces minLength 1) [spec]; `changeCardPin.newPin` pattern `\d{4}` [spec]. PIN copied from old card on re-issue [spec]. PIN blocked after 3 incorrect entries [spec].
- **CVV:** 3 incorrect entries → blocked; `cvvRemainingTries` reaches 0 [spec].
- **`otp`:** 6 digits, one-time [spec].
- **Preference defaults:** `cardEnabled=true`, `mobileWalletPaymentsEnabled=true`, `cardNotPresentEnabled=false`, `cashWithdrawalEnabled=false`, `contactlessEnabled=false`, `magneticStripeEnabled=false` [spec]; "To enable card preferences by default during the card creation, please contact our CSM or CI team. This approach is preferable to migrate your existing data to Shaype platform." [docs:card-operations] — i.e. overridable per client, not via API [inferred].
- **Preference precedence:** `cardEnabled=false` overrides every other flag except `mobileWalletPaymentsEnabled` [docs:card-operations].
- **Preference editability:** only when `cardStatus == ACTIVE` [docs:card-operations]; per-type/phase table in §1.
- **Idempotency:** `createHayCard.idempotencyKey` and `reissueHayCard.idempotencyKey` are required UUIDs "used to recognise any subsequent retries" [spec]; replay behaviour undocumented. `rewards` is idempotent via 200-vs-201 [spec]. `renewCard` has no key [spec].
- **Card ↔ account ↔ customer:** a card "belongs to a customer and is linked to an account (individual or joint)" [docs:cards]; exactly one `customerHayId` and one `accountHayId` per card [spec]. Multiple cards per customer/account allowed ("does not cancel any existing card") [docs:card-operations].
- **Billing address ≠ delivery address:** billing/AVS address is the customer's stored address; delivery address is per-request [docs:card-creation].
- **Timestamps:** `issuedDateTimeUtc`, `voidDateTimeUtc` are UTC `date-time` [spec]; `voidDateTimeUtc` set when cancelled/voided [spec description].
- **Webhook delivery:** platform retries 18 times over up to 48 hours with exponential backoff on client responses 401, 403, 429, 5XX [docs:webhook-notification]; every notification carries an `idempotencyKey` for dedup [webhook-spec].
- No balances, limits or monetary calculations live in this domain [spec]; card spend limits surface only as transaction outcomes (`REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED`, `REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED` [webhook-spec]) in the transactions domain.

## 5. Cross-domain dependencies

**Reads from other domains**
- **Accounts:** `createHayCard.accountId` must reference an existing account; `HayCard.accountHayId` mirrors it [spec]. `HayAccount.status` enum is `PENDING_APPROVAL | APPROVED | ACTIVE | LOCKED | DORMANT | CLOSED | ACTIVE_IN_ARREARS` [spec]; **which statuses permit card creation is not documented** in the cards docs (§7). Account may be "individual or joint/business" [docs:card-creation].
- **Customers:** `createHayCard.customerHayId` must reference an existing customer; the customer's stored address becomes the card's billing/AVS address on create, re-issue and renew [docs:card-creation]. `HayCustomer.status` enum is `ACTIVE | INACTIVE | REJECTED | BLOCKED | PENDING_APPROVAL | REFERRED` [spec]; permitted statuses for card creation undocumented. `firstName`/`lastName`/`email`/`phoneNumber`/`title` are re-supplied in the create-card request rather than read from the customer [spec].

**Exposes to other domains**
- **Accounts API:** `GET /v0/accounts/{accountId}/cards` (`getCardsForAccountId`) → `HayCard[]` [spec].
- **Customers API:** `GET /v0/customers/{customerHayId}/cards` (`getCardsForCustomerId`) → `HayCard[]` [spec].
- **Utilities API (staging mocks):** `PATCH /v0/utils/cards/{cardId}/expiry-date` (`changeCardExpiryDate`, body `ChangeCardExpiryDateRequestBody { expiryDate!: date, example "2027-09-30" }` → `GenericMessage`) mutates `HayCard.expiryDate` [spec]; mock transaction generators (`generateAuthHold`, `generateCardTransaction`, `generateHoldAndUpdateHoldTransactions`, `generateAtmTransaction`, `generateRefundTransaction`) all take `cardToken` (required); `cardUsage ∈ MAGNETIC_STRIPE | CONTACTLESS | CARD_PRESENT` (optional) exists only on `generateAuthHold` (`GenerateCardHoldTransactionRequestBody`), `generateCardTransaction` (`GenerateCardHoldAndSettleTransactionRequestBody`) and `generateHoldAndUpdateHoldTransactions` (`GenerateUpdateHoldTransactionRequestBody`); those same three schemas also carry `declineReason` (string, optional, `nullable: true`, "The reason for which the card transaction was automatically declined by the payment processor.", enum verbatim `CARD_EXPIRED | WRONG_CVV | CVV_BLOCKED | INCORRECT_PIN | ALLOWED_PIN_RETRIES_EXCEEDED | INVALID_MERCHANT | CARD_IS_NOT_ACTIVE | RESTRICTED_CARD`) [spec] — whether a `WRONG_CVV` / `CVV_BLOCKED` / `INCORRECT_PIN` / `ALLOWED_PIN_RETRIES_EXCEEDED` decline mutates `cvvRemainingTries` / `CardPinStatus.enabled` is undocumented [inferred]; `generateAtmTransaction` and `generateRefundTransaction` share `GenerateCardTransactionRequestBody`, whose only properties are `amount`, `cardToken`, `currency`, `merchantDetails` — no `cardUsage`, no `declineReason` [spec] — they need card status/preferences to decide `cardPreferenceOutcome`.
- **Click to Pay API:** `POST /v0/cards/{cardId}/ctp` (`enrolCard`, body `EnrolCardToClickToPayRequestBody { email?: email ≤255 }`), `DELETE /v0/cards/{cardId}/ctp` (`unenrolCard`) — both no-op success when already in the target state [spec]. Separate domain; not part of the "Cards API" tag.
- **Transactions / Holds:** `AuthorisationHold.cardId`, `FinancialTransaction.cardId` [spec]; webhook `TransactionEventDto.cardHayId`, `cardPreferenceOutcome`, `cardProcessorResponse`, `cardUsageDetails` [webhook-spec]. Authorisation checks consume `cardStatus` (BLOCKED → `CARD_BLOCKED`; not ACTIVE → processor `CARD_IS_NOT_ACTIVE`/`EXPIRED_CARD` [webhook-spec enum names; mapping inferred]) and the six preference flags (→ `CARD_FROZEN`, `CARD_NOT_PRESENT_DISABLED`, `CASH_WITHDRAWAL_DISABLED`, `CONTACTLESS_DISABLED`, `MAGNETIC_STRIPE_PAYMENT_DISABLED`, `MOBILE_WALLET_PAYMENT_DISABLED`) with overall `outcome = REFUSED_CARD_PREFERENCE` [docs:payment-transaction-outcome][webhook-spec].
- **External authorisation (Shaype → client):** `POST /holds` body `Hold { holdId!, accountId!, cardId!, customerId, amount!, merchantDetails, rawExternalProcessorRequest }` — `cardId` is the card's UUID, `customerId` "Identifier of the customer who owns the card" [ext-auth-spec]. The client-side authoriser therefore needs card → account/customer lookup.
- **FX:** `searchConversions` "linked to a given card-spend transaction"; `FxRateEntry.cardMarginAdjustedBidRate` [spec] — no direct card-entity dependency.
- **Notifications (Shaype → client):** `CARD_STATUS_CHANGE`, `CARD_ADDED_TO_WALLET`, `REMINDER` (card expiry + wallet-provisioning reminder types), email `CARD_PIN_CHANGE` [webhook-spec] — see §2.

## 6. Error catalogue

No error message text is documented for any Cards API operation [spec][docs]. The only `ErrorResponse` examples in the spec are on other endpoints (see the header): `message` = `<UPPER_SNAKE_CODE>: <sentence>` (e.g. `PERMISSION_DENIED: …`), `details` = "Please refer to the API documentation or contact Shaype for more info with the traceId.", `status` = the code as a string, `traceId` = uuid; a status-precondition failure is a **422** in those examples [spec]. Status codes declared per Cards operation: `400`, `403`, `422`, `500`, `501` on all 19; `429` additionally on `rewards` (body `CardRewardsStatusBody`, not `ErrorResponse`) [spec].

| condition | code | source |
|---|---|---|
| Malformed JSON / schema violation (missing required field, minLength/maxLength, `format: uuid`, enum membership, `newPin` not `\d{4}`) | `400` "Bad Request" **or** `422` "Unprocessable Content" — spec declares both, never says which | [spec] |
| Unauthenticated / not permitted (e.g. `changeCardPin` without CSM-granted privilege; `rewards` without feature enabled) | `403` "Forbidden" | [spec] + [docs:card-operations][docs:rewards] (code inferred) |
| `activateCard` on a card not in `AWAITING_ACTIVATION` | error, code undocumented (`422` fits) | [spec description] |
| `createHayCard` with a `cardType` not agreed with Shaype | "an error will occur", code undocumented | [docs:card-creation] |
| `convertCard` on a `PHYSICAL` card | error, code undocumented | [docs:card-operations] |
| `updatePaymentPreferences` when `cardStatus != ACTIVE` | error, code undocumented | [docs:card-operations] |
| `renewCard` earlier than 2 months before `expiryDate` | error, code undocumented | [docs:card-operations] |
| `unblockCard` on a card not `BLOCKED`; `cancelCard`/`blockCard` on `INACTIVE` | error, code undocumented | [inferred] |
| Unknown `cardId` | **undocumented** — no `404` declared; `400`/`422` are the only client-error options listed | [spec] |
| Duplicate `idempotencyKey` on create/re-issue | **undocumented** — no `409` declared | [spec] |
| `rewards` rate-limited | `429` "Too many requests" with `CardRewardsStatusBody` body | [spec] |
| `rewards` already enrolled | `200` (not an error) "Card was already enrolled." | [spec][docs:rewards] |
| Server failure / feature not implemented | `500` "Internal Server Error" / `501` "Not Implemented" | [spec] |

Related non-API error vocabularies (transactions domain, for completeness): `cardPreferenceOutcome` values and `cardProcessorResponse` values such as `INCORRECT_PIN`, `REFUSED_CARD_BLOCKED`, `RESTRICTED_CARD`, `CAPTURE_CARD`, `EXPIRED_CARD`, `LOST_CARD_CAP`, `STOLEN_CARD_CAP`, `CARD_IS_NOT_ACTIVE`, `ALLOWED_PIN_RETRIES_EXCEEDED`, `ALLOWED_NUMBER_OF_PIN_TRIES_EXCEEDED`, `UNACCEPTABLE_PIN`, `PIN_VALIDATION_NOT_POSSIBLE`, `CVV_FAIL`, `CVV2_FAILURE`, `INVALID_CARD_NUMBER` [webhook-spec].

## 7. Open questions

1. **Unknown `cardId`:** no `404` is declared on any operation. Decide: return `404` (pragmatic) or `422`/`400` (spec-literal).
2. **400 vs 422 split:** the spec declares both on every operation with no conditions. Suggested split [inferred, supported by the non-cards 422 examples in the spec]: `400` for unparsable/structurally invalid bodies, `422` for semantically invalid (bad enum, wrong state, failed precondition) with `message` = `<CODE>: <sentence>`.
3. **Idempotency replay:** what `createHayCard`/`reissueHayCard` return when the same `idempotencyKey` is re-sent (same `HayCard` + 200? a `409`? and is the key scoped per client, per customer, or global?). Not documented. `renewCard` has no key at all.
4. **Account/customer status preconditions:** which `HayAccount.status` / `HayCustomer.status` values allow card creation, re-issue, renew, activate. Cards docs are silent.
5. **Undocumented status transitions:** block/cancel from `AWAITING_ACTIVATION`; cancel from `BLOCKED`; expiry of `BLOCKED`/`AWAITING_ACTIVATION` cards; re-issue/renew from `BLOCKED`, `EXPIRED`, `AWAITING_ACTIVATION`; convert from `BLOCKED`. The diagram only draws these operations from the Activated (`ACTIVE`) state.
6. **Renew from `EXPIRED`:** diagram shows `EXPIRED` with no exit; docs say renew must be "within 2 months of the expiry date" (before or after?). Decide whether `EXPIRED` is terminal.
7. **Renew into VIRTUAL:** no activation step exists, so when the old card becomes `INACTIVE` is undefined (immediately? never?).
8. **Delivery address on re-issue/renew:** three conflicting statements — schema: "same ... delivery address" as the old card; card-creation doc: the customer's stored cardholder address is used; body: accepts an explicit `deliveryAddress`. Suggested [inferred]: explicit body value wins, else old card's delivery address.
9. **Convert without `deliveryAddress`:** fallback address undefined.
10. **Preference table contradictions:** `contactlessEnabled`/`magneticStripeEnabled` marked "NO" for physical cards even after activation; `mobileWalletPaymentsEnabled` "YES" before activation while "Card preferences can only be updated if the card is ACTIVE". Decide whether the table gates *which flags* may be set per type/phase, and how to reject (422?).
11. **`cardEnabled` reported in non-ACTIVE states:** diagram shows `cardEnabled:false` for `AWAITING_ACTIVATION`/`BLOCKED`/`INACTIVE`/`EXPIRED` but `true` for the renewed old card. Is the stored flag mutated by status changes, or is the read value derived? Also: does activation restore a pre-existing `cardEnabled=false` (set on a virtual card before convert)?
12. **`blockedBy` after unblock:** cleared to null, or left as last blocker? And may a client `unblockCard` a `PLATFORM`-blocked card?
13. **Block/unblock/cancel repeated calls:** error or idempotent no-op? (Compare `enrolCard`/`unenrolCard` in Click to Pay which are explicitly no-op successes.)
14. **PIN/CVV blocking triggers:** no Cards API operation decrements CVV tries or blocks the PIN; the Utilities mock endpoints (`generateAuthHold`, `generateCardTransaction`, `generateHoldAndUpdateHoldTransactions`) accept `declineReason = WRONG_CVV / CVV_BLOCKED / INCORRECT_PIN / ALLOWED_PIN_RETRIES_EXCEEDED` [spec], but whether those decline reasons mutate `cvvRemainingTries` / `CardPinStatus.enabled` is undocumented [inferred]. Decide whether the local Utilities mock decrements/blocks on them, or add a test-only hook to simulate 3 failed entries. Also `unblockCardCvv`/`unblockCardPin` on an unblocked card: error or no-op?
15. **PIN length mismatch:** create accepts 4–12 digits (description) with only `minLength: 1` enforced; change-PIN enforces exactly 4. Decide validation for create (`^\d{4,12}$` [inferred]).
16. **`nameOnCard` default details:** "smaller than 23 characters combined" — is 23 exactly allowed? Upper-casing (example `M SMITH`)? Applied to `OemProvisioningData.cardHolderName` too?
17. **Expiry period:** years from `issuedDateTimeUtc` to `expiryDate` undocumented (typical Visa 3–5 years). Also the `page:create-card` example `expiryDate` (`2025-08-27`) is not a month-end, contradicting the field description.
18. **Wallet vocabulary:** `ApiDigitalWallet.type` ("APPLE, GOOGLE etc.") vs webhook `walletType` (`DEFAULT_WALLET|APPLE_WALLET|ANDROID_WALLET|SAMSUNG_WALLET`); `digitalWalletStatus` documents only `ACTIVE_TOKEN`. Pick one vocabulary and whether re-issue/cancel produces a second status value.
19. **`primaryAccountIdentifier` format:** undocumented string from the wallet provider.
20. **OEM provisioning encryption:** described as "encrypted" but fields are plain strings; scheme undocumented. Staging has no push-provisioning support.
21. **Webhook emission points:** docs only explicitly document `CARD_ADDED_TO_WALLET` and the reminder types; `CARD_STATUS_CHANGE` on create/activate/block/unblock/cancel/convert/re-issue/renew/expiry is inferred from the enum. Decide which transitions emit, and `actionOwner` (`CLIENT` for API-driven, `PLATFORM` for expiry job) [inferred].
22. **`GenericMessage.message` text:** no examples; pick a stable string per operation.
23. **`rewards` 429 body:** declared as `CardRewardsStatusBody`, not `ErrorResponse` — decide whether to mirror this oddity.
24. **Physical card with `cardType` omitted on `reissueHayCard`:** default is PHYSICAL even if the old card was VIRTUAL — confirm this is intended behaviour to replicate.
25. **Design (`cardSubDesign`) unsupported values:** the schema enumerates all 100 sub-designs; unagreed designs presumably error like unagreed card types [inferred] — code undocumented.
