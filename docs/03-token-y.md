# Token Y Protocol Design (`dsn-token-y`)

## Purpose

Token Y is the native token with a fixed 21M supply, enforced on-chain via the
contract suite (doc 11 §1.1). This crate contains **pure computation** — no
I/O, no storage, no async. Smart contracts enforce all rules; this crate
provides the math and validation logic that clients, indexers, and contracts
all rely on.

The economic design follows the **monetary constitution** (doc 10 §2): every
rule in this document is objective, deterministic, and immutable at genesis.
Nothing in the money layer measures a subjective quantity (doc 09 §3).
There is no bonding, no donation-weighted emission, and no social metric
anywhere in this crate — see doc 09 §2.1–2.3 for why those were removed.

## Module Structure

```
crates/token-y/src/
  lib.rs
  supply.rs           # Total supply, allocation buckets, rebate drop schedule
  tips.rs             # Tip split math (transfer + flat burn)
  fees.rs             # Protocol fee sinks: invitation, promotion; referral split
  name_registry.rs    # Name pricing, renewal, expiry, validation
  rebate.rs           # Usage rebate pool: per-epoch pro-rata distribution
  referral.rs         # Referral annuity math (10% of direct invitees' fees)
  error.rs
```

All modules are **pure functions** over their inputs. No I/O, no storage, no async.

## A. Supply & Allocation (`supply.rs`)

### Fixed Parameters

```rust
pub const TOTAL_SUPPLY: u64 = 21_000_000_000_000; // 21M with 6 decimals

/// Pure fair launch (doc 14, D5): 100% of supply is earned. There are NO
/// team, treasury, foundation, sale, or discretionary-drop buckets.
/// Ratios are constitutional; minted once at genesis into their contracts.
pub const USAGE_REBATE_POOL: u64   = 15_750_000_000_000; // 75% — RebatePool contract
pub const SERVICE_POOL: u64        =  5_250_000_000_000; // 25% — ServiceRegistry reward pool
```

There is no mint function outside these two pools. Once they are exhausted,
distribution is over; from then on supply only shrinks (burns). The contract
deployer (the "steward" of doc 09 §3) receives zero tokens and retains zero
keys after deployment.

### Rebate Drop Schedule

Epochs are block-based, targeting ~1 week (doc 00). The usage rebate pool
pays a scheduled per-epoch drop with 2-year halvings:

```rust
pub const INITIAL_REBATE_DROP: u64 = 75_000_000_000; // 75,000 Y/epoch
pub const REBATE_HALVING_INTERVAL: u64 = 104;        // epochs (~2 years)
pub const MAX_REBATE_HALVINGS: u64 = 20;

/// Service pool drop follows the same halving shape at 1/3 the size.
pub const INITIAL_SERVICE_DROP: u64 = 25_000_000_000; // 25,000 Y/epoch

/// Y dropped by the rebate pool in a given epoch.
pub fn rebate_drop_for_epoch(epoch: u64) -> u64 {
    let halvings = epoch / REBATE_HALVING_INTERVAL;
    if halvings >= MAX_REBATE_HALVINGS { return 0; }
    INITIAL_REBATE_DROP >> halvings
}

/// Total dropped before a given epoch (for pool accounting).
pub fn total_dropped_before_epoch(epoch: u64) -> u64;
```

| Epoch Range | Rebate Y/Epoch | Cumulative Rebates | Service Y/Epoch |
|---|---|---|---|
| 0–103 | 75,000 | 7,800,000 | 25,000 |
| 104–207 | 37,500 | 11,700,000 | 12,500 |
| 208–311 | 18,750 | 13,650,000 | 6,250 |
| 312–415 | 9,375 | 14,625,000 | 3,125 |
| 416–519 | 4,687.5 | 15,112,500 | 1,562.5 |

Geometric-series dust remaining in the pool after `MAX_REBATE_HALVINGS` is
burned in the final epoch (deterministic close-out).

## B. Tips (`tips.rs`)

A tip is the atomic social-economic act: a transfer of **existing** Y from
fan to creator with a small flat burn. Nothing is minted against tips
(doc 10 §1.1), so wash-tipping is strictly lossy and pointless.

### Mechanics

- `TIP_BURN_RATE_BPS` of each tip is burned; the remainder goes to the creator.
- Each tip carries a 32-byte memo — the content address of the post it
  rewards — so indexers can attribute tips to content (doc 11 §1.2).
- Privacy: clients SHOULD send tips from one-time derived sender keys
  (doc 09 §2.7) so the public ledger records flows without a linkable donor
  identity by default.
- Tip burns are **not** rebate-eligible (§E): rebating them would subsidize
  fake tip volume and corrupt the tip signal indexers use for ranking.

### Constants and Functions

```rust
pub const TIP_BURN_RATE_BPS: u64 = 100; // 1%

pub fn compute_tip_split(amount: u64) -> TipSplit {
    let burn = amount * TIP_BURN_RATE_BPS / 10_000;
    let creator_share = amount - burn;
    TipSplit { burn, creator_share }
}

pub struct TipSplit {
    pub burn: u64,
    pub creator_share: u64,
}
```

## C. Protocol Fees & Referral Split (`fees.rs`, `referral.rs`)

All protocol fees (invitations, promotions, name registration/renewal) route
through one deterministic split: if the payer has an inviter within the
referral term, 10% of the fee goes to that inviter and 90% burns; otherwise
100% burns.

```rust
pub const REFERRAL_SHARE_BPS: u64 = 1_000; // 10% of fees to the direct inviter
pub const REFERRAL_TERM_EPOCHS: u64 = 208; // ~4 years from the invitee's invitation

pub struct FeeSplit {
    pub referral_share: u64, // 0 if no eligible inviter
    pub burned: u64,
}

/// Split a protocol fee between the payer's inviter (if within term) and burn.
pub fn compute_fee_split(
    fee: u64,
    invited_at_epoch: Option<u64>,
    current_epoch: u64,
) -> FeeSplit;
```

Properties (doc 10 §3.3): objective, oracle-free, depth-1 only (no
compounding tree income), and unfakeable at a profit — routing your own fees
through a Sybil invitee returns 10% of money that was 100% yours.

### Fee Sinks

```rust
/// Flat cost to issue an invitation (doc 05).
pub const INVITATION_COST_Y: u64 = 100_000_000; // 100 Y

/// Promotion: pay-to-amplify. The full amount is a fee (routed through
/// compute_fee_split, i.e. ≥90% burned). No return path — an advertising
/// cost, not an investment (replaces bonding, doc 09 §2.3).
pub fn validate_promotion(amount: u64, min_promotion: u64) -> Result<(), TokenYError>;
```

Posting, following, replying, and reading carry **no protocol fee** — costs
sit on amplification and scarce namespace, never on existence (doc 10 §1.2).

## D. Name Registry (`name_registry.rs`)

Users pay Y (via the fee split) to claim a unique name, and an annual renewal
to keep it. Names that lapse past a grace period expire and become
registrable again (doc 09 §2.8: fixes squatting, lost keys, and gives the
sink an ongoing life).

### Pricing Tiers

Registration includes the first year. Renewal costs the same tier price per
year.

| Name Length | Registration (Y) | Renewal (Y/year) |
|---|---|---|
| 1 char | 1,000,000 | 1,000,000 |
| 2 chars | 100,000 | 100,000 |
| 3 chars | 10,000 | 10,000 |
| 4 chars | 1,000 | 1,000 |
| 5+ chars | 100 | 100 |

```rust
pub const NAME_TERM_EPOCHS: u64 = 52;       // one year of exclusivity per payment
pub const NAME_GRACE_PERIOD_EPOCHS: u64 = 4; // renewal window after expiry

/// Return the Y cost to register or renew a name for one term.
pub fn name_cost(name: &str) -> u64;

/// A name lapses when current_epoch > paid_through + grace period.
pub fn is_name_expired(paid_through_epoch: u64, current_epoch: u64) -> bool {
    current_epoch > paid_through_epoch + NAME_GRACE_PERIOD_EPOCHS
}
```

### Validation Rules

- Lowercase alphanumeric characters and hyphens only.
- Length: 1–32 characters.
- No leading or trailing hyphens; no consecutive hyphens.
- Unicode normalization (NFKC) applied before validation.

```rust
/// Validate and normalize a name. Returns the NFKC-normalized name on success.
pub fn validate_name(name: &str) -> Result<String, NameError>;
```

The smart contract checks availability (including expiry of previous
registrations) on-chain. Names resolve to an **identity** (doc 01), not a raw
key, so key rotation does not orphan names.

## E. Usage Rebate Distribution (`rebate.rs`)

Each epoch's drop (§A) is distributed **pro-rata to protocol fees burned that
epoch** by each account (doc 10 §3.2.1). This is the "smart distribution to
early adopters": while `drop > total fees`, real usage is rebated at >100% —
the early network is effectively free — decaying smoothly to full price as
adoption grows. Its fully-adversarial equilibrium is a continuous token sale
at market price (see doc 10 §3.2.1 for the analysis), and Sybil-splitting
across accounts changes a pro-rata share by exactly zero.

### Eligible Fees (constitutional exclusion list, doc 10 §3.2.1)

| Fee | Rebate-eligible? | Rationale |
|---|---|---|
| Name registration | yes | pure burn |
| Name renewal (first year of a given name) | yes | pure burn |
| Name renewal (subsequent years) | **no** | gives squat-harvesting a carrying cost |
| Invitation | yes | pure burn |
| Promotion | yes | pure burn |
| Tip burns | **no** | protects tip-signal integrity |
| Any resource-consuming fee (e.g. future storage rent) | **no** | rebating would manufacture spam load |

### Key Function

```rust
/// Compute the epoch's rebate distribution.
/// Pure function: takes the eligible fees burned per account this epoch,
/// returns each account's share of the epoch drop.
pub fn compute_epoch_rebates(
    epoch: u64,
    eligible_fees_burned: &[(PublicKey, u64)],
) -> HashMap<PublicKey, u64>;
```

No caps, no weights, no identity logic — pro-rata over burned amounts is the
entire mechanism, and that simplicity is what makes it Sybil-immune.

## F. Referral Annuity Accounting (`referral.rs`)

```rust
/// Whether an invitee's fees still pay their inviter.
pub fn referral_active(invited_at_epoch: u64, current_epoch: u64) -> bool {
    current_epoch < invited_at_epoch + REFERRAL_TERM_EPOCHS
}

/// The inviter's cut of a fee (0 if term elapsed or genesis account).
pub fn referral_cut(fee: u64) -> u64 {
    fee * REFERRAL_SHARE_BPS / 10_000
}
```

## Error Types (`error.rs`)

```rust
#[derive(Debug, thiserror::Error)]
pub enum TokenYError {
    #[error("insufficient balance: have {have}, need {need}")]
    InsufficientBalance { have: u64, need: u64 },

    #[error("invalid tip amount")]
    InvalidTipAmount,

    #[error("promotion below minimum: {amount} < {min}")]
    PromotionBelowMinimum { amount: u64, min: u64 },

    #[error("post not found")]
    PostNotFound,

    #[error("name already taken: {name}")]
    NameTaken { name: String },

    #[error("name expired; must re-register: {name}")]
    NameExpired { name: String },

    #[error("invalid name: {reason}")]
    InvalidName { reason: String },

    #[error("rebate pool exhausted")]
    RebatePoolExhausted,
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

## Anti-Gaming Analysis

Every distribution channel passes the doc 10 §3.1 test (*"the fully-gamed
equilibrium must still be an acceptable outcome"*):

- **Wash tips**: burn 1% to move your own money, mint nothing. Strictly lossy.
  Self-tipping to climb an indexer's tip-ranked feed is paid promotion at
  full price — an ad buy, not an exploit.
- **Rebate harvesting**: profitable only while `drop > total fees`; the
  equilibrium is buying tokens from the protocol at market price. Sybil
  accounts are irrelevant to a pro-rata share.
- **Referral self-dealing**: paying your own fees through a Sybil invitee
  returns 10% of your own money. Strictly lossy.
- **Name squatting**: recurring renewal cost per name per year, and renewals
  after year one are rebate-ineligible, so a large squat portfolio bleeds Y
  forever.
- **What no longer exists**: bonding curves (pyramid, doc 09 §2.3) and
  donation-weighted emission (mining equilibrium at `D ≈ 20E`, doc 09 §2.1).
  Nothing in this crate mints against a social metric.
