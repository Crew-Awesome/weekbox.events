# WeekBox Events

admin panel for the Events tab in ShitBox.
Uses Cloudflare Workers, D1, Durable Objects, React, Vite, and Mantine.
yall shouldnt use this cus i made it for weekbox specifically buy go nuts sure :P

## Development

Requires Node.js 24+ and pnpm 12.18.0.

```bash
pnpm install
pnpm db:migrate:local
pnpm db:seed:local
pnpm dev
```

Admin panel: http://127.0.0.1:5173 (on local, i wont reveal public lol)

## Features

- Create and manage events.
- Add, edit, hide, reorder, and reveal mods.
- Etc

## API

Undocumented yet :p

## Deployment

Configure Cloudflare Access, D1, and the `OWNER_EMAIL` secret.

```bash
pnpm --filter @weekbox/api exec wrangler d1 migrations apply weekbox-events --remote
pnpm --filter @weekbox/api exec wrangler deploy
```

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm format:checkx
pnpm build
```