# Agent CTOS x402 Escrow — Design Document

## Problem Statement

x402's `exact` scheme on Solana is a single irreversible transfer: the buyer
signs, the facilitator submits, and the money is gone the instant the
transaction lands. There is no native escrow or commerce scheme for Solana in
the x402 spec. That means:

1. **Zero buyer protection.** If a merchant takes payment and never delivers,
   the buyer has no recourse; the transfer already finalised.
2. **No way to pay a stranger.** An autonomous agent transacting with an
   unknown merchant is making an unsecured, unrecoverable prepayment every
   time.

The specification is explicit that this gap is deliberate. The
[SVM `exact` scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md)
separates payment semantics from what it calls a **Sponsor Acceptance
Policy** — how the sponsoring party evaluates risk, limits cost, or constrains
transaction structure — and puts that policy out of scope. Someone has to
implement it. This program is that policy, enforced on-chain.

## Solution Overview

Replace the irreversible transfer with an escrow that any of the two parties
can resolve, under one rule:

> **An instant reversal needs both parties to agree. Anything one party can do
> alone must wait for the clock.**

That single sentence produces the entire instruction set:

| Outcome | Signers | Timing | Fee |
|---|---|---|---|
| Merchant is paid | buyer | any time | 0.50% |
| Order is cancelled | buyer **and** merchant | any time | none |
| Buyer recovers funds | buyer | after expiry | none |

The symmetry is the point. A buyer alone cannot take delivery and then pull the
money back — that would make the program anti-rug for buyers and fully
rug-able for merchants. A merchant alone cannot keep money the buyer never
confirmed. Each side's unilateral escape hatch is gated by a deadline the buyer
chose at payment time and the merchant can read before deciding to deliver.

## Custody

Escrowed tokens sit in an SPL token account at seeds
`[b"vault", payment_pubkey]`, whose authority is **the Payment account itself**.

Not a keypair. Not the deployer. Not a facilitator. Releases are signed with
the Payment PDA's own seeds via `invoke_signed`, so the only code that can move
the funds is the three instructions above, and the only way to change that code
is a program upgrade visible on-chain.

There is no `admin`, no `pause`, no `sweep`, and no discretionary instruction
anywhere in the program.

## Fee Design

`FEE_BPS = 50` — 0.50% of the order amount — taken from the vault at
settlement, before the remainder goes to the merchant.

**A percentage, not a flat amount.** x402 exists for micropayments. A flat fee
large enough to matter on a $100 order would exceed a $0.001 API call entirely,
which would exclude the protocol's main use case rather than serve it.

**Only on success.** Refunds and reclaims are free. A buyer who did not receive
what they paid for pays nothing, and the protocol earns only when commerce
actually completes — which aligns the fee-taker's incentives with the buyer's
rather than against them.

**The treasury is compiled in.** It is a `const Pubkey`, constrained in the
`ConfirmDelivery` accounts struct, not a field in a config account. There is
therefore no instruction that can redirect fees, and changing the destination
requires a program upgrade anyone can observe. The tradeoff is that the fee is
not adjustable without redeploying — deliberate, since an adjustable fee needs
an admin key, and an admin key is exactly what this design is trying not to
have.

## Rent and Account Lifetime

Every order creates a Payment account plus a token vault. The vault is closed
the moment it is emptied, returning its rent to the buyer. The Payment account
is closable too, via `close_payment`, once the order has resolved.

This matters more than it looks. An account left open forever costs roughly
0.002 SOL in permanent rent — more than a micropayment is worth, which would
quietly make the protocol uneconomic for the payments it exists to serve.

The order's history is not lost. `PaymentInitiated` and `PaymentSettled` events
are emitted on-chain and are what indexers read; a closed account's outcome
remains reconstructible from transaction history. Keeping a rent-paying account
open purely as a log is the wrong storage for the job.

## Replay Protection

A Payment account's address is derived from `[b"payment", buyer, merchant,
order_id]`. Reusing an `order_id` for the same buyer and merchant therefore
tries to initialise an account that already exists, and the runtime rejects it.
Replay protection falls out of the address derivation rather than needing a
check, a nonce, or a seen-set.

## What This Deliberately Does Not Solve

Naming these is part of the design, not an omission:

**The oracle problem.** The chain cannot see whether goods arrived.
`confirm_delivery` requires the buyer's signature, so a buyer who takes
delivery and then refuses to confirm forces the merchant to wait out the
timeout and lose the payment. No escrow settles offline delivery disputes
on-chain, and any design claiming to has hidden a trusted party somewhere. The
honest framing is that this program removes the *unilateral* rug, not the
*mutual* dispute.

**An abandoned buyer.** Both exits require the buyer's signature, so a buyer
whose key is lost freezes the escrow permanently, penalising a merchant who
delivered. The design chose "funds stuck" over "funds released to the wrong
party": a system that can pay out without the buyer can be made to pay out
against the buyer. A future version would add a much longer second window after
which anyone may permissionlessly settle to the merchant.

**Token-2022.** The program uses the legacy SPL Token program. Beyond the type
constraint, transfer-fee extensions would silently break escrow accounting,
since the amount received would not equal the amount sent.

**Partial delivery.** An order is all-or-nothing. Milestones would need a
different account shape.

## Platform Integration

The program is a drop-in replacement for the transfer inside an x402
facilitator's `/settle`:

- Instead of a plain SPL transfer, the facilitator calls `initiate_payment`.
- On delivery, the buyer (or their agent) calls `confirm_delivery`.
- On silence, the buyer calls `reclaim_timeout` once the expiry passes.

Buyers and sellers do not change how they call the facilitator. Because there
is no standard SVM escrow scheme in x402 yet, any `extra` metadata describing
this escrow (`escrowProgramId`, `paymentPda`, `expiryUnixTime`) is necessarily
non-standard — only a client that knows about this program will understand it.
That is a documented tradeoff, not an oversight.

## Future Work

- A permissionless post-expiry settlement path, so an abandoned buyer cannot
  freeze a delivered order forever.
- Address Lookup Table support, so `initiate_payment`'s account list stays
  within the `exact` scheme's instruction-count conventions when wallets inject
  their own instructions.
- A facilitator-side duplicate-settlement cache, mirroring the SVM spec's
  120-second recommendation.
- Token-2022 support, including correct accounting under transfer fees.
