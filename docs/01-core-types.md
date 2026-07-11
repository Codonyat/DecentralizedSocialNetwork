# Core Types & Crypto Primitives (`dsn-core`)

## Module Structure

```
crates/core/src/
├── lib.rs              # Re-exports all public types
├── identity.rs         # ed25519 key wrappers, IdentityId, user identity
├── post.rs             # Post, reply, thread types
├── profile.rs          # User profile
├── social.rs           # Follow list, feed index
├── token.rs            # Bond, Donation, NameRecord (on-chain types)
├── epoch.rs            # Block-based epoch definitions, emission schedule
├── chain_events.rs     # ChainEvent enum (smart contract events)
├── crypto.rs           # Hashing, signing helpers
├── address.rs          # Content addresses, key addresses
└── error.rs            # Shared error types
```

## Identity Types (`identity.rs`)

### Design Decisions

- We wrap raw ed25519 byte arrays (`ed25519-dalek` under the hood); simulation uses the same real crypto, so there is one code path everywhere.
- Identity keys carry a versioned `scheme_id` (1 = ed25519). A future post-quantum migration is just a new scheme reached through key rotation (see the Identity Registry), never a type break.

```rust
/// An ed25519 public key (32 bytes). A user's genesis public key is their
/// permanent `IdentityId`; the key currently authorized to sign for that identity
/// is resolved through the IdentityRegistry (see below).
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PublicKey(pub [u8; 32]);

/// The permanent identity of a user: their genesis ed25519 public key.
/// `IdentityId` IS a `PublicKey`, so every structural reference to a user is
/// type-correct as-is; the current signing key is a separate, rotatable value.
pub type IdentityId = PublicKey;

/// An ed25519 secret key (32 bytes).
/// Never serialized to network storage — only held locally.
pub struct SecretKey(pub [u8; 32]);

/// An ed25519 signature (64 bytes).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signature(pub [u8; 64]);

/// A user identity combining key material with a human-readable handle.
/// The display_name is purely cosmetic. The `IdentityId` (genesis public key) is
/// the only canonical identity. An optional on-chain `@handle` is claimed via
/// NameRecord by setting an assessed value and paying the first epoch's rent, and
/// kept by paying per-epoch rent to the Reward Pool (Harberger-taxed for len ≤ 6,
/// flat rent for len ≥ 7).
#[derive(Clone, Serialize, Deserialize)]
pub struct UserIdentity {
    pub public_key: PublicKey,          // the user's IdentityId (genesis key)
    pub display_name: String,           // max 64 chars, cosmetic
    pub bio: String,                    // max 256 chars
    pub handle: Option<String>,         // on-chain unique @handle, if claimed
}
```

### Identity Principle

The canonical identity is the **`IdentityId`** — the user's genesis public key —
resolved through the **IdentityRegistry** to whatever key is currently authorized to
sign. A handle is a convenience layer, never an identity:

- All structural references — follows, replies, `mentions` — embed the `IdentityId` directly, never handles.
- Handles resolve to keys only at render time (the indexer/client looks up the current owner).
- The current signing key is rotatable (see below); the `IdentityId` never changes, so structural references stay stable across rotations and recoveries.
- The on-chain registry keeps queryable ownership history, so a client can render "formerly @x" and warn when a handle recently changed hands. Handles are rented, so a handle pointing at an identity today is no guarantee it did yesterday.

**IdentityId convention (binding).** Wherever protocol data references a user — the
invitation tree, donation tuples, flags, handle ownership, API `:user_pk` params, CLI
output — the value is the **`IdentityId`** (the genesis key), never a current signing
key. Because `IdentityId` IS a `PublicKey`, every existing `PublicKey`-typed reference
is already correct; the current signing key is consulted only to verify a signature,
via the registry. (Echoed in 07's API section.)

### Identity Registry, Rotation & Recovery

The **IdentityRegistry** is an on-chain contract mapping each `IdentityId` to its
current signing key and recovery configuration:

```rust
/// On-chain registry record for one identity (keyed by IdentityId).
pub struct RegistryRecord {
    /// The permanent identity anchor (genesis public key).
    pub identity: IdentityId,
    /// The key currently authorized to sign for this identity.
    pub current_key: PublicKey,
    /// Signature scheme of `current_key` (1 = ed25519).
    pub scheme_id: u8,
    /// Ordered history of authorized keys: (key, scheme_id, from_block, to_block).
    /// `to_block == None` for the current key.
    pub key_history: Vec<(PublicKey, u8, u64, Option<u64>)>,
    /// Keys explicitly revoked as compromised, with the revoking tx's block.
    pub revoked: Vec<(PublicKey, u64)>,
    /// Optional M-of-N guardian set for social recovery.
    pub guardians: Option<Guardians>,
}

pub struct Guardians {
    /// Guardian identities; their CURRENT keys (via the registry at approval time)
    /// sign approvals.
    pub keys: Vec<IdentityId>,
    /// Threshold M of N required to recover.
    pub threshold: u32,
}
```

**Rotation.** `rotate(new_key, scheme_id)`, signed by the current key, appends to
`key_history` and takes effect the next epoch. Rotation is proactive hygiene and
**never invalidates anything**: objects signed by a previous key stay valid forever
(see the validity rule). PQ migration is just a rotation into a new `scheme_id`.

**Guardians.** `set_guardians(keys, threshold)` (signed by the current key) opts an
identity into M-of-N social recovery. The invitation tree is a natural guardian set.
Guardians are `IdentityId`s; their *current* keys sign approvals.

**Recovery.** When a key is lost, guardians recover it:

- One active proposal at a time. `RecoveryProposed` **snapshots the guardian set** at proposal time and opens a `proposal_id`.
- Guardians submit `RecoveryApproved` against the `proposal_id`; once approvals reach the threshold M, a `RECOVERY_VETO_EPOCHS = 2` (tunable) veto window opens.
- While a proposal is active, `rotate()` and `set_guardians()` are **frozen** — a thief cannot swap guardians mid-recovery.
- The current key can `RecoveryVetoed` within the window; **the veto wins**. If no veto lands, execution is automatic at the deadline (`RecoveryExecuted` installs the new key).

**Honest scope.** Social recovery protects against **loss** of a key, not against
**theft of an active key**: a thief holding the current key can veto any recovery, so
that case is unrecoverable by design. This is the deliberate, stated trade-off.

**Validity rule (binding — the one rule).** An object is valid iff it is signed by
**any** key in the identity's registry history that was **not revoked**. Rotation is
irrelevant to validity — a proactively rotated key stays valid, past and future. The
*only* cutoff is explicit revocation: a separate `revoke_from(...)` action marks a key
compromised and emits `KeyRevoked { identity, key, block }`. An object signed by a
revoked key is valid iff it is proven to predate the revoking transaction's `block` —
either by an anchor Merkle branch (doc 12's timestamp anchoring) or by an on-chain
reference (a donation or bond pointing at it) — an objective, on-chain boundary. New
ingests of revoked-key objects without such a proof are rejected; a not-yet-anchored
object is marked unproven until the next anchor interval. `claimed_epoch` is display
metadata only and **never** enters validity. (Ingest + anchoring mechanics: 07.)

**Chain custody.** Each identity also binds an EVM gas account alongside its
content-signing key (the Farcaster custody-plus-signer split); the gas account pays for
on-chain actions and can itself be rotated. We do not overbuild this — one custody
binding, resolved through the same registry.

### Key Operations

```rust
impl SecretKey {
    /// Generate a new random secret key.
    pub fn generate() -> Self;

    /// Derive the corresponding public key.
    pub fn public_key(&self) -> PublicKey;

    /// Sign arbitrary bytes.
    pub fn sign(&self, message: &[u8]) -> Signature;

    /// Export as hex string (for local storage only).
    pub fn to_hex(&self) -> String;

    /// Import from hex string.
    pub fn from_hex(hex: &str) -> Result<Self, CryptoError>;
}

impl PublicKey {
    /// Verify a signature against a message.
    pub fn verify(&self, signature: &Signature, message: &[u8]) -> bool;

    /// Compute this key's deterministic logical address (see 02 for the
    /// hash-based addressing of mutable records).
    pub fn to_address(&self) -> ContentAddress;

    /// Display as shortened hex (first 8 chars) for UX.
    pub fn short_hex(&self) -> String;
}
```

### Crypto Backend

There is one code path everywhere: development, simulation, and production all use
real `ed25519-dalek` keys and signatures. No separate simulated scheme, no conversion
layer.

## Address Types (`address.rs`)

```rust
/// Content-addressed location: the BLAKE3 hash (32 bytes) of an object's bytes.
/// Used for immutable, content-addressed objects.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ContentAddress(pub [u8; 32]);

/// Key-addressed location (derived from a PublicKey).
/// Used for mutable records and signed edges.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct KeyAddress(pub PublicKey);

/// A reference that can point to either content-addressed or key-addressed data.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DataAddress {
    Content(ContentAddress),
    Key(KeyAddress),
}
```

### Address Computation

```rust
impl ContentAddress {
    /// Compute from raw data (BLAKE3 hash → 32 bytes).
    pub fn from_data(data: &[u8]) -> Self;
}

impl From<&PublicKey> for KeyAddress {
    fn from(pk: &PublicKey) -> Self;
}
```

## Post Types (`post.rs`)

```rust
/// A single post (analogous to a tweet).
/// A signed, content-addressed object published to the author's chosen indexers
/// (off-chain content storage; the author also keeps a local copy).
#[derive(Clone, Serialize, Deserialize)]
pub struct Post {
    /// Author's IdentityId (genesis public key).
    pub author: IdentityId,

    /// Epoch the author claims this post was created in. Display metadata only —
    /// covered by the signature but NEVER used for validity (see the validity rule).
    pub claimed_epoch: u64,

    /// Post content (plaintext, max 4000 chars).
    pub content: String,

    /// Optional: address of parent post (makes this a reply).
    pub reply_to: Option<ContentAddress>,

    /// Monotonic counter per author (prevents replay).
    pub sequence: u64,

    /// Timestamp (informational, not trusted for protocol logic).
    pub created_at: chrono::DateTime<chrono::Utc>,

    /// The amount of Y the author bonds on this post at creation time.
    /// This is the mandatory first bond — recorded on-chain via a Bond transaction.
    pub initial_bond_amount: u64,

    /// IdentityIds mentioned in the post. Clients resolve @handles to keys at
    /// write time and embed the keys here; handles are never stored structurally.
    pub mentions: Vec<IdentityId>,

    /// Attached media, referenced by content address (never bare URLs).
    pub media: Vec<MediaRef>,

    /// Optional recent L2 block hash captured at creation, under the signature.
    /// A later anchor of that block proves this post was created AFTER it — the
    /// "created-after" bound complementing anchoring's "existed-before" bound (doc 12).
    pub freshness_anchor: Option<[u8; 32]>,

    /// ed25519 signature over all fields above.
    pub signature: Signature,
}

/// A reference to a media blob by content address. Media bytes are stored and served
/// by indexers (or anyone) at their discretion and price; a lying host is caught on
/// first fetch because the bytes must hash to `hash` (see 02).
#[derive(Clone, Serialize, Deserialize)]
pub struct MediaRef {
    /// BLAKE3 content address of the media bytes.
    pub hash: ContentAddress,
    /// Optional hints for where to try fetching the bytes (not authoritative).
    pub server_hints: Vec<String>,
}

/// A signed post with its content address (computed after serialization).
#[derive(Clone, Serialize, Deserialize)]
pub struct SignedPost {
    pub post: Post,
    pub address: ContentAddress,
}
```

### Post Operations

```rust
impl Post {
    /// Create and sign a new post.
    pub fn new(
        sk: &SecretKey,
        claimed_epoch: u64,
        content: String,
        reply_to: Option<ContentAddress>,
        sequence: u64,
        initial_bond_amount: u64,
        mentions: Vec<IdentityId>,
        media: Vec<MediaRef>,
        freshness_anchor: Option<[u8; 32]>,
    ) -> Self;

    /// Verify the post's signature.
    pub fn verify(&self) -> bool;

    /// Compute the content address (hash of serialized post).
    pub fn content_address(&self) -> ContentAddress;

    /// The bytes that are signed: all fields except `signature`, including
    /// `author`, `claimed_epoch`, `sequence`, `mentions`, `media`, and
    /// `freshness_anchor`.
    pub fn signable_bytes(&self) -> Vec<u8>;
}
```

### Validation Rules

- `content.len() <= 4000` (characters, not bytes)
- `signature` must verify against `signable_bytes()` using the key current for `author`'s IdentityId in the registry (per the validity rule); a revoked signing key requires a pre-revocation anchor/on-chain proof
- `sequence` must be strictly greater than the author's last known sequence
- `reply_to`, if present, must reference an existing post
- `initial_bond_amount > 0` (every post must have a non-zero creator bond)
- `mentions` may reference any `IdentityId`; an identity with no known handle at render time displays as raw hex
- each `MediaRef.hash` must be a well-formed content address; fetched media bytes must hash to it

## Profile Types (`profile.rs`)

```rust
/// User profile stored as a signed mutable record (off-chain, mutable).
/// User can update freely.
#[derive(Clone, Serialize, Deserialize)]
pub struct UserProfile {
    /// The owner's IdentityId (also derives the record's logical address).
    pub owner: IdentityId,

    /// Human-readable display name (max 64 chars).
    pub display_name: String,

    /// Short bio (max 256 chars).
    pub bio: String,

    /// Content address of an avatar image object (optional).
    pub avatar: Option<ContentAddress>,

    /// Monotonic version counter.
    pub version: u64,

    /// Signature over all fields above.
    pub signature: Signature,
}
```

## Social Types (`social.rs`)

```rust
/// A user's follow list, stored as a signed mutable record (off-chain).
#[derive(Clone, Serialize, Deserialize)]
pub struct FollowList {
    pub owner: IdentityId,
    pub following: Vec<IdentityId>,
    pub version: u64,
    pub signature: Signature,
}

/// A user's feed index, stored as a signed mutable record (off-chain).
/// Maps to the last N posts by this user (rolling window).
#[derive(Clone, Serialize, Deserialize)]
pub struct FeedIndex {
    pub owner: IdentityId,
    /// Ordered list of post addresses, newest first.
    /// A 4 MB mutable record ≈ 125K entries.
    pub posts: Vec<ContentAddress>,
    pub version: u64,
    pub signature: Signature,
}
```

## Token Types (`token.rs`)

All token operations happen on-chain via smart contracts. These types represent the on-chain data structures that the smart contract manages. Token Y is the sole token — there is no separate reputation token.

```rust
/// A bond placed on a post (on-chain).
/// Bonds are the primary curation signal. Bonding Y on a post signals
/// belief in its quality. A fraction of each bond is taken as a protocol fee and
/// recycled to the Reward Pool; tokens are never destroyed. The mandatory first
/// bond is paid entirely into the Reward Pool (see 03 §C).
#[derive(Clone, Serialize, Deserialize)]
pub struct Bond {
    /// The user placing the bond.
    pub bonder: PublicKey,
    /// Content hash of the post being bonded on.
    pub post_content_hash: ContentAddress,
    /// Amount of Y bonded.
    pub amount: u64,
    /// True if this is the mandatory creator bond (first bond on the post).
    pub is_first_bond: bool,
}

/// A donation to a post's creator (on-chain).
/// Donations transfer Y to the creator, with a fraction taken as a protocol fee
/// and recycled to the Reward Pool.
#[derive(Clone, Serialize, Deserialize)]
pub struct Donation {
    /// The user making the donation.
    pub donor: PublicKey,
    /// Content hash of the post being donated to.
    pub post_content_hash: ContentAddress,
    /// The creator who receives the donation.
    pub creator: PublicKey,
    /// Total amount of Y donated.
    pub amount: u64,
    /// Fee recycled to the Reward Pool (e.g., 5%).
    pub fee_amount: u64,
    /// Remainder transferred to the creator.
    pub creator_amount: u64,
}

/// An on-chain @handle record.
/// A handle is claimed (never purchased) and kept by paying per-epoch rent to the
/// Reward Pool; tokens are never destroyed. Short handles (len ≤ 6) are Harberger-
/// taxed on a self-assessed value; long handles (len ≥ 7) pay a flat rent.
#[derive(Clone, Serialize, Deserialize)]
pub struct NameRecord {
    /// The current owner.
    pub owner: PublicKey,
    /// The handle (lowercase alphanumeric + hyphens, 1-32 chars).
    pub handle: String,
    /// Self-assessed Harberger value V (atomic Y); stored as `0` in the flat tier,
    /// where V is meaningless (no force-buy, flat rent).
    pub assessed_value: u64,
    /// A pending assessment change; a decrease takes effect only after
    /// LOOKBACK_EPOCHS, so an owner cannot dodge a force-buy by dropping V.
    pub pending_assessment: Option<(u64, u64)>, // (value, effective_epoch)
    /// An open force-buy bid, if any (Harberger tier only).
    pub force_buy: Option<ForceBuy>,
    /// Epoch at which the handle was claimed.
    pub claimed_at_epoch: u64,
    /// Rent is paid through (and including) this epoch.
    pub rent_paid_through_epoch: u64,
}

/// An open force-buy on a Harberger-tier handle.
#[derive(Clone, Serialize, Deserialize)]
pub struct ForceBuy {
    pub bidder: PublicKey,
    /// The escrowed bid = `max(V, floor)` at trigger time.
    pub bid: u64,
    /// The transfer executes at this epoch unless the owner cancels first.
    pub deadline_epoch: u64,
}

/// An invitation record (on-chain).
/// Invitations form a web-of-trust tree rooted at genesis users.
#[derive(Clone, Serialize, Deserialize)]
pub struct OnChainInvitation {
    /// The user issuing the invitation.
    pub inviter: PublicKey,
    /// The user being invited.
    pub invitee: PublicKey,
    /// Y paid to issue this invitation; the fee is recycled to the Reward Pool.
    pub y_cost: u64,
    /// Trust distance from genesis (inviter's distance + 1).
    pub trust_distance: u32,
}
```

**Fee arithmetic convention (applies to every bps calculation in these docs):**
every basis-point multiplication uses `u128` intermediates, because at the 140B-Y
scale `amount * bps` (and pool-balance math) overflows `u64`. Protocol **fees round
up** — `fee = ((x as u128 * bps as u128 + 9_999) / 10_000) as u64` — so no dust
ever escapes fee-free; **payouts and the pool drip round down**.

### Validation Rules

**Bond:**
- `amount > 0`
- If `is_first_bond == true`, `bonder` must be the post author
- A post must have exactly one first bond (the creator bond)
- `bonder` must have sufficient Y balance on-chain

**Donation:**
- `amount >= MIN_DONATION` (smaller donations are invalid — no fee-free dust)
- `fee_amount + creator_amount == amount`
- `fee_amount` must match the ceiling-division fee `((amount as u128 * donation_fee_bps as u128 + 9_999) / 10_000) as u64`
- `donor` must have sufficient Y balance on-chain
- `creator` must be the actual author of the referenced post

**NameRecord (claim):**
- `handle` must match `^[a-z0-9-]{1,32}$` (NFKC-normalized before matching)
- `handle` must not already be owned (claim only if unowned)
- Harberger tier (len ≤ 6): `assessed_value >= assessment_floor(len)`; flat tier (len ≥ 7): `assessed_value` is ignored and stored as `0`
- The first epoch's rent is due at claim time
- `owner` must have sufficient Y balance on-chain

**OnChainInvitation:**
- `inviter` must be an existing invited user (or genesis)
- `invitee` must not already be invited
- `y_cost` must match `EpochConfig::invitation_cost_y`
- `trust_distance == inviter.trust_distance + 1`

## Epoch Types (`epoch.rs`)

Epochs are block-based: the smart contract advances the epoch after a fixed number of blocks. Emission is distributed on-chain at epoch boundaries.

```rust
/// Configuration constants for epoch mechanics (on-chain, set at contract deployment).
/// Changes only through governance or contract migration.
pub struct EpochConfig {
    /// Number of blockchain blocks per epoch.
    pub epoch_duration_blocks: u64,
    /// Bond fee, recycled to the Reward Pool (basis points, e.g., 1000 = 10%). (tunable)
    pub bond_fee_bps: u64,
    /// Donation fee, recycled to the Reward Pool (basis points, e.g., 500 = 5%). (tunable)
    pub donation_fee_bps: u64,
    /// Minimum valid donation (atomic Y, e.g., 10_000 = 0.01 Y). (tunable)
    pub min_donation: u64,
    /// Y cost to issue an invitation; the fee is recycled to the Reward Pool. (tunable)
    pub invitation_cost_y: u64,
    /// Maximum percentage of epoch emission any single creator can receive (basis points). (tunable)
    pub per_creator_emission_cap_bps: u64,
    /// Fraction of the Reward Pool balance dripped into creator emission each epoch
    /// (basis points, e.g., 200 = 2%). (tunable)
    pub reward_pool_drip_bps: u64,
    /// Harberger rent rate for short handles (basis points of `max(V, floor)` per epoch,
    /// e.g., 10 = 0.1%). (tunable)
    pub handle_rent_rate_bps: u64,
    /// Flat rent per epoch for long handles (len ≥ 7), identical for all such lengths
    /// (atomic Y, e.g., 1 Y). (tunable)
    pub flat_handle_rent: u64,
    /// Force-buy notice window: epochs the owner has to cancel before transfer. (tunable)
    pub notice_window_epochs: u64,
    /// Epochs over which an assessment decrease (and retroactive rent) is applied. (tunable)
    pub lookback_epochs: u64,
    /// Grace epochs after nonpayment before a handle lapses to unowned. (tunable)
    pub grace_epochs: u64,
    /// Non-refundable force-buy fee, recycled to the Reward Pool (basis points of the bid,
    /// e.g., 100 = 1%). (tunable)
    pub force_buy_fee_bps: u64,
    /// To cancel a force-buy, the owner must raise V to at least (100% + this) of the bid
    /// (basis points, e.g., 1000 = raise to ≥ 110% of the bid). (tunable)
    pub raise_premium_bps: u64,
    /// Referral annuity: share of an invitee's protocol fees routed to their direct
    /// inviter (depth 1) during `referral_term_epochs`, taken before the remainder
    /// reaches the Reward Pool (basis points). (tunable)
    pub referral_bps: u64,               // REFERRAL_BPS = 1000  (10%)
    /// Epochs after an invitee joins during which the referral annuity applies. (tunable)
    pub referral_term_epochs: u64,       // REFERRAL_TERM_EPOCHS = 208  (~4y)
    /// Share of the gross pool drip routed to the Treasury each epoch, until
    /// `treasury_term_epochs` (basis points). (tunable)
    pub treasury_drip_share_bps: u64,    // TREASURY_DRIP_SHARE_BPS = 1500  (15%)
    /// Epochs the Treasury slice is taken; afterward 100% of the drip goes to
    /// creators. (tunable)
    pub treasury_term_epochs: u64,       // TREASURY_TERM_EPOCHS = 260  (~5y)
    /// Epoch at which any unspent Treasury balance auto-returns to the pool. (tunable)
    pub treasury_reclaim_epoch: u64,     // TREASURY_RECLAIM_EPOCH = 416  (~8y)
    /// Veto window (in epochs) after guardian recovery reaches threshold, during
    /// which the current key can cancel the recovery. (tunable)
    pub recovery_veto_epochs: u64,       // RECOVERY_VETO_EPOCHS = 2
}

/// Y emission schedule — fixed at contract deployment, halving-based.
/// Enforced on-chain by the smart contract. `emission_for_epoch` returns only the
/// *scheduled* portion; the per-epoch total distributed to creators is
/// `scheduled + creator_drip`, where `creator_drip = gross_drip − treasury_slice`
/// (see the Reward Pool and drip accounting, 03).
pub struct EmissionSchedule {
    /// Hard-cap total supply of Y (atomic units): 140B Y (6 decimals, fits u64).
    /// Scheduled emission asymptotically approaches this cap; integer-truncation
    /// dust stays unminted. (tunable)
    pub total_supply: u64,                  // 140_000_000_000_000_000
    /// Y emitted per epoch before any halving: 1.4B Y. (tunable)
    pub initial_emission_per_epoch: u64,    // 1_400_000_000_000_000
    /// Number of epochs between halvings (ideal sum 1.4B × 50 × 2 = 140B). (tunable)
    pub halving_interval: u64,              // 50
}
```

### Emission Calculation

```rust
impl EmissionSchedule {
    /// Compute the *scheduled* Y emission for a given epoch number.
    /// This logic is mirrored in the smart contract.
    pub fn emission_for_epoch(&self, epoch: u64) -> u64 {
        let halvings = epoch / self.halving_interval;
        // Shift-width safety only: 1.4e15 < 2^51, so the value is already 0 from
        // halving 51 onward. This is NOT an economic cutoff — creator emission
        // continues (as recycled fees via the pool drip) under the 140B cap.
        if halvings >= 51 { return 0; }
        self.initial_emission_per_epoch >> halvings
    }

    /// Compute total scheduled Y minted up to (not including) a given epoch.
    /// The hard cap applies to cumulative *scheduled* minting; the pool drip only
    /// redistributes already-minted tokens and does not mint against the cap.
    pub fn total_emitted_before_epoch(&self, epoch: u64) -> u64;
}
```

**Epoch-0 genesis bootstrap:** at launch nobody holds Y, so there are no donations
to direct emission. Epoch 0's scheduled emission (1.4B Y) is instead split equally
among the deployer-seeded genesis accounts. From epoch 1 onward, distribution is
donation-directed (see 03 §D).

**Per-epoch total and remainders:** the amount distributed to creators in an epoch is
`emission_for_epoch(epoch) + creator_drip`, where `gross_drip = pool_balance × drip_bps`,
`treasury_slice` is skimmed from it (03, A2), and `creator_drip = gross_drip − treasury_slice`.
Any scheduled emission or `creator_drip` left undistributed (zero qualifying donations,
or per-creator caps binding) accrues to the Reward Pool rather than being lost.

## Chain Events (`chain_events.rs`)

Events emitted by the smart contracts, consumed by the off-chain indexer. These represent the canonical on-chain state transitions.

```rust
/// Events emitted by smart contracts, consumed by the indexer.
/// This enum is CANONICAL: the indexer's listener (07) mirrors these variant names
/// and payload fields exactly.
///
/// Referral cut: every fee-bearing variant carries `referral_to` (the payer's direct
/// inviter, if the payer is within their `referral_term_epochs`) and `referral_amount`
/// (split off before the pool deposit; 0 if none). See 05.
#[derive(Clone, Serialize, Deserialize)]
pub enum ChainEvent {
    /// A Y token transfer between two accounts.
    Transfer {
        from: PublicKey,
        to: PublicKey,
        amount: u64,
    },
    /// A bond placed on a post.
    Bond {
        bonder: PublicKey,
        post_hash: ContentAddress,
        amount: u64,
        referral_to: Option<IdentityId>,
        referral_amount: u64,
    },
    /// A donation made to a post's creator.
    Donation {
        donor: PublicKey,
        post_hash: ContentAddress,
        amount: u64,
        referral_to: Option<IdentityId>,
        referral_amount: u64,
    },
    /// A handle claimed (previously unowned) on-chain.
    NameClaimed {
        owner: PublicKey,
        handle: String,
        assessed_value: u64, // 0 in the flat tier
        epoch: u64,
    },
    /// A handle's self-assessed value changed (a decrease takes effect after LOOKBACK).
    AssessmentChanged {
        handle: String,
        old_value: u64,
        new_value: u64,
        effective_epoch: u64,
    },
    /// Per-epoch handle rent paid into the Reward Pool.
    NameRentPaid {
        handle: String,
        payer: PublicKey,
        amount: u64,
        paid_through_epoch: u64,
        referral_to: Option<IdentityId>,
        referral_amount: u64,
    },
    /// A force-buy bid opened on a Harberger-tier handle (bid escrowed; 1% fee → pool).
    ForceBuyInitiated {
        handle: String,
        bidder: PublicKey,
        bid: u64,
        deadline_epoch: u64,
        referral_to: Option<IdentityId>,
        referral_amount: u64,
    },
    /// A handle changed owner (claim after a lapse, or a completed force-buy;
    /// any floor-excess fee flows to the pool net of the referral cut).
    NameTransferred {
        handle: String,
        from: PublicKey,
        to: PublicKey,
        referral_to: Option<IdentityId>,
        referral_amount: u64,
    },
    /// A handle lapsed to unowned after the grace period without rent.
    NameLapsed {
        handle: String,
        prior_owner: PublicKey,
        epoch: u64,
    },
    /// An invitation issued on-chain. Also opens a depth-1 referral annuity from the
    /// invitee to this inviter (see 05). `referral_*` here is the cut on the invite
    /// fee the INVITER pays, routed to THEIR own inviter if in-term.
    Invitation {
        inviter: PublicKey,
        invitee: PublicKey,
        cost: u64,
        referral_to: Option<IdentityId>,
        referral_amount: u64,
    },
    /// The epoch counter advanced. Fee portions (net of referral cuts) of bonds,
    /// donations, invitations, handle rent, and force-buy fees flow into the Reward
    /// Pool. The drip is then split: `gross_drip = pool_balance × drip_bps`,
    /// `treasury_slice = floor(gross_drip × TREASURY_DRIP_SHARE_BPS / 10_000)`
    /// (0 after TREASURY_TERM_EPOCHS), `creator_drip = gross_drip − treasury_slice`.
    EpochAdvanced {
        epoch: u64,
        scheduled_emission: u64,
        gross_drip: u64,
        treasury_slice: u64,
        pool_balance: u64,
    },
    /// Emission distributed to a creator for an epoch.
    EmissionDistributed {
        epoch: u64,
        creator: PublicKey,
        amount: u64,
    },
    /// A batch of newly indexed content addresses anchored as a Merkle root on the
    /// AnchorLog contract — proves every included object existed before this block
    /// (doc 12 timestamp anchoring).
    Anchored {
        sender: PublicKey,
        root: [u8; 32],
    },
    /// The signing key authorized for an identity was rotated (effective next epoch).
    /// Rotation never invalidates previously-signed objects.
    KeyRotated {
        identity: IdentityId,
        old_key: PublicKey,
        new_key: PublicKey,
        scheme_id: u8,
        effective_epoch: u64,
    },
    /// A key was explicitly revoked as compromised. Objects signed by it are valid
    /// only if proven (by anchor branch or on-chain reference) to predate `block`.
    KeyRevoked {
        identity: IdentityId,
        key: PublicKey,
        block: u64,
    },
    /// An identity opted into (or updated) an M-of-N social-recovery guardian set.
    GuardiansSet {
        identity: IdentityId,
        guardians: Vec<IdentityId>,
        threshold: u32,
    },
    /// A guardian recovery was proposed; the guardian set is snapshotted at this point.
    RecoveryProposed {
        identity: IdentityId,
        proposal_id: u64,
        proposed_key: PublicKey,
        scheme_id: u8,
        veto_deadline_epoch: u64,
    },
    /// A guardian approved an active recovery proposal.
    RecoveryApproved {
        identity: IdentityId,
        proposal_id: u64,
        guardian: IdentityId,
    },
    /// The current key vetoed an active recovery proposal (the veto wins).
    RecoveryVetoed {
        identity: IdentityId,
        proposal_id: u64,
    },
    /// A recovery executed automatically at its deadline, installing the new key.
    RecoveryExecuted {
        identity: IdentityId,
        proposal_id: u64,
        new_key: PublicKey,
        scheme_id: u8,
        epoch: u64,
    },
}
```

## Crypto Helpers (`crypto.rs`)

```rust
/// Hash data with BLAKE3 (fast, 32-byte output).
pub fn hash_blake3(data: &[u8]) -> [u8; 32];

/// Hash data with SHA-256 (compatibility with external systems).
pub fn hash_sha256(data: &[u8]) -> [u8; 32];

/// Compute a Merkle root from a list of 32-byte leaf hashes.
/// Uses BLAKE3 for internal nodes.
pub fn merkle_root(leaves: &[[u8; 32]]) -> [u8; 32];

/// Verify a Merkle proof (leaf + proof path → expected root).
pub fn merkle_verify(
    leaf: &[u8; 32],
    proof: &[MerkleProofNode],
    root: &[u8; 32],
) -> bool;

#[derive(Clone, Serialize, Deserialize)]
pub struct MerkleProofNode {
    pub hash: [u8; 32],
    pub is_left: bool,
}
```

## Error Types (`error.rs`)

```rust
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("invalid signature")]
    InvalidSignature,

    #[error("content too large: {size} bytes, max {max}")]
    ContentTooLarge { size: usize, max: usize },

    #[error("invalid sequence: expected > {expected}, got {actual}")]
    InvalidSequence { expected: u64, actual: u64 },

    #[error("serialization error: {0}")]
    Serialization(String),

    #[error("invalid public key: {0}")]
    InvalidPublicKey(String),

    #[error("invalid secret key: {0}")]
    InvalidSecretKey(String),

    #[error("invalid content address: {0}")]
    InvalidAddress(String),

    #[error("invalid name: {0}")]
    InvalidName(String),

    #[error("insufficient balance: have {have}, need {need}")]
    InsufficientBalance { have: u64, need: u64 },
}
```

## Serialization Strategy

| Context | Format | Why |
|---|---|---|
| Off-chain content storage (signed objects, indexer-hosted) | `bincode` | Compact, fast, deterministic |
| Signature computation | `bincode` | Must be deterministic across all clients |
| On-chain data | ABI-encoded | Smart contract compatibility |
| Indexer API responses | `serde_json` | Human-readable, web-compatible |
| Local key storage | Hex strings | Easy to copy/paste, grep in files |
| Debug/logging | `Debug` derive | Automatic from Rust derives |

**Critical invariant**: All types that are signed MUST serialize deterministically. `bincode` with default config produces deterministic output for the same input. We define a `signable_bytes(&self) -> Vec<u8>` method on every signed type that produces the canonical byte representation.

## Constants

```rust
pub const MAX_POST_CONTENT_CHARS: usize = 4_000;
pub const MAX_DISPLAY_NAME_CHARS: usize = 64;
pub const MAX_BIO_CHARS: usize = 256;
pub const MAX_HANDLE_CHARS: usize = 32;
pub const MAX_MUTABLE_RECORD_SIZE: usize = 4 * 1024 * 1024; // 4 MB (off-chain mutable-record limit)
pub const PUBLIC_KEY_SIZE: usize = 32;   // ed25519
pub const SECRET_KEY_SIZE: usize = 32;   // ed25519
pub const SIGNATURE_SIZE: usize = 64;    // ed25519
pub const CONTENT_ADDRESS_SIZE: usize = 32;
pub const ED25519_SCHEME_ID: u8 = 1;     // scheme_id 1 = ed25519

// Referral annuity, Treasury, and recovery constants — canonical values, mirrored
// wherever restated (all tunable). See EpochConfig above.
pub const REFERRAL_BPS: u64 = 1000;             // 10% of an invitee's protocol fees → direct inviter (depth 1)
pub const REFERRAL_TERM_EPOCHS: u64 = 208;      // ~4y per invitee
pub const TREASURY_DRIP_SHARE_BPS: u64 = 1500;  // 15% of the pool drip → Treasury
pub const TREASURY_TERM_EPOCHS: u64 = 260;      // ~5y; then 100% of drip to creators
pub const TREASURY_RECLAIM_EPOCH: u64 = 416;    // ~8y; unspent treasury auto-returns to pool
pub const RECOVERY_VETO_EPOCHS: u64 = 2;        // guardian-recovery veto window
```
