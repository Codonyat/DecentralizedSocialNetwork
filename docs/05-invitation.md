# Invitation Tree & Trust Distance (`dsn-invitation`)

## Purpose

The invitation system provides Sybil resistance via an on-chain invitation tree. Each invitation costs Y (flat cost; the fee is recycled to the Reward Pool), creating an auditable tree structure. A donor's **subtree position** — depth, ancestry, and lineage family — weights donations for emission calculation. An invitation also opens a **referral annuity**: a bounded-term cut of every protocol fee the invitee later pays routes back to their direct inviter (see Referral Annuity below). A donor **outside** the invitation tree carries **zero** donation weight by construction — the property that makes private, unweighted donations safe.

This document is the **canonical donation-weighting spec**. The weighting rules here (pairwise weight + lineage families) REPLACE both prior distance tables — the one that used to live in this file and the one in `03-token-y.md`. No other doc defines donation weights; 03 references this one.

## Module Structure

```
crates/invitation/src/
  lib.rs
  invite.rs            # Invitation logic
  trust_distance.rs    # Depth + ancestry (is_ancestor, LCA, hops_to_ancestor)
  donation_weight.rs   # Subtree-position donation weighting + lineage families
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
- Each invitation costs Y (flat cost, defined in `EpochConfig::invitation_cost_y`); the fee is recycled to the Reward Pool
- Each invitation also opens a **depth-1 referral annuity** from the invitee to the inviter (see Referral Annuity below)
- Tree structure: each account has exactly one inviter (except genesis accounts)
- Genesis accounts seeded by contract deployer at depth 0

### Tree Position Concepts

Three properties of the invitation tree drive weighting:

1. **Depth** = hops from genesis (each account has exactly one inviter, hence exactly one depth). Used to locate an account's lineage-family root, not to weight donations directly.
2. **Ancestry** = whether one account lies on the other's inviter chain to genesis (`is_ancestor`). An account and anyone it ultimately invited are ancestor/descendant at any depth.
3. **LCA & separation** = the lowest common ancestor of two accounts and `s = min(hops donor→LCA, hops recipient→LCA)`. Small `s` means the two accounts branch apart just below a shared ancestor (siblings, cousins) — cheap to manufacture, so low weight. Large `s` (or different genesis roots) means genuinely separated participants.

### Trust Distance

- `trust_distance(account) = inviter's trust_distance + 1`
- Genesis accounts have `trust_distance = 0` (equivalently, depth 0)

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

- Creating sock puppets costs Y per invite (the fee is recycled to the Reward Pool)
- Sock puppets sit CLOSE in the invitation tree (low donation weight when cross-donating)
- Y cost is the natural limiter (optionally also a per-epoch cap in the contract)
- **Self-referral is strictly unprofitable**: the referral annuity returns only 10% of fees that were already 100% the controller's money — a net loss after the pool fee — and the annuity scales with an invitee's *real* fee-paying usage, so quality recruiting beats puppet volume

## Trust Distance Computation (trust_distance.rs)

```rust
/// Compute the depth (trust distance) of an account from genesis.
/// Returns None if the account is not in the invitation tree.
pub fn trust_distance(
    account: &PublicKey,
    tree: &HashMap<PublicKey, PublicKey>, // invitee -> inviter
) -> Option<u32>;

/// True if `maybe_ancestor` lies on `node`'s inviter chain to genesis
/// (at any depth). An account is NOT its own ancestor.
pub fn is_ancestor(
    maybe_ancestor: &PublicKey,
    node: &PublicKey,
    tree: &HashMap<PublicKey, PublicKey>,
) -> bool;

/// The deepest node that is an ancestor of BOTH accounts, or None when they
/// descend from different genesis roots (no common ancestor).
pub fn lowest_common_ancestor(
    a: &PublicKey,
    b: &PublicKey,
    tree: &HashMap<PublicKey, PublicKey>,
) -> Option<PublicKey>;

/// Number of inviter steps from `descendant` up to `ancestor`
/// (0 if they are the same node). None if `ancestor` is not on the chain.
pub fn hops_to_ancestor(
    descendant: &PublicKey,
    ancestor: &PublicKey,
    tree: &HashMap<PublicKey, PublicKey>,
) -> Option<u32>;
```

## Donation Weighting (donation_weight.rs)

Donation weight has **two layers** applied together:

1. A **pairwise weight** per donation, from the donor's and recipient's positions in the tree.
2. A **lineage-family** aggregation across a recipient's incoming donations, so extra donations from the same corner of the tree yield diminishing returns.

### Pairwise weight

```rust
/// Pairwise weight of a single donation, from the donor's and recipient's
/// positions in the invitation tree. This is the sole canonical pairwise
/// spec — it REPLACES the old tables in both this doc and 03-token-y.
///
/// | Relationship                                | Weight |
/// |---------------------------------------------|--------|
/// | donor not in the invitation tree (private)  | 0.0    |
/// | same account (self-donation)                | 0.0    |
/// | ancestor / descendant (any depth)           | 0.25   |
/// | else, s = min(hops donor→LCA, recip→LCA):    |        |
/// |   s ≤ 2 (branch apart near a shared ancestor) | 0.5   |
/// |   s ≥ 3 (well separated) or different roots    | 1.0   |
pub fn pairwise_weight(
    donor: &PublicKey,
    recipient: &PublicKey,
    tree: &HashMap<PublicKey, PublicKey>, // invitee -> inviter
) -> f64 {
    // FIRST rule: a donor with no position in the invitation tree
    // (`trust_distance` = None) — e.g. a fresh standalone keypair used for a
    // private donation — carries zero emission weight by construction.
    if trust_distance(donor, tree).is_none() {
        return 0.0;
    }
    if donor == recipient {
        return 0.0;
    }
    if is_ancestor(donor, recipient, tree) || is_ancestor(recipient, donor, tree) {
        return 0.25; // within one lineage, at ANY depth of chain
    }
    match lowest_common_ancestor(donor, recipient, tree) {
        None => 1.0, // different genesis roots — fully independent
        Some(lca) => {
            let sd = hops_to_ancestor(donor, &lca, tree).unwrap_or(0);
            let sr = hops_to_ancestor(recipient, &lca, tree).unwrap_or(0);
            if sd.min(sr) <= 2 { 0.5 } else { 1.0 }
        }
    }
}
```

Any account not present in `tree` (no inviter chain — a fresh standalone keypair) resolves to weight **0.0**: this is what makes private donations safe, since such keypairs carry zero emission weight by construction. The donor still pays the 5% donation fee and the creator's share is unchanged; only the emission-directing weight is nulled (see the private-donations note in [03-token-y.md](03-token-y.md)).

### Lineage-Family Diminishing Returns

A **lineage family** is the boundary that a later participant cannot manufacture. A donor's family is the subtree rooted at the donor's ancestor at depth `FAMILY_ROOT_DEPTH = 2` (tunable). Donors at depth ≤ 2 are their own family. The family is identified by the PublicKey of that depth-2 root node.

Why this boundary is unforgeable: depth-2 nodes are minted only by depth-1 accounts (the genesis invitees). An attacker sitting anywhere deeper than depth 2 can NEVER mint a new family root — every account it creates (siblings, deep chains, parallel chains) walks up through the attacker's own depth-2 ancestor and collapses into a single family.

```rust
/// The donor's LINEAGE FAMILY: the subtree rooted at the donor's ancestor
/// at depth FAMILY_ROOT_DEPTH (= 2). Returns that family-root PublicKey.
/// Donors at depth ≤ 2 are their own family root.
pub fn lineage_family(
    donor: &PublicKey,
    tree: &HashMap<PublicKey, PublicKey>,
) -> Option<PublicKey> {
    let mut node = *donor;
    let mut depth = trust_distance(&node, tree)?;
    // Walk up toward genesis, stopping at depth FAMILY_ROOT_DEPTH.
    while depth > FAMILY_ROOT_DEPTH {
        node = *tree.get(&node)?;
        depth -= 1;
    }
    Some(node) // depth-2 ancestor, or the donor itself if depth ≤ 2
}

/// Per-epoch weight of a recipient. Incoming donations are grouped by the
/// donor's lineage family; each family's weighted sum is passed through a
/// concave exponent (BRANCH_FAMILY_EXPONENT = 0.5) so additional donations
/// from the SAME family yield diminishing returns. Emission is split across
/// recipients in proportion to this weight.
pub fn recipient_epoch_weight(
    recipient: &PublicKey,
    donations: &[(PublicKey, u64)], // (donor, amount) to this recipient
    tree: &HashMap<PublicKey, PublicKey>,
) -> f64 {
    let mut family_sums: HashMap<PublicKey, f64> = HashMap::new();
    for (donor, amount) in donations {
        let w = pairwise_weight(donor, recipient, tree);
        let fam = lineage_family(donor, tree).unwrap_or(*donor);
        *family_sums.entry(fam).or_default() += (*amount as f64) * w;
    }
    family_sums
        .values()
        .map(|s| s.powf(BRANCH_FAMILY_EXPONENT)) // ^0.5
        .sum()
}
```

The concave exponent is applied **per family**, not per donor — this is the key that defeats donation-splitting.

#### Worked example 1 — splitting across self-created invitees (one family, no gain)

Attacker M sits at depth 4 (well below the depth-2 line). M invites `n` fresh puppets `P1..Pn` (each depth 5, costing `n` invitation fees), and each `Pi` donates `A/n` Y to a creator account `C` that M also controls. Every `Pi` walks up through M to the same depth-2 ancestor `F`, so `lineage_family(Pi) = F` for all `i` — **one family**.

That family's weighted sum is `Σ (A/n)·w = A·w` (with `w` the shared pairwise weight), contributing `(A·w)^0.5` to `C`'s weight. A single donation of `A` from one account contributes `(A·w)^0.5` as well. Splitting into `n` puppets buys nothing and costs `n` invitation fees. The naive hope of `n·(A/n)^0.5 = √n·√A` is denied because the concave exponent is applied per family, not per donation.

#### Worked example 2 — sibling attack via a controlled inviter (still one family)

To dodge the ancestor/descendant 0.25 penalty, M instead spins up a controlled inviter `Q` inside his subtree and has `Q` invite many siblings `S1..Sn`, then routes donations sibling→`C`, hoping siblings read as independent (their pairwise separation can be pushed to `s = 1 → 0.5`, above the 0.25 floor).

But pairwise independence does not create family independence. `Q` and every `Si` sit inside M's subtree, so they all resolve to the same depth-2 ancestor `F`. All sibling donations land in the single family `F` and are flattened together by `F_sum^0.5`. Because family roots are minted only by genesis invitees (depth 1), M — being deep in the tree — cannot manufacture a second family no matter how he reshapes the accounts he controls. The sibling attack collapses to the same one-family bound as example 1.

### Why This Works Against Sock Puppets

- **Same-inviter puppets**: A and B share inviter P → `s = min(1,1) = 1` → pairwise 0.5, AND both share the same depth-2 ancestor → one lineage family. Two layers of discount stack.
- **Chained descendant**: A invites B (B is A's descendant) → `is_ancestor(A, B)` → 0.25 at ANY depth. Lengthening the chain never lifts a within-lineage donation above 0.25.
- **Self**: donor == recipient → 0.0.

## Referral Annuity

Inviting someone is not only a Sybil gate — it opens a **referral annuity**. For an invitee's first `REFERRAL_TERM_EPOCHS = 208` epochs (~4 years per invitee), a `REFERRAL_BPS = 1000` (10%, tunable) cut of every Reward-Pool inflow **attributable to that invitee as the payer** is split off to their **direct inviter** (depth 1 only) before the remainder reaches the Reward Pool.

**Base — every pool-bound fee the invitee pays as payer:** donation fees, bond fees (including the entire first bond, which is otherwise paid wholly into the pool), handle rent (including arrears), force-buy fees, and floor excesses on name takeovers. The payer is the account the Y left. Invitation fees are paid by the **inviter**, not the invitee — so an invitee's own later invitations carry a referral cut to *their* inviter one level up, never back to themselves.

The annuity is a redirection of already-paid fees, so it **costs the emission schedule nothing**: no new Y is minted; the Reward Pool simply receives the post-referral remainder. The split math lives in `referral.rs` (see [03-token-y.md](03-token-y.md)); the constants mirror `EpochConfig` in [01-core-types.md](01-core-types.md) and are restated under Constants below.

## Constants

```rust
/// Default invitation cost in Y (can be overridden in EpochConfig).
/// The invitation fee is recycled to the Reward Pool. (tunable)
pub const DEFAULT_INVITATION_COST_Y: u64 = 100_000_000; // 100 Y

/// Referral annuity: fraction of an invitee's pool-bound fees redirected to
/// their direct inviter, in basis points (1000 = 10%). (tunable)
pub const REFERRAL_BPS: u64 = 1_000; // mirrors EpochConfig

/// Referral annuity term: epochs an invitee's fees feed their inviter's
/// annuity (~4 years per invitee). (tunable)
pub const REFERRAL_TERM_EPOCHS: u64 = 208; // mirrors EpochConfig

/// Depth of the lineage-family root: a donor's family is the subtree rooted
/// at its ancestor at this depth. Depth-2 nodes are minted only by genesis
/// invitees, so no deeper participant can manufacture a new family. (tunable)
pub const FAMILY_ROOT_DEPTH: u32 = 2;

/// Concave exponent applied to each lineage family's weighted-donation sum,
/// giving diminishing returns to extra donations from one family. (tunable)
pub const BRANCH_FAMILY_EXPONENT: f64 = 0.5;

/// Max ancestry walk when computing depth / LCA / hops (cycle & runaway guard).
pub const MAX_ANCESTOR_WALK_DEPTH: u32 = 100;
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

### Chained descendants

**Attack**: A invites B invites C … a long chain, hoping depth buys weight, then donates along the chain.
**Defense**: Any ancestor/descendant pair scores pairwise weight 0.25 at ANY chain length — lengthening the chain never lifts a within-lineage donation above 0.25. Each hop also costs an invitation fee (recycled to the Reward Pool).

### Siblings & parallel chains under one controller

**Attack**: A controller builds many siblings or parallel sub-chains so cross-donations read as independent (pairwise 0.5–1.0).
**Defense**: Lineage-family collapse. Everything the controller builds below its own account resolves to one depth-2 family root, so all those donations sum inside a single family and are flattened by `family_sum^0.5` — no `√n` advantage from spreading donations across more puppets (see worked examples above). Family roots are minted only by genesis invitees, so a deeper attacker cannot mint a second family. Compounded by the per-invite fee and the per-creator emission cap (03 §D).

### Self-donation rings

**Attack**: An A ⇄ B ⇄ C cycle donating among accounts one entity controls.
**Defense**: Self-donations score 0.0; ancestor/descendant recycling scores 0.25; each donation pays the 5% fee (recycled to the Reward Pool) and each account pays an invitation fee. Combined with the per-creator cap, the ring bleeds Y for a heavily discounted, capped claim.

### Wash-trading (acknowledged open risk)

**Attack**: A controller cycles Y between related accounts it owns purely to convert fees into an emission claim on a recipient it also owns.

**Analysis**: Each 1 Y washed pays the donation fee `f ≈ 0.05` (5%, recycled to the Reward Pool) and, if routed ancestor↔descendant, contributes pairwise weight `w = 0.25` of weighted-Y toward the controlled recipient — a claim of roughly `w · e` Y, where `e` = emission paid per unit of weighted-Y directed that epoch (epoch emission ÷ total weighted donations, at the margin). If the controller **also referred** the paying account (still within its term), the referral annuity rebates `r = 0.10` of the fee, so the *effective* fee falls to `f(1−r) ≈ 0.045`. The cycle is profitable iff

```
w · e > f(1−r)   i.e.   e > f(1−r) / w = 0.045 / 0.25 ≈ 0.18  (Y of emission per weighted-Y)
```

so the referral annuity **slightly worsens** wash economics — it lowers the break-even emission rate from ~0.2 to ~0.18. The recovery is bounded: each invitee's referral term expires after `REFERRAL_TERM_EPOCHS = 208` epochs, and renewing it via a fresh invitee costs the 100 Y invitation fee, which prices the churn. Four factors still bound the attack, none eliminates it: the 0.25 weight makes washing 4× less efficient than an honest arm's-length donation; the lineage-family `^0.5` concavity shrinks the marginal claim as the controller pushes more through one family; the per-creator emission cap ceilings the recoverable amount; and invitation costs price every extra account.

This is an **acknowledged open risk, NOT a solved problem**. Whether real emission rates sit above or below the `e > f(1−r)/w` line, and how the per-creator cap, the exponent, the referral rate, and the fees should be set, is **simulation-required before launch** — the design does not claim the attack is impossible. (03 Economic Design states the matching profitability condition; the maximal adversarial case against donation-directed emission is archived in [archive/09-first-principles-review.md](archive/09-first-principles-review.md) §2.1, non-normative.) The parameters `f` (DONATION_FEE_BPS), `r` (REFERRAL_BPS), `w` (pairwise weight floor), `BRANCH_FAMILY_EXPONENT`, and the per-creator cap are all tunable.
