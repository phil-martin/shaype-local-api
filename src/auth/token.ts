/**
 * Cognito-style client-credentials tokens: HS256 JWTs signed with a per-process secret.
 * Expiry is evaluated against the virtual clock so tests can expire tokens by advancing time.
 */
import { randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose'
import type { Clock } from '../lib/clock.js'

export class TokenService {
  private readonly key = randomBytes(32)

  constructor(private readonly clock: Clock, private readonly ttlSeconds: number) {}

  async issue(clientId: string): Promise<{ access_token: string; expires_in: number; token_type: 'Bearer' }> {
    const now = Math.floor(this.clock.now().getTime() / 1000)
    const access_token = await new SignJWT({ client_id: clientId, token_use: 'access', scope: 'shaype/b2b' })
      .setProtectedHeader({ alg: 'HS256', kid: 'local' })
      .setSubject(clientId)
      .setIssuer('shaype-local')
      .setIssuedAt(now)
      .setExpirationTime(now + this.ttlSeconds)
      .setJti(randomBytes(8).toString('hex'))
      .sign(this.key)
    return { access_token, expires_in: this.ttlSeconds, token_type: 'Bearer' }
  }

  /** Returns the client id when valid, otherwise a reason string. */
  async verify(token: string): Promise<{ ok: true; clientId: string } | { ok: false; reason: 'expired' | 'invalid' }> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: 'shaype-local', currentDate: this.clock.now() })
      return { ok: true, clientId: String(payload.sub) }
    } catch (e) {
      return { ok: false, reason: e instanceof joseErrors.JWTExpired ? 'expired' : 'invalid' }
    }
  }
}
