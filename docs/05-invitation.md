# Invitations: Vouches, Sponsorship & Aura (`dsn-invitation`)

## Purpose

Invitations are **data**. A signed, recipient-accepted "A vouches for B" object gives a newcomer cold-start context and an offered first follow. There is no invite fee, no on-chain tree, and no invitation-derived weight anywhere in the protocol.

No sybil defence lives here, because sybils gain nothing in either layer that matters:
- **Money** is bounded by stake × time: accounts, likes and routing add nothing to what a coalition can direct (03 §B, The bound).
- **Reach** is a conserved attention budget: creating accounts cannot raise anyone's share (09).

What remains is edge policy: invites are scarce but free, with quotas set by clients and hosts. It also covers two onboarding conveniences, power delegation and client-sponsored onboarding, and one status signal, aura.

Canonical home: this doc specifies `Vouch`, `PowerDelegation`, quotas, and aura. The types live in 01 (`vouch.rs`); money mechanics are in 03.

## Module Structure

```
crates/invitation/src/
  lib.rs
  vouch.rs         # Vouch statement signing, acceptance, validation
  delegation.rs    # PowerDelegation validation; which likes a sponsor may settle
  policy.rs        # Reference vouch-quota and aura policy (client/host-side, not protocol)
  error.rs
```

## Dependencies

```
dsn-invitation depends on:
  - dsn-core    (IdentityId, Vouch, PowerDelegation, Like, signing)
```

No `dsn-chain` dependency: nothing here is on-chain.

## Vouches (`vouch.rs`)

A **vouch** records that a voucher vouched for a vouchee, and that the vouchee accepted.

- The voucher signs a statement over `(voucher, vouchee, issued_epoch)`.
- The **vouchee** publishes the `Vouch` object (01), which embeds that signature. Publication is acceptance: a vouch nobody accepted does not exist. The object carries one envelope signature, the vouchee's (02).
- It is an ordinary off-chain signed object, published to indexers and synced like any other.

```rust
/// Voucher side: sign the statement a vouchee can later publish.
pub fn sign_vouch_statement(
    voucher_sk: &SecretKey,
    voucher: &IdentityId,
    vouchee: &IdentityId,
    issued_epoch: u64,
) -> Signature;

/// Vouchee side: build and sign the Vouch object (publication = acceptance).
pub fn accept_vouch(
    vouchee_sk: &SecretKey,
    voucher: IdentityId,
    vouchee: IdentityId,
    issued_epoch: u64,
    voucher_signature: Signature,
    claimed_epoch: u64,
) -> Vouch;

/// Both signatures verify (each under the validity rule of 01), voucher != vouchee.
pub fn validate_vouch(vouch: &Vouch) -> Result<(), InvitationError>;
```

**Rules**
- **Uniqueness.** One vouch per `(voucher, vouchee)`; first-seen wins (ties broken by lowest object hash).
- **History, not privilege.** A vouch grants nothing, so there is nothing to revoke. The vouchee may retract it (02).
- **Uses.**
  - Cold-start context: the default client offers the voucher as the newcomer's first follow (09, Cold Start).
  - A "vouched by" line on profiles.
  - Natural guardian candidates (01, Guardians).

**Invite flow.** The newcomer's client generates a key and shares its `IdentityId`, usually through an invite link. The voucher's client signs the statement and returns it as a token. The newcomer's client publishes the `Vouch`. Two things may optionally accompany a vouch:
- a plain Y transfer, which is just a transfer;
- a `PowerDelegation`.

## Power Delegation (`delegation.rs`)

Newcomers have **ranking weight immediately**: their likes are free signed objects and count as ranking edges from the first one (09). They have **money weight** when they hold and stake Y, or when a **sponsor** — an inviter or a client — lets them spend part of the sponsor's like power.

- A sponsor signs a `PowerDelegation { sponsor, delegate, expires_epoch }` (01).
- The delegate's likes name the sponsor (`Like.sponsor`).
- The sponsor includes those likes in its own daily settlement, where they debit the sponsor's **one** power meter (03 §B).

**Delegation is conserved.** All of a sponsor's delegates debit the same meter, so delegating to a thousand accounts spends no more than the sponsor could spend alone. How much of its meter the sponsor opens to delegates is a sponsor-side allowance: client configuration, with no on-chain state.

```rust
/// A like may carry the sponsor's power iff a valid PowerDelegation from
/// `like.sponsor` to `like.liker` exists with `expires_epoch >= epoch`.
pub fn like_may_use_sponsor(
    like: &Like,
    delegations: &[PowerDelegation],
    epoch: u64,
) -> bool;

/// Sponsor side: order candidate delegate likes for the day's settlement,
/// capped by the sponsor's allowance (power units). Pure policy; the chain
/// sees only the sponsor's own settlement.
pub fn select_delegate_likes(
    candidates: &[Like],
    allowance: u64,
    power: u64,
) -> Vec<Like>;
```

## Sponsored Onboarding (client convention, not protocol)

A newcomer should never need ETH or Y to start. Clients pay for onboarding as an acquisition cost and recoup it from facilitator fees (03 §C; 07, Indexer Economics):

- **Gas.** An ERC-4337 paymaster run by the client sponsors the newcomer's on-chain actions and daily settlements. The client's own abuse policy decides whom it sponsors, for example requiring an accepted vouch. There is no protocol paymaster and no protocol gate.
- **First handle.** The client funds the first epoch's rent with a plain transfer bundled with the claim (03 §D). The registry is unchanged.

## Quotas & Aura (`policy.rs`, client/host policy — NOT protocol)

**Invites are scarce but free.** A client or host may cap how many vouches an identity issues per epoch. It may refuse to index vouches beyond its policy, or a ranker may ignore them. Quotas exist for spam and UX, not sybil defence: a sybil holding a thousand vouches gains no money and no reach.

**Aura** is a **non-transferable status score** that clients and indexers compute from public likes. The protocol records no aura. It is bound by these rules:

- It never feeds money: aura is not an input to issuance, fees or tips.
- It never feeds reach: aura is not a ranking feature and not a budget input (09).
- Its one scarce perk is **extra invites**: a larger vouch quota under the computing party's policy.
- Its formula is local policy, like label aggregation (06). The reference default counts distinct likers of an account's posts over a trailing window; any policy is valid, and an indexer's aura is advisory display.

```rust
/// Reference policy knobs; values are client/host configuration, not protocol constants.
pub struct VouchQuotaPolicy {
    pub base_per_epoch: u32,
    pub aura_bonus_per_epoch: fn(u64) -> u32, // extra invites for a given aura
    pub aura_window_epochs: u64,
}

/// Reference aura: distinct likers of `account`'s posts within the window.
pub fn aura(account: &IdentityId, likes_received: &[Like], window_start_epoch: u64) -> u64;

/// Vouches `account` may issue this epoch under `policy`.
pub fn vouch_quota(aura: u64, policy: &VouchQuotaPolicy) -> u32;
```

## Error Types

```rust
#[derive(Debug, thiserror::Error)]
pub enum InvitationError {
    #[error("cannot vouch for yourself")]
    SelfVouch,

    #[error("invalid voucher signature")]
    InvalidVoucherSignature,

    #[error("invalid vouchee signature")]
    InvalidVoucheeSignature,

    #[error("delegation expired at epoch {expires_epoch}")]
    DelegationExpired { expires_epoch: u64 },

    #[error("no delegation from sponsor to liker")]
    NoDelegation,
}
```

## Anti-Gaming Analysis

### Sybil vouch farms

**Attack.** One controller creates many accounts and vouches for all of them, or collects vouches from them.
**Outcome.** The farm gains nothing it can spend. Money is stake-bounded (03 §B), and a vouch confers no budget share (09). The only product is aura-based extra invites, which buy only more vouches. Quotas and indexing policy keep the spam cost on the farm's hosts.

### Delegation amplification

**Attack.** A sponsor delegates to many accounts to multiply its like power.
**Outcome.** Impossible by construction: every delegate debits the sponsor's one meter.

### Cold-start steering (honest limit)

A voucher, or the default client, chooses what a newcomer sees first; that is real influence. It is bounded, not removed:
- The newcomer can unfollow.
- 20% of the feed is labelled exploration from providers the viewer chooses (09).
- The budget cannot be inflated by the voucher's own accounts.

Collusion among trusted accounts, and endorsements sold for money, are not stopped here (09, honest limits).

### What was removed

The on-chain invitation tree, the 100 Y invitation fee, trust distance, and the invitation-weighted donation rules (pairwise weights and lineage-family diminishing returns) are gone.

They defended a money layer that no longer pays by activity. They deterred only lazy harvesters, and they taxed honest friends: every honest invite paid the fee, and every related-account like was discounted. Stake now bounds the money layer (03 §B, and 03 Economic Design, Superseded designs).
