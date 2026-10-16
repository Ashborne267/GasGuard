# Unsafe redirect fixtures

Small, representative repository snapshots used by
`libs/engine/analyzers/unsafe-redirect/__tests__/unsafe-redirect.repositories.spec.ts`
and `apps/api/src/scanner/redirect-scan.job.spec.ts`.

| Fixture        | Stack                                   | Purpose                                     |
| -------------- | --------------------------------------- | ------------------------------------------- |
| `express-app`  | Express (CommonJS + TS utils) + Solidity | Server redirects, weak checks, mixed langs  |
| `nextjs-app`   | Next.js App Router (TS/TSX)             | `NextResponse.redirect`, client navigation  |
| `node-service` | Koa, Fastify, raw `http`                | Framework sink coverage, `writeHead`        |
| `safe-app`     | Express + browser                       | Correct validation only — must yield zero   |

These files are intentionally vulnerable test data. Do not copy them into
application code.
