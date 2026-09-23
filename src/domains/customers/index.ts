/**
 * customers domain — see docs/superpowers/specs/2026-09-24-shaype-local-api-design.md and docs/map/customers.md
 * Not implemented yet: every operation of this domain is served by the generic stub until register() wires it.
 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'

export function register(_app: FastifyInstance, _ctx: AppContext): void {}
