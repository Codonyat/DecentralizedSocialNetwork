# Decentralized Content Moderation Protocol (`dsn-moderation`)

## Purpose

Content moderation separates **existence** from **visibility**. Data stored on Autonomi is permanent and uncensorable (existence). Indexers decide what to serve, and users choose which indexer to trust (visibility). This crate provides the flagging, counter-flagging, aggregation, and policy machinery that indexers use to make visibility decisions.

The protocol is fully transparent: all flags are public GraphEntries on Autonomi, all scoring is deterministic, and any observer can audit the moderation history of any post or user.

## Module Structure

```
crates/moderation/src/
├── lib.rs              # Re-exports
├── flag.rs             # ContentFlag creation, validation, serialization
├── counter_flag.rs     # Counter-flag (contest) creation and validation
├── aggregation.rs      # Flag score aggregation and weighted scoring
├── policy.rs           # ModerationPolicy trait + built-in policies
├── reputation.rs       # Flagger reputation tracking and penalties
├── review.rs           # Broader community review triggered by counter-flags
└── error.rs            # Moderation error types
```

## Design Principles

1. **No censorship at the data layer** -- Autonomi stores everything permanently. Flags are metadata *about* content, not deletion requests.
2. **Indexer sovereignty** -- Each indexer chooses its own `ModerationPolicy`. Users who disagree switch indexers.
3. **Reputation-gated flagging** -- Only users with R above a threshold can flag, preventing flag spam from bots.
4. **Sublinear influence** -- Flag weight uses `sqrt(flagger_R)`, preventing whales from unilaterally hiding content.
5. **Accountability** -- Flags are signed and permanent. Flaggers who abuse the system lose R.
6. **Contestability** -- Flagged content authors can counter-flag, triggering broader community review.

## Type Definitions

### Flag Reason (`flag.rs`)

```rust
/// Reason categories for flagging content.
/// Encoded as a u8 and hashed into the GraphEntry's descendant metadata.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
#[repr(u8)]
pub enum FlagReason {
    /// Unsolicited commercial content, bot-generated spam.
    Spam = 0,
    /// Targeted abuse, threats, or doxxing directed at an individual.
    Harassment = 1,
    /// Content depicting or promoting violence.
    Violence = 2,
    /// Content that is verifiably false and likely to cause harm.
    Misinformation = 3,
    /// Content illegal in most jurisdictions (e.g., CSAM).
    IllegalContent = 4,
    /// Not safe for work (nudity, explicit material). Not inherently rule-breaking;
    /// some indexers may allow NSFW with a content warning.
    Nsfw = 5,
    /// Catch-all for violations not covered above.
    Other = 255,
}
```

### Content Flag (`flag.rs`)

```rust
/// A content flag submitted by a user.
/// Stored as a GraphEntry on Autonomi (immutable once written).
///
/// GraphEntry mapping:
///   owner:       flag_derived_key (derived from flagger's root key + flag purpose + post address)
///   parents:     [flagger_pk]
///   content:     flagged_post_address (32 bytes)
///   descendants: [(post_author_pk, flag_metadata_hash)]
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct ContentFlag {
    /// Public key of the user who submitted the flag.
    pub flagger: PublicKey,

    /// Content address of the flagged post.
    pub post_address: ContentAddress,

    /// Public key of the post's author.
    pub post_author: PublicKey,

    /// Reason for the flag.
    pub reason: FlagReason,

    /// Optional free-text explanation (max 512 chars).
    /// Stored as a Chunk; this field holds the ContentAddress of that Chunk.
    pub explanation: Option<ContentAddress>,

    /// Flagger's R balance at time of flagging (self-reported; verified by indexers).
    pub flagger_r_at_flag: u64,

    /// Epoch in which the flag was submitted.
    pub flagged_at_epoch: u64,

    /// Monotonic flag sequence per flagger (prevents replay).
    pub sequence: u64,

    /// BLS signature over all fields above.
    pub signature: Signature,
}
```

### Flag Metadata Hash

The `flag_metadata_hash` stored in the GraphEntry descendant tuple is computed as:

```rust
/// Compute the 32-byte metadata hash stored in the GraphEntry descendant.
pub fn flag_metadata_hash(flag: &ContentFlag) -> [u8; 32] {
    let bytes = bincode::serialize(&(
        flag.reason as u8,
        flag.flagger_r_at_flag,
        flag.flagged_at_epoch,
        flag.sequence,
    )).unwrap();
    hash_blake3(&bytes)
}
```

### Counter-Flag (`counter_flag.rs`)

```rust
/// A counter-flag (contest) submitted by the author of flagged content.
/// Stored as a GraphEntry on Autonomi.
///
/// GraphEntry mapping:
///   owner:       counter_flag_derived_key
///   parents:     [contester_pk]
///   content:     original_flag_address (32-byte hash identifying the flag GraphEntry)
///   descendants: [(original_flagger_pk, contest_metadata_hash)]
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct CounterFlag {
    /// The user contesting the flag (must be the flagged post's author).
    pub contester: PublicKey,

    /// Content address of the flagged post.
    pub post_address: ContentAddress,

    /// Reference to the original flag being contested.
    /// This is the ContentAddress of the serialized ContentFlag.
    pub original_flag_ref: ContentAddress,

    /// The original flagger's public key.
    pub original_flagger: PublicKey,

    /// Reason for contesting.
    pub contest_reason: ContestReason,

    /// Optional evidence (ContentAddress of a Chunk with supporting material).
    pub evidence: Option<ContentAddress>,

    /// Contester's R at time of counter-flag.
    pub contester_r_at_counter: u64,

    /// Epoch in which the counter-flag was submitted.
    pub countered_at_epoch: u64,

    /// Monotonic counter-flag sequence per contester.
    pub sequence: u64,

    /// BLS signature over all fields above.
    pub signature: Signature,
}

/// Reason for contesting a flag.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
#[repr(u8)]
pub enum ContestReason {
    /// The flag reason does not apply to this content.
    Inapplicable = 0,
    /// The content has been taken out of context.
    OutOfContext = 1,
    /// The flagger is acting in bad faith (targeted harassment via flags).
    BadFaithFlag = 2,
    /// The content is clearly satire, parody, or artistic expression.
    SatireOrArt = 3,
    /// Other reason.
    Other = 255,
}
```

### Review Vote (`review.rs`)

```rust
/// A community review vote cast during a broader review triggered by a counter-flag.
/// Stored as a GraphEntry on Autonomi.
///
/// GraphEntry mapping:
///   owner:       review_derived_key
///   parents:     [reviewer_pk]
///   content:     counter_flag_address (32 bytes)
///   descendants: [(post_author_pk, vote_metadata_hash)]
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct ReviewVote {
    /// The community member casting the review vote.
    pub reviewer: PublicKey,

    /// Reference to the counter-flag that triggered this review.
    pub counter_flag_ref: ContentAddress,

    /// The flagged post's content address.
    pub post_address: ContentAddress,

    /// The vote: uphold the original flag, or overturn it.
    pub verdict: ReviewVerdict,

    /// Reviewer's R at time of voting.
    pub reviewer_r_at_vote: u64,

    /// Epoch of the vote.
    pub voted_at_epoch: u64,

    /// Monotonic review sequence per reviewer.
    pub sequence: u64,

    /// BLS signature.
    pub signature: Signature,
}

/// The outcome a reviewer votes for.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub enum ReviewVerdict {
    /// The original flag was correct; content should remain hidden.
    UpholdFlag,
    /// The original flag was incorrect; content should be restored.
    OverturnFlag,
}
```

### Aggregated Flag Score (`aggregation.rs`)

```rust
/// The aggregated moderation score for a single post.
/// Computed by indexers from all flags, counter-flags, and review votes.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PostModerationScore {
    /// The post being scored.
    pub post_address: ContentAddress,

    /// Weighted flag score: sum of sqrt(flagger_R) for all active flags.
    pub weighted_flag_score: f64,

    /// Weighted counter-flag score: sum of sqrt(reviewer_R) for overturn votes.
    pub weighted_overturn_score: f64,

    /// Weighted uphold score: sum of sqrt(reviewer_R) for uphold votes.
    pub weighted_uphold_score: f64,

    /// Net moderation score: flag_score + uphold_score - overturn_score.
    /// Positive = content is flagged. Negative or zero = content is clean.
    pub net_score: f64,

    /// Number of unique flaggers.
    pub flag_count: u32,

    /// Number of active counter-flags.
    pub counter_flag_count: u32,

    /// Number of review votes cast.
    pub review_vote_count: u32,

    /// Whether a broader review is currently active.
    pub review_active: bool,

    /// Breakdown by flag reason.
    pub reason_scores: HashMap<FlagReason, f64>,

    /// Epoch at which this score was last computed.
    pub computed_at_epoch: u64,
}
```

## Flag Flow (Step-by-Step)

### Step 1: User Submits a Flag

1. Alice sees a post she considers spam.
2. Alice's client verifies she has `R >= MIN_FLAGGER_R` (the minimum R required to flag).
3. Alice's client constructs a `ContentFlag` with reason `Spam`.
4. Alice derives a flag-specific key: `derive_child(root_sk, b"flag" || post_address)`.
5. Alice's client serializes the flag, signs it, and writes a GraphEntry to Autonomi:
   ```
   GraphEntry {
       owner: flag_derived_pk,
       parents: [alice_pk],
       content: post_content_address,
       descendants: [(post_author_pk, flag_metadata_hash)],
   }
   ```
6. The flag is now permanently recorded on Autonomi.

### Step 2: Indexers Aggregate Flags

1. Indexers crawl GraphEntries, discovering new flags.
2. For each flagged post, the indexer computes `PostModerationScore` (see Aggregation below).
3. The indexer applies its `ModerationPolicy` to decide visibility.
4. If `net_score >= policy.hide_threshold`, the indexer hides the post from its feeds.

### Step 3 (Optional): Author Contests via Counter-Flag

1. Bob, the post author, sees his post was hidden.
2. Bob's client constructs a `CounterFlag` referencing the original flag.
3. Bob derives a counter-flag-specific key and writes a GraphEntry:
   ```
   GraphEntry {
       owner: counter_flag_derived_pk,
       parents: [bob_pk],
       content: original_flag_ref,
       descendants: [(alice_pk, contest_metadata_hash)],
   }
   ```
4. The counter-flag triggers a broader community review.

### Step 4: Broader Community Review

1. Indexers detect the counter-flag and mark the post as "under review."
2. Community members with `R >= MIN_REVIEWER_R` can cast `ReviewVote` entries.
3. The review window lasts `REVIEW_PERIOD_EPOCHS` epochs.
4. Votes are weighted by `sqrt(reviewer_R)`.
5. Each reviewer may only vote once per review (enforced by derived key uniqueness).

### Step 5: Review Resolution

1. After the review period, indexers tally `weighted_uphold_score` vs `weighted_overturn_score`.
2. If `weighted_overturn_score > weighted_uphold_score`:
   - The flag is **overturned**. The post is restored to visibility.
   - The original flagger's reputation is penalized (see Reputation below).
3. If `weighted_uphold_score >= weighted_overturn_score`:
   - The flag is **upheld**. The post remains hidden.
   - The contester receives no penalty (contesting is free except for the effort).

## Flag Aggregation and Scoring (`aggregation.rs`)

### Core Scoring Formula

```rust
/// Compute the weighted flag score for a single flag.
pub fn flag_weight(flagger_r: u64) -> f64 {
    (flagger_r as f64).sqrt()
}

/// Aggregate all flags, counter-flags, and review votes for a post.
pub fn aggregate_moderation_score(
    flags: &[ContentFlag],
    counter_flags: &[CounterFlag],
    review_votes: &[ReviewVote],
    verified_r: &HashMap<PublicKey, u64>,  // Verified R balances from indexer
    current_epoch: u64,
) -> PostModerationScore {
    let mut weighted_flag_score = 0.0_f64;
    let mut weighted_overturn_score = 0.0_f64;
    let mut weighted_uphold_score = 0.0_f64;
    let mut reason_scores: HashMap<FlagReason, f64> = HashMap::new();
    let mut unique_flaggers: HashSet<PublicKey> = HashSet::new();

    // 1. Score all flags
    for flag in flags {
        // Use indexer-verified R, not self-reported
        let r = verified_r.get(&flag.flagger).copied().unwrap_or(0);
        if r < MIN_FLAGGER_R {
            continue; // Below threshold, ignore flag
        }

        // Each flagger counted only once per post
        if !unique_flaggers.insert(flag.flagger.clone()) {
            continue;
        }

        let weight = flag_weight(r);
        weighted_flag_score += weight;

        *reason_scores.entry(flag.reason).or_insert(0.0) += weight;
    }

    // 2. Determine if a review is active
    let review_active = !counter_flags.is_empty()
        && counter_flags.iter().any(|cf| {
            current_epoch < cf.countered_at_epoch + REVIEW_PERIOD_EPOCHS
        });

    // 3. Score review votes (only if a review was triggered)
    let mut unique_reviewers: HashSet<PublicKey> = HashSet::new();
    for vote in review_votes {
        let r = verified_r.get(&vote.reviewer).copied().unwrap_or(0);
        if r < MIN_REVIEWER_R {
            continue;
        }

        if !unique_reviewers.insert(vote.reviewer.clone()) {
            continue;
        }

        let weight = flag_weight(r);
        match vote.verdict {
            ReviewVerdict::UpholdFlag => weighted_uphold_score += weight,
            ReviewVerdict::OverturnFlag => weighted_overturn_score += weight,
        }
    }

    // 4. Compute net score
    let net_score = weighted_flag_score + weighted_uphold_score - weighted_overturn_score;

    PostModerationScore {
        post_address: flags.first()
            .map(|f| f.post_address.clone())
            .unwrap_or(ContentAddress([0u8; 32])),
        weighted_flag_score,
        weighted_overturn_score,
        weighted_uphold_score,
        net_score,
        flag_count: unique_flaggers.len() as u32,
        counter_flag_count: counter_flags.len() as u32,
        review_vote_count: unique_reviewers.len() as u32,
        review_active,
        reason_scores,
        computed_at_epoch: current_epoch,
    }
}
```

### Score Examples

| Scenario | Flaggers (R) | Flag Score | Outcome (default policy, threshold=10.0) |
|---|---|---|---|
| 1 whale flags (R=1000) | [1000] | sqrt(1000) = 31.6 | Hidden |
| 10 newcomers flag (R=5 each) | [5; 10] | 10 * sqrt(5) = 22.4 | Hidden |
| 1 newcomer flags (R=5) | [5] | sqrt(5) = 2.2 | Visible (below threshold) |
| 3 mid-tier flag (R=50 each) | [50; 3] | 3 * sqrt(50) = 21.2 | Hidden |
| Whale flags, review overturns | flag=31.6, overturn=40.0 | net = 31.6 - 40.0 = -8.4 | Visible (overturned) |

## Moderation Policy Abstraction (`policy.rs`)

### The Trait

```rust
/// A moderation policy that an indexer applies to decide post visibility.
/// Different indexers can implement different policies, giving users choice.
pub trait ModerationPolicy: Send + Sync {
    /// Decide whether a post should be visible given its moderation score.
    fn should_hide(&self, score: &PostModerationScore) -> bool;

    /// Decide whether a post should show a content warning instead of being hidden.
    fn should_warn(&self, score: &PostModerationScore) -> bool;

    /// Return human-readable description of this policy (for indexer metadata).
    fn description(&self) -> &str;

    /// Return the policy's unique identifier (for user preference storage).
    fn policy_id(&self) -> &str;
}
```

### Built-In Policies

```rust
/// Default moderation policy: moderate threshold, hides clearly flagged content.
pub struct DefaultPolicy {
    /// Net score above which content is hidden.
    pub hide_threshold: f64,
    /// Net score above which a content warning is shown (below hide threshold).
    pub warn_threshold: f64,
}

impl Default for DefaultPolicy {
    fn default() -> Self {
        Self {
            hide_threshold: 10.0,
            warn_threshold: 5.0,
        }
    }
}

impl ModerationPolicy for DefaultPolicy {
    fn should_hide(&self, score: &PostModerationScore) -> bool {
        score.net_score >= self.hide_threshold
    }

    fn should_warn(&self, score: &PostModerationScore) -> bool {
        score.net_score >= self.warn_threshold && score.net_score < self.hide_threshold
    }

    fn description(&self) -> &str {
        "Default: hides content with net flag score >= 10.0, warns at >= 5.0"
    }

    fn policy_id(&self) -> &str {
        "default-v1"
    }
}

/// Strict moderation policy: lower thresholds, also applies reason-specific rules.
pub struct StrictPolicy {
    pub hide_threshold: f64,
    pub warn_threshold: f64,
    /// Reason-specific overrides: some reasons trigger hiding at lower thresholds.
    pub reason_overrides: HashMap<FlagReason, f64>,
}

impl Default for StrictPolicy {
    fn default() -> Self {
        let mut overrides = HashMap::new();
        overrides.insert(FlagReason::IllegalContent, 3.0);  // Very low threshold for illegal
        overrides.insert(FlagReason::Violence, 5.0);

        Self {
            hide_threshold: 7.0,
            warn_threshold: 3.0,
            reason_overrides: overrides,
        }
    }
}

impl ModerationPolicy for StrictPolicy {
    fn should_hide(&self, score: &PostModerationScore) -> bool {
        // Check reason-specific overrides first
        for (reason, threshold) in &self.reason_overrides {
            if let Some(reason_score) = score.reason_scores.get(reason) {
                if *reason_score >= *threshold {
                    return true;
                }
            }
        }
        score.net_score >= self.hide_threshold
    }

    fn should_warn(&self, score: &PostModerationScore) -> bool {
        score.net_score >= self.warn_threshold && !self.should_hide(score)
    }

    fn description(&self) -> &str {
        "Strict: lower thresholds, reason-specific overrides for illegal/violent content"
    }

    fn policy_id(&self) -> &str {
        "strict-v1"
    }
}

/// Permissive moderation policy: only hides content with overwhelming consensus.
pub struct PermissivePolicy {
    pub hide_threshold: f64,
}

impl Default for PermissivePolicy {
    fn default() -> Self {
        Self {
            hide_threshold: 25.0,
        }
    }
}

impl ModerationPolicy for PermissivePolicy {
    fn should_hide(&self, score: &PostModerationScore) -> bool {
        score.net_score >= self.hide_threshold
    }

    fn should_warn(&self, score: &PostModerationScore) -> bool {
        score.net_score >= 10.0 && score.net_score < self.hide_threshold
    }

    fn description(&self) -> &str {
        "Permissive: only hides content with net flag score >= 25.0"
    }

    fn policy_id(&self) -> &str {
        "permissive-v1"
    }
}

/// No moderation at all. Indexer serves everything.
pub struct UnmoderatedPolicy;

impl ModerationPolicy for UnmoderatedPolicy {
    fn should_hide(&self, _score: &PostModerationScore) -> bool {
        false
    }

    fn should_warn(&self, _score: &PostModerationScore) -> bool {
        false
    }

    fn description(&self) -> &str {
        "Unmoderated: no content is hidden or warned"
    }

    fn policy_id(&self) -> &str {
        "unmoderated-v1"
    }
}
```

### Indexer Policy Selection

Indexers advertise their policy in their public metadata. Users query the indexer's policy before subscribing:

```rust
/// Metadata an indexer publishes about its moderation stance.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct IndexerModerationMetadata {
    /// The policy ID this indexer uses.
    pub policy_id: String,
    /// Human-readable description.
    pub policy_description: String,
    /// The numeric thresholds (for transparency).
    pub hide_threshold: f64,
    pub warn_threshold: f64,
    /// Whether the indexer applies reason-specific overrides.
    pub has_reason_overrides: bool,
}
```

## Flagger Reputation Tracking (`reputation.rs`)

### Flagger Record

```rust
/// Tracks a flagger's moderation history.
/// Indexers maintain this locally; the underlying data (flags, reviews) is all on Autonomi.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FlaggerRecord {
    pub flagger: PublicKey,

    /// Total flags submitted by this user.
    pub total_flags: u64,

    /// Flags that were upheld (or never contested).
    pub upheld_flags: u64,

    /// Flags that were overturned by community review.
    pub overturned_flags: u64,

    /// Flags currently under review.
    pub pending_review_flags: u64,

    /// Computed accuracy rate: upheld / (upheld + overturned).
    /// Flags that were never contested count as upheld.
    pub accuracy_rate: f64,

    /// R penalty accumulated from overturned flags.
    pub total_r_penalty: u64,
}
```

### Reputation Penalties

```rust
/// Penalty applied when a flagger's flag is overturned.
pub const OVERTURN_R_PENALTY_BPS: u64 = 500; // 5% of flagger's R at time of flag

/// Threshold: if a flagger's accuracy drops below this, their future flags
/// are ignored by the aggregation engine (treated as if R = 0).
pub const MIN_FLAGGER_ACCURACY: f64 = 0.5;

/// Compute the R penalty for a flagger whose flag was overturned.
pub fn compute_overturn_penalty(flagger_r_at_flag: u64) -> u64 {
    flagger_r_at_flag * OVERTURN_R_PENALTY_BPS / 10_000
}

/// Determine if a flagger should be trusted based on their track record.
pub fn is_flagger_trusted(record: &FlaggerRecord) -> bool {
    // New flaggers (< 3 flags) are trusted by default
    if record.total_flags < 3 {
        return true;
    }
    record.accuracy_rate >= MIN_FLAGGER_ACCURACY
}

/// Update a flagger's record after a review concludes.
pub fn update_flagger_record(
    record: &mut FlaggerRecord,
    outcome: ReviewOutcome,
) {
    match outcome {
        ReviewOutcome::Upheld => {
            record.upheld_flags += 1;
        }
        ReviewOutcome::Overturned { r_penalty } => {
            record.overturned_flags += 1;
            record.total_r_penalty += r_penalty;
        }
    }

    let total_resolved = record.upheld_flags + record.overturned_flags;
    if total_resolved > 0 {
        record.accuracy_rate = record.upheld_flags as f64 / total_resolved as f64;
    }
}

/// The outcome of a review for a specific flag.
pub enum ReviewOutcome {
    /// The flag was correct.
    Upheld,
    /// The flag was overturned; the flagger loses R.
    Overturned { r_penalty: u64 },
}
```

### R Penalty Integration with `dsn-token-r`

When a flag is overturned, the moderation crate computes a `SlashableOffense` that is fed into `dsn-token-r`'s slashing system:

```rust
/// Create an R slash event for an overturned flag.
/// This is stored as a Chunk on Autonomi for auditability.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct FlagOverturnProof {
    /// The flagger being penalized.
    pub flagger: PublicKey,

    /// The original flag that was overturned.
    pub flag_ref: ContentAddress,

    /// The counter-flag that initiated the review.
    pub counter_flag_ref: ContentAddress,

    /// Weighted overturn score vs uphold score.
    pub overturn_score: f64,
    pub uphold_score: f64,

    /// R penalty amount.
    pub r_penalty: u64,

    /// Epoch of resolution.
    pub resolved_at_epoch: u64,

    /// Publisher's signature (any indexer can publish this proof).
    pub publisher: PublicKey,
    pub signature: Signature,
}
```

## Broader Community Review (`review.rs`)

### Review Lifecycle

```rust
/// Configuration constants for the review process.
pub const REVIEW_PERIOD_EPOCHS: u64 = 2;
pub const MIN_REVIEW_VOTES: u32 = 5;   // Minimum votes for a decisive review
pub const MIN_REVIEWER_R: u64 = 10;     // Minimum R to cast a review vote

/// State machine for a review triggered by a counter-flag.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ReviewState {
    /// Review is active; votes are being collected.
    Active {
        counter_flag_ref: ContentAddress,
        started_at_epoch: u64,
        votes_uphold: Vec<(PublicKey, f64)>,   // (reviewer, sqrt_r weight)
        votes_overturn: Vec<(PublicKey, f64)>,
    },
    /// Review period ended; outcome decided.
    Resolved {
        outcome: ResolvedOutcome,
        resolved_at_epoch: u64,
    },
    /// Not enough votes were cast; flag remains in its pre-review state.
    Inconclusive {
        ended_at_epoch: u64,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ResolvedOutcome {
    /// Community upheld the flag.
    FlagUpheld {
        uphold_score: f64,
        overturn_score: f64,
    },
    /// Community overturned the flag.
    FlagOverturned {
        uphold_score: f64,
        overturn_score: f64,
        flagger_r_penalty: u64,
    },
}
```

### Review Resolution Logic

```rust
/// Resolve a review after the review period has elapsed.
pub fn resolve_review(
    counter_flag: &CounterFlag,
    review_votes: &[ReviewVote],
    verified_r: &HashMap<PublicKey, u64>,
    current_epoch: u64,
) -> Result<ReviewState, ModerationError> {
    // Must be past review period
    if current_epoch < counter_flag.countered_at_epoch + REVIEW_PERIOD_EPOCHS {
        return Err(ModerationError::ReviewPeriodNotOver);
    }

    let mut uphold_score = 0.0_f64;
    let mut overturn_score = 0.0_f64;
    let mut votes_uphold = Vec::new();
    let mut votes_overturn = Vec::new();
    let mut unique_voters: HashSet<PublicKey> = HashSet::new();

    for vote in review_votes {
        let r = verified_r.get(&vote.reviewer).copied().unwrap_or(0);
        if r < MIN_REVIEWER_R {
            continue;
        }
        if !unique_voters.insert(vote.reviewer.clone()) {
            continue;
        }

        let weight = (r as f64).sqrt();
        match vote.verdict {
            ReviewVerdict::UpholdFlag => {
                uphold_score += weight;
                votes_uphold.push((vote.reviewer.clone(), weight));
            }
            ReviewVerdict::OverturnFlag => {
                overturn_score += weight;
                votes_overturn.push((vote.reviewer.clone(), weight));
            }
        }
    }

    // Not enough votes for a decisive outcome
    if unique_voters.len() < MIN_REVIEW_VOTES as usize {
        return Ok(ReviewState::Inconclusive {
            ended_at_epoch: current_epoch,
        });
    }

    if overturn_score > uphold_score {
        // Overturned: penalize the original flagger
        let flagger_r_at_flag = counter_flag.contester_r_at_counter; // approximate
        let penalty = compute_overturn_penalty(flagger_r_at_flag);

        Ok(ReviewState::Resolved {
            outcome: ResolvedOutcome::FlagOverturned {
                uphold_score,
                overturn_score,
                flagger_r_penalty: penalty,
            },
            resolved_at_epoch: current_epoch,
        })
    } else {
        Ok(ReviewState::Resolved {
            outcome: ResolvedOutcome::FlagUpheld {
                uphold_score,
                overturn_score,
            },
            resolved_at_epoch: current_epoch,
        })
    }
}
```

## Key Derivation for Flags

Each flag, counter-flag, and review vote is a separate GraphEntry. The derived key ensures:
1. One flag per flagger per post (deterministic key from flagger + post address).
2. One counter-flag per author per flag (deterministic key from author + flag reference).
3. One review vote per reviewer per review (deterministic key from reviewer + counter-flag reference).

```rust
/// Derive the key used for a content flag GraphEntry.
pub fn derive_flag_key(root_sk: &SecretKey, post_address: &ContentAddress) -> SecretKey {
    root_sk.derive_child(&[b"flag", post_address.0.as_slice()].concat())
}

/// Derive the key used for a counter-flag GraphEntry.
pub fn derive_counter_flag_key(
    root_sk: &SecretKey,
    flag_ref: &ContentAddress,
) -> SecretKey {
    root_sk.derive_child(&[b"counter-flag", flag_ref.0.as_slice()].concat())
}

/// Derive the key used for a review vote GraphEntry.
pub fn derive_review_vote_key(
    root_sk: &SecretKey,
    counter_flag_ref: &ContentAddress,
) -> SecretKey {
    root_sk.derive_child(&[b"review-vote", counter_flag_ref.0.as_slice()].concat())
}
```

## Constants

```rust
/// Minimum R required to submit a content flag.
pub const MIN_FLAGGER_R: u64 = 5;

/// Minimum R required to cast a review vote.
pub const MIN_REVIEWER_R: u64 = 10;

/// Number of epochs a review remains open for voting.
pub const REVIEW_PERIOD_EPOCHS: u64 = 2;

/// Minimum number of unique review voters for a decisive outcome.
pub const MIN_REVIEW_VOTES: u32 = 5;

/// R penalty rate for overturned flags (basis points of flagger's R at flag time).
pub const OVERTURN_R_PENALTY_BPS: u64 = 500;

/// Flagger accuracy below which future flags are ignored.
pub const MIN_FLAGGER_ACCURACY: f64 = 0.5;

/// Maximum length of flag explanation text (characters).
pub const MAX_EXPLANATION_CHARS: usize = 512;
```

## Validation Rules

### Flag Validation

```rust
/// Validate a content flag before accepting it.
pub fn validate_flag(
    flag: &ContentFlag,
    verified_r: &HashMap<PublicKey, u64>,
) -> Result<(), ModerationError> {
    // 1. Signature must verify
    if !flag.verify_signature() {
        return Err(ModerationError::InvalidSignature);
    }

    // 2. Flagger must have sufficient R
    let r = verified_r.get(&flag.flagger).copied().unwrap_or(0);
    if r < MIN_FLAGGER_R {
        return Err(ModerationError::InsufficientR {
            have: r,
            required: MIN_FLAGGER_R,
        });
    }

    // 3. Cannot flag own content
    if flag.flagger == flag.post_author {
        return Err(ModerationError::CannotFlagOwnContent);
    }

    // 4. Self-reported R must approximately match verified R
    // (Allow 10% tolerance for timing differences)
    let tolerance = r / 10;
    if flag.flagger_r_at_flag > r + tolerance {
        return Err(ModerationError::RMismatch {
            claimed: flag.flagger_r_at_flag,
            verified: r,
        });
    }

    Ok(())
}
```

### Counter-Flag Validation

```rust
/// Validate a counter-flag.
pub fn validate_counter_flag(
    counter_flag: &CounterFlag,
    original_flag: &ContentFlag,
) -> Result<(), ModerationError> {
    // 1. Signature must verify
    if !counter_flag.verify_signature() {
        return Err(ModerationError::InvalidSignature);
    }

    // 2. Contester must be the flagged post's author
    if counter_flag.contester != original_flag.post_author {
        return Err(ModerationError::NotPostAuthor);
    }

    // 3. Must reference the correct flag
    if counter_flag.original_flagger != original_flag.flagger {
        return Err(ModerationError::FlagReferenceMismatch);
    }

    // 4. Post addresses must match
    if counter_flag.post_address != original_flag.post_address {
        return Err(ModerationError::PostAddressMismatch);
    }

    Ok(())
}
```

## Error Types (`error.rs`)

```rust
#[derive(Debug, thiserror::Error)]
pub enum ModerationError {
    #[error("invalid signature on moderation action")]
    InvalidSignature,

    #[error("insufficient R for flagging: have {have}, required {required}")]
    InsufficientR { have: u64, required: u64 },

    #[error("cannot flag own content")]
    CannotFlagOwnContent,

    #[error("R mismatch: claimed {claimed}, verified {verified}")]
    RMismatch { claimed: u64, verified: u64 },

    #[error("not the post author: only the post author can counter-flag")]
    NotPostAuthor,

    #[error("flag reference mismatch")]
    FlagReferenceMismatch,

    #[error("post address mismatch between flag and counter-flag")]
    PostAddressMismatch,

    #[error("review period not yet over")]
    ReviewPeriodNotOver,

    #[error("already flagged this post")]
    AlreadyFlagged,

    #[error("already voted on this review")]
    AlreadyVoted,

    #[error("flag not found: {0:?}")]
    FlagNotFound(ContentAddress),

    #[error("counter-flag not found: {0:?}")]
    CounterFlagNotFound(ContentAddress),

    #[error("explanation too long: {size} chars, max {max}")]
    ExplanationTooLong { size: usize, max: usize },

    #[error("flagger accuracy too low: {accuracy:.2}, minimum {minimum:.2}")]
    FlaggerAccuracyTooLow { accuracy: f64, minimum: f64 },

    #[error("invalid flag sequence: expected > {expected}, got {actual}")]
    InvalidSequence { expected: u64, actual: u64 },

    #[error("data layer error: {0}")]
    Data(#[from] DataError),

    #[error("serialization error: {0}")]
    Serialization(String),
}
```

## Anti-Gaming Analysis

### Flag Spam from Bots

Bots have R = 0. They cannot flag (requires `R >= MIN_FLAGGER_R`). Even if they earned minimal R through the invitation system, `sqrt(low_R)` produces negligible weight. A single legitimate reviewer with moderate R outweighs hundreds of low-R flag-spammers.

### Coordinated Flag Brigading

A group conspires to flag legitimate content:
- Each flagger's contribution is `sqrt(R)`, so amassing more flaggers has diminishing returns.
- The author counter-flags, triggering review.
- Independent reviewers (not part of the brigade) vote to overturn.
- Every brigade member who flagged loses R (5% each), making repeated brigading self-destructive.
- All flags are public and auditable, so brigading patterns are visible.

### Retaliatory Flagging

A user flags someone's content out of personal grudge:
- A single flagger with moderate R may not reach the hide threshold (depending on indexer policy).
- The author counter-flags, and community review corrects the injustice.
- The retaliatory flagger loses R and accuracy, weakening future flags.

### Flag-to-Harass

A user repeatedly flags a target's content:
- Each overturn costs the flagger R.
- After accuracy drops below `MIN_FLAGGER_ACCURACY`, the flagger's future flags are ignored entirely.
- The flagger effectively silences themselves, not their target.

### Indexer Collusion

A malicious indexer sets a hide threshold of 0 (hiding everything):
- Users can simply switch to a different indexer.
- The indexer's policy is publicly advertised; users can evaluate before subscribing.
- Competing indexers have an economic incentive to offer fair moderation.

## Integration with Other Crates

### `dsn-core`

- Uses `PublicKey`, `SecretKey`, `Signature`, `ContentAddress` for identity and addressing.
- Uses `Post` type for looking up flagged content metadata.

### `dsn-data`

- Uses `GraphStore` trait to read/write flag, counter-flag, and review vote GraphEntries.
- Uses `ChunkStore` to store flag explanations and `FlagOverturnProof` records.
- Uses `ScratchpadStore` (via `dsn-token-r`) to read verified R balances.

### `dsn-token-r`

- Reads R balances to determine flagger eligibility and flag weight.
- Produces `FlagOverturnProof` records that feed into R slashing.
- The R penalty from overturned flags is applied via `dsn-token-r`'s slashing module.

### `dsn-indexer`

- The indexer calls `aggregate_moderation_score()` during its crawl cycle.
- Applies its configured `ModerationPolicy` to decide visibility.
- Maintains `FlaggerRecord` locally for reputation tracking.
- Publishes `FlagOverturnProof` Chunks when reviews resolve.
