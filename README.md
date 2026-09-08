# Agent CTOS — x402 Escrow for Solana

An escrow program that routes every x402 payment through a rule instead of
through trust: **extraction is bounded by posted collateral, not by knowing
who anyone is.** Some of an order can be paid to the merchant instantly, but
only up to what the merchant's own collateral covers, and only for a buyer
who has completed at least one order before. Everything else is held until
the buyer confirms delivery or the clock runs out — and if the merchant
never delivers, the buyer is made whole out of the merchant's own posted
collateral, with no cooperation from anyone.

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
| Tests | 14 passing |

## Quick Start

```bash
git clone https://github.com/edison9733/agentCTOS.git
cd agentCTOS

npm install
anchor build

npm run demo
```

The demo runs five acts against devnet: a merchant posting collateral and a
buyer registering, that buyer's first order still landing in full escrow, the
same buyer's next order paying instantly, a second merchant taking an instant
payment and vanishing, and the buyer recovering the full order — the instant
portion included — straight out of that merchant's own collateral. Every step
prints an Explorer link.

To drive a single payment yourself:

```bash
npm run pay -- --amount 25                                        # full escrow, confirm
npm run pay -- --amount 60 --reserve 100 --register --settle confirm
npm run pay -- --amount 5  --settle reclaim --timeout 60           # get rugged, then reclaim
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

### The router reads both parties before moving anything

Every payment is split into an **instant** portion, paid to the merchant
immediately and uncollateralized, and an **escrowed** portion, held until the
order resolves. How much can go instant is decided by a lookup, not a
promise:

| Merchant's reserve | Buyer has no history | Buyer is established |
|---|---|---|
| **Covers the order** | Full escrow | **Instant**, in full |
| **Partial** | Full escrow | **Split** — instant up to the reserve |
| **None** | Full escrow | Full escrow |

"Established" means this buyer has completed at least one order before —
see `register_buyer` and `BuyerStanding` below. A merchant with no reserve,
or a buyer with no history, always defaults to full escrow: **five of six
cells above are full escrow, and that is the point.** A fresh wallet is
always fully protected — it can always reclaim on timeout — and it never has
an instant portion to dispute, so it can never reach a merchant's collateral.
A swarm of throwaway wallets has nothing to take.

This is also why reputation stops being a fraud control here and becomes
what it actually is: a **capital-efficiency dial**. Faking `BuyerStanding`
cannot unlock more than a merchant's own reserve already covers, and faking
`MerchantReserve` is impossible — it is real tokens, checked by the SPL
token program, not a number anyone can set.

### Only two things can ever unlock escrowed funds

| Instruction | Who signs | What happens |
|---|---|---|
| `confirm_delivery` | buyer | The merchant is paid the escrowed portion, less the settlement fee. |
| `reclaim_timeout` | buyer, after expiry | The buyer recovers the escrowed portion **and** the reserve is skimmed to recover the instant portion. |

There is no third path. Earlier versions of this program had a mutual
buyer-and-merchant refund, which let a buyer walk away penalty-free at the
merchant's expense with no cause — that instruction has been removed. Every
order now resolves through fulfillment or the clock, never through a costless
early reversal.

### An honest merchant does not need the buyer to come back

If a buyer simply never returns — the most common failure, more likely than
any attack — the merchant is not stuck unpaid. `claim_fulfillment` lets the
merchant assert delivery; if the buyer does not call `dispute_claim` within
24 hours, `finalize_claim` — callable by anyone, no signature required —
settles the order exactly as a confirmation would. A genuine dispute clears
the claim and falls back to the normal timeout.

### The escrow vault has no owner

Funds sit in an SPL token account at seeds `[b"vault", payment_pubkey]`, whose
authority is **the Payment account itself** — not a keypair, not an operator,
not the deployer. Releases are signed by the Payment PDA's own seeds. A
merchant's collateral is the same story: its vault's authority is the
`MerchantReserve` PDA. There is no admin instruction anywhere in this program,
and no key that can move anyone's money on their behalf.

### The fee is a percentage, charged only on the escrowed portion, only on success

`FEE_BPS` is 50 — 0.50% of the escrowed portion of an order — charged **only
when that portion settles successfully**. The instant portion carries no fee
at all: a merchant that has posted real collateral has already paid the cost
of earning instant eligibility, and taxing the thing collateral is meant to
incentivize would undercut the incentive. Reclaims are free either way: a
buyer who did not get what they paid for pays nothing.

### Order records do not accumulate rent

Each order creates a Payment account, and an account left open forever costs
more rent than a small payment is worth. So the order's outcome is emitted as
an on-chain **event**, and `close_payment` deletes the finished record and
returns its rent. Indexers read the events; nothing verifiable is lost.

### Pricing the patient attacker

One attack this program does not eliminate: a merchant builds real,
`BuyerStanding`-eligible history over genuine orders, then takes an instant
payment on one it never intends to deliver. This build enforces strict 1:1
collateralization — the instant portion of an order can never exceed a
merchant's own currently-available reserve — so a bust-out costs the merchant
exactly its own forfeited collateral, and `reclaim_timeout`'s reserve skim
always makes the buyer whole. There is no leverage extended beyond posted
collateral today.

`LIMIT_COEFFICIENT_K` (100) and `RESERVE_SKIM_RATE_C` (5) are published in
`lib.rs` for a *leveraged* future version, where instant eligibility could be
extended some bounded amount beyond raw reserve coverage. In that design, a
patient attacker's faked payoff grows like `k · √(faked volume)` while the
cost to fake it grows linearly (`c · faked volume`); the gap between them is
maximized at `k² / (4c)`. With the constants above, that ceiling is `100² /
(4 × 5) = 500` tokens — a known, chosen number rather than one discovered on
stage. Publishing it is the point of naming these constants at all, even
before the leveraged version that would need them exists.

### One asymmetry is deliberate, not a bug

A merchant that delivered correctly can still lose: if a dishonest buyer
disputes a genuine `claim_fulfillment`, the claim is cleared and the order
falls back to the timeout path, which favors the buyer. There is no on-chain
way to prove delivery happened, so there is no appeal. This is a deliberate
asymmetry in the buyer's favor, not an oversight — own it rather than
discovering it on stage.

## Instructions

- **`open_reserve()`** — merchant-signed, once; creates an empty
  `MerchantReserve` and its paired token vault.
- **`post_reserve(amount)`** — merchant-signed; deposits collateral into an
  already-opened reserve. Callable any number of times to top it up.
- **`withdraw_reserve(amount)`** — merchant-signed; withdraws collateral that
  is not currently backing an outstanding instant payment. Rejected past
  `vault_balance - locked_exposure`.
- **`register_buyer()`** — buyer-signed, once, optional; opens a
  `BuyerStanding` record at `settled_count = 0`. A buyer who never calls this
  can still pay for anything — every order simply defaults to full escrow.
- **`initiate_payment(amount, order_id, timeout_seconds)`** — the router.
  Looks up the merchant's available reserve and the buyer's standing, splits
  `amount` into `instant_amount` and `escrowed_amount` per the table above,
  pays the instant portion immediately, and escrows the rest. `order_id`,
  together with the buyer and merchant, forms the Payment account's address,
  so a replayed order id is rejected by the runtime rather than by a check.
- **`confirm_delivery(order_id)`** — buyer-signed; pays the merchant the
  escrowed amount less the settlement fee, releases the merchant's reserve
  exposure for this order, and raises the buyer's own standing.
- **`claim_fulfillment(order_id)`** — merchant-signed, before `expiry`;
  asserts delivery without the buyer confirming, starting a 24-hour dispute
  window.
- **`dispute_claim(order_id)`** — buyer-signed; clears an active claim that
  was not actually fulfilled, falling back to the normal timeout.
- **`finalize_claim(order_id)`** — no signer required; once
  `CLAIM_DISPUTE_SECONDS` have passed on an unopposed claim, settles the
  order exactly as `confirm_delivery` would.
- **`reclaim_timeout(order_id)`** — buyer-signed, only after `expiry`; returns
  the escrowed amount to the buyer and skims the merchant's reserve for up to
  the instant amount already paid, making the buyer whole either way.
- **`close_payment(order_id)`** — buyer-signed; deletes a finished order
  record and refunds its rent. Rejected while the escrow is still held.

## Accounts

### `Payment` — seeds `[b"payment", buyer, merchant, order_id]`

| Field | Meaning |
|---|---|
| `buyer` / `merchant` | the two parties; the merchant is an address, not a record |
| `mint` | the SPL token this order settles in |
| `amount` | the full order price |
| `instant_amount` / `escrowed_amount` | the router's split; they always sum to `amount` |
| `fee_amount` | the settlement fee charged, on the escrowed portion only; zero until settled |
| `status` | `EscrowHeld` → `Settled` \| `Reclaimed` |
| `expiry` | unix timestamp after which the buyer may reclaim |
| `claimed_at` | unix timestamp of an active `claim_fulfillment`; zero means no active claim |

### `MerchantReserve` — seeds `[b"reserve", merchant]`

| Field | Meaning |
|---|---|
| `merchant` / `mint` | the collateral's owner and denomination |
| `locked_exposure` | how much of the vault's balance currently backs outstanding instant payments |

### `BuyerStanding` — seeds `[b"standing", buyer]`

| Field | Meaning |
|---|---|
| `settled_count` | orders this buyer has completed; `> 0` is "established" |

### Escrow vault — seeds `[b"vault", payment_pubkey]`

An SPL token account whose authority is the `Payment` PDA.

### Reserve vault — seeds `[b"reserve_vault", reserve_pubkey]`

An SPL token account whose authority is the `MerchantReserve` PDA.

## Using it from an AI agent (MCP)

The point of this program is that an agent can pay a stranger safely. So it
ships as an MCP server — no knowledge of Solana accounts required.

```bash
npm run mcp
```

Wire it into Claude Code:

```bash
claude mcp add x402-escrow -- npx ts-node /ABSOLUTE/PATH/TO/agentCTOS/scripts/mcp-server.ts
```

| Tool | What the agent does with it |
|---|---|
| `pay_merchant` | Pay under escrow; routed instantly wherever the merchant's reserve and your own standing already cover it. |
| `check_payment` | Status of one order: still held, settled, or reclaimable now. Read-only. |
| `confirm_delivery` | Release the escrow to the merchant. |
| `reclaim_payment` | Recover funds from a merchant who never delivered — escrow and any instant portion alike. |
| `close_order` | Reclaim a finished order's rent. |

The server acts as a single wallet — your local Solana CLI keypair
(`~/.config/solana/id.json`, override with `ANCHOR_WALLET`) — always as the
buyer. Point it at a cluster with `ANCHOR_PROVIDER_URL`.

## Building and testing

```bash
npm install
anchor build
anchor test    # 14 passing, ~2.5 minutes
```

The program ID is committed in `lib.rs` and `Anchor.toml`. Run `anchor keys
sync` only if you are deploying under a keypair of your own.

Two tests genuinely sleep 62 seconds each: the program enforces a 60-second
minimum escrow timeout, and those tests wait it out rather than faking the
clock. That is expected, not a hang.

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
| `InvalidAmount` | payment or deposit amount was zero |
| `InvalidTimeout` | timeout outside [60s, 30 days] |
| `InvalidPaymentStatus` | the order is already settled or reclaimed |
| `InvalidOrder` | order id mismatch |
| `ReclaimNotYetAvailable` | reclaim or claim attempted before the escrow's expiry |
| `InvalidTokenOwner` / `InvalidMint` | token account doesn't belong to the expected party or mint |
| `InvalidMerchant` / `InvalidBuyer` | signer is not the party named on the payment |
| `InvalidTreasury` | fee destination is not the compiled-in treasury |
| `PaymentStillOpen` | tried to close a record whose escrow is still held |
| `ArithmeticOverflow` | checked math guard tripped |
| `InvalidReserve` | reserve account doesn't match the expected merchant, mint, or vault |
| `InsufficientReserve` | withdrawal exceeds the reserve's currently-available (unlocked) balance |
| `InvalidStanding` | standing account doesn't match the expected buyer |
| `AlreadyClaimed` | this order already has an active fulfillment claim |
| `NoActiveClaim` | `dispute_claim` or `finalize_claim` called with no active claim |
| `ClaimNotYetFinalizable` | `finalize_claim` called before the dispute window elapsed |

## What this does not do

Stated plainly, because these are the first questions a reviewer asks:

- **It cannot tell whether goods actually arrived.** No on-chain system can. A
  buyer who takes delivery and refuses to confirm forces the merchant to rely
  on `claim_fulfillment`'s 24-hour dispute window instead. That is the oracle
  problem, and any design claiming to solve it has hidden a trusted party
  somewhere.
- **If the buyer disappears, the escrow is stuck** unless the merchant claims
  fulfillment. `reclaim_timeout` still needs the buyer's own signature. The
  design chose "funds frozen" over "funds released to the wrong party" — a
  system that can pay out without the buyer can be made to pay out against
  them.
- **No leverage beyond posted collateral, yet.** See "Pricing the patient
  attacker" above — the constants for a leveraged version are published, not
  enforced.
- **The honest-bad-dispute asymmetry is real and unresolved by design.** See
  "One asymmetry is deliberate, not a bug" above.
- **Token-2022 mints are not supported.** The program uses the legacy SPL Token
  program. Transfer-fee extensions would also break the escrow accounting,
  since the amount received would not match the amount sent.
- **Every field on a `Payment`, `MerchantReserve`, or `BuyerStanding` account
  is public.** All plaintext, readable by anyone via RPC. Making this private
  would mean either Token-2022's Confidential Transfer extension (hides
  amount only; its ZK ElGamal proof program's mainnet/devnet status needs
  checking before relying on it) or a live third-party network like Arcium's
  Confidential SPL. Neither is built here.
- **No partial delivery or dispute resolution.** An order is all-or-nothing.
- **It is not audited.** This is hackathon-grade. A production version would
  want a facilitator-side duplicate-settlement guard and Address Lookup Table
  support for the account count this now needs.

## Security notes

- Every fund-moving CPI is signed by the `Payment` or `MerchantReserve` PDA's
  own seeds. No operator keypair can authorise a release, skim, or reclaim.
- All arithmetic is checked or explicitly saturating; overflow aborts the
  transaction rather than wrapping.
- The fee destination is constrained to a compiled-in treasury address, so a
  caller cannot redirect the fee to themselves.
- The program is upgradeable and the upgrade authority is a single wallet. That
  is a real trusted party. Before mainnet, `solana program set-upgrade-authority
  --final`, or hand it to a multisig with a timelock.
