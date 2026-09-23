# shaype-local-api

A cleanroom, local re-implementation of the [Shaype B2B Operations API](https://developer.shaype.com/openapi/b2b-operations-api.json) for end-to-end testing of code that integrates with Shaype, on a developer machine. Stateful (customers, accounts, cards, transactions, holds, PayIDs, mandates, ...), backed by SQLite (in-memory or file), with Cognito-style client-credentials auth and outbound webhook notifications.

Not affiliated with Shaype. Not for production use.

## Quick start

```sh
npm install
npm run dev -- --port 8080 --webhook-url http://localhost:3000
```

See `docs/` for the design spec and implementation plan.
