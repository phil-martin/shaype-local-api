/**
 * Generates the contract layer from the vendored OpenAPI specs.
 *
 * Output (src/contract/generated/, git-ignored):
 *   operations.json        one entry per B2B operation: routing + ajv-ready schemas ($ref -> shared ids)
 *   components.req.json    component schemas for REQUEST validation (required kept), $id "req:<Name>"
 *   components.res.json    component schemas for RESPONSE serialization (required stripped), $id "res:<Name>"
 *   webhooks.json          webhook spec component schemas (response flavour), $id "wh:<Name>"
 *   b2b-types.ts           TypeScript types for the B2B spec (openapi-typescript)
 *   webhook-types.ts       TypeScript types for the webhook spec
 *
 * OpenAPI 3.0 -> JSON Schema (ajv/fast-json-stringify) conversions applied:
 *   - nullable: true            -> type: [T, "null"] / enum + null / anyOf [$ref, null]
 *   - exclusiveMinimum: true    -> numeric exclusiveMinimum (draft-06+)
 *   - single-element enums whose value is "A,B,C" (generator artefact, 45 in the spec) -> split; duplicate enum values removed
 *   - OpenAPI-only keywords dropped: example, examples, deprecated, xml, externalDocs, discriminator, x-*
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import openapiTS, { astToString } from 'openapi-typescript'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'src/contract/generated')
mkdirSync(OUT, { recursive: true })

type Json = any
const DROP = new Set(['example', 'examples', 'deprecated', 'xml', 'externalDocs', 'discriminator', 'readOnly', 'writeOnly'])
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

function convert(node: Json, prefix: string, stripRequired: boolean): Json {
  if (Array.isArray(node)) return node.map((n) => convert(n, prefix, stripRequired))
  if (node === null || typeof node !== 'object') return node
  if (typeof node.$ref === 'string') {
    const name = node.$ref.replace('#/components/schemas/', '')
    const ref = { $ref: `${prefix}${name}#` }
    return node.nullable ? { anyOf: [ref, { type: 'null' }] } : ref
  }
  const out: Json = {}
  for (const [k, v] of Object.entries(node)) {
    if (DROP.has(k) || k.startsWith('x-')) continue
    if (k === 'required' && stripRequired && Array.isArray(v)) continue
    if (k === 'nullable') continue
    if (k === 'enum' && Array.isArray(v)) {
      // 45 PayTo enums are a single comma-joined string (generator artefact); one currency enum has duplicates.
      const values = v.length === 1 && typeof v[0] === 'string' && v[0].includes(',') ? v[0].split(',').map((s: string) => s.trim()) : v
      out.enum = [...new Set(values)]
      continue
    }
    if (k === 'exclusiveMinimum' && v === true) { out.exclusiveMinimum = node.minimum; continue }
    if (k === 'exclusiveMaximum' && v === true) { out.exclusiveMaximum = node.maximum; continue }
    if (k === 'exclusiveMinimum' && v === false) continue
    if (k === 'exclusiveMaximum' && v === false) continue
    if (k === 'minimum' && node.exclusiveMinimum === true) continue
    if (k === 'maximum' && node.exclusiveMaximum === true) continue
    if (k === 'properties' || k === 'patternProperties') {
      out[k] = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, convert(pv, prefix, stripRequired)]))
      continue
    }
    if (k === 'items' || k === 'additionalProperties' || k === 'not') { out[k] = typeof v === 'object' ? convert(v, prefix, stripRequired) : v; continue }
    if (k === 'allOf' || k === 'anyOf' || k === 'oneOf') { out[k] = (v as Json[]).map((s) => convert(s, prefix, stripRequired)); continue }
    out[k] = v
  }
  if (node.nullable === true) {
    if (typeof out.type === 'string') out.type = [out.type, 'null']
    else if (Array.isArray(out.type) && !out.type.includes('null')) out.type = [...out.type, 'null']
    if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null]
    if (out.type === undefined && out.enum === undefined && !out.anyOf && !out.allOf && !out.oneOf) out.type = ['object', 'null']
  }
  return out
}

function components(spec: Json, prefix: string, stripRequired: boolean): Json[] {
  return Object.entries(spec.components?.schemas ?? {}).map(([name, schema]) => ({ $id: `${prefix}${name}`, ...convert(schema, prefix, stripRequired) }))
}

function paramsSchema(params: Json[], where: 'path' | 'query'): Json | undefined {
  const ps = params.filter((p) => p.in === where)
  if (!ps.length) return undefined
  const properties: Json = {}
  const required: string[] = []
  for (const p of ps) {
    properties[p.name] = convert(p.schema ?? { type: 'string' }, 'req:', false)
    if (p.required || where === 'path') required.push(p.name)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

const b2b = JSON.parse(readFileSync(path.join(ROOT, 'spec/b2b-operations-api.json'), 'utf8'))
const wh = JSON.parse(readFileSync(path.join(ROOT, 'spec/notification-webhooks.json'), 'utf8'))

const operations: Json[] = []
for (const [p, item] of Object.entries<Json>(b2b.paths)) {
  const shared: Json[] = item.parameters ?? []
  for (const m of METHODS) {
    const op = item[m]
    if (!op) continue
    const params = [...shared, ...(op.parameters ?? [])]
    const bodyContent = op.requestBody?.content?.['application/json']
    const responses: Record<string, Json | null> = {}
    for (const [code, r] of Object.entries<Json>(op.responses ?? {})) {
      const c = r.content?.['application/json']?.schema
      responses[code] = c ? convert(c, 'res:', true) : null
    }
    const successStatus = Number(Object.keys(responses).find((c) => c.startsWith('2')) ?? '200')
    operations.push({
      operationId: op.operationId,
      method: m.toUpperCase(),
      path: p,
      url: p.replace(/\{(\w+)\}/g, ':$1'),
      tag: op.tags?.[0] ?? 'untagged',
      summary: op.summary ?? '',
      deprecated: op.deprecated === true,
      params: paramsSchema(params, 'path'),
      querystring: paramsSchema(params, 'query'),
      body: bodyContent?.schema ? convert(bodyContent.schema, 'req:', false) : undefined,
      bodyRequired: op.requestBody?.required === true,
      successStatus,
      responses,
    })
  }
}

writeFileSync(path.join(OUT, 'operations.json'), JSON.stringify(operations, null, 1))
writeFileSync(path.join(OUT, 'components.req.json'), JSON.stringify(components(b2b, 'req:', false), null, 1))
writeFileSync(path.join(OUT, 'components.res.json'), JSON.stringify(components(b2b, 'res:', true), null, 1))
writeFileSync(path.join(OUT, 'webhooks.json'), JSON.stringify({
  components: components(wh, 'wh:', true),
  endpoints: Object.entries<Json>(wh.paths).map(([p, item]) => ({ path: p, operationId: item.post.operationId, body: convert(item.post.requestBody.content['application/json'].schema, 'wh:', true) })),
}, null, 1))

const header = '/* eslint-disable */\n// GENERATED by scripts/gen-contract.ts — do not edit.\n'
writeFileSync(path.join(OUT, 'b2b-types.ts'), header + astToString(await openapiTS(b2b)))
writeFileSync(path.join(OUT, 'webhook-types.ts'), header + astToString(await openapiTS(wh)))

console.log(`gen-contract: ${operations.length} operations, ${Object.keys(b2b.components.schemas).length} B2B schemas, ${Object.keys(wh.components.schemas).length} webhook schemas -> ${path.relative(ROOT, OUT)}`)
