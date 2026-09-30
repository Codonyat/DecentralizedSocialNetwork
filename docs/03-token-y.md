# Token Y Protocol Design (`dsn-token-y`)

## Purpose

Token Y is the native utility token. Supply is capped at 140,000,000,000 Y (140B, 6 decimals — `140_000_000_000_000_000` atomic units, which fits u64), enforced on-chain. Y is minted by exactly two paths: a snapshot **genesis** allocation (§A) and **like-power issuance** (§B). Cumulative minting from both never exceeds the cap, and no token is ever destroyed: every protocol fee recycles through the **fee pool**. This crate contains **pure computation** — no I/O, no storage, no async. Smart contracts enforce all rules; this crate provides the math and validation logic that both clients and contracts rely on.

## Module Structure

```
crates/token-y/src/
  lib.rs
  supply.rs           # Supply split: GENESIS_TOTAL vs issuance capacity
  genesis.rs          # Snapshot entitlements: leaves, weekly tranches, splits
  like_power.rs       # Stake -> power meter: accrual, cap, spend per like, settlement split
  issuance.rs         # Mint rate k(t), epoch issuance budget, creator reward shares
  fee_pool.rs         # Fee pool drip and its allocation against stake-time
  tip.rs              # Tip split: protocol fee + facilitator fee; foreign-key escrow
  name_registry.rs    # Handle claim/assess/rent/force-buy (Harberger tier), base-rent controller, validation
  error.rs
```

All modules are **pure functions** over their inputs.

## Units and Conventions

- **Epoch** = `EPOCH_SECONDS` (604,800 s, one week) of L2 block time. Contracts derive the epoch from `block.timestamp`, counting from the main deployment (epoch 0). No caller-supplied timestamp ever sets priority or rate.
- **Power**: 1 power unit = 1 staked atomic Y held for one epoch (the regeneration rate `r` is normalized to 1). Stake-time and power share this unit.
- **Arithmetic**: every basis-point or rate multiplication uses **u128 intermediates** (see the convention in [01-core-types.md](01-core-types.md)). Protocol **fees round up**; **payouts, drips, reservations and facilitator fees round down**; a zero denominator yields zero.
- **`TBD`** marks a founder placeholder that needs population and concentration data. The main deployment cannot happen while any `TBD` is unset (00, Canary deployment).
- **(tunable)** means tunable in design and on the canary, frozen at deployment (00, Parameter Immutability). Values marked **(6c)** are the canary starting values chosen in the pillars review; the canary tunes them.

## A. Supply & Genesis (`supply.rs`, `genesis.rs`)

### Supply split

```rust
pub const TOTAL_SUPPLY: u64 = 140_000_000_000_000_000; // 140B Y, 6 decimals; hard cap on genesis + issuance
pub const GENESIS_SHARE_BPS: u64 = TBD;                 // genesis-to-issuance split; needs population + concentration data

/// Y reserved for the genesis allocation. Round DOWN.
pub fn genesis_total() -> u64 {
    ((TOTAL_SUPPLY as u128 * GENESIS_SHARE_BPS as u128) / 10_000) as u64
}

/// Y available to like-power issuance over the protocol's life (§B).
pub fn issuance_capacity() -> u64 {
    TOTAL_SUPPLY - genesis_total()
}
```

Invariants: genesis minting ≤ `genesis_total()`; issuance ≤ `issuance_capacity()`; their sum ≤ `TOTAL_SUPPLY`. Missed genesis tranches and rounding dust are simply never minted — they never reopen issuance capacity.

### Snapshot eligibility

Eligibility is a real sunk cost or age, provable from public chain data before a cutoff already in the past. Eligible keys are grouped into **cohorts**; the genesis allocation is split across cohorts plus one treasury leaf.

```rust
pub struct CohortSpec {
    pub id: u8,
    pub name: &'static str,
    pub rule: &'static str,     // reproducible eligibility rule over public data before the cutoff
    pub key_type: &'static str, // foreign key type of the cohort's leaves (01 ForeignKey)
    pub share_bps: u64,         // share of genesis_total(); cohorts + TREASURY_SHARE_BPS sum to 10_000
}

pub const GENESIS_COHORTS: &[CohortSpec] = TBD;  // cohorts, rules, thresholds, shares; needs population + concentration data
pub const TREASURY_SHARE_BPS: u64 = TBD;         // share of genesis_total(); settled with the split
pub const TREASURY_SHARE_CAP_BPS: u64 = 1_000;   // treasury <= 10% of genesis_total()
pub const TREASURY_COHORT_ID: u8 = 0;            // reserved cohort id of the single treasury leaf

/// Leaf hash committed under the genesis Merkle root (leaf type: 01 GenesisLeaf).
pub fn genesis_leaf_hash(leaf: &GenesisLeaf) -> [u8; 32];

/// Build every leaf from the frozen dataset. Within a cohort every eligible key
/// receives the SAME entitlement: cohort_total / eligible_keys, round DOWN.
/// A key eligible in several cohorts holds one leaf per cohort. Checks: cohort
/// shares + TREASURY_SHARE_BPS == 10_000 and TREASURY_SHARE_BPS <= TREASURY_SHARE_CAP_BPS.
pub fn build_genesis_leaves(
    cohorts: &[(CohortSpec, Vec<ForeignKey>)],
    treasury_key: ForeignKey,
) -> Vec<GenesisLeaf>;
```

- **Reproducibility.** The dataset, the rules, the leaf list, the Merkle root, and a concentration analysis are published before deployment; anyone can recompute the root.
- **Treasury.** One disclosed leaf (`TREASURY_COHORT_ID`) held by a disclosed address, vesting on the same schedule as every other leaf. It holds **tokens, not powers**: no protocol privilege, spending disclosed. Honest limit: no contract can verify that a disbursement was an operating expense.

### Activation, tranches, splits

```rust
pub const GENESIS_VEST_HALVING_EPOCHS: u64 = 104; // tranches halve every 104 epochs (~2y) (tunable)
pub const GENESIS_CLAIM_WINDOW_EPOCHS: u64 = 1;   // a tranche is claimable only in its own epoch (tunable)

/// Tranche that nominal entitlement `entitlement` vests in `epoch`: flat within
/// each 104-epoch window, halving per window, so the sum over all epochs
/// approaches `entitlement` asymptotically. Round DOWN.
pub fn genesis_tranche(entitlement: u64, epoch: u64) -> u64 {
    let window = epoch / GENESIS_VEST_HALVING_EPOCHS;
    if window >= 64 { return 0; } // shift-width guard only
    (entitlement / (2 * GENESIS_VEST_HALVING_EPOCHS)) >> window
}

/// Move `amount` of nominal entitlement to another account. Returns the
/// sender's and receiver's new nominal entitlements; the sum is unchanged.
pub fn split_entitlement(from_nominal: u64, to_nominal: u64, amount: u64)
    -> Result<(u64, u64), TokenYError>;
```

- **Activation.** A leaf activates once, by a Merkle proof plus a signature from its `ForeignKey` (ecrecover for Ethereum keys) naming a destination `IdentityId`. The nominal entitlement then belongs to that account.
- **Claiming.** In epoch `e` an account may claim `genesis_tranche(nominal_e, e)`, within `GENESIS_CLAIM_WINDOW_EPOCHS`, where `nominal_e` is the nominal entitlement **in force during epoch `e`** (splits recorded with a later effective epoch do not count). A tranche not claimed in its window is **never minted** — including every tranche before activation. Vesting is wall-clock: the genesis clock starts at epoch 0 for everyone.
- **Splitting.** A holder may split nominal entitlement to any account (typically a newcomer). Only rights to **future** tranches move, on the same genesis clock, recorded as `(amount, effective_epoch = current + 1)` and counted only for tranches of epochs `>= effective_epoch`; claimed and missed tranches are never reopened. Splitting is conserved, so self-splitting creates nothing.

## B. Like Power & Issuance (`like_power.rs`, `issuance.rs`)

### One button

A **like** is a signed, off-chain object (01 `Like`): free, and a ranking edge for everyone (09). For an account with stake — or a like carried under a sponsor's `PowerDelegation` (05) — the like also spends 2% of current like power, and the client settles the day's likes on-chain in one batch. Unspent power mints nothing. A plain Y transfer and a tip (§C) remain separate actions.

### Stake and the power meter

```rust
pub const EPOCH_SECONDS: u64 = 604_800;         // one week of L2 block time (tunable)
pub const POWER_CAP_SECONDS: u64 = 86_400;      // the meter holds 24 h of regeneration (6c)
pub const LIKE_SPEND_BPS: u64 = 200;            // each like spends 2% of current power (6c)
pub const UNSTAKE_DELAY_SECONDS: u64 = 604_800; // 7 days; regeneration stops at the request (6c)

/// Cap on stored power: 24 h of regeneration on the eligible stake. Round DOWN.
pub fn power_cap(eligible_stake: u64) -> u64 {
    ((eligible_stake as u128 * POWER_CAP_SECONDS as u128) / EPOCH_SECONDS as u128) as u64
}

/// Power available at block time `now`: stored power plus regeneration since
/// `last_update`, clamped to the cap. Round DOWN. (Meter type: 01 PowerMeter.)
pub fn accrue(meter: &PowerMeter, now: u64) -> u64 {
    let dt = now.saturating_sub(meter.last_update) as u128;
    let regen = (meter.eligible_stake as u128 * dt) / EPOCH_SECONDS as u128;
    (meter.stored_power as u128 + regen).min(power_cap(meter.eligible_stake) as u128) as u64
}
```

- Stake Y into the Like contract. Power regenerates at 1 unit per staked atomic Y per epoch, up to `power_cap`.
- **Every stake change first settles the meter** (`stored_power = accrue(meter, now); last_update = now`) and only then changes `eligible_stake`.
- **Deposits start empty**: added stake raises regeneration and the cap, never stored power.
- **Unstaking**: `request_unstake(amount)` moves `amount` from eligible to pending. Regeneration on it stops at once and stored power clamps to the new cap; the Y is withdrawable after `UNSTAKE_DELAY_SECONDS`. Moving stake never carries or duplicates stored power.
- Power is a per-account meter: never transferable, never a token.

### Settlement

```rust
/// Power a batch of `n_likes` spends: each like spends LIKE_SPEND_BPS of the
/// power left after the previous one, with no regeneration inside the batch:
/// spend = P - P * 0.98^n (fixed-point pow at 1e18 scale; the remainder rounds UP, so spend rounds DOWN).
pub fn spend_for_likes(power: u64, n_likes: u32) -> u64;

/// Split a batch's spend across recipients pro rata by weight. Round DOWN.
/// The settled spend is the SUM ALLOCATED; the rounding dust stays in the meter.
/// u128 intermediates: `spend * w_i` and `Σ w` can exceed u64.
pub fn split_spend(spend: u64, weights: &[(IdentityId, u64)]) -> Vec<(IdentityId, u64)>;
```

`settle(n_likes, allocations: Vec<(IdentityId, u64 /* weight */)>, nonce)` is sent by the staker's gas account (01, chain custody), with gas sponsored by the client:

- `nonce` must equal the meter's `settle_nonce` (replay protection); `n_likes >= 1`; every weight is positive; an allocation to the staker itself is **invalid** (self-likes mint nothing).
- The contract computes `P = accrue(meter, now)`, `spend = spend_for_likes(P, n_likes)`, and `split_spend(spend, weights)`. It debits the sum allocated, credits each recipient's **power received** in the current epoch, adds the sum to the epoch's **total spent**, and emits `LikesSettled`. There is no minimum payout.
- Allocations are derived from the weights by `split_spend`, so they sum to the settled spend by construction; the protocol checks nothing else about them. How weights derive from likes is a client convention: one like = 10,000 units, split by the `Like.recipients` list. The reference client sends 100% of a like to the post's author — there is **no payment to recommendation sources** and no reward to earlier likers.
- The settled spend belongs to the epoch in which the settlement lands. The reference cadence is one batched settlement per staker per day (6c); frequency cannot raise the bound, since accrual comes from block time and is capped at 24 h.
- **Delegated likes.** A sponsor includes its delegates' likes (`Like.sponsor`, 05 `PowerDelegation`) in its own settlement. They debit the sponsor's single meter, so delegation never multiplies power; the delegates' shared allowance is a sponsor-side setting with no on-chain state. The self-allocation rule binds only the staker; a delegate liking its own posts is excluded by the reference client, and the bound holds either way.

**Stake-time.** `S_e = ∫ eligible_stake(t) dt / EPOCH_SECONDS` over epoch `e`, summed over all accounts — the power the network could regenerate in `e`, in power units. The contract maintains it with a global accumulator updated on every stake change.

### Issuance

```rust
pub const INITIAL_MINT_RATE_PPB: u64 = 5_000_000; // k = 0.5%: 0.005 atomic Y per power unit (1 atomic Y staked for 1 epoch) spent, so a fully used meter mints 0.5% of its stake per epoch (6c)
pub const MINT_HALVING_EPOCHS: u64 = 104;          // k halves every 104 epochs (~2y) (6c)

/// k for an epoch, in parts per billion. The value is already 0 from halving 23
/// onward (5e6 < 2^23); the guard below is shift-width safety only.
pub fn mint_rate_ppb(epoch: u64) -> u64 {
    let halvings = epoch / MINT_HALVING_EPOCHS;
    if halvings >= 64 { return 0; }
    INITIAL_MINT_RATE_PPB >> halvings
}

/// Issuance budget reserved at the close of epoch `epoch`: k * spent, clipped
/// to the capacity not yet reserved by earlier epochs. Round DOWN.
pub fn epoch_mint_budget(epoch: u64, spent: u64, capacity_remaining: u64) -> u64 {
    let want = (spent as u128 * mint_rate_ppb(epoch) as u128) / 1_000_000_000;
    want.min(capacity_remaining as u128) as u64
}

pub struct CreatorReward {
    pub minted: u64,     // new Y (counts against issuance capacity)
    pub fee_reward: u64, // recycled Y from the fee pool reserve (does not)
}

/// A creator's claim for one closed epoch, from the power it received:
///   minted     = mint_budget * received / spent
///   fee_reward = fee_drip * received / max(stake_time, spent)
/// Round DOWN; zero denominators yield zero.
pub fn creator_epoch_reward(
    received: u64,
    spent: u64,
    stake_time: u64,
    mint_budget: u64,
    fee_drip: u64,
) -> CreatorReward;
```

- **Epoch close** is lazy: the first transaction after a boundary closes the previous epoch. It records `spent_e` and `S_e`, sets `mint_budget_e = epoch_mint_budget(e, spent_e, capacity_remaining)`, and subtracts it from `capacity_remaining` — the budget is **reserved** and can never be re-offered to a later epoch. The fee pool's share is reserved in the same step (§ Fee Pool). Emits `EpochAdvanced`. If several boundaries have passed, the close runs once per elapsed epoch, in order; an epoch with no settlements reserves nothing.
- **Creator claims** are pulled per closed epoch, with no expiry. Constrained budgets — the remaining issuance capacity, the fee drip — are therefore shared **pro rata, never first-come**. Cost: creator income lags by up to one epoch. Rounding dust stays unminted or in the reserve.
- Cumulative issuance never exceeds `issuance_capacity()`. Once it is exhausted, settled likes still direct the fee pool's drip.

### The bound

Whatever a coalition does with accounts, likes, or routing, per epoch it can direct at most:

- **issuance** ≤ `k_e ×` (power regenerated from its own eligible stake-time + at most one day's carried power);
- **fee rewards** ≤ `drip_e × its spent / max(S_e, spent_e)` ≤ `drip_e`.

Only stake × time enters; accounts and routing add nothing. Economic Design states what this bound does not settle.

## Fee Pool (`fee_pool.rs`)

Every protocol fee flows into the **fee pool**, held by the Like contract: tip protocol fees (§C) and name fees (§D — handle rent, force-buy fees, floor excesses, rent arrears). Nothing is burned.

```rust
pub const FEE_POOL_DRIP_BPS: u64 = 200; // 2% of the pool balance per epoch (6c)

/// Drip released at an epoch's close, on the balance at that moment. Round DOWN.
/// u128 intermediate: balance * 200 overflows u64 at the 140B scale.
pub fn fee_pool_drip(pool_balance: u64) -> u64 {
    ((pool_balance as u128 * FEE_POOL_DRIP_BPS as u128) / 10_000) as u64
}

/// Part of the drip reserved for creator claims: drip * spent / max(stake_time, spent).
/// The rest never leaves the pool. Round DOWN.
pub fn fee_reserved(drip: u64, spent: u64, stake_time: u64) -> u64 {
    let denom = stake_time.max(spent) as u128;
    if denom == 0 { return 0; }
    ((drip as u128 * spent as u128) / denom) as u64
}
```

- **Allocated against all eligible stake-time.** The drip is shared over `S_e`, not over power spent, so a staker that spends none of its power leaves its share in the pool. The `max(S_e, spent_e)` denominator keeps payouts ≤ the drip even when carried power pushes `spent_e` above `S_e`.
- **Separate accounting.** Fee rewards are recycled Y and never count against issuance capacity.
- **Steady state.** Per epoch the pool pays out `2% × balance × u`, with `u = spent / max(S, spent)` ∈ [0, 1]. Against a fee inflow `F` the balance tends to `F / (0.02 u)`: outflow scales with the pool, so the pool is not a sink while likes are settled. With `u = 0` (nothing settled) it only accumulates fees until liking resumes.

## C. Tips (`tip.rs`)

A **tip** is an on-chain payment to a creator, optionally referencing a post. It is separate from the like button, and the plain transfer stays separate from both.

```rust
pub const PROTOCOL_FEE_BPS: u64 = 100;                // 1% -> fee pool; rounds UP (6c)
pub const MAX_FACILITATOR_FEE_BPS: u64 = 500;         // facilitator fee cap; rounds DOWN (6c)
pub const TIP_ESCROW_REFUND_SECONDS: u64 = 2_592_000; // 30 days (tunable)

/// Protocol fees round UP (ceiling division) so no dust escapes fee-free.
fn ceil_fee(amount: u64, bps: u64) -> u64 {
    ((amount as u128 * bps as u128 + 9_999) / 10_000) as u64
}

pub struct TipSplit {
    pub protocol_fee: u64,    // -> fee pool
    pub facilitator_fee: u64, // -> the originating client's facilitator address
    pub recipient_share: u64, // -> the creator, or into escrow for a foreign key
}

pub fn compute_tip_split(amount: u64, facilitator_fee_bps: u64) -> Result<TipSplit, TokenYError> {
    if facilitator_fee_bps > MAX_FACILITATOR_FEE_BPS {
        return Err(TokenYError::FacilitatorFeeTooHigh { bps: facilitator_fee_bps, max: MAX_FACILITATOR_FEE_BPS });
    }
    let protocol_fee = ceil_fee(amount, PROTOCOL_FEE_BPS);
    let facilitator_fee = ((amount as u128 * facilitator_fee_bps as u128) / 10_000) as u64;
    let fees = protocol_fee + facilitator_fee; // each <= amount, so no u64 overflow
    if fees > amount {
        return Err(TokenYError::TipBelowFees { amount, fees });
    }
    Ok(TipSplit { protocol_fee, facilitator_fee, recipient_share: amount - fees })
}
```

- **Facilitator fee.** Set per transaction by the originating client (web app, indexer, CLI) and authorized by the payer's signature; 0 when there is none. It pays whoever built the client or indexer (07, Indexer Economics).
- **No minimum.** With no weighting there is nothing for dust to game; the round-up protocol fee already makes dust expensive.
- **Tips carry no weight.** They mint nothing and never buy reach: tip totals are display data and capped, viewer-relative ranking features only (09).
- **Private tips.** A tip may come from any key — for example a fresh one. This is unlinkability at the tip layer only: the funding transfer is public, and a client need not sponsor a fresh key's gas.
- **Supporter recognition** (thread prominence, badges, leaderboards) is a client/indexer convention over public tips (07), never an on-chain reward.

### Foreign-key escrow

- A tip may target `TipRecipient::Foreign(ForeignKey::Ethereum(addr))`, a supported pre-existing key; ENS names resolve client-side to an address at tip time.
- The split is taken at tip time and the net `recipient_share` is escrowed with `refund_after = now + TIP_ESCROW_REFUND_SECONDS`.
- Before `refund_after`, the key's owner claims the net amount with a signature from that key naming a destination `IdentityId`. After it, anyone may trigger the refund of the net amount to the tipper. There is no administrator.
- Claiming unlocks no issuance and no genesis entitlement.

## D. Name Registry (`name_registry.rs`)

Names are a **two-layer model**: a free off-chain display name and an optional on-chain rented @handle.

### Display Name

Off-chain, free, non-unique, purely cosmetic. It is metadata a client renders, carries no on-chain state, and is not part of anyone's canonical identity (see the Identity Principle in [01-core-types.md](01-core-types.md)).

### @handle (on-chain)

A unique, on-chain handle that resolves to a public key. Handles are **rented, not purchased** — there is no one-time cost and no permanent ownership.

- **Claim** an unowned handle by setting an assessed value `V` (mandatory `>= floor` for lengths 1–6; omitted and stored as `0` for the flat tier, where `V` is meaningless) and paying the first epoch's rent at claim time. A client may fund a newcomer's first rent by a plain transfer bundled with the claim (05, Sponsored Onboarding); the registry is unchanged.
- `V` may be raised at any time. Decreases take effect only after `LOOKBACK_EPOCHS` (via `pending_assessment`), so an owner cannot dodge a force-buy by dropping `V` the moment a bid lands.
- Rent is due every epoch and flows to the fee pool. Nonpayment triggers a `GRACE_EPOCHS` (4) grace period; after that the handle lapses to unowned.
- **Prepaid** epochs are priced at the rent in force when paid, and `rent_paid_through_epoch − current_epoch` may never exceed `MAX_PREPAID_EPOCHS`.

### Base rent (demand-targeting controller)

No price is frozen in Y. The flat-tier rent is the **base rent** `B`, and the Harberger floors are fixed multiples of it. At each epoch close the registry steps `B` by ±12.5% against a target number of new flat-tier claims in the epoch just closed, and records `B` in a per-epoch history. The history prices arrears at the rents that applied when they accrued.

```rust
pub const LAUNCH_BASE_RENT: u64 = 1_000_000;         // 1 Y/epoch at launch (tunable)
pub const MIN_BASE_RENT: u64 = 1_000;                // 0.001 Y; keeps a 12.5% step able to move (tunable)
pub const MAX_BASE_RENT: u64 = u64::MAX / 1_000_000; // keeps the largest floor (1_000_000 x B) within u64
pub const BASE_RENT_STEP_BPS: u64 = 1_250;           // +/-12.5% per epoch (tunable)
pub const TARGET_FLAT_CLAIMS_PER_EPOCH: u64 = TBD;   // needs population data
pub const MAX_PREPAID_EPOCHS: u64 = 26;              // cap on rent_paid_through_epoch - current_epoch (tunable)

/// Next epoch's base rent: one step up if flat-tier claims exceeded the target,
/// one step down if they fell short, unchanged at the target; clamped to [MIN, MAX].
pub fn next_base_rent(current: u64, flat_claims_last_epoch: u64) -> u64 {
    let c = current as u128;
    let stepped = if flat_claims_last_epoch > TARGET_FLAT_CLAIMS_PER_EPOCH {
        c * (10_000 + BASE_RENT_STEP_BPS) as u128 / 10_000
    } else if flat_claims_last_epoch < TARGET_FLAT_CLAIMS_PER_EPOCH {
        c * (10_000 - BASE_RENT_STEP_BPS) as u128 / 10_000
    } else {
        c
    };
    stepped.clamp(MIN_BASE_RENT as u128, MAX_BASE_RENT as u128) as u64
}
```

**Harberger tier (lengths 1–6).** Rent per epoch = `HANDLE_RENT_RATE_BPS × max(V, assessment_floor(len, B))`.

| Handle Length | Assessment Floor | At launch (`B` = 1 Y) |
|---|---|---|
| 1–2 chars | 1,000,000 × `B` | 1,000,000 Y |
| 3–4 chars | 100,000 × `B` | 100,000 Y |
| 5–6 chars | 10,000 × `B` | 10,000 Y |

Assessing below the floor earns nothing on a takeover (see the waterfall) while still paying floor-based rent, so rational owners assess `>= floor`. When `B` rises past an owner's `V`, the existing rules apply unchanged: rent and force-buy price follow the floor.

**Flat tier (lengths ≥ 7).** Rent = `B` per epoch, identical for ALL lengths ≥ 7; no assessed value, no force-buy (safe harbor). Rationale: past 6 characters the namespace is effectively infinite, so length stops measuring scarcity. Flat rent does three jobs with one number — it imposes a cost on bulk-hoarding, recycles abandoned handles (via lapse), and yields fee-pool revenue — and the controller keeps that number meaningful whatever Y's price does. Accepted leak: dictionary-word squatting, since length cannot price desirability; only a Harberger assessment could, and the safe harbor from force-buys matters more for ordinary users.

**Force-buy (Harberger tier only).** A challenger triggers a takeover by escrowing a bid = `max(V, floor)` and paying a **1% non-refundable fee** (`FORCE_BUY_FEE_BPS`) to the fee pool — skin in the game against griefing ratchets. The bid is escrowed for the `NOTICE_WINDOW_EPOCHS` (1) notice window. The owner may **cancel** by raising `V` to `>= 110%` of the bid (`RAISE_PREMIUM_BPS`) and paying the retroactive rent difference on the increase over `LOOKBACK_EPOCHS` (a +1-atomic raise no longer cancels for free). Otherwise the transfer executes and the escrowed bid is allocated by the **waterfall** — arrears to the fee pool first, then `min(V, remainder)` to the outgoing owner, remainder to the fee pool — which can never exceed the escrowed bid nor underflow. Flat-tier handles have no force-buy.

### Validation Rules

- Lowercase alphanumeric characters and hyphens only.
- Length: 1–32 characters (`MAX_HANDLE_CHARS`).
- No leading or trailing hyphens; no consecutive hyphens.
- Unicode normalization (NFKC) is applied before validation.
- Claim succeeds only if the handle is currently unowned; `V >= assessment_floor(len, B)` for lengths 1–6; the flat tier ignores `V`.

### Types and Functions

```rust
pub const HANDLE_RENT_RATE_BPS: u64 = 10;    // 0.1%/epoch of max(V, floor); Harberger tier (tunable)
pub const NOTICE_WINDOW_EPOCHS: u64 = 1;     // force-buy escrow window (tunable)
pub const LOOKBACK_EPOCHS: u64 = 26;         // assessment-decrease / cancel-raise settle delay (tunable)
pub const GRACE_EPOCHS: u64 = 4;             // rent grace before lapse (tunable)
pub const FORCE_BUY_FEE_BPS: u64 = 100;      // 1% non-refundable bid fee -> fee pool (tunable)
pub const RAISE_PREMIUM_BPS: u64 = 1_000;    // cancel requires V >= 110% of the bid (tunable)

// NameRecord and ForceBuy: canonical in 01 (token.rs).

pub struct ForceBuyWaterfall {
    pub arrears_to_pool: u64,
    pub to_owner: u64,
    pub excess_to_pool: u64,
}

/// Rent/force-buy floor for a Harberger-tier handle, in atomic Y. None for the
/// flat tier. Cannot overflow: base_rent <= MAX_BASE_RENT.
pub fn assessment_floor(len: usize, base_rent: u64) -> Option<u64> {
    let multiplier: u64 = match len {
        1..=2 => 1_000_000,
        3..=4 => 100_000,
        5..=6 => 10_000,
        _ => return None, // flat tier, len >= 7
    };
    Some(base_rent * multiplier)
}

pub fn is_harberger_tier(len: usize) -> bool { len <= 6 }

/// Rent owed for one epoch whose base rent is `base_rent`, in atomic Y.
/// Harberger tier: round-down(rate * max(V, floor)). Flat tier: base_rent, V ignored.
pub fn handle_rent_per_epoch(len: usize, assessed_value: u64, base_rent: u64) -> u64 {
    match assessment_floor(len, base_rent) {
        Some(floor) => {
            let base = assessed_value.max(floor);
            ((base as u128 * HANDLE_RENT_RATE_BPS as u128) / 10_000) as u64
        }
        None => base_rent,
    }
}

/// Unpaid rent of the outgoing owner: the sum of handle_rent_per_epoch over each
/// unpaid epoch, at that epoch's recorded base rent.
pub fn arrears(record: &NameRecord, base_rent_history: &[u64], current_epoch: u64) -> u64;

/// Bid a challenger must escrow to force-buy = max(V, floor) at the current base rent.
pub fn force_buy_price(record: &NameRecord, base_rent: u64) -> u64;

/// Allocate the escrowed bid on a completed force-buy. Never exceeds `bid`,
/// never underflows. `arrears` comes from `arrears()` above.
pub fn force_buy_waterfall(record: &NameRecord, bid: u64, arrears: u64) -> ForceBuyWaterfall {
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

All functions are pure — no storage lookups. The smart contract checks handle availability, escrow, rent state, and the base-rent history on-chain.

## Economic Design

**Two anchors, one cap.** Both mint paths rest on something outside in-network activity. Genesis rests on pre-existing history before a past cutoff. Issuance rests on capital × time: accounts, likes, and routing add nothing to what a coalition can direct (§B, The bound). Everything paid for activity itself is either a transfer between users (tips) or recycled fees (the fee pool).

**Harvesting equilibrium (a hypothesis, not a measurement).** Once harvesting tools exist, most stake-directed issuance — plausibly over 80% — may return to stakers through second accounts. Creators then receive what honestly-liking stake sends them. The honest description of the mechanism is that **holders may donate their inflation entitlement to creators**. The harm from harvesting is bounded to dilution of at most `k × r` of stake per epoch. The canary's decisive metric is the share of issuance reaching independent creators after harvesting tools appear (00, Canary deployment).

**A rate on staked capital, halving.** Issuance is a rate on stake that is actually used, not an absolute per-epoch schedule. An absolute schedule sized to the cap leaves no room for a genesis allocation, and it pays the most when the network is smallest. Halving every 104 epochs leaves entry room well beyond year one. The self-liker ceiling starts at 0.5% of stake per week (≈ 30% a year, compounded, at most). Only spent power mints, so realised issuance sits well below that ceiling.

**Fee recycling, no burns.** Fees flow to the pool, and the pool drips against all stake-time, with unspent shares staying in the pool. Outflow scales with the pool, so the pool reaches a steady state instead of sinking. This recycling is safe because allocation is bounded by stake, not by matching volume.

**Reach is never bought.** Exposure is the conserved attention budget (09): a whale's like pays the creator and reaches only the whale's own followers. Likes and tips enter ranking only as capped, viewer-relative features.

**No invite-graph money weights, no curation rewards.** Weighting money by invitation position deterred only lazy harvesters and taxed honest friends; stake bounds the money layer instead (05). There is no reward to earlier likers, because that would create a timing contest that invites prediction bots. There is also no protocol payment to recommendation sources.

**No frozen nominal prices.** The only Y-denominated prices left are the handle base rent, which a controller moves, and the floors, which are multiples of it. `MIN_BASE_RENT` and `MAX_BASE_RENT` are safety clamps, not prices. Repricing never needs a redeployment.

**Why bonding was rejected.** An earlier design let users bond Y on posts to earn from later bonders, with the poster's mandatory first bond serving as the spam deterrent. It was removed for four reasons:
- Its payoff was a greater-fool game: a bonder profited only when later bonders arrived.
- It sold general reach, contradicting "reach is never bought".
- Its spam-deterrent role is covered by labels, client-side filtering and the conserved attention budget.
- The mandatory first bond locked zero-balance accounts out of posting.

Posting, replying and liking are free at the protocol level.

**Superseded designs.** The 2026-07 design is removed. It combined donation-directed emission under an absolute halving schedule (1.4B Y per epoch), a 5% donation fee into a Reward Pool, an emission match cap at 4% of weighted donations, pairwise and lineage-family donation weights over an on-chain invitation tree, and a 15% treasury drip slice. Because the match cap sat below the fee, creators in aggregate could never receive what donors paid, and the pool only filled. The treasury slice, the one uncapped outflow, became the largest distributor: about 41–45% of supply in simulation. The evidence is non-normative: [proposals/2026-09-29-pillars-review.md](proposals/2026-09-29-pillars-review.md) §3 F1 and `proposals/pool_sim.js`. The adversarial brief against activity-directed rewards remains in [archive/09-first-principles-review.md](archive/09-first-principles-review.md) §2.1 (non-normative).

## Error Types (`error.rs`)

```rust
#[derive(Debug, thiserror::Error)]
pub enum TokenYError {
    #[error("insufficient balance: have {have}, need {need}")]
    InsufficientBalance { have: u64, need: u64 },

    #[error("post not found")]
    PostNotFound,

    // --- Genesis (§A) ---
    #[error("genesis leaf already activated")]
    GenesisAlreadyActivated,

    #[error("invalid genesis proof or foreign-key signature")]
    InvalidGenesisProof,

    #[error("tranche for epoch {epoch} is not claimable now")]
    TrancheNotClaimable { epoch: u64 },

    #[error("split exceeds nominal entitlement: {amount} > {nominal}")]
    SplitExceedsEntitlement { amount: u64, nominal: u64 },

    // --- Like power & issuance (§B) ---
    #[error("insufficient eligible stake: have {have}, need {need}")]
    InsufficientStake { have: u64, need: u64 },

    #[error("unstake not available until {available_at}")]
    UnstakeNotReady { available_at: u64 },

    #[error("settlement nonce mismatch: expected {expected}, got {got}")]
    SettlementNonce { expected: u64, got: u64 },

    #[error("empty settlement (no likes or no allocations)")]
    EmptySettlement,

    #[error("a settlement may not allocate to the staker itself")]
    SelfAllocation,

    #[error("epoch {epoch} is not closed yet")]
    EpochNotClosed { epoch: u64 },

    // --- Tips (§C) ---
    #[error("facilitator fee too high: {bps} bps > {max} bps")]
    FacilitatorFeeTooHigh { bps: u64, max: u64 },

    #[error("tip below fees: amount {amount} < fees {fees}")]
    TipBelowFees { amount: u64, fees: u64 },

    #[error("escrow claim window closed")]
    EscrowExpired,

    #[error("escrow not refundable before {refund_after}")]
    EscrowNotRefundable { refund_after: u64 },

    // --- Names (§D) ---
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

    #[error("prepayment beyond {max} epochs ahead")]
    PrepayTooFar { max: u64 },

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
