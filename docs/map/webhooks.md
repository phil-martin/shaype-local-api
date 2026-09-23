# Shaype webhooks / notifications — API map

Ground truth for the local re-implementation of the **client-side webhook receiver contract** (Shaype → client) and the **event emission rules** the local mock must reproduce.

Sources (all read for this map):

- `[spec]` = `notification-webhooks.json` (OpenAPI "Notification Webhooks" v1.0.0, `x-explorer-enabled: false`, server `http://localhost:8080`, tag `Notifications API` — "Notifications (webhooks) API that should be implemented by client"). The two reference pages `reference/notifynotification` and `reference/notifygenericnotification` embed the *same* OpenAPI (verified: schema key sets and NotificationDto are identical; the reference page for v0 just omits the v1/SMS/email schemas).
- `[spec:b2b]` = `b2b-operations-api.json`; `[spec:batch]` = `batch-api.json`; `[spec:ext-auth]` = `external-balance.yaml`.
- `[docs:<slug>]` = `https://developer.shaype.com/docs/<slug>.md` — webhook-notification, payto-notifications, apple-and-google-pay-notifications, card-transactions, account-status, customer-status-flow, card-lifecycle-stauts (image only, no text), payment-transaction-outcome, simulates-card-transaction-on-staging, customer-creation-1 (§"Webhook Events"), direct-debits, payments, bpay, apple-reward-transactions, batch-api, account-closure, accounts-overview, payto-payment, payto-staging-testing-suite, status-transitions, scheduled-payments, card-operations, external-authorisation-and-balance.
- `[inferred]` = my inference; docs/spec are silent. Treat as a hypothesis to confirm with Shaype, not fact.

Conventions: field names, enum values and paths are **verbatim** from the source. Where a docs example contradicts the spec, both are shown and the discrepancy is listed in §6.

---

## 0. Implementer summary (read this first)

1. Shaype **POSTs JSON** to four client endpoints; the client must host them at the **exact paths** `/{your-baseURL}/api/hay/v0/communications/{notification|email|sms}` (and `/api/hay/v1/communications/notification` for the "generic" stream) `[docs:webhook-notification]` `[spec]`.
2. Only two streams carry business events for B2B integrators: **v0 `/notification`** (`NotificationDto`, 17 `type` values, one optional `*Event` sub-object per type) and **v1 `/notification`** (`NotificationDtoV1`, 2 `type` values, single `eventDetails` object discriminated by `eventType`). `/sms` and `/email` are for the Shaype Accelerator app / auth service; the client is told to implement them and return 200 `[docs:webhook-notification]`.
3. The client responds **200** on success. Shaype **retries 18 times over up to 48h with exponential backoff** when it gets **401, 403, 429 or 5XX**, or cannot reach the endpoint `[docs:webhook-notification]`. Every payload carries an `idempotencyKey` (UUID) for de-duplication `[spec]`.
4. **No signature / auth header is defined in the webhook spec** (`components.securitySchemes` is `null`; no header parameters on any operation) `[spec]`. Auth is arranged out-of-band with the Client Integration Team `[docs:webhook-notification]`. (The *external authorisation* callback API is a different contract and does define `Shaype-Signature` etc. — see §3.5.)
5. **Ordering is not documented** anywhere `[inferred: none]`. The local mock should deliver in emission order but tests must not depend on it.
6. The workhorse event is `type: "TRANSACTION"` with `transactionEvent.transactionType` (17 values) + `isPending` + `holdHayId` distinguishing card hold / settlement / refund and NPP / DE / BPAY / internal transfers. Verbatim examples in §5.

---

## 1. Endpoints in the webhook spec

All four are `POST`, `requestBody.required: true`, `content: application/json`, tag `Notifications API`, and share the same response set `[spec]`:

| code | description (verbatim) |
|---|---|
| `200` | Success |
| `403` | Unauthorised |
| `422` | Invalid Input |
| `500` | Internal error |

(No response body schema is defined for any code `[spec]`.)

| # | path | operationId | summary (verbatim) | request body | who implements | version |
|---|---|---|---|---|---|---|
| 1 | `/api/hay/v0/communications/notification` | `notifyNotification` | Notification - event | `NotificationDto` | **client** — the B2B business-event stream ("main notification stream for the platform events") | v0 |
| 2 | `/api/hay/v1/communications/notification` | `notifyGenericNotification` | Generic Notification - event | `NotificationDtoV1` | **client** — "main notification stream for the platform events in a new generic format"; today carries only `BATCH_COMPLETED` and `PERK_ORDER_UPDATE` | v1 (generic) |
| 3 | `/api/hay/v0/communications/sms` | `notifySms` | Notification - SMS | `SmsDto` | **client** (return a simple 200) — "events we recommend being delivered via SMS - that includes OTP texts needed for clients using our authentication service" | v0 |
| 4 | `/api/hay/v0/communications/email` | `notifyEmail` | Notification - email | `EmailDto` | **client** (return a simple 200) — "events we recommend being delivered via email - that includes magic-link email needed for clients using our authentication service" | v0 |

jq evidence:

```
jq -c '.paths | to_entries[] | {path:.key, op:.value.post.operationId, body:.value.post.requestBody.content["application/json"].schema["$ref"]}' notification-webhooks.json
{"path":"/api/hay/v1/communications/notification","op":"notifyGenericNotification","body":"#/components/schemas/NotificationDtoV1"}
{"path":"/api/hay/v0/communications/sms","op":"notifySms","body":"#/components/schemas/SmsDto"}
{"path":"/api/hay/v0/communications/notification","op":"notifyNotification","body":"#/components/schemas/NotificationDto"}
{"path":"/api/hay/v0/communications/email","op":"notifyEmail","body":"#/components/schemas/EmailDto"}
jq '.components.securitySchemes, .security' notification-webhooks.json   # -> null, null
```

Docs framing `[docs:webhook-notification]` (verbatim): "Shaype has exposed three endpoints for notifications: `/email`: When using the Shaype Accelerator app. `/sms`: When using the Shaype Accelerator app. `/notification`: When using the Shaype B2B APIs." … "Please implement all three endpoints on your end and return a simple 200 success response from the `/email` and `/sms` endpoints." … "Ensure that the endpoints are implemented with the same URL paths (/{your-baseURL}/api/hay/v0/communications/{notifcation-type} where notification type is ["/notification", "/email", "/sms"]) provided by Shaype." The docs page pre-dates the v1 generic endpoint (it says "three"); the v1 endpoint is documented only in the spec and in `[docs:batch-api]` ("Batch Notification" links to `notifygenericnotification`).

Local-mock implication `[inferred]`: the mock must be a webhook **sender**. Configure one client base URL; POST v0 events to `<base>/api/hay/v0/communications/notification`, v1 events to `<base>/api/hay/v1/communications/notification`. Emitting `/sms` and `/email` is optional (auth-service features are out of scope unless the SUT uses them).

---

## 2. Envelopes and payload DTOs

### 2.1 Discriminator → payload field → DTO (v0 `NotificationDto`)

`type` is the discriminator. Exactly one `*Event` property is expected to be populated for the given type (the DTO descriptions all say "provided when the type is `X`") `[spec]`; in real payloads the *other* event properties are present as explicit `null`s (see the card-transaction examples in §5) `[docs:card-transactions]`.

Every `type` value, verbatim from `jq '.components.schemas.NotificationDto.properties.type.enum'` (17 values, in spec order):

```
["ACCOUNT_STATUS_CHANGE","CUSTOMER_STATUS_UPDATED","CARD_ADDED_TO_WALLET","CARD_STATUS_CHANGE","CUSTOMER_DETAILS_CHANGE","ONBOARDING_PASSED","ONBOARDING_FAILED","REMINDER","SCHEDULED_PAYMENT","TRANSACTION","DIRECT_ENTRY","MANDATE","MANDATE_DUE_PAYMENT","MANDATE_PAYMENT","APPLE_PAY_REWARD_FOR_CUSTOMER","MANDATE_ACTION_EXPIRATION","DELEGATED_OTP_NOTIFICATION"]
```

| `type` | meaning (verbatim from `type` description) | payload property on `NotificationDto` `[spec]` | payload DTO | notes |
|---|---|---|---|---|
| `ACCOUNT_STATUS_CHANGE` | The status of an account has changed | `accountStatusChangeEvent` | `AccountStatusChangeEventDto` | |
| `CUSTOMER_STATUS_UPDATED` | Customer's status has been updated | `customerStatusUpdatedEvent` | `CustomerStatusUpdatedEventDto` | |
| `CARD_ADDED_TO_WALLET` | Card has been added to a device wallet | `cardAdditionToWalletEvent` | `CardAdditionToWalletEventDto` | |
| `CARD_STATUS_CHANGE` | The status of a card has changed | `cardStatusChangeEvent` | `CardStatusChangeEventDto` | |
| `CUSTOMER_DETAILS_CHANGE` | Customer's personal details have been updated | `customerDetailsChangeEvent` | `CustomerDetailsChangeEventDto` | |
| `ONBOARDING_PASSED` | Customer onboarding completed successfully | **none** — envelope only | — | docs example carries only `customerHayId`, `idempotencyKey`, `type`, `firebaseDeviceToken` `[docs:customer-creation-1]` |
| `ONBOARDING_FAILED` | Customer onboarding failed | `onboardingFailedEvent` | `OnboardingFailedEventDto` | |
| `REMINDER` | A reminder | `reminderType` (string enum, 19 values) + for card-expiry reminders `cardExpiryReminderEvent` | `CardExpiryReminderEventDto` | Apple/Google reminders put `cardHayId` on the envelope `[docs:apple-and-google-pay-notifications]` |
| `SCHEDULED_PAYMENT` | Scheduled payment creation notification | `scheduledPaymentEvent` | `ScheduledPaymentEventDto` | |
| `TRANSACTION` | Transaction notification | `transactionEvent` | `TransactionEventDto` | sub-discriminated by `transactionType` |
| `DIRECT_ENTRY` | Direct Entry notification | `directEntryEvent` | `DirectEntryEventDto` | |
| `MANDATE` | Mandate notification | `mandateEventDto` | `MandateEventDto` | **property name in spec is `mandateEventDto`; docs examples show a `mandateEvent` key** (§6 Q1) |
| `MANDATE_DUE_PAYMENT` | Mandate due payment notification | `mandateDuePaymentEventDto` | `MandateDuePaymentEventDto` | same naming discrepancy (`mandateDuePaymentEvent` in docs examples) |
| `MANDATE_PAYMENT` | Mandate payment notification | `mandatePaymentEventDto` | `MandatePaymentEventDto` | same naming discrepancy (`mandatePaymentEvent` in docs examples) |
| `APPLE_PAY_REWARD_FOR_CUSTOMER` | Apple Pay reward reminder | `applePayRewardForCustomerEvent` | `ApplePayRewardForCustomerEventDto` | |
| `MANDATE_ACTION_EXPIRATION` | Mandate action expiration notification | `mandateActionExpirationEvent` | `MandateActionExpirationEventDto` | |
| `DELEGATED_OTP_NOTIFICATION` | Delegated OTP notification for 3DS authentication | `delegatedOtpNotificationEvent` | `DelegatedOtpNotificationEventDto` | |

Envelope-level fields common to all v0 events: `customerHayId` (required), `idempotencyKey` (required), `type` (required), `firebaseDeviceToken`, `actionOwner` (`CLIENT` | `PLATFORM`), `cardHayId` (nullable), `productId` `[spec]`. Full table in §2.2.

### 2.2 `NotificationDto` (v0 envelope) — every field `[spec]`

**`NotificationDto`** — Details of event the notification  
required: ['customerHayId', 'idempotencyKey', 'type']

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `customerHayId` | string (uuid) | yes |  | Unique identifier (UUID) of the customer associated with the notification |
| `idempotencyKey` | string (uuid) | yes |  | Idempotency key (UUID) to uniquely represent this request and prevent duplication. |
| `type` | string | yes | `ACCOUNT_STATUS_CHANGE`, `CUSTOMER_STATUS_UPDATED`, `CARD_ADDED_TO_WALLET`, `CARD_STATUS_CHANGE`, `CUSTOMER_DETAILS_CHANGE`, `ONBOARDING_PASSED`, `ONBOARDING_FAILED`, `REMINDER`, `SCHEDULED_PAYMENT`, `TRANSACTION`, `DIRECT_ENTRY`, `MANDATE`, `MANDATE_DUE_PAYMENT`, `MANDATE_PAYMENT`, `APPLE_PAY_REWARD_FOR_CUSTOMER`, `MANDATE_ACTION_EXPIRATION`, `DELEGATED_OTP_NOTIFICATION` | The type of the notification event - one of:  * **ACCOUNT_STATUS_CHANGE**: The status of an account has changed  * **APPLE_PAY_REWARD_FOR_CUSTOMER**: Apple Pay reward reminder  * **CARD_ADDED_TO_WALLET**: Card has been a… (full text below) |
| `firebaseDeviceToken` | string | no |  | Firebase token of the customer's device |
| `actionOwner` | string | no | `CLIENT`, `PLATFORM` | The party responsible for the triggering of an action resulting in a notification event. Possible values:  * **CLIENT**: Client executed an action which triggered the event.  * **PLATFORM**: Shaype executed an action whi… (full text below) |
| `cardHayId` | string (uuid), nullable | no |  | Unique identifier (UUID) of the Card associated with the event |
| `productId` | string (uuid) | no |  | Unique identifier (UUID) of the Product of the account associated with the event |
| `accountStatusChangeEvent` | AccountStatusChangeEventDto | no |  |  |
| `customerStatusUpdatedEvent` | CustomerStatusUpdatedEventDto | no |  |  |
| `transactionEvent` | TransactionEventDto | no |  |  |
| `cardStatusChangeEvent` | CardStatusChangeEventDto | no |  |  |
| `customerDetailsChangeEvent` | CustomerDetailsChangeEventDto | no |  |  |
| `cardAdditionToWalletEvent` | CardAdditionToWalletEventDto | no |  |  |
| `reminderType` | string | no | `REMINDER_TO_COMPLETE_FUNDING`, `REMINDER_TO_PROVISION_DIGITAL_CARD`, `REMINDER_TO_TRANSACT`, `APPLE_PAY_REMINDER_24_HRS`, `APPLE_PAY_REMINDER_7_DAYS`, `APPLE_PAY_SPEND_REMINDER_7_DAYS`, `APPLE_PAY_SPEND_REMINDER_14_DAYS`, `APPLE_PAY_ADDITION_REWARD`, `APPLE_PAY_SPEND_REWARD`, `APPLE_PAY_ADD_TO_WALLET_REMINDER_30_DAYS`, `APPLE_PAY_ADD_TO_WALLET_REMINDER_60_DAYS`, `APPLE_PAY_ADD_TO_WALLET_REMINDER_90_DAYS`, `GOOGLE_PAY_24_HRS_PARTIAL_PROVISIONING`, `GOOGLE_PAY_7_DAYS_PARTIAL_PROVISIONING`, `GOOGLE_PAY_7_DAYS_SPEND_REMINDER`, `GOOGLE_PAY_14_DAYS_SPEND_REMINDER`, `CARD_EXPIRY_MONTH_REMINDER`, `CARD_EXPIRY_2_WEEK_REMINDER`, `CARD_EXPIRY_DAY_REMINDER` | Type of the **Reminder** event; provided when the type is `REMINDER`. Possible values:  * **REMINDER_TO_COMPLETE_FUNDING**  * **REMINDER_TO_PROVISION_DIGITAL_CARD**  * **REMINDER_TO_TRANSACT**  * **APPLE_PAY_REMINDER_24_… (full text below) |
| `scheduledPaymentEvent` | ScheduledPaymentEventDto | no |  |  |
| `onboardingFailedEvent` | OnboardingFailedEventDto | no |  |  |
| `directEntryEvent` | DirectEntryEventDto | no |  |  |
| `mandateDuePaymentEventDto` | MandateDuePaymentEventDto | no |  |  |
| `mandateEventDto` | MandateEventDto | no |  |  |
| `mandatePaymentEventDto` | MandatePaymentEventDto | no |  |  |
| `applePayRewardForCustomerEvent` | ApplePayRewardForCustomerEventDto | no |  |  |
| `cardExpiryReminderEvent` | CardExpiryReminderEventDto | no |  |  |
| `mandateActionExpirationEvent` | MandateActionExpirationEventDto | no |  |  |
| `delegatedOtpNotificationEvent` | DelegatedOtpNotificationEventDto | no |  |  |

Full description of `NotificationDto.type` (verbatim from spec):

> The type of the notification event - one of:
>  * **ACCOUNT_STATUS_CHANGE**: The status of an account has changed
>  * **APPLE_PAY_REWARD_FOR_CUSTOMER**: Apple Pay reward reminder
>  * **CARD_ADDED_TO_WALLET**: Card has been added to a device wallet
>  * **CARD_STATUS_CHANGE**: The status of a card has changed
>  * **CUSTOMER_DETAILS_CHANGE**: Customer's personal details have been updated
>  * **CUSTOMER_STATUS_UPDATED**: Customer's status has been updated
>  * **ONBOARDING_PASSED**: Customer onboarding completed successfully
>  * **ONBOARDING_FAILED**: Customer onboarding failed
>  * **REMINDER**: A reminder
>  * **SCHEDULED_PAYMENT**: Scheduled payment creation notification
>  * **TRANSACTION**: Transaction notification
>  * **DIRECT_ENTRY**: Direct Entry notification
>  * **MANDATE**: Mandate notification
>  * **MANDATE_DUE_PAYMENT**: Mandate due payment notification
>  * **MANDATE_PAYMENT**: Mandate payment notification
>  * **MANDATE_ACTION_EXPIRATION**: Mandate action expiration notification
>  * **DELEGATED_OTP_NOTIFICATION**: Delegated OTP notification for 3DS authentication
> 

Full description of `NotificationDto.actionOwner` (verbatim from spec):

> The party responsible for the triggering of an action resulting in a notification event. Possible values:
>  * **CLIENT**: Client executed an action which triggered the event.
>  * **PLATFORM**: Shaype executed an action which triggered the event.

Full description of `NotificationDto.reminderType` (verbatim from spec):

> Type of the **Reminder** event; provided when the type is `REMINDER`. Possible values:
>  * **REMINDER_TO_COMPLETE_FUNDING**
>  * **REMINDER_TO_PROVISION_DIGITAL_CARD**
>  * **REMINDER_TO_TRANSACT**
>  * **APPLE_PAY_REMINDER_24_HRS**
>  * **APPLE_PAY_REMINDER_7_DAYS**
>  * **APPLE_PAY_SPEND_REMINDER_7_DAYS**
>  * **APPLE_PAY_SPEND_REMINDER_14_DAYS**
>  * **APPLE_PAY_ADD_TO_WALLET_REMINDER_30_DAYS**
>  * **APPLE_PAY_ADD_TO_WALLET_REMINDER_60_DAYS**
>  * **APPLE_PAY_ADD_TO_WALLET_REMINDER_90_DAYS**
>  * **GOOGLE_PAY_24_HRS_PARTIAL_PROVISIONING**
>  * **GOOGLE_PAY_7_DAYS_PARTIAL_PROVISIONING**
>  * **GOOGLE_PAY_7_DAYS_SPEND_REMINDER**
>  * **GOOGLE_PAY_14_DAYS_SPEND_REMINDER**
>  * **CARD_EXPIRY_MONTH_REMINDER**
>  * **CARD_EXPIRY_2_WEEK_REMINDER**
>  * **CARD_EXPIRY_DAY_REMINDER**

### 2.3 `NotificationDtoV1` (v1 generic envelope) — every field `[spec]`

`type` enum verbatim (`jq '.components.schemas.NotificationDtoV1.properties.type.enum'`): `["BATCH_COMPLETED","PERK_ORDER_UPDATE"]`. Note the `type` description text only lists BATCH_COMPLETED; the enum has both. `eventDetails` is `oneOf [BatchCompletedEventDto, PerkOrderUpdateEventDto]`, both `allOf`-extending `EventDetailsDto`, whose `eventType` (same 2 values) is the OpenAPI `discriminator.propertyName`. So a v1 payload carries the event kind twice: `type` on the envelope and `eventDetails.eventType` inside `[spec]`.

**`NotificationDtoV1`** — Details of event the v1 notification  
required: ['idempotencyKey', 'type']

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `idempotencyKey` | string (uuid) | yes |  | Idempotency key (UUID) to uniquely represent this request and prevent duplication. |
| `type` | string | yes | `BATCH_COMPLETED`, `PERK_ORDER_UPDATE` | The type of the notification event - one of:  * **BATCH_COMPLETED**: The bulk batch-completed event |
| `createdTimeUtc` | string (date-time) | no |  | Resolution requested by date and time |
| `actionOwner` | string | no | `CLIENT`, `PLATFORM` | The party responsible for the triggering of an action resulting in a notification event. Possible values:  * **CLIENT**: Client executed an action which triggered the event.  * **PLATFORM**: Shaype executed an action whi… (full text below) |
| `eventDetails` | oneOf[BatchCompletedEventDto, PerkOrderUpdateEventDto] | no |  |  |

Full description of `NotificationDtoV1.actionOwner` (verbatim from spec):

> The party responsible for the triggering of an action resulting in a notification event. Possible values:
>  * **CLIENT**: Client executed an action which triggered the event.
>  * **PLATFORM**: Shaype executed an action which triggered the event.

**`EventDetailsDto`** — Provided event details.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `eventType` | string | no | `BATCH_COMPLETED`, `PERK_ORDER_UPDATE` |  |

#### v1 payload DTOs (fields shown are the `allOf` union: `EventDetailsDto.eventType` + own properties)

**`BatchCompletedEventDto`** — Details of the **Bulk-Batch Completed** event; provided when the type is `BATCH_COMPLETED`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `eventType` | string | no | `BATCH_COMPLETED`, `PERK_ORDER_UPDATE` |  |
| `batchId` | string (uuid) | no |  | Unique identifier (UUID) of the Batch-completed associated with the event. |
| `batchType` | string | no |  | Batch type associated to the completed event. |
| `receivedAtUtc` | string (date-time) | no |  | DateTime of when the batch was created |
| `finishedAtUtc` | string (date-time) | no |  | DateTime of when the batch was processed and completed |
| `status` | string | no | `RECEIVED`, `PROCESSING`, `COMPLETED` | Batch status. |
| `itemStatistics` | ItemStatisticsDto | no |  |  |

**`ItemStatisticsDto`** — Details of the **Bulk-Batch items count**  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `pending` | integer (int32) | no |  | Total pending batch items. |
| `success` | integer (int32) | no |  | Total successful batch items. |
| `error` | integer (int32) | no |  | Total errored  batch items. |
| `failed` | integer (int32) | no |  | Total failure  batch items. |

**`PerkOrderUpdateEventDto`** — Details of the **Perk Order Update** event; provided when the type is `PERK_ORDER_UPDATE`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `eventType` | string | no | `BATCH_COMPLETED`, `PERK_ORDER_UPDATE` |  |
| `orderExternalId` | string (uuid) | no |  | The externalId the perk order was created with. |
| `status` | string | no | `COMPLETED`, `DECLINED`, `REVERSED` | Final order status. |
| `pinCode` | string | no |  | PIN code, for PIN-based products. |
| `pinSerial` | string | no |  | PIN serial, for PIN-based products. |
| `confirmedTimeUtc` | string (date-time) | no |  | DateTime of when the order was confirmed. |
| `redemption` | RedemptionDto | no |  |  |

**`RedemptionDto`** — Redemption details for a delivered PIN.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `usageInfo` | array<string> | no |  | Instructions on how to redeem the PIN. |
| `terms` | string | no |  | Restrictions and terms; Markdown formatted. |
| `validity` | ValidityDto | no |  |  |

**`ValidityDto`** — PIN validity period after purchase.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `unit` | string | no |  | Time unit. |
| `quantity` | integer (int32) | no |  | Unit count; -1 unlimited, null unknown. |

### 2.4 v0 payload DTOs, per event type (all `$ref`s expanded) `[spec]`

#### `ACCOUNT_STATUS_CHANGE` → `accountStatusChangeEvent`

**`AccountStatusChangeEventDto`** — Details of the **Account Status Change** event; provided when the type is `ACCOUNT_STATUS_CHANGE`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `accountHayId` | string (uuid) | no |  | Unique identifier (UUID) of the Account associated with the event |
| `accountStatus` | string | no | `ACTIVE`, `BLOCKED`, `PENDING_APPROVAL`, `APPROVED`, `DORMANT`, `CLOSED`, `ACTIVE_IN_ARREARS` | New account status:  * **ACTIVE**: Account has been activated  * **PENDING_APPROVAL**: Account is pending approval  * **APPROVED**: Account has been approved  * **ACTIVE_IN_ARREARS**: Account is active but has arrears  *… (full text below) |

Full description of `AccountStatusChangeEventDto.accountStatus` (verbatim from spec):

> New account status:
>  * **ACTIVE**: Account has been activated
>  * **PENDING_APPROVAL**: Account is pending approval
>  * **APPROVED**: Account has been approved
>  * **ACTIVE_IN_ARREARS**: Account is active but has arrears
>  * **BLOCKED**: Account has been blocked
>  * **CLOSED**: Account has been closed

Note: enum contains `BLOCKED` and `DORMANT`; the B2B `HayAccount.status` enum is `["PENDING_APPROVAL","APPROVED","ACTIVE","LOCKED","DORMANT","CLOSED","ACTIVE_IN_ARREARS"]` `[spec:b2b]` and `[docs:account-status]` describes `LOCKED`, not `BLOCKED` (§6 Q2).

#### `CUSTOMER_STATUS_UPDATED` → `customerStatusUpdatedEvent`

**`CustomerStatusUpdatedEventDto`** — Details of the **Customer Status Updated** event; provided when the type is `CUSTOMER_STATUS_UPDATED`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `customerStatus` | string | no | `ACTIVE`, `INACTIVE`, `REJECTED`, `BLOCKED`, `PENDING_APPROVAL`, `REFERRED` | New customer status:  * **ACTIVE**: Customer is active  * **INACTIVE**: Customer is not active (closed)  * **REJECTED**: Customer has been rejected  * **BLOCKED**: Customer is blocked  * **PENDING_APPROVAL**: Customer is… (full text below) |

Full description of `CustomerStatusUpdatedEventDto.customerStatus` (verbatim from spec):

> New customer status:
>  * **ACTIVE**: Customer is active
>  * **INACTIVE**: Customer is not active (closed)
>  * **REJECTED**: Customer has been rejected
>  * **BLOCKED**: Customer is blocked
>  * **PENDING_APPROVAL**: Customer is awaiting approval
>  * **REFERRED**: Customer is referred for further KYC checks

#### `CARD_ADDED_TO_WALLET` → `cardAdditionToWalletEvent`

**`CardAdditionToWalletEventDto`** — Details of the **Card Status Change** event; provided when the type is `CARD_ADDED_TO_WALLET`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `cardHayId` | string (uuid) | no |  | Unique identifier (UUID) of the Card associated with the event |
| `cardLastFourDigits` | string | no |  | Last four card digits |
| `walletType` | string | no | `DEFAULT_WALLET`, `APPLE_WALLET`, `ANDROID_WALLET`, `SAMSUNG_WALLET` | The type of the device wallet:  * DEFAULT_WALLET  * APPLE_WALLET  * ANDROID_WALLET  * SAMSUNG_WALLET |
| `activationCode` | string | no |  | Payment-token activation code |

#### `CARD_STATUS_CHANGE` → `cardStatusChangeEvent`

**`CardStatusChangeEventDto`** — Details of the **Card Status Change** event; provided when the type is `CARD_STATUS_CHANGE`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `cardHayId` | string (uuid) | no |  | Unique identifier (UUID) of the Card associated with the event |
| `accountHayId` | string (uuid) | no |  | Unique identifier (UUID) of the Account associated with the event |
| `cardStatus` | string | no | `ACTIVE`, `BLOCKED`, `EXPIRED`, `INACTIVE`, `AWAITING_ACTIVATION` | New card status:  * **ACTIVE**: Card has been activated  * **BLOCKED**: Card has been blocked  * **EXPIRED**: Card has been expired"  * **INACTIVE**: Card has been cancelled  * **AWAITING_ACTIVATION**: Card is awaiting a… (full text below) |
| `cardLastFourDigits` | string | no |  | Last four card digits |

Full description of `CardStatusChangeEventDto.cardStatus` (verbatim from spec):

> New card status:
>  * **ACTIVE**: Card has been activated
>  * **BLOCKED**: Card has been blocked
>  * **EXPIRED**: Card has been expired"
>  * **INACTIVE**: Card has been cancelled
>  * **AWAITING_ACTIVATION**: Card is awaiting activation

#### `CUSTOMER_DETAILS_CHANGE` → `customerDetailsChangeEvent`

**`CustomerDetailsChangeEventDto`** — Details of the **Customer Details Change** event; provided when the type is `CUSTOMER_DETAILS_CHANGE`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `phoneNumberChanged` | boolean | no |  | Updated phone number |
| `customerNameChanged` | boolean | no |  | Updated customer name |
| `emailAddressChanged` | boolean | no |  | Updated email |
| `addressChanged` | boolean | no |  | Updated address |

#### `ONBOARDING_PASSED` — no payload DTO (envelope only)

#### `ONBOARDING_FAILED` → `onboardingFailedEvent`

**`OnboardingFailedEventDto`** — Details of the **Onboarding Failed** event; provided when the type is `ONBOARDING_FAILED`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `state` | string | no | `DOCUMENT_SCAN`, `SANCTIONS_SCAN`, `KYC_AML_SCAN`, `DUPLICATE_CHECK` | Stage at which the onboarding checks failed:  * **DOCUMENT_SCAN**: Document and identity check  * **SANCTIONS_SCAN**: Sanctions check  * **KYC_AML_SCAN**: KYC / AML check  * **DUPLICATE_CHECK**: Duplicate customer check |
| `submissionFailure` | boolean | no |  |  |

Note: the docs example uses `"isSubmissionFailure": true` whereas the spec property is `submissionFailure` (§6 Q3).

#### `REMINDER` → `reminderType` (+ `cardExpiryReminderEvent` for card-expiry reminders)

`reminderType` enum verbatim (19 values, `jq '.components.schemas.NotificationDto.properties.reminderType.enum'`):

```
["REMINDER_TO_COMPLETE_FUNDING","REMINDER_TO_PROVISION_DIGITAL_CARD","REMINDER_TO_TRANSACT","APPLE_PAY_REMINDER_24_HRS","APPLE_PAY_REMINDER_7_DAYS","APPLE_PAY_SPEND_REMINDER_7_DAYS","APPLE_PAY_SPEND_REMINDER_14_DAYS","APPLE_PAY_ADDITION_REWARD","APPLE_PAY_SPEND_REWARD","APPLE_PAY_ADD_TO_WALLET_REMINDER_30_DAYS","APPLE_PAY_ADD_TO_WALLET_REMINDER_60_DAYS","APPLE_PAY_ADD_TO_WALLET_REMINDER_90_DAYS","GOOGLE_PAY_24_HRS_PARTIAL_PROVISIONING","GOOGLE_PAY_7_DAYS_PARTIAL_PROVISIONING","GOOGLE_PAY_7_DAYS_SPEND_REMINDER","GOOGLE_PAY_14_DAYS_SPEND_REMINDER","CARD_EXPIRY_MONTH_REMINDER","CARD_EXPIRY_2_WEEK_REMINDER","CARD_EXPIRY_DAY_REMINDER"]
```

Note: `APPLE_PAY_ADDITION_REWARD` and `APPLE_PAY_SPEND_REWARD` are in the enum but not in the description's bullet list; no docs page mentions them `[spec]`.

**`CardExpiryReminderEventDto`** — Details of the **Card About To Expire Event** event; provided when the type is `REMINDER`+ with one of the following reminder type values:  * **CARD_EXPIRY_MONTH_REMINDER**  * **CARD_EXPIRY_2_WEEK_REMINDER**  * **CARD_EXPIRY_DAY_REMINDER**  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `cardId` | string (uuid) | no |  | Card Id |
| `expirationMonth` | integer (int32) | no |  | Card expiration month |
| `expirationYear` | integer (int32) | no |  | Card expiration year |

#### `SCHEDULED_PAYMENT` → `scheduledPaymentEvent`

**`ScheduledPaymentEventDto`** — Details of the **Scheduled Payment Created** event; provided when the type is `SCHEDULED_PAYMENT`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `hayId` | string (uuid) | no |  | Unique identifier (UUID) of the Scheduled Payment that has been created |

#### `TRANSACTION` → `transactionEvent`

**`TransactionEventDto`** — Details of the **Transaction** event; provided when the type is `TRANSACTION`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `transactionHayId` | string (uuid) | no |  | Unique identifier (UUID) of the Transaction associated with the event |
| `holdHayId` | string (uuid) | no |  | Unique identifier (UUID) of the Hold associated with the event (only applicable to card transactions). This is also referred to as `relatedHoldHayId` when `isPending` flag is `false`. |
| `accountHayId` | string (uuid) | no |  | Unique identifier (UUID) of the Account associated with the event |
| `currencyAmount` | CurrencyAmount | no |  |  |
| `originalCurrencyAmount` | CurrencyAmount | no |  |  |
| `updatedBalance` | CurrencyAmount | no |  |  |
| `isPending` | boolean | no |  | Specifies whether the transaction is still pending |
| `counterpartName` | string | no |  | Transaction counterpart name |
| `outcome` | string | no | `ACCEPTED`, `REFUSED_CARD_PREFERENCE`, `REFUSED_ACCOUNT_PREFERENCE`, `REFUSED_FRAUD`, `REFUSED_AML`, `REFUSED_MAX_BALANCE_EXCEEDED`, `REFUSED_NOT_ENOUGH_FUNDS`, `REFUSED_DAILY_LIMIT_EXCEEDED`, `INTERNAL_ERROR`, `REFUSED_ACCOUNT_NOT_FOUND_FOR_CARD_TOKEN`, `REFUSED_UNDETERMINED_BALANCE_FOR_ACCOUNT`, `REFUSED_ACCOUNT_NOT_FOUND_FOR_CURRENCY`, `REFUSED_UNDETERMINED_SPENDING_FOR_ACCOUNT`, `REFUSED_UNDETERMINED_TOP_UPS_FOR_ACCOUNT`, `REFUSED_UNDETERMINED_ATM_WITHDRAWALS_FOR_ACCOUNT`, `REFUSED_ANNUAL_SPENDING_LIMIT_BREACHED`, `REFUSED_DAILY_ATM_WITHDRAWAL_LIMIT_BREACHED`, `REFUSED_DAILY_TOP_UP_LIMIT_BREACHED`, `REFUSED_ACCOUNT_BLOCKED`, `REFUSED_ACCOUNT_CLOSED`, `REFUSED_RECIPIENT_ACCOUNT_BLOCKED`, `REFUSED_RECIPIENT_ACCOUNT_CLOSED`, `REFUSED_DAILY_DIRECT_DEBIT_LIMIT_BREACHED`, `REFUSED_DAILY_TRANSFERS_OUT_LIMIT_BREACHED`, `REFUSED_RULES`, `REFUSED_TOTAL_INBOUND_DIRECT_DEBIT_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_OUTBOUND_BPAY_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_NET_VISA_DAILY_LIMIT_BREACHED`, `REFUSED_TOTAL_NON_SCHEME_DAILY_LIMIT_BREACHED`, `REFUSED_BPAY_INVALID_BILLER_CODE`, `REFUSED_BPAY_INVALID_REFERENCE`, `REFUSED_BPAY_INVALID_PAYMENT`, `REFUSED_BPAY_REJECTED`, `REFUSED_DAILY_CARD_TRANSACTIONS_LIMIT_BREACHED`, `REFUSED_SINGLE_CARD_TRANSACTION_LIMIT_BREACHED`, `REFUSED_SANCTIONS`, `REFUSED_UNABLE_TO_VALIDATE`, `REFUSED_INSUFFICIENT_DATA`, `REFUSED_SENDER_ACCOUNT_NOT_VERIFIED`, `REFUSED_CAPABILITY_NOT_ENABLED`, `REFUSED_QUOTE_EXPIRED` | Authorisation outcome type - for possible values, please see relevant guidance on Transactions |
| `transactionTimeUtc` | string (date-time) | no |  | Transaction date and time |
| `cardPreferenceOutcome` | string | no | `CARD_FROZEN`, `CARD_NOT_PRESENT_DISABLED`, `CASH_WITHDRAWAL_DISABLED`, `CONTACTLESS_DISABLED`, `OVERSEAS_SPENDING_DISABLED`, `MAGNETIC_STRIPE_PAYMENT_DISABLED`, `MOBILE_WALLET_PAYMENT_DISABLED`, `OK`, `CARD_BLOCKED` | Outcome of the card preferences check - for possible values, please see relevant guidance on Transactions |
| `cardProcessorResponse` | string | no | `INCORRECT_PIN`, `REFUSED_CARD_BLOCKED`, `RESTRICTED_CARD`, `ALL_GOOD`, `REFER_TO_ISSUER`, `INVALID_MERCHANT`, `CAPTURE_CARD`, `DO_NOT_HONOR`, `UNSPECIFIED_ERROR`, `HONOR_WITH_IDENTIFICATION`, `PARTIAL_APPROVAL`, `INVALID_TRANSACTION`, `INVALID_AMOUNT`, `INVALID_CARD_NUMBER`, `CARD_SCHEME_NETWORK_CANNOT_CONNECT_TO_THREDD`, `CUSTOMER_CANCELLATION`, `FATAL_ERROR`, `PARTIAL_REVERSAL`, `EXPIRED_CARD_CAP`, `SUSPECTED_FRAUD`, `LOST_CARD_CAP`, `STOLEN_CARD_CAP`, `CLOSED_ACCOUNT`, `INSUFFICIENT_FUNDS`, `EXPIRED_CARD`, `TRANSACTION_NOT_PERMITTED_TO_HOLDER`, `TRANSACTION_NOT_PERMITTED_TO_TERMINAL`, `EXCEEDED_WITHDRAW_AMOUNT_LIMIT`, `SECURITY_VIOLATION`, `EXCEEDED_WITHDRAWAL_FREQUENCY_LIMIT`, `RESPONSE_RECEIVED_TOO_LATE`, `HOLDER_TO_CONTACT_ISSUER`, `ALLOWED_PIN_RETRIES_EXCEEDED`, `ALLOWED_NUMBER_OF_PIN_TRIES_EXCEEDED`, `ISSUER_DOES_NOT_PARTICIPATE_IN_THE_SERVICE`, `CARD_IS_NOT_ACTIVE`, `UNACCEPTABLE_PIN`, `DOMESTIC_DEBIT_TRANSACTION_NOT_ALLOWED`, `TIMEOUT_AT_IEM`, `APPROVED_NON_FINANCIAL_OR_HOLD`, `PIN_VALIDATION_NOT_POSSIBLE`, `PURCHASE_AMOUNT_ONLY_NO_CASHBACK_ALLOWED`, `CRYPTOGRAPHIC_FAILURE`, `AUTHENTICATION_FAILURE`, `ISSUER_INOPERATIVE`, `CANT_ROUTE`, `VIOLATION_OF_LAW`, `DUPLICATE_TRANSMISSION`, `SYSTEM_MALFUNCTION`, `CVV_FAIL`, `FORCE_STIP`, `APPROVE_LOAD`, `VERIFICATION_DATA_FAILED`, `STRONG_CUSTOMER_AUTHENTICATION`, `SCA_REQUIRED`, `CVV2_FAILURE`, `UNKNOWN_REASON` | Card processor response - for possible values, please see relevant guidance on Transactions |
| `merchantName` | string | no |  | Merchant name |
| `isAtmTransaction` | boolean, **deprecated** | no |  | Specifies whether the transaction is an ATM transaction |
| `transactionType` | string | no | `CARD_TRANSACTION`, `CARD_TRANSACTION_REFUND`, `CARD_TRANSACTION_SETTLED`, `INTRABANK_TRANSFER_IN`, `INTRABANK_TRANSFER_OUT`, `INTERBANK_TRANSFER_IN`, `INTERBANK_TRANSFER_OUT`, `DIRECT_DEBIT_TRANSFER`, `HAY_TOP_UP`, `INTERBANK_TRANSFER_OUT_REVERSAL`, `REWARD`, `GENERAL_CREDIT`, `GENERAL_DEBIT`, `ORIGINAL_CREDIT`, `BPAY_TRANSFER_OUT`, `CONVERSION_IN`, `CONVERSION_OUT` | Transaction type:  * **CARD_TRANSACTION**: Card transaction  * **CARD_TRANSACTION_REFUND**: A refund of a card transaction  * **CARD_TRANSACTION_SETTLED**: A settlement of a card transaction  * **INTRABANK_TRANSFER_IN**:… (full text below) |
| `cardUsageDetails` | CardUsageDetails | no |  |  |
| `accountBalances` | AccountBalancesDto | no |  |  |
| `cardHayId` | string (uuid) | no |  | Unique identifier (UUID) of the Card associated with the event |
| `customerHayId` | string (uuid) | no |  | Unique identifier (UUID) of the Customer associated with the event |
| `ruleDetails` | RuleDetails | no |  |  |
| `counterpartDetails` | CounterpartDetails | no |  |  |
| `originId` | string (uuid) | no |  | Transaction origin ID (to be used with `originType`). |
| `originType` | string | no | `CUSTOMER`, `SCHEDULED_PAYMENT`, `HAAS_OPERATIONS`, `OPERATIONS`, `MANDATE_PAYMENT`, `DIRECT_DEBIT`, `TRANSACTION` | Transaction origin type:  * **CUSTOMER**: Transaction initiated by a customer  * **SCHEDULED_PAYMENT**: Transaction initiated by a schedule  * **HAAS_OPERATIONS**: Transaction initiated by client operations  * **OPERATIO… (full text below) |
| `category` | string | no |  | Category of the transaction. |
| `merchantId` | string | no |  | Merchant ID, alphanumeric / special characters maximum 15 characters in length. |
| `description` | string | no |  | Description on the Transaction |
| `mandatePaymentDetails` | MandatePaymentDetails | no |  |  |
| `returnReason` | ReturnReason | no |  |  |
| `reference` | string | no |  | Transaction reference. |
| `externalIdentifiers` | array<ExternalIdentifierDto> | no |  | External identifiers associated with the transaction (e.g. VISA trace lifecycle). |

Full description of `TransactionEventDto.transactionType` (verbatim from spec):

> Transaction type:
>  * **CARD_TRANSACTION**: Card transaction
>  * **CARD_TRANSACTION_REFUND**: A refund of a card transaction
>  * **CARD_TRANSACTION_SETTLED**: A settlement of a card transaction
>  * **INTRABANK_TRANSFER_IN**: Incoming internal transfer
>  * **INTRABANK_TRANSFER_OUT**: Outgoing internal transfer
>  * **INTERBANK_TRANSFER_IN**: Incoming external bank transfer
>  * **INTERBANK_TRANSFER_OUT**: Outgoing external bank transfer
>  * **DIRECT_DEBIT_TRANSFER**: Direct Debit
>  * **HAY_TOP_UP**: An account top-up
>  * **INTERBANK_TRANSFER_OUT_REVERSAL**: (NOT CURRENTLY IN USE)
>  * **REWARD**: A reward credited to the account
>  * **GENERAL_CREDIT**: A general account credit
>  * **GENERAL_DEBIT**: A general account debit
>  * **ORIGINAL_CREDIT**: Visa Original Credit transaction
>  * **BPAY_TRANSFER_OUT**: Outgoing BPAY transfer
>  * **CONVERSION_IN**: Currency conversion buy (credit)
>  * **CONVERSION_OUT**: Currency conversion sell (debit)
> 
> 

Full description of `TransactionEventDto.originType` (verbatim from spec):

> Transaction origin type:
>  * **CUSTOMER**: Transaction initiated by a customer
>  * **SCHEDULED_PAYMENT**: Transaction initiated by a schedule
>  * **HAAS_OPERATIONS**: Transaction initiated by client operations
>  * **OPERATIONS**: Transaction initiated by Shaype operations
>  * **MANDATE_PAYMENT**: Transaction initiated by mandate
>  * **DIRECT_DEBIT**: Transaction initiated by direct debit
>  * **TRANSACTION**: Transaction initiated by another transaction

Sub-objects of `TransactionEventDto`:

**`CurrencyAmount`** — Monetary value and currency  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `currency` | string | no | 162 ISO-4217 codes — verbatim list in Appendix A | Currency as three letter code as per ISO 4217 |
| `amount` | number | no |  | Monetary amount to 2 decimal places |

**`AccountBalancesDto`** — Breakdown of the account balances  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `totalBalance` | CurrencyAmount | no |  |  |
| `heldBalance` | CurrencyAmount | no |  |  |
| `lockedBalance` | CurrencyAmount | no |  |  |
| `stacksBalance` | CurrencyAmount | no |  |  |
| `availableBalance` | CurrencyAmount | no |  |  |

**`CardUsageDetails`** — Details on the circumstances of card transaction  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `isMagneticStripePayment` | boolean | no |  | Specifies whether the magnetic stripe was used |
| `isContactless` | boolean | no |  | Specifies whether the payment was contactless |
| `isCardPresent` | boolean | no |  | Specifies whether it was a card present transaction |
| `isMobileWalletPayment` | boolean | no |  | Specifies whether it was a device wallet payment |
| `isAtmWithdrawal` | boolean | no |  | Specifies whether it was an ATM withdrawal |

**`CounterpartDetails`** — Transaction counterpart details.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `accountId` | string | no |  | Transaction counterpart account unique identifier (UUID) |
| `customerId` | string | no |  | Transaction counterpart customer unique identifier (UUID) |
| `name` | string | no |  | Transaction counterpart name. |
| `bpayDetails` | BpayDetails | no |  |  |
| `basicAccountNumber` | BasicAccountNumber | no |  |  |

**`BpayDetails`** — BPAY transaction counterpart details.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `billerCode` | string | no |  | Biller code. |
| `billerReference` | string | no |  | Customer reference number (CRN). |
| `billerName` | string | no |  | Biller name. |
| `billerImage` | string | no |  | Biller image. |

**`BasicAccountNumber`** — Details of the counterpart account number  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `accountNumber` | string | no |  |  |
| `branchNumber` | string | no |  |  |

**`RuleDetails`** — Details about the transaction blocking rule  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `ruleId` | string (uuid) | no |  | Unique identifier (UUID) of the transaction blocking rule |

**`MandatePaymentDetails`** — Mandate payment details.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `mandateId` | string (uuid) | no |  | Mandate ID associated to the transaction. |
| `instructionId` | string | no |  | Unique mandate payment instruction identification assigned by the instructing party. |
| `initiatingPartyName` | string | no |  | Initiating Party Name. |

**`ReturnReason`** — Reason for a transaction reversal.  
required: ['code', 'message']

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `code` | string | yes | `ACCOUNT_BLOCKED`, `ACCOUNT_CLOSED`, `ACCOUNT_INVALID`, `AMOUNT_INVALID`, `CANCELLED`, `CURRENCY_INVALID`, `CUSTOMER_REQUEST`, `DUPLICATE`, `FRAUD`, `OTHER` | Return reason code:  * **ACCOUNT_BLOCKED**: Account blocked  * **ACCOUNT_CLOSED**: Account closed  * **ACCOUNT_INVALID**: Invalid account details  * **AMOUNT_INVALID**: Invalid amount  * **CANCELLED**: Return following a… (full text below) |
| `message` | string | yes |  | Detailed return reason message |

Full description of `ReturnReason.code` (verbatim from spec):

> Return reason code:
>  * **ACCOUNT_BLOCKED**: Account blocked
>  * **ACCOUNT_CLOSED**: Account closed
>  * **ACCOUNT_INVALID**: Invalid account details
>  * **AMOUNT_INVALID**: Invalid amount
>  * **CANCELLED**: Return following a cancellation request
>  * **CURRENCY_INVALID**: Invalid currency
>  * **CUSTOMER_REQUEST**: Return of funds requested by end customer
>  * **DUPLICATE**: Duplicate payment
>  * **FRAUD**: Fraud or Regulatory
>  * **OTHER**: Other reason

**`ExternalIdentifierDto`** — External identifier associated with the transaction.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `source` | string | no |  | Source system (e.g. 'visa'). |
| `identifierType` | string | no |  | Identifier type (e.g. 'trace-lifecycle', 'acquirer-reference'). |
| `value` | string | no |  | Identifier value. |

Fields seen in docs examples but **absent from the spec**: `relatedHoldHayId` (null in NPP examples; the spec's `holdHayId` description says it "is also referred to as `relatedHoldHayId` when `isPending` flag is `false`"), `accountBalances.legacyAvailableBalance` (NPP INTRABANK_OUT examples) — §6 Q4.

#### `DIRECT_ENTRY` → `directEntryEvent`

**`DirectEntryEventDto`** — Details of the **Direct Entry** event; provided when the type is `DIRECT_ENTRY`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `transactionId` | string (uuid) | no |  | Unique identifier (UUID) of the Direct Entry Transaction associated with the event |
| `type` | string | no | `DEBIT` | Transaction type; Currently only the `DEBIT` type is supported. |
| `direction` | string | no | `OUTBOUND` | Transaction direction; Currently only the `OUTBOUND` direction is supported. |
| `status` | string | no | `RECEIVED`, `ACCEPTED`, `REJECTED`, `SUBMITTED`, `RETURNED`, `COMPLETE`, `INCOMPLETE` | Transaction status. |

#### `MANDATE` → `mandateEventDto`

**`MandateEventDto`** — Details of the **Mandate** event; provided when the type is `MANDATE`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `mandateId` | string (uuid) | no |  | Mandate identifier |
| `actionId` | string (uuid) | no |  | Action identifier |
| `description` | string | no |  | Event description |
| `trigger` | string | no | `MAMN`, `MAMP`, `MAMR`, `MAMX`, `MCRP`, `MCRR`, `MCRT`, `MCRX`, `MPOF`, `MPOT`, `MPOX`, `MSCH`, `CSCH`, `PAMC`, `PAMD`, `PAMN`, `PCRC`, `PCRD`, `PPOT`, `PSCH`, `PPOI`, `PPOR`, `MCRC`, `MCRD`, `MAMC`, `MAMD`, `CCRR`, `IAMN`, `ISCH`, `IAMP`, `IAMR`, `ICRR` | Event trigger * **CCRR**: Cuscal mandate create recalled * **CSCH**: Cuscal mandate status changed * **IAMN**: Initiator mandate amended * **IAMP**: Initiator mandate amend proposed * **IAMR**: Initiator mandate amend re… (full text below) |

Full description of `MandateEventDto.trigger` (verbatim from spec):

> Event trigger
> * **CCRR**: Cuscal mandate create recalled
> * **CSCH**: Cuscal mandate status changed
> * **IAMN**: Initiator mandate amended
> * **IAMP**: Initiator mandate amend proposed
> * **IAMR**: Initiator mandate amend recalled
> * **ICRR**: Initiator mandate create recalled
> * **ISCH**: Initiator mandate status changed
> * **MAMC**: Mandate amend confirmed
> * **MAMD**: Mandate amend declined
> * **MAMN**: Mandate amended
> * **MAMP**: Mandate amend proposed
> * **MAMR**: Mandate amend recalled
> * **MAMX**: Mandate amend expired
> * **MCRC**: Mandate create confirmed
> * **MCRD**: Mandate create declined
> * **MCRP**: Mandate create proposed
> * **MCRR**: Mandate create recalled
> * **MCRT**: Mandate created
> * **MCRX**: Mandate create expired
> * **MPOF**: Mandate port finalised
> * **MPOT**: Mandate ported
> * **MPOX**: Mandate port expired
> * **MSCH**: Mandate status changed
> * **PAMC**: Payer mandate amend confirmed
> * **PAMD**: Payer mandate amend declined
> * **PAMN**: Payer mandate amended
> * **PCRC**: Payer mandate create confirmed
> * **PCRD**: Payer mandate create declined
> * **PPOI**: Payer mandate port initiated
> * **PPOR**: Payer mandate port recalled
> * **PPOT**: Payer mandate ported
> * **PSCH**: Payer mandate status changed

#### `MANDATE_DUE_PAYMENT` → `mandateDuePaymentEventDto`

**`MandateDuePaymentEventDto`** — Details of the **Mandate Due Payment** event; provided when the type is `MANDATE_DUE_PAYMENT`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `mandateId` | string (uuid) | no |  | Mandate identification |
| `notificationId` | string (uuid) | no |  | Notification identifier |
| `paymentDateTimeUtc` | string (date-time) | no |  | Payment date and time |

#### `MANDATE_PAYMENT` → `mandatePaymentEventDto`

**`MandatePaymentEventDto`** — Details of the **Mandate Payment** event; provided when the type is `MANDATE_PAYMENT`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `instructionId` | string | no |  | Instruction identification |
| `mandateId` | string (uuid) | no |  | Mandate identifier |
| `paymentStatus` | string | no | `MANDATE_PAYMENT_ACCEPTED`, `MANDATE_PAYMENT_ACCEPTED_FOR_CLEARANCE`, `MANDATE_PAYMENT_PENDING`, `MANDATE_PAYMENT_RECEIVED`, `MANDATE_PAYMENT_REJECTED`, `MANDATE_PAYMENT_SENT`, `MANDATE_PAYMENT_SETTLEMENT_ABORTED`, `MANDATE_PAYMENT_STORE_AND_FORWARD`, `MANDATE_PAYMENT_UNDELIVERED` | Payment Status * **MANDATE_PAYMENT_RECEIVED**: Message has been received, no further update on status yet. Please continue to check for updates. * **MANDATE_PAYMENT_UNDELIVERED**: Message could not be delivered to the Pa… (full text below) |
| `reasonCode` | string | no |  | Payment rejection reason code: * **AB01**: Clearing process aborted due to timeout * **AB02**: Clearing process aborted due to a fatal error * **AB03**: Settlement aborted due to timeout * **AB04**: Settlement aborted du… (full text below) |
| `transactionHayId` | string (uuid) | no |  | Transaction identifier. When payment status is rejected, transaction identifier is null |
| `isFinal` | boolean | no |  | Whether the payment status is final |
| `originId` | string (uuid) | no |  | Transaction origin ID (to be used with `originType`). |
| `originType` | string | no | `CUSTOMER`, `SCHEDULED_PAYMENT`, `HAAS_OPERATIONS`, `OPERATIONS`, `MANDATE_PAYMENT`, `DIRECT_DEBIT`, `TRANSACTION` | Transaction origin type:  * **CUSTOMER**: Transaction initiated by a customer  * **SCHEDULED_PAYMENT**: Transaction initiated by a schedule  * **HAAS_OPERATIONS**: Transaction initiated by client operations  * **OPERATIO… (full text below) |

Full description of `MandatePaymentEventDto.paymentStatus` (verbatim from spec):

> Payment Status
> * **MANDATE_PAYMENT_RECEIVED**: Message has been received, no further update on status yet. Please continue to check for updates.
> * **MANDATE_PAYMENT_UNDELIVERED**: Message could not be delivered to the PayTo rails (PAG). Client should retry initiation.
> * **MANDATE_PAYMENT_SENT**: Message has been sent, no acknowledgement yet received. Please continue to check for updates.
> * **MANDATE_PAYMENT_STORE_AND_FORWARD**: Target institution is not available, but message will be relayed when they are back online. Please continue to check for updates.
> * **MANDATE_PAYMENT_ACCEPTED_FOR_CLEARANCE**: Payment is accepted but settlement not initiated. Please continue to check for updates.
> * **MANDATE_PAYMENT_SETTLEMENT_ABORTED**: Settlement could not be completed. A retry attempt will be made on behalf of the client. Please continue to check for updates.
> * **MANDATE_PAYMENT_ACCEPTED**: Settlement completed.
> * **MANDATE_PAYMENT_REJECTED**: Payment could not be completed. Request could be modified and resubmitted - or if unexpected problem then please contact Shaype team for support.
> * **MANDATE_PAYMENT_PENDING**: Settlement queued for handling but not complete. Please continue to check for updates

Full description of `MandatePaymentEventDto.reasonCode` (verbatim from spec):

> Payment rejection reason code:
> * **AB01**: Clearing process aborted due to timeout
> * **AB02**: Clearing process aborted due to a fatal error
> * **AB03**: Settlement aborted due to timeout
> * **AB04**: Settlement aborted due to a fatal error
> * **AB08**: Creditor agent is not online
> * **AC02**: Account to be debited does not exist
> * **AC03**: Account to be Credited does not exist
> * **AC05**: The original Payer Customer Account number is closed
> * **AC06**: Account is temporarily blocked where it is able to identify that the Account currently exists
> * **AC07**: Account to be credited previously existed and is now permanently closed
> * **AC13**: Account to be debited cannot debit funds within
> * **AC14**: Account to be credited cannot accept funds
> * **AC15**: Payer account was changed to different account
> * **AG01**: Account to be debited is unable to be debited
> * **AG03**: Payee Participant has rejected the resulting NPP payment from payer
> * **AG07**: Debtor account cannot be debited for a generic reason
> * **AGNT**: Agent in the payment workflow is incorrect
> * **AM01**: Use of zero-dollar payment initiation requests is prohibited
> * **AM02**: The amount requested is greater than the maximum NPP limit of $99,999,999,999
> * **AM03**: Specified message amount is a non-processable currency outside of existing agreement
> * **AM04**: Amount of funds available to cover specified message amount is insufficient
> * **AM06**: Specified transaction amount is less than agreed minimum
> * **AM09**: Amount received is not the amount agreed or expected
> * **AM12**: The amount in the NPP Payment Initiation Request is missing or invalid
> * **AM19**: Number of transactions at the Group level is invalid or missing
> * **AM21**: The amount requested in the NPP Payment Initiation Request exceeds the agreed limit
> * **BE05**: Reject the NPP Payment Initiation Request as the Creditor is unknown to Debtor
> * **BE06**: End customer specified is not known at associated Sort/National Bank Code or does no longer exist in the books
> * **BE08**: Debtor Name not provided
> * **BE22**: Creditor Name not provided
> * **CH20**: Number of decimal points not compatible with the currency
> * **CH21**: Required Compulsory Element Missing
> * **CURR**: The currency included in the Clearing Request is incorrect (value other than AUD)
> * **CUST**: Cancellation requested by the Debtor
> * **DT02**: The CreationDateTime in the Group Header is not as per the required format
> * **DT04**: The Business Service does not support future dated NPP Payment Initiation Requests
> * **ED05**: Settlement of the transaction has failed
> * **ED06**: Interbank settlement system not available
> * **FF04**: Service Level code is missing or invalid
> * **FF08**: End to End Id missing or invalid for catsct payment Instruction
> * **FF10**: File or transaction cannot be processed due to technical issues at the bank side
> * **FF11**: Clearing Request rejected due it being subject to an abort operation
> * **FRAD**: Cancellation requested following a transaction that was originated fraudulently
> * **G005**: Payment has been delivered to creditor agent with service level
> * **G006**: Payment has been delivered to creditor agent without service level
> * **MD01**: The NPP Payment Initiation Request did not contain a MandateId
> * **MD02**: The Mandate Cryptogram contained in a Mandate NPP Payment Initiation Request did not verify
> * **MD20**: The Mandate Cryptogram was older than the allowed timeframe (24hrs)
> * **MS02**: Reason has not been specified by end customer
> * **NARR**: Reason is provided as narrative information in the additional reason information
> * **RC05**: The BIC identifier in the Message Payload is invalid or missing
> * **RR04**: Regulatory Reason
> * **SL01**: Due to specific service offered by the Debtor Agent
> * **SL11**: The Creditor did not appear on the Debtors whitelist
> * **SL12**: The Creditor did appear on the Debtors blacklist
> * **SL13**: Number of transactions requested exceeds the Debtor Agent offering
> * **SL14**: Total value of transactions requested exceeds the Debtor Agent offering
> * **TD03**: The file format is incomplete or invalid
> * **TM01**: Request received after agreed cut-off time
> * **E991**: Check with Cuscal on possible Outage
> * **E992**: Check with Cuscal on possible Outage
> * **M901-M922**: Various mandate-specific error codes
> * **M308**: Creditor Reference Must be equal to End to End Id
> * **M001**: Invalid or not applicable character set
> * **E999**: Unexpected System Error
> * **PA04**: Check with Cuscal on possible Outage

Full description of `MandatePaymentEventDto.originType` (verbatim from spec):

> Transaction origin type:
>  * **CUSTOMER**: Transaction initiated by a customer
>  * **SCHEDULED_PAYMENT**: Transaction initiated by a schedule
>  * **HAAS_OPERATIONS**: Transaction initiated by client operations
>  * **OPERATIONS**: Transaction initiated by Shaype operations
>  * **MANDATE_PAYMENT**: Transaction initiated by mandate
>  * **DIRECT_DEBIT**: Transaction initiated by direct debit
>  * **TRANSACTION**: Transaction initiated by another transaction

#### `APPLE_PAY_REWARD_FOR_CUSTOMER` → `applePayRewardForCustomerEvent`

**`ApplePayRewardForCustomerEventDto`** — Details of the **Apple Pay Reward For Customer** event; provided when the type is `APPLE_PAY_REWARD_FOR_CUSTOMER`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `accountId` | string (uuid) | no |  | Account Id |
| `cardId` | string (uuid) | no |  | Card Id |

#### `MANDATE_ACTION_EXPIRATION` → `mandateActionExpirationEvent`

**`MandateActionExpirationEventDto`** — Details of the **Mandate Action Expiration** event; provided when the type is `MANDATE_ACTION_EXPIRATION`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `mandateId` | string (uuid) | no |  | Mandate identification |
| `actionId` | string (uuid) | no |  | Action identifier |
| `resolutionRequestedByDateTimeUtc` | string (date-time) | no |  | Resolution requested by date and time |

#### `DELEGATED_OTP_NOTIFICATION` → `delegatedOtpNotificationEvent`

**`DelegatedOtpNotificationEventDto`** — Details of the **Delegated OTP Notification** event; provided when the type is `DELEGATED_OTP_NOTIFICATION`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `cardId` | string (uuid) | no |  | Card identifier associated with the transaction |
| `accountId` | string (uuid) | no |  | Account identifier associated with the transaction |
| `merchantInfo` | MerchantInfoDto | no |  |  |
| `transactionInfo` | TransactionInfoDto | no |  |  |
| `passcode` | string | no |  | One-time passcode for 3DS authentication |

**`MerchantInfoDto`** — Details of the merchant involved in the transaction  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `acquirerId` | string | no |  | Acquirer identifier |
| `merchantId` | string | no |  | Merchant identifier |
| `merchantName` | string | no |  | Merchant display name |
| `merchantUrl` | string | no |  | Merchant website URL |
| `merchantCategoryCode` | string | no |  | Merchant category code |
| `merchantCountryCode` | string | no |  | Merchant country code |
| `merchantAppRedirectUrl` | string | no |  | Merchant app redirect URL |

**`TransactionInfoDto`** — Details of the transaction  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `transactionTimeStamp` | string | no |  | Transaction timestamp |
| `transactionAmount` | integer (int64) | no |  | Transaction amount |
| `transactionCurrency` | string | no |  | Transaction currency |
| `transactionExponent` | integer (int32) | no |  | Transaction exponent |

### 2.5 `SmsDto` and `EmailDto` (the `/sms` and `/email` endpoints) `[spec]`

Included for completeness; these carry auth-service / Accelerator-app events. Their `type` enums are **different** from `NotificationDto.type` and are not part of `webhookEvents` for the business stream.

**`SmsDto`** — Details of the SMS notification  
required: ['idempotencyKey', 'phoneNumber', 'type']

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `phoneNumber` | PhoneNumber | yes |  |  |
| `type` | string | yes | `ACCOUNT_STATUS_CHANGE`, `CARD_ADDED_TO_WALLET`, `OTP`, `PASSCODE_CHANGE`, `PHONE_NUMBER_VERIFICATION` | The type of the notification event - one of:  * **ACCOUNT_STATUS_CHANGE**: The status of an account has changed  * **CARD_ADDED_TO_WALLET**: Card has been added to a device wallet  * **OTP**: One-time password has been r… (full text below) |
| `idempotencyKey` | string (uuid) | yes |  | Idempotency key (UUID) to uniquely represent this request and prevent duplication. |
| `customerHayId` | string (uuid) | no |  | Unique identifier (UUID) of the Customer associated with the event |
| `cardStatusChangeEvent` | CardStatusChangeEventDto | no |  |  |
| `accountStatusChangeEvent` | AccountStatusChangeEventDto | no |  |  |
| `passcodeChangeEvent` | PasscodeChangeEventDto | no |  |  |
| `phoneNumberVerificationEvent` | PhoneNumberVerificationEventDto | no |  |  |
| `customerOtpEvent` | CustomerOtpEventDto | no |  |  |

Full description of `SmsDto.type` (verbatim from spec):

> The type of the notification event - one of:
>  * **ACCOUNT_STATUS_CHANGE**: The status of an account has changed
>  * **CARD_ADDED_TO_WALLET**: Card has been added to a device wallet
>  * **OTP**: One-time password has been requested
>  * **PASSCODE_CHANGE**: Customer's passcode has been changed
>  * **PHONE_NUMBER_VERIFICATION**: Phone number verification has been requested
> 

**`PhoneNumber`** — Phone number to send the SMS notification to.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `countryCodePrefix` | string | no |  |  |
| `numberAfterPrefix` | string | no |  |  |

**`CustomerOtpEventDto`** — Details of the **One-Time Password Request** event; provided when the type is `OTP`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `otp` | string | no |  | One-Time Password to be delivered to the customer |

**`PasscodeChangeEventDto`** — Details of the **Passcode Change** event; provided when the type is `PASSCODE_CHANGE`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `otp` | string | no |  | One-Time Password to be delivered to the customer |
| `type` | string | no | `SET_PASSCODE`, `FORGOT_PASSCODE` | The type of the passcode change:  * **SET_PASSCODE**: A new passcode has been set  * **FORGOT_PASSCODE**: Forgotten passcode process has been invoked |

**`PhoneNumberVerificationEventDto`** — Details of the **Phone Number Verification** event; provided when the type is `PHONE_NUMBER_VERIFICATION`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `otp` | string | no |  | One-Time Password to be delivered to the customer |

**`EmailDto`** — Details of the email notification  
required: ['emailAddress', 'idempotencyKey', 'type']

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `idempotencyKey` | string (uuid) | yes |  | Idempotency key (UUID) to uniquely represent this request and prevent duplication. |
| `emailAddress` | string | yes |  | Email address to send the email notification to. |
| `type` | string | yes | `CARD_ADDED_TO_WALLET`, `CARD_PIN_CHANGE`, `CUSTOMER_DETAILS_CHANGE`, `MAGIC_LINK`, `REMINDER` | The type of the notification event - one of:  * **CARD_ADDED_TO_WALLET**: Card has been added to a device wallet  * **CARD_PIN_CHANGE**: Card PIN has been changed  * **CUSTOMER_DETAILS_CHANGE**: Customer's personal detai… (full text below) |
| `customerDetails` | CustomerDetails | no |  |  |
| `cardHayId` | string (uuid), nullable | no |  | Unique identifier (UUID) of the Card associated with the event |
| `cardAdditionToWalletEvent` | CardAdditionToWalletEventDto | no |  |  |
| `cardPinChangeEvent` | CardPinChangeEventDto | no |  |  |
| `customerDetailsChangeEvent` | CustomerDetailsChangeEventDto | no |  |  |
| `magicLinkEvent` | MagicLinkEventDto | no |  |  |
| `reminderType` | string | no | `REMINDER_TO_COMPLETE_FUNDING`, `REMINDER_TO_PROVISION_DIGITAL_CARD`, `REMINDER_TO_TRANSACT`, `APPLE_PAY_REMINDER_24_HRS`, `APPLE_PAY_REMINDER_7_DAYS`, `APPLE_PAY_SPEND_REMINDER_7_DAYS`, `APPLE_PAY_SPEND_REMINDER_14_DAYS`, `APPLE_PAY_ADDITION_REWARD`, `APPLE_PAY_SPEND_REWARD`, `APPLE_PAY_ADD_TO_WALLET_REMINDER_30_DAYS`, `APPLE_PAY_ADD_TO_WALLET_REMINDER_60_DAYS`, `APPLE_PAY_ADD_TO_WALLET_REMINDER_90_DAYS`, `GOOGLE_PAY_24_HRS_PARTIAL_PROVISIONING`, `GOOGLE_PAY_7_DAYS_PARTIAL_PROVISIONING`, `GOOGLE_PAY_7_DAYS_SPEND_REMINDER`, `GOOGLE_PAY_14_DAYS_SPEND_REMINDER`, `CARD_EXPIRY_MONTH_REMINDER`, `CARD_EXPIRY_2_WEEK_REMINDER`, `CARD_EXPIRY_DAY_REMINDER` | Type of the **Reminder** event; provided when the type is `REMINDER`. Possible values:  * **REMINDER_TO_COMPLETE_FUNDING**  * **REMINDER_TO_PROVISION_DIGITAL_CARD**  * **REMINDER_TO_TRANSACT**  * **APPLE_PAY_REMINDER_24_… (full text below) |

Full description of `EmailDto.type` (verbatim from spec):

> The type of the notification event - one of:
>  * **CARD_ADDED_TO_WALLET**: Card has been added to a device wallet
>  * **CARD_PIN_CHANGE**: Card PIN has been changed
>  * **CUSTOMER_DETAILS_CHANGE**: Customer's personal details have been updated
>  * **MAGIC_LINK**: Magic link email has been requested
>  * **REMINDER**: A reminder

Full description of `EmailDto.reminderType` (verbatim from spec):

> Type of the **Reminder** event; provided when the type is `REMINDER`. Possible values:
>  * **REMINDER_TO_COMPLETE_FUNDING**
>  * **REMINDER_TO_PROVISION_DIGITAL_CARD**
>  * **REMINDER_TO_TRANSACT**
>  * **APPLE_PAY_REMINDER_24_HRS**
>  * **APPLE_PAY_REMINDER_7_DAYS**
>  * **APPLE_PAY_SPEND_REMINDER_7_DAYS**
>  * **APPLE_PAY_SPEND_REMINDER_14_DAYS**
>  * **GOOGLE_PAY_24_HRS_PARTIAL_PROVISIONING**
>  * **GOOGLE_PAY_7_DAYS_PARTIAL_PROVISIONING**
>  * **GOOGLE_PAY_7_DAYS_SPEND_REMINDER**
>  * **GOOGLE_PAY_14_DAYS_SPEND_REMINDER**

**`CustomerDetails`** — Details of the customer - recipient of the email.  
required: ['customerHayId', 'firstName', 'lastName', 'preferredName']

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `customerHayId` | string (uuid) | yes |  |  |
| `firstName` | string | yes |  |  |
| `lastName` | string | yes |  |  |
| `preferredName` | string | yes |  |  |

**`CardPinChangeEventDto`** — Details of the **Card PIN Change** event; provided when the type is `CARD_PIN_CHANGE`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `cardHayId` | string (uuid) | no |  | Unique identifier (UUID) of the Card associated with the event |
| `cardLastFourDigits` | string | no |  | Last four card digits |

**`MagicLinkEventDto`** — Details of the **Magic Link Email Request** event; provided when the type is `MAGIC_LINK`.  
required: none

| field | type | required | enum (verbatim) | description |
|---|---|---|---|---|
| `magicLink` | string | no |  | Magic Link to be delivered to the customer |

Observation `[docs:apple-and-google-pay-notifications]`: the `APPLE_PAY_REMINDER_24_HRS`, `APPLE_PAY_REMINDER_7_DAYS`, `GOOGLE_PAY_*` reminder examples on that page have `emailAddress` + `customerDetails{customerHayId,firstName,lastName,preferredName}` and no top-level `customerHayId` — i.e. they are `EmailDto` shapes (delivered to `/email`), while the `APPLE_PAY_ADD_TO_WALLET_REMINDER_*`, `APPLE_PAY_SPEND_REMINDER_*` and `CARD_ADDED_TO_WALLET` examples are `NotificationDto` shapes (delivered to `/notification`). The page does not say which endpoint each goes to (§6 Q5).
---

## 3. Delivery semantics

### 3.1 Retry policy `[docs:webhook-notification]` (verbatim where quoted)

| aspect | value | source |
|---|---|---|
| Who retries | "The Shaype platform is responsible for retrying the delivery of notifications if the client service is unreachable, unavailable, or returns a failure response code." | [docs:webhook-notification] |
| Strategy | "**exponential backoff** technique, where operations are retried with progressively increasing wait times, for a specified number of retry attempts." | [docs:webhook-notification] |
| Attempts / window | "The platform will retry sending the webhook notification **18 times** over a period of up to 48 hours." | [docs:webhook-notification] |
| Status codes that trigger retry | "**401, 403, 429, 5XX**" (plus unreachable/unavailable) | [docs:webhook-notification] |
| Exact backoff schedule | **not documented** | — |
| What happens after the 18th failure | **not documented** (dead-letter? manual replay?) | — |
| Codes NOT in the retry list | 400, 404, 422 etc. are not listed → treated as terminal by Shaype `[inferred]`. Note the spec advertises `422 Invalid Input` as a client response yet the retry list omits it — a 422 from the client presumably means "give up". | [inferred] |

### 3.2 Expected client response `[spec]` `[docs:webhook-notification]`

- Return **`200`** ("Success"). Spec lists `403 Unauthorised`, `422 Invalid Input`, `500 Internal error` as the other documented responses; no response body schema for any of them.
- Docs: "Handle the notifications, take appropriate actions, and respond to the notifications." and for `/email`, `/sms`: "return a simple 200 success response".
- No documented timeout for the client's response `[inferred: none]` (the *external authorisation* API, a different contract, says "We enforce a strict synchronous response timeout" without a number `[docs:external-authorisation-and-balance]`).

### 3.3 Idempotency / de-duplication `[spec]`

- Every envelope (`NotificationDto`, `NotificationDtoV1`, `SmsDto`, `EmailDto`) has required `idempotencyKey` — "Idempotency key (UUID) to uniquely represent this request and prevent duplication."
- `[inferred]` Retries re-send the **same** `idempotencyKey`; distinct events have distinct keys. In the docs examples, hold and settlement of the same purchase carry different `idempotencyKey`s but the same `holdHayId` `[docs:card-transactions]`.
- `[inferred]` Because retries exist, at-least-once delivery is the model; the client must de-dup on `idempotencyKey`.

### 3.4 Ordering

- **Not documented.** No statement about per-customer/per-account ordering, and the retry policy (18 attempts over 48h per notification) implies a later event can arrive before an earlier one that is still being retried `[inferred]`.
- The docs do describe *emission* sequences: hold → settlement ("Two webhooks are emitted in sequence") `[docs:simulates-card-transaction-on-staging]`; `DIRECT_ENTRY` `RECEIVED` and `ACCEPTED` "will be sent synchronously and SUBMITTED and COMPLETE status notification will arrive later" `[docs:direct-debits]`.

### 3.5 Authentication / signature headers

- Webhook spec: **none**. `jq '.components.securitySchemes'` → `null`; no `parameters` (header or otherwise) on any of the four operations `[spec]`.
- Docs: the client must "Provide notification details such as connectivity, authentication, and notification endpoint details to the Shaype Client Integration Team" `[docs:webhook-notification]` — i.e. auth is bilateral configuration (unspecified mechanism). The retry list including `401`/`403` implies Shaype expects the client to authenticate the call somehow `[inferred]`.
- Contrast — the **external authorisation callback** (`external-balance.yaml`, Shaype calling the client for `POST /holds`, `PATCH /holds/{holdId}`, `POST /transactions`) *does* define request headers on every operation `[spec:ext-auth]`: `Shaype-Version` (e.g. `2023-01-30`), `Shaype-Trace-Id`, `Shaype-Idempotency-Key`, `Shaype-Timestamp` (RFC-3339), `Shaype-Signature` ("Signature hash of the request body with the shared secret"), `Shaype-Key-Id`. Its docs `[docs:external-authorisation-and-balance]` describe signature verification and replay prevention via the timestamp. **Nothing says these headers are used on the notification webhooks** (§6 Q6). Local mock: do not add them to webhook POSTs unless the SUT requires it; make it configurable `[inferred]`.

### 3.6 Payload shape conventions observed in real samples `[docs:card-transactions]` `[docs:payments]`

- v0 envelopes are serialised with **all** event properties present, non-applicable ones as `null` (e.g. `"accountStatusChangeEvent": null, … "mandateActionExpirationEvent": null`), and `firebaseDeviceToken`/`actionOwner`/`cardHayId` also `null` when absent. Older examples (`[docs:payments]` INTRABANK_TRANSFER_IN, `[docs:bpay]`) omit nulls entirely. Both shapes must be accepted by a client; the local mock should pick one (recommend: omit nulls, the compact form) `[inferred]`.
- Money: `currencyAmount.amount` is **negative for debits, positive for credits** (e.g. `-8.40` hold, `0.5000` reversal, `5.99` refund, `2000.00` inbound) `[docs:card-transactions]` `[docs:payments]`. Spec says "Monetary amount to 2 decimal places" but examples show `0.5000` and integers `5066` — do not assume scale.
- Timestamps: `transactionTimeUtc` ISO-8601 with microseconds and `Z` (`2025-07-17T11:13:20.990107Z`).
- `productId` at envelope level is present in most TRANSACTION samples (`8aa6…` style UUID-ish values) but absent in some (reversal samples) `[docs:card-transactions]`.

