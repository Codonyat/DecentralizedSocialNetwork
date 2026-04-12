# Token Y Protocol Design (`dsn-token-y`)

## Purpose

Token Y is the native utility token with a fixed 21M supply, enforced on-chain via smart contracts. This crate contains **pure computation** -- no I/O, no storage, no async. Smart contracts enforce all rules; this crate provides the math and validation logic that both clients and contracts rely on.

## Module Structure

```
crates/token-y/src/
  lib.rs
  emission.rs         # Halving math, emission_for_epoch()
  donation.rs         # Donation burn math, creator share, trust-distance weighting
  bonding.rs          # Bonding curve pricing, burn computation
  distribution.rs     # Per-epoch emission shares (donations -> emission allocation)
  name_registry.rs    # Name pricing, validation
  error.rs
```

All modules are **pure functions** over their inputs. No I/O, no storage, no async.

## A. Emission (`emission.rs`)

### Fixed Parameters

```rust
pub const TOTAL_SUPPLY: u64 = 21_000_000_000_000;  // 21M with 6 decimals
pub const INITIAL_EMISSION: u64 = 10_000_000_000;   // 10,000 Y/epoch
pub const HALVING_INTERVAL: u64 = 52;
pub const MAX_HALVINGS: u64 = 20;
```

### Emission Table (first 5 halvings)

| Epoch Range | Y per Epoch | Cumulative Y |
|---|---|---|
| 0-51 | 10,000 | 520,000 |
| 52-103 | 5,000 | 780,000 |
| 104-155 | 2,500 | 910,000 |
| 156-207 | 1,250 | 975,000 |
| 208-259 | 625 | 1,007,500 |

### Key Functions

```rust
/// Compute Y emission for a specific epoch.
/// Epochs are block-based; the smart contract determines boundaries.
pub fn emission_for_epoch(epoch: u64) -> u64 {
    let halvings = epoch / HALVING_INTERVAL;
    if halvings >= MAX_HALVINGS { return 0; }
    INITIAL_EMISSION >> halvings
}

/// Compute total Y emitted before a given epoch (sum of all prior epochs).
pub fn total_emitted_before_epoch(epoch: u64) -> u64;
```

Emission is distributed to creators proportional to weighted donations received during each epoch. A per-creator cap per epoch prevents any single creator from capturing all emission. Donor diversity weighting ensures that more unique donors at greater trust distances produce more weight.

## B. Donations (`donation.rs`)

A "like" is a micro-Y donation to a creator. Each donation is a pure loss for the donor, making it a strong quality signal.

### Mechanics

- A fraction of each donation is burned (removed from circulation permanently).
- The remainder goes to the creator.
- Donations are weighted by trust distance between donor and recipient for emission calculations (farther = more weight, preventing self-donation via sock puppets).

### Constants and Functions

```rust
pub const DONATION_BURN_RATE_BPS: u64 = 500; // 5%

pub fn compute_donation_split(amount: u64) -> DonationSplit {
    let burn = amount * DONATION_BURN_RATE_BPS / 10_000;
    let creator_share = amount - burn;
    DonationSplit { burn, creator_share }
}

pub struct DonationSplit {
    pub burn: u64,
    pub creator_share: u64,
}

/// Weight a donation for emission calculation based on trust distance.
/// Greater distance = more weight (harder to fake).
/// Graph distance 0 (self) = 0 weight.
/// Graph distance 1 (direct invitee/inviter) = 0.5 weight.
/// Graph distance 2+ = 1.0 weight (uncapped).
pub fn donation_weight(graph_distance: u32) -> f64;
```

All functions are pure -- they take inputs and return outputs with no side effects.

## C. Bonding (`bonding.rs`)

Users bond Y on posts they believe will attract future bonders.

### Mechanics

- The poster is the mandatory first bonder (skin in the game, spam deterrent).
- A percentage of every bond is burned (negative-sum).
- Bonding curve: later bonders pay more; early bonders profit from distributions of new bonds.
- Bonding is non-redeemable against the contract. Bonders do not "sell back." Instead, a portion of each new bond is distributed to previous bonders proportional to their position. The burned percentage is gone forever.

### Types and Functions

```rust
pub const BOND_BURN_RATE_BPS: u64 = 1_000; // 10%

pub struct BondingCurveState {
    pub total_bonded: u64,
    pub bond_count: u64,
    pub bonders: Vec<(PublicKey, u64)>, // (bonder, amount)
}

/// Compute the price of the next bond given the current curve state.
/// Linear curve: price = base_price + slope * total_bonded
pub fn bond_price(state: &BondingCurveState, base_price: u64, slope: u64) -> u64;

/// Compute how a new bond is distributed.
pub fn compute_bond_distribution(
    bond_amount: u64,
    state: &BondingCurveState,
) -> BondDistribution;

pub struct BondDistribution {
    pub burned: u64,
    pub to_previous_bonders: Vec<(PublicKey, u64)>, // proportional to existing bonds
}
```

All bonding functions are pure computation over the curve state.

## D. Distribution (`distribution.rs`)

Per-epoch emission shares are computed from donations.

### Mechanics

- Each creator's share = `weighted_donations_received / total_weighted_donations` applied to the epoch's emission.
- Weight for each donation = `donation_amount * donation_weight(graph_distance)`.
- Per-creator cap: no single creator receives more than `per_creator_cap_bps` of total emission in a single epoch.

### Key Function

```rust
/// Compute how the epoch's emission is distributed across creators.
/// Pure function: takes the epoch number and a list of donations, returns
/// a map of creator public key to Y amount earned.
pub fn compute_epoch_emission_shares(
    epoch: u64,
    donations: &[(PublicKey, PublicKey, u64, u32)], // (donor, creator, amount, graph_distance)
    per_creator_cap_bps: u64,
) -> HashMap<PublicKey, u64>;
```

No I/O -- the caller supplies all donation data and receives the result.

## E. Name Registry (`name_registry.rs`)

Users burn Y to claim a username on-chain. Names are permanent and resolve to a public key.

### Pricing Tiers

| Name Length | Cost (Y) |
|---|---|
| 1 char | 1,000,000 |
| 2 chars | 100,000 |
| 3 chars | 10,000 |
| 4 chars | 1,000 |
| 5+ chars | 100 |

### Validation Rules

- Lowercase alphanumeric characters and hyphens only.
- Length: 1-32 characters.
- No leading or trailing hyphens.
- No consecutive hyphens.
- Unicode normalization (NFKC) is applied before validation.

### Functions

```rust
/// Return the Y cost to register a name, based on its normalized length.
pub fn name_cost(name: &str) -> u64;

/// Validate and normalize a name. Returns the NFKC-normalized name on success.
pub fn validate_name(name: &str) -> Result<String, NameError>;
```

Both functions are pure -- no storage lookups. The smart contract checks name availability on-chain.

## Error Types (`error.rs`)

```rust
#[derive(Debug, thiserror::Error)]
pub enum TokenYError {
    #[error("insufficient balance: have {have}, need {need}")]
    InsufficientBalance { have: u64, need: u64 },

    #[error("invalid bond amount")]
    InvalidBondAmount,

    #[error("invalid donation amount")]
    InvalidDonationAmount,

    #[error("post not found")]
    PostNotFound,

    #[error("name already taken: {name}")]
    NameTaken { name: String },

    #[error("invalid name: {reason}")]
    InvalidName { reason: String },

    #[error("emission cap exceeded")]
    EmissionCapExceeded,
}

#[derive(Debug, thiserror::Error)]
pub enum NameError {
    #[error("name too long: {len} chars, max {max}")]
    TooLong { len: usize, max: usize },

    #[error("name too short")]
    TooShort,

    #[error("invalid character '{ch}' at position {position}")]
    InvalidCharacter { ch: char, position: usize },

    #[error("name must not start with a hyphen")]
    LeadingHyphen,

    #[error("name must not end with a hyphen")]
    TrailingHyphen,

    #[error("name must not contain consecutive hyphens")]
    ConsecutiveHyphens,
}
```
