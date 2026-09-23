/**
 * Deterministic example generator for out-of-scope operations: walks the response schema and
 * produces a value that satisfies it (enums -> first value, formats -> plausible constants).
 */
import { responseComponentById, type JsonSchema } from '../contract/index.js'
import { isoDate, isoUtc } from '../lib/clock.js'

export const STUB_UUID = '00000000-0000-4000-8000-000000000001'

export function exampleFor(schema: JsonSchema | null | undefined, now: Date, name = 'value', depth = 0): unknown {
  if (!schema || depth > 8) return null
  const ref = schema.$ref as string | undefined
  if (ref) {
    const id = ref.replace(/#$/, '')
    return exampleFor(responseComponentById.get(id), now, id.replace(/^res:/, ''), depth + 1)
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const alts = schema[key] as JsonSchema[] | undefined
    if (alts?.length) {
      const first = alts.find((a) => a.type !== 'null') ?? alts[0]
      return exampleFor(first, now, name, depth + 1)
    }
  }
  const allOf = schema.allOf as JsonSchema[] | undefined
  if (allOf?.length) return Object.assign({}, ...allOf.map((s) => exampleFor(s, now, name, depth + 1) ?? {}))

  const type = Array.isArray(schema.type) ? (schema.type as string[]).find((t) => t !== 'null') : (schema.type as string | undefined)
  const enumValues = schema.enum as unknown[] | undefined
  if (enumValues?.length) return enumValues.find((v) => v !== null) ?? null

  switch (type) {
    case 'string': {
      const format = schema.format as string | undefined
      if (format === 'uuid') return STUB_UUID
      if (format === 'date-time') return isoUtc(now)
      if (format === 'date') return isoDate(now)
      if (schema.pattern) return examplePattern(schema.pattern as string, name)
      return name
    }
    case 'integer':
    case 'number': {
      const min = (schema.minimum as number | undefined) ?? (schema.exclusiveMinimum !== undefined ? (schema.exclusiveMinimum as number) + 1 : undefined)
      return min ?? 0
    }
    case 'boolean':
      return false
    case 'array':
      return [exampleFor(schema.items as JsonSchema, now, name, depth + 1)]
    case 'object':
    default: {
      const props = schema.properties as Record<string, JsonSchema> | undefined
      if (!props) return {}
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(props)) out[k] = exampleFor(v, now, k, depth + 1)
      return out
    }
  }
}

function examplePattern(pattern: string, name: string): string {
  if (/\\d\{6\}/.test(pattern) || /\^\\d\{6\}\$/.test(pattern)) return '636220'
  if (/\[0-9\]\{4\}/.test(pattern) || /\\d\{4\}/.test(pattern)) return '5411'
  if (/\[A-Z\]\{3\}/.test(pattern)) return 'AUD'
  if (/\[0-9a-fA-F\]\{32\}/.test(pattern)) return STUB_UUID.replace(/-/g, '')
  if (/^\^\(\?=\.\{1,19\}\$\)/.test(pattern)) return '0.00'
  if (/\\d/.test(pattern) || /\[0-9\]/.test(pattern)) return '12345678'
  return name
}
