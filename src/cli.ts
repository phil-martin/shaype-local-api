#!/usr/bin/env node
import { HELP, loadConfig } from './config.js'
import { buildServer } from './server.js'

const config = loadConfig(process.argv.slice(2), process.env)
if (config.help) {
  process.stdout.write(HELP)
  process.exit(0)
}
const { app, ctx, stubbed } = await buildServer(config)
await app.listen({ port: config.port, host: config.host })
app.log.info(
  { operations: ctx.handled.size, stubbed: stubbed.length, db: config.db, auth: config.auth, webhookUrl: config.webhookUrl },
  `shaype-local listening on http://${config.host}:${config.port}  (token: POST /oauth2/token, admin: /_admin/health)`,
)
const shutdown = async () => { await app.close(); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
