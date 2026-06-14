# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Local development (starts Shopify CLI tunnel + Vite dev server)
npm run dev          # or: shopify app dev

# Build for production
npm run build        # react-router build

# Production server
npm run start        # react-router-serve ./build/server/index.js

# Database
npm run setup        # prisma generate + prisma migrate deploy (run after cloning)
npx prisma migrate dev --name <name>   # create a new migration
npx prisma studio    # visual DB explorer

# Code quality
npm run lint         # eslint
npm run typecheck    # react-router typegen + tsc --noEmit

# GraphQL type generation
npm run graphql-codegen

# Deploy to Shopify
npm run deploy
```

## Architecture

This is a **Shopify embedded app** built with React Router v7 (server-side rendering, not SPA). It runs inside the Shopify Admin as an iframe.

### Key files

- `app/shopify.server.ts` — initializes `shopifyApp` with Prisma session storage. Exports `authenticate`, `login`, `registerWebhooks`, etc. **This is the single source of truth for Shopify auth.**
- `app/db.server.ts` — singleton Prisma client (dev: reuses global to avoid exhausting connections across HMR reloads).
- `prisma/schema.prisma` — only contains the `Session` model (used by the Shopify session storage adapter). Add your own models here.

### Routing (file-system based via `@react-router/fs-routes`)

```
app/routes/
  _index/route.tsx          # Public landing page (no auth)
  app.tsx                   # Layout: calls authenticate.admin + wraps <AppProvider>
  app._index.tsx            # /app - main embedded page
  app.additional.tsx        # /app/additional
  auth.$.tsx                # OAuth catch-all
  auth.login/               # Login page
  webhooks.app.uninstalled.tsx
  webhooks.app.scopes_update.tsx
  webhooks.orders.paid.tsx
```

Every route under `app.*` is protected: the `app.tsx` layout calls `authenticate.admin(request)`, which redirects to OAuth if the session is missing or expired.

Webhook routes export only an `action` function; they call `authenticate.webhook(request)` (no redirect, just HMAC verification).

### Authentication pattern

```ts
// In any app.* loader or action:
const { admin, session } = await authenticate.admin(request);
const response = await admin.graphql(`...`);
```

Never use `redirect` from `react-router` inside embedded routes — use the `redirect` returned from `authenticate.admin` or `boundary.error`. Navigating with `<a>` breaks the embedded session; use `<Link>` from `react-router` or Polaris web component `<s-link>`.

### UI: Polaris web components

The UI uses Shopify's Polaris web components (`<s-page>`, `<s-section>`, `<s-button>`, `<s-stack>`, etc.) — these are custom HTML elements, not React components. The `<AppProvider embedded>` in `app.tsx` registers them.

### Webhooks

Webhooks are declared in `shopify.app.toml` (app-specific subscriptions) and handled by routes matching the `uri` path. Prefer app-specific webhooks (in the toml) over shop-specific ones registered in `afterAuth` — the CLI syncs them on every `deploy`.

### GraphQL codegen

`.graphqlrc.ts` targets the Shopify Admin API (October 2025). Running `npm run graphql-codegen` generates types into `app/types/`. Tag inline queries with `#graphql` for IDE schema hints.

### Environment variables

Set by the Shopify CLI during `dev`. For production you need:
- `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`
- `DATABASE_URL` if switching from SQLite to Postgres/MySQL
- `NODE_ENV=production`

### Shopify Dev MCP

The Shopify Dev MCP (`@shopify/dev-mcp`) is configured in `.mcp.json` and `.cursor/mcp.json`. It gives AI tools live access to Shopify API docs and schema — use it when working on GraphQL queries or Shopify-specific APIs.
