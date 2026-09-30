# Core Types & Crypto Primitives (`dsn-core`)

## Module Structure

```
crates/core/src/
├── lib.rs              # Re-exports all public types
├── identity.rs         # ed25519 key wrappers, IdentityId, user identity
├── post.rs             # Post, reply, thread types
├── profile.rs          # User profile
├── social.rs           # Follow list, feed index
├── like.rs             # Like object: the one button (money rules: 03 §B)
├── vouch.rs            # Vouch + PowerDelegation (canonical spec: 05)
├── label.rs            # Content label (canonical spec: 06)
├── token.rs            # Tip, ForeignKey, GenesisLeaf, PowerMeter, NameRecord (on-chain types)
├── epoch.rs            # Time-based epochs, EpochConfig, supply schedule
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
/// kept by paying per-epoch rent to the fee pool (Harberger-taxed for len ≤ 6,
/// the base rent for len ≥ 7).
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

**IdentityId convention (binding).** Wherever protocol data references a user — vouches,
likes, tips, stakes, labels, handle ownership, API `:user_pk` params, CLI
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
identity into M-of-N social recovery. Your vouchers and vouchees (05) are a natural guardian set.
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
reference (a tip pointing at it) — an objective, on-chain boundary. New
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

    /// Optional: address of a post being reposted or quoted. MUST NOT be set
    /// together with `reply_to`. Empty `content` makes this a pure repost; non-empty
    /// `content` makes it a quote post.
    pub repost_of: Option<ContentAddress>,

    /// Monotonic counter per author (prevents replay).
    pub sequence: u64,

    /// Timestamp (informational, not trusted for protocol logic).
    pub created_at: chrono::DateTime<chrono::Utc>,

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
        repost_of: Option<ContentAddress>,
        sequence: u64,
        mentions: Vec<IdentityId>,
        media: Vec<MediaRef>,
        freshness_anchor: Option<[u8; 32]>,
    ) -> Self;

    /// Verify the post's signature.
    pub fn verify(&self) -> bool;

    /// Compute the content address (hash of serialized post).
    pub fn content_address(&self) -> ContentAddress;

    /// The bytes that are signed: all fields except `signature`, including
    /// `author`, `claimed_epoch`, `sequence`, `repost_of`, `mentions`, `media`,
    /// and `freshness_anchor`.
    pub fn signable_bytes(&self) -> Vec<u8>;
}
```

### Validation Rules

- `content.len() <= 4000` (characters, not bytes)
- `signature` must verify against `signable_bytes()` using the key current for `author`'s IdentityId in the registry (per the validity rule); a revoked signing key requires a pre-revocation anchor/on-chain proof
- `sequence` must be strictly greater than the author's last known sequence
- `reply_to`, if present, must reference an existing post
- `reply_to` and `repost_of` MUST NOT both be set (a post is a reply or a repost/quote, not both)
- `repost_of`, if present, must reference an existing post; empty `content` makes it a pure repost, non-empty `content` a quote post
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

## Like Types (`like.rs`)

The one button (03 §B). A like is an off-chain signed, content-addressed object — free, and a ranking edge for everyone (09). For an account with stake, or under a sponsor's `PowerDelegation`, the client also settles it on-chain, where it spends like power and directs issuance (03 §B).

```rust
/// A signed like (off-chain, content-addressed).
#[derive(Clone, Serialize, Deserialize)]
pub struct Like {
    /// The liker's IdentityId.
    pub liker: IdentityId,
    /// Content address of the liked post.
    pub target: ContentAddress,
    /// Optional recipient split in basis points (client convention). Empty = 100%
    /// to the target's author. The protocol enforces only that a settlement's
    /// shares sum to the batch spend (03 §B).
    pub recipients: Vec<(IdentityId, u16)>,
    /// Set when the like spends a sponsor's power under a PowerDelegation (05).
    pub sponsor: Option<IdentityId>,
    /// Display metadata only; never enters validity.
    pub claimed_epoch: u64,
    /// ed25519 signature over all fields above.
    pub signature: Signature,
}
```

**Validation:** the signature verifies under the validity rule; `target` references an existing post; `recipients` is empty or its bps sum to exactly 10,000; `sponsor`, if set, names an identity holding a live `PowerDelegation` to `liker`. One like per `(liker, target)`, first-seen wins (ties broken by lowest object hash); un-liking is a retract (02).

## Vouch Types (`vouch.rs`)

Invitations are data (canonical spec: 05). Both objects are off-chain, signed, and content-addressed.

```rust
/// "voucher vouches for vouchee", recipient-accepted: the VOUCHEE publishes it,
/// so publication is acceptance, and the object carries one envelope signature (02).
#[derive(Clone, Serialize, Deserialize)]
pub struct Vouch {
    pub voucher: IdentityId,
    pub vouchee: IdentityId,
    /// Epoch the voucher signed the statement.
    pub issued_epoch: u64,
    /// The voucher's signature over (voucher, vouchee, issued_epoch).
    pub voucher_signature: Signature,
    /// Display metadata only; never enters validity.
    pub claimed_epoch: u64,
    /// The vouchee's signature over all fields above.
    pub signature: Signature,
}

/// A sponsor lets `delegate` spend the sponsor's like power (03 §B, 05).
/// All of a sponsor's delegates debit the sponsor's one meter.
#[derive(Clone, Serialize, Deserialize)]
pub struct PowerDelegation {
    pub sponsor: IdentityId,
    pub delegate: IdentityId,
    /// Last epoch in which the delegate's likes may carry the sponsor's power.
    pub expires_epoch: u64,
    /// Display metadata only; never enters validity.
    pub claimed_epoch: u64,
    /// The sponsor's signature over all fields above.
    pub signature: Signature,
}
```

## Token Types (`token.rs`)

All token operations happen on-chain via smart contracts. These types represent the on-chain data structures that the smart contracts manage. Token Y is the sole token — there is no separate reputation token, and like power is a meter, never a token.

```rust
/// A pre-existing external key that can receive an escrowed tip or hold a
/// genesis leaf (03 §A, §C). Ethereum addresses first; ENS names resolve
/// client-side to an address.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ForeignKey {
    Ethereum([u8; 20]),
}

#[derive(Clone, Serialize, Deserialize)]
pub enum TipRecipient {
    /// A DSN identity; paid immediately.
    Identity(IdentityId),
    /// A foreign key; the net amount waits in escrow (03 §C).
    Foreign(ForeignKey),
}

/// A tip (on-chain). Fees are taken at tip time (03 §C).
#[derive(Clone, Serialize, Deserialize)]
pub struct Tip {
    pub tipper: PublicKey,
    pub recipient: TipRecipient,
    /// Optional post the tip refers to.
    pub post: Option<ContentAddress>,
    /// Gross amount paid by the tipper.
    pub amount: u64,
    /// 1% protocol fee -> fee pool (rounds up).
    pub protocol_fee: u64,
    /// The originating client's facilitator address, if any.
    pub facilitator: Option<PublicKey>,
    /// Payer-authorized facilitator fee, 0-5% (rounds down).
    pub facilitator_fee: u64,
    /// amount - protocol_fee - facilitator_fee; paid or escrowed.
    pub recipient_amount: u64,
}

/// One genesis entitlement, committed under the genesis Merkle root (03 §A).
#[derive(Clone, Serialize, Deserialize)]
pub struct GenesisLeaf {
    /// Cohort id (TREASURY_COHORT_ID for the treasury leaf).
    pub cohort: u8,
    /// The eligible external key.
    pub key: ForeignKey,
    /// Nominal entitlement in atomic Y (equal for every key in the cohort).
    pub entitlement: u64,
}

/// Per-account genesis state in the GenesisClaim contract (03 §A). A split
/// changes `nominal` only from `next_effective_epoch`, so a tranche is always
/// claimed on the nominal in force during its own epoch.
#[derive(Clone, Serialize, Deserialize)]
pub struct GenesisAccount {
    /// Nominal entitlement in force now.
    pub nominal: u64,
    /// Nominal after pending splits in and out; takes effect at `next_effective_epoch`.
    pub next_nominal: u64,
    pub next_effective_epoch: u64,
    /// Last epoch whose tranche was claimed (each tranche claims at most once).
    pub last_claimed_epoch: Option<u64>,
}

/// Per-account like-power state in the Like contract (03 §B).
#[derive(Clone, Serialize, Deserialize)]
pub struct PowerMeter {
    /// Stake that regenerates power.
    pub eligible_stake: u64,
    /// Stake awaiting withdrawal; regenerates nothing.
    pub pending_unstake: u64,
    /// Block time at which `pending_unstake` becomes withdrawable.
    pub unstake_available_at: u64,
    /// Power stored at `last_update` (<= power_cap(eligible_stake)).
    pub stored_power: u64,
    /// Block timestamp of the last accrual.
    pub last_update: u64,
    /// Next expected settlement nonce (replay protection).
    pub settle_nonce: u64,
}

/// An on-chain @handle record.
/// A handle is claimed (never purchased) and kept by paying per-epoch rent to the
/// fee pool; tokens are never destroyed. Short handles (len ≤ 6) are Harberger-
/// taxed on a self-assessed value; long handles (len ≥ 7) pay the base rent.
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
    /// Rent is paid through (and including) this epoch; at most
    /// MAX_PREPAID_EPOCHS past the current epoch (03 §D).
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
```

**Fee arithmetic convention (applies to every bps and rate calculation in these docs):**
every basis-point or rate multiplication uses `u128` intermediates, because at the
140B-Y scale `amount * bps` (and pool-balance or stake-time math) overflows `u64`.
Protocol **fees round up** — `fee = ((x as u128 * bps as u128 + 9_999) / 10_000) as u64` —
so no dust ever escapes fee-free; **payouts, drips, reservations and facilitator fees
round down**; a zero denominator yields zero.

### Validation Rules

**Tip:**
- `facilitator_fee` bps ≤ `MAX_FACILITATOR_FEE_BPS`, authorized by the tipper's signature
- `protocol_fee` must match the ceiling-division fee at `PROTOCOL_FEE_BPS`; `facilitator_fee` the round-down fee
- `protocol_fee + facilitator_fee <= amount` and `recipient_amount == amount - protocol_fee - facilitator_fee`
- `tipper` must have sufficient Y balance on-chain
- If `post` is set, an `Identity` recipient should be its author (checked by clients and indexers; the contract cannot see off-chain authorship)

**PowerMeter (settlement):**
- `nonce == settle_nonce`; `n_likes >= 1`; every allocation weight > 0; no allocation to the staker itself
- Power spent is computed by the contract from block time (03 §B); the sum allocated is debited

**GenesisLeaf (activation):**
- Merkle proof to the genesis root; signature by `key` naming the destination `IdentityId`; each leaf activates once

**NameRecord (claim):**
- `handle` must match `^[a-z0-9-]{1,32}$` (NFKC-normalized before matching)
- `handle` must not already be owned (claim only if unowned)
- Harberger tier (len ≤ 6): `assessed_value >= assessment_floor(len, base_rent)`; flat tier (len ≥ 7): `assessed_value` is ignored and stored as `0`
- The first epoch's rent is due at claim time
- `owner` must have sufficient Y balance on-chain (a client may fund it by a bundled transfer, 05)

## Epoch Types (`epoch.rs`)

Epochs are time-based: an epoch is `EPOCH_SECONDS` (604,800 s, one week) of L2 block time, derived by the contracts from `block.timestamp` and counted from the main deployment (epoch 0). Like power accrues continuously from block timestamps (03 §B). No caller-supplied timestamp sets priority or rate. Each epoch is closed lazily by the first transaction after its boundary: the close reserves that epoch's issuance budget and fee-pool share for pulled creator claims, and steps the handle base rent (03 §B, Fee Pool, §D).

```rust
/// Configuration constants (on-chain, set at contract deployment). Canonical values
/// and rationale live in 03; fields mirror them. Parameters are fixed at deployment;
/// changing them requires a new deployment and opt-in migration by users and
/// indexers (see 00, Parameter Immutability & Upgrades).
pub struct EpochConfig {
    /// Seconds of L2 block time per epoch. (tunable)
    pub epoch_seconds: u64,                  // EPOCH_SECONDS = 604_800 (one week)
    // --- Tips (03 §C) ---
    /// Protocol fee on tips, to the fee pool (basis points, rounds up). (tunable)
    pub protocol_fee_bps: u64,               // PROTOCOL_FEE_BPS = 100 (1%)
    /// Cap on the payer-authorized facilitator fee (basis points, rounds down). (tunable)
    pub max_facilitator_fee_bps: u64,        // MAX_FACILITATOR_FEE_BPS = 500 (5%)
    /// Seconds before an unclaimed foreign-key escrow refunds to the tipper. (tunable)
    pub tip_escrow_refund_seconds: u64,      // TIP_ESCROW_REFUND_SECONDS = 2_592_000 (30 days)
    // --- Like power & issuance (03 §B) ---
    /// Seconds of regeneration the power meter can hold. (tunable)
    pub power_cap_seconds: u64,              // POWER_CAP_SECONDS = 86_400 (24 h)
    /// Share of current power each like spends (basis points). (tunable)
    pub like_spend_bps: u64,                 // LIKE_SPEND_BPS = 200 (2%)
    /// Delay between an unstake request and withdrawal; regeneration stops at the request. (tunable)
    pub unstake_delay_seconds: u64,          // UNSTAKE_DELAY_SECONDS = 604_800 (7 days)
    // --- Fee pool ---
    /// Share of the fee pool balance dripped at each epoch close (basis points). (tunable)
    pub fee_pool_drip_bps: u64,              // FEE_POOL_DRIP_BPS = 200 (2%)
    // --- Genesis (03 §A) ---
    /// Epochs a genesis tranche stays claimable. (tunable)
    pub genesis_claim_window_epochs: u64,    // GENESIS_CLAIM_WINDOW_EPOCHS = 1
    // --- Names (03 §D) ---
    /// Harberger rent rate for short handles (basis points of `max(V, floor)` per epoch,
    /// e.g., 10 = 0.1%). (tunable)
    pub handle_rent_rate_bps: u64,
    /// Base rent at launch: the flat-tier rent and the unit of the Harberger floors (atomic Y). (tunable)
    pub launch_base_rent: u64,               // LAUNCH_BASE_RENT = 1_000_000 (1 Y)
    /// Clamp on the base rent (atomic Y). MAX keeps 1_000_000 × base within u64.
    pub min_base_rent: u64,                  // MIN_BASE_RENT = 1_000
    pub max_base_rent: u64,                  // MAX_BASE_RENT = u64::MAX / 1_000_000
    /// Per-epoch base-rent step toward the claim target (basis points). (tunable)
    pub base_rent_step_bps: u64,             // BASE_RENT_STEP_BPS = 1_250 (12.5%)
    /// New flat-tier claims per epoch the base rent targets.
    pub target_flat_claims_per_epoch: u64,   // TARGET_FLAT_CLAIMS_PER_EPOCH = TBD
    /// Maximum epochs of rent paid ahead of the current epoch. (tunable)
    pub max_prepaid_epochs: u64,             // MAX_PREPAID_EPOCHS = 26
    /// Force-buy notice window: epochs the owner has to cancel before transfer. (tunable)
    pub notice_window_epochs: u64,
    /// Epochs over which an assessment decrease (and retroactive rent) is applied. (tunable)
    pub lookback_epochs: u64,
    /// Grace epochs after nonpayment before a handle lapses to unowned. (tunable)
    pub grace_epochs: u64,
    /// Non-refundable force-buy fee, to the fee pool (basis points of the bid,
    /// e.g., 100 = 1%). (tunable)
    pub force_buy_fee_bps: u64,
    /// To cancel a force-buy, the owner must raise V to at least (100% + this) of the bid
    /// (basis points, e.g., 1000 = raise to ≥ 110% of the bid). (tunable)
    pub raise_premium_bps: u64,
    // --- Identity ---
    /// Veto window (in epochs) after guardian recovery reaches threshold, during
    /// which the current key can cancel the recovery. (tunable)
    pub recovery_veto_epochs: u64,           // RECOVERY_VETO_EPOCHS = 2
}

/// Y supply schedule — fixed at contract deployment (03 §A, §B). Genesis and
/// like-power issuance are the only mint paths; together they never exceed
/// `total_supply`, and missed tranches or dust never reopen capacity.
pub struct SupplySchedule {
    /// Hard cap on genesis + issuance (atomic units): 140B Y (6 decimals, fits u64).
    pub total_supply: u64,                  // 140_000_000_000_000_000
    /// total_supply × GENESIS_SHARE_BPS / 10_000.
    pub genesis_total: u64,                 // GENESIS_SHARE_BPS = TBD
    /// total_supply − genesis_total: the most like-power issuance can ever mint.
    pub issuance_capacity: u64,
    /// k at epoch 0, in parts per billion: atomic Y minted per power unit spent × 1e9
    /// (5_000_000 = 0.5%; a power unit = 1 atomic Y staked for 1 epoch). (tunable)
    pub initial_mint_rate_ppb: u64,         // INITIAL_MINT_RATE_PPB = 5_000_000 (k×r = 0.5%/epoch)
    /// Epochs between halvings of k. (tunable)
    pub mint_halving_epochs: u64,           // MINT_HALVING_EPOCHS = 104
    /// Epochs between halvings of genesis tranches. (tunable)
    pub genesis_vest_halving_epochs: u64,   // GENESIS_VEST_HALVING_EPOCHS = 104
    /// Merkle root of GenesisLeaf hashes, published with the dataset, rules and
    /// concentration analysis before deployment.
    pub genesis_root: [u8; 32],
}
```

### Supply Calculation

```rust
impl SupplySchedule {
    /// k for an epoch, in ppb; halves every `mint_halving_epochs`.
    /// Mirrored in the Like contract (03 §B `mint_rate_ppb`).
    pub fn mint_rate_ppb(&self, epoch: u64) -> u64 {
        let halvings = epoch / self.mint_halving_epochs;
        if halvings >= 64 { return 0; } // shift-width safety only; already 0 from halving 23
        self.initial_mint_rate_ppb >> halvings
    }

    /// Tranche that nominal genesis entitlement `entitlement` vests in `epoch`.
    /// Mirrored in the GenesisClaim contract (03 §A `genesis_tranche`).
    pub fn genesis_tranche(&self, entitlement: u64, epoch: u64) -> u64 {
        let window = epoch / self.genesis_vest_halving_epochs;
        if window >= 64 { return 0; }
        (entitlement / (2 * self.genesis_vest_halving_epochs)) >> window
    }
}
```

**Genesis:** there is no deployer-chosen account set. The genesis allocation is a snapshot Merkle root over eligible external keys, claimed in weekly tranches from epoch 0 (03 §A).

**Per-epoch issuance:** creators receive, per closed epoch, `mint_budget_e × received / spent_e` of new Y plus `drip_e × received / max(S_e, spent_e)` of recycled fees. Both are reserved at the epoch's close and pulled by the creator (03 §B, Fee Pool).

## Chain Events (`chain_events.rs`)

Events emitted by the smart contracts, consumed by the off-chain indexer. These represent the canonical on-chain state transitions.

```rust
/// Events emitted by smart contracts, consumed by the indexer.
/// This enum is CANONICAL: the indexer's listener (07) mirrors these variant names
/// and payload fields exactly.
#[derive(Clone, Serialize, Deserialize)]
pub enum ChainEvent {
    /// A Y token transfer between two accounts.
    Transfer {
        from: PublicKey,
        to: PublicKey,
        amount: u64,
    },
    // --- Tips (03 §C) ---
    /// A tip paid to a DSN identity; `protocol_fee` → fee pool, `facilitator_fee`
    /// → `facilitator`, the rest → `recipient`.
    Tip {
        tipper: PublicKey,
        recipient: IdentityId,
        post_hash: Option<ContentAddress>,
        amount: u64,                     // gross
        protocol_fee: u64,
        facilitator: Option<PublicKey>,
        facilitator_fee: u64,
    },
    /// A tip to a foreign key; fees are taken now and the net amount is escrowed.
    TipEscrowed {
        escrow_id: u64,
        tipper: PublicKey,
        recipient_key: ForeignKey,
        post_hash: Option<ContentAddress>,
        amount: u64,                     // gross
        protocol_fee: u64,
        facilitator: Option<PublicKey>,
        facilitator_fee: u64,
        escrowed: u64,                   // net = amount − fees
        refund_after: u64,               // block timestamp
    },
    /// The foreign key's owner claimed the escrow into a DSN identity.
    TipEscrowClaimed {
        escrow_id: u64,
        destination: IdentityId,
        amount: u64,                     // net
    },
    /// An unclaimed escrow refunded to the tipper after `refund_after`.
    TipEscrowRefunded {
        escrow_id: u64,
        tipper: PublicKey,
        amount: u64,                     // net
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
    /// Handle rent paid into the fee pool (`amount` goes to the pool in full).
    NameRentPaid {
        handle: String,
        payer: PublicKey,
        amount: u64,
        paid_through_epoch: u64,
    },
    /// A force-buy bid opened on a Harberger-tier handle (bid escrowed; 1% fee → fee pool).
    ForceBuyInitiated {
        handle: String,
        bidder: PublicKey,
        bid: u64,
        deadline_epoch: u64,
        fee_to_pool: u64,
    },
    /// A handle changed owner (claim after a lapse, or a completed force-buy;
    /// any floor excess flows to the fee pool).
    NameTransferred {
        handle: String,
        from: PublicKey,
        to: PublicKey,
    },
    /// A handle lapsed to unowned after the grace period without rent.
    NameLapsed {
        handle: String,
        prior_owner: PublicKey,
        epoch: u64,
    },
    // --- Like power & issuance (03 §B) ---
    /// Y staked into the Like contract (adds regeneration, never stored power).
    Staked {
        staker: IdentityId,
        amount: u64,
    },
    /// Stake moved to pending withdrawal; regeneration on it stops now.
    UnstakeRequested {
        staker: IdentityId,
        amount: u64,
        available_at: u64,               // block timestamp
    },
    /// Pending stake withdrawn after the delay.
    Unstaked {
        staker: IdentityId,
        amount: u64,
    },
    /// A batched like settlement. `power_spent` = Σ allocations (dust stays in the meter).
    LikesSettled {
        staker: IdentityId,
        nonce: u64,
        epoch: u64,
        n_likes: u32,
        power_spent: u64,
        allocations: Vec<(IdentityId, u64)>, // (recipient, power received)
    },
    /// A creator pulled its reward for one closed epoch.
    CreatorRewardsClaimed {
        creator: IdentityId,
        epoch: u64,
        minted: u64,                     // new Y, counted against issuance capacity
        fee_reward: u64,                 // recycled Y from the fee-pool reserve
    },
    /// The epoch counter advanced, closing `epoch − 1`: its issuance budget and
    /// fee-pool share are reserved for pulled claims, and the base rent steps.
    /// `closed_fee_reserved = closed_fee_drip × spent / max(stake_time, spent)`.
    EpochAdvanced {
        epoch: u64,                      // the new epoch
        closed_power_spent: u64,
        closed_stake_time: u64,
        closed_mint_budget: u64,
        closed_fee_drip: u64,
        closed_fee_reserved: u64,
        fee_pool_balance: u64,           // after the reservation
        mint_rate_ppb: u64,              // k for the new epoch
        base_rent: u64,                  // base rent for the new epoch
    },
    // --- Genesis (03 §A) ---
    /// A genesis leaf activated into a DSN identity.
    GenesisActivated {
        key: ForeignKey,
        cohort: u8,
        account: IdentityId,
        entitlement: u64,                // nominal
    },
    /// One epoch's genesis tranche claimed.
    GenesisTrancheClaimed {
        account: IdentityId,
        epoch: u64,
        amount: u64,
    },
    /// Nominal entitlement moved to another account (future tranches only).
    EntitlementSplit {
        from: IdentityId,
        to: IdentityId,
        amount: u64,
        effective_epoch: u64,            // current epoch + 1
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

// Epoch and recovery constants (tunable). Economic constants are canonical in 03
// and mirrored in EpochConfig / SupplySchedule above.
pub const EPOCH_SECONDS: u64 = 604_800;         // one week of L2 block time
pub const RECOVERY_VETO_EPOCHS: u64 = 2;        // guardian-recovery veto window
```
