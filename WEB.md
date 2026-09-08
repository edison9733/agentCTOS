# The live demo on the web

`frontend/live.html` runs the same five acts as `npm run demo`, in a browser,
against the same deployed devnet program. The visitor needs no wallet, no
devnet SOL, and none of the demo token: a server-side keypair drives the run.

Every figure on the page is read back from on-chain accounts, and every act
links to the transaction on Solana Explorer.

## Why it is one request per act

Act 4 opens an escrow that cannot be reclaimed until it expires 60 seconds
later — that refusal *is* the guarantee being demonstrated, so it cannot be
skipped or faked. Running all five acts in one call therefore takes about 90
seconds, most of it asleep, which is well past a serverless function's budget.

So `api/demo.ts` handles one act per request, and the browser orchestrates.
The 60-second wait happens client-side as a live countdown, which reads better
than a blocked socket anyway.

Serverless invocations share nothing, so the run's state travels to the client
and back as an opaque `session` blob. It carries the secret keys of the
throwaway buyer and merchant keypairs generated for that run. That is safe only
because those keys are created per run, hold nothing but devnet play money, and
are abandoned when the run finishes. **The server wallet's key never leaves the
server.**

## Setup

### 1. Commit the IDL

`target/` is gitignored, so the build output does not exist on the deployment.
The API imports `idl/x402_scoring.json`, which must be committed:

```bash
anchor build
npm run sync-idl
git add idl/x402_scoring.json && git commit -m "Sync IDL"
```

Re-run this whenever the program's interface changes, or the deployed page will
be calling an older shape than the chain expects.

### 2. Fund a demo wallet

Each run spends roughly **0.08 SOL** of devnet SOL — rent for a fresh mint,
six token accounts and the PDAs, plus funding the throwaway buyer and two
merchants. Use a wallet dedicated to this, not your deploy wallet:

```bash
solana-keygen new -o demo-wallet.json
solana airdrop 2 $(solana-keygen pubkey demo-wallet.json) --url devnet
```

Keep it topped up. The API refuses to start a run below 0.12 SOL rather than
failing halfway and stranding the visitor mid-demo.

### 3. Environment variables

Set these in the Vercel project (Settings → Environment Variables):

| Variable | Value |
|---|---|
| `DEMO_WALLET_SECRET` | Contents of `demo-wallet.json` (the JSON array), or a base58 secret key |
| `DEMO_PROGRAM_ID` | `HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4` |
| `DEMO_RPC_URL` | Your Helius devnet URL. Optional — defaults to the public endpoint, which is rate-limited enough to make runs flaky |

`DEMO_WALLET_SECRET` is a private key. It belongs only in Vercel's encrypted
environment variables — never in the repository, and never in a `NEXT_PUBLIC_`
style client-visible variable.

### 4. Deploy

`vercel.json` is already configured. Two things in it differ from a purely
static setup and both matter:

- `installCommand` runs a real `npm install`. The original config skipped
  installation entirely, which is correct for a static site but would leave the
  API function's imports unresolvable.
- `functions.api/demo.ts.maxDuration` is 60s. Act 0 sends eight transactions;
  at devnet confirmation speed that is comfortably inside 60s but well outside
  the 10s default. **Vercel's Hobby plan caps functions below this** — check
  your plan's limit, and if it is lower, split act 0 rather than raising the cap.

```bash
npx vercel --prod
```

Then open `/live.html`.

## Rate limiting

`api/demo.ts` throttles new runs to 6 per minute, but does it with an in-memory
counter. Serverless instances are recycled and several can run at once, so this
narrows abuse rather than preventing it — a determined visitor can drain the
demo wallet.

Before putting the page anywhere public, move the counter to shared storage:

```ts
import { kv } from "@vercel/kv";
const n = await kv.incr(`demo:${new Date().toISOString().slice(0, 16)}`);
if (n > 6) return res.status(429).json({ error: "Busy — try again shortly." });
```

Only act 0 is throttled. Continuing an in-flight run is never rejected, since
that would strand a visitor mid-demo.

## Local development

```bash
npm install
DEMO_WALLET_SECRET="$(cat demo-wallet.json)" \
DEMO_PROGRAM_ID=HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4 \
DEMO_RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_KEY" \
npx vercel dev
```

Opening `frontend/live.html` as a file will not work — the page posts to
`/api/demo`, which needs the dev server.
