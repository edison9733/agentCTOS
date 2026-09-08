# Agent CTOS — website

Three static pages, no build step, no bundler, no framework.

| File | Route | What it is |
|---|---|---|
| `index.html` | `#/network`, `#/collateral`, `#/reports` | The main site |
| `live.html` | — | Server-driven live demo: runs the five acts on devnet from the browser |
| `deck.html` | — | The ten-slide pitch deck, 1280×720 per slide |

## What is real and what is simulated

This matters, and the site says so on the page rather than hiding it.

- **`#/collateral` is real.** It reads `MerchantReserve` and `Payment` accounts
  straight off Solana devnet with plain JSON-RPC, decodes the Anchor account
  bytes in the browser, and links every address to Solscan. If the chain is
  empty, the page says so instead of inventing rows.
- **`live.html` is real.** Each act is an actual devnet transaction, driven by
  a server-side keypair so the visitor needs no wallet. See `../WEB.md`.
- **`#/network` and `#/reports` are simulated**, and labelled as such. They
  illustrate the shape of a busy network at a scale devnet does not have yet.

## The collateral model

The site previously showed merchant **trust tiers** (1–4) with a reputation
score. That mechanism no longer exists — `programs/x402-scoring/src/lib.rs`
contains no tier, score, or reputation of any kind, and the whole argument of
the current design is that it does not need one.

What replaced it:

- A merchant posts collateral into a reserve vault it funds itself.
- Free collateral (posted − locked exposure) is the **ceiling on instant
  payment**. Whatever it cannot cover is escrowed.
- A merchant with no bond is not blocked. Its orders simply route through full
  escrow and it is paid on delivery.
- On timeout the buyer reclaims the escrow **and** skims the instant portion
  out of the merchant's own reserve, with no merchant signature.

The `#/network` simulation was converted to the same model: nodes carry
`posted` and `exposure`, and the instant/escrow split is derived from them the
way the program derives it.

## Running it

```bash
npx serve frontend
```

Open the file directly if you prefer, but serve it with a charset header —
Python's `http.server` omits `charset=utf-8` and the em dashes turn to mojibake.

### Pointing the live view at your own RPC

`#/collateral` defaults to `https://api.devnet.solana.com`, which rate-limits
`getProgramAccounts` fairly aggressively. To use a dedicated endpoint:

```
index.html?rpc=https://devnet.helius-rpc.com/?api-key=YOUR_KEY#/collateral
```

The default is the public endpoint **specifically because it carries no API
key**. This page is served to anyone, so a keyed URL must never be committed
into it.

## Deploying

`vercel.json` at the repository root handles it. Note two things it does that a
purely static config would not:

- `installCommand` runs a real `npm install`, because `api/demo.ts` (the live
  demo's backend) has dependencies. Skipping install leaves them unresolvable.
- `functions` raises `maxDuration`, because the demo's first act sends eight
  transactions.

If you only want the static pages and not the live demo, you can drop `api/`
and revert those two keys.

## A note on the d3 dependency

`index.html` loads d3 from cdnjs for the network canvas. The whole file is one
IIFE, so an unreachable CDN used to throw and take the **entire** site down with
it — including the collateral view, which needs no d3 at all. There is now a
`HAS_D3` guard and an inert stand-in simulation object, so a CDN failure costs
you the network animation and nothing else.
