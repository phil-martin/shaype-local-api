import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
