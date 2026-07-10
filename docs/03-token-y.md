# Token Y Protocol Design (`dsn-token-y`)

## Purpose

Token Y is the native utility token. Supply is capped at 140,000,000,000 Y (140B, 6 decimals — `140_000_000_000_000_000` atomic units, which fits u64), enforced on-chain via smart contracts. Scheduled emission **asymptotically approaches** this hard cap; it is never reached exactly, since integer truncation leaves dust unminted. This crate contains **pure computation** -- no I/O, no storage, no async. Smart contracts enforce all rules; this crate provides the math and validation logic that both clients and contracts rely on.

## Module Structure

```
crates/token-y/src/
  lib.rs
  emission.rs         # Halving math, emission_for_epoch(), scheduled_plus_drip()
  reward_pool.rs      # Fee recycling, pool_drip()
  donation.rs         # Donation fee/creator split; weighting spec lives in 05-invitation.md
  bonding.rs          # Bonding curve pricing, fee-to-pool computation
  distribution.rs     # Per-epoch emission shares (donations -> emission allocation)
  name_registry.rs    # Handle claim/assess/rent/force-buy (Harberger tier), validation
  error.rs
```

All modules are **pure functions** over their inputs. No I/O, no storage, no async.

Every basis-point multiplication below uses **u128 intermediates** — `pool_balance * 200` and fee math overflow u64 at the 140B scale (see the arithmetic convention in [01-core-types.md](01-core-types.md)). Protocol **fees round up** (ceiling division, so no dust escapes fee-free); **payouts and the pool drip round down**.

## A. Emission (`emission.rs`)

### Fixed Parameters

```rust
pub const TOTAL_SUPPLY: u64 = 140_000_000_000_000_000; // 140B Y, 6 decimals; hard cap (tunable)
pub const INITIAL_EMISSION: u64 = 1_400_000_000_000_000; // 1.4B Y/epoch (tunable)
pub const HALVING_INTERVAL: u64 = 50; // epochs per halving; 1.4B x 50 x 2 = 140B ideal sum (tunable)
```

### Emission Table (first 5 halvings)

| Epoch Range | Y per Epoch | Cumulative Y |
|---|---|---|
| 0–49 | 1,400,000,000 | 70,000,000,000 |
| 50–99 | 700,000,000 | 105,000,000,000 |
| 100–149 | 350,000,000 | 122,500,000,000 |
| 150–199 | 175,000,000 | 131,250,000,000 |
| 200–249 | 87,500,000 | 135,625,000,000 |

Each halving adds half the previous window's total, so cumulative scheduled emission **asymptotically approaches 140B Y** without ever reaching it exactly. Integer truncation of the halved amounts leaves the final dust permanently unminted.

### Key Functions

```rust
/// Compute the *scheduled* Y emission for a specific epoch.
/// Epochs are event-based; the smart contract determines boundaries.
pub fn emission_for_epoch(epoch: u64) -> u64 {
    let halvings = epoch / HALVING_INTERVAL;
    // Shift-width safety: INITIAL_EMISSION (1.4e15) < 2^51, so the value is
    // already 0 from halving 51 onward. This guard prevents an over-wide
    // shift, NOT an economic cutoff -- the schedule asymptotically approaches
    // TOTAL_SUPPLY and emission simply becomes 0 dust here.
    if halvings >= 51 { return 0; }
    INITIAL_EMISSION >> halvings
}

/// Total Y scheduled to be minted before a given epoch (sum of all prior epochs).
pub fn total_emitted_before_epoch(epoch: u64) -> u64;

/// Per-epoch total available to creators = scheduled emission + Reward Pool drip.
/// u128 note applies via pool_drip; the sum saturates at u64::MAX defensively.
pub fn scheduled_plus_drip(epoch: u64, pool_balance: u64) -> u64 {
    emission_for_epoch(epoch).saturating_add(pool_drip(pool_balance))
}
```

The per-epoch total available to creators is **scheduled emission + pool drip** (§ Reward Pool). Only the scheduled part counts against the cumulative 140B cap; the drip redistributes tokens that were already minted. Any scheduled emission or drip left undistributed in an epoch (zero qualifying donations, per-creator caps binding) accrues back to the Reward Pool — no emission is orphaned.

**Bootstrap (epoch 0).** At launch nobody holds Y, so there are no donations to direct the first epoch's emission. Epoch 0's scheduled emission (1.4B Y) is instead split **equally among the deployer-seeded genesis accounts**. From epoch 1 onward, distribution is donation-directed (§D). This resolves the launch circularity without a premine — the genesis split lives inside the 140B schedule.

## Reward Pool (`reward_pool.rs`)

All protocol fees flow into a single Reward Pool: donation fees (5%), bond fees (10%), invitation costs, handle rent, force-buy fees, floor excesses from name takeovers, and rent arrears. No token is ever destroyed; every fee is **recycled** to the pool.

Each epoch the pool releases a **2% drip** (`REWARD_POOL_DRIP_BPS = 200`) of its balance, added to that epoch's scheduled creator emission (§D). Undistributed scheduled emission and undistributed drip both accrue back into the pool. As the halving schedule fades toward zero, the drip takes over: in the long run creator emission is entirely recycled fees, bounded by the hard 140B cap.

```rust
pub const REWARD_POOL_DRIP_BPS: u64 = 200; // 2% of pool balance per epoch (tunable)

/// Amount the Reward Pool releases into creator emission this epoch.
/// Payout: round DOWN. u128 intermediate -- balance * 200 overflows u64 at 140B scale.
pub fn pool_drip(pool_balance: u64) -> u64 {
    ((pool_balance as u128 * REWARD_POOL_DRIP_BPS as u128) / 10_000) as u64
}
```

## B. Donations (`donation.rs`)

A "like" is a micro-Y donation to a creator. Each donation is a pure loss for the donor, making it a strong quality signal.

### Mechanics

- A fraction of each donation is a **fee, recycled to the Reward Pool**.
- The remainder goes to the creator.
- Donations are weighted for emission by the donor's tree position relative to the recipient. The canonical weighting spec — pairwise weights plus lineage-family diminishing returns — is defined once in [05-invitation.md](05-invitation.md) and is **not** duplicated here.
- Donations below `MIN_DONATION` are invalid (dust would otherwise game eligibility gates and split-donation weighting).

### Constants and Functions

```rust
pub const DONATION_FEE_BPS: u64 = 500; // 5% fee, recycled to the Reward Pool (tunable)
pub const MIN_DONATION: u64 = 10_000;  // 0.01 Y; smaller donations are invalid (tunable)

/// Protocol fees round UP (ceiling division) so no dust escapes fee-free.
/// u128 intermediate: amount * bps overflows u64 near the supply cap.
fn ceil_fee(amount: u64, bps: u64) -> u64 {
    ((amount as u128 * bps as u128 + 9_999) / 10_000) as u64
}

pub fn compute_donation_split(amount: u64) -> DonationSplit {
    let fee = ceil_fee(amount, DONATION_FEE_BPS);
    let creator_share = amount - fee;
    DonationSplit { fee, creator_share }
}

pub struct DonationSplit {
    pub fee: u64,          // recycled to the Reward Pool
    pub creator_share: u64,
}
```

All functions are pure -- they take inputs and return outputs with no side effects.

**Donor Recognition.** At the protocol level a donation stays a pure financial loss for the donor; the quality-signal property depends on it. Any social recognition of donors — superchat-style thread prominence, supporter badges, lifetime-donated leaderboards — is a client/indexer convention computed from public chain data (specified in [07-indexer.md](07-indexer.md)), never an on-chain reward.

## C. Bonding (`bonding.rs`)

Users bond Y on posts they believe will attract future bonders.

### Mechanics

- The poster is the mandatory first bonder — the spam deterrent: posting genuinely costs Y, put at risk.
- The **first bond is paid entirely into the Reward Pool** (there are no previous bonders to receive it) and establishes the poster's curve position at the full bond amount. The position is funded, not a free book entry.
- A 10% **fee** on every subsequent bond is recycled to the Reward Pool; the remaining 90% is distributed to previous bonders proportional to their positions.
- Bonding curve: later bonders pay more; early bonders profit from distributions of new bonds.
- Bonding is non-redeemable against the contract. Bonders do not "sell back"; they earn only from later bonders' distributions.

### Types and Functions

```rust
pub const BOND_FEE_BPS: u64 = 1_000; // 10% fee, recycled to the Reward Pool (tunable)

pub struct BondingCurveState {
    pub total_bonded: u64,
    pub bond_count: u64,
    pub bonders: Vec<(PublicKey, u64)>, // (bonder, amount)
}

/// Compute the price of the next bond given the current curve state.
/// Linear curve: price = base_price + slope * total_bonded
pub fn bond_price(state: &BondingCurveState, base_price: u64, slope: u64) -> u64;

/// Compute how a new bond is distributed.
/// First bond (empty curve): entire amount -> Reward Pool; position established
///   at the full amount (funded, not free).
/// Subsequent bonds: BOND_FEE_BPS (10%) -> pool, remainder -> previous bonders pro rata.
pub fn compute_bond_distribution(
    bond_amount: u64,
    state: &BondingCurveState,
) -> BondDistribution;

pub struct BondDistribution {
    pub fee_to_pool: u64,
    pub to_previous_bonders: Vec<(PublicKey, u64)>, // proportional to existing bonds
}
```

All bonding functions are pure computation over the curve state.

## D. Distribution (`distribution.rs`)

Per-epoch emission shares are computed from donations.

### Mechanics

- The epoch's distributable emission = **scheduled emission + pool drip** (§A, § Reward Pool), computed before splitting.
- Each creator's share = `weighted_donations_received / total_weighted_donations` applied to that distributable emission.
- Weight for each donation = `donation_amount * pairwise_weight`, further shaped by lineage-family diminishing returns. Both are defined canonically in [05-invitation.md](05-invitation.md); this crate consumes precomputed weight + lineage-family id per donation.
- Per-creator cap: no single creator receives more than `per_creator_cap_bps` of the distributable emission in a single epoch.
- Any amount left undistributed (per-creator caps binding, or zero qualifying donations) accrues back to the Reward Pool.

### Key Function

```rust
/// Compute how the epoch's emission is distributed across creators.
/// Pure function: takes the epoch, the pool balance (for the drip), and a list of
/// donations with precomputed weighting, returns a map of creator to Y earned.
/// The lineage-family id and pairwise weight come from the invitation tree (see 05).
pub fn compute_epoch_emission_shares(
    epoch: u64,
    pool_balance: u64,
    donations: &[(PublicKey, PublicKey, u64, f64, PublicKey)], // (donor, creator, amount, pairwise_weight, lineage_family)
    per_creator_cap_bps: u64,
) -> HashMap<PublicKey, u64>;
```

No I/O -- the caller supplies all donation data and the pool balance, and receives the result. Undistributed remainder is reported to the caller to route back into the pool.

## E. Name Registry (`name_registry.rs`)

Names are a **two-layer model**: a free off-chain display name and an optional on-chain rented @handle.

### Display Name

Off-chain, free, non-unique, purely cosmetic. Unchanged from before — it is metadata a client renders, carries no on-chain state, and is not part of anyone's canonical identity (see the Identity Principle in [01-core-types.md](01-core-types.md)).

### @handle (on-chain)

A unique, on-chain handle that resolves to a public key. Handles are **rented, not purchased** — there is no one-time cost and no permanent ownership.

- **Claim** an unowned handle by setting an assessed value `V` (mandatory `>= floor` for lengths 1–6; omitted and stored as `0` for the flat tier, where `V` is meaningless) and paying the first epoch's rent at claim time.
- `V` may be raised at any time. Decreases take effect only after `LOOKBACK_EPOCHS` (via `pending_assessment`), so an owner cannot dodge a force-buy by dropping `V` the moment a bid lands.
- Rent is due every epoch and flows to the Reward Pool. Nonpayment triggers a `GRACE_EPOCHS` (4) grace period; after that the handle lapses to unowned.

**Harberger tier (lengths 1–6).** Rent per epoch = `HANDLE_RENT_RATE_BPS × max(V, assessment_floor(len))`.

| Handle Length | Assessment Floor (Y) |
|---|---|
| 1–2 chars | 1,000,000 |
| 3–4 chars | 100,000 |
| 5–6 chars | 10,000 |

Assessing below the floor earns nothing on a takeover (see the waterfall) while still paying floor-based rent, so rational owners assess `>= floor`.

**Flat tier (lengths ≥ 7).** Rent = **1 Y/epoch**, identical for ALL lengths ≥ 7; no assessed value, no force-buy (safe harbor). Rationale: past 6 characters the namespace is effectively infinite, so length stops measuring scarcity. Flat rent does three jobs with one number — it imposes a cost on bulk-hoarding, recycles abandoned handles (via lapse), and yields pool revenue. Accepted leak: dictionary-word squatting, since length cannot price desirability; only a Harberger assessment could, and the safe harbor from force-buys matters more for ordinary users.

**Force-buy (Harberger tier only).** A challenger triggers a takeover by escrowing a bid = `max(V, floor)` and paying a **1% non-refundable fee** (`FORCE_BUY_FEE_BPS`) to the pool — skin in the game against griefing ratchets. The bid is escrowed for the `NOTICE_WINDOW_EPOCHS` (1) notice window. The owner may **cancel** by raising `V` to `>= 110%` of the bid (`RAISE_PREMIUM_BPS`) and paying the retroactive rent difference on the increase over `LOOKBACK_EPOCHS` (a +1-atomic raise no longer cancels for free). Otherwise the transfer executes and the escrowed bid is allocated by the amendment-3 **waterfall** — arrears to the pool first, then `min(V, remainder)` to the outgoing owner, remainder to the pool — which can never exceed the escrowed bid nor underflow. Flat-tier handles have no force-buy.

### Validation Rules

- Lowercase alphanumeric characters and hyphens only.
- Length: 1–32 characters (`MAX_HANDLE_CHARS`).
- No leading or trailing hyphens; no consecutive hyphens.
- Unicode normalization (NFKC) is applied before validation.
- Claim succeeds only if the handle is currently unowned; `V >= floor` for lengths 1–6; the flat tier ignores `V`.

### Types and Functions

```rust
pub const HANDLE_RENT_RATE_BPS: u64 = 10;    // 0.1%/epoch of max(V, floor); Harberger tier (tunable)
pub const FLAT_HANDLE_RENT: u64 = 1_000_000; // 1 Y/epoch for ALL handles >= 7 chars (tunable)
pub const NOTICE_WINDOW_EPOCHS: u64 = 1;     // force-buy escrow window (tunable)
pub const LOOKBACK_EPOCHS: u64 = 26;         // assessment-decrease / cancel-raise settle delay (tunable)
pub const GRACE_EPOCHS: u64 = 4;             // rent grace before lapse (tunable)
pub const FORCE_BUY_FEE_BPS: u64 = 100;      // 1% non-refundable bid fee -> pool (tunable)
pub const RAISE_PREMIUM_BPS: u64 = 1_000;    // cancel requires V >= 110% of the bid (tunable)

pub struct NameRecord {
    pub owner: PublicKey,
    pub handle: String,
    pub assessed_value: u64,                    // V; 0 in the flat tier (meaningless there)
    pub pending_assessment: Option<(u64, u64)>, // (value, effective_epoch); decreases settle after LOOKBACK
    pub force_buy: Option<ForceBuy>,
    pub claimed_at_epoch: u64,
    pub rent_paid_through_epoch: u64,
}

pub struct ForceBuy {
    pub bidder: PublicKey,
    pub bid: u64,           // escrowed for NOTICE_WINDOW_EPOCHS
    pub deadline_epoch: u64,
}

pub struct ForceBuyWaterfall {
    pub arrears_to_pool: u64,
    pub to_owner: u64,
    pub excess_to_pool: u64,
}

/// Rent/force-buy floor for a Harberger-tier handle, in atomic Y. None for the flat tier.
pub fn assessment_floor(len: usize) -> Option<u64> {
    match len {
        1..=2 => Some(1_000_000_000_000), // 1,000,000 Y
        3..=4 => Some(100_000_000_000),   //   100,000 Y
        5..=6 => Some(10_000_000_000),    //    10,000 Y
        _ => None,                         // flat tier, len >= 7
    }
}

pub fn is_harberger_tier(len: usize) -> bool { len <= 6 }

/// Rent owed per epoch, in atomic Y.
/// Harberger tier: round-down(rate * max(V, floor)). Flat tier: FLAT_HANDLE_RENT (1 Y), V ignored.
pub fn handle_rent_per_epoch(len: usize, assessed_value: u64) -> u64 {
    match assessment_floor(len) {
        Some(floor) => {
            let base = assessed_value.max(floor);
            ((base as u128 * HANDLE_RENT_RATE_BPS as u128) / 10_000) as u64
        }
        None => FLAT_HANDLE_RENT, // 1 Y/epoch, identical for all lengths >= 7
    }
}

/// Bid a challenger must escrow to force-buy = max(V, floor). Harberger tier only.
pub fn force_buy_price(record: &NameRecord) -> u64;

/// Allocate the escrowed bid on a completed force-buy. Never exceeds `bid`,
/// never underflows. `arrears` = unpaid rent accrued by the outgoing owner.
pub fn force_buy_waterfall(record: &NameRecord, bid: u64) -> ForceBuyWaterfall {
    let arrears = record.arrears();
    let arrears_to_pool = arrears.min(bid);
    let to_owner = record.assessed_value.min(bid - arrears_to_pool);
    let excess_to_pool = bid - arrears_to_pool - to_owner;
    ForceBuyWaterfall { arrears_to_pool, to_owner, excess_to_pool }
}

/// Minimum V an owner must raise to (>= 110% of the bid) to cancel a pending force-buy.
pub fn cancel_raise_minimum(bid: u64) -> u64 {
    ((bid as u128 * (10_000 + RAISE_PREMIUM_BPS) as u128 + 9_999) / 10_000) as u64
}

/// Validate and NFKC-normalize a handle. Returns the normalized handle on success.
pub fn validate_handle(handle: &str) -> Result<String, NameError>;
```

All functions are pure -- no storage lookups. The smart contract checks handle availability, escrow, and rent state on-chain.

## Economic Design

**Fee-recycling equilibrium.** Every protocol fee — donation (5%), bond (10%), invitation cost, handle rent, force-buy fees, floor excesses, rent arrears — flows into the Reward Pool, which drips 2% of its balance per epoch back into creator emission. Because those fees are assessed as a fraction of value that tracks real economic activity (donations, bonds, rent on desirable handles), the Y-denominated fee flow scales with activity and price. As scheduled emission halves toward zero, the pool drip takes over, so in the long run **every fee becomes creator rewards, under a hard 140B cap**. This closes a feedback loop: higher activity feeds a larger pool, a larger drip rewards more creators, and circulating supply moves countercyclically — heavy-fee epochs pull Y into the pool, the drip releases it steadily — damping price swings so price tracks activity/emission rather than spiking.

**Why halving-to-zero was rejected.** A pure halving schedule that terminates emission and permanently removes fee tokens from supply starves the system once the schedule fades: the creator subsidy that pays for curation dies, and a fixed, permanently shrinking float rewards hoarding over participation (holding Y beats spending it — a deflationary trap). Recycling fees through the pool instead keeps a perpetual creator subsidy alive under the cap without ever minting past 140B and without permanent supply destruction.

**Wash-trading is an open risk (simulation-required before launch).** A controller who donates between related accounts they control pays ~5% in fees and receives 0.25-weighted claims on emission (the ancestor/descendant pairwise weight). Whether this is net-profitable depends on the emission-per-weighted-Y rate versus that fee: if a self-donated Y earns back more than roughly the fee in emission share, the loop is positive. Four mechanisms bound it — the 0.25 weight (4× less efficient than an honest arm's-length donation), lineage-family collapse (all of a controller's sybils share one depth-2 ancestor and count as a single family; see [05-invitation.md](05-invitation.md)), the per-creator emission cap, and per-invitation costs — but none proves it impossible. The parameters that set the margin (per-creator cap, `BRANCH_FAMILY_EXPONENT`, fee rate) MUST be tuned by simulation before launch; we document the profitability condition rather than claim immunity. See [05-invitation.md](05-invitation.md) Anti-Gaming for the matching treatment.

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

    #[error("donation below minimum: {amount} < {min}")]
    DonationBelowMinimum { amount: u64, min: u64 },

    #[error("post not found")]
    PostNotFound,

    #[error("name already taken: {name}")]
    NameTaken { name: String },

    #[error("invalid name: {reason}")]
    InvalidName { reason: String },

    #[error("assessed value below tier floor: {value} < {floor}")]
    AssessmentBelowFloor { value: u64, floor: u64 },

    #[error("handle rent unpaid")]
    RentUnpaid,

    #[error("handle has lapsed to unowned")]
    HandleLapsed,

    #[error("force-buy not allowed on the flat tier (safe harbor)")]
    ForceBuyNotAllowedFlatTier,

    #[error("a force-buy is already pending on this handle")]
    ForceBuyPending,

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
