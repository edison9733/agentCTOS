# Agent CTOS — x402 Escrow for Solana

An escrow program that makes x402 payments recoverable. Every payment is held
until the buyer confirms delivery — and if the merchant never delivers, the
buyer takes the money back alone, with no cooperation from anyone.

x402's `exact` scheme on Solana is a single irreversible transfer: the buyer
signs, the facilitator submits, and the money is gone the moment the
transaction lands. If the merchant takes payment and disappears, there is no
recourse. This program replaces that transfer.

It also implements something the specification deliberately leaves out. The
[SVM `exact` scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md)
separates payment semantics from what it calls a *Sponsor Acceptance Policy* —
how the sponsoring party evaluates risk — and declares that out of scope. This
is that policy, enforced on-chain.

## Live on devnet

| | |
|---|---|
| Program ID | `HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4` |
| Cluster | devnet |
| Explorer | [view the program](https://explorer.solana.com/address/HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4?cluster=devnet) |
| Tests | 9 passing |

## Quick Start

```bash
git clone https://github.com/edison9733/agentCTOS.git
cd agentCTOS

npm install
anchor build

npm run demo
```

The demo runs four acts against devnet: a payment the merchant cannot touch, a
second merchant who takes an order and vanishes, an honest delivery released by
the buyer, and the buyer recovering the stolen escrow with no merchant
signature anywhere in the transaction. Every step prints an Explorer link.

To drive a single payment yourself:

```bash
npm run pay -- --amount 25                               # pay and confirm
npm run pay -- --amount 5 --settle reclaim --timeout 60  # get rugged, then reclaim
```

Presenting this? [PRESENT.md](PRESENT.md) is the run order and the lines worth
saying out loud.

**Requirements:** Rust, Solana CLI, Anchor 0.29.0, Node 18+, and a devnet
wallet with ~0.1 SOL. If anything fails, **[RUNBOOK.md](RUNBOOK.md)** is the
complete copy-paste path from a bare machine, with a troubleshooting table for
every error this project has actually produced.

> **macOS:** run `export COPYFILE_DISABLE=1` before `anchor test`, or the local
> validator fails to unpack its own genesis archive.

## How it works

A payment can end in exactly three ways, and the rule behind them is one
sentence: **an instant reversal needs both parties to agree, and anything one
party can do alone must wait for the clock.**

| Instruction | Who signs | What happens |
|---|---|---|
| `confirm_delivery` | buyer | The merchant is paid, less the settlement fee. |
| `refund_escrow` | buyer **and** merchant | The buyer is repaid in full, no fee. |
| `reclaim_timeout` | buyer, after expiry | The buyer takes the money back. The merchant cannot block it. |

That is what stops either side rugging the other. A buyer alone cannot take
delivery and then pull the money back; a merchant alone cannot keep money the
buyer never confirmed. Each party's unilateral route is time-gated by a
deadline the buyer set when paying, which the merchant can see before
delivering.

### The escrow vault has no owner

Funds sit in an SPL token account at seeds `[b"vault", payment_pubkey]`, whose
authority is **the Payment account itself** — not a keypair, not an operator,
not the deployer. Releases are signed by the Payment PDA's own seeds. There is
no admin instruction anywhere in this program, and no key that can move a
buyer's money.

### The fee is a percentage, and only on success

`FEE_BPS` is 50 — 0.50% of the order — charged **only when an order settles
successfully**. Refunds and reclaims are free: a buyer who did not get what
they paid for pays nothing.

A percentage rather than a flat amount, because a flat fee would price out
micropayments, and micropayments are x402's main use case. The treasury address
is compiled into the program rather than stored in a config account, so no
admin instruction can redirect it — changing it takes a program upgrade that
anyone can see on-chain.

### Order records do not accumulate rent

Each order creates a Payment account, and an account left open forever costs
more rent than a small payment is worth. So the order's outcome is emitted as
an on-chain **event**, and `close_payment` deletes the finished record and
returns its rent. Indexers read the events; nothing verifiable is lost.

## Instructions

- **`initiate_payment(amount, order_id, timeout_seconds)`** — moves the full
  amount into the escrow vault and creates the Payment record. `timeout_seconds`
  must be between 60 and 2,592,000 (30 days). The Payment account's address is
  derived from the buyer, merchant and `order_id`, so a replayed order id is
  rejected by the runtime rather than by a check.
- **`confirm_delivery(order_id)`** — buyer-signed; pays the merchant the order
  amount less the settlement fee, and closes the vault.
- **`batch_confirm_delivery()`** — settles up to 8 orders in one transaction
  instead of one `confirm_delivery` per order. Takes no typed accounts of its
  own; every four consecutive entries in the transaction's remaining accounts
  are one order's `[payment, escrow_vault, merchant_token, treasury_token]`.
  All orders in one call must share the same buyer, since the transaction
  carries only that one signature. Same rule, same helpers as
  `confirm_delivery` — this only amortizes the network fee and confirmation
  wait across many orders.
- **`refund_escrow(order_id)`** — buyer- **and** merchant-signed; returns the
  full amount to the buyer with no fee.
- **`reclaim_timeout(order_id)`** — buyer-signed, only after `expiry`; returns
  the full amount to the buyer with no fee.
- **`close_payment(order_id)`** — buyer-signed; deletes a finished order record
  and refunds its rent. Rejected while the escrow is still held.

## Accounts

### `Payment` — seeds `[b"payment", buyer, merchant, order_id]`

| Field | Meaning |
|---|---|
| `buyer` / `merchant` | the two parties; the merchant is an address, not a record |
| `mint` | the SPL token this order settles in |
| `amount` | the full order price, all of which is escrowed |
| `fee_amount` | the settlement fee charged; zero until settled, and zero forever on a refund or reclaim |
| `status` | `EscrowHeld` → `Settled` \| `Refunded` \| `Reclaimed` |
| `expiry` | unix timestamp after which the buyer may reclaim |

### Escrow vault — seeds `[b"vault", payment_pubkey]`

An SPL token account whose authority is the `Payment` PDA. See above.

## Using it from an AI agent (MCP)

The point of this program is that an agent can pay a stranger safely. So it
ships as an MCP server — five tools, no knowledge of Solana accounts required.

```bash
npm run mcp
```

Wire it into Claude Code:

```bash
claude mcp add x402-escrow -- npx ts-node /ABSOLUTE/PATH/TO/agentCTOS/scripts/mcp-server.ts
```

| Tool | What the agent does with it |
|---|---|
| `pay_merchant` | Pay under escrow. Returns the order id and the reclaim deadline. |
| `check_payment` | Status of one order: still held, settled, or reclaimable now. Read-only. |
| `confirm_delivery` | Release the escrow to the merchant. |
| `reclaim_payment` | Recover funds from a merchant who never delivered. |
| `close_order` | Reclaim a finished order's rent. |

The server acts as a single wallet — your local Solana CLI keypair
(`~/.config/solana/id.json`, override with `ANCHOR_WALLET`) — always as the
buyer. Point it at a cluster with `ANCHOR_PROVIDER_URL`.

## Building and testing

```bash
npm install
anchor build
anchor test    # 9 passing, ~2 minutes
```

The program ID is committed in `lib.rs` and `Anchor.toml`. Run `anchor keys
sync` only if you are deploying under a keypair of your own.

One test genuinely sleeps 62 seconds: the program enforces a 60-second minimum
escrow timeout, and that test waits it out rather than faking the clock. That
is expected, not a hang.

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
congestion; without it the deploy tends to exhaust its retries on `Blockhash
expired`. [RUNBOOK.md](RUNBOOK.md) covers resuming a failed deploy from its
buffer, and `solana program extend` when an upgraded binary no longer fits.

## Error Codes

| Code | Meaning |
|---|---|
| `InvalidAmount` | payment amount was zero |
| `InvalidTimeout` | timeout outside [60s, 30 days] |
| `InvalidPaymentStatus` | the order is already settled, refunded, or reclaimed |
| `InvalidOrder` | order id mismatch |
| `ReclaimNotYetAvailable` | called before the escrow's expiry |
| `InvalidTokenOwner` / `InvalidMint` | token account doesn't belong to the expected party or mint |
| `InvalidMerchant` / `InvalidBuyer` | signer is not the party named on the payment |
| `InvalidTreasury` | fee destination is not the compiled-in treasury |
| `PaymentStillOpen` | tried to close a record whose escrow is still held |
| `ArithmeticOverflow` | checked math guard tripped |
| `InvalidBatchSize` | `batch_confirm_delivery`'s remaining accounts weren't a multiple of 4, or exceeded 8 orders |

## What this does not do

Stated plainly, because these are the first questions a reviewer asks:

- **It cannot tell whether goods actually arrived.** No on-chain system can. A
  buyer who takes delivery and refuses to confirm forces the merchant to wait
  out the timeout and lose the payment. That is the oracle problem, and any
  design claiming to solve it has hidden a trusted party somewhere.
- **If the buyer disappears, the escrow is stuck.** Both exits need the buyer's
  signature. The design chose "funds frozen" over "funds released to the wrong
  party" — a system that can pay out without the buyer can be made to pay out
  against them.
- **Token-2022 mints are not supported.** The program uses the legacy SPL Token
  program. Transfer-fee extensions would also break the escrow accounting,
  since the amount received would not match the amount sent.
- **Every field on a `Payment` account is public.** Buyer, merchant, mint, and
  amount are all plaintext, readable by anyone via RPC. Making this private
  would mean either Token-2022's Confidential Transfer extension (hides
  amount only; its ZK ElGamal proof program's mainnet/devnet status needs
  checking before relying on it) or a live third-party network like Arcium's
  Confidential SPL. Neither is built here — this is unverified, researched,
  and left for later, not attempted blind in an environment with no Solana
  toolchain to compile or test it.
- **No partial delivery or dispute resolution.** An order is all-or-nothing.
- **It is not audited.** This is hackathon-grade. A production version would
  want a permissionless post-expiry settlement path for abandoned buyers, a
  facilitator-side duplicate-settlement guard, and Address Lookup Table support.

## Security notes

- Every fund-moving CPI is signed by the `Payment` PDA's own seeds. No operator
  keypair can authorise a release, refund, or reclaim.
- All arithmetic is checked; overflow aborts the transaction rather than
  wrapping.
- The fee destination is constrained to a compiled-in treasury address, so a
  caller cannot redirect the fee to themselves.
- The program is upgradeable and the upgrade authority is a single wallet. That
  is a real trusted party. Before mainnet, `solana program set-upgrade-authority
  --final`, or hand it to a multisig with a timelock.
