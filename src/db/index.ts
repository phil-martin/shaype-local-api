import Database from 'better-sqlite3'
import { CORE_SCHEMA } from './schema.js'

export type Db = Database.Database

const schemas: string[] = [CORE_SCHEMA]
const columns: { table: string; column: string; ddl: string }[] = []

/** Domain modules call this at import time to contribute their tables. */
export function registerSchema(sql: string): void {
  schemas.push(sql)
}

/**
 * A column added after a table was first shipped: a file database created by an earlier version gets it
 * through ALTER TABLE when opened (CREATE TABLE IF NOT EXISTS leaves an existing table untouched).
 */
export function registerColumn(table: string, column: string, ddl: string): void {
  columns.push({ table, column, ddl })
}

export function openDatabase(file: string): Db {
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  if (file !== ':memory:') db.pragma('journal_mode = WAL')
  migrate(db)
  return db
}

export function migrate(db: Db): void {
  for (const sql of schemas) db.exec(sql)
  for (const c of columns) {
    const existing = db.prepare(`PRAGMA table_info("${c.table}")`).all() as { name: string }[]
    if (!existing.some((e) => e.name === c.column)) db.exec(`ALTER TABLE "${c.table}" ADD COLUMN ${c.column} ${c.ddl}`)
  }
}

/** Wipe every user table (keeps the schema). */
export function resetDatabase(db: Db): void {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]
  db.transaction(() => {
    for (const { name } of tables) db.prepare(`DELETE FROM "${name}"`).run()
  })()
}

/** Monotonic per-database counter (survives restarts for file databases). */
export function nextSeq(db: Db, name: string): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`seq:${name}`) as { value: string } | undefined
  const next = (row ? Number(row.value) : 0) + 1
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`seq:${name}`, String(next))
  return next
}

export const json = {
  stringify: (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v)),
  parse: <T = unknown>(s: string | null | undefined): T | undefined => (s === null || s === undefined ? undefined : (JSON.parse(s) as T)),
}
