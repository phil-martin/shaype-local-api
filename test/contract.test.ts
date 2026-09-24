import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { operations } from '../src/contract/index.js'
import { startApp } from './helpers.js'
import type { BuiltServer } from '../src/server.js'

let built: BuiltServer
beforeAll(async () => { built = await startApp() })
afterAll(async () => { await built.app.close() })

describe('contract coverage', () => {
  it('registers a route for every operation in the spec', () => {
    expect(operations.length).toBe(169)
    expect(built.ctx.handled.size).toBe(169)
    for (const op of operations) expect(built.ctx.handled.has(op.operationId)).toBe(true)
  })

  it('answers every GET operation that has no required query params with its success status', async () => {
    const gets = operations.filter((o) => o.method === 'GET' && !(o.querystring as { required?: string[] } | null)?.required?.length)
    expect(gets.length).toBeGreaterThan(30)
    for (const op of gets) {
      const url = op.url.replace(/:(\w+)/g, (_, p: string) => sampleParam(op, p))
      const res = await built.app.inject({ method: 'GET', url })
      // Implemented domains answer 404 for the sample id (unknown entity); stubs always answer the success status.
      const acceptable = built.stubbed.includes(op.operationId) ? [op.successStatus] : [op.successStatus, 404]
      expect(acceptable, `${op.operationId} ${url} -> ${res.statusCode} ${res.body}`).toContain(res.statusCode)
    }
  })

  it('builds the server without any Fastify deprecation warning on stderr', () => {
    const script = "const m = await import('./src/server.ts'); const b = await m.buildServer({ logLevel: 'silent' }); await b.app.ready(); await b.app.close()"
    const out = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 })
    expect(out.status, out.stderr).toBe(0)
    expect(out.stderr).not.toMatch(/FSTDEP|DeprecationWarning|FastifyWarning/)
  })

  it('router-level URL errors (malformed percent-escape, over-long path parameter) answer a 400 ErrorResponse', async () => {
    for (const url of ['/v0/accounts/%ZZ', `/v0/accounts/${'a'.repeat(600)}`, '/v0/payids/%E0%A4%A/resolve?payIdType=EMAIL', `/v1/payto/mandates/${'b'.repeat(700)}`]) {
      const res = await built.app.inject({ method: 'GET', url })
      expect(res.statusCode, `${url.slice(0, 40)} ${res.body}`).toBe(400)
      const body = res.json()
      expect(Object.keys(body).sort()).toEqual(['details', 'message', 'status', 'traceId'])
      expect(body).toMatchObject({ status: '400', message: expect.stringMatching(/^BAD_REQUEST: /) })
    }
  })

  it('returns the ErrorResponse envelope for unknown routes', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/v9/nothing' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ status: '404', message: expect.stringContaining('NOT_FOUND') })
    expect(res.json().traceId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('validates request bodies against the spec (400 ErrorResponse)', async () => {
    const res = await built.app.inject({ method: 'POST', url: '/v0/customers/create', payload: { email: 42 } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ status: '400', details: expect.stringContaining('traceId') })
  })

  it('validates uuid path params', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/v0/accounts/not-a-uuid' })
    expect(res.statusCode).toBe(400)
  })
})

function sampleParam(op: { params?: unknown }, name: string): string {
  const schema = ((op.params as { properties?: Record<string, { format?: string; pattern?: string; enum?: string[] }> } | null)?.properties ?? {})[name]
  if (schema?.enum?.length) return schema.enum[0]!
  if (schema?.format === 'uuid') return '11111111-1111-4111-8111-111111111111'
  if (schema?.pattern?.includes('d{6}')) return '636220'
  return 'sample'
}

describe('response contract validation (validateResponses)', () => {
  const probe = async (validateResponses?: boolean) => {
    const { buildServer } = await import('../src/server.js')
    const server = await buildServer({ logLevel: 'silent', auth: false, ...(validateResponses === undefined ? {} : { validateResponses }) })
    // A route bound to getHayAccount that answers a body breaking the HayAccount schema (format and type).
    server.app.get('/v0/__probe', { config: { operationId: 'getHayAccount' } }, async (_req, reply) =>
      reply.type('application/json').send(JSON.stringify({ accountHayId: 'not-a-uuid', availableBalance: 'lots' })))
    await server.app.ready()
    const res = await server.app.inject({ method: 'GET', url: '/v0/__probe' })
    await server.app.close()
    return res
  }

  it('replaces a response that breaks the operation schema with a 500 naming the operation and the error', async () => {
    const res = await probe(true)
    expect(res.statusCode).toBe(500)
    expect(res.json()).toMatchObject({ status: '500', message: expect.stringMatching(/^RESPONSE_CONTRACT_VIOLATION: getHayAccount \(GET \/v0\/__probe -> 200\): /) })
    expect(res.json().message).toContain('response/accountHayId must match format "uuid"')
    expect(res.json().message).toContain('response/availableBalance must be number')
  })

  it('is off by default', async () => {
    const res = await probe()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ accountHayId: 'not-a-uuid', availableBalance: 'lots' })
  })

  it('passes conforming bodies, error bodies of a declared status included', async () => {
    // startApp() turns validation on: a declared 400 ErrorResponse goes through the validator untouched.
    const res = await built.app.inject({ method: 'GET', url: '/v0/accounts/not-a-uuid' })
    expect(res.statusCode).toBe(400)
    expect(res.json().status).toBe('400')
  })

  it('checks the handler object before the serializer coerces it (real getHayAccount route)', async () => {
    // fast-json-stringify would answer 12.5 for '12.5' and "" for null; the object is checked before that.
    const accounts = built.ctx.services.accounts
    const get = vi.spyOn(accounts, 'get').mockReturnValue({} as ReturnType<typeof accounts.get>)
    const view = vi.spyOn(accounts, 'toResponse').mockReturnValue({ accountHayId: '11111111-1111-4111-8111-111111111111', availableBalance: '12.5', bsb: null } as unknown as ReturnType<typeof accounts.toResponse>)
    try {
      const res = await built.app.inject({ method: 'GET', url: '/v0/accounts/11111111-1111-4111-8111-111111111111' })
      expect(res.statusCode).toBe(500)
      expect(res.json().message).toMatch(/^RESPONSE_CONTRACT_VIOLATION: getHayAccount \(GET \/v0\/accounts\/[0-9a-f-]+ -> 200\): /)
      expect(res.json().message).toContain('response/availableBalance must be number')
      expect(res.json().message).toContain('response/bsb must be string')
    } finally {
      get.mockRestore()
      view.mockRestore()
    }
  })

  it('checks undeclared error statuses against ErrorResponse (404 NOT_FOUND passes)', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/v0/accounts/11111111-1111-4111-8111-111111111111' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ status: '404', message: expect.stringMatching(/^NOT_FOUND/) })

    const server = await buildProbe((app) =>
      app.get('/v0/__probe', { config: { operationId: 'getHayAccount' } }, async (_req, reply) => reply.code(404).send({ status: 404, message: 'gone' })))
    const bad = await server.app.inject({ method: 'GET', url: '/v0/__probe' })
    await server.app.close()
    expect(bad.statusCode).toBe(500)
    expect(bad.json().message).toMatch(/^RESPONSE_CONTRACT_VIOLATION: getHayAccount \(GET \/v0\/__probe -> 404\): response\/status must be string/)
  })

  it('refuses a 2xx status the operation does not declare', async () => {
    const server = await buildProbe((app) =>
      app.get('/v0/__probe', { config: { operationId: 'getHayAccount' } }, async (_req, reply) => reply.code(201).send({ accountHayId: '11111111-1111-4111-8111-111111111111' })))
    const res = await server.app.inject({ method: 'GET', url: '/v0/__probe' })
    await server.app.close()
    expect(res.statusCode).toBe(500)
    expect(res.json().message).toBe('RESPONSE_CONTRACT_VIOLATION: getHayAccount (GET /v0/__probe -> 201): status 201 is not declared by the contract')
  })

  it('refuses an undeclared 2xx without a body too', async () => {
    const server = await buildProbe((app) =>
      app.get('/v0/__probe', { config: { operationId: 'getHayAccount' } }, async (_req, reply) => reply.code(204).send()))
    const res = await server.app.inject({ method: 'GET', url: '/v0/__probe' })
    await server.app.close()
    expect(res.statusCode).toBe(500)
    expect(res.json().message).toBe('RESPONSE_CONTRACT_VIOLATION: getHayAccount (GET /v0/__probe -> 204): status 204 is not declared by the contract')
  })
})

async function buildProbe(route: (app: BuiltServer['app']) => unknown): Promise<BuiltServer> {
  const { buildServer } = await import('../src/server.js')
  const server = await buildServer({ logLevel: 'silent', auth: false, validateResponses: true })
  route(server.app)
  await server.app.ready()
  return server
}
