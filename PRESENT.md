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
from the output — a Merchant PDA — and leave that tab ready.

---

## Phase 2 — presenting

Scroll to the top of the captured output and walk down it act by act. The
transcript is real; you ran it minutes ago. Re-running live adds risk and
proves nothing extra.

If you'd rather run it live:

```bash
npm run demo
```

Act 5 pauses about 45 seconds waiting out the escrow expiry. That pause is
the most convincing part of the demo if you narrate it:

> "The merchant can't stop this clock. When it expires the buyer takes the
> money back — and the merchant's signature is nowhere in that transaction."

---

## Phase 3 — the tier story

Use this when asked *how does a merchant earn trust?* Start a fresh merchant
so the numbers are clean:

```bash
npm run pay -- --amount 10
```

Copy the merchant owner pubkey it prints at the end, then:

```bash
export MERCHANT=<PASTE_MERCHANT_OWNER_PUBKEY>
```

Four more settlements — five total is `MIN_TX_TIER_2`:

```bash
npm run pay -- --amount 10 --merchant $MERCHANT
npm run pay -- --amount 10 --merchant $MERCHANT
npm run pay -- --amount 10 --merchant $MERCHANT
npm run pay -- --amount 10 --merchant $MERCHANT
```

The fourth prints **`tier   1 → 2`**. Promotion is arithmetic on counters —
no operator, no allowlist, no appeal.

```bash
npm run pay -- --amount 50 --merchant $MERCHANT
```

First non-zero `instant_amount`: about 10% held, the rest settles instantly.
Trust bought speed, and only speed.

```bash
npm run pay -- --amount 500 --merchant $MERCHANT
```

Snaps back to **100% escrow** with `forced_full_escrow  true` — while
`tier_at_payment` still reads `2`.

> "The merchant kept its tier. The payment lost the discount."

That sentence is the whole design. The tier is a property of the merchant;
the reserve is a property of the payment.

---

## Phase 4 — single scenarios on demand

```bash
npm run pay -- --amount 25                                # pay, then confirm
npm run pay -- --amount 25 --settle refund                # buyer refunds pre-delivery
npm run pay -- --amount 5 --settle reclaim --timeout 60   # the rug, in 60 seconds
npm run pay -- --amount 25 --settle hold                  # leave escrow open to inspect
```

---

## Phase 5 — "how do I know this isn't a database?"

```bash
solana account <MERCHANT_PDA> --url devnet
```

Raw account bytes off devnet, with none of our code in the path. Then open
the same PDA on Explorer. Anyone can recompute the tier from those counters —
`recompute_tier` is permissionless precisely so they can.

---

## If something breaks

| Symptom | Fix |
|---|---|
| `429 Too Many Requests` | Your shell lost `ANCHOR_PROVIDER_URL`. Re-run Phase 0. |
| `Test validator does not look started` | `export COPYFILE_DISABLE=1 && rm -rf .anchor/test-ledger test-ledger` |
| `no matches found: https://...` | zsh globbed the `?`. Quote the URL. |
| `MintMismatch` on `--merchant` | You're pointing at a merchant registered under a different mint. Start a fresh one. |
| Anything else | [RUNBOOK.md](RUNBOOK.md#troubleshooting) has the full table. |

---

## Numbers worth knowing cold

| | |
|---|---|
| Program ID | `HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4` (devnet) |
| Tiers | 1 new · 2 proven · 3 trusted · 4 excellent |
| Settlements to reach each | 5 / 20 / 50 |
| Reserve by tier | 100% / 10% / 3% / 1%, plus a flat base |
| Size ceiling by tier | 2× / 10× / 50× / 100× the merchant's own average |
| Rug penalty | reset to tier 1, plus 10 clean settlements before promotion |
| Escrow timeout range | 60 seconds to 30 days |

---

## Two things not to claim

**Don't say "audited" or "production-ready."** It isn't, and one sharp
follow-up will cost you more credibility than the claim ever bought. Say
"hackathon-grade, and here's what a production version would need" — the
Security Notes in [README.md](README.md#security-notes) list exactly that.

**Don't say "this prevents fraud."** It prices it. A merchant can still take
a tier-1 order and vanish; what it cannot do is take the money, and the
attempt is permanently on-chain against its address.
