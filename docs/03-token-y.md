# Token Y Protocol Design (`dsn-token-y`)

## Purpose

Token Y is the native utility token. Supply is capped at 140,000,000,000 Y (140B, 6 decimals — `140_000_000_000_000_000` atomic units, which fits u64), enforced on-chain via smart contracts. Scheduled emission **asymptotically approaches** this hard cap; it is never reached exactly, since integer truncation leaves dust unminted. This crate contains **pure computation** -- no I/O, no storage, no async. Smart contracts enforce all rules; this crate provides the math and validation logic that both clients and contracts rely on.

## Module Structure

```
crates/token-y/src/
  lib.rs
  emission.rs         # Halving math, emission_for_epoch(), scheduled_plus_drip()
  reward_pool.rs      # Fee recycling, gross_drip(), treasury/creator drip split
  donation.rs         # Donation fee/creator split; weighting spec lives in 05-invitation.md
  distribution.rs     # Per-epoch emission shares + match cap (donations -> emission allocation)
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
pub const EMISSION_MATCH_CAP_BPS: u64 = 400; // 4%; a creator's epoch emission <= 4% of their raw weighted donations; MUST stay < DONATION_FEE_BPS (tunable)
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

/// Per-epoch total available to creators = scheduled emission + the creator
/// share of the Reward Pool drip (`creator_drip` = gross drip minus the
/// treasury slice; see § Reward Pool). u128 note applies via gross_drip; the
/// sum saturates at u64::MAX defensively.
pub fn scheduled_plus_drip(epoch: u64, pool_balance: u64) -> u64 {
    emission_for_epoch(epoch).saturating_add(creator_drip(epoch, pool_balance))
}
```

The per-epoch total available to creators is **scheduled emission + creator drip** (`creator_drip` = the pool's gross drip minus the treasury slice; § Reward Pool). Only the scheduled part counts against the cumulative 140B cap; the drip redistributes tokens that were already minted. Any scheduled emission or undistributed creator drip left over in an epoch (zero qualifying donations, the emission match cap binding) accrues back to the Reward Pool — no emission is orphaned. With the match cap (§C), early-epoch emission defers to the pool when organic volume is small: the launch-window inversion of the halving schedule — maximum scheduled emission exactly when the network is smallest — is closed by construction. The pool's 2% drip runs every epoch regardless; organic donation volume determines how much of scheduled emission + drip can actually be released through the cap.

**Bootstrap (epoch 0).** At launch nobody holds Y, so there are no donations to direct the first epoch's emission. Epoch 0's scheduled emission (1.4B Y) is instead split **equally among the deployer-seeded genesis accounts**. From epoch 1 onward, distribution is donation-directed (§C). This resolves the launch circularity without a premine — the genesis split lives inside the 140B schedule.

## Reward Pool (`reward_pool.rs`)

All protocol fees flow into a single Reward Pool: donation fees (5%), invitation costs, handle rent, force-buy fees, floor excesses from name takeovers, and rent arrears. No token is ever destroyed; every fee is **recycled** to the pool.

Each epoch the pool releases a **2% gross drip** (`REWARD_POOL_DRIP_BPS = 200`) of its balance. That gross drip is split into a **treasury slice** and the **creator drip** (`gross_drip − treasury_slice`), the latter added to that epoch's scheduled creator emission (§A, §C). Undistributed scheduled emission and undistributed creator drip both accrue back into the pool. As the halving schedule fades toward zero, the drip takes over: in the long run creator emission is entirely recycled fees, bounded by the hard 140B cap.

**Treasury slice.** `TREASURY_DRIP_SHARE_BPS = 1500` (15%) of the gross drip routes to a single disclosed Treasury address for the first `TREASURY_TERM_EPOCHS = 260` epochs (~5 years); after that the slice is `0` and 100% of the drip goes to creators. The Treasury holds **tokens, not powers** — a plain address whose funds reference the client, hosting, audits, and grants, with spending disclosed; it confers no protocol privileges. Any balance still sitting at the Treasury address at epoch `TREASURY_RECLAIM_EPOCH = 416` (~8 years) auto-returns to the Reward Pool. This is a time-boxed slice of an already-minted drip, **not** a premine (see Economic Design).

```rust
pub const REWARD_POOL_DRIP_BPS: u64 = 200;       // 2% of pool balance per epoch (tunable)
pub const TREASURY_DRIP_SHARE_BPS: u64 = 1_500;  // 15% of the gross drip -> Treasury (tunable); mirrors EpochConfig
pub const TREASURY_TERM_EPOCHS: u64 = 260;       // treasury slice active ~5y, then 0 (tunable); mirrors EpochConfig
pub const TREASURY_RECLAIM_EPOCH: u64 = 416;     // unspent treasury auto-returns to the pool ~8y (tunable); mirrors EpochConfig

/// Gross drip the Reward Pool releases each epoch, before the treasury split.
/// Payout: round DOWN. u128 intermediate -- balance * 200 overflows u64 at 140B scale.
pub fn gross_drip(pool_balance: u64) -> u64 {
    ((pool_balance as u128 * REWARD_POOL_DRIP_BPS as u128) / 10_000) as u64
}

/// Treasury slice of this epoch's gross drip: 15% until TREASURY_TERM_EPOCHS,
/// then 0. Round DOWN.
pub fn treasury_slice(epoch: u64, pool_balance: u64) -> u64 {
    if epoch >= TREASURY_TERM_EPOCHS { return 0; }
    ((gross_drip(pool_balance) as u128 * TREASURY_DRIP_SHARE_BPS as u128) / 10_000) as u64
}

/// Creator share of this epoch's gross drip = gross_drip - treasury_slice.
/// Folded into creator emission by `scheduled_plus_drip` (§A).
pub fn creator_drip(epoch: u64, pool_balance: u64) -> u64 {
    gross_drip(pool_balance) - treasury_slice(epoch, pool_balance)
}
```

## B. Donations (`donation.rs`)

A "like" is a micro-Y donation to a creator. Each donation is a pure loss for the donor, making it a strong quality signal.

### Mechanics

- A fraction of each donation is a **fee, recycled to the Reward Pool**.
- The remainder goes to the creator.
- Donations are weighted for emission by the donor's tree position relative to the recipient. The canonical weighting spec — pairwise weights plus lineage-family diminishing returns — is defined once in [05-invitation.md](05-invitation.md) and is **not** duplicated here.
- Donations below `MIN_DONATION` are invalid (dust would otherwise game split-donation weighting).

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

**Private donations.** A supporter who wants to give without linking the gift to their main identity signs it from a **fresh standalone keypair** — a brand-new account with no position in the invitation tree (nothing is derived from another key). Because the donor is outside the tree, its `pairwise_weight` is **0.0** by construction (see [05-invitation.md](05-invitation.md)), so the donation directs no emission; the 5% pool fee and the creator's share are **unchanged**. Such donors surface only as anonymous supporters in client/indexer recognition features (see [07-indexer.md](07-indexer.md)). No tree membership is required to donate — the 0.0 weight is the only gate. Honesty caveats: this is unlinkability **at the donation layer**, not chain-analysis resistance — the funding transfer that seeds the fresh keypair is public, so an observer who traces that funding can still de-anonymize it; and because the sponsored-gas paymaster only covers invited accounts, a private donor **pays their own gas**.

## C. Distribution (`distribution.rs`)

Per-epoch emission shares are computed from donations, subject to a per-creator **emission match cap**.

### Mechanics

- The epoch's distributable emission = **scheduled emission + creator drip** (§A, § Reward Pool), computed before splitting.
- Each creator's share is proportional to their **concave family weight** — `donation_amount * pairwise_weight`, further shaped by lineage-family diminishing returns. Both are defined canonically in [05-invitation.md](05-invitation.md); this crate consumes the precomputed pairwise weight + lineage-family id per donation.
- **Emission match cap.** A creator's emission for an epoch is capped at `floor(EMISSION_MATCH_CAP_BPS × RW / 10_000)`, where `RW` is that creator's **raw weighted donation sum** for the epoch (`Σ pairwise_weight × gross donation amount`, computed **before** the lineage-family concavity). At `EMISSION_MATCH_CAP_BPS = 400` (4%) a creator can never mint more than 4% of the weighted donation volume they actually received. The deployment-time invariant **`EMISSION_MATCH_CAP_BPS < DONATION_FEE_BPS`** keeps the cap strictly below the 5% donation fee, so any closed donation loop is a guaranteed net loss (see Economic Design).
- **Single-pass allocation.** Shares are assigned proportional to the concave family weights, then each creator's share is clipped at their cap. There is **no redistribution** after clipping: the clipped remainder, plus any emission left undistributed (zero qualifying donations), accrues back to the Reward Pool via the existing accrual mechanism.
- u128 intermediates throughout; the cap payout rounds **DOWN** while fees round **UP** (§ Donations), so rounding never opens a profitable edge.

### Key Function

```rust
/// Compute how the epoch's emission is distributed across creators.
/// Pure function: takes the epoch, the pool balance (for the drip), and a list of
/// donations with precomputed weighting; returns a map of creator to Y earned plus
/// the undistributed remainder the caller routes back into the pool.
/// The lineage-family id and pairwise weight come from the invitation tree (see 05).
/// Each creator's share is clipped at floor(emission_match_cap_bps * RW / 10_000),
/// where RW is their raw weighted donation sum (pre-concavity). Single pass, no
/// redistribution: clipped remainder + undistributed emission -> the pool.
pub fn compute_epoch_emission_shares(
    epoch: u64,
    pool_balance: u64,
    donations: &[(PublicKey, PublicKey, u64, f64, PublicKey)], // (donor, creator, amount, pairwise_weight, lineage_family)
    emission_match_cap_bps: u64,
) -> (HashMap<PublicKey, u64>, u64); // (creator -> Y earned, undistributed remainder)
```

No I/O -- the caller supplies all donation data and the pool balance, and receives the shares plus the explicit undistributed remainder to route back into the pool.

## D. Name Registry (`name_registry.rs`)

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

**Fee-recycling equilibrium.** Every protocol fee — donation (5%), invitation cost, handle rent, force-buy fees, floor excesses, rent arrears — flows into the Reward Pool. The pool then drips 2% of its balance per epoch, of which a **treasury slice** (`TREASURY_DRIP_SHARE_BPS = 1500`, 15%) routes to a disclosed Treasury address until epoch `TREASURY_TERM_EPOCHS = 260` — thereafter 100% of the drip goes to creators, and any Treasury balance unspent at epoch `TREASURY_RECLAIM_EPOCH = 416` returns to the pool — while the remaining **creator drip** feeds creator emission. Because those fees are assessed as a fraction of value that tracks real economic activity (donations, rent on desirable handles), the Y-denominated fee flow scales with activity and price. As scheduled emission halves toward zero, the pool drip takes over, so in the long run **every fee becomes creator rewards, under a hard 140B cap**. This closes a feedback loop: higher activity feeds a larger pool, a larger drip rewards more creators, and circulating supply moves countercyclically — heavy-fee epochs pull Y into the pool, the drip releases it steadily — damping price swings so price tracks activity/emission rather than spiking.

**Fair launch, no premine.** Supply is still **100% emitted** — no sale, no team allocation, no premine. The Treasury is a **time-boxed slice of the drip** (already-minted, recycled fees), not an up-front allocation; it sunsets at epoch 260 and any unspent balance returns to the pool at epoch 416.

**Why halving-to-zero was rejected.** A pure halving schedule that terminates emission and permanently removes fee tokens from supply starves the system once the schedule fades: the creator subsidy that pays for curation dies, and a fixed, permanently shrinking float rewards hoarding over participation (holding Y beats spending it — a deflationary trap). Recycling fees through the pool instead keeps a perpetual creator subsidy alive under the cap without ever minting past 140B and without permanent supply destruction.

**Why bonding was rejected.** An earlier design let users bond Y on posts to earn from later bonders, with the poster's mandatory first bond serving as the spam deterrent. It was removed: its payoff structure was a greater-fool game (a bonder profited only when later bonders arrived), it sold general reach in direct contradiction of the anti-pay-for-reach principle (see Donor Recognition in [07-indexer.md](07-indexer.md)), its spam-deterrent role is already covered by invitation gating plus labels and client-side filtering, and the mandatory first bond locked zero-balance invitees out of posting entirely. Posting and replying are now free at the protocol level.

**Wash-trading is bounded by the emission match cap, not eliminated (simulation still required).** The match cap (§C) converts wash-trading from an open risk into a bounded one, with four guarantees stated precisely:

1. **Aggregate bound.** Any closed coalition that donates only among accounts it controls pays the 5% donation fee on every internal flow and can extract at most 4% of those same flows back as emission (`EMISSION_MATCH_CAP_BPS < DONATION_FEE_BPS`). Washing is therefore a **guaranteed net loss of ≥ 1% of the washed volume** — at any network size, in any epoch, independent of the allocation shape.
2. **Launch window closed.** The halving schedule pays the most emission when the network is smallest, historically the moment gaming is easiest. With tiny organic volume the cap releases only tiny emission and the remainder defers to the pool automatically, so the early-epoch subsidy cannot be strip-mined.
3. **Residual headroom leak (stated honestly).** A creator with genuine donation inflow whose concave-allocated share sits **below** their cap can wash-donate to themselves to fill that headroom — profitable up to roughly 4% of their honest weighted inflow. Gaming is therefore bounded by genuine popularity, not driven to zero; measuring this incentive under realistic distributions is a launch-simulation task.
4. **First-order break-evens (heuristics — the concave allocation shifts the exact margins).** Related-account washing pays `f` and reclaims a `w = 0.25`-weighted claim, so it breaks even only above `e > f/w = 0.05/0.25 = 0.2` (Y of emission per weighted-Y). **Reciprocal collusion** between two genuinely unrelated accounts (pairwise weight `w = 1.0`, different lineage families) breaks even at `e > f = 0.05` — an attack the pairwise and family layers do **not** bound, since pairwise weights only discount *related* accounts and family collapse does not apply across genuinely distinct families (a ring or paid marketplace of unrelated accounts donating to each other defeats both). The cap binds regardless of `e`.

The parameters that set the residual margin (`EMISSION_MATCH_CAP_BPS`, `BRANCH_FAMILY_EXPONENT`, fee rate) MUST still be tuned by simulation before launch: the cap makes the *aggregate* outcome a provable loss, but the honest-headroom leak and the reciprocal-collusion margin are what simulation must quantify. See [05-invitation.md](05-invitation.md) Anti-Gaming for the matching treatment. The strongest adversarial statement of this attack — arguing that any donation-directed emission is inherently a mining algorithm — is preserved in [archive/09-first-principles-review.md](archive/09-first-principles-review.md) §2.1 (non-normative); the launch simulation must answer it.

## Error Types (`error.rs`)

```rust
#[derive(Debug, thiserror::Error)]
pub enum TokenYError {
    #[error("insufficient balance: have {have}, need {need}")]
    InsufficientBalance { have: u64, need: u64 },

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
