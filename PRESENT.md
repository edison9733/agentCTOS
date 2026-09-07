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

Expect **9 passing**, about two minutes. One test really does sleep 62
seconds — the program enforces a 60-second minimum escrow timeout and that
test waits it out rather than faking the clock.

```bash
npm run demo 2>&1 | tee demo-output.txt
```

About two minutes. Leaves the full transcript on screen *and* in
`demo-output.txt`. **This is your primary artifact.** Open one Explorer link
from the output — the rugged order's Payment account — and leave that tab ready.

---

## Phase 2 — presenting

Scroll to the top of the captured output and walk down it act by act. The
transcript is real; you ran it minutes ago. Re-running live adds risk and
proves nothing extra.

If you'd rather run it live:

```bash
npm run demo
```

Act 4 pauses about 45 seconds waiting out the escrow expiry. That pause is
the most convincing part of the demo if you narrate it:

> "The merchant can't stop this clock. When it expires the buyer takes the
> money back — and the merchant's signature is nowhere in that transaction."

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

Then the counterpart — why this is not just a buyer-favouring system:

```bash
npm run pay -- --amount 25 --settle refund
```

A refund needs both signatures. Say why:

> "If the buyer could refund alone, they would take delivery and pull the money
> back. An instant reversal needs both parties. Anything one party does alone
> has to wait for the clock."

## Phase 4 — single scenarios on demand

```bash
npm run pay -- --amount 25                                # pay, then confirm
npm run pay -- --amount 25 --settle refund                # cancelled by mutual agreement
npm run pay -- --amount 5 --settle reclaim --timeout 60   # the rug, in 60 seconds
npm run pay -- --amount 25 --settle hold                  # leave escrow open to inspect
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

---

## If something breaks

| Symptom | Fix |
|---|---|
| `429 Too Many Requests` | Your shell lost `ANCHOR_PROVIDER_URL`. Re-run Phase 0. |
| `Test validator does not look started` | `export COPYFILE_DISABLE=1 && rm -rf .anchor/test-ledger test-ledger` |
| `no matches found: https://...` | zsh globbed the `?`. Quote the URL. |
| `--merchant also needs --mint` | This program keeps no merchant record, so the token has to be named explicitly. |
| Anything else | [RUNBOOK.md](RUNBOOK.md#troubleshooting) has the full table. |

---

## Numbers worth knowing cold

| | |
|---|---|
| Program ID | `HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4` (devnet) |
| Escrowed per payment | 100% — the merchant is paid nothing up front |
| Settlement fee | 0.50%, charged only when an order succeeds |
| Refunds and reclaims | free |
| Refund | needs both the buyer's and the merchant's signature |
| Reclaim | buyer alone, after the expiry |
| Escrow timeout range | 60 seconds to 30 days |

---

## Two things not to claim

**Don't say "audited" or "production-ready."** It isn't, and one sharp
follow-up will cost you more credibility than the claim ever bought. Say
"hackathon-grade, and here's what a production version would need" — the
Security Notes in [README.md](README.md#security-notes) list exactly that.

**Don't say "this prevents fraud."** It makes fraud unprofitable. A merchant
can still take an order and vanish — what they cannot do is keep the money.
And say plainly what it does not solve: the chain cannot see whether goods
arrived, so a buyer who takes delivery and refuses to confirm still costs the
merchant the payment. Naming that before you are asked is worth more than any
answer you give after.
