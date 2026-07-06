# Invitation Registry & Referral Annuity (`dsn-invitation`)

## Purpose

The invitation system is the network's **membership registry and growth
engine**. Each invitation is an on-chain record (invitee → inviter) created by
paying a flat Y fee. The registry serves three roles:

1. **Membership & discovery** — every legitimate account enters through an
   invitation (or genesis). Indexers bootstrap user discovery from these
   events (doc 07).
2. **Accountability data** — the tree records who vouched for whom. Clients
   and indexers may use it for *informational* purposes (display, trust-
   informed filtering, spam heuristics). It is **never consulted by any
   monetary contract** — see "What the tree is NOT" below.
3. **Referral annuity** — the inviter earns 10% of the protocol fees their
   direct invitees burn for ~4 years (doc 10 §3.3). This is the early-adopter
   reward mechanism: it pays for recruiting people who *actually use* the
   network.

## What the tree is NOT (design history)

An earlier revision weighted donations by graph distance in this tree for
Sybil resistance and emission calculation. That design was removed (doc 09
§2.1–2.2): tree distance measures topology, not identity — invite markets
place an attacker's purchased accounts far apart (full weight) while genuine
friends sit close together (penalized), inverting the intended incentive; and
per-donation shortest-path computation is impractical on-chain, which would
have smuggled a trusted weight-oracle into the money layer.

Consequences in the current design:

- No graph-distance weighting exists anywhere in the monetary layer.
- Sybil resistance is not this module's job. Accounts are cheap by design;
  what Sybils could once *earn* (emission) no longer exists (doc 10 §3.2.3),
  and pro-rata rebates are Sybil-invariant (doc 03 §E).
- Graph utilities remain available for **edge-layer** consumers only
  (indexer display, client-side trust heuristics).

## Module Structure

```
crates/invitation/src/
  lib.rs
  invite.rs            # Invitation validation logic
  referral.rs          # Referral annuity queries (term, cut, attribution)
  tree.rs              # Informational tree queries (chain, depth, subtree) — edge-layer only
  error.rs
```

## Dependencies

```
dsn-invitation depends on:
  - dsn-core     (PublicKey, ContentAddress, etc.)
  - dsn-chain    (ChainClient trait for on-chain operations)
  - dsn-token-y  (INVITATION_COST_Y, referral math)
```

## Core Concepts

### Invitation Registry

- Invitations are ON-CHAIN calls to the `InvitationRegistry` contract (doc 11 §1.1).
- Each invitation costs a flat fee (`INVITATION_COST_Y`, doc 03 §C), routed
  through the standard fee split: 10% to the *inviter's own* inviter if
  within term, remainder burned. The fee is rebate-eligible (doc 03 §E).
- Tree structure: each account has exactly one inviter (except genesis
  accounts, seeded at deployment by the steward role — doc 09 §3).
- The registry records `invited_at_epoch`, which anchors the referral term
  and the account-age criterion used by moderation eligibility (doc 06).

### Onboarding Convention

Clients SHOULD bundle "invite + starter tip" as one action (doc 10 §3.5):
the inviter pays the invite fee and gifts pocket Y, which is individually
rational — the inviter owns the referral annuity on this person's future
fees. This is how a new user first touches Y without an exchange.

## Types

```rust
/// An on-chain invitation record.
pub struct OnChainInvitation {
    pub inviter: PublicKey,
    pub invitee: PublicKey,
    pub y_fee: u64,
    pub invited_at_epoch: u64,
}
```

## Invitation Creation (`invite.rs`)

```rust
/// Validate an invitation before submitting on-chain.
/// Preconditions:
/// - Inviter must be an existing on-chain account (invited or genesis)
/// - Invitee must NOT already exist in the registry
/// - Inviter must have Y balance >= INVITATION_COST_Y
/// - Cannot self-invite
pub fn validate_invitation(
    inviter: &PublicKey,
    invitee: &PublicKey,
    inviter_balance: u64,
    invitation_cost: u64,
    invitee_exists: bool,
) -> Result<(), InvitationError>;
```

## Referral Annuity (`referral.rs`)

The fee-routing itself is enforced by the `ReferralRouter` contract at burn
time (doc 11 §1.1); this module provides the matching pure math and queries.

```rust
/// Re-exported constants (canonical values in dsn-token-y, doc 03 §C):
///   REFERRAL_SHARE_BPS = 1_000  (10%)
///   REFERRAL_TERM_EPOCHS = 208  (~4 years)

/// Whether fees paid by `invitee` currently route a cut to their inviter.
pub fn referral_active(invitation: &OnChainInvitation, current_epoch: u64) -> bool;

/// Total referral earnings of an inviter, computed from chain events.
/// (Convenience for clients/indexers; the chain is the source of truth.)
pub fn referral_earnings(
    inviter: &PublicKey,
    fee_events: &[FeeEvent], // (payer, fee, epoch) from the chain listener
    registry: &HashMap<PublicKey, OnChainInvitation>,
    current_epoch: u64,
) -> u64;
```

Properties (doc 10 §3.3): depth 1 only — an inviter earns from direct
invitees, never from invitees-of-invitees, so income cannot compound down the
tree (referral program, not MLM). Objective and oracle-free: eligibility is a
registry lookup plus epoch arithmetic.

## Informational Tree Queries (`tree.rs`) — edge-layer only

These functions support display ("your invitation chain"), analytics, and
optional client-side trust heuristics. **No monetary contract consumes their
output.**

```rust
/// Depth of an account from genesis (hops up the inviter chain).
pub fn invitation_depth(
    account: &PublicKey,
    registry: &HashMap<PublicKey, PublicKey>, // invitee -> inviter
) -> Option<u32>;

/// The inviter chain from an account up to its genesis root.
pub fn invitation_chain(
    account: &PublicKey,
    registry: &HashMap<PublicKey, PublicKey>,
) -> Vec<PublicKey>;

/// Direct invitees of an account.
pub fn direct_invitees(
    account: &PublicKey,
    registry: &HashMap<PublicKey, PublicKey>,
) -> Vec<PublicKey>;
```

## Constants

```rust
/// Canonical fee lives in dsn-token-y (doc 03 §C).
pub use dsn_token_y::INVITATION_COST_Y; // 100 Y

/// Safety bound for chain walks in tree.rs.
pub const MAX_CHAIN_DEPTH: u32 = 1_000;
```

## Error Types

```rust
#[derive(Debug, thiserror::Error)]
pub enum InvitationError {
    #[error("insufficient Y to invite: have {have}, need {need}")]
    InsufficientY { have: u64, need: u64 },

    #[error("cannot invite yourself")]
    SelfInvitation,

    #[error("invitee already exists in the invitation registry")]
    AlreadyInvited,

    #[error("inviter not found in invitation registry")]
    InviterNotFound,

    #[error("chain error: {0}")]
    Chain(String),
}
```

## Anti-Gaming Analysis

### Referral self-dealing

**Attack**: Invite your own Sybil account, then route your fee spending
through it to collect the 10% referral cut.
**Outcome**: You paid the invite fee, and the "cut" returns 10% of money that
was already 100% yours while 90% burns. Strictly lossy. (Doc 10 §3.3.)

### Invite-market Sybils

**Attack**: Buy invitations from strangers to mass-create accounts.
**Outcome**: Accounts are obtainable at the invite price — by design. There
is nothing account-multiplication can earn: rebates are pro-rata to fees
burned (account count is irrelevant, doc 03 §E), tips mint nothing, and
emission-by-social-metric no longer exists. The invite fee is a growth
throttle and fee sink, not a Sybil proof (doc 09 §2.2).

### MLM shaping

**Attack**: Build a deep recruiting tree expecting compounding income.
**Outcome**: Referral income is depth-1 only and time-limited per invitee.
There is no downline. Recruiting many *active* users directly is exactly the
behavior the mechanism intends to pay for.
