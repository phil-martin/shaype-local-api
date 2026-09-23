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

---

## 4. Trigger mapping — which operation / mock generator / external event emits which webhook, and when

Legend for "emitted by": `op:<operationId>` = B2B operation (`[spec:b2b]` / `ops.json`), `mock:<operationId>` = staging Utilities API generator, `ext:` = external system event (Visa, NPP, MMS, DE), `platform:` = Shaype scheduler / async processing. The `when` column is only as precise as the cited source; rows marked `[inferred]` have no doc backing for the emission itself.

### 4.1 `TRANSACTION` (`transactionEvent`), keyed by `transactionType`

| `transactionType` | `isPending` | emitted by | when | source |
|---|---|---|---|---|
| `CARD_TRANSACTION` | `true` | ext: Visa authorisation request; mock:`generateAuthHold`, mock:`generateCardTransaction` (1st of 2), mock:`generateHoldAndUpdateHoldTransactions` (initial hold, and again for a hold **increase** with the same `transactionHayId` and the updated total amount) | After internal checks (balance, limits, rules, fraud) and acknowledgement to Visa; "Then the platform sends transaction details, along with the outcome" — sent for declined outcomes too (`outcome` ≠ `ACCEPTED`, e.g. `REFUSED_RULES` with `ruleDetails`) | [docs:card-transactions] [docs:simulates-card-transaction-on-staging] [docs:accounts-overview] ("notification with the ruleDetail under type TRANSACTION on rule failed") |
| `CARD_TRANSACTION` | `false` | ext: Visa stand-in / ATM; mock:`generateAtmTransaction` | "settled in-line, no separate _SETTLED event", `isAtmTransaction: true`, `cardUsageDetails.isAtmWithdrawal: true` | [docs:simulates-card-transaction-on-staging] |
| `CARD_TRANSACTION_SETTLED` | `false` | ext: Visa presentment/clearing; mock:`generateCardTransaction` (2nd), mock:`generateHoldAndUpdateHoldTransactions` (last, after `settlementDelayInSeconds` 5–300) | "After successfully processing the settlement"; new `transactionHayId`, `holdHayId` = original hold; held balance released, total balance reduced | [docs:card-transactions] [docs:simulates-card-transaction-on-staging] [docs:external-authorisation-and-balance] ("After Hold accepted") |
| `CARD_TRANSACTION_REFUND` | `true` | ext: Visa authorisation reversal (partial/full hold decrease); mock:`generateHoldAndUpdateHoldTransactions` with **positive** `updateHoldAmount` | Pre-settlement; same `transactionHayId` as the hold; positive `currencyAmount.amount` = released portion | [docs:card-transactions] [docs:simulates-card-transaction-on-staging] |
| `CARD_TRANSACTION_REFUND` | `false` | ext: merchant refund / Visa OCT; mock:`generateRefundTransaction` | Post-settlement, own `transactionHayId`, "not linked to a prior purchase by Shaype" | [docs:card-transactions] [docs:simulates-card-transaction-on-staging] [docs:external-authorisation-and-balance] ("Hold decrease - OCT - Reversal - Refund") |
| `INTRABANK_TRANSFER_IN` | `false` | op:`makeTransferV1` (and deprecated `makeTransferV0`) with `transferType` `ACCOUNT` to a Shaype BSB ("automatically converted to an INTERNAL (ShaypePay) transaction") — delivered to the **recipient** customer | after execution; "both the sender and receiver will receive a webhook notification" | [docs:payments] [docs:direct-debits] |
| `INTRABANK_TRANSFER_OUT` | `false` | same as above — delivered to the **sender** customer | after execution; a reversal carries `returnReason` | [docs:payments] (NB: the page's INTRABANK_TRANSFER_OUT samples actually show `"transactionType": "INTERBANK_TRANSFER_OUT"` — §6 Q7) |
| `INTERBANK_TRANSFER_IN` | `false` | ext: inbound NPP / DE credit; mock:`generateInboundNppTransaction`, mock:`generateInboundNppTransactionV2` (also the settlement leg of a PayTo payment when the client is creditor), mock:`generateInboundDeTransaction` with `transactionType: CREDIT` `[inferred for the DE mock]` | on receipt of funds from an external bank | [docs:payments] [docs:direct-debits] [docs:payto-staging-testing-suite] |
| `INTERBANK_TRANSFER_OUT` | `false` | op:`makeTransferV1` to a non-Shaype BSB (NPP if eligible else DE); batch items from `createBatch` (`ACCOUNT_TRANSFER`) `[spec:batch]`; scheduled payments executing (`originType: SCHEDULED_PAYMENT`) `[inferred]` | after execution; NPP return → second event with positive amount and `returnReason` (e.g. `CUSTOMER_REQUEST`) | [docs:payments] [docs:direct-debits] [docs:batch-api] |
| `DIRECT_DEBIT_TRANSFER` | `false` | ext: external institution pulls funds ("external bank account pull funds from customer account using Direct Debit"); op:`createDirectDebitV1` outbound DD (credited "after two working days") — the `DIRECT_ENTRY` event is about the *request*, this one is "for the actual transaction"; mock:`generateInboundDeTransaction` with `transactionType: DEBIT` `[inferred]` | at posting | [docs:direct-debits] |
| `BPAY_TRANSFER_OUT` | `false` | op:`makeBpayPayment` | after payment accepted; `counterpartDetails.bpayDetails` populated | [docs:bpay] |
| `HAY_TOP_UP` | — | — | "An account top-up" — no docs | [spec] only; `[inferred]` legacy/Accelerator funding |
| `REWARD` | — | — | "A reward credited to the account" — no docs; Apple rewards are instead created by the client via `createCreditTransactionV1` with `transactionChannel: APPLE_REWARD` `[docs:apple-reward-transactions]` | [spec] only |
| `GENERAL_CREDIT` / `GENERAL_DEBIT` | `false` `[inferred]` | op:`createCreditTransactionV1` / op:`createDebitTransactionV1` (and V0) `[inferred]` — matches the ext-auth `authorisationTransactionType` values `GENERAL_CREDIT`/`GENERAL_DEBIT` `[spec:ext-auth]` | after the transaction is accepted | [inferred] |
| `ORIGINAL_CREDIT` | — | ext: "Visa Original Credit transaction" | — | [spec] only (ext-auth docs list OCT under CARD_TRANSACTION_REFUND — §6 Q8) |
| `CONVERSION_IN` / `CONVERSION_OUT` | — | op:`executeConversion` (FX) `[inferred]` — "Currency conversion buy (credit)" / "sell (debit)" | — | [spec] + [inferred] |
| `INTERBANK_TRANSFER_OUT_REVERSAL` | — | "(NOT CURRENTLY IN USE)" | never | [spec] |
| (any, PayTo settlement) | `false` | op:`makeAdhocPayment` / platform: scheduled mandate payments — "webhook notification of the payment with transaction event object that contain mandateId and Payment InstructionId" (`mandatePaymentDetails`) | when the NPP payment lands on the creditor account | [docs:payto-payment] |

### 4.2 Non-transaction v0 events

| `type` | emitted by | when | source |
|---|---|---|---|
| `ACCOUNT_STATUS_CHANGE` | op:`createAccount` / op:`createHayAccount` → `APPROVED` (`actionOwner: PLATFORM` in the sample); platform: first deposit/withdrawal `APPROVED → ACTIVE`; op:`blockAccount` → blocked (`LOCKED` per docs / `BLOCKED` per enum, §6 Q2); op:`unblockAccount` → `ACTIVE`; op:`closeAccount` → `CLOSED`; platform: overdraft arrears `ACTIVE ↔ ACTIVE_IN_ARREARS` | on each status transition `[inferred: docs give the transitions, the sample, and the event's purpose "The status of an account has changed", not an explicit per-op emission list]` | [docs:customer-creation-1] (sample) [docs:account-status] [docs:account-closure] |
| `CUSTOMER_STATUS_UPDATED` | op:`changeHayCustomerStatus` ("also sends a webhook event with the type CUSTOMER_STATUS_UPDATED"); op:`blockCustomer` → `BLOCKED`; op:`unblockCustomer` → `ACTIVE`; platform: account closure making the customer `INACTIVE` `[inferred]`; platform: onboarding outcome → `ACTIVE`/`REFERRED`/`REJECTED` `[inferred]` | on status change; `actionOwner: CLIENT` in the sample | [docs:customer-creation-1] [docs:account-closure] |
| `CUSTOMER_DETAILS_CHANGE` | op:`updateCustomer` ("also sends a webhook event with the type CUSTOMER_DETAILS_CHANGE along with the customerDetailsChangeEvent object") | after update; booleans flag which of phone/name/email/address changed | [docs:customer-creation-1] |
| `ONBOARDING_PASSED` | platform: async onboarding checks after op:`createHayCustomer` (and KYC ops `approve*Check` `[inferred]`) | when onboarding completes successfully | [docs:customer-creation-1] (sample only; wording "Customer onboarding completed successfully" from spec) |
| `ONBOARDING_FAILED` | platform: same pipeline | on failure at `DOCUMENT_SCAN` / `SANCTIONS_SCAN` / `KYC_AML_SCAN` / `DUPLICATE_CHECK` | [docs:customer-creation-1] (sample) [spec] |
| `CARD_STATUS_CHANGE` | op:`activateCard` → `ACTIVE`; op:`blockCard` → `BLOCKED`; op:`unblockCard` → `ACTIVE`; op:`cancelCard` → `INACTIVE`; op:`reissueHayCard` (old → `INACTIVE`, new `AWAITING_ACTIVATION` if physical / `ACTIVE` if virtual); op:`renewCard` (old disabled after new activated); op:`convertCard`; op:`createHayCard` (`AWAITING_ACTIVATION`/`ACTIVE`); op:`closeAccount` → all linked cards `INACTIVE` ("you will receive the following Notification events … Card Status Change"); platform: expiry → `EXPIRED` | on each card status transition `[inferred for all but closeAccount; docs:card-operations gives resulting statuses but never says a webhook fires]` | [docs:account-closure] [docs:card-operations] [spec] |
| `CARD_ADDED_TO_WALLET` | ext: Apple/Google/Samsung wallet provisioning completes | "Triggered immediately after card added to wallet" | [docs:apple-and-google-pay-notifications] |
| `REMINDER` (Apple/Google `reminderType`s) | platform: reminder scheduler, started "when a customer starts the process of adding their card to a digital wallet" (or, for the `_ADD_TO_WALLET_REMINDER_30/60/90_DAYS`, when the card is created but provisioning never started) | 24h / 7d / 14d / 30d / 60d / 90d schedules as named; `_7_DAYS_PARTIAL_PROVISIONING` "Only triggered on first attempt of partial provisioning attempt" | [docs:apple-and-google-pay-notifications] |
| `REMINDER` (`CARD_EXPIRY_MONTH_REMINDER`, `CARD_EXPIRY_2_WEEK_REMINDER`, `CARD_EXPIRY_DAY_REMINDER`) | platform: pre-expiry scheduler, with `cardExpiryReminderEvent{cardId, expirationMonth, expirationYear}`; staging can move expiry with mock:`changeCardExpiryDate` `[inferred]` | 1 month / 2 weeks / 1 day before expiry `[inferred from names]` | [spec] |
| `REMINDER` (`REMINDER_TO_COMPLETE_FUNDING`, `REMINDER_TO_PROVISION_DIGITAL_CARD`, `REMINDER_TO_TRANSACT`, `APPLE_PAY_ADDITION_REWARD`, `APPLE_PAY_SPEND_REWARD`) | — | no docs at all | [spec] only |
| `APPLE_PAY_REWARD_FOR_CUSTOMER` | platform: "After the reminders notification, if a condition is met (provision completed or spent on Apple Pay token)"; "client configurable, so it can be enabled/disabled"; account-level (one reward per joint account) | when condition met; client then calls `createCreditTransactionV1` with `transactionChannel: APPLE_REWARD` | [docs:apple-reward-transactions] |
| `SCHEDULED_PAYMENT` | platform/GraphQL: scheduled-payment **creation** (`createScheduledPayment` mutation on the UI portal — "not available through the B2B API"); PayTo: automatic scheduled payment creation when a mandate becomes active `[inferred]` | on creation; payload = `{hayId}` | [spec] ("Scheduled payment creation notification") [docs:scheduled-payments] |
| `DIRECT_ENTRY` | op:`createDirectDebitV1` — "The platform will send `DIRECT_ENTRY` webhook notification for each of the statuses in the diagram above. A RECEIVED and ACCEPTED webhook will be sent synchronously and SUBMITTED and COMPLETE status notification will arrive later."; returns → `RETURNED` / `REJECTED` / `INCOMPLETE` `[inferred]`; mock:`generateInboundDeTransaction` with `recordType` `RETURN`/`REFUSAL` `[inferred]` | per status; `type: DEBIT`, `direction: OUTBOUND` only | [docs:direct-debits] [spec] |
| `MANDATE` | ext: NPP Mandate Management Service notifications (client = Payment Initiator, or Payer); mock:`generateMandateNotificationForInitiator` (triggers `MCRC,MCRD,MCRX,MAMC,MAMD,MAMN,MAMX,MPOF,MPOT,MPOX,MSCH`) and mock:`generateMandateNotificationForPayer` (`MCRX,MCRT,MCRP,MAMN,MAMP,MAMR,MAMX,MSCH`) | on MMS action: authorisation responses (accepted/declined/expired), debtor status changes (suspended/released/cancelled), amendments, recalls; `trigger` = MMS code | [docs:payto-notifications] [docs:payto-staging-testing-suite] [spec:b2b] |
| `MANDATE_PAYMENT` | op:`makeAdhocPayment` (staging: "will receive a RJCT PSR notification"); platform: scheduled mandate payments; mock:`generateReceiveAPaymentInstruction` (`transactionStatus` `ACCP`/`RJCT`) `[inferred]` | "sent for all payment instructions when the final status is known"; `paymentStatus` + `isFinal` + `reasonCode` on rejection | [docs:payto-notifications] [docs:payto-payment] [spec:b2b] |
| `MANDATE_DUE_PAYMENT` | platform `[inferred]` | ahead of a scheduled mandate payment (`paymentDateTimeUtc`) `[inferred]` | [spec] only |
| `MANDATE_ACTION_EXPIRATION` | platform/MMS `[inferred]` — bilateral action pending resolution with `resolutionRequestedByDateTimeUtc`; MMS expiry itself arrives as `MANDATE` with `MCRX`/`MAMX` | `[inferred]` | [spec] only |
| `DELEGATED_OTP_NOTIFICATION` | ext: 3-D Secure authentication of a card-not-present transaction (Shaype delegates OTP delivery to the client) | during 3DS challenge; payload has `passcode`, `merchantInfo`, `transactionInfo` | [spec] only |

### 4.3 v1 generic events

| `type` / `eventType` | emitted by | when | source |
|---|---|---|---|
| `BATCH_COMPLETED` | op:`createBatch` (`[spec:batch]`, `POST /batches`) | "Once the batch has completed … confirm all records have been attempted … count of how many transactions have been ACCEPTED, FAILED or returned an ERROR" (spec field names: `itemStatistics.pending/success/error/failed`; `status` `RECEIVED`/`PROCESSING`/`COMPLETED`). Each ACCEPTED/FAILED item also produces its own `TRANSACTION` webhook; ERROR items produce none. | [docs:batch-api] [spec] |
| `PERK_ORDER_UPDATE` | op:`createOrder` (`POST /v1/perks/orders`) `[inferred]` | "Final order status" `COMPLETED`/`DECLINED`/`REVERSED`, with PIN details for PIN-based products | [spec] only |

### 4.4 Mock generators (staging Utilities API) → webhooks, at a glance `[docs:simulates-card-transaction-on-staging]` `[spec:b2b]`

| mock operationId | path | webhooks produced |
|---|---|---|
| `generateAtmTransaction` | `POST /v0/utils/generate-atm-transaction` | 1× `TRANSACTION` `CARD_TRANSACTION` `isPending:false`, `isAtmTransaction:true` |
| `generateAuthHold` | `POST /v0/utils/generate-auth-hold` | 1× `CARD_TRANSACTION` `isPending:true`, `holdHayId == transactionHayId` |
| `generateCardTransaction` | `POST /v0/utils/generate-card-transaction` | `CARD_TRANSACTION` (pending) then `CARD_TRANSACTION_SETTLED` after `settlementDelayInSeconds` |
| `generateHoldAndUpdateHoldTransactions` | `POST /v0/utils/generate-update-auth-hold` | hold → (increase: `CARD_TRANSACTION` pending, same id \| decrease: `CARD_TRANSACTION_REFUND` pending, same id) after `updateHoldDelayInSeconds` → `CARD_TRANSACTION_SETTLED` |
| `generateRefundTransaction` | `POST /v0/utils/generate-refund-transaction` | 1× `CARD_TRANSACTION_REFUND` `isPending:false` |
| `generateInboundNppTransaction` / `…V2` | `POST /v0/utils/generate-npp-inbound`, `…/generate-inbound-npp-transaction-v2` | `TRANSACTION` `INTERBANK_TRANSFER_IN` `[inferred from docs:payments]` |
| `generateInboundDeTransaction` | `POST /v0/utils/generate-de-inbound` | `TRANSACTION` (`INTERBANK_TRANSFER_IN` for CREDIT / `DIRECT_DEBIT_TRANSFER` for DEBIT) and/or `DIRECT_ENTRY` for RETURN/REFUSAL `[inferred]` |
| `generateMandateNotificationForInitiator` / `…ForPayer` | `POST /v0/utils/generate-mandate-notification-initiator`, `…-payer` | `MANDATE` with the requested `trigger` `[inferred: docs say "notification", spec DTO is MandateEventDto]` |
| `generateReceiveAPaymentInstruction` | `POST /v0/utils/generate-receive-a-payment-instruction` | `MANDATE_PAYMENT` (`ACCP`→accepted / `RJCT`→rejected) `[inferred]` |
| `changeCardExpiryDate` | `PATCH /v0/utils/cards/{cardId}/expiry-date` | enables testing `CARD_EXPIRY_*` reminders / `EXPIRED` status `[inferred]` |
| `createStubForMandateSearchPaymentInstructions` | `POST /v0/utils/create-stub-search-payment-instructions` | none (stubs a query) |

Declined simulations: `declineReason` (`CARD_EXPIRED`, `WRONG_CVV`, `CVV_BLOCKED`, `PIN_BLOCKED`, `INCORRECT_PIN`, `ALLOWED_PIN_RETRIES_EXCEEDED`, `INVALID_MERCHANT`, `CARD_IS_NOT_ACTIVE`, `RESTRICTED_CARD`) makes the processor decline; how that maps onto `outcome`/`cardProcessorResponse` in the resulting webhook is not documented (§6 Q9) `[docs:simulates-card-transaction-on-staging]`.

---

## 5. Example payloads (verbatim copies from the docs; the spec itself contains no examples)

Every block below is copied byte-for-byte from the cited page (including typos such as a missing opening quote or a trailing space in an id — they are in the source). Nothing here is fabricated; where no example exists for an event type, that is stated and a clearly-labelled **[inferred] skeleton** derived from the spec is given instead.

### 5.1 `TRANSACTION` — card hold / settlement / incremental / reversal / refund

#### TRANSACTION (card) — scenario "1. Hold Authorisation Request + Settlement" — Authorisation Hold Webhook Sample `[docs:card-transactions]`

```json
{
  "customerHayId": "1111a53d-d8e0-45af-9977-6309879cedd7",
  "idempotencyKey": "22228600-489b-4dc9-8177-d712024c3c5d",
  "type": "TRANSACTION",
  "productId": "33338e33-77ce-fdfa-0188-cfa462650060",
  "firebaseDeviceToken": null,
  "actionOwner": null,
  "cardHayId": null,
  "accountStatusChangeEvent": null,
  "customerStatusUpdatedEvent": null,
  "transactionEvent": {
    "transactionHayId": "44449ce6-3251-4a18-ac77-439e370e6bb4",
		"holdHayId": "44449ce6-3251-4a18-ac77-439e370e6bb4",
    "accountHayId": "555507d1-10f8-41f9-ba77-d71542ba4e4c",
    "currencyAmount": {
      "currency": "AUD",
      "amount": -8.40
    },
    "updatedBalance": {
      "currency": "AUD",
      "amount": 2.73
    },
    "isPending": true,
    "outcome": "ACCEPTED",
    "transactionTimeUtc": "2025-07-17T11:13:20.990107Z",
    "cardPreferenceOutcome": null,
    "cardProcessorResponse": null,
    "transactionType": "CARD_TRANSACTION",
    "cardUsageDetails": {
      "isMagneticStripePayment": null,
      "isContactless": null,
      "isCardPresent": true,
      "isMobileWalletPayment": false,
      "isAtmWithdrawal": false
    },
    "isAtmTransaction": false,
    "accountBalances": {
      "totalBalance": {
        "currency": "AUD",
        "amount": 11.13
      },
      "heldBalance": {
        "currency": "AUD",
        "amount": 8.4
      },
      "lockedBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "stacksBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "availableBalance": {
        "currency": "AUD",
        "amount": 2.73
      }
    },
    "cardHayId": "66660ee3-f26d-47f9-8d77-a475170043b8",
    "customerHayId": "1111a53d-d8e0-45af-9977-6309879cedd7",
    "ruleDetails": null,
    "counterpartDetails": null,
    "originId": null,
    "originType": null,
    "counterpartName": "IGA (Mt Cotton)",
    "merchantName": null,
    "category": null,
    "merchantId": "000009493578577",
    "description": null,
    "mandatePaymentDetails": null,
    "returnReason": null
  },
  "cardStatusChangeEvent": null,
  "customerDetailsChangeEvent": null,
  "cardAdditionToWalletEvent": null,
  "reminderType": null,
  "scheduledPaymentEvent": null,
  "onboardingFailedEvent": null,
  "directEntryEvent": null,
  "mandateDuePaymentEvent": null,
  "mandateEvent": null,
  "mandatePaymentEvent": null,
  "applePayRewardForCustomerEvent": null,
  "cardExpiryReminderEvent": null,
  "mandateActionExpirationEvent": null
}
```

#### TRANSACTION (card) — scenario "1. Hold Authorisation Request + Settlement" — Settlement Webhook Sample `[docs:card-transactions]`

```json
{
  "customerHayId": "1111a53d-d8e0-45af-9977-6309879cedd7",
  "idempotencyKey": "777797a5-9b88-49a6-aa77-6918ee8dfc1e",
  "type": "TRANSACTION",
  "productId": "33338e33-77ce-fdfa-0188-cfa462650060",
  "firebaseDeviceToken": null,
  "actionOwner": null,
  "cardHayId": null,
  "accountStatusChangeEvent": null,
  "customerStatusUpdatedEvent": null,
  "transactionEvent": {
    "transactionHayId": 888858f5-12bc-4e06-a577-21776b900a12",
    "holdHayId": "44449ce6-3251-4a18-ac77-439e370e6bb4",
		"accountHayId": "555507d1-10f8-41f9-ba77-d71542ba4e4c",
    "currencyAmount": {
      "currency": "AUD",
      "amount": -8.40
    },
    "updatedBalance": {
      "currency": "AUD",
      "amount": 2.73
    },
    "isPending": false,
    "outcome": "ACCEPTED",
    "transactionTimeUtc": "2025-07-17T11:13:20.990107Z",
    "cardPreferenceOutcome": null,
    "cardProcessorResponse": null,
    "transactionType": "CARD_TRANSACTION_SETTLED",
    "cardUsageDetails": {
      "isMagneticStripePayment": null,
      "isContactless": null,
      "isCardPresent": true,
      "isMobileWalletPayment": false,
      "isAtmWithdrawal": false
    },
    "isAtmTransaction": false,
    "accountBalances": {
      "totalBalance": {
        "currency": "AUD",
        "amount": 2.73
      },
      "heldBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "lockedBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "stacksBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "availableBalance": {
        "currency": "AUD",
        "amount": 2.73
      }
    },
    "cardHayId": "66660ee3-f26d-47f9-8d77-a475170043b8",
    "customerHayId": "1111a53d-d8e0-45af-9977-6309879cedd7",
    "ruleDetails": null,
    "counterpartDetails": null,
    "originId": null,
    "originType": null,
    "counterpartName": "IGA (Mt Cotton)",
    "merchantName": null,
    "category": null,
    "merchantId": "000009493578598",
    "description": null,
    "mandatePaymentDetails": null,
    "returnReason": null
  },
  "cardStatusChangeEvent": null,
  "customerDetailsChangeEvent": null,
  "cardAdditionToWalletEvent": null,
  "reminderType": null,
  "scheduledPaymentEvent": null,
  "onboardingFailedEvent": null,
  "directEntryEvent": null,
  "mandateDuePaymentEvent": null,
  "mandateEvent": null,
  "mandatePaymentEvent": null,
  "applePayRewardForCustomerEvent": null,
  "cardExpiryReminderEvent": null,
  "mandateActionExpirationEvent": null
}
```

#### TRANSACTION (card) — scenario "2. Incremental Authorisation" — Initial Hold Webhook Sample `[docs:card-transactions]`

```json
{
  "customerHayId": "111c046d-32f4-4920-af32-7df893f85b5b",
  "idempotencyKey": "22272762-37a1-4911-b432-b51fd032cc0d",
  "type": "TRANSACTION",
  "productId": "33368fda-8047-2f19-0132-477797f6016e",
  "firebaseDeviceToken": null,
  "actionOwner": null,
  "cardHayId": null,
  "accountStatusChangeEvent": null,
  "customerStatusUpdatedEvent": null,
  "transactionEvent": {
  	"transactionHayId": "4441ae58-1f2b-417d-98d3-08c8b12504e0",    
		"holdHayId": "4441ae58-1f2b-417d-98d3-08c8b12504e0",
    "accountHayId": "5554720e-33ed-4bfe-9832-9f87de9e8fff",
    "currencyAmount": {
      "currency": "AUD",
      "amount": -9.00
    },
    "updatedBalance": {
      "currency": "AUD",
      "amount": 5066
    },
    "isPending": true,
    "outcome": "ACCEPTED",
    "transactionTimeUtc": "2025-07-17T11:13:20.990107Z",
    "cardPreferenceOutcome": null,
    "cardProcessorResponse": null,
    "transactionType": "CARD_TRANSACTION",
    "cardUsageDetails": {
      "isMagneticStripePayment": null,
      "isContactless": null,
      "isCardPresent": false,
      "isMobileWalletPayment": false,
      "isAtmWithdrawal": false
    },
    "isAtmTransaction": false,
    "accountBalances": {
      "totalBalance": {
        "currency": "AUD",
        "amount": 232.64
      },
      "heldBalance": {
        "currency": "AUD",
        "amount": 166.64
      },
      "lockedBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "stacksBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "availableBalance": {
        "currency": "AUD",
        "amount": 66.00
      }
    },
    "cardHayId": "6666eb76-a0cb-4c1c-a9c3-4e89b40b70ff",
    "customerHayId": "111c046d-32f4-4920-af32-7df893f85b5b",
    "ruleDetails": null,
    "counterpartDetails": null,
    "originId": null,
    "originType": null,
    "counterpartName": "PayPal",
    "merchantName": null,
    "category": null,
    "merchantId": "000980200061932",
    "description": null,
    "mandatePaymentDetails": null,
    "returnReason": null
  },
  "cardStatusChangeEvent": null,
  "customerDetailsChangeEvent": null,
  "cardAdditionToWalletEvent": null,
  "reminderType": null,
  "scheduledPaymentEvent": null,
  "onboardingFailedEvent": null,
  "directEntryEvent": null,
  "mandateDuePaymentEvent": null,
  "mandateEvent": null,
  "mandatePaymentEvent": null,
  "applePayRewardForCustomerEvent": null,
  "cardExpiryReminderEvent": null,
  "mandateActionExpirationEvent": null
}
```

#### TRANSACTION (card) — scenario "2. Incremental Authorisation" — Incremental Hold Webhook Sample `[docs:card-transactions]`

```json
{
  "customerHayId": "111c046d-32f4-4920-af32-7df893f85b5b",
  "idempotencyKey": "123e32c2-5b6c-4575-ad32-2f25a68d27e2",
  "type": "TRANSACTION",
  "productId": "33368fda-8047-2f19-0132-477797f6016e",
  "firebaseDeviceToken": null,
  "actionOwner": null,
  "cardHayId": null,
  "accountStatusChangeEvent": null,
  "customerStatusUpdatedEvent": null,
  "transactionEvent": {
    "transactionHayId": "4441ae58-1f2b-417d-98d3-08c8b12504e0",
    "holdHayId": "4441ae58-1f2b-417d-98d3-08c8b12504e0",
		"accountHayId": "5554720e-33ed-4bfe-9832-9f87de9e8fff",
    "currencyAmount": {
      "currency": "AUD",
      "amount": -19.00
    },
    "updatedBalance": {
      "currency": "AUD",
      "amount": 5065
    },
    "isPending": true,
    "outcome": "ACCEPTED",
    "transactionTimeUtc": "2025-07-17T11:13:20.990107Z",
    "cardPreferenceOutcome": null,
    "cardProcessorResponse": null,
    "transactionType": "CARD_TRANSACTION",
    "cardUsageDetails": {
      "isMagneticStripePayment": null,
      "isContactless": null,
      "isCardPresent": true,
      "isMobileWalletPayment": false,
      "isAtmWithdrawal": false
    },
    "isAtmTransaction": false,
    "accountBalances": {
      "totalBalance": {
        "currency": "AUD",
        "amount": 241.64
      },
      "heldBalance": {
        "currency": "AUD",
        "amount": 176.64
      },
      "lockedBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "stacksBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "availableBalance": {
        "currency": "AUD",
        "amount": 65.00
      }
    },
    "cardHayId": "6666eb76-a0cb-4c1c-a9c3-4e89b40b70ff",
    "customerHayId": "111c046d-32f4-4920-af32-7df893f85b5b",
    "ruleDetails": null,
    "counterpartDetails": null,
    "originId": null,
    "originType": null,
    "counterpartName": "PayPal",
    "merchantName": null,
    "category": null,
    "merchantId": "000980200061932",
    "description": null,
    "mandatePaymentDetails": null,
    "returnReason": null
  },
  "cardStatusChangeEvent": null,
  "customerDetailsChangeEvent": null,
  "cardAdditionToWalletEvent": null,
  "reminderType": null,
  "scheduledPaymentEvent": null,
  "onboardingFailedEvent": null,
  "directEntryEvent": null,
  "mandateDuePaymentEvent": null,
  "mandateEvent": null,
  "mandatePaymentEvent": null,
  "applePayRewardForCustomerEvent": null,
  "cardExpiryReminderEvent": null,
  "mandateActionExpirationEvent": null
}
```

#### TRANSACTION (card) — scenario "2. Incremental Authorisation" — Settlement Webhook Sample `[docs:card-transactions]`

```json
{
  "customerHayId": "111c046d-32f4-4920-af32-7df893f85b5b",
  "idempotencyKey": "4560ac1d-fd93-442b-ab32-db57a64e3412",
  "type": "TRANSACTION",
  "productId": "33368fda-8047-2f19-0132-477797f6016e",
  "firebaseDeviceToken": null,
  "actionOwner": null,
  "cardHayId": null,
  "accountStatusChangeEvent": null,
  "customerStatusUpdatedEvent": null,
  "transactionEvent": {
  	"transactionHayId": "7890c496-ff68-40d6-9932-af154202924b",
		"holdHayId": "4441ae58-1f2b-417d-98d3-08c8b12504e0",
    "accountHayId": "5554720e-33ed-4bfe-9832-9f87de9e8fff",
    "currencyAmount": {
      "currency": "AUD",
      "amount": -19.00
    },
    "updatedBalance": {
      "currency": "AUD",
      "amount": 5075
    },
    "isPending": false,
    "outcome": "ACCEPTED",
    "transactionTimeUtc": "2025-07-17T11:13:20.990107Z",
    "cardPreferenceOutcome": null,
    "cardProcessorResponse": null,
    "transactionType": "CARD_TRANSACTION_SETTLED",
    "cardUsageDetails": {
      "isMagneticStripePayment": null,
      "isContactless": null,
      "isCardPresent": false,
      "isMobileWalletPayment": false,
      "isAtmWithdrawal": false
    },
    "isAtmTransaction": false,
    "accountBalances": {
      "totalBalance": {
        "currency": "AUD",
        "amount": 75
      },
      "heldBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "lockedBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "stacksBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "availableBalance": {
        "currency": "AUD",
        "amount": 75
      }
    },
    "cardHayId": "6666eb76-a0cb-4c1c-a9c3-4e89b40b70ff",
    "customerHayId": "111c046d-32f4-4920-af32-7df893f85b5b",
    "ruleDetails": null,
    "counterpartDetails": null,
    "originId": null,
    "originType": null,
    "counterpartName": "PayPal",
    "merchantName": null,
    "category": null,
    "merchantId": "000980200061995",
    "description": null,
    "mandatePaymentDetails": null,
    "returnReason": null
  },
  "cardStatusChangeEvent": null,
  "customerDetailsChangeEvent": null,
  "cardAdditionToWalletEvent": null,
  "reminderType": null,
  "scheduledPaymentEvent": null,
  "onboardingFailedEvent": null,
  "directEntryEvent": null,
  "mandateDuePaymentEvent": null,
  "mandateEvent": null,
  "mandatePaymentEvent": null,
  "applePayRewardForCustomerEvent": null,
  "cardExpiryReminderEvent": null,
  "mandateActionExpirationEvent": null
}
```

#### TRANSACTION (card) — scenario "3. Authorisation Reversal / Hold Decrease (partial/full)" — Initial Hold Webhook Sample `[docs:card-transactions]`

```json
{
  "customerHayId": "d09010f7-62f8-4575-8544-836447fd701e",
  "idempotencyKey": "d80a2248-068d-4664-b944-94b4e6e8e149",
  "type": "TRANSACTION",
  "firebaseDeviceToken": null,
  "actionOwner": null,
  "cardHayId": null,
  "accountStatusChangeEvent": null,
  "customerStatusUpdatedEvent": null,
  "transactionEvent": {
    "transactionHayId": "fba1cf60-116d-4704-b744-2e937796e3fa",
    "holdHayId": "fba1cf60-116d-4704-b744-2e937796e3fa",
		"accountHayId": "dae57032-4ad7-44e3-b8a4-c9f7dae4ea1b",
    "currencyAmount": {
      "currency": "AUD",
      "amount": -5.00
    },
    "updatedBalance": {
      "currency": "AUD",
      "amount": 1.37
    },
    "isPending": true,
    "outcome": "ACCEPTED",
    "transactionTimeUtc": "2025-07-17T11:13:20.990107Z",
    "cardPreferenceOutcome": null,
    "cardProcessorResponse": null,
    "transactionType": "CARD_TRANSACTION",
    "cardUsageDetails": {
      "isMagneticStripePayment": null,
      "isContactless": null,
      "isCardPresent": true,
      "isMobileWalletPayment": true,
      "isAtmWithdrawal": false
    },
    "isAtmTransaction": false,
    "accountBalances": {
      "totalBalance": {
        "currency": "AUD",
        "amount": 10.87
      },
      "heldBalance": {
        "currency": "AUD",
        "amount": 9.5
      },
      "lockedBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "stacksBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "availableBalance": {
        "currency": "AUD",
        "amount": 1.37
      }
    },
    "cardHayId": "88d88c60-c894-432a-95b4-cf907aec8d66",
    "customerHayId": "d09010f7-62f8-4575-8544-836447fd701e",
    "ruleDetails": null,
    "counterpartDetails": null,
    "originId": null,
    "originType": null,
    "counterpartName": "Coca-Cola Europacific Partners",
    "merchantName": null,
    "category": null,
    "merchantId": "26185344",
    "description": null,
    "mandatePaymentDetails": null,
    "returnReason": null
  },
  "cardStatusChangeEvent": null,
  "customerDetailsChangeEvent": null,
  "cardAdditionToWalletEvent": null,
  "reminderType": null,
  "scheduledPaymentEvent": null,
  "onboardingFailedEvent": null,
  "directEntryEvent": null,
  "mandateDuePaymentEvent": null,
  "mandateEvent": null,
  "mandatePaymentEvent": null,
  "applePayRewardForCustomerEvent": null,
  "cardExpiryReminderEvent": null,
  "mandateActionExpirationEvent": null
}
```

#### TRANSACTION (card) — scenario "3. Authorisation Reversal / Hold Decrease (partial/full)" — Reversal Transaction Webhook Sample `[docs:card-transactions]`

```json
{
  "customerHayId": "d09010f7-62f8-4575-8544-836447fd701e",
  "idempotencyKey": "67b5c1f1-d73e-4481-aa44-f597f6fd9e31",
  "type": "TRANSACTION",
  "firebaseDeviceToken": null,
  "actionOwner": null,
  "cardHayId": null,
  "accountStatusChangeEvent": null,
  "customerStatusUpdatedEvent": null,
  "transactionEvent": {
    "transactionHayId": "fba1cf60-116d-4704-b744-2e937796e3fa",
    "holdHayId": "fba1cf60-116d-4704-b744-2e937796e3fa",
		"accountHayId": "dae57032-4ad7-44e3-b8a4-c9f7dae4ea1b",
    "currencyAmount": {
      "currency": "AUD",
      "amount": 0.5000
    },
    "updatedBalance": {
      "currency": "AUD",
      "amount": 1.87
    },
    "isPending": true,
    "outcome": "ACCEPTED",
    "transactionTimeUtc": "2025-07-17T11:13:20.990107Z",
    "cardPreferenceOutcome": null,
    "cardProcessorResponse": null,
    "transactionType": "CARD_TRANSACTION_REFUND",
    "cardUsageDetails": {
      "isMagneticStripePayment": null,
      "isContactless": null,
      "isCardPresent": false,
      "isMobileWalletPayment": true,
      "isAtmWithdrawal": false
    },
    "isAtmTransaction": false,
    "accountBalances": {
      "totalBalance": {
        "currency": "AUD",
        "amount": 10.87
      },
      "heldBalance": {
        "currency": "AUD",
        "amount": 9
      },
      "lockedBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "stacksBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "availableBalance": {
        "currency": "AUD",
        "amount": 1.87
      }
    },
    "cardHayId": "88d88c60-c894-432a-95b4-cf907aec8d66",
    "customerHayId": "d09010f7-62f8-4575-8544-836447fd701e",
    "ruleDetails": null,
    "counterpartDetails": null,
    "originId": null,
    "originType": null,
    "counterpartName": "Coca-Cola Europacific Partners",
    "merchantName": null,
    "category": null,
    "merchantId": "26185344",
    "description": null,
    "mandatePaymentDetails": null,
    "returnReason": null
  },
  "cardStatusChangeEvent": null,
  "customerDetailsChangeEvent": null,
  "cardAdditionToWalletEvent": null,
  "reminderType": null,
  "scheduledPaymentEvent": null,
  "onboardingFailedEvent": null,
  "directEntryEvent": null,
  "mandateDuePaymentEvent": null,
  "mandateEvent": null,
  "mandatePaymentEvent": null,
  "applePayRewardForCustomerEvent": null,
  "cardExpiryReminderEvent": null,
  "mandateActionExpirationEvent": null
}
```

#### TRANSACTION (card) — scenario "3. Authorisation Reversal / Hold Decrease (partial/full)" — Settlement Webhook Sample `[docs:card-transactions]`

```json
{
  "customerHayId": "d09010f7-62f8-4575-8544-836447fd701e ",
  "idempotencyKey": "99f35464-8d9d-40ff-a844-b0faa6d731ab",
  "type": "TRANSACTION",
  "firebaseDeviceToken": null,
  "actionOwner": null,
  "cardHayId": null,
  "accountStatusChangeEvent": null,
  "customerStatusUpdatedEvent": null,
  "transactionEvent": {
  	"transactionHayId": "88614cd9-cedd-4595-a044-39ed95c05a12",
		"holdHayId": "fba1cf60-116d-4704-b744-2e937796e3fa",
    "accountHayId": "dae57032-4ad7-44e3-b8a4-c9f7dae4ea1b",
    "currencyAmount": {
      "currency": "AUD",
      "amount": -4.50
    },
    "updatedBalance": {
      "currency": "AUD",
      "amount": 1.87
    },
    "isPending": false,
    "outcome": "ACCEPTED",
    "transactionTimeUtc": "2025-07-17T11:13:20.990107Z",
    "cardPreferenceOutcome": null,
    "cardProcessorResponse": null,
    "transactionType": "CARD_TRANSACTION_SETTLED",
    "cardUsageDetails": {
      "isMagneticStripePayment": null,
      "isContactless": null,
      "isCardPresent": true,
      "isMobileWalletPayment": true,
      "isAtmWithdrawal": false
    },
    "isAtmTransaction": false,
    "accountBalances": {
      "totalBalance": {
        "currency": "AUD",
        "amount": 1.87
      },
      "heldBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "lockedBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "stacksBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "availableBalance": {
        "currency": "AUD",
        "amount": 1.87
      }
    },
    "cardHayId": "88d88c60-c894-432a-95b4-cf907aec8d66",
    "customerHayId": "d09010f7-62f8-4575-8544-836447fd701e",
    "ruleDetails": null,
    "counterpartDetails": null,
    "originId": null,
    "originType": null,
    "counterpartName": "Coca-Cola Europacific Partners",
    "merchantName": null,
    "category": null,
    "merchantId": "26185330",
    "description": null,
    "mandatePaymentDetails": null,
    "returnReason": null
  },
  "cardStatusChangeEvent": null,
  "customerDetailsChangeEvent": null,
  "cardAdditionToWalletEvent": null,
  "reminderType": null,
  "scheduledPaymentEvent": null,
  "onboardingFailedEvent": null,
  "directEntryEvent": null,
  "mandateDuePaymentEvent": null,
  "mandateEvent": null,
  "mandatePaymentEvent": null,
  "applePayRewardForCustomerEvent": null,
  "cardExpiryReminderEvent": null,
  "mandateActionExpirationEvent": null
}
```

#### TRANSACTION (card) — scenario "4. Refund" — Refund Transaction Webhook Sample `[docs:card-transactions]`

```json
{
  "customerHayId": "dc15c3fb-4feb-49d4-a278-b8d5d7d93dcd",
  "idempotencyKey": "fbec65cd-00cf-423e-9d78-da1c885dc911",
  "type": "TRANSACTION",
  "productId": "8aa68667-8009-b773-0178-09f41bf00124",
  "transactionEvent": {
    "transactionHayId": "63c86de3-9146-4377-a388-421d08697d19",
    "accountHayId": "98032560-0e21-475b-b876-e8672becb8d8",
    "currencyAmount": {
      "currency": "AUD",
      "amount": 5.99
    },
    "updatedBalance": {
      "currency": "AUD",
      "amount": 3305.99
    },
    "isPending": false,
    "counterpartName": "IGA (Piedimonte\u0027s Fitzroy North)",
    "outcome": "ACCEPTED",
    "transactionTimeUtc": "2024-09-16T08:17:18.947713Z",
    "isAtmTransaction": false,
    "transactionType": "CARD_TRANSACTION_REFUND",
    "cardUsageDetails": {
      "isCardPresent": false,
      "isMobileWalletPayment": false,
      "isAtmWithdrawal": false
    },
    "accountBalances": {
      "totalBalance": {
        "currency": "AUD",
        "amount": 5.99
      },
      "heldBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "lockedBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "stacksBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "availableBalance": {
        "currency": "AUD",
        "amount": 5.99
      }
    },
    "cardHayId": "1ade4041-27f8-4e07-ab78-bbed3ae1e740",
    "customerHayId": "dc15c3fb-4feb-49d4-a278-b8d5d7d93dcd",
    "merchantId": "000009391315129"
  }
}
```

### 5.2 `TRANSACTION` — NPP / internal transfers

#### TRANSACTION (NPP/internal) — `INTRABANK_TRANSFER_IN` `[docs:payments]`

```json
{
  "customerHayId": "3f42ae09-3e37-41b5-996e-70de4b4bc8y4",
  "idempotencyKey": "2c84111b-a568-3434-9cac-70de4b4bc8y4",
  "type": "TRANSACTION",
  "productId": "8aa68667-8009-b773-0180-70de4b4bc8y4",
  "transactionEvent": {
    "transactionHayId": "bdb22873-ebdf-3c82-a1a0-70de4b4bc8y4",
    "accountHayId": "4d4f348e-5f9b-4c01-9a04-70de4b4bc8y4",
    "currencyAmount": {
      "currency": "AUD",
      "amount": 2000.00
    },
    "updatedBalance": {
      "currency": "AUD",
      "amount": 3144.69
    },
    "isPending": false,
    "counterpartName": "Andy",
    "outcome": "ACCEPTED",
    "transactionTimeUtc": "2024-06-12T07:16:41.370341Z",
    "isAtmTransaction": false,
    "transactionType": "INTRABANK_TRANSFER_IN",
    "accountBalances": {
      "totalBalance": {
        "currency": "AUD",
        "amount": 3144.69
      },
      "heldBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "lockedBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "stacksBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "availableBalance": {
        "currency": "AUD",
        "amount": 3144.69
      }
    },
    "counterpartDetails": {
      "name": "Andy"
    },
    "category": "SAVING",
    "description": "description"
  }
}
```

#### TRANSACTION (NPP/internal) — `Original Transfer Sample Notification` `[docs:payments]`

```json
{
    "customerHayId": "c1ce15ef-9ee0-41ed-a562-f7b59ad70acb",
    "idempotencyKey": "e1e0dd2b-8f0a-44bf-bee1-6870b8bf2541",
    "type": "TRANSACTION",
    "firebaseDeviceToken": null,
    "actionOwner": null,
    "cardHayId": null,
    "accountStatusChangeEvent": null,
    "customerStatusUpdatedEvent": null,
    "transactionEvent": {
      "transactionHayId": "a1a0c9ef-76a9-40b9-8606-cecb0b29d736",
      "accountHayId": "b1b1ce0d-1a05-4bbf-9af2-4c4aaa7474a3",
      "currencyAmount": {
        "currency": "AUD",
        "amount": -212.38
      },
      "updatedBalance": {
        "currency": "AUD",
        "amount": 1067.61
      },
      "isPending": false,
      "outcome": "ACCEPTED",
      "transactionTimeUtc": "2024-06-12T07:16:41.370341Z",
      "cardPreferenceOutcome": null,
      "cardProcessorResponse": null,
      "transactionType": "INTERBANK_TRANSFER_OUT",
      "cardUsageDetails": null,
      "isAtmTransaction": false,
      "accountBalances": {
        "totalBalance": {
          "currency": "AUD",
          "amount": 5182.41
        },
        "heldBalance": {
          "currency": "AUD",
          "amount": 4114.8
        },
        "lockedBalance": {
          "currency": "AUD",
          "amount": 0
        },
        "stacksBalance": {
          "currency": "AUD",
          "amount": 0
        },
        "availableBalance": {
          "currency": "AUD",
          "amount": 1067.61
        },
        "legacyAvailableBalance": {
          "currency": "AUD",
          "amount": 1067.61
        }
      },
      "cardHayId": null,
      "customerHayId": "c1ce15ef-9ee0-41ed-a562-f7b59ad70acb",
      "ruleDetails": null,
      "counterpartDetails": {
        "name": "Romar Viduya",
        "bpayDetails": null,
        "basicAccountNumber": {
          "accountNumber": "123441287",
          "branchNumber": "111985"
        }
      },
      "originId": null,
      "originType": null,
      "counterpartName": "Romar Viduya",
      "merchantName": null,
      "category": "Shaype POC",
      "merchantId": null,
      "relatedHoldHayId": null,
      "description": "Romar",
      "mandatePaymentDetails": null,
      "returnReason": null
    },
    "cardStatusChangeEvent": null,
    "customerDetailsChangeEvent": null,
    "cardAdditionToWalletEvent": null,
    "reminderType": null,
    "scheduledPaymentEvent": null,
    "onboardingFailedEvent": null,
    "directEntryEvent": null,
    "mandateDuePaymentEvent": null,
    "mandateEvent": null,
    "mandatePaymentEvent": null,
    "applePayRewardForCustomerEvent": null,
    "cardExpiryReminderEvent": null,
    "mandateActionExpirationEvent": null
}
```

#### TRANSACTION (NPP/internal) — `Return Transfer Sample Notification` `[docs:payments]`

```json
{
    "customerHayId": "c1ce15ef-9ee0-41ed-a562-f7b59ad70acb",
    "idempotencyKey": "f1f2d7e6-e398-4638-adf1-29b87013ad10",
    "type": "TRANSACTION",
    "firebaseDeviceToken": null,
    "actionOwner": null,
    "cardHayId": null,
    "accountStatusChangeEvent": null,
    "customerStatusUpdatedEvent": null,
    "transactionEvent": {
      "transactionHayId": "d1db4bea-650c-44db-b55e-b1473ccaaf99",
      "accountHayId": "b1b1ce0d-1a05-4bbf-9af2-4c4aaa7474a3",
      "currencyAmount": {
        "currency": "AUD",
        "amount": 212.38
      },
      "updatedBalance": {
        "currency": "AUD",
        "amount": 267.61
      },
      "isPending": false,
      "outcome": "ACCEPTED",
      "transactionTimeUtc": "2024-06-12T07:16:41.370341Z",
      "cardPreferenceOutcome": null,
      "cardProcessorResponse": null,
      "transactionType": "INTERBANK_TRANSFER_OUT",
      "cardUsageDetails": null,
      "isAtmTransaction": false,
      "accountBalances": {
        "totalBalance": {
          "currency": "AUD",
          "amount": 267.61
        },
        "heldBalance": {
          "currency": "AUD",
          "amount": 0
        },
        "lockedBalance": {
          "currency": "AUD",
          "amount": 0
        },
        "stacksBalance": {
          "currency": "AUD",
          "amount": 0
        },
        "availableBalance": {
          "currency": "AUD",
          "amount": 267.61
        },
        "legacyAvailableBalance": {
          "currency": "AUD",
          "amount": 267.61
        }
      },
      "cardHayId": null,
      "customerHayId": null,
      "ruleDetails": null,
      "counterpartDetails": {
        "name": "Romar Viduya",
        "bpayDetails": null,
        "basicAccountNumber": {
          "accountNumber": "123441287",
          "branchNumber": "111985"
        }
      },
      "originId": null,
      "originType": null,
      "counterpartName": "Romar Viduya",
      "merchantName": null,
      "category": "BANK_TRANSFER",
      "merchantId": null,
      "relatedHoldHayId": null,
      "description": "Romar",
      "mandatePaymentDetails": null,
      "returnReason": {
        "code": "CUSTOMER_REQUEST",
        "message": "Return of funds requested by end customer"
      }
    },
    "cardStatusChangeEvent": null,
    "customerDetailsChangeEvent": null,
    "cardAdditionToWalletEvent": null,
    "reminderType": null,
    "scheduledPaymentEvent": null,
    "onboardingFailedEvent": null,
    "directEntryEvent": null,
    "mandateDuePaymentEvent": null,
    "mandateEvent": null,
    "mandatePaymentEvent": null,
    "applePayRewardForCustomerEvent": null,
    "cardExpiryReminderEvent": null,
    "mandateActionExpirationEvent": null
  }
```

#### TRANSACTION (NPP/internal) — `INTERBANK_TRANSFER_IN` `[docs:payments]`

```json
{
  "customerHayId": "61f3d1d3-78e1-4da4-ab8f-faa13546ab8f",
  "idempotencyKey": "b98b9584-a296-40db-8a52-faa13546ab8f",
  "type": "TRANSACTION",
  "productId": "8aa686b7-7c36-e802-017c-faa13546ab8f",
  "transactionEvent": {
    "transactionHayId": "f416825e-17d0-4366-acba-faa13546ab8f",
    "accountHayId": "0285c377-bdf8-461e-a885-faa13546ab8f",
    "currencyAmount": {
      "currency": "AUD",
      "amount": 200.00
    },
    "updatedBalance": {
      "currency": "AUD",
      "amount": 62925.58
    },
    "isPending": false,
    "counterpartName": "Andy",
    "outcome": "ACCEPTED",
    "transactionTimeUtc": "2024-06-12T07:21:54.220527Z",
    "isAtmTransaction": false,
    "transactionType": "INTERBANK_TRANSFER_IN",
    "accountBalances": {
      "totalBalance": {
        "currency": "AUD",
        "amount": 66049.69
      },
      "heldBalance": {
        "currency": "AUD",
        "amount": 3124.11
      },
      "lockedBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "stacksBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "availableBalance": {
        "currency": "AUD",
        "amount": 62925.58
      }
    },
    "counterpartDetails": {
      "name": "Andy"
    },
    "category": "BANK_TRANSFER",
    "description": "withdrawal"
  }
}
```

#### TRANSACTION (NPP/internal) — `INTERBANK_TRANSFER_OUT` `[docs:payments]`

```json
{
  "customerHayId": "58b86c08-d2b4-4f1d-a7fc-fcd1aeb6a7fc",
  "idempotencyKey": "54b7383a-0b68-4757-9e96-fcd1aeb6a7fc",
  "type": "TRANSACTION",
  "firebaseDeviceToken": "eQwhRSuQkWk:APA91bE4E2fcd2mpB_CkHNukNSESigu3fK_vDaVqvzXu0K_1z_aHZPfGyD5IouQFhArUe_S0BIb5QYwnilRnTubAfO1Q_fcd1aeb6a7fc",
  "productId": "8aa686b7-7c36-e802-017c-fcd1aeb6a7fc",
  "transactionEvent": {
    "transactionHayId": "90f90c57-a85e-4a2f-b444-fcd1aeb6a7fc",
    "accountHayId": "9ea48b15-474c-4276-bf90-fcd1aeb6a7fc",
    "currencyAmount": {
      "currency": "AUD",
      "amount": -0.01
    },
    "updatedBalance": {
      "currency": "AUD",
      "amount": 9568.52
    },
    "isPending": false,
    "counterpartName": "Andy",
    "outcome": "ACCEPTED",
    "transactionTimeUtc": "2024-06-12T07:31:58.77028Z",
    "isAtmTransaction": false,
    "transactionType": "INTERBANK_TRANSFER_OUT",
    "accountBalances": {
      "totalBalance": {
        "currency": "AUD",
        "amount": 9568.52
      },
      "heldBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "lockedBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "stacksBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "availableBalance": {
        "currency": "AUD",
        "amount": 9568.52
      }
    },
    "customerHayId": "58b86c08-d2b4-4f1d-a7fc-fcd1aeb6a7fc",
    "counterpartDetails": {
      "name": "Andy",
      "basicAccountNumber": {
        "accountNumber": "12345000",
        "branchNumber": "518900"
      }
    },
    "category": "BANK_TRANSFER",
    "description": "Trip expenses"
  }
}
```

### 5.3 `TRANSACTION` — Direct Entry / Direct Debit, and `DIRECT_ENTRY`

#### TRANSACTION (Direct Debit) — `DIRECT_DEBIT_TRANSFER` `[docs:direct-debits]`

```json
{
  "customerHayId": "46db5ab0-8ee2-4cb9-b059-68a75b23b059",
  "idempotencyKey": "8183131d-021b-49ae-a032-68a75b23b059",
  "type": "TRANSACTION",
  "productId": "8aa6879a-74d5-37a5-0174-68a75b23b059",
  "transactionEvent": {
    "transactionHayId": "fd7a2acb-f906-415d-9378-68a75b23b059",
    "accountHayId": "ac364762-56bd-41a2-a966-68a75b23b059",
    "currencyAmount": {
      "currency": "AUD",
      "amount": -457.12
    },
    "updatedBalance": {
      "currency": "AUD",
      "amount": 3197.26
    },
    "isPending": false,
    "counterpartName": "Andy",
    "outcome": "ACCEPTED",
    "transactionTimeUtc": "2024-06-21T12:21:54.689834Z",
    "isAtmTransaction": false,
    "transactionType": "DIRECT_DEBIT_TRANSFER",
    "accountBalances": {
      "totalBalance": {
        "currency": "AUD",
        "amount": 3197.26
      },
      "heldBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "lockedBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "stacksBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "availableBalance": {
        "currency": "AUD",
        "amount": 3197.26
      }
    },
    "customerHayId": "46db5ab0-8ee2-4cb9-b059-68a75b23b059",
    "counterpartDetails": {
      "name": "Andy"
    },
    "category": "BANK_TRANSFER",
    "description": "Thanks for lunch"
  }
}
```

#### `DIRECT_ENTRY` — `status: COMPLETE` `[docs:direct-debits]`

```json
{
  "customerHayId": "000d8874-f9c4-455e-b565-6d439fdd55ad",
  "idempotencyKey": "5fcae09b-b2f1-3d6f-a60c-c02b8c842083",
  "type": "DIRECT_ENTRY",
  "directEntryEvent": {
    "transactionId": "7a70baa7-a4d4-4359-8cae-37e7bf971342",
    "type": "DEBIT",
    "direction": "OUTBOUND",
    "status": "COMPLETE"
  }
}
```

### 5.4 `TRANSACTION` — BPAY

#### TRANSACTION (BPAY) — `BPAY_TRANSFER_OUT` `[docs:bpay]`

```json
{
  "customerHayId": "63d24ae0-d497-485e-800a-ad141542d23r",
  "idempotencyKey": "f2f7076f-6fb1-46e1-9730-369a86f3234e",
  "type": "TRANSACTION",
  "productId": "8aa68646-77a4-8411-0177-a4dabc5d03d1",
  "transactionEvent": {
    "transactionHayId": "d3daec8e-6044-4c60-b233-ad141542d23r",
    "accountHayId": "150960b2-d042-4b63-abaa-ad141542d23r",
    "currencyAmount": {
      "currency": "AUD",
      "amount": -20.00
    },
    "updatedBalance": {
      "currency": "AUD",
      "amount": 151087.66
    },
    "isPending": false,
    "counterpartName": "TestGQL",
    "outcome": "ACCEPTED",
    "transactionTimeUtc": "2024-06-21T03:03:16.354179Z",
    "isAtmTransaction": false,
    "transactionType": "BPAY_TRANSFER_OUT",
    "accountBalances": {
      "totalBalance": {
        "currency": "AUD",
        "amount": 151087.66
      },
      "heldBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "lockedBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "stacksBalance": {
        "currency": "AUD",
        "amount": 0
      },
      "availableBalance": {
        "currency": "AUD",
        "amount": 151087.66
      }
    },
    "customerHayId": "63d24ae0-d497-485e-800a-ad141542d23r",
    "counterpartDetails": {
      "name": "TestGQL",
      "bpayDetails": {
        "billerCode": "93880",
        "billerReference": "271682361223",
        "billerName": "iiNet",
        "billerImage": "https://images.lookwhoscharging.com/8d9595b6-812e-4e32-8a58-fedbe856b2f2/iinet-ci-image.png"
      }
    },
    "category": "Category",
    "description": "test BPAY TRANSFER BA AU PAYEE"
  }
}
```

### 5.5 Customer / account lifecycle events

#### `ONBOARDING_PASSED` `[docs:customer-creation-1]`

```json
{
  "customerHayId": "42f5b631-edd5-00f0-9f17-cd17da0ca0d9",
  "idempotencyKey": "42f5b631-edd5-00f0-9f17-cd17da0ca0d9",
  "type": "ONBOARDING_PASSED",
  "firebaseDeviceToken": "fD3ZhPHr3UxGsi81Xc_zGt:APA91bFuuqvv4pUJ39sXE79RJK3kBvgYwUmfH2E9F9wUdlgurBkvWNyxv8vsLL93RCKKyyaZ9i4hk5rM1oxgCvTH6rtOozmoAge0_VPdJg32eNVHvdfZlKpAUhsaPKtV3JfriZsdf234sd"
}
```

#### `ONBOARDING_FAILED` `[docs:customer-creation-1]`

```json
{
  "customerHayId": "c1c476dd-6c1a-23dd-8e4f-a4229f9563bf",
  "idempotencyKey": "3971e549-a178-23dd-9d76-737328a6ce40",
  "type": "ONBOARDING_FAILED",
  "firebaseDeviceToken": "dbRQCIhFLEsIn3_SSDE8r9:APA91bHTpCuhS6sjHG6uRMnP_tn7mOmy0QebEprYDQPVoJf7oXspxhagt9Ai1OuDqZHssU7BMk-sxII85WcFoxqruW8NXCykwvPzyjTh9UiYbKYdUdS6tg-TPsaPuAeQGQblasdd32sdfsZ",
  "onboardingFailedEvent": {
    "state": "KYC_AML_SCAN",
    "isSubmissionFailure": true
  }
}
```

#### `CUSTOMER_STATUS_UPDATED` `[docs:customer-creation-1]`

```json
{
  "customerHayId": "74b7aaa9-dwe3-4a09-a618-f1bd405c3ead",
  "idempotencyKey": "f7ec6a11-df3t-4eff-a5d9-31e948e8210f",
  "type": "CUSTOMER_STATUS_UPDATED",
  "actionOwner": "CLIENT",
  "customerStatusUpdatedEvent": {
    "customerStatus": "ACTIVE"
  }
}
```

#### `ACCOUNT_STATUS_CHANGE` `[docs:customer-creation-1]`

```json
{
  "customerHayId": "0964ac36-a1dd-8dj8-b0a1-f01eca1941b4",
  "idempotencyKey": "ff1531ca-d069-6537-bede-95db70c12a91",
  "type": "ACCOUNT_STATUS_CHANGE",
  "actionOwner": "PLATFORM",
  "accountStatusChangeEvent": {
    "accountHayId": "92000f75-11f6-4ec1-h892-6a98591ab95f",
    "accountStatus": "APPROVED"
  }
}
```

### 5.6 Apple / Google Pay reminders, `CARD_ADDED_TO_WALLET`, `APPLE_PAY_REWARD_FOR_CUSTOMER`

Note: several reminder blocks on the docs page start with a prose line inside the code fence; it is reproduced as-is. Blocks with `emailAddress`/`customerDetails` are `EmailDto`-shaped (see §2.5).

#### REMINDER / wallet — `APPLE_PAY_ADD_TO_WALLET_REMINDER_30_DAYS` `[docs:apple-and-google-pay-notifications]`

```json
{
  "customerHayId": "e35176d6-0d18-4d0d-bfde-186583ef5s23",
  "idempotencyKey": "43ff14b2-2f0a-4409-a821-bb823d92cs34",
  "type": "REMINDER",
  "cardHayId": "8d382435-3fba-4edb-807b-1f0389698765",
  "reminderType": "APPLE_PAY_ADD_TO_WALLET_REMINDER_30_DAYS"
}
```

#### REMINDER / wallet — `APPLE_PAY_ADD_TO_WALLET_REMINDER_60_DAYS` `[docs:apple-and-google-pay-notifications]`

```json
{
  "customerHayId": "e98a0fa5-df8f-4b5a-b365-186583ef5s23",
  "idempotencyKey": "01b58dc2-7590-43ea-9b8e-bb823d92cs34",
  "type": "REMINDER",
  "cardHayId": "e2a4f618-d452-4fe9-ae5e-1f0389698765",
  "reminderType": "APPLE_PAY_ADD_TO_WALLET_REMINDER_60_DAYS"
}
```

#### REMINDER / wallet — `APPLE_PAY_ADD_TO_WALLET_REMINDER_90_DAYS` `[docs:apple-and-google-pay-notifications]`

```json
{
  "customerHayId": "0349ee9d-771d-4f54-a2c1-186583ef5s23",
  "idempotencyKey": "67e54ae5-aac8-469d-be35-bb823d92cs34",
  "type": "REMINDER",
  "cardHayId": "38323d18-c472-45da-8456-1f0389698765",
  "reminderType": "APPLE_PAY_ADD_TO_WALLET_REMINDER_90_DAYS"
}
```

#### REMINDER / wallet — `APPLE_PAY_REMINDER_24_HRS` `[docs:apple-and-google-pay-notifications]`

```json
Within 24 hours of customer onboarding, Apple Pay provisioning has begun but
has not yet been completed.

{
  "idempotencyKey": "bd84afb3-80de-456b-909e-186583ef5s23",
  "emailAddress": "abc@xx.com",
  "type": "REMINDER",
  "customerDetails": {
    "customerHayId": "f064f06a-e5bb-4b0c-8318-186583ef5s23",
    "firstName": "Andyfirstname",
    "lastName": "Andylastname",
    "preferredName": "Andy"
  },
  "cardHayId": "3057cd4f-45cf-48ba-af7f-186583ef5s23",
  "reminderType": "APPLE_PAY_REMINDER_24_HRS"
}
```

#### REMINDER / wallet — `APPLE_PAY_REMINDER_7_DAYS` `[docs:apple-and-google-pay-notifications]`

```json
Within 7 days of provisioning commencing, but it still has not been completed.
Only triggered on first attempt of partial provisioning attempt

{
  "idempotencyKey": "4bf4bca6-67c3-450e-82b3-bb823d92cs34",
  "emailAddress": "abc@xx.com.au",
  "type": "REMINDER",
  "customerDetails": {
    "customerHayId": "3f11e4df-fcf1-484a-918a-186583ef5s23",
    "firstName": "Andy firstname",
    "lastName": "Andy lastname",
    "preferredName": "Andy"
  },
  "reminderType": "APPLE_PAY_REMINDER_7_DAYS"
}
```

#### REMINDER / wallet — `GOOGLE_PAY_24_HRS_PARTIAL_PROVISIONING` `[docs:apple-and-google-pay-notifications]`

```json
Within 24 hours of customer onboarding, Google Pay provisioning 
has begun but has not yet been completed.

{
  "idempotencyKey": "ed004e8a-522b-4899-910e-49c74bea1976",
  "emailAddress": "abc@xx.com.au",
  "type": "REMINDER",
  "customerDetails": {
    "customerHayId": "9528f731-8447-433c-936b-9940d7d3121b",
    "firstName": "Andyfirstname",
    "lastName": "Andylastname",
    "preferredName": "Andy"
  },
  "cardHayId": "4893794b-37a6-4234-8b35-9940d7d3121b",
  "reminderType": "GOOGLE_PAY_24_HRS_PARTIAL_PROVISIONING"
}
```

#### REMINDER / wallet — `GOOGLE_PAY_7_DAYS_PARTIAL_PROVISIONING` `[docs:apple-and-google-pay-notifications]`

```json
Within 7 days of provisioning commencing, but it still has not been completed.
Only triggered on first attempt of partial provisioning attempt

{
  "idempotencyKey": "a7052ab2-82d6-42a4-beff-9940d7d3121b",
  "emailAddress": "abc@xx.com.au",
  "type": "REMINDER",
  "customerDetails": {
    "customerHayId": "81926133-2621-48cc-9ad7-9940d7d3121b",
    "firstName": "Andyfirstname",
    "lastName": "Andylastname",
    "preferredName": "Andy"
  },
  "cardHayId": "d852865b-6f76-49d3-968f-9940d7d3121b",
  "reminderType": "GOOGLE_PAY_7_DAYS_PARTIAL_PROVISIONING"
}
```

#### REMINDER / wallet — `CARD_ADDED_TO_WALLET` `[docs:apple-and-google-pay-notifications]`

```json
Triggered immediately after card added to wallet

{  
  "customerHayId": "e818093c-4bd6-4dbc-b054-66318a55a587",  
  "idempotencyKey": "7ed153c1-e1f9-4305-a92c-0b30e1c56b20",  
  "type": "CARD_ADDED_TO_WALLET",  
  "cardAdditionToWalletEvent": {  
    "cardHayId": "b91826b8-78f2-4d36-bfb4-a4139cee591e",  
    "cardLastFourDigits": "7927",  
    "walletType": "APPLE_WALLET"  
  }  
}
```

#### REMINDER / wallet — `APPLE_PAY_SPEND_REMINDER_7_DAYS` `[docs:apple-and-google-pay-notifications]`

```json
Within the 7 days of provisioning Apple Pay, but no transactions have been made 
using Apple Pay. Awareness of being able to use contactless payments with Apple Pay.

{
  "customerHayId": "203d1dda-5665-440a-a757-186583ef5s23",
  "idempotencyKey": "bf3506c2-3781-44b8-8304-186583ef5s23",
  "type": "REMINDER",
  "reminderType": "APPLE_PAY_SPEND_REMINDER_7_DAYS"
}
```

#### REMINDER / wallet — `APPLE_PAY_SPEND_REMINDER_14_DAYS` `[docs:apple-and-google-pay-notifications]`

```json
Within the 14 days of provisioning Apple Pay, but no transactions have been made using Apple Pay.

{
  "customerHayId": "203d1dda-5665-440a-a757-bb823d92cs34",
  "idempotencyKey": "84f96abf-2ea5-4eea-bd63-186583ef5s23",
  "type": "REMINDER",
  "reminderType": "APPLE_PAY_SPEND_REMINDER_14_DAYS"
}
```

#### REMINDER / wallet — `GOOGLE_PAY_7_DAYS_SPEND_REMINDER` `[docs:apple-and-google-pay-notifications]`

```json
Within the 7 days of provisioning Google Pay, but no transactions have been made 
using Google Pay. Awareness of being able to use contactless payments with Google Pay.

{
  "idempotencyKey": "8b52b805-0524-4d75-98e3-9940d7d3121b",
  "emailAddress": "abc@xx.com.au",
  "type": "REMINDER",
  "customerDetails": {
    "customerHayId": "401f8748-fa16-4642-9a6f-9940d7d3121b",
    "firstName": "Andyfirstname",
    "lastName": "Andylastname",
    "preferredName": "Andy"
  },
  "cardHayId": "231f83c5-f77b-4e3d-8845-9940d7d3121b",
  "reminderType": "GOOGLE_PAY_7_DAYS_SPEND_REMINDER"
}
```

#### REMINDER / wallet — `GOOGLE_PAY_14_DAYS_SPEND_REMINDER` `[docs:apple-and-google-pay-notifications]`

```json
Within the 14 days of provisioning Google Pay, but no transactions have been made using Google Pay.

{
  "idempotencyKey": "c8884b45-bf2b-45bc-9ff5-9940d7d3121b",
  "emailAddress": "abc@xx.com.au",
  "type": "REMINDER",
  "customerDetails": {
    "customerHayId": "a6fefd05-c76f-4da8-81e5-9940d7d3121b",
    "firstName": "Andyfirstname",
    "lastName": "Andylastname",
    "preferredName": "Andy"
  },
  "cardHayId": "0000f60a-4cfa-451e-ae82-9940d7d3121b",
  "reminderType": "GOOGLE_PAY_14_DAYS_SPEND_REMINDER"
}
```

#### APPLE_PAY_REWARD_FOR_CUSTOMER — `APPLE_PAY_REWARD_FOR_CUSTOMER` `[docs:apple-reward-transactions]`

```json
{
  "customerHayId": "203d1dda-5665-440a-a757-102519fb0da8",
  "idempotencyKey": "bf3506c2-3781-44b8-8304-e1cc89e10ad2",
  "type": "APPLE_PAY_REWARD_FOR_CUSTOMER",
  "applePayRewardForCustomerEvent": {
    "accountId": "b91826b8-78f2-4d36-bfb4-a4139cee591e",
    "cardId": "bac20509-f094-470d-a65f-794b58e88f37"
  }
}
```
### 5.7 Event types with **no example anywhere** in spec or docs

The following have no sample payload in `notification-webhooks.json` (which has zero `example`/`examples` entries apart from `ValidityDto.unit`/`quantity` and `MandatePaymentEventDto.reasonCode: "AB01"`) nor on any fetched docs page: `CARD_STATUS_CHANGE`, `CUSTOMER_DETAILS_CHANGE`, `SCHEDULED_PAYMENT`, `MANDATE`, `MANDATE_DUE_PAYMENT`, `MANDATE_PAYMENT`, `MANDATE_ACTION_EXPIRATION`, `DELEGATED_OTP_NOTIFICATION`, the `CARD_EXPIRY_*` / `REMINDER_TO_*` reminders, and both v1 events `BATCH_COMPLETED`, `PERK_ORDER_UPDATE`.

The skeletons below are **[inferred]**: field names and enum values are verbatim from the spec DTOs (§2), the *values* are placeholders, and the choice of which envelope fields to populate follows the pattern of the real samples above. They are what the local mock should emit unless Shaype provides real samples.

```json CARD_STATUS_CHANGE [inferred skeleton]
{
  "customerHayId": "<uuid>",
  "idempotencyKey": "<uuid>",
  "type": "CARD_STATUS_CHANGE",
  "actionOwner": "CLIENT",
  "cardHayId": "<uuid>",
  "cardStatusChangeEvent": {
    "cardHayId": "<uuid>",
    "accountHayId": "<uuid>",
    "cardStatus": "BLOCKED",
    "cardLastFourDigits": "7927"
  }
}
```

```json CUSTOMER_DETAILS_CHANGE [inferred skeleton]
{
  "customerHayId": "<uuid>",
  "idempotencyKey": "<uuid>",
  "type": "CUSTOMER_DETAILS_CHANGE",
  "actionOwner": "CLIENT",
  "customerDetailsChangeEvent": {
    "phoneNumberChanged": false,
    "customerNameChanged": true,
    "emailAddressChanged": false,
    "addressChanged": false
  }
}
```

```json SCHEDULED_PAYMENT [inferred skeleton]
{
  "customerHayId": "<uuid>",
  "idempotencyKey": "<uuid>",
  "type": "SCHEDULED_PAYMENT",
  "scheduledPaymentEvent": { "hayId": "<uuid>" }
}
```

```json MANDATE [inferred skeleton — property name per spec is mandateEventDto; docs null-lists show mandateEvent, see §6 Q1]
{
  "customerHayId": "<uuid>",
  "idempotencyKey": "<uuid>",
  "type": "MANDATE",
  "mandateEventDto": {
    "mandateId": "<uuid>",
    "actionId": "<uuid>",
    "description": "Mandate create confirmed",
    "trigger": "MCRC"
  }
}
```

```json MANDATE_PAYMENT [inferred skeleton]
{
  "customerHayId": "<uuid>",
  "idempotencyKey": "<uuid>",
  "type": "MANDATE_PAYMENT",
  "mandatePaymentEventDto": {
    "instructionId": "<string>",
    "mandateId": "<uuid>",
    "paymentStatus": "MANDATE_PAYMENT_ACCEPTED",
    "reasonCode": null,
    "transactionHayId": "<uuid>",
    "isFinal": true,
    "originId": "<uuid>",
    "originType": "MANDATE_PAYMENT"
  }
}
```

```json MANDATE_DUE_PAYMENT [inferred skeleton]
{
  "customerHayId": "<uuid>",
  "idempotencyKey": "<uuid>",
  "type": "MANDATE_DUE_PAYMENT",
  "mandateDuePaymentEventDto": {
    "mandateId": "<uuid>",
    "notificationId": "<uuid>",
    "paymentDateTimeUtc": "2026-09-24T00:00:00Z"
  }
}
```

```json MANDATE_ACTION_EXPIRATION [inferred skeleton]
{
  "customerHayId": "<uuid>",
  "idempotencyKey": "<uuid>",
  "type": "MANDATE_ACTION_EXPIRATION",
  "mandateActionExpirationEvent": {
    "mandateId": "<uuid>",
    "actionId": "<uuid>",
    "resolutionRequestedByDateTimeUtc": "2026-09-30T00:00:00Z"
  }
}
```

```json DELEGATED_OTP_NOTIFICATION [inferred skeleton]
{
  "customerHayId": "<uuid>",
  "idempotencyKey": "<uuid>",
  "type": "DELEGATED_OTP_NOTIFICATION",
  "cardHayId": "<uuid>",
  "delegatedOtpNotificationEvent": {
    "cardId": "<uuid>",
    "accountId": "<uuid>",
    "merchantInfo": {
      "acquirerId": "<string>", "merchantId": "<string>", "merchantName": "<string>", "merchantUrl": "<string>",
      "merchantCategoryCode": "<string>", "merchantCountryCode": "<string>", "merchantAppRedirectUrl": "<string>"
    },
    "transactionInfo": {
      "transactionTimeStamp": "<string>", "transactionAmount": 1234, "transactionCurrency": "AUD", "transactionExponent": 2
    },
    "passcode": "123456"
  }
}
```

```json REMINDER (card expiry) [inferred skeleton]
{
  "customerHayId": "<uuid>",
  "idempotencyKey": "<uuid>",
  "type": "REMINDER",
  "cardHayId": "<uuid>",
  "reminderType": "CARD_EXPIRY_2_WEEK_REMINDER",
  "cardExpiryReminderEvent": { "cardId": "<uuid>", "expirationMonth": 10, "expirationYear": 2026 }
}
```

```json BATCH_COMPLETED (v1, POST /api/hay/v1/communications/notification) [inferred skeleton]
{
  "idempotencyKey": "<uuid>",
  "type": "BATCH_COMPLETED",
  "createdTimeUtc": "2026-09-24T01:02:03Z",
  "actionOwner": "PLATFORM",
  "eventDetails": {
    "eventType": "BATCH_COMPLETED",
    "batchId": "<uuid>",
    "batchType": "ACCOUNT_TRANSFER",
    "receivedAtUtc": "2026-09-24T01:00:00Z",
    "finishedAtUtc": "2026-09-24T01:02:03Z",
    "status": "COMPLETED",
    "itemStatistics": { "pending": 0, "success": 8, "error": 1, "failed": 1 }
  }
}
```

```json PERK_ORDER_UPDATE (v1) [inferred skeleton]
{
  "idempotencyKey": "<uuid>",
  "type": "PERK_ORDER_UPDATE",
  "createdTimeUtc": "2026-09-24T01:02:03Z",
  "actionOwner": "PLATFORM",
  "eventDetails": {
    "eventType": "PERK_ORDER_UPDATE",
    "orderExternalId": "<uuid>",
    "status": "COMPLETED",
    "pinCode": "<string>",
    "pinSerial": "<string>",
    "confirmedTimeUtc": "2026-09-24T01:02:03Z",
    "redemption": { "usageInfo": ["<string>"], "terms": "<markdown>", "validity": { "unit": "DAY", "quantity": 365 } }
  }
}
```

(`batchType: "ACCOUNT_TRANSFER"` is the only batch type named in `[docs:batch-api]`; the spec leaves `batchType` as a free string.)

---

## 6. Open questions (things the sources do not settle)

| # | question | evidence | impact on local mock |
|---|---|---|---|
| Q1 | **Property names for the three mandate payloads**: spec says `mandateEventDto`, `mandateDuePaymentEventDto`, `mandatePaymentEventDto`; every real v0 sample's null-list shows `mandateEvent`, `mandateDuePaymentEvent`, `mandatePaymentEvent` `[docs:card-transactions]` `[docs:payments]`. Which key does production actually send? | spec vs 7 docs samples | Emit the spec names by default; make it switchable; SUT parsers should accept both. |
| Q2 | **Blocked account status value**: `AccountStatusChangeEventDto.accountStatus` enum has `BLOCKED` (and `DORMANT`, `PENDING_APPROVAL`) but no `LOCKED`; B2B `HayAccount.status` and `[docs:account-status]` use `LOCKED` (no `BLOCKED`). What does `blockAccount` actually emit? | spec vs spec:b2b vs docs | Pick `BLOCKED` for the webhook (spec) while the account resource reports `LOCKED`; flag in tests. |
| Q3 | `ONBOARDING_FAILED` sample uses `isSubmissionFailure`; spec property is `submissionFailure` (boolean, no description). Which is real? What does it mean? | [docs:customer-creation-1] vs spec | Emit `submissionFailure`; note both. |
| Q4 | Undocumented fields in samples: `relatedHoldHayId` (null) and `accountBalances.legacyAvailableBalance` `[docs:payments]`; envelope `productId` present in most but not all TRANSACTION samples. Are they part of the contract? | docs samples only | Do not rely on them; optionally emit `productId`. |
| Q5 | Which endpoint receives the Apple/Google **reminder** notifications? Half the samples are `EmailDto`-shaped (`emailAddress`, `customerDetails`), half `NotificationDto`-shaped; the page never names the endpoint. | [docs:apple-and-google-pay-notifications] | Deliver the `NotificationDto`-shaped ones to `/notification`; treat `EmailDto`-shaped ones as `/email` traffic (Accelerator only). |
| Q6 | **Authentication of webhook calls**: no scheme in spec; docs say it is arranged with the Client Integration Team; retry on 401/403 implies *some* credential is sent. Is it the `Shaype-Signature`/`Shaype-Key-Id`/`Shaype-Timestamp` header set from the external-authorisation API, a static bearer/basic header, mTLS, or IP allow-listing? | [spec] [docs:webhook-notification] [spec:ext-auth] | Make headers configurable (none by default; optional static header; optional HMAC with the ext-auth header names). |
| Q7 | `[docs:payments]` INTRABANK_TRANSFER_OUT section: its two samples carry `"transactionType": "INTERBANK_TRANSFER_OUT"` and a BSB counterpart (the "Original"/"Return" pair) — copy-paste error, or does an internal transfer to another Shaype account really surface as INTERBANK? Also: does the internal sender get `INTRABANK_TRANSFER_OUT` and the recipient `INTRABANK_TRANSFER_IN` (implied by "both the sender and receiver will receive a webhook")? | docs inconsistency | Emit `INTRABANK_TRANSFER_OUT`/`_IN` for Shaype-to-Shaype; `INTERBANK_*` for external. |
| Q8 | Where do Visa OCT (original credit) events land — `transactionType: ORIGINAL_CREDIT` (spec enum) or `CARD_TRANSACTION_REFUND` (ext-auth docs list "OCT" under refund)? | [spec] vs [docs:external-authorisation-and-balance] | Low priority; default to `CARD_TRANSACTION_REFUND`, `isPending:false`. |
| Q9 | For a declined card authorisation: is a `TRANSACTION` webhook always emitted (with `outcome` ≠ `ACCEPTED`), and how do the staging `declineReason` values map to `outcome` / `cardProcessorResponse` / `cardPreferenceOutcome`? `[docs:accounts-overview]` confirms a webhook for `REFUSED_RULES`; `[docs:card-transactions]` says the outcome is sent "along with" transaction details. | partial | Emit on decline too, `isPending:false`, `updatedBalance` unchanged `[inferred]`. |
| Q10 | Exact exponential-backoff schedule for the 18 retries / 48h, and what happens after exhaustion (dead-letter, manual replay, alert)? | [docs:webhook-notification] gives only totals | Mock: configurable retry (default e.g. 18 attempts, capped backoff) + a dead-letter list inspectable by tests. |
| Q11 | Is there a client-response **timeout** for webhook delivery? (Ext-auth says "strict synchronous response timeout" without a value; nothing for webhooks.) | none | Mock: configurable, default 10 s. |
| Q12 | **Ordering / concurrency**: any per-customer or per-account ordering guarantee? Are hold and settlement guaranteed in order? | none | Mock: sequential per-destination queue; tests must tolerate reordering. |
| Q13 | Does `ACCOUNT_STATUS_CHANGE` fire for every transition listed in `[docs:account-status]` (incl. `APPROVED → ACTIVE` on first transaction and `ACTIVE ↔ ACTIVE_IN_ARREARS`), and does `CARD_STATUS_CHANGE` fire for every card op (activate/block/unblock/cancel/reissue/renew/convert/create)? Only `closeAccount → Card Status Change` and the `createAccount → APPROVED` sample are documented. | [docs:account-closure] [docs:customer-creation-1] | Mock: fire on every transition (superset); document it. |
| Q14 | Who receives `CUSTOMER_STATUS_UPDATED` when onboarding resolves (`PENDING_APPROVAL → ACTIVE/REFERRED/REJECTED`) — is it emitted in addition to `ONBOARDING_PASSED`/`ONBOARDING_FAILED`? | none | Mock: emit both `[inferred]`. |
| Q15 | `MANDATE_DUE_PAYMENT`, `MANDATE_ACTION_EXPIRATION`, `DELEGATED_OTP_NOTIFICATION`, `SCHEDULED_PAYMENT`, `PERK_ORDER_UPDATE`, `REMINDER_TO_*`, `APPLE_PAY_*_REWARD` reminder types, `HAY_TOP_UP`, `REWARD`, `CONVERSION_IN/OUT`: spec-only, no docs, no samples — semantics and triggers unknown. | [spec] | Implement from spec shapes; mark as low-confidence in the mock's docs. |
| Q16 | `NotificationDtoV1.type` description lists only `BATCH_COMPLETED` while the enum also has `PERK_ORDER_UPDATE`; `createdTimeUtc` is described as "Resolution requested by date and time" (copy-paste from the mandate DTO?). Is `createdTimeUtc` the emission time? | [spec] | Treat as emission time `[inferred]`. |
| Q17 | Are the "compact" (nulls omitted) and "full" (all keys, nulls explicit) serialisations both current, or is the compact form from an older platform version? | docs samples of different vintages | SUT must accept both; mock emits compact by default. |
| Q18 | `CurrencyAmount.amount` is documented as "to 2 decimal places" but samples show `0.5000` and integer `5066` — is the wire type always a JSON number? Any big-decimal string variant? | [spec] vs samples | Emit JSON numbers with 2 dp. |
| Q19 | Reminder scheduling for `REMINDER` events and the Apple reward: are these enabled per client (docs say the reward is "client configurable")? Are reminders also delivered on `/notification` for non-Accelerator clients? | [docs:apple-reward-transactions] | Mock: feature-flag reminders/rewards off by default. |

---

## Appendix A — `CurrencyAmount.currency` enum (162 values, verbatim) `[spec]`

`jq -c '.components.schemas.CurrencyAmount.properties.currency.enum' notification-webhooks.json`:

```
["AED","AFN","ALL","AMD","ANG","AOA","ARS","AUD","AWG","AZN","BAM","BBD","BDT","BGN","BHD","BIF","BMD","BND","BOB","BOV","BRL","BSD","BTN","BWP","BYN","BZD","CAD","CDF","CHF","CLP","CNH","CNY","COP","CRC","CUC","CUP","CVE","CZK","DJF","DKK","DOP","DZD","EGP","ERN","ETB","EUR","FJD","FKP","GBP","GEL","GHS","GIP","GMD","GNF","GTQ","GYD","HKD","HNL","HRK","HTG","HUF","IDR","ILS","INR","IQD","IRR","ISK","JMD","JOD","JPY","KES","KGS","KHR","KMF","KPW","KRW","KWD","KYD","KZT","LAK","LBP","LKR","LRD","LSL","LYD","MAD","MDL","MGA","MKD","MMK","MNT","MOP","MRU","MUR","MVR","MWK","MXN","MYR","MZN","NAD","NGN","NIO","NOK","NPR","NZD","OMR","PAB","PEN","PGK","PHP","PKR","PLN","PYG","QAR","RON","RSD","RUB","RWF","SAR","SBD","SCR","SDG","SEK","SGD","SHP","SLE","SLL","SOS","SRD","SSP","STN","SVC","SYP","SZL","THB","TJS","TMT","TND","TOP","TRY","TTD","TWD","TZS","UAH","UGX","USD","UYU","UZS","VES","VND","VUV","WST","XAF","XCD","XCG","XOF","XPF","YER","ZAR","ZMW","ZWG","ZWL"]
```

## Appendix B — jq one-liners used for this map

```
J=notification-webhooks.json
jq -r '.components.schemas | keys[]' $J                                   # 45 schemas
jq -c '.paths | to_entries[] | {path:.key, op:.value.post.operationId}' $J
jq '.components.schemas.NotificationDto.properties.type.enum' $J          # 17 event types
jq '.components.schemas.NotificationDtoV1.properties.type.enum' $J        # 2 event types
jq '.components.schemas.NotificationDto.properties.reminderType.enum' $J  # 19 reminder types
jq '.components.schemas.TransactionEventDto.properties.transactionType.enum' $J   # 17
jq '.components.schemas.TransactionEventDto.properties.outcome.enum' $J           # 41
jq '.components.schemas.TransactionEventDto.properties.cardProcessorResponse.enum' $J  # 57
jq '.components.schemas.TransactionEventDto.properties.cardPreferenceOutcome.enum' $J  # 9
jq '.components.schemas.MandateEventDto.properties.trigger.enum' $J       # 32 MMS triggers
jq '.components.schemas.MandatePaymentEventDto.properties.paymentStatus.enum' $J  # 9
jq '.components.schemas.DirectEntryEventDto.properties.status.enum' $J    # 7
jq '.components.schemas.SmsDto.properties.type.enum, .components.schemas.EmailDto.properties.type.enum' $J
jq '.components.securitySchemes, .security' $J                            # null null
jq '[.. | objects | select(has("example") or has("examples"))] | length' $J   # 3 (no payload examples)
```
