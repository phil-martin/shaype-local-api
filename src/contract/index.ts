/**
 * Contract layer: loads the generated OpenAPI-derived artefacts (see scripts/gen-contract.ts).
 */
import { readFileSync } from 'node:fs'

export type JsonSchema = Record<string, unknown>
export interface SchemaWithId extends JsonSchema { $id: string }

export interface Operation {
  operationId: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** OpenAPI path, e.g. /v0/accounts/{accountId} */
  path: string
  /** Fastify url, e.g. /v0/accounts/:accountId */
  url: string
  tag: string
  summary: string
  deprecated: boolean
  params?: JsonSchema | null
  querystring?: JsonSchema | null
  body?: JsonSchema | null
  bodyRequired: boolean
  successStatus: number
  /** status code -> response schema (null when the response has no body) */
  responses: Record<string, JsonSchema | null>
}

export interface WebhookContract {
  components: SchemaWithId[]
  endpoints: { path: string; operationId: string; body: JsonSchema }[]
}

function load<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(`./generated/${file}`, import.meta.url), 'utf8')) as T
}

export const operations: Operation[] = load('operations.json')
export const requestComponents: SchemaWithId[] = load('components.req.json')
export const responseComponents: SchemaWithId[] = load('components.res.json')
export const webhookContract: WebhookContract = load('webhooks.json')

export const operationById: ReadonlyMap<string, Operation> = new Map(operations.map((o) => [o.operationId, o]))
export const responseComponentById: ReadonlyMap<string, SchemaWithId> = new Map(responseComponents.map((s) => [s.$id, s]))

export function getOperation(operationId: string): Operation {
  const op = operationById.get(operationId)
  if (!op) throw new Error(`Unknown operationId: ${operationId}`)
  return op
}
