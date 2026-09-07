# Agent CTOS — x402 Anti-Rug Escrow Program

A from-scratch Anchor escrow program for Solana that underwrites x402
payments: every merchant is scored purely from on-chain settlement history,
and every payment's escrow requirement is computed deterministically from
that history at the moment of payment. There is no off-chain database and no
human in the loop — a merchant's tier, reserve math, and full settlement
history all live in on-chain PDAs that anyone can read on Solana Explorer.

This exists because, as of today, Solana's x402 `exact` scheme has no native
escrow/commerce spec (unlike EVM's Commerce Payments Protocol / x402r). This
program is that missing piece: a merchant-underwriting facilitator shim you
can drop in front of an x402 facilitator's `/verify` and `/settle` calls.

## Live on devnet

| | |
|---|---|
| Program ID | `HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4` |
| Cluster | devnet |
| Explorer | [view the program](https://explorer.solana.com/address/HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4?cluster=devnet) |
| Tests | 9 passing |

The program is already deployed, so you can clone and watch it work without
deploying anything yourself.

## Quick Start

```bash
git clone https://github.com/edison9733/agentCTOS.git
cd agentCTOS
git checkout claude/x402-solana-scoring-p3yoot

npm install
anchor build

npm run demo
```

That runs a five-act walkthrough against devnet — a merchant taking money and
never delivering, a second merchant earning its way to tier 2, and the buyer
recovering the stolen escrow with no merchant signature. Every number printed
is re-read from the program's own on-chain accounts, and every step prints an
Explorer link you can check independently.

To drive a single payment yourself instead:

```bash
npm run pay -- --amount 25                               # pay and confirm
npm run pay -- --amount 5 --settle reclaim --timeout 60  # get rugged, then reclaim
```

**Requirements:** Rust, Solana CLI, Anchor 0.29.0, Node 18+, and a devnet
wallet with ~0.1 SOL. If you don't have those yet — or anything below fails —
**[RUNBOOK.md](RUNBOOK.md)** is the complete copy-paste path from a bare
machine to a settled payment, including a troubleshooting table for every
error this project has actually produced.

> **macOS:** run `export COPYFILE_DISABLE=1` before `anchor test`, or the
> local validator fails to unpack its own genesis archive.

## The Twelve Anti-Rug Rules

The program implements these rules exactly, with no manual override
instruction anywhere in the codebase:

1. **Reserve scales with transaction size** — `escrow_amount = base_reserve + (tx_size × risk_multiplier)`
2. **Size multiplier by tier** — a payment may reach at most `avg_historical_tx × tier_multiplier`:
   - Tier 1 (new): 2x
   - Tier 2 (proven): 10x
   - Tier 3 (trusted): 50x
   - Tier 4 (excellent): 100x
3. **No N-x jumps** — a payment above that multiple is forced to full escrow, regardless of tier
4. **New addresses = zero trust** — a fresh merchant PDA starts at tier 1 (100% escrow); there is no way to inherit history by rotating keys
5. **Refund rate signal** — refund rate is tracked, and a rate over threshold drops the merchant to tier 1 (100% escrow) on its next payment
6. **Reclaim rate signal** — reclaim (timeout) rate is tracked the same way, and carries the same consequence
7. **Completed volume is input** — only confirmed/settled transactions feed the average tx size and tier math; a pending or disputed order never counts
8. **No human opinion** — `recompute_tier` is a pure function of on-chain counters; anyone can call it and always gets the same answer
9. **Trust ≤ collateral** — a tier only grants speed if the reserve requirement for that tx size is actually funded, atomically, in the same instruction
10. **Velocity check** — a sudden pattern change (flat history → a huge bid) is caught by the same avg-relative check as rules 2/3
11. **Reserve survives tier changes** — a payment's `escrow_amount` is fixed at creation and is never re-derived from a later tier change; the reclaim timeout on an open escrow always applies
12. **Cold-start cost** — a reclaimed (timed-out) escrow resets the merchant to tier 1 and locks out promotion until a fresh batch of transactions is completed

### The `/verify`-time decision tree

This is implemented verbatim in `initiate_payment`:

```
tier = recompute_tier(merchant)      # pure function of the merchant's counters;
                                     # bad refund/reclaim rates land it on tier 1 here

if merchant_is_new OR tier == 1:
    -> 100% escrow for the whole payment

else if tx_size > avg_historical_tx_size × tier_multiplier:
    -> force escrow for the entire amount (this transaction only; tier is untouched)

else:
    -> minimal reserve (base_reserve + tx_size × risk_multiplier), rest settles instantly
```

## Why On-Chain PDAs Instead of a Database

A facilitator could keep merchant scores in an off-chain table — it's the
fastest thing to build, but judges (and buyers) have to trust that table.
Storing every merchant's tier, counters, and rate history in a Program
Derived Address means anyone can independently verify the exact numbers that
drove a routing decision, on Explorer, without trusting the facilitator's
backend at all. That's the whole point of this design.

## Accounts

### `Merchant` PDA — seeds `[b"merchant", owner_pubkey]`
| Field | Meaning |
|---|---|
| `mint` | the single SPL mint this merchant settles in, fixed at registration |
| `tier` | 1 (new) – 4 (excellent) |
| `completed_tx_count` | settled/confirmed transactions only (rule 7) |
| `total_completed_volume` | sum of confirmed order amounts |
| `avg_tx_size` | running average of confirmed order amounts — the baseline for the size/velocity check |
| `refund_count` / `reclaim_count` | rug signals |
| `total_settlement_events` | completed + refunded + reclaimed — the denominator for the rate signals |
| `tier_floor_tx_count` | cold-start floor after a reclaim (rule 12) |

### `Payment` PDA — seeds `[b"payment", buyer, merchant, order_id]`
| Field | Meaning |
|---|---|
| `mint` | settlement mint, snapshotted so an audit needn't trust merchant state |
| `amount` | full order price |
| `escrow_amount` | portion held in the vault (immutable after creation — rule 11) |
| `instant_amount` | portion sent straight to the merchant at initiation |
| `tier_at_payment` | merchant tier snapshotted for audit |
| `forced_full_escrow` | true if the size/velocity anomaly check triggered |
| `status` | `EscrowHeld` → `Settled` \| `Refunded` \| `Reclaimed` |
| `expiry` | unix timestamp after which the buyer may reclaim |

`Payment` accounts are never closed, so the full settlement history of every
order stays queryable on-chain — that's the transparency this design is for.

### Escrow vault — an SPL token account at seeds `[b"vault", payment_pubkey]`
Owned by the `Payment` PDA itself (not a human-held keypair). The program
signs release/refund/reclaim transfers with the PDA's own seeds — there is no
`escrow_authority` keypair anywhere, so no third party can ever move the
funds.

## Instructions

- **`register_merchant()`** — creates a merchant PDA at tier 1, zero history,
  and pins the SPL mint it settles in. Reputation is denominated: `avg_tx_size`
  and `total_completed_volume` are bare `u64` counters, so a payment in any
  other mint is rejected rather than summed into the same average.
- **`initiate_payment(amount, order_id, timeout_seconds)`** — runs the
  decision tree above, atomically splits `amount` into an instant transfer to
  the merchant and an escrow deposit into the vault, and creates the
  `Payment` record. `timeout_seconds` must be between 60 and 2,592,000 (30 days).
- **`confirm_delivery(order_id)`** — buyer-signed; releases any escrowed
  funds to the merchant, closes the vault, and folds the order into the
  merchant's completed history (this is the only thing that ever raises
  `avg_tx_size` or unlocks a higher tier).
- **`refund_escrow(order_id)`** — buyer-signed; returns the escrowed funds to
  the buyer before delivery and records a refund event.
- **`reclaim_timeout(order_id)`** — buyer-signed, only callable after
  `expiry`; unilaterally pulls the escrowed funds back, records a reclaim
  event, and resets the merchant to tier 1 with a cold-start floor.
- **`recompute_tier()`** — permissionless; recomputes a merchant's tier from
  its own counters. Called automatically after every settlement event, and
  exposed publicly so anyone can re-verify a merchant's tier independently.

## Building

```bash
npm install
anchor build
```

The program ID is already committed in `lib.rs` and `Anchor.toml`. Run
`anchor keys sync` only if you are deploying under a keypair of your own.

## Testing

```bash
anchor test    # 9 passing, ~2 minutes
```

On macOS, set `export COPYFILE_DISABLE=1` first — otherwise the test
validator fails to unpack its own genesis archive (`extra entry found:
"._genesis.bin"`), because macOS writes extended attributes into archives as
`._` companion files.

The reclaim-timeout test sleeps for real past a 61-second escrow expiry
(the program enforces a 60-second minimum timeout), so the full suite takes
a little over a minute — that's expected, not a hang.

## Deployment (devnet)

```bash
solana config set --url devnet
solana airdrop 2

solana program deploy target/deploy/x402_scoring.so \
  --program-id target/deploy/x402_scoring-keypair.json \
  --use-rpc --max-sign-attempts 50 \
  --with-compute-unit-price 50000
```

`--with-compute-unit-price` is what gets the buffer writes through devnet
congestion; without it the deploy tends to exhaust its retries on
`Blockhash expired`. See [RUNBOOK.md](RUNBOOK.md) for resuming a failed
deploy from its buffer, and for `solana program extend` when an upgraded
binary no longer fits.

## Live Demo

`scripts/demo.ts` runs an end-to-end walkthrough against a real cluster: it
registers a brand-new merchant and a "proven" one (seeded with five clean
orders so it mechanically promotes to tier 2), then fires off real
transactions that show the decision tree making a different call each time —
full escrow for the new merchant, a small scaled reserve for the proven one,
a forced full escrow when a payment blows past that merchant's own history,
and finally a rug: a merchant that takes an order, never delivers, and has the
escrow pulled back by the buyer alone once the timeout expires. It mints its own demo SPL token and uses your
already-funded CLI wallet as the buyer, so it has no faucet dependency.

```bash
anchor build       # once, so target/idl + target/deploy exist
npm run demo       # defaults to devnet, using ~/.config/solana/id.json
```

To drive a single payment yourself instead of the scripted narrative:

```bash
npm run pay -- --amount 25
npm run pay -- --amount 5 --settle reclaim --timeout 60
```

`scripts/pay.ts` runs one order through register → initiate → settle and
prints the escrow split and the merchant's counters before and after. See
[RUNBOOK.md](RUNBOOK.md) for the full walkthrough, including how to promote a
merchant to tier 2 and then watch a large order lose the discount.

Every step prints the transaction signature plus a clickable
`explorer.solana.com` link, and re-fetches the `Merchant`/`Payment` PDA state
right after so what's on screen is exactly what's on-chain — nothing here is
computed off-chain.

To rehearse the same demo locally first (faster, no devnet RPC/confirmation
delays):

```bash
solana-test-validator                                  # in one terminal
anchor deploy --provider.cluster localnet               # in another terminal
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npm run demo
```

## Prerequisites

1. Node.js 18+ and a package manager (npm/pnpm/yarn)
2. Rust via [rustup](https://rustup.rs)
3. Solana CLI (`solana-install`), bundles a local test validator
4. Anchor CLI **0.29.0** via AVM — the version this project builds against;
   `latest` will not compile it:
   ```bash
   cargo install --git https://github.com/coral-xyz/anchor avm --locked
   avm install 0.29.0 && avm use 0.29.0
   ```
5. `solana config set --url devnet`
6. `solana-keygen new` for a local wallet, then `solana airdrop 2 --url devnet`.
   Devnet airdrops are frequently rate-limited; if yours is,
   [RUNBOOK.md](RUNBOOK.md#3-create-and-fund-a-wallet--once) covers the
   proof-of-work faucet, which ignores IP limits.
7. Nothing else — `npm run demo` and `npm run pay` mint their own demo SPL
   token and create every token account they need, so there is no dependency
   on a devnet USDC mint or a token faucet.
8. **macOS:** `export COPYFILE_DISABLE=1`, or `solana-test-validator` fails to
   unpack its own genesis archive.

Note that each wallet needs an Associated Token Account for a mint before it
can hold or receive that token — unlike EVM, you cannot send SPL tokens to a
bare address. The scripts handle this for the accounts they create.

## Error Codes

| Code | Meaning |
|---|---|
| `InvalidAmount` | payment amount was zero |
| `InvalidTimeout` | timeout outside [60s, 30 days] |
| `InvalidPaymentStatus` | operation not valid for the payment's current status |
| `InvalidOrder` | order ID mismatch |
| `ReclaimNotYetAvailable` | called before the escrow's expiry |
| `InvalidTokenOwner` / `InvalidMint` | token account doesn't belong to the expected party/mint |
| `MintMismatch` | payment mint isn't the merchant's registered settlement mint |
| `ArithmeticOverflow` / `ArithmeticUnderflow` | checked math guard tripped |

## Security Notes

- All fund-moving CPIs are signed by the `Payment` PDA's own seeds — no
  operator keypair can ever authorize a release, refund, or reclaim.
- All arithmetic is checked (`checked_add`/`checked_mul`/`checked_sub`);
  overflow/underflow aborts the transaction instead of wrapping.
- `escrow_amount` is fixed at payment creation and is never recomputed from a
  later tier change (rule 11) — a merchant cannot retroactively unlock funds
  by having their tier change after the fact.
- This is a hackathon/demo-grade implementation. It has not been audited.
  Production use would additionally want: a duplicate-settlement dedup guard
  at the facilitator layer, Address Lookup Table support for larger
  transactions, and a security review of the tier-recompute thresholds
  against real fraud data.
