import { buildServer, type BuiltServer } from '../src/server.js'
import type { Config } from '../src/config.js'

export async function startApp(overrides: Partial<Config> = {}, deps: { fetch?: typeof fetch } = {}): Promise<BuiltServer> {
  const built = await buildServer({ logLevel: 'silent', auth: false, ...overrides }, deps)
  await built.app.ready()
  return built
}

export async function getToken(app: BuiltServer['app'], clientId = 'local-client', clientSecret = 'local-secret'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/oauth2/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
  })
  if (res.statusCode !== 200) throw new Error(`token request failed: ${res.statusCode} ${res.body}`)
  return res.json().access_token as string
}
