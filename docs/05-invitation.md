# Invitation Web of Trust & Sybil Resistance (`dsn-invitation`)

## Purpose

The invitation system provides Sybil resistance without centralized gatekeepers. Users with sufficient reputation (R) can invite new users by staking R on them. This creates an auditable web of trust stored as GraphEntries on Autonomi. Uninvited accounts can still participate but receive deprioritized treatment from indexers. The system incentivizes careful vetting of invitees through skin-in-the-game mechanics: if your invitee turns out to be spam, you lose the R you staked.

## Module Structure

```
crates/invitation/src/
├── lib.rs              # Re-exports
├── invite.rs           # Invitation creation, validation, acceptance
├── stake.rs            # R staking on invitees, stake resolution
├── capacity.rs         # Rate limiting: invitations per epoch
├── graph.rs            # Invitation graph traversal, trust verification
├── anticartel.rs       # Cartel detection, diversity bonus, pattern analysis
├── uninvited.rs        # Open entry fallback for uninvited accounts
└── error.rs            # Invitation errors
```

## Dependencies

```
dsn-invitation depends on:
  - dsn-core    (PublicKey, SecretKey, Signature, ContentAddress, GraphEntryData, RBalance)
  - dsn-data    (Storage traits: GraphStore, ScratchpadStore)
```

## Core Types

### Invitation Record

```rust
/// An invitation from one user to another.
/// Stored as a GraphEntry on Autonomi (immutable, auditable).
#[derive(Clone, Serialize, Deserialize)]
pub struct Invitation {
    /// The inviter's public key.
    pub inviter: PublicKey,

    /// The invitee's public key.
    pub invitee: PublicKey,

    /// Amount of R the inviter staked on this invitee.
    pub r_staked: u64,

    /// Epoch when the invitation was created.
    pub created_at_epoch: u64,

    /// Inviter's signature over all fields above.
    pub signature: Signature,
}
```

### GraphEntry Mapping

Invitations are stored as GraphEntries on Autonomi. The mapping from `Invitation` to `GraphEntryData`:

```
GraphEntry {
    owner: invitation_derived_key,         // Derived from inviter's root key
    parents: [inviter_pk],                 // The inviter
    content: hash(invitee_pk),             // 32-byte BLAKE3 hash of invitee's public key
    descendants: [(invitee_pk, staked_r_bytes)],  // Edge to invitee with staked R as metadata
    signature: inviter_signature,
}
```

The `staked_r_bytes` field encodes the staked R amount as a 32-byte array (u64 little-endian in the first 8 bytes, remaining bytes encode the epoch as u64 LE, rest zeroed).

```rust
/// Encode invitation metadata into the 32-byte descendant content field.
pub fn encode_invitation_metadata(r_staked: u64, epoch: u64) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    bytes[0..8].copy_from_slice(&r_staked.to_le_bytes());
    bytes[8..16].copy_from_slice(&epoch.to_le_bytes());
    bytes
}

/// Decode invitation metadata from the 32-byte descendant content field.
pub fn decode_invitation_metadata(bytes: &[u8; 32]) -> (u64, u64) {
    let r_staked = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
    let epoch = u64::from_le_bytes(bytes[8..16].try_into().unwrap());
    (r_staked, epoch)
}
```

### Invitation Status

```rust
/// Current status of an invitation, computed from on-chain data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InvitationStatus {
    /// Invitation exists and invitee has not been flagged.
    Active {
        r_staked: u64,
        created_at_epoch: u64,
    },

    /// Invitee was flagged as spam; inviter's stake is subject to slashing.
    Slashed {
        r_lost: u64,
        flagged_at_epoch: u64,
    },

    /// Invitee succeeded (earned R independently); inviter's stake is released.
    Succeeded {
        invitee_r: u64,
        released_at_epoch: u64,
    },
}
```

### Invitation Capacity

```rust
/// A user's invitation capacity for a given epoch.
#[derive(Clone, Debug)]
pub struct InvitationCapacity {
    /// The user's public key.
    pub user: PublicKey,

    /// The user's current R balance.
    pub current_r: u64,

    /// Maximum invitations this epoch.
    pub max_invitations: u64,

    /// Invitations already issued this epoch.
    pub used_invitations: u64,

    /// R currently locked in active invitation stakes.
    pub r_locked_in_stakes: u64,
}
```

### Trust Path

```rust
/// A path through the invitation graph from a genesis user to a target user.
/// Used to verify that a user is part of the web of trust.
#[derive(Clone, Debug)]
pub struct TrustPath {
    /// Ordered sequence of (inviter, invitee, r_staked) from root to target.
    pub hops: Vec<TrustHop>,

    /// Total depth (number of hops from a genesis/high-R user).
    pub depth: u64,

    /// Minimum R staked along the path (weakest link).
    pub min_stake: u64,
}

#[derive(Clone, Debug)]
pub struct TrustHop {
    pub inviter: PublicKey,
    pub invitee: PublicKey,
    pub r_staked: u64,
    pub epoch: u64,
}
```

## Constants

```rust
/// Minimum R required to issue an invitation.
pub const INVITATION_R_THRESHOLD: u64 = 50;

/// Minimum R that must be staked per invitee.
pub const MIN_INVITATION_STAKE: u64 = 10;

/// Maximum R that can be staked per invitee (prevents over-concentration).
pub const MAX_INVITATION_STAKE: u64 = 100;

/// Number of epochs before an invitation stake can be released
/// (if invitee succeeds) or slashed (if invitee is flagged).
pub const INVITATION_EVALUATION_PERIOD: u64 = 10;

/// Base number of invitations per epoch for users at R_THRESHOLD.
pub const BASE_INVITATIONS_PER_EPOCH: u64 = 1;

/// Maximum invitations per epoch (even at R_CAP).
pub const MAX_INVITATIONS_PER_EPOCH: u64 = 5;

/// R threshold at which an invitee is considered "succeeded"
/// (inviter's stake is released and diversity bonus may apply).
pub const INVITEE_SUCCESS_R_THRESHOLD: u64 = 20;

/// Weight multiplier for uninvited accounts in indexer ranking.
/// Indexers multiply an uninvited user's effective R by this factor.
pub const UNINVITED_WEIGHT_MULTIPLIER: f64 = 0.1;

/// R earning rate multiplier for uninvited accounts (slow but possible).
pub const UNINVITED_EARNING_MULTIPLIER: f64 = 0.2;

/// Maximum depth for trust path traversal (prevents infinite loops).
pub const MAX_TRUST_PATH_DEPTH: u64 = 50;

/// Second-degree diversity bonus multiplier.
/// Applied when an invitee's own invitees succeed.
pub const SECOND_DEGREE_BONUS_MULTIPLIER: f64 = 0.5;
```

## Invitation Creation (`invite.rs`)

### Creating an Invitation

```rust
/// Create a new invitation from inviter to invitee.
/// Locks `r_stake` from the inviter's R balance.
///
/// # Preconditions
/// - Inviter's R >= INVITATION_R_THRESHOLD
/// - r_stake >= MIN_INVITATION_STAKE && r_stake <= MAX_INVITATION_STAKE
/// - Inviter has remaining invitation capacity this epoch
/// - Invitee has not already been invited by this inviter
/// - Invitee is not the same as inviter (no self-invitation)
pub fn create_invitation(
    inviter_r: &mut RBalance,
    inviter_sk: &SecretKey,
    invitee: &PublicKey,
    r_stake: u64,
    current_epoch: u64,
    existing_invitations: &[Invitation],
) -> Result<Invitation, InvitationError> {
    // Validate inviter has sufficient R
    if inviter_r.balance < INVITATION_R_THRESHOLD {
        return Err(InvitationError::InsufficientR {
            have: inviter_r.balance,
            need: INVITATION_R_THRESHOLD,
        });
    }

    // Validate stake bounds
    if r_stake < MIN_INVITATION_STAKE {
        return Err(InvitationError::StakeTooLow {
            provided: r_stake,
            minimum: MIN_INVITATION_STAKE,
        });
    }
    if r_stake > MAX_INVITATION_STAKE {
        return Err(InvitationError::StakeTooHigh {
            provided: r_stake,
            maximum: MAX_INVITATION_STAKE,
        });
    }

    // Validate inviter has enough R to cover the stake
    let r_available = inviter_r.balance - compute_locked_r(existing_invitations);
    if r_available < r_stake {
        return Err(InvitationError::InsufficientAvailableR {
            available: r_available,
            staking: r_stake,
        });
    }

    // Validate no self-invitation
    let inviter_pk = inviter_sk.public_key();
    if inviter_pk == *invitee {
        return Err(InvitationError::SelfInvitation);
    }

    // Validate not already invited by this inviter
    if existing_invitations.iter().any(|inv| inv.invitee == *invitee) {
        return Err(InvitationError::AlreadyInvited {
            invitee: invitee.clone(),
        });
    }

    // Check capacity for this epoch
    let used_this_epoch = existing_invitations
        .iter()
        .filter(|inv| inv.created_at_epoch == current_epoch)
        .count() as u64;
    let max_capacity = compute_invitation_capacity(inviter_r.balance);
    if used_this_epoch >= max_capacity {
        return Err(InvitationError::CapacityExhausted {
            used: used_this_epoch,
            max: max_capacity,
            epoch: current_epoch,
        });
    }

    // Create and sign the invitation
    let invitation = Invitation {
        inviter: inviter_pk,
        invitee: invitee.clone(),
        r_staked: r_stake,
        created_at_epoch: current_epoch,
        signature: inviter_sk.sign(&invitation_signable_bytes(
            &inviter_pk, invitee, r_stake, current_epoch,
        )),
    };

    Ok(invitation)
}

/// Compute the signable bytes for an invitation.
fn invitation_signable_bytes(
    inviter: &PublicKey,
    invitee: &PublicKey,
    r_staked: u64,
    epoch: u64,
) -> Vec<u8> {
    bincode::serialize(&(inviter, invitee, r_staked, epoch)).unwrap()
}
```

### Validating an Invitation

```rust
/// Validate an invitation's cryptographic integrity and business rules.
pub fn validate_invitation(
    invitation: &Invitation,
    inviter_r_at_creation: u64,
) -> Result<(), InvitationError> {
    // 1. Verify signature
    let signable = invitation_signable_bytes(
        &invitation.inviter,
        &invitation.invitee,
        invitation.r_staked,
        invitation.created_at_epoch,
    );
    if !invitation.inviter.verify(&invitation.signature, &signable) {
        return Err(InvitationError::InvalidSignature);
    }

    // 2. Verify inviter had sufficient R at creation time
    if inviter_r_at_creation < INVITATION_R_THRESHOLD {
        return Err(InvitationError::InsufficientR {
            have: inviter_r_at_creation,
            need: INVITATION_R_THRESHOLD,
        });
    }

    // 3. Verify stake bounds
    if invitation.r_staked < MIN_INVITATION_STAKE || invitation.r_staked > MAX_INVITATION_STAKE {
        return Err(InvitationError::InvalidStakeAmount {
            amount: invitation.r_staked,
        });
    }

    // 4. Verify no self-invitation
    if invitation.inviter == invitation.invitee {
        return Err(InvitationError::SelfInvitation);
    }

    Ok(())
}
```

### Storing an Invitation as a GraphEntry

```rust
/// Convert an Invitation into a GraphEntryData for storage on Autonomi.
pub fn invitation_to_graph_entry(
    invitation: &Invitation,
    inviter_sk: &SecretKey,
) -> GraphEntryData {
    let metadata = encode_invitation_metadata(
        invitation.r_staked,
        invitation.created_at_epoch,
    );
    let invitee_hash = hash_blake3(&bincode::serialize(&invitation.invitee).unwrap());

    GraphEntryData {
        owner: inviter_sk.derive_child(b"invitation").public_key(),
        parents: vec![invitation.inviter.clone()],
        content: invitee_hash,
        descendants: vec![(invitation.invitee.clone(), metadata)],
        signature: inviter_sk.sign(&invitation_signable_bytes(
            &invitation.inviter,
            &invitation.invitee,
            invitation.r_staked,
            invitation.created_at_epoch,
        )),
    }
}

/// Reconstruct an Invitation from a GraphEntryData.
pub fn graph_entry_to_invitation(
    entry: &GraphEntryData,
) -> Result<Invitation, InvitationError> {
    if entry.parents.is_empty() {
        return Err(InvitationError::MalformedGraphEntry);
    }
    if entry.descendants.is_empty() {
        return Err(InvitationError::MalformedGraphEntry);
    }

    let inviter = entry.parents[0].clone();
    let (invitee, metadata) = &entry.descendants[0];
    let (r_staked, epoch) = decode_invitation_metadata(metadata);

    Ok(Invitation {
        inviter,
        invitee: invitee.clone(),
        r_staked,
        created_at_epoch: epoch,
        signature: entry.signature.clone(),
    })
}
```

## Invitation Staking (`stake.rs`)

### Stake Resolution

```rust
/// Evaluate the outcome of an invitation stake.
/// Called after INVITATION_EVALUATION_PERIOD epochs have passed.
pub fn resolve_invitation_stake(
    invitation: &Invitation,
    invitee_current_r: u64,
    invitee_flagged_as_spam: bool,
    current_epoch: u64,
) -> Result<InvitationStakeOutcome, InvitationError> {
    // Must be past evaluation period
    if current_epoch < invitation.created_at_epoch + INVITATION_EVALUATION_PERIOD {
        return Err(InvitationError::EvaluationPeriodNotOver {
            created: invitation.created_at_epoch,
            current: current_epoch,
            need: invitation.created_at_epoch + INVITATION_EVALUATION_PERIOD,
        });
    }

    if invitee_flagged_as_spam {
        // FAILURE: invitee was flagged as spam — inviter loses staked R
        Ok(InvitationStakeOutcome::InviteeSpam {
            r_slashed: invitation.r_staked,
        })
    } else if invitee_current_r >= INVITEE_SUCCESS_R_THRESHOLD {
        // SUCCESS: invitee has earned meaningful R independently
        Ok(InvitationStakeOutcome::InviteeSucceeded {
            r_returned: invitation.r_staked,
            r_bonus: compute_invitation_r_bonus(invitation, invitee_current_r),
        })
    } else {
        // NEUTRAL: invitee exists but hasn't earned enough R yet.
        // Stake remains locked; re-evaluate next epoch.
        Ok(InvitationStakeOutcome::Pending {
            invitee_r: invitee_current_r,
        })
    }
}

pub enum InvitationStakeOutcome {
    /// Invitee was flagged as spam. Inviter's staked R is destroyed.
    InviteeSpam {
        r_slashed: u64,
    },

    /// Invitee earned R independently. Inviter gets stake back + bonus.
    InviteeSucceeded {
        r_returned: u64,
        r_bonus: u64,
    },

    /// Not yet resolved. Invitee hasn't reached threshold and isn't flagged.
    Pending {
        invitee_r: u64,
    },
}
```

### R Bonus for Successful Invitation

```rust
/// Compute the R bonus an inviter earns when their invitee succeeds.
/// Proportional to the invitee's earned R, capped to prevent gaming.
fn compute_invitation_r_bonus(
    invitation: &Invitation,
    invitee_r: u64,
) -> u64 {
    // Bonus = sqrt(invitee_R) * (staked_R / MAX_INVITATION_STAKE)
    // This rewards higher stakes and more successful invitees,
    // but with diminishing returns.
    let invitee_factor = (invitee_r as f64).sqrt();
    let stake_factor = invitation.r_staked as f64 / MAX_INVITATION_STAKE as f64;
    (invitee_factor * stake_factor) as u64
}
```

### Computing Locked R

```rust
/// Compute total R currently locked in active (unresolved) invitation stakes.
pub fn compute_locked_r(invitations: &[Invitation]) -> u64 {
    invitations.iter().map(|inv| inv.r_staked).sum()
}
```

## Rate Limiting (`capacity.rs`)

### Invitation Capacity Per Epoch

```rust
/// Compute how many invitations a user can issue per epoch,
/// based on their current R balance.
///
/// Formula: floor(log2(R / INVITATION_R_THRESHOLD)) + BASE_INVITATIONS_PER_EPOCH
/// Capped at MAX_INVITATIONS_PER_EPOCH.
///
/// | R Balance | Invitations/Epoch |
/// |-----------|-------------------|
/// | < 50      | 0 (ineligible)    |
/// | 50-99     | 1                 |
/// | 100-199   | 2                 |
/// | 200-399   | 3                 |
/// | 400-799   | 4                 |
/// | 800-1000  | 5 (max)           |
pub fn compute_invitation_capacity(r_balance: u64) -> u64 {
    if r_balance < INVITATION_R_THRESHOLD {
        return 0;
    }

    let ratio = r_balance / INVITATION_R_THRESHOLD;
    let log2_ratio = (ratio as f64).log2().floor() as u64;
    let capacity = BASE_INVITATIONS_PER_EPOCH + log2_ratio;

    capacity.min(MAX_INVITATIONS_PER_EPOCH)
}

/// Check whether a user can issue another invitation this epoch.
pub fn can_invite(
    r_balance: u64,
    invitations_this_epoch: u64,
    r_locked_in_stakes: u64,
) -> Result<(), InvitationError> {
    let capacity = compute_invitation_capacity(r_balance);
    if capacity == 0 {
        return Err(InvitationError::InsufficientR {
            have: r_balance,
            need: INVITATION_R_THRESHOLD,
        });
    }

    if invitations_this_epoch >= capacity {
        return Err(InvitationError::CapacityExhausted {
            used: invitations_this_epoch,
            max: capacity,
            epoch: 0, // Caller fills in
        });
    }

    let available_r = r_balance.saturating_sub(r_locked_in_stakes);
    if available_r < MIN_INVITATION_STAKE {
        return Err(InvitationError::InsufficientAvailableR {
            available: available_r,
            staking: MIN_INVITATION_STAKE,
        });
    }

    Ok(())
}
```

### Rate Limit Per Epoch (Summary Table)

| Inviter R | Capacity/Epoch | Max R Stakeable/Epoch | Notes |
|---|---|---|---|
| 0-49 | 0 | 0 | Cannot invite |
| 50-99 | 1 | 100 | Must carefully choose |
| 100-199 | 2 | 200 | Moderate influence |
| 200-399 | 3 | 300 | Established user |
| 400-799 | 4 | 400 | High-reputation user |
| 800-1000 | 5 | 500 | Maximum capacity (R cap = 1000) |

## Invitation Flow (Step by Step)

### Step 1: Inviter Checks Eligibility

```
1. Inviter reads own R balance from Scratchpad
2. Verify R >= INVITATION_R_THRESHOLD (50)
3. Count invitations already issued this epoch
4. Verify count < compute_invitation_capacity(R)
5. Compute available R = R - locked R in active stakes
6. Verify available R >= MIN_INVITATION_STAKE
```

### Step 2: Inviter Creates Invitation

```
1. Inviter creates Invitation struct (invitee pk, stake amount, epoch)
2. Inviter signs the invitation with their secret key
3. Invitation is converted to GraphEntryData
4. GraphEntry is stored on Autonomi via GraphStore::put()
5. Inviter updates their R balance Scratchpad to reflect locked R
```

### Step 3: Invitee Becomes Discoverable

```
1. Invitee creates an account (profile Scratchpad, feed index, etc.)
2. Indexers crawl GraphEntries and discover the invitation edge
3. Indexers verify the invitation signature and inviter's R at creation time
4. If valid, indexers treat the invitee as "invited" — full weight in rankings
5. Invitee can now post, curate, and earn R at the standard rate
```

### Step 4: Evaluation After INVITATION_EVALUATION_PERIOD

```
1. After 10 epochs, the invitation stake becomes resolvable
2. If invitee's R >= INVITEE_SUCCESS_R_THRESHOLD:
   → Inviter gets staked R back + bonus R
   → Inviter may earn second-degree diversity bonus (see Anti-Cartel)
3. If invitee is flagged as spam by moderation system:
   → Inviter loses staked R (slashed via SlashableOffense::InviteeSpam)
   → Inviter's overall R is penalized
4. If neither:
   → Stake remains locked; re-evaluated next epoch
```

### Step 5: Second-Degree Evaluation

```
1. When an invitee (B) themselves invites someone (C), and C succeeds:
   → B earns the standard invitation bonus
   → A (who invited B) earns a second-degree diversity bonus
2. This incentivizes inviting people who will themselves be good judges
3. The bonus decays with depth: only 1st and 2nd degree earn bonuses
```

## Graph Traversal for Trust Verification (`graph.rs`)

### Finding a Trust Path

```rust
/// Find the shortest trust path from any genesis/high-R user to the target.
/// Uses breadth-first search over the invitation graph.
///
/// Returns None if no trust path exists (uninvited user).
pub async fn find_trust_path(
    storage: &dyn Storage,
    target: &PublicKey,
    max_depth: u64,
) -> Result<Option<TrustPath>, InvitationError> {
    // BFS from target upward through invitation graph
    let mut queue: VecDeque<(PublicKey, Vec<TrustHop>)> = VecDeque::new();
    let mut visited: HashSet<PublicKey> = HashSet::new();

    queue.push_back((target.clone(), vec![]));
    visited.insert(target.clone());

    while let Some((current, path)) = queue.pop_front() {
        if path.len() as u64 >= max_depth {
            continue;
        }

        // Find all invitations where `current` is the invitee
        let invitations = get_invitations_for_invitee(storage, &current).await?;

        for invitation in invitations {
            if visited.contains(&invitation.inviter) {
                continue;
            }

            let mut new_path = path.clone();
            new_path.push(TrustHop {
                inviter: invitation.inviter.clone(),
                invitee: invitation.invitee.clone(),
                r_staked: invitation.r_staked,
                epoch: invitation.created_at_epoch,
            });

            // Check if inviter is a genesis/high-R user (trust root)
            let inviter_r = get_user_r(storage, &invitation.inviter).await?;
            if inviter_r >= INVITATION_R_THRESHOLD * 2 {
                // Found a trust root — reverse path for root-to-target ordering
                new_path.reverse();
                let min_stake = new_path.iter().map(|h| h.r_staked).min().unwrap_or(0);
                return Ok(Some(TrustPath {
                    depth: new_path.len() as u64,
                    min_stake,
                    hops: new_path,
                }));
            }

            visited.insert(invitation.inviter.clone());
            queue.push_back((invitation.inviter.clone(), new_path));
        }
    }

    Ok(None)
}
```

### Computing Trust Score

```rust
/// Compute a trust score for a user based on their position in the invitation graph.
/// Higher score = more trusted.
///
/// Components:
/// - Invitation depth (shorter path = more trust)
/// - Minimum stake along path (higher = more trust)
/// - Inviter's current R (higher = more trust)
/// - Number of independent paths (more = more trust)
pub async fn compute_trust_score(
    storage: &dyn Storage,
    user: &PublicKey,
) -> Result<TrustScore, InvitationError> {
    let path = find_trust_path(storage, user, MAX_TRUST_PATH_DEPTH).await?;

    match path {
        Some(trust_path) => {
            let depth_factor = 1.0 / (1.0 + trust_path.depth as f64);
            let stake_factor = (trust_path.min_stake as f64).sqrt();
            let score = depth_factor * stake_factor * 100.0;

            Ok(TrustScore {
                score: score as u64,
                invited: true,
                path: Some(trust_path),
            })
        }
        None => {
            // Uninvited user — minimal trust score
            Ok(TrustScore {
                score: 0,
                invited: false,
                path: None,
            })
        }
    }
}

#[derive(Clone, Debug)]
pub struct TrustScore {
    /// Numeric trust score (0 = uninvited, higher = more trusted).
    pub score: u64,
    /// Whether the user was invited at all.
    pub invited: bool,
    /// The trust path, if one exists.
    pub path: Option<TrustPath>,
}
```

### Querying the Invitation Graph

```rust
/// Get all invitations issued by a given inviter.
pub async fn get_invitations_by_inviter(
    storage: &dyn Storage,
    inviter: &PublicKey,
) -> Result<Vec<Invitation>, InvitationError>;

/// Get all invitations received by a given invitee.
pub async fn get_invitations_for_invitee(
    storage: &dyn Storage,
    invitee: &PublicKey,
) -> Result<Vec<Invitation>, InvitationError>;

/// Get the full invitation subtree rooted at a given user (all downstream invitees).
/// Used for cartel detection and diversity bonus computation.
pub async fn get_invitation_subtree(
    storage: &dyn Storage,
    root: &PublicKey,
    max_depth: u64,
) -> Result<InvitationSubtree, InvitationError>;

#[derive(Clone, Debug)]
pub struct InvitationSubtree {
    pub root: PublicKey,
    /// All nodes in the subtree with their depth.
    pub nodes: Vec<(PublicKey, u64)>,
    /// All edges (inviter → invitee) in the subtree.
    pub edges: Vec<(PublicKey, PublicKey, u64)>,  // (inviter, invitee, r_staked)
    /// Total users in subtree.
    pub size: u64,
}
```

## Anti-Cartel Implementation (`anticartel.rs`)

### R Cap Enforcement

The R cap (max 1000 R per user, defined in dsn-token-r) is the first line of defense. Even the most prolific inviter cannot accumulate unbounded influence.

```rust
/// Verify that a user's R does not exceed R_CAP after invitation bonuses.
/// This is enforced at the R computation level (dsn-token-r),
/// but checked here for defense in depth.
pub fn enforce_r_cap_on_invitation_bonus(
    current_r: u64,
    invitation_bonus: u64,
) -> u64 {
    let new_r = current_r.saturating_add(invitation_bonus);
    new_r.min(R_CAP)
}
```

### Invitation Diversity Bonus

Inviters earn bonus R when their invitees' invitees succeed (second-degree success). This rewards building a diverse, healthy invitation tree rather than a narrow, controlled one.

```rust
/// Compute the second-degree diversity bonus for an inviter.
///
/// For each invitee B that the inviter A invited:
///   For each invitee C that B invited (where C succeeded):
///     A earns: sqrt(C's R) * SECOND_DEGREE_BONUS_MULTIPLIER
///
/// The bonus is only awarded if B and C curate DIFFERENT content
/// (prevents cartels from just re-curating each other's posts).
pub async fn compute_diversity_bonus(
    storage: &dyn Storage,
    inviter: &PublicKey,
    current_epoch: u64,
) -> Result<u64, InvitationError> {
    let direct_invitees = get_invitations_by_inviter(storage, inviter).await?;
    let mut total_bonus: f64 = 0.0;

    for direct in &direct_invitees {
        // Get invitees of our invitee (second degree)
        let second_degree = get_invitations_by_inviter(storage, &direct.invitee).await?;

        for second in &second_degree {
            let second_r = get_user_r(storage, &second.invitee).await?;

            if second_r < INVITEE_SUCCESS_R_THRESHOLD {
                continue; // Not yet successful
            }

            // Check curation diversity: second-degree invitee must curate
            // different content than the first-degree invitee
            let diversity = compute_curation_overlap(
                storage,
                &direct.invitee,
                &second.invitee,
                current_epoch,
            ).await?;

            if diversity > 0.5 {
                // More than 50% overlap in curated content — likely coordinated
                continue; // No bonus
            }

            total_bonus += (second_r as f64).sqrt() * SECOND_DEGREE_BONUS_MULTIPLIER;
        }
    }

    Ok(total_bonus as u64)
}

/// Compute the fraction of overlap between two users' curated posts.
/// Returns 0.0 (no overlap) to 1.0 (identical curation sets).
async fn compute_curation_overlap(
    storage: &dyn Storage,
    user_a: &PublicKey,
    user_b: &PublicKey,
    epoch: u64,
) -> Result<f64, InvitationError>;
```

### Cartel Pattern Detection

```rust
/// Analyze an invitation subtree for cartel-like patterns.
/// Returns a list of detected anomalies.
///
/// Cartel indicators:
/// 1. Dense interconnection: high ratio of edges to nodes
/// 2. Reciprocal invitations: A invites B, B invites C, C invites A
/// 3. Synchronized timing: many invitations in the same epoch
/// 4. Curation overlap: members curate the same content
/// 5. Narrow tree: low branching factor (one inviter dominates)
pub async fn detect_cartel_patterns(
    storage: &dyn Storage,
    subtree: &InvitationSubtree,
    current_epoch: u64,
) -> Result<CartelAnalysis, InvitationError> {
    let mut indicators: Vec<CartelIndicator> = Vec::new();

    // 1. Dense interconnection
    let density = subtree.edges.len() as f64 / subtree.nodes.len().max(1) as f64;
    if density > 3.0 {
        indicators.push(CartelIndicator::HighDensity { density });
    }

    // 2. Reciprocal invitations (cycles in graph)
    let cycles = detect_invitation_cycles(subtree);
    if !cycles.is_empty() {
        indicators.push(CartelIndicator::ReciprocalInvitations {
            cycle_count: cycles.len() as u64,
        });
    }

    // 3. Synchronized timing
    let epoch_counts = count_invitations_per_epoch(subtree);
    for (epoch, count) in &epoch_counts {
        if *count > subtree.size / 2 && *count > 3 {
            indicators.push(CartelIndicator::SynchronizedTiming {
                epoch: *epoch,
                count: *count,
            });
        }
    }

    // 4. Curation overlap among members
    let avg_overlap = compute_average_curation_overlap(
        storage, subtree, current_epoch
    ).await?;
    if avg_overlap > 0.7 {
        indicators.push(CartelIndicator::HighCurationOverlap {
            overlap: avg_overlap,
        });
    }

    // 5. Narrow tree (low branching factor)
    let avg_branching = subtree.edges.len() as f64 / subtree.nodes.len().max(1) as f64;
    if avg_branching < 1.2 && subtree.size > 5 {
        indicators.push(CartelIndicator::NarrowTree {
            branching_factor: avg_branching,
        });
    }

    let suspicion_score = indicators.len() as f64 / 5.0; // 0.0 to 1.0

    Ok(CartelAnalysis {
        subtree_root: subtree.root.clone(),
        subtree_size: subtree.size,
        indicators,
        suspicion_score,
    })
}

#[derive(Clone, Debug)]
pub struct CartelAnalysis {
    pub subtree_root: PublicKey,
    pub subtree_size: u64,
    pub indicators: Vec<CartelIndicator>,
    /// 0.0 = no suspicion, 1.0 = strong cartel signal.
    pub suspicion_score: f64,
}

#[derive(Clone, Debug)]
pub enum CartelIndicator {
    /// Edges-to-nodes ratio exceeds threshold.
    HighDensity { density: f64 },

    /// Invitation cycles detected (A→B→C→A).
    ReciprocalInvitations { cycle_count: u64 },

    /// Many invitations in a single epoch.
    SynchronizedTiming { epoch: u64, count: u64 },

    /// Members curate heavily overlapping content.
    HighCurationOverlap { overlap: f64 },

    /// Low branching factor (linear chain).
    NarrowTree { branching_factor: f64 },
}

/// Detect cycles in the invitation graph.
fn detect_invitation_cycles(subtree: &InvitationSubtree) -> Vec<Vec<PublicKey>>;

/// Count invitations per epoch in a subtree.
fn count_invitations_per_epoch(subtree: &InvitationSubtree) -> HashMap<u64, u64>;

/// Compute average pairwise curation overlap among subtree members.
async fn compute_average_curation_overlap(
    storage: &dyn Storage,
    subtree: &InvitationSubtree,
    current_epoch: u64,
) -> Result<f64, InvitationError>;
```

### Discovery Bonus Integration

The discovery bonus (defined in dsn-token-r) interacts with invitations. Curators earn bonus R for being the first to curate content from low-R users. This incentivizes high-R users to actively seek out and support new, uninvited users — providing a natural counterbalance to closed invitation cliques.

```rust
/// Check whether an invitation bonus should be reduced due to cartel suspicion.
/// Indexers and watchers call this when computing R adjustments.
pub fn apply_cartel_penalty(
    invitation_bonus: u64,
    cartel_analysis: &CartelAnalysis,
) -> u64 {
    if cartel_analysis.suspicion_score < 0.4 {
        invitation_bonus // No penalty
    } else if cartel_analysis.suspicion_score < 0.7 {
        invitation_bonus / 2 // 50% penalty
    } else {
        0 // Full penalty — suspected cartel gets no bonus
    }
}
```

### Invitation Graph Transparency

All invitation GraphEntries are public and immutable on Autonomi. Anyone can:

1. Crawl the full invitation graph
2. Run cartel detection algorithms
3. Publish analysis results (as Chunks)
4. Flag suspicious patterns to the moderation system

This transparency is the ultimate anti-cartel measure: cartels cannot hide their structure because the invitation graph is fully auditable.

## Open Entry Fallback (`uninvited.rs`)

Uninvited accounts can still participate, but at reduced effectiveness. This prevents the invitation system from becoming a gatekeeping tool.

```rust
/// Compute the effective weight of an uninvited user for indexer ranking.
/// Uninvited users' R is multiplied by UNINVITED_WEIGHT_MULTIPLIER (0.1).
pub fn uninvited_effective_r(actual_r: u64) -> u64 {
    (actual_r as f64 * UNINVITED_WEIGHT_MULTIPLIER) as u64
}

/// Compute the R earning rate for an uninvited user.
/// Uninvited users earn R at UNINVITED_EARNING_MULTIPLIER (0.2) of the standard rate.
pub fn uninvited_r_earning(standard_earning: u64) -> u64 {
    (standard_earning as f64 * UNINVITED_EARNING_MULTIPLIER) as u64
}

/// Check whether a user is invited (has at least one valid invitation in the graph).
pub async fn is_invited(
    storage: &dyn Storage,
    user: &PublicKey,
) -> Result<bool, InvitationError> {
    let invitations = get_invitations_for_invitee(storage, user).await?;
    // At least one valid, non-slashed invitation
    Ok(invitations.iter().any(|inv| {
        validate_invitation(inv, INVITATION_R_THRESHOLD).is_ok()
    }))
}

/// Compute the R earning multiplier for a user based on invitation status.
/// Returns 1.0 for invited users, UNINVITED_EARNING_MULTIPLIER for uninvited.
pub async fn earning_multiplier(
    storage: &dyn Storage,
    user: &PublicKey,
) -> Result<f64, InvitationError> {
    if is_invited(storage, user).await? {
        Ok(1.0)
    } else {
        Ok(UNINVITED_EARNING_MULTIPLIER)
    }
}
```

### Path from Uninvited to Invited

An uninvited user can transition to invited status at any time:

1. **Organic discovery**: A high-R user discovers the uninvited user's content through the discovery bonus mechanic, decides to invite them
2. **Reputation threshold**: Once an uninvited user's R exceeds `INVITEE_SUCCESS_R_THRESHOLD` (even at the slow earning rate), they become more attractive invitation targets
3. **Community bootstrapping**: During early network growth, the first users have no inviters — they earn R slowly and then begin inviting others

### Uninvited User Timeline

| Epoch | Action | R Balance | Effective R |
|---|---|---|---|
| 0 | Account created (no invitation) | 0 | 0 |
| 1-5 | Posting content, curating (at 0.2x rate) | ~4 | ~0.4 |
| 6-10 | Continued participation | ~15 | ~1.5 |
| 11 | Discovered and invited by high-R user | 18 | 18 (full weight) |
| 12+ | Standard participation rate | Growing | Full |

## Full R Computation Integration

The invitation system integrates with the R computation pipeline (dsn-token-r `compute_r_from_scratch`). The following adjustments apply:

```rust
/// Adjustments to R computation for invitation-related factors.
/// Called within the per-epoch R computation loop.
pub fn invitation_r_adjustments(
    user: &PublicKey,
    base_r_earned: u64,
    is_invited: bool,
    invitation_bonuses: u64,
    cartel_penalty: u64,
) -> u64 {
    let mut adjusted = base_r_earned;

    // Apply uninvited penalty if applicable
    if !is_invited {
        adjusted = uninvited_r_earning(adjusted);
    }

    // Add invitation bonuses (for inviter when invitees succeed)
    adjusted = adjusted.saturating_add(invitation_bonuses);

    // Subtract cartel penalties
    adjusted = adjusted.saturating_sub(cartel_penalty);

    // Enforce R cap
    adjusted.min(R_CAP)
}
```

## Error Types (`error.rs`)

```rust
#[derive(Debug, thiserror::Error)]
pub enum InvitationError {
    #[error("insufficient R to invite: have {have}, need {need}")]
    InsufficientR { have: u64, need: u64 },

    #[error("insufficient available R: available {available}, staking {staking}")]
    InsufficientAvailableR { available: u64, staking: u64 },

    #[error("stake too low: provided {provided}, minimum {minimum}")]
    StakeTooLow { provided: u64, minimum: u64 },

    #[error("stake too high: provided {provided}, maximum {maximum}")]
    StakeTooHigh { provided: u64, maximum: u64 },

    #[error("invalid stake amount: {amount}")]
    InvalidStakeAmount { amount: u64 },

    #[error("cannot invite yourself")]
    SelfInvitation,

    #[error("user {invitee:?} already invited by this inviter")]
    AlreadyInvited { invitee: PublicKey },

    #[error("invitation capacity exhausted: used {used}/{max} in epoch {epoch}")]
    CapacityExhausted { used: u64, max: u64, epoch: u64 },

    #[error("evaluation period not over: created {created}, current {current}, need {need}")]
    EvaluationPeriodNotOver { created: u64, current: u64, need: u64 },

    #[error("invalid invitation signature")]
    InvalidSignature,

    #[error("malformed graph entry: missing required fields")]
    MalformedGraphEntry,

    #[error("trust path too deep: depth {depth}, max {max}")]
    TrustPathTooDeep { depth: u64, max: u64 },

    #[error("invitation graph cycle detected")]
    CycleDetected,

    #[error("data error: {0}")]
    Data(#[from] DataError),
}
```

## Anti-Gaming Analysis

### Sybil Attack via Invitation Chains

**Attack**: Attacker with R = 200 creates a chain: A invites B, B invites C, C invites D...

**Defense**:
- Each invitation costs MIN_INVITATION_STAKE (10 R), locked for INVITATION_EVALUATION_PERIOD (10 epochs)
- Attacker with R = 200 can invite at most 2 users/epoch (capacity formula)
- Each invitee must independently earn R >= 20 to release the stake
- If invitees are bots that don't earn real R, the stake stays locked forever
- Attacker hemorrhages R through decay (10%/epoch) while R is locked

**Cost**: Creating 10 Sybils costs 100 R locked for 10+ epochs. During that time, decay consumes 10 R/epoch from the remaining balance. The attacker runs out of R within ~10 epochs.

### Cartel Invitation Rings

**Attack**: Group of users A, B, C form a ring where each invites the others' alt accounts.

**Defense**:
- `detect_invitation_cycles()` identifies rings in the graph
- Curation overlap check (`compute_curation_overlap`) catches members curating the same content
- Second-degree diversity bonus requires invitees to curate DIFFERENT content
- Cartel penalty reduces or eliminates invitation bonuses for suspicious subtrees
- Full graph transparency means anyone can detect and publicize cartel patterns

### Invitation Selling

**Attack**: High-R user sells invitations for real money.

**Defense**:
- Inviter stakes R on invitee — if the buyer is spam, the seller loses R
- The economic incentive is to invite quality users, not sell to the highest bidder
- R cap (1000) limits how much R any inviter can risk
- Reputation damage from inviting spammers compounds: each slashed invitation reduces future capacity

### Ghost Invitees

**Attack**: Invite accounts that never participate, to appear well-connected.

**Defense**:
- Staked R remains locked until invitee reaches INVITEE_SUCCESS_R_THRESHOLD
- R decay erodes the inviter's balance while stakes are locked
- No R bonus unless invitees actually succeed
- Inviting ghosts is purely costly to the inviter
