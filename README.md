# Chess Notifier

A simple free app hosted on Cloudflare to pull Chess.com games daily and import into lichess and then email me the games.

Basically when I play a game on Chess.com I don't want to have to go to a computer and import it into Lichess to use their engine. Arguably I could just play on Lichess.

## Tech

Typescript, Hono.js, Cloudflare Workers, Resend

## Setup

### What you'll need

- Lichess API Key
- Resend API key
- Cloudflare Worker account (steps to set up later)

### wrangler.jsonc

1. `npx wrangler login` to connect with Cloudflare and get an ID to put into wrangler.jsonc
2. Enter Chess.com username and email address

### Wrangler config

Each command will prompt you to enter a value and set it on the Cloudflare side

```
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TRIGGER_SECRET
npx wrangler secret put LICHESS_TOKEN
```

Add a root level `.dev.vars` copying the example.

Run `npx wrangler deploy`. If you don't have a Cloudflare subdomain configured you can set one up now. This is an account level namespace, not project level. Then ping the endpoint `curl "https://chess-notifier.<your-subdomain>.workers.dev/run?key=<TRIGGER_SECRET>"`
