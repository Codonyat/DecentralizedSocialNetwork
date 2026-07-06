# Decentralized Content Moderation Protocol (`dsn-moderation`)

## Purpose

Content moderation separates **existence** from **visibility**. Data stored on Autonomi is permanent and uncensorable (existence). Indexers decide what to serve, and users choose which indexer to trust (visibility). This crate provides the flagging, counter-flagging, aggregation, and policy machinery that indexers use to make visibility decisions.

The protocol is fully transparent: all flags are public GraphEntries on Autonomi, all scoring is deterministic, and any observer can audit the moderation history of any post or user.

One caveat must be stated honestly: for illegal content (e.g., CSAM), "existence is uncensorable" is **not** an adequate answer. Permanent storage of such material is real legal exposure for storage node operators, indexers, and the project. The flagging machinery in this document governs *visibility only*; handling at the storage layer -- chunk-level blocklist standards and hash-list integration that storage nodes can adopt -- is required and is tracked as an open protocol issue (doc 09 §2.5).

## Module Structure

```
crates/moderation/src/
├── lib.rs              # Re-exports
├── flag.rs             # ContentFlag creation, validation, serialization
├── counter_flag.rs     # Counter-flag (contest) creation and validation
├── aggregation.rs      # Flag score aggregation and uniform scoring
├── policy.rs           # ModerationPolicy trait + built-in policies
├── reputation.rs       # Flagger and reviewer reputation tracking (accuracy-based)
├── review.rs           # Broader community review triggered by counter-flags
└── error.rs            # Moderation error types
```

## Design Principles

1. **No censorship at the data layer** -- Autonomi stores everything permanently. Flags are metadata *about* content, not deletion requests.
2. **Indexer sovereignty** -- Each indexer chooses its own `ModerationPolicy`. Users who disagree switch indexers.
3. **Eligibility-gated flagging** -- Only users who are invited, have sufficient account age, and hold an active moderation bond can flag. The bond makes every flagging identity carry an objective, per-identity capital cost (doc 09 §2.5).
4. **Uniform influence** -- Each eligible flagger/reviewer contributes weight 1.0, preventing any single account from dominating moderation outcomes.
5. **Accountability** -- Flags and review votes are signed and permanent. Flaggers and reviewers who abuse the system lose credibility (low accuracy causes their flags or review votes to be ignored by indexers).
6. **Contestability** -- Flagged content authors can counter-flag, triggering broader community review.

## Eligibility Criteria

A user is **eligible** to flag or review if all of the following are true:

1. **Invited**: The user has an on-chain invitation record (exists in the web-of-trust graph).
2. **Account age**: The user's account is at least `MIN_ACCOUNT_AGE_EPOCHS` epochs old.
3. **Moderation bond**: The user has an active moderation bond: `MODERATION_BOND_Y` (10 Y) locked in the on-chain service registry's moderator role (doc 11). The bond is refundable after `MODERATION_BOND_COOLDOWN_EPOCHS` epochs once the user exits moderation.

The bond replaces the earlier donation-count criterion, which was judged purchasable -- dust donations bought moderation votes, and any donation-derived criterion inherited wash-traffic corruption (doc 09 §2.5). A locked bond is an objective, on-chain fact with a real per-identity capital cost.

Each eligible user receives a uniform weight of **1.0** for flagging and reviewing.

```rust
/// Check whether a user is eligible to flag or review.
pub fn is_eligible(
    user: &PublicKey,
    eligible_accounts: &HashSet<PublicKey>,
) -> bool {
    eligible_accounts.contains(user)
}
```

Indexers are responsible for computing the set of eligible accounts based on on-chain data (invitation records, account creation epochs, active moderation bonds).

## Type Definitions

### Flag Reason (`flag.rs`)

Note that misinformation is deliberately not a protocol-level reason: truth-by-majority-vote is not resolvable at the protocol layer and was the primary brigading target in any polarized topic (doc 09 §2.5); indexers that want such categories define policy-specific vocabularies via `Other` plus their published policy metadata.

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
    // 3 reserved (Misinformation removed from the protocol vocabulary, doc 09 §2.5)
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

    /// Weighted flag score: count of eligible flaggers whose flags are
    /// ACTIVE, i.e. not nullified by a resolved overturn (each weight 1.0).
    pub weighted_flag_score: f64,

    /// Informational: count of eligible overturn voters (each weight 1.0).
    /// A review-outcome input, not a score component -- overturn votes decide
    /// review resolution, which nullifies flags; they are never subtracted.
    pub weighted_overturn_score: f64,

    /// Informational: count of eligible uphold voters (each weight 1.0).
    /// A review-outcome input, not a score component -- uphold votes resolve
    /// the review but never add to the score.
    pub weighted_uphold_score: f64,

    /// Net moderation score: the weighted score of active (non-nullified)
    /// flags. Positive = content is flagged. Zero = content is clean.
    pub net_score: f64,

    /// Number of unique flaggers (including those whose flags were nullified).
    pub flag_count: u32,

    /// Number of flags nullified by a resolved overturn.
    pub nullified_flag_count: u32,

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
2. Alice's client verifies she is eligible (invited, sufficient account age, active moderation bond).
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

1. Indexers detect the counter-flag and mark the post as "under review" (`review_active`); the existing flags remain counted while the review runs.
2. Eligible community members (invited + account age >= `MIN_ACCOUNT_AGE_EPOCHS` + active moderation bond) can cast `ReviewVote` entries.
3. The review window lasts `REVIEW_PERIOD_EPOCHS` epochs.
4. Each eligible reviewer contributes weight 1.0.
5. Each reviewer may only vote once per review (enforced by derived key uniqueness).

### Step 5: Review Resolution

1. After the review period, indexers tally `weighted_uphold_score` vs `weighted_overturn_score`.
2. If `weighted_overturn_score > weighted_uphold_score`:
   - The flag is **overturned**. The flags covered by the review are **nullified** -- excluded from the flag score entirely -- and the post is restored to visibility.
   - The original flagger's accuracy is penalized (see Reputation below).
3. If `weighted_uphold_score >= weighted_overturn_score`:
   - The flag is **upheld**. The flags remain active and the post remains hidden. Uphold votes do not add to the score; they only resolve the review.
   - The contester receives no penalty (contesting is free except for the effort).
4. In either case, if the review resolved with a margin >= 2:1, reviewers on the losing side have their accuracy decremented (see Reviewer Accountability below); narrower verdicts affect nobody's accuracy.

## Flag Aggregation and Scoring (`aggregation.rs`)

### Core Scoring Formula

```rust
/// Aggregate all flags, counter-flags, review votes, and resolved review
/// outcomes for a post.
///
/// Scoring model (doc 09 §2.5): the net score is the weighted score of
/// ACTIVE flags only. A review that resolves as `FlagOverturned` NULLIFIES
/// the flags it covered -- they are excluded from the score entirely, not
/// merely outvoted. While a review is active the flags remain counted and
/// the post is marked `review_active`. Uphold votes never add to the score;
/// they only resolve the review.
pub fn aggregate_moderation_score(
    flags: &[ContentFlag],
    counter_flags: &[CounterFlag],
    review_votes: &[ReviewVote],
    resolved_reviews: &[ReviewState],        // Resolved reviews for this post
    eligible_accounts: &HashSet<PublicKey>,  // Eligible accounts computed by indexer
    current_epoch: u64,
) -> PostModerationScore {
    let mut weighted_flag_score = 0.0_f64;
    let mut weighted_overturn_score = 0.0_f64;
    let mut weighted_uphold_score = 0.0_f64;
    let mut nullified_flag_count = 0_u32;
    let mut reason_scores: HashMap<FlagReason, f64> = HashMap::new();
    let mut unique_flaggers: HashSet<PublicKey> = HashSet::new();

    // 1. Determine the nullification cutoff: each review that resolved as
    //    FlagOverturned nullifies the flags it covered -- every flag on this
    //    post submitted before that review resolved.
    let mut nullify_before_epoch: Option<u64> = None;
    for review in resolved_reviews {
        if let ReviewState::Resolved {
            outcome: ResolvedOutcome::FlagOverturned { .. },
            resolved_at_epoch,
        } = review {
            nullify_before_epoch = Some(
                nullify_before_epoch.map_or(*resolved_at_epoch, |e| e.max(*resolved_at_epoch)),
            );
        }
    }

    // 2. Score ACTIVE flags (each eligible flagger contributes weight 1.0)
    for flag in flags {
        if !eligible_accounts.contains(&flag.flagger) {
            continue; // Not eligible, ignore flag
        }

        // Each flagger counted only once per post
        if !unique_flaggers.insert(flag.flagger.clone()) {
            continue;
        }

        // Nullified by a resolved overturn: excluded from the score entirely
        if let Some(cutoff) = nullify_before_epoch {
            if flag.flagged_at_epoch < cutoff {
                nullified_flag_count += 1;
                continue;
            }
        }

        let weight = 1.0;
        weighted_flag_score += weight;

        *reason_scores.entry(flag.reason).or_insert(0.0) += weight;
    }

    // 3. Determine if a review is active (flags stay counted meanwhile)
    let review_active = !counter_flags.is_empty()
        && counter_flags.iter().any(|cf| {
            current_epoch < cf.countered_at_epoch + REVIEW_PERIOD_EPOCHS
        });

    // 4. Tally review votes (informational; they decide review resolution,
    //    they are NOT score components)
    let mut unique_reviewers: HashSet<PublicKey> = HashSet::new();
    for vote in review_votes {
        if !eligible_accounts.contains(&vote.reviewer) {
            continue;
        }

        if !unique_reviewers.insert(vote.reviewer.clone()) {
            continue;
        }

        let weight = 1.0;
        match vote.verdict {
            ReviewVerdict::UpholdFlag => weighted_uphold_score += weight,
            ReviewVerdict::OverturnFlag => weighted_overturn_score += weight,
        }
    }

    // 5. Compute net score: active (non-nullified) flags only
    let net_score = weighted_flag_score;

    PostModerationScore {
        post_address: flags.first()
            .map(|f| f.post_address.clone())
            .unwrap_or(ContentAddress([0u8; 32])),
        weighted_flag_score,
        weighted_overturn_score,
        weighted_uphold_score,
        net_score,
        flag_count: unique_flaggers.len() as u32,
        nullified_flag_count,
        counter_flag_count: counter_flags.len() as u32,
        review_vote_count: unique_reviewers.len() as u32,
        review_active,
        reason_scores,
        computed_at_epoch: current_epoch,
    }
}
```

### Score Examples

| Scenario | Eligible Flaggers | Net Score | Outcome (default policy, threshold=10.0) |
|---|---|---|---|
| 1 eligible user flags | 1 | 1.0 | Visible (below threshold) |
| 10 eligible users flag | 10 | 10.0 | Hidden |
| 3 eligible users flag | 3 | 3.0 | Visible (below threshold) |
| 12 flag, review resolves 8 overturn vs 3 uphold | 12, all nullified by the overturn | net = 0.0 | Visible (overturn nullifies the flags) |
| 15 flag, review resolves 2 overturn vs 5 uphold | 15, all remain active | net = 15.0 | Hidden (upheld; uphold votes add nothing) |

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

## Flagger and Reviewer Reputation Tracking (`reputation.rs`)

### Flagger Record

Accuracy is computed **only from flags that went through a resolved community review**. Uncontested flags carry no accuracy signal either way. (An earlier revision counted uncontested flags as upheld; that let flaggers farm accuracy by targeting users unlikely to counter-flag -- newcomers, casual users -- and was removed per doc 09 §2.5.)

```rust
/// Tracks a flagger's moderation history.
/// Indexers maintain this locally; the underlying data (flags, reviews) is all on Autonomi.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FlaggerRecord {
    pub flagger: PublicKey,

    /// Total flags submitted by this user (contested or not).
    pub total_flags: u64,

    /// Flags that were upheld by a resolved community review.
    pub resolved_upheld: u64,

    /// Flags that were overturned by a resolved community review.
    pub resolved_overturned: u64,

    /// Flags currently under review.
    pub pending_review_flags: u64,

    /// Computed accuracy rate: resolved_upheld / (resolved_upheld + resolved_overturned).
    /// Only resolved reviews move this number; uncontested flags carry
    /// NO accuracy signal either way (doc 09 §2.5).
    pub accuracy_rate: f64,
}
```

### Reputation Tracking

```rust
/// Threshold: if a flagger's accuracy drops below this, their future flags
/// are ignored by indexers.
pub const MIN_FLAGGER_ACCURACY: f64 = 0.5;

/// Determine if a flagger should be trusted based on their track record.
pub fn is_flagger_trusted(record: &FlaggerRecord) -> bool {
    // Flaggers with < 3 resolved reviews are trusted by default
    // (uncontested flags carry no accuracy signal, doc 09 §2.5)
    if record.resolved_upheld + record.resolved_overturned < 3 {
        return true;
    }
    record.accuracy_rate >= MIN_FLAGGER_ACCURACY
}

/// Update a flagger's record after a review RESOLVES.
/// This is the only path that moves accuracy: flags that are never
/// contested leave the record untouched.
pub fn update_flagger_record(
    record: &mut FlaggerRecord,
    outcome: ReviewOutcome,
) {
    match outcome {
        ReviewOutcome::Upheld => {
            record.resolved_upheld += 1;
        }
        ReviewOutcome::Overturned => {
            record.resolved_overturned += 1;
        }
    }

    let total_resolved = record.resolved_upheld + record.resolved_overturned;
    if total_resolved > 0 {
        record.accuracy_rate = record.resolved_upheld as f64 / total_resolved as f64;
    }
}

/// The outcome of a review for a specific flag.
pub enum ReviewOutcome {
    /// The flag was correct.
    Upheld,
    /// The flag was overturned; the flagger loses credibility (no economic penalty).
    Overturned,
}
```

Bad flaggers (those with low accuracy) have their flags ignored by indexers -- no economic penalty, just credibility loss. Once a flagger's accuracy drops below `MIN_FLAGGER_ACCURACY`, their flags are effectively invisible to the moderation system.

### Reviewer Accountability

Reviewers face consequences symmetrical to flaggers. After a review resolves with a **decisive margin** (winning side >= 2:1 over the losing side), every reviewer on the losing side has their accuracy decremented. Reviews that resolve with a narrow margin (< 2:1) affect nobody's accuracy -- close calls are not evidence of bad faith. Once a reviewer's accuracy drops below `MIN_REVIEWER_ACCURACY`, indexers ignore their future review votes, exactly as they ignore low-accuracy flaggers' flags.

```rust
/// Reviewer accuracy below which future review votes are ignored by indexers.
pub const MIN_REVIEWER_ACCURACY: f64 = 0.5;

/// Winning-side : losing-side margin at or above which a resolved review
/// moves reviewer accuracy. Narrower verdicts affect nobody.
pub const REVIEWER_ACCURACY_MARGIN: f64 = 2.0;

/// Tracks a reviewer's moderation history.
/// Indexers maintain this locally; the underlying data (review votes) is all on Autonomi.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReviewerRecord {
    pub reviewer: PublicKey,

    /// Total review votes cast by this user.
    pub total_votes: u64,

    /// Votes on the winning side of a decisively resolved review (margin >= 2:1).
    pub decisive_majority_votes: u64,

    /// Votes on the losing side of a decisively resolved review (margin >= 2:1).
    pub decisive_minority_votes: u64,

    /// Computed accuracy rate:
    /// decisive_majority / (decisive_majority + decisive_minority).
    /// Narrow-margin reviews (< 2:1) carry no accuracy signal either way.
    pub accuracy_rate: f64,
}

/// Determine if a reviewer's votes should be counted.
pub fn is_reviewer_trusted(record: &ReviewerRecord) -> bool {
    // Reviewers with < 3 decisively resolved reviews are trusted by default
    if record.decisive_majority_votes + record.decisive_minority_votes < 3 {
        return true;
    }
    record.accuracy_rate >= MIN_REVIEWER_ACCURACY
}

/// Update reviewer records after a review resolves.
/// Only decisive resolutions (margin >= 2:1) move anyone's accuracy.
pub fn update_reviewer_records(
    records: &mut HashMap<PublicKey, ReviewerRecord>,
    votes_uphold: &[PublicKey],
    votes_overturn: &[PublicKey],
) {
    let (winners, losers) = if votes_uphold.len() >= votes_overturn.len() {
        (votes_uphold, votes_overturn)
    } else {
        (votes_overturn, votes_uphold)
    };

    // Narrow margin: no accuracy signal for anyone
    if (winners.len() as f64) < REVIEWER_ACCURACY_MARGIN * (losers.len() as f64) {
        return;
    }

    for pk in winners {
        let record = records.entry(pk.clone()).or_insert_with(|| ReviewerRecord::new(pk.clone()));
        record.decisive_majority_votes += 1;
        recompute_reviewer_accuracy(record);
    }
    for pk in losers {
        let record = records.entry(pk.clone()).or_insert_with(|| ReviewerRecord::new(pk.clone()));
        record.decisive_minority_votes += 1;
        recompute_reviewer_accuracy(record);
    }
}

fn recompute_reviewer_accuracy(record: &mut ReviewerRecord) {
    let decisive = record.decisive_majority_votes + record.decisive_minority_votes;
    if decisive > 0 {
        record.accuracy_rate = record.decisive_majority_votes as f64 / decisive as f64;
    }
}
```

## Broader Community Review (`review.rs`)

### Review Lifecycle

```rust
/// Configuration constants for the review process.
pub const REVIEW_PERIOD_EPOCHS: u64 = 2;
pub const MIN_REVIEW_VOTES: u32 = 5;   // Minimum votes for a decisive review

/// State machine for a review triggered by a counter-flag.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ReviewState {
    /// Review is active; votes are being collected.
    Active {
        counter_flag_ref: ContentAddress,
        started_at_epoch: u64,
        votes_uphold: Vec<PublicKey>,
        votes_overturn: Vec<PublicKey>,
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
        uphold_count: u32,
        overturn_count: u32,
    },
    /// Community overturned the flag.
    FlagOverturned {
        uphold_count: u32,
        overturn_count: u32,
    },
}
```

### Review Resolution Logic

```rust
/// Resolve a review after the review period has elapsed.
pub fn resolve_review(
    counter_flag: &CounterFlag,
    review_votes: &[ReviewVote],
    eligible_accounts: &HashSet<PublicKey>,
    current_epoch: u64,
) -> Result<ReviewState, ModerationError> {
    // Must be past review period
    if current_epoch < counter_flag.countered_at_epoch + REVIEW_PERIOD_EPOCHS {
        return Err(ModerationError::ReviewPeriodNotOver);
    }

    let mut uphold_count = 0_u32;
    let mut overturn_count = 0_u32;
    let mut votes_uphold = Vec::new();
    let mut votes_overturn = Vec::new();
    let mut unique_voters: HashSet<PublicKey> = HashSet::new();

    for vote in review_votes {
        if !eligible_accounts.contains(&vote.reviewer) {
            continue;
        }
        if !unique_voters.insert(vote.reviewer.clone()) {
            continue;
        }

        match vote.verdict {
            ReviewVerdict::UpholdFlag => {
                uphold_count += 1;
                votes_uphold.push(vote.reviewer.clone());
            }
            ReviewVerdict::OverturnFlag => {
                overturn_count += 1;
                votes_overturn.push(vote.reviewer.clone());
            }
        }
    }

    // Not enough votes for a decisive outcome
    if unique_voters.len() < MIN_REVIEW_VOTES as usize {
        return Ok(ReviewState::Inconclusive {
            ended_at_epoch: current_epoch,
        });
    }

    if overturn_count > uphold_count {
        Ok(ReviewState::Resolved {
            outcome: ResolvedOutcome::FlagOverturned {
                uphold_count,
                overturn_count,
            },
            resolved_at_epoch: current_epoch,
        })
    } else {
        Ok(ReviewState::Resolved {
            outcome: ResolvedOutcome::FlagUpheld {
                uphold_count,
                overturn_count,
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
/// Minimum account age (in epochs) required to flag or review.
pub const MIN_ACCOUNT_AGE_EPOCHS: u64 = 2;

/// Moderation bond required to flag or review: Y locked in the on-chain
/// service registry's moderator role (doc 11).
pub const MODERATION_BOND_Y: u64 = 10_000_000; // 10 Y (6 decimals, doc 03)

/// Epochs after exiting moderation before the bond is refundable.
pub const MODERATION_BOND_COOLDOWN_EPOCHS: u64 = 4;

/// Number of epochs a review remains open for voting.
pub const REVIEW_PERIOD_EPOCHS: u64 = 2;

/// Minimum number of unique review voters for a decisive outcome.
pub const MIN_REVIEW_VOTES: u32 = 5;

/// Flagger accuracy below which future flags are ignored.
pub const MIN_FLAGGER_ACCURACY: f64 = 0.5;

/// Reviewer accuracy below which future review votes are ignored.
pub const MIN_REVIEWER_ACCURACY: f64 = 0.5;

/// Winning-side : losing-side margin at or above which a resolved review
/// moves reviewer accuracy.
pub const REVIEWER_ACCURACY_MARGIN: f64 = 2.0;

/// Maximum length of flag explanation text (characters).
pub const MAX_EXPLANATION_CHARS: usize = 512;
```

## Validation Rules

### Flag Validation

```rust
/// Validate a content flag before accepting it.
pub fn validate_flag(
    flag: &ContentFlag,
    eligible_accounts: &HashSet<PublicKey>,
) -> Result<(), ModerationError> {
    // 1. Signature must verify
    if !flag.verify_signature() {
        return Err(ModerationError::InvalidSignature);
    }

    // 2. Flagger must be eligible
    if !eligible_accounts.contains(&flag.flagger) {
        return Err(ModerationError::NotEligible {
            reason: "flagger is not eligible (must be invited, have sufficient account age, and an active moderation bond)".to_string(),
        });
    }

    // 3. Cannot flag own content
    if flag.flagger == flag.post_author {
        return Err(ModerationError::CannotFlagOwnContent);
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

    #[error("not eligible: {reason}")]
    NotEligible { reason: String },

    #[error("cannot flag own content")]
    CannotFlagOwnContent,

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

Bots cannot meet eligibility requirements: they lack on-chain invitations, have no account age, and hold no moderation bond. Even if a bot obtains an invitation, it must wait `MIN_ACCOUNT_AGE_EPOCHS` epochs and lock `MODERATION_BOND_Y` (10 Y) in the service registry's moderator role before it can flag. The bond is a **per-identity capital cost**: a botnet must lock real Y for every flagging identity it operates, so scaling flag spam scales locked capital linearly, and the `MODERATION_BOND_COOLDOWN_EPOCHS` cooldown prevents rapidly recycling one bond across throwaway identities.

### Coordinated Flag Brigading

A group conspires to flag legitimate content:
- Each eligible flagger contributes exactly 1.0, so the damage is proportional to headcount.
- The author counter-flags, triggering review.
- Independent reviewers (not part of the brigade) vote to overturn.
- Every brigade member who flagged loses accuracy, and once accuracy drops below `MIN_FLAGGER_ACCURACY`, their future flags are ignored entirely.
- Brigading the review itself now costs the brigade its reviewing power too: if the review resolves decisively (margin >= 2:1) against them, every brigade reviewer on the losing side loses accuracy, and below `MIN_REVIEWER_ACCURACY` their future review votes are ignored by indexers.
- All flags are public and auditable, so brigading patterns are visible.
- The eligibility threshold (invitations + account age + moderation bonds) makes it expensive to create many sockpuppet accounts for brigading -- each one must lock its own bond.

### Retaliatory Flagging

A user flags someone's content out of personal grudge:
- A single flagger contributes weight 1.0, which alone cannot reach the hide threshold (depending on indexer policy).
- The author counter-flags, and community review corrects the injustice.
- The retaliatory flagger loses accuracy, weakening future flags.

### Flag-to-Harass

A user repeatedly flags a target's content:
- Each overturn costs the flagger accuracy.
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
- Uses `ChunkStore` to store flag explanations.

### `dsn-indexer`

- The indexer calls `aggregate_moderation_score()` during its crawl cycle.
- The indexer computes the set of eligible accounts from on-chain data (invitation records, account creation epochs, and active moderation bonds in the service registry's moderator role, doc 11) and passes it to the aggregation functions.
- Applies its configured `ModerationPolicy` to decide visibility.
- Maintains `FlaggerRecord` and `ReviewerRecord` locally for reputation tracking.
