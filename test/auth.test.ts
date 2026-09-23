import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getToken, startApp } from './helpers.js'
import type { BuiltServer } from '../src/server.js'

let built: BuiltServer
beforeAll(async () => { built = await startApp({ auth: true }) })
afterAll(async () => { await built.app.close() })

describe('client-credentials auth', () => {
  it('rejects protected routes without a bearer token using the 403 ErrorResponse', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/v1/products' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ status: '403', message: expect.stringContaining('FORBIDDEN') })
  })

  it('issues a token for valid client credentials (form body)', async () => {
    const token = await getToken(built.app)
    expect(token.split('.')).toHaveLength(3)
    const res = await built.app.inject({ method: 'GET', url: '/v1/products', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(200)
  })

  it('accepts HTTP Basic client credentials like Cognito', async () => {
    const basic = Buffer.from('local-client:local-secret').toString('base64')
    const res = await built.app.inject({ method: 'POST', url: '/oauth2/token', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'grant_type=client_credentials' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ token_type: 'Bearer', expires_in: 3600 })
  })

  it('rejects bad credentials and grant types with Cognito-style errors', async () => {
    const bad = await built.app.inject({ method: 'POST', url: '/oauth2/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'grant_type=client_credentials&client_id=x&client_secret=y' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toEqual({ error: 'invalid_client' })
    const grant = await built.app.inject({ method: 'POST', url: '/oauth2/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'grant_type=password' })
    expect(grant.json()).toEqual({ error: 'unsupported_grant_type' })
  })

  it('expires tokens when the virtual clock advances past the TTL', async () => {
    const token = await getToken(built.app)
    await built.app.inject({ method: 'POST', url: '/_admin/clock', payload: { advanceMs: 3601 * 1000 } })
    const res = await built.app.inject({ method: 'GET', url: '/v1/products', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(403)
    expect(res.json().message).toContain('expired')
    await built.app.inject({ method: 'POST', url: '/_admin/clock', payload: { reset: true } })
  })

  it('leaves /_admin and /oauth2 unprotected', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/_admin/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', operations: 169 })
  })
})
