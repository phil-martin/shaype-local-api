# Testing your integration against shaype-local

How to run end-to-end tests of an application that integrates with Shaype against this server, from the application's own repository: start the server once per test run, point the application at it, assert the webhooks it sends, and steer asynchronous outcomes with the virtual clock. The README covers the server itself (flags, admin API, test-steering conventions); everything below was run against the packed CLI with Vitest 5 and Jest 30.

## 1. Get the CLI into your repository

The package's `bin` is `shaype-local` (`dist/cli.js`). Build and pack it from a checkout, then install the tarball as a dev dependency:

```sh
# in the shaype-local-api checkout
npm install && npm run build && npm pack          # -> shaype-local-api-0.1.0.tgz

# in your repository
npm install -D ../shaype-local-api/shaype-local-api-0.1.0.tgz
npx shaype-local --help
```

Without packing, `node <checkout>/dist/cli.js` (after `npm run build`) or `npx tsx <checkout>/src/cli.ts` start the same server.

## 2. Start it once per test run

### Vitest

A small module shared by the setup and the tests says where the server is and wraps the calls:

```ts
// test/shaype.ts
export const SHAYPE_PORT = 8090
export const SHAYPE_URL = `http://127.0.0.1:${SHAYPE_PORT}`

export async function shaype(method: string, path: string, body?: unknown, token?: string): Promise<any> {
  const res = await fetch(`${SHAYPE_URL}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`)
  return text ? JSON.parse(text) : undefined
}

export async function token(): Promise<string> {
  const res = await fetch(`${SHAYPE_URL}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'local-client', client_secret: 'local-secret' }),
  })
  return ((await res.json()) as { access_token: string }).access_token
}

/** Waits for asynchronous platform work and webhook deliveries, then returns the stored notifications. */
export async function notifications(query = ''): Promise<any[]> {
  await shaype('POST', '/_admin/flush')
  return shaype('GET', `/_admin/notifications${query ? `?${query}` : ''}`)
}
```

The global setup spawns `npx shaype-local`, waits for `/_admin/health` and stops it afterwards:

```ts
// test/global-setup.ts
import { spawn, type ChildProcess } from 'node:child_process'
import { SHAYPE_PORT, SHAYPE_URL } from './shaype.js'

let server: ChildProcess | undefined

export async function setup(): Promise<void> {
  const args = ['shaype-local', '--port', String(SHAYPE_PORT), '--log-level', 'warn']
  // where your application receives Shaype webhooks (it must be running during the tests)
  if (process.env.APP_URL) args.push('--webhook-url', process.env.APP_URL)
  server = spawn('npx', args, { stdio: 'inherit', detached: true })
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      if ((await fetch(`${SHAYPE_URL}/_admin/health`)).ok) return
    } catch { /* not listening yet */ }
    if (server.exitCode !== null) throw new Error(`shaype-local exited with code ${server.exitCode}`)
    if (Date.now() > deadline) throw new Error('shaype-local did not become healthy in 30 s')
    await new Promise((r) => setTimeout(r, 100))
  }
}

export async function teardown(): Promise<void> {
  // npx runs the CLI in a child process: signal the whole process group (detached: true made it one).
  if (server?.pid) process.kill(-server.pid, 'SIGTERM')
}
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false, // one shared server: test files take turns
  },
})
```

A test then resets the server, logs in and drives the API:

```ts
// test/onboarding.test.ts
import { randomUUID } from 'node:crypto'
import { beforeEach, expect, it } from 'vitest'
import { notifications, shaype, token } from './shaype.js'

let auth: string
beforeEach(async () => {
  await shaype('POST', '/_admin/reset')
  auth = await token()
})

it('onboards a customer and notifies the application', async () => {
  const customer = await shaype('POST', '/v0/customers/create', {
    idempotencyKey: randomUUID(), email: 'jane@example.com', customerTier: 'STANDARD',
    phoneNumber: { countryCodePrefix: '+61', numberAfterPrefix: '412345678' },
    address: { line1: '395 Bourke St', townOrCity: 'Melbourne', administrativeRegion: 'VIC', postcode: '3000', countryCodeIso: 'AUS' },
    customerDetails: { firstName: 'Jane', lastName: 'Citizen', dateOfBirth: '1990-01-01' },
  }, auth)
  const sent = await notifications('type=CUSTOMER_STATUS_UPDATED')
  expect(sent.map((n) => [n.payload.customerHayId, n.payload.customerStatusUpdatedEvent.customerStatus])).toEqual([[customer.customerHayId, 'ACTIVE']])
})
```

### Jest

Jest's `globalSetup` and `globalTeardown` run in the same process, so the child process can be kept on `globalThis`; environment variables set in the setup reach the test workers.

```js
// jest/global-setup.cjs
const { spawn } = require('node:child_process')

const PORT = 8091
const URL = `http://127.0.0.1:${PORT}`

module.exports = async function globalSetup() {
  const args = ['shaype-local', '--port', String(PORT), '--log-level', 'warn', '--default-risk-level', 'LOW']
  if (process.env.APP_URL) args.push('--webhook-url', process.env.APP_URL)
  const server = spawn('npx', args, { stdio: 'inherit', detached: true })
  globalThis.__SHAYPE_SERVER__ = server
  process.env.SHAYPE_URL = URL
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      if ((await fetch(`${URL}/_admin/health`)).ok) return
    } catch { /* not listening yet */ }
    if (server.exitCode !== null) throw new Error(`shaype-local exited with code ${server.exitCode}`)
    if (Date.now() > deadline) throw new Error('shaype-local did not become healthy in 30 s')
    await new Promise((r) => setTimeout(r, 100))
  }
}
```

```js
// jest/global-teardown.cjs
module.exports = async function globalTeardown() {
  const server = globalThis.__SHAYPE_SERVER__
  if (server?.pid) process.kill(-server.pid, 'SIGTERM')
}
```

```js
// jest.config.cjs
module.exports = {
  globalSetup: './jest/global-setup.cjs',
  globalTeardown: './jest/global-teardown.cjs',
  maxWorkers: 1, // one shared server: test files take turns
}
```

### Point your application at it

Configure the application under test the way you configure it for Shaype staging: API base URL `http://127.0.0.1:8090`, token URL `http://127.0.0.1:8090/oauth2/token`, client `local-client` / `local-secret` (or whatever you pass with `--client-id` / `--client-secret`). Start the server with `--webhook-url` set to the application's base URL; notifications arrive at `<base>/api/hay/v0/communications/notification`.

### Isolation

- `POST /_admin/reset` in `beforeEach` gives every test an empty server: entities, notifications, pending asynchronous work and the clock are all reset. Tokens stay valid.
- Test files that share one server must not run at the same time if they reset it (`fileParallelism: false`, `maxWorkers: 1`). The alternative is to never reset and make every test's data unique: customers must differ in email, phone number, identity document and name + date of birth, or creation answers `422 DUPLICATE_CUSTOMER`.
- A server per test file is possible too (a different `--port` each), at a second or two of start-up each.

## 3. Assert webhooks

Every notification the server produces is stored, whether or not it was delivered, so there are two places to look.

**What was sent** — `GET /_admin/notifications` after `POST /_admin/flush`. Filter with `type`, `status` (`queued`, `delivered`, `failed`, `stored`), `sinceSeq`, `limit` (default 1000) and `order` (`asc`, the default: oldest first; `desc`: newest first). To assert only what one action produced, remember the last `seq` before it. Ask for the newest row: the default listing is the oldest 1000, so on a server that is never reset its last row is not the latest one.

```ts
const [last] = await shaype('GET', '/_admin/notifications?order=desc&limit=1')
const before = last?.seq ?? 0
await shaype('POST', `/v1/accounts/${accountId}/transfer`, transfer, auth)
const produced = await notifications(`sinceSeq=${before}`)
// both accounts already ACTIVE (a first posting would add ACCOUNT_STATUS_CHANGE {ACTIVE})
expect(produced.map((n) => [n.type, n.payload.transactionEvent?.transactionType])).toEqual([
  ['TRANSACTION', 'INTRABANK_TRANSFER_OUT'],
  ['TRANSACTION', 'INTRABANK_TRANSFER_IN'],
])
```

Each row carries the delivery record next to the payload: `{ id, version, type, payload, status, attempts, lastStatus, lastError, createdAt, nextAttemptAt, deliveredAt, seq }`. Notifications are addressed to one customer each (`payload.customerHayId`); a joint account notifies every member.

**What your application did with it** — start the server with `--webhook-url` pointing at the application and assert the application's own state after `POST /_admin/flush` (which also waits for deliveries and their retries).

Useful checks on the application side:

- **Retries and idempotency.** Make the webhook endpoint answer `500` (or not answer within `--webhook-timeout-ms`, default 10 s) and watch `attempts` and `status` on `/_admin/notifications/:id`: `401`, `403`, `429`, `5xx`, network errors and timeouts are retried with doubling backoff in real time (`--webhook-backoff-ms`, `--webhook-max-attempts`), also while the virtual clock is frozen; any other non-2xx status is final. `POST /_admin/notifications/:id/redeliver` sends the same payload (same `idempotencyKey`) again, which is how to test duplicate handling.
- **Payload shape.** The package ships `spec/notification-webhooks.json`; validate received payloads against its `NotificationDto` schema if your application parses them strictly.

Two things to know:

- Without `--webhook-url` notifications are only stored (`status: "stored"`) and `flush` returns at once. With a URL nobody listens on, `flush` waits until every retry has failed (about 3 s with the defaults), so leave the flag out when you only read `/_admin/notifications`.
- To test a receiver in-process instead (as `test/scenario.test.ts` in this repository does), start the server on the same machine with `--webhook-url` set to the receiver's fixed port.

## 4. Steer asynchronous outcomes with the clock

Some of Shaype's effects are asynchronous: the onboarding outcome, the account-closure cascade, direct-debit progress, PayTo payment progress and card settlement. Locally they run `--async-delay-ms` after the call that caused them (default `0`: right away), so with the defaults `POST /_admin/flush` is all a test needs.

To observe the intermediate states, give the server a long delay, e.g. `--async-delay-ms 3600000`: nothing asynchronous happens until the test moves the virtual clock. `POST /_admin/clock` runs whatever became due before it answers, and `POST /_admin/notifications/flush` waits for the resulting webhooks:

```ts
// server started with --async-delay-ms 3600000; `customer` and `directDebit` are ordinary request bodies
/** One hour on: due effects run, their webhooks are delivered, and a fresh token replaces the expired one. */
const step = async () => {
  await shaype('POST', '/_admin/clock', { advanceMs: 3_600_000 })
  await shaype('POST', '/_admin/notifications/flush')
  auth = await token() // tokens expire on the same clock
}

const created = await shaype('POST', '/v0/customers/create', customer, auth)
expect(created.status).toBe('PENDING_APPROVAL')
await step()                                                          // onboarding outcome
expect((await shaype('GET', `/v0/customers/${created.customerHayId}`, undefined, auth)).status).toBe('ACTIVE')

const account = await shaype('POST', '/v1/accounts', {
  idempotencyKey: randomUUID(), accountHolderId: created.customerHayId, accountHolderType: 'CUSTOMER', productId: 'a1b2c3d4-0000-4000-8000-000000000001',
}, auth)
// New accounts have risk level HIGH, which refuses every movement: the collected funds would be refused and the
// direct debit would end INCOMPLETE. Set LOW here, or start the server with --default-risk-level LOW.
await shaype('PATCH', `/v0/accounts/${account.accountHayId}/riskLevel`, { level: 'LOW', reason: 'KYC complete' }, auth)

await shaype('POST', '/v1/direct-debits', { ...directDebit, transactionId, senderBsb: account.bsb, senderAccountNumber: account.accountNumber }, auth)
const status = async () => (await shaype('GET', `/v1/direct-entry/${transactionId}/status`, undefined, auth)).status
expect(await status()).toBe('ACCEPTED')
await step()
expect(await status()).toBe('SUBMITTED')
await step()
expect(await status()).toBe('COMPLETE')
// DIRECT_ENTRY webhooks: RECEIVED, ACCEPTED, SUBMITTED, COMPLETE; the credit arrives as TRANSACTION / DIRECT_DEBIT_TRANSFER
```

Rules of thumb:

- In this mode do not call `POST /_admin/flush` while an effect is pending: it waits in real time and answers `500` after 10 s. Use `/_admin/notifications/flush` after moving the clock.
- Tokens live 3600 s on the virtual clock: fetch a new one after moving it by an hour or more.
- `{ "set": "<ISO date-time>" }` jumps to an instant and keeps ticking; `{ "freeze": "<ISO date-time>" }` pins the clock so timestamps in responses and webhooks are predictable; `{ "reset": true }` (or `/_admin/reset`) returns to real time.
- Time-driven jobs run whenever the clock moves and on every API request. For example a card issued in September 2026 expires on 2030-09-30: `{ "set": "2030-09-01T00:00:00Z" }` produces a `REMINDER` notification (`reminderType: CARD_EXPIRY_MONTH_REMINDER`), and `{ "set": "2030-10-01T00:00:00Z" }` turns the card `EXPIRED` (`CARD_STATUS_CHANGE`, `actionOwner: PLATFORM`). Scheduled payments created with `POST /_admin/scheduled-payments` run on their dates the same way, as do the PayID and PayTo timers.
- Daily limits are rolling 24-hour windows on the clock: move it a day forward to lift a daily cap.
- The card-purchase mock (`POST /v0/utils/generate-card-transaction`) authorises the hold at once and settles it `settlementDelayInSeconds` later on the virtual clock. It is provided by the Utilities API: check that `GET /_admin/operations` lists `generateCardTransaction` under `handled` rather than `stubbed`.

The other outcomes are steered by data rather than time (email tags `+referred`, `+rejected`, `+pending`; BSB `999999`; biller code `000000`; `declineReason` on the card mocks; `paymentstatus:` hints for PayTo); the README's test-steering table lists them.
