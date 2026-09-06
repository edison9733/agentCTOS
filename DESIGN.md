# Agent CTOS Anti-Rug Escrow — Design Document

## Problem Statement

x402's `exact` scheme on Solana is a single irreversible transfer: the buyer
signs, the facilitator submits, and the money is gone the instant the
transaction lands. There is no native escrow or commerce scheme for Solana in
the x402 spec (unlike EVM, which has the audited Commerce Payments
Protocol). That means:

1. **No risk differentiation** — a brand-new, unproven merchant is paid
   exactly as fast and exactly as irreversibly as one with years of clean
   settlement history.
2. **Zero buyer protection** — if a merchant takes payment and never
   delivers, the buyer has no recourse; the transfer already finalized.
3. **No transparency** — nothing about a merchant's track record is visible
   on-chain before a buyer pays them.

## Solution Overview

A facilitator can sit as the `feePayer`/sponsor in x402's `exact` SVM flow
and, per the spec's own Sponsor Acceptance Policy, refuse or reroute a
payment before signing it. This program is what that facilitator routes
into: a merchant-underwriting escrow where trust is **collateral, not
reputation** — a merchant's tier only ever grants *speed*, never an
exemption from having the appropriate reserve actually funded.

Every input to the tier is a settlement event that already happened
on-chain (a confirmed delivery, a refund, a reclaim). There is no
`update_merchant_tier` instruction, no admin key, no discretionary override
anywhere in this program — tier is a pure function of history, recomputed
the same way every time, by anyone.

## The Twelve Anti-Rug Rules

| # | Rule | Enforced in |
|---|---|---|
| 1 | Reserve scales with tx size: `base_reserve + tx_size × risk_multiplier` | `reserve_amount()` |
| 2 | Size multiplier by tier (2x / 10x / 50x / 100x) | `TIER_MULTIPLIER`, `tier_multiplier()` |
| 3 | No N-x jumps — oversized tx forced to full escrow | `initiate_payment` size-anomaly branch |
| 4 | New addresses = zero trust | `initiate_payment` `is_new \|\| tier == 1` branch |
| 5 | Refund rate signal | `Merchant::rates_bps()`, `refund_escrow` |
| 6 | Reclaim rate signal | `Merchant::rates_bps()`, `reclaim_timeout` |
| 7 | Completed volume is input, pending/disputed isn't | `Merchant::record_completed()` |
| 8 | No human opinion — pure recompute | `Merchant::recompute_tier()` |
| 9 | Trust ≤ collateral | atomic transfer in `initiate_payment` |
| 10 | Velocity check | same avg-relative check as rules 2/3 |
| 11 | Reserve survives tier changes | `Payment.escrow_amount` is immutable post-creation |
| 12 | Cold-start cost after a rug | `reclaim_timeout` resets tier + sets `tier_floor_tx_count` |

## Core Concepts

### Merchant Tiers

Tiers are integers 1–4, not labels — a plain `u8` the program itself assigns
via `recompute_tier`, which nobody can call with a different outcome than
the one the counters dictate.

| Tier | Meaning | Size multiplier | Reserve (risk_multiplier) |
|---|---|---|---|
| 1 | New / unproven | 2x avg | 100% (full escrow, no exception) |
| 2 | Proven | 10x avg | 10% |
| 3 | Trusted | 50x avg | 3% |
| 4 | Excellent | 100x avg | 1% |

Promotion thresholds (all must hold, purely mechanical):

```
tier 4  <- completed_tx_count >= 50  AND refund_rate <= 5%  AND reclaim_rate <= 3%
tier 3  <- completed_tx_count >= 20  AND refund_rate <= 5%  AND reclaim_rate <= 3%
tier 2  <- completed_tx_count >= 5   AND refund_rate <= 5%  AND reclaim_rate <= 3%
tier 1  <- otherwise
```

A merchant can never be promoted past tier 1 while
`completed_tx_count < tier_floor_tx_count` — the cold-start floor set after a
reclaim (rule 12).

### The `/verify`-Time Decision Tree

```
if merchant_is_new OR merchant_tier == 1:
    -> 100% escrow for all transactions

else if tx_size > avg_historical_size × tier_multiplier:
    -> force escrow for the entire amount (this tx only — tier is untouched)

else if refund_rate > threshold OR reclaim_rate > threshold:
    -> lower tier, recalculate the reserve under the new tier

else:
    -> instant settlement, minimal reserve per tier
```

This tree runs once, atomically, inside `initiate_payment`. The buyer's
tokens are split in the same instruction: the escrow slice moves to the
vault PDA, the instant slice moves straight to the merchant. A merchant
cannot receive the instant portion without the buyer's escrow slice also
landing — there is no code path where one succeeds without the other.

### Payment Lifecycle

```
initiate_payment
    |
    v
escrow_amount == 0 ? --yes--> Settled (counted toward history immediately)
    |
    no
    v
EscrowHeld -----confirm_delivery-----> Settled (counted toward history)
    |
    |-----refund_escrow----------------> Refunded (raises refund rate)
    |
    '-----reclaim_timeout (post-expiry)-> Reclaimed (raises reclaim rate,
                                            resets tier to 1, rule 12)
```

Only the `Settled` path (whether instant or via `confirm_delivery`) ever
feeds `avg_tx_size` / `total_completed_volume` / `completed_tx_count` — a
refunded or reclaimed order changes the *rate* denominators but never counts
as completed volume (rule 7).

## Security Model

### Fund custody
The escrow vault's authority is the `Payment` PDA itself, not a human-held
"escrow authority" keypair. Every release (`confirm_delivery`), refund
(`refund_escrow`), and reclaim (`reclaim_timeout`) signs its CPI with the
`Payment` account's own derivation seeds. There is no key whose compromise
lets anyone but the buyer (via reclaim) or the program logic (via confirm)
move escrowed funds.

### Access control
- `confirm_delivery` / `refund_escrow` / `reclaim_timeout`: buyer-signed only.
- `reclaim_timeout`: additionally gated on `now > payment.expiry`.
- `recompute_tier`: permissionless by design — since it is a pure function
  of on-chain state, there is nothing to gate; letting anyone call it makes
  independent verification trivial.
- There is no instruction that lets a merchant, an operator, or anyone else
  set a tier directly.

### Arithmetic safety
Every counter update uses `checked_add`/`checked_mul`/`checked_sub`/`checked_div`;
the running average (`avg_tx_size`) is computed in `u128` to avoid overflow
before narrowing back to `u64`.

### Reserve immutability (rule 11)
`Payment.escrow_amount` and `Payment.expiry` are set once, at creation, from
the merchant's tier *at that moment* (`tier_at_payment` is stored purely for
audit). If the merchant's tier changes afterward — promoted, demoted, or
reset to 1 by a later reclaim — no already-open escrow's terms move. The
reclaim timeout on an open escrow always applies regardless of what happens
to the merchant's tier in the meantime.

## Incentive Alignment

- **New merchants** pay the cost of unproven trust (100% escrow) but face no
  ceiling on ever reaching tier 4 — the path is purely volume + clean
  settlement, not application or approval.
- **Proven merchants** get instant settlement on in-range orders, but a
  single refund/reclaim spike immediately raises their rate and can demote
  them on the very next payment — there's no grace period to hide behind.
- **Buyers** are protected by escrow scaled to exactly the risk the
  merchant's own history implies, and can always reclaim a stalled order
  once its expiry passes, without needing the merchant's or a facilitator's
  cooperation.
- **A rug attempt costs the most it possibly could**: the reclaim that
  follows a failed delivery both proves the rug (on-chain, permanently, in
  the `Payment` record) and resets the merchant to the same zero-trust
  starting line as a brand-new address, plus a rebuild floor before they can
  climb back out of tier 1.

## On-Chain PDA Transparency

Everything a routing decision depends on — tier, average tx size, refund
count, reclaim count, total settlement events — is a field on a PDA anyone
can fetch and recompute from first principles (`recompute_tier` is public
specifically so this is checkable without trusting the facilitator's
off-chain view of the same data). Every `Payment` account is left open
(never closed) after settlement, so a merchant's entire history —
instant vs. escrowed, forced-full-escrow flags, refunds, reclaims — is a
permanent, queryable, Explorer-linkable ledger.

## Platform Integration

The program is a thin plug-in behind an x402 facilitator's `/verify` and
`/settle`:
- The facilitator looks up the merchant's `Merchant` PDA (keyed by `payTo`).
- It calls `initiate_payment` instead of a plain SPL transfer; the program
  itself performs the tiering, sizing, and splitting.
- Buyers and sellers do not change anything about how they call the
  facilitator — the routing decision is entirely inside this program.

Because there is no standard SVM escrow/commerce scheme in x402 yet (the
only proposal, PR #873, is closed/unmerged), any `extra` metadata describing
this escrow (`escrowProgramId`, `escrowPda`, `tier`, `reservePercentBps`,
`expiryUnixTime`) is necessarily non-standard — only a client that knows
about this specific program will understand it. That's an explicit,
documented tradeoff, not an oversight.

## Future Enhancements

- Address Lookup Table support so `initiate_payment`'s account list stays
  within the SVM `exact` scheme's instruction-count conventions when wallets
  inject their own Lighthouse/Memo instructions.
- A facilitator-side dedup cache (mirroring the SVM spec's 120-second
  recommendation) to guard against replayed settlement requests.
- Configurable per-mint thresholds (today's constants assume a 6-decimal
  stablecoin like USDC).
- A Solana Attestation Service integration so a merchant's tier can be
  read by *other* programs, not just this one.
