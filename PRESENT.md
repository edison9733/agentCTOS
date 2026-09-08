# Presenting this project

The terminal is the deliverable. Every number it prints is re-read from the
program's own on-chain accounts, and every step prints an Explorer link — so
the demo is the evidence, not a picture of it.

---

## Phase 0 — start of every session

Both variables die when you close the terminal. Run this first, every time.

```bash
cd ~/code/agentCTOS
export ANCHOR_PROVIDER_URL="https://api.devnet.solana.com"
export COPYFILE_DISABLE=1
```

Swap in your Helius URL if the public endpoint rate-limits you:

```bash
export ANCHOR_PROVIDER_URL="https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
```

The quotes matter — zsh treats a bare `?` as a glob.

---

## Phase 1 — before you present

Do this early, with time to spare. Not on stage.

```bash
git pull origin main
anchor build
anchor test
```

Expect **14 passing**, about two and a half minutes. Two tests really do
sleep 62 seconds each — the program enforces a 60-second minimum escrow
timeout and those tests wait it out rather than faking the clock.

```bash
npm run demo 2>&1 | tee demo-output.txt
```

About two and a half minutes. Leaves the full transcript on screen *and* in
`demo-output.txt`. **This is your primary artifact.** Open one Explorer link
from the output — the rugged order's Payment account — and leave that tab
ready.

---

## Phase 2 — presenting

Scroll to the top of the captured output and walk down it act by act. The
transcript is real; you ran it minutes ago. Re-running live adds risk and
proves nothing extra.

If you'd rather run it live:

```bash
npm run demo
```

Act 5 pauses about a minute waiting out the escrow expiry. That pause is the
most convincing part of the demo if you narrate it:

> "The rugger already got paid instantly, out of its own posted collateral.
> When this clock expires, that same collateral is what pays the buyer
> back — and the merchant's signature is nowhere in that transaction."

---

## Phase 3 — the guarantee, on demand

Use this when asked *what actually stops a merchant taking the money?*

```bash
npm run pay -- --amount 5 --settle reclaim --timeout 60
```

It pays a merchant who never delivers, waits out the 60-second deadline, and
recovers the money. Watch the signer list: only the buyer.

> "The merchant was not asked. They could not object, could not stall, could
> not extend the deadline. That is the whole guarantee."

Then show the part that's new — instant payment backed by real collateral:

```bash
npm run pay -- --amount 60 --reserve 100 --register --settle confirm
```

> "This merchant posted 100 tokens of its own collateral before this order
> even started. The buyer gets paid — sorry, the *merchant* gets paid —
> the instant this transaction lands, because that collateral is already on
> the hook if it doesn't deliver. Reputation didn't unlock this. Money did."

## Phase 4 — single scenarios on demand

```bash
npm run pay -- --amount 25                                         # no setup: full escrow, then confirm
npm run pay -- --amount 60 --reserve 100 --register --settle confirm  # instant, backed by real collateral
npm run pay -- --amount 5  --settle reclaim --timeout 60            # the rug, in 60 seconds
npm run pay -- --amount 25 --settle claim                           # merchant claims fulfillment, no buyer confirmation
npm run pay -- --amount 25 --settle hold                            # leave escrow open to inspect
```

---

## Phase 5 — "how do I know this isn't a database?"

Leave an escrow open, then read it straight off the chain:

```bash
npm run pay -- --amount 25 --settle hold
solana account <PAYMENT_PDA> --url devnet
```

Raw account bytes off devnet, with none of our code in the path. Then open the
same account on Explorer, and the vault beside it — the vault's authority is
the payment account itself, which is how you show there is no key to steal.
The same is true of a merchant's reserve vault: its authority is the
`MerchantReserve` PDA, not the merchant's own wallet.

---

## If something breaks

| Symptom | Fix |
|---|---|
| `429 Too Many Requests` | Your shell lost `ANCHOR_PROVIDER_URL`. Re-run Phase 0. |
| `Test validator does not look started` | `export COPYFILE_DISABLE=1 && rm -rf .anchor/test-ledger test-ledger` |
| `no matches found: https://...` | zsh globbed the `?`. Quote the URL. |
| `--merchant also needs --mint` | This program keeps no merchant record, so the token has to be named explicitly. |
| `--reserve needs a generated merchant` | This script can only post collateral for a merchant whose keypair it generated itself. |
| Anything else | [RUNBOOK.md](RUNBOOK.md#troubleshooting) has the full table. |

---

## Numbers worth knowing cold

| | |
|---|---|
| Program ID | `HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4` (devnet) |
| Instant eligibility | reserve covers the order **and** the buyer has settled at least one order before |
| Settlement fee | 0.50% of the *escrowed* portion only, charged only on success |
| Reclaims | free, always |
| Reclaim | buyer alone, after the expiry — and it skims the merchant's own reserve to cover any instant portion too |
| Escrow timeout range | 60 seconds to 30 days |
| Claim dispute window | 24 hours |
| Published max loss to a patient bust-out | `k²/(4c)` = 500 tokens, with today's constants (no leverage is actually extended yet, so this is a documented ceiling for a future version, not today's live exposure) |

---

## Two things not to claim

**Don't say "audited" or "production-ready."** It isn't, and one sharp
follow-up will cost you more credibility than the claim ever bought. Say
"hackathon-grade, and here's what a production version would need" — the
Security Notes in [README.md](README.md#security-notes) list exactly that.

**Don't say "this prevents fraud."** It makes fraud unprofitable, bounded by
whatever a merchant actually posted as collateral. A merchant can still take
an order and vanish — what they cannot do is walk away with more than they
put up. And say plainly what it does not solve: the chain cannot see whether
goods arrived, so a dishonest buyer can still dispute a genuine
`claim_fulfillment` and cost the merchant the payment. Naming that before you
are asked — see README's "One asymmetry is deliberate, not a bug" — is worth
more than any answer you give after.
