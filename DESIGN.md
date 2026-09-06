# x402 Solana Scoring System - Design Document

## Problem Statement

x402 is a payment protocol that treats all merchants the same way, regardless of trustworthiness. This creates several security issues:

1. **No Risk Differentiation**: Risky and unknown merchants get the same payment terms as trusted ones
2. **Zero Buyer Protection**: If a merchant takes payment and never delivers, the buyer has no recourse
3. **No Transparency**: There's no built-in way to distinguish "safe merchants" from "risky merchants" before making a payment

## Solution Overview

The x402 Solana Scoring System implements a **two-tier trust model** that allows merchants to be categorized as either Low or High tier. Payment settlement is automatically adjusted based on tier:

- **Low-tier merchants**: Use escrow protection (funds held until delivery confirmed)
- **High-tier merchants**: Get instant payment (no delay, reflects their proven track record)

## Core Concepts

### 1. Merchant Tiers

#### Low Tier (Default)
- New merchants start at Low tier
- Payments are held in escrow
- Merchant only receives funds after buyer confirms delivery
- Protects buyers from non-delivery risk
- Incentivizes merchants to deliver on promises

#### High Tier
- Earned through successful deliveries
- Payments settle instantly (no escrow)
- Reflects merchant's proven reliability
- Better customer experience for both buyer and merchant

### 2. Payment Flow by Tier

#### Low-Tier Payment Flow
```
Buyer initiates payment
    ↓
Funds → Escrow Account
    ↓
Buyer receives goods/services
    ↓
Buyer confirms delivery
    ↓
Funds released from Escrow → Merchant
    ↓
Transaction complete
```

#### High-Tier Payment Flow
```
Buyer initiates payment
    ↓
Funds → Merchant Account (immediately)
    ↓
Transaction complete
```

### 3. Data Structures

#### Merchant Account
Stores persistent merchant information:
- `address`: Merchant's public key
- `tier`: Current trust tier (Low/High)
- `total_payments`: Cumulative payment count (for metrics)
- `successful_deliveries`: Count of confirmed escrow releases
- `escrow_balance`: Total funds currently held in escrow

#### Payment Account
Tracks individual transaction state:
- `buyer`: Buyer's public key
- `merchant`: Merchant's public key
- `amount`: Payment amount
- `order_id`: Unique order identifier
- `status`: Current payment status (Pending → EscrowHeld/Settled/Refunded)
- `created_at`: Unix timestamp

### 4. Payment Statuses

- **Pending**: Payment initialized but not yet processed
- **EscrowHeld**: Funds in escrow (Low-tier merchants only)
- **Settled**: Payment completed and delivered to recipient
- **Refunded**: Payment returned to buyer

## Key Operations

### Register Merchant
Creates a new merchant account with Low tier status.

**Requirements:**
- Merchant signs the transaction
- Creates a PDA: `[b"merchant", merchant_pubkey]`

**State Changes:**
- New Merchant account created
- Tier set to Low
- Counters initialized to 0

### Update Merchant Tier
Changes a merchant's trust tier.

**Requirements:**
- Only the merchant themselves can update their tier
- Tier must be valid (0=Low, 1=High)

**Use Cases:**
- Promotion: Low → High after successful deliveries
- Demotion: High → Low after failed transactions (if implemented)

### Initiate Payment
Routes payment to either escrow or direct delivery based on merchant tier.

**Requirements:**
- Buyer signs the transaction
- Sufficient balance in buyer's token account
- Target merchant account exists

**Logic:**
```
if merchant.tier == Low:
    transfer(buyer_token → escrow_token)
    payment.status = EscrowHeld
else if merchant.tier == High:
    transfer(buyer_token → merchant_token)
    payment.status = Settled
```

### Confirm Delivery
Releases escrowed funds to merchant (Low-tier only).

**Requirements:**
- Buyer signs the transaction (only buyer can confirm)
- Payment status must be EscrowHeld
- Escrow authority signs to release funds
- Correct order_id provided

**State Changes:**
- Funds transferred from escrow to merchant
- Payment status → Settled
- Merchant's successful_deliveries incremented
- Merchant's total_payments incremented
- Escrow balance decremented

### Refund Escrow
Returns escrowed payment to buyer (Low-tier only).

**Requirements:**
- Buyer signs the transaction
- Payment status must be EscrowHeld
- Correct order_id provided

**Use Cases:**
- Buyer determined merchant didn't deliver
- Mutual agreement to cancel transaction

**State Changes:**
- Funds transferred from escrow to buyer
- Payment status → Refunded
- Merchant's escrow balance decremented

## Security Model

### Access Control
- **Merchant tier update**: Only merchant themselves (signer)
- **Payment confirmation**: Only payment buyer (signer)
- **Escrow authority**: Required to release funds (multi-sig safety)

### Fund Safety
- **Escrow separation**: Low-tier funds never go to merchant until confirmed
- **Atomic transfers**: Each payment state change is atomic
- **Overflow protection**: All arithmetic checked for overflow/underflow

### Merchant Accountability
- **Successful delivery tracking**: Enables tier promotion decisions
- **Historical record**: All metrics stored on-chain permanently
- **Tier-based consequences**: High-tier merchants risk demotion if delivery fails

## Incentive Alignment

### For Merchants
- **Low tier**: Temporary friction, but safe for buyers (builds trust)
- **High tier**: Instant payment, but reputation at stake
- **Motivation**: Deliver consistently to earn and maintain High tier

### For Buyers
- **Low tier merchants**: Protected by escrow until delivery confirmed
- **High tier merchants**: Faster, frictionless payments with proven reliability
- **Recourse**: Can request refund if merchant fails (Low-tier)

### For Protocol
- **Reduced fraud**: Tier system incentivizes honest merchant behavior
- **Self-scaling**: Tier promotion is automatic based on metrics
- **No centralized judgment**: Objective metrics drive tier decisions

## Platform Integration

The system is designed as a **thin plug-in**:
- Buyers and sellers don't change their workflow
- Escrow and tier logic is transparent
- Can be added to existing x402 implementations
- No breaking changes to x402 protocol

## Future Enhancements

### Possible Extensions
1. **Automatic tier promotion**: Promote to High after N successful deliveries
2. **Reputation scoring**: Fine-grained scoring beyond Low/High
3. **Dispute resolution**: On-chain arbitration for contested deliveries
4. **Fee structure**: Different transaction fees based on tier
5. **Time-locked escrow**: Auto-release if not confirmed within timeframe
6. **Penalty system**: Demote High-tier merchants after failed deliveries

### Extensibility Points
- Custom tier scoring logic
- Integration with oracle data
- Multi-sig merchant recovery
- Governance upgrades via DAO

## Implementation Notes

### Technology Stack
- **Solana Blockchain**: High-speed, low-cost transactions
- **Anchor Framework**: Safe Rust smart contract development
- **SPL Token**: Standard token transfers for payments
- **PDAs**: Program-derived accounts for merchant and payment records

### Account Model
- **Merchant Account**: Owned by program, keyed by `[b"merchant", merchant_pubkey]`
- **Payment Account**: Owned by program, keyed by `[b"payment", buyer, merchant, order_id]`
- **Token Accounts**: Standard SPL token accounts

### Cost Estimation
- Register merchant: ~1 SOL (one-time)
- Initiate payment: ~0.1 SOL
- Confirm/refund: ~0.1 SOL

## Conclusion

The x402 Solana Scoring System provides a minimal, effective mechanism for risk differentiation in p2p payments. By introducing just two tiers and automatic escrow/instant settlement logic, it dramatically improves buyer protection while maintaining minimal friction for proven merchants.
