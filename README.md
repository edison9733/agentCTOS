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
5. **Refund rate signal** — refund rate is tracked and demotes the tier when it crosses a threshold
6. **Reclaim rate signal** — reclaim (timeout) rate is tracked and demotes the tier when it crosses a threshold
7. **Completed volume is input** — only confirmed/settled transactions feed the average tx size and tier math; a pending or disputed order never counts
8. **No human opinion** — `recompute_tier` is a pure function of on-chain counters; anyone can call it and always gets the same answer
9. **Trust ≤ collateral** — a tier only grants speed if the reserve requirement for that tx size is actually funded, atomically, in the same instruction
10. **Velocity check** — a sudden pattern change (flat history → a huge bid) is caught by the same avg-relative check as rules 2/3
11. **Reserve survives tier changes** — a payment's `escrow_amount` is fixed at creation and is never re-derived from a later tier change; the reclaim timeout on an open escrow always applies
12. **Cold-start cost** — a reclaimed (timed-out) escrow resets the merchant to tier 1 and locks out promotion until a fresh batch of transactions is completed

### The `/verify`-time decision tree

This is implemented verbatim in `initiate_payment`:

```
if merchant_is_new OR merchant_tier == 1:
    -> 100% escrow for the whole payment

else if tx_size > avg_historical_tx_size × tier_multiplier:
    -> force escrow for the entire amount (this transaction only; tier is untouched)

else if refund_rate > threshold OR reclaim_rate > threshold:
    -> demote the tier by one, recalculate the reserve under the new tier

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

- **`register_merchant()`** — creates a merchant PDA at tier 1, zero history.
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
# One-time toolchain setup (see the Prerequisites section below)
anchor keys sync        # writes your real program ID into lib.rs and Anchor.toml
anchor build
```

## Testing

```bash
anchor test
```

The reclaim-timeout test sleeps for real past a 61-second escrow expiry
(the program enforces a 60-second minimum timeout), so the full suite takes
a little over a minute — that's expected, not a hang.

## Deployment (devnet)

```bash
solana config set --url devnet
solana airdrop 2
anchor deploy
```

## Prerequisites

1. Node.js 18+ and a package manager (npm/pnpm/yarn)
2. Rust via [rustup](https://rustup.rs)
3. Solana CLI (`solana-install`), bundles a local test validator
4. Anchor CLI via AVM:
   ```bash
   cargo install --git https://github.com/coral-xyz/anchor avm
   avm install latest && avm use latest
   ```
5. `solana config set --url devnet`
6. `solana-keygen new` for a local wallet, then `solana airdrop 2 --url devnet`
7. A devnet SPL mint to use as the payment token (a devnet USDC mint is
   commonly used — verify the current address against your faucet before
   using it, mint addresses on devnet do get retired/reissued)
8. Each wallet needs an Associated Token Account (ATA) for that mint before
   it can hold or receive tokens — unlike EVM, you cannot send SPL tokens to
   a bare address.

## Error Codes

| Code | Meaning |
|---|---|
| `InvalidAmount` | payment amount was zero |
| `InvalidTimeout` | timeout outside [60s, 30 days] |
| `InvalidPaymentStatus` | operation not valid for the payment's current status |
| `InvalidOrder` | order ID mismatch |
| `ReclaimNotYetAvailable` | called before the escrow's expiry |
| `InvalidTokenOwner` / `InvalidMint` | token account doesn't belong to the expected party/mint |
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
