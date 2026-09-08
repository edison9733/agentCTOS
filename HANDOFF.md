# Handoff — website + live devnet integration

This package is meant to be dropped into `mykh13/agentCTOS` and finished there.
Everything in it has been written and checked against the current program; what
is left is listed at the bottom, honestly.

## The one thing to understand first

The site used to describe **merchant trust tiers (1–4) and a reputation score**.
That mechanism was removed from the program. `programs/x402-scoring/src/lib.rs`
now contains **no tier, no score, no reputation** — `grep -i tier` on it returns
nothing.

The current design is the opposite argument: *you should not have to know who a
merchant is.* A merchant posts collateral; free collateral is the hard ceiling
on instant payment; on timeout the buyer reclaims the escrow and skims the
instant portion out of that collateral without the merchant's signature.

Anything still phrased in tier language anywhere is stale and wrong.

## What is in this package

```
frontend/index.html     main site — #/collateral now reads live devnet
frontend/live.html      server-driven five-act demo, no visitor wallet needed
frontend/deck.html      ten-slide pitch deck, 1280x720 per slide
frontend/README.md      what is real vs simulated, how to run and deploy
frontend/favicon.svg    unchanged
api/demo.ts             serverless backend for live.html
idl/README.md           how to populate the IDL the API needs
vercel.json             install + function config (see caveats below)
WEB.md                  full deploy runbook for the live demo
HANDOFF.md              this file
```

## What changed in `index.html`

1. **`#/rankings` → `#/collateral`, and it is no longer simulated.**
   It reads `MerchantReserve` (82 bytes) and `Payment` (171 bytes) accounts off
   devnet with plain JSON-RPC `getProgramAccounts`, decodes the Anchor account
   bytes in-browser, and links every address to Solscan.

   Vault balances come from `getTokenAccountsByOwner` on the reserve PDA rather
   than a derived address — the vault's authority *is* the reserve PDA
   (`token::authority = reserve` in `OpenReserve`), which avoids doing PDA
   derivation (sha256 + curve check) in the browser with no library.

   Byte offsets, verified against the Rust structs:

   | Account | Offset | Field |
   |---|---|---|
   | MerchantReserve | 8 / 40 / 72 | merchant / mint / locked_exposure (u64 LE) |
   | Payment | 8 / 40 / 72 | buyer / merchant / mint |
   | Payment | 104 / 112 / 120 / 128 | order_id / amount / instant / escrowed |
   | Payment | 144 / 153 | status (0 held, 1 settled, 2 reclaimed) / expiry (i64) |

   Amounts are parsed as `BigInt` — an escrow in base units can exceed 2^53.

2. **The `#/network` simulation was converted to the same model.** Merchants
   carry `posted` and `exposure`; the instant/escrow split is derived from them.
   `deriveTier` and `deriveScore` are deleted. The drawer shows *Collateral
   posted / Locked exposure / Instant ceiling* instead of *Tier / Score*.

3. **A d3 failure no longer kills the site.** The file is one IIFE and d3 was
   used at top level, so an unreachable CDN threw and took every view down with
   it — including the collateral view, which needs no d3. There is now a
   `HAS_D3` guard plus an inert stand-in simulation object, so the cost of a CDN
   failure is the network animation and nothing else.

## Before this will work

**1. The IDL must be committed.** `api/demo.ts` imports `../idl/x402_scoring.json`.
`target/` is gitignored, so that file does not exist on a deployment:

```bash
anchor build && npm run sync-idl && git add idl/x402_scoring.json
```

**2. Vercel env vars** (`DEMO_WALLET_SECRET`, `DEMO_PROGRAM_ID`, optionally
`DEMO_RPC_URL`). Full detail in `WEB.md`. The wallet secret is a private key and
belongs only in Vercel's encrypted env vars.

**3. `vercel.json` differs from a purely static config in two ways that matter.**
`installCommand` runs a real `npm install` (the original `echo` would leave the
API's imports unresolvable), and `functions.maxDuration` is raised because act 0
sends eight transactions. If you drop `api/`, revert both.

## Still to do

- **`#/reports` is still simulated** and still frames things as receipts filed
  against merchants. It is not *wrong* under the new model, but it would be
  stronger reading real `Payment` accounts the way `#/collateral` does — the
  decoding helpers are already there and reusable.
- **The live view has no auto-refresh.** There is a manual Refresh button. A
  `getProgramAccounts` poll every ~30s, or an account subscription over
  websocket, would make it feel live during a demo.
- **Rate limiting on `api/demo.ts` is in-memory**, so it is best-effort across
  serverless instances. `WEB.md` has the Vercel KV version. Do this before the
  page is public — each run spends real devnet SOL.
- **`#/collateral` shows at most 12 orders** and does not paginate.
- **Nothing is wallet-interactive yet.** The live demo is server-driven by
  design (zero visitor friction). Letting a visitor connect Phantom and pay for
  real would additionally need a devnet token faucet and a funded merchant.
