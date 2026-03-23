# Token R Reputation Design (`dsn-token-r`)

## Purpose

Token R is soulbound (non-transferable) reputation earned through genuine participation. It determines curation weight, Y emission share, invitation capacity, and moderation influence. It is deterministically computable from public data on Autonomi.

## Module Structure

```
crates/token-r/src/
├── lib.rs              # Re-exports
├── diversity.rs        # DiversityScore computation
├── curation.rs         # Curation staking: place stake, evaluate, resolve
├── earning.rs          # R earning from curation success + content creation
├── decay.rs            # R decay per epoch
├── slashing.rs         # R slashing for fraud
├── computation.rs      # Full R computation from Autonomi data
└── error.rs            # Token R errors
```

## DiversityScore (`diversity.rs`)

### Formula

For a given post, after the cooling period (2 full epochs):

```
DiversityScore = Σ (sqrt(curator_R) × DecayMultiplier(curator))
                 for each unique curator
```

### Components

**`sqrt(curator_R)`**: Sublinear weighting.

| Curator R | sqrt(R) | Relative Weight |
|---|---|---|
| 1 | 1.0 | 1× |
| 10 | 3.16 | 3.16× |
| 100 | 10.0 | 10× |
| 1000 (cap) | 31.6 | 31.6× |

A user with 100× more R only gets 10× more curation weight. This prevents whale domination.

**`DecayMultiplier(curator)`**: Penalizes coordinated bursts.

```rust
/// Compute the DecayMultiplier for a curator's stake on a post.
/// Measures temporal spread of curations.
///
/// `curations_before`: number of curations on this post before this curator's
/// `unique_viewers`: number of unique accounts that follow the post's author
///                   at the time this curation was placed
pub fn decay_multiplier(curations_before: u64, unique_viewers: u64) -> f64 {
    // Burst detection: if many curations arrived before the post was
    // widely seen, they're likely coordinated.
    if unique_viewers == 0 { return 0.1; } // Minimal weight if no organic viewers
    let organic_ratio = curations_before as f64 / unique_viewers as f64;

    if organic_ratio < 0.1 {
        1.0                     // Healthy: few curations relative to viewers
    } else if organic_ratio < 0.5 {
        0.5                     // Suspicious: many curations relative to viewers
    } else {
        0.1                     // Very suspicious: curations outpace viewership
    }
}
```

### DiversityScore Implementation

```rust
/// Compute the DiversityScore for a post.
pub fn diversity_score(
    post_address: &ContentAddress,
    curations: &[CurationWithContext],
) -> f64 {
    let mut seen_curators: HashSet<PublicKey> = HashSet::new();
    let mut score = 0.0_f64;

    for curation in curations {
        // Each curator counted only once
        if !seen_curators.insert(curation.curator.clone()) {
            continue;
        }

        let sqrt_r = (curation.curator_r as f64).sqrt();
        let multiplier = decay_multiplier(
            curation.curations_before,
            curation.unique_viewers_at_time,
        );

        score += sqrt_r * multiplier;
    }

    score
}

/// Context needed to evaluate a single curation.
pub struct CurationWithContext {
    pub curator: PublicKey,
    pub curator_r: u64,
    pub r_staked: u64,
    pub y_staked: u64,
    pub curations_before: u64,
    pub unique_viewers_at_time: u64,
    pub staked_at_epoch: u64,
}
```

### DiversityScore Threshold

```rust
/// Minimum DiversityScore for a post to "succeed" (curators earn R).
/// Fixed at launch. Intentionally low to allow early-network posts to succeed
/// when the user base is small.
pub const DIVERSITY_THRESHOLD: f64 = 10.0;
```

## Curation Staking (`curation.rs`)

### Stake Placement

```rust
/// Place a curation stake on a post.
/// Deducts R (and optionally Y) from the curator's balance.
pub fn place_curation_stake(
    curator_r: &mut RBalance,
    curator_y: &mut YBalance,        // optional Y staking
    post_address: &ContentAddress,
    r_amount: u64,
    y_amount: u64,                   // 0 if no Y staking
    current_epoch: u64,
    sk: &SecretKey,
) -> Result<CurationStake, CurationError>;
```

**Constraints:**
- `r_amount > 0` (must stake some R)
- `r_amount <= curator_r.balance` (can't stake more R than you have)
- `y_amount <= curator_y.balance` (if staking Y)
- Cannot curate the same post twice
- Cannot curate your own post (self-dealing prevention)

### Stake Resolution (after cooling period)

```rust
/// Resolve a curation stake after the cooling period.
/// Returns R/Y deltas for the curator.
pub fn resolve_curation_stake(
    stake: &CurationStake,
    post_diversity_score: f64,
    current_epoch: u64,
) -> Result<CurationOutcome, CurationError> {
    // Must be past cooling period
    if current_epoch < stake.staked_at_epoch + COOLING_PERIOD_EPOCHS {
        return Err(CurationError::CoolingPeriodNotOver);
    }

    if post_diversity_score >= DIVERSITY_THRESHOLD {
        // SUCCESS: curator gains R + gets Y back (+ bonus)
        Ok(CurationOutcome::Success {
            r_earned: compute_curation_r_reward(stake, post_diversity_score),
            y_returned: stake.y_staked,
            y_bonus: compute_curation_y_bonus(stake, post_diversity_score),
        })
    } else {
        // FAILURE: curator loses portion of staked R + Y
        Ok(CurationOutcome::Failure {
            r_slashed: stake.r_staked / 2,  // Lose half staked R
            y_slashed: stake.y_staked / 4,  // Lose quarter staked Y
        })
    }
}

pub enum CurationOutcome {
    Success {
        r_earned: u64,
        y_returned: u64,
        y_bonus: u64,
    },
    Failure {
        r_slashed: u64,
        y_slashed: u64,
    },
}
```

### Curation R Reward Calculation

```rust
/// R earned from a successful curation.
/// Proportional to stake relative to total DiversityScore.
fn compute_curation_r_reward(
    stake: &CurationStake,
    post_diversity_score: f64,
) -> u64 {
    // Base reward: proportional to sqrt(staked_R)
    let base = (stake.r_staked as f64).sqrt();

    // Scale by how much the post exceeded threshold
    let excess_ratio = (post_diversity_score / DIVERSITY_THRESHOLD).min(5.0);

    (base * excess_ratio) as u64
}
```

## R Earning (`earning.rs`)

R is earned from two sources:

### 1. Successful Curation

As described above. The primary R-earning mechanism.

### 2. Content Creation

Posts that achieve high DiversityScore earn the creator R:

```rust
/// R earned by a post creator based on the post's DiversityScore.
pub fn creator_r_reward(
    diversity_score: f64,
    creator_current_r: u64,
) -> u64 {
    if diversity_score < DIVERSITY_THRESHOLD {
        return 0;
    }

    // Creator earns R proportional to DiversityScore, but capped
    let base = diversity_score.sqrt();

    // Diminishing returns for high-R creators (prevents runaway accumulation)
    let diminishing = 1.0 / (1.0 + (creator_current_r as f64 / R_CAP as f64));

    (base * diminishing * 10.0) as u64
}
```

### Discovery Bonus

Curators who are the FIRST to curate content from low-R users earn a multiplier:

```rust
/// Bonus multiplier for discovering underdog content.
pub fn discovery_bonus(
    curator_position: u64,    // 0 = first curator, 1 = second, etc.
    post_creator_r: u64,      // Creator's R at time of curation
) -> f64 {
    if curator_position > 2 { return 1.0; }  // Only first 3 curators get bonus

    // Larger bonus for lower-R creators
    let creator_factor = if post_creator_r < 10 {
        3.0     // 3× for very new creators
    } else if post_creator_r < 100 {
        2.0     // 2× for emerging creators
    } else {
        1.0     // No bonus for established creators
    };

    // First curator gets full bonus, second gets half, third gets quarter
    let position_factor = 1.0 / (1 << curator_position) as f64;

    1.0 + (creator_factor - 1.0) * position_factor
}
```

## R Decay (`decay.rs`)

R decays at a fixed rate per epoch, forcing ongoing participation.

```rust
/// Fixed decay rate: 10% per epoch (1000 basis points).
pub const R_DECAY_BPS: u64 = 1_000;

/// Apply R decay at epoch boundary.
pub fn apply_decay(current_r: u64) -> u64 {
    // Decay 10%: new_r = current_r * 90%
    current_r * (10_000 - R_DECAY_BPS) / 10_000
}
```

### Decay Timeline

| Starting R | After 1 Epoch | After 5 Epochs | After 10 Epochs |
|---|---|---|---|
| 1000 | 900 | 590 | 348 |
| 100 | 90 | 59 | 34 |
| 10 | 9 | 5 | 3 |

This means a user who stops participating will lose most R within ~10 epochs. Continuous participation required.

## R Slashing (`slashing.rs`)

R is slashed (destroyed) for proven fraud:

```rust
/// Slash R for a proven offense.
pub fn slash_r(
    current_r: &mut RBalance,
    offense: SlashableOffense,
) -> u64 {
    let slash_amount = match offense {
        SlashableOffense::DoubleSpend => current_r.balance,        // 100% slash
        SlashableOffense::FalseClaimY => current_r.balance,        // 100% slash
        SlashableOffense::FalseFraudAccusation => current_r.balance / 2, // 50% slash
        SlashableOffense::InviteeSpam => current_r.balance / 4,   // 25% slash (inviter penalty)
    };

    current_r.balance = current_r.balance.saturating_sub(slash_amount);
    slash_amount
}

pub enum SlashableOffense {
    /// Y double-spend detected (fraud proof exists).
    DoubleSpend,
    /// Claimed more Y than entitled.
    FalseClaimY,
    /// Filed a fraud proof that was invalid.
    FalseFraudAccusation,
    /// Invited a user who was flagged as spam.
    InviteeSpam,
}
```

## Full R Computation (`computation.rs`)

### Deterministic R Computation

R is **not** stored authoritatively — it's deterministically computable from public data. The R balance in a user's Scratchpad is a self-claimed cache that watchers verify.

```rust
/// Compute the correct R balance for a user from scratch.
/// Reads all relevant data from Autonomi storage.
pub async fn compute_r_from_scratch(
    storage: &dyn Storage,
    user: &PublicKey,
    up_to_epoch: u64,
) -> Result<u64, ComputationError> {
    let mut r: u64 = 0;

    for epoch in 0..=up_to_epoch {
        // 1. Apply decay from previous epoch
        if epoch > 0 {
            r = apply_decay(r);
        }

        // 2. Add R earned from successful curations this epoch
        let curations = get_user_curations(storage, user, epoch).await?;
        for curation in &curations {
            let post_score = compute_post_diversity_score(storage, &curation.post_address, epoch).await?;
            match resolve_curation_stake(curation, post_score, epoch)? {
                CurationOutcome::Success { r_earned, .. } => {
                    r = r.saturating_add(r_earned);
                }
                CurationOutcome::Failure { r_slashed, .. } => {
                    r = r.saturating_sub(r_slashed);
                }
            }
        }

        // 3. Add R earned from content creation
        let posts = get_user_posts(storage, user, epoch).await?;
        for post in &posts {
            let score = compute_post_diversity_score(storage, &post.address, epoch).await?;
            r = r.saturating_add(creator_r_reward(score, r));
        }

        // 4. Subtract R slashed for any offenses
        let slashes = get_user_slashes(storage, user, epoch).await?;
        for slash in &slashes {
            r = r.saturating_sub(slash_r_amount(&slash));
        }

        // 5. Enforce R cap
        r = r.min(R_CAP);
    }

    Ok(r)
}
```

### Verification

```rust
/// Verify a user's self-claimed R balance.
pub async fn verify_r_balance(
    storage: &dyn Storage,
    claimed: &RBalance,
) -> Result<RVerdict, ComputationError> {
    let correct = compute_r_from_scratch(storage, &claimed.owner, claimed.computed_at_epoch).await?;

    if claimed.balance == correct {
        Ok(RVerdict::Valid)
    } else {
        Ok(RVerdict::Invalid { claimed: claimed.balance, correct })
    }
}
```

## R Cap

```rust
/// Maximum R any single user can hold.
/// Limits individual influence regardless of tenure.
pub const R_CAP: u64 = 1_000;
```

The cap ensures:
- No single user can dominate curation votes
- Long-time users don't become untouchable
- New users can reach meaningful influence relatively quickly

## Anti-Gaming Analysis

### Bot Swarms

Bots start with R = 0. `sqrt(0) = 0` contribution to DiversityScore. They must first earn genuine R through weeks of honest participation. Even then, each bot's individual contribution is small due to `sqrt()`.

**Cost analysis**: Each bot needs an Autonomi account (ANT cost) + genuine participation over multiple epochs to accumulate meaningful R. The economic cost of building a bot army with significant R is prohibitive.

### Collusion Rings

A group of users curating each other's posts:
- `DecayMultiplier` detects coordinated timing (many curations arriving before organic viewership)
- R is soulbound — can't pool it
- The group's total `sqrt(R)` contributions are bounded by the cap
- Need diverse *independent* curators for high DiversityScore

### Self-Dealing

Curating your own post is blocked. Even if you use an alt account, that alt must have independently earned R, and your single `sqrt(R)` contribution is dwarfed by many independent curators needed for the DiversityScore threshold.

### Content Farms

Mass mediocre content:
- Each post needs independent curators to succeed
- Curators risk R by staking on bad content
- Rational curators only stake on content they believe will attract diverse engagement

## Error Types

```rust
#[derive(Debug, thiserror::Error)]
pub enum CurationError {
    #[error("cannot curate own post")]
    SelfCuration,

    #[error("already curated this post")]
    AlreadyCurated,

    #[error("insufficient R: have {have}, staking {staking}")]
    InsufficientR { have: u64, staking: u64 },

    #[error("cooling period not over: staked epoch {staked}, current {current}, need {need}")]
    CoolingPeriodNotOver { staked: u64, current: u64, need: u64 },

    #[error("data error: {0}")]
    Data(#[from] DataError),
}

#[derive(Debug, thiserror::Error)]
pub enum ComputationError {
    #[error("epoch {epoch} boundary not found")]
    EpochNotFound { epoch: u64 },

    #[error("data error: {0}")]
    Data(#[from] DataError),
}
```
