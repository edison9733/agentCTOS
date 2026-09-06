# x402 Solana Scoring System

A Solana smart contract implementing a two-tier merchant scoring system (Low/High) for secure x402 payments with escrow protection.

## Overview

The x402 Scoring System solves the problem of payment risk in p2p transactions by:

1. **Merchant Registration**: Merchants are registered with an initial **Low** trust tier
2. **Risk-Based Payment Handling**:
   - **Low-tier merchants**: Payments held in escrow, released only after buyer confirms delivery
   - **High-tier merchants**: Instant payment settlement, no escrow delay
3. **Tier Management**: Merchants can be promoted to High tier based on successful delivery history

## Key Features

### Merchant Accounts
- **Address**: Merchant's public key
- **Tier**: Low or High (determines payment handling)
- **Total Payments**: Count of all transactions
- **Successful Deliveries**: Count of completed escrow releases
- **Escrow Balance**: Funds currently held in escrow

### Payment Lifecycle

#### For Low-Tier Merchants:
1. Buyer initiates payment → funds move to escrow
2. After delivery, buyer confirms delivery → funds released to merchant
3. If delivery fails, buyer can request refund

#### For High-Tier Merchants:
1. Buyer initiates payment → funds transferred directly to merchant (instant)
2. No escrow, no delays

### Instructions

#### `register_merchant`
Registers a new merchant account with Low tier status.
```
Parameters:
  - owner: Signer (merchant address)
```

#### `update_merchant_tier`
Updates merchant's trust tier (Low or High).
```
Parameters:
  - merchant: Merchant account to update
  - new_tier: 0 for Low, 1 for High
  - owner: Signer (must match merchant)
```

#### `initiate_payment`
Initiates payment transaction. Routes to escrow or direct payment based on merchant tier.
```
Parameters:
  - buyer: Signer
  - merchant: Target merchant account
  - buyer_token: Buyer's token account
  - merchant_token: Merchant's token account
  - escrow_token: Escrow holding account
  - amount: Payment amount in lamports
  - order_id: Unique order identifier
```

#### `confirm_delivery`
Confirms delivery and releases escrow funds to merchant (Low-tier only).
```
Parameters:
  - buyer: Signer (payment creator)
  - payment: Payment account to settle
  - order_id: Order identifier
```

#### `refund_escrow`
Refunds escrowed payment to buyer if delivery fails (Low-tier only).
```
Parameters:
  - buyer: Signer (payment creator)
  - payment: Payment account to refund
  - order_id: Order identifier
```

## Payment Statuses
- **Pending**: Payment initiated but not yet processed
- **EscrowHeld**: Funds held in escrow (Low-tier merchants)
- **Settled**: Payment completed
- **Refunded**: Payment refunded to buyer

## Security Considerations

1. **Access Control**: Only the buyer who initiated payment can confirm delivery or request refund
2. **Tier Authority**: Only the merchant can update their own tier
3. **Escrow Protection**: Low-tier merchants cannot access funds until buyer confirms
4. **Arithmetic Safety**: All math operations checked for overflow/underflow

## Building

```bash
anchor build
```

## Testing

```bash
anchor test
```

## Deployment

```bash
anchor deploy
```

## Architecture

### Accounts Involved
- **Merchant Account**: Stores merchant profile and statistics (PDA)
- **Payment Account**: Tracks individual payment transactions (PDA)
- **Token Accounts**: SPL token accounts for transfers
- **Escrow Account**: Holds funds for Low-tier merchant payments

### PDA Seeds
- **Merchant**: `[b"merchant", owner_pubkey]`
- **Payment**: `[b"payment", buyer_pubkey, merchant_pubkey, order_id]`

## Error Handling

- `InvalidMerchant`: Merchant account validation failed
- `InvalidTier`: Invalid tier value provided
- `InvalidPaymentStatus`: Payment status incompatible with operation
- `InvalidOrder`: Order ID mismatch
- `Unauthorized`: Signer not authorized for operation
- `ArithmeticOverflow`: Integer overflow detected
- `ArithmeticUnderflow`: Integer underflow detected
