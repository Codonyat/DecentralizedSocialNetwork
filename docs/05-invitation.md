# Invitation Tree & Trust Distance (`dsn-invitation`)

## Purpose

The invitation system provides Sybil resistance via an on-chain invitation tree. Each invitation burns Y (flat cost), creating an auditable tree structure. Trust distance (graph distance between accounts) is used to weight donations for emission calculation.

## Module Structure

```
crates/invitation/src/
  lib.rs
  invite.rs            # Invitation logic
  trust_distance.rs    # Trust distance + graph distance computation
  donation_weight.rs   # Trust-distance-based donation weighting
  error.rs
```

## Dependencies

```
dsn-invitation depends on:
  - dsn-core    (PublicKey, ContentAddress, etc.)
  - dsn-chain   (ChainClient trait for on-chain operations)
```

## Core Concepts

### Invitation Tree

- Invitations are ON-CHAIN smart contract calls
- Each invitation burns Y (flat cost, defined in EpochConfig::invitation_cost_y)
- Tree structure: each account has exactly one inviter (except genesis accounts)
- Genesis accounts seeded by contract deployer at distance 0

### Two Distinct Distance Concepts

1. **Depth** = hops from genesis (each account has exactly one). Property of the tree, not used directly for weighting.
2. **Graph distance** = shortest path between two accounts in the invitation tree. This is what weights donations. Sock puppets created by the same inviter have graph distance 2 from each other (very close), making cross-puppet donations low-weight.

### Trust Distance

- `trust_distance(account) = inviter's trust_distance + 1`
- Genesis accounts have trust_distance = 0

## Types

```rust
/// An on-chain invitation record.
pub struct OnChainInvitation {
    pub inviter: PublicKey,
    pub invitee: PublicKey,
    pub y_cost: u64,
    pub trust_distance: u32,  // invitee's trust distance (inviter's + 1)
}
```

## Invitation Creation (invite.rs)

```rust
/// Validate an invitation before submitting on-chain.
/// Preconditions:
/// - Inviter must be an existing on-chain account
/// - Invitee must NOT already exist in the invitation tree
/// - Inviter must have sufficient Y balance >= invitation_cost_y
/// - Cannot self-invite
pub fn validate_invitation(
    inviter: &PublicKey,
    invitee: &PublicKey,
    inviter_balance: u64,
    invitation_cost: u64,
    invitee_exists: bool,
) -> Result<(), InvitationError>;
```

### Anti-Sybil Economics

- Creating sock puppets costs Y per invite
- Sock puppets are CLOSE in trust tree (low donation weight when self-donating)
- Y cost is the natural limiter (optionally also per-epoch cap in contract)

## Trust Distance Computation (trust_distance.rs)

```rust
/// Compute the trust distance (depth) of an account from genesis.
/// Returns None if the account is not in the invitation tree.
pub fn trust_distance(
    invitee: &PublicKey,
    invitation_tree: &HashMap<PublicKey, PublicKey>, // invitee -> inviter
) -> Option<u32>;

/// Compute the graph distance between two accounts in the invitation tree.
/// This is the shortest path through the tree (going up to common ancestor, then down).
pub fn graph_distance(
    account_a: &PublicKey,
    account_b: &PublicKey,
    invitation_tree: &HashMap<PublicKey, PublicKey>,
) -> Option<u32>;
```

## Donation Weighting (donation_weight.rs)

```rust
/// Weight a donation based on the graph distance between donor and creator.
/// Greater distance = more weight (harder to fake with sock puppets).
///
/// | Graph Distance | Weight |
/// |----------------|--------|
/// | 0 (self)       | 0.0    |
/// | 1              | 0.5    |
/// | 2              | 0.75   |
/// | 3+             | 1.0    |
pub fn donation_weight_from_distance(graph_distance: u32) -> f64;
```

### Why This Works Against Sock Puppets

- Attacker creates accounts A and B via the same inviter
- A and B have graph distance 2 (A->inviter->B)
- Donations from A to B get weight 0.75 (reduced)
- Attacker creates A, then A invites B
- A and B have graph distance 1
- Donations from A to B get weight 0.5 (heavily reduced)
- Self-donations (distance 0) get weight 0.0

## Constants

```rust
/// Default invitation cost in Y (can be overridden in EpochConfig).
pub const DEFAULT_INVITATION_COST_Y: u64 = 100_000_000; // 100 Y

/// Maximum depth for graph distance computation.
pub const MAX_GRAPH_DISTANCE_DEPTH: u32 = 100;
```

## Error Types

```rust
#[derive(Debug, thiserror::Error)]
pub enum InvitationError {
    #[error("insufficient Y to invite: have {have}, need {need}")]
    InsufficientY { have: u64, need: u64 },

    #[error("cannot invite yourself")]
    SelfInvitation,

    #[error("invitee already exists in the invitation tree")]
    AlreadyInvited,

    #[error("inviter not found in invitation tree")]
    InviterNotFound,

    #[error("chain error: {0}")]
    Chain(String),
}
```

## Anti-Gaming Analysis

### Sybil via Invitation Chains

**Attack**: Attacker creates a chain of puppet accounts.
**Defense**: Each invitation costs Y (burned). Creating 10 puppets costs 10 x invitation_cost Y. And all puppets are close in the tree, making cross-puppet donations low-weight.

### Self-Donation Rings

**Attack**: A invites B, B donates to A's posts.
**Defense**: Graph distance A<->B = 1, donation weight = 0.5. The donation costs Y (5% burned), so it's a net loss for the attacker.
