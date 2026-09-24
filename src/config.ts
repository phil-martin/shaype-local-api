import { parseArgs } from 'node:util'

export interface Config {
  port: number
  host: string
  /** ':memory:' or a file path */
  db: string
  /** Base URL of the system under test; notifications are POSTed to <webhookUrl>/api/hay/v{0,1}/communications/notification */
  webhookUrl: string | null
  clientId: string
  clientSecret: string
  /** When false, /v0 and /v1 routes accept requests without a bearer token. */
  auth: boolean
  logLevel: string
  tokenTtlSeconds: number
  webhookMaxAttempts: number
  /** First retry delay; doubles on each attempt. */
  webhookBackoffMs: number
  /** Milliseconds of simulated processing before async events (card settlement etc.) fire. 0 = immediate. */
  asyncDelayMs: number
  /** Risk level given to new accounts. Shaype defaults to HIGH (all limits 0) until the client sets LOW. */
  defaultRiskLevel: 'HIGH' | 'LOW'
  /**
   * Emit CUSTOMER_STATUS_UPDATED {INACTIVE} when the platform closes a customer (last account closed, group
   * removal). Off by default: docs:account-closure lists only the account and card events for that cascade and
   * says the customer's future notifications are cancelled. Client-driven INACTIVE always emits.
   */
  emitCustomerInactive: boolean
  /**
   * Validate every JSON response of a /v0 or /v1 route against the operation's response schema for its
   * status code; a mismatch is logged and answered as a 500 ErrorResponse (src/contract/validate-responses.ts).
   * Off by default; the test helpers turn it on.
   */
  validateResponses: boolean
}

export const defaultConfig: Config = {
  port: 8080,
  host: '127.0.0.1',
  db: ':memory:',
  webhookUrl: null,
  clientId: 'local-client',
  clientSecret: 'local-secret',
  auth: true,
  logLevel: 'info',
  tokenTtlSeconds: 3600,
  webhookMaxAttempts: 5,
  webhookBackoffMs: 200,
  asyncDelayMs: 0,
  defaultRiskLevel: 'HIGH',
  emitCustomerInactive: false,
  validateResponses: false,
}

export const CLI_OPTIONS = {
  port: { type: 'string', short: 'p' },
  host: { type: 'string' },
  db: { type: 'string' },
  'webhook-url': { type: 'string', short: 'w' },
  'client-id': { type: 'string' },
  'client-secret': { type: 'string' },
  'no-auth': { type: 'boolean' },
  'log-level': { type: 'string' },
  'webhook-max-attempts': { type: 'string' },
  'webhook-backoff-ms': { type: 'string' },
  'async-delay-ms': { type: 'string' },
  'default-risk-level': { type: 'string' },
  'emit-customer-inactive': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

export const HELP = `shaype-local — local re-implementation of the Shaype B2B Operations API

Usage: shaype-local [options]

  -p, --port <n>               listen port                     (SHAYPE_LOCAL_PORT, default 8080)
      --host <host>            bind address                    (SHAYPE_LOCAL_HOST, default 127.0.0.1)
      --db <path|:memory:>     sqlite database                 (SHAYPE_LOCAL_DB, default :memory:)
  -w, --webhook-url <url>      base URL to POST notifications  (SHAYPE_LOCAL_WEBHOOK_URL)
      --client-id <id>         accepted client_id              (SHAYPE_LOCAL_CLIENT_ID, default local-client)
      --client-secret <s>      accepted client_secret          (SHAYPE_LOCAL_CLIENT_SECRET, default local-secret)
      --no-auth                do not require a bearer token   (SHAYPE_LOCAL_AUTH=false)
      --log-level <level>      pino level                      (SHAYPE_LOCAL_LOG_LEVEL, default info)
      --webhook-max-attempts   delivery attempts before giving up (default 5)
      --webhook-backoff-ms     first retry delay, doubling      (default 200)
      --async-delay-ms         delay for simulated async events (default 0)
      --default-risk-level     HIGH|LOW for new accounts       (SHAYPE_LOCAL_DEFAULT_RISK_LEVEL, default HIGH — Shaype's default; HIGH refuses all money movement until set LOW)
      --emit-customer-inactive send CUSTOMER_STATUS_UPDATED {INACTIVE} for the platform closure cascade (SHAYPE_LOCAL_EMIT_CUSTOMER_INACTIVE, default off)
  -h, --help
`

export function loadConfig(argv: string[] = [], env: NodeJS.ProcessEnv = {}): Config & { help: boolean } {
  const { values } = parseArgs({ args: argv, options: CLI_OPTIONS, strict: true })
  const str = (flag: keyof typeof values, envKey: string, fallback: string): string => {
    const v = values[flag]
    if (typeof v === 'string') return v
    return env[envKey] ?? fallback
  }
  const num = (flag: keyof typeof values, envKey: string, fallback: number): number => {
    const n = Number(str(flag, envKey, String(fallback)))
    if (!Number.isFinite(n)) throw new Error(`Invalid number for --${String(flag)}`)
    return n
  }
  const authEnv = env.SHAYPE_LOCAL_AUTH
  const envTrue = (v: string | undefined): boolean => v !== undefined && ['true', '1', 'yes', 'on'].includes(v.toLowerCase())
  return {
    port: num('port', 'SHAYPE_LOCAL_PORT', defaultConfig.port),
    host: str('host', 'SHAYPE_LOCAL_HOST', defaultConfig.host),
    db: str('db', 'SHAYPE_LOCAL_DB', defaultConfig.db),
    webhookUrl: str('webhook-url', 'SHAYPE_LOCAL_WEBHOOK_URL', '') || null,
    clientId: str('client-id', 'SHAYPE_LOCAL_CLIENT_ID', defaultConfig.clientId),
    clientSecret: str('client-secret', 'SHAYPE_LOCAL_CLIENT_SECRET', defaultConfig.clientSecret),
    auth: values['no-auth'] ? false : authEnv === undefined ? true : !['false', '0', 'no', 'off'].includes(authEnv.toLowerCase()),
    logLevel: str('log-level', 'SHAYPE_LOCAL_LOG_LEVEL', defaultConfig.logLevel),
    tokenTtlSeconds: defaultConfig.tokenTtlSeconds,
    webhookMaxAttempts: num('webhook-max-attempts', 'SHAYPE_LOCAL_WEBHOOK_MAX_ATTEMPTS', defaultConfig.webhookMaxAttempts),
    webhookBackoffMs: num('webhook-backoff-ms', 'SHAYPE_LOCAL_WEBHOOK_BACKOFF_MS', defaultConfig.webhookBackoffMs),
    asyncDelayMs: num('async-delay-ms', 'SHAYPE_LOCAL_ASYNC_DELAY_MS', defaultConfig.asyncDelayMs),
    defaultRiskLevel: riskLevel(str('default-risk-level', 'SHAYPE_LOCAL_DEFAULT_RISK_LEVEL', defaultConfig.defaultRiskLevel)),
    emitCustomerInactive: values['emit-customer-inactive'] === true || envTrue(env.SHAYPE_LOCAL_EMIT_CUSTOMER_INACTIVE),
    validateResponses: defaultConfig.validateResponses,
    help: values.help === true,
  }
}

function riskLevel(v: string): 'HIGH' | 'LOW' {
  const u = v.toUpperCase()
  if (u !== 'HIGH' && u !== 'LOW') throw new Error(`--default-risk-level must be HIGH or LOW, got ${v}`)
  return u
}
