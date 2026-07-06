# Core Types & Crypto Primitives (`dsn-core`)

## Module Structure

```
crates/core/src/
├── lib.rs              # Re-exports all public types
├── identity.rs         # BLS key wrappers, user identity, identity registry types
├── post.rs             # Post, reply, thread types
├── profile.rs          # User profile
├── social.rs           # Follow list, feed index
├── token.rs            # Tip, Promotion, NameRegistration/Renewal (on-chain types)
├── epoch.rs            # Block-based epoch definitions, rebate drop schedule
├── chain_events.rs     # ChainEvent enum (smart contract events)
├── crypto.rs           # Hashing, signing helpers
├── address.rs          # Content addresses, key addresses
└── error.rs            # Shared error types
```

## Identity Types (`identity.rs`)

### Design Decisions

- We wrap raw byte arrays rather than depending on the `autonomi` crate's BLS types
- This keeps dsn-core dependency-free from Autonomi, enabling pure simulation
- When integrating with real Autonomi, the data layer converts between our types and Autonomi's

```rust
/// A BLS public key (48 bytes, compressed G1 point).
/// This is the user's identity on the network.
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PublicKey(pub [u8; 48]);

/// A BLS secret key (32 bytes, scalar field element).
/// Never serialized to network storage — only held locally.
pub struct SecretKey(pub [u8; 32]);

/// A BLS signature (96 bytes, compressed G2 point).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signature(pub [u8; 96]);

/// A user identity combining key material with a human-readable handle.
/// The display_name is purely cosmetic. The PublicKey is the only canonical identity.
/// An optional `registered_name` can be claimed on-chain via NameRegistration
/// (unique, verified, costs Y to register and renew annually). The registered
/// name resolves to the *identity* (see Identity Registry Types below), not the
/// raw key, so key rotation does not orphan names.
#[derive(Clone, Serialize, Deserialize)]
pub struct UserIdentity {
    pub public_key: PublicKey,
    pub display_name: String,           // max 64 chars, cosmetic
    pub bio: String,                    // max 256 chars
    pub registered_name: Option<String>, // on-chain unique name, if registered
}
```

### Key Operations

```rust
impl SecretKey {
    /// Generate a new random secret key.
    pub fn generate() -> Self;

    /// Derive the corresponding public key.
    pub fn public_key(&self) -> PublicKey;

    /// Sign arbitrary bytes.
    pub fn sign(&self, message: &[u8]) -> Signature;

    /// Derive a child key for a specific purpose (e.g., "feed", "profile").
    /// Uses HKDF or similar KDF.
    pub fn derive_child(&self, purpose: &[u8]) -> SecretKey;

    /// Export as hex string (for local storage only).
    pub fn to_hex(&self) -> String;

    /// Import from hex string.
    pub fn from_hex(hex: &str) -> Result<Self, CryptoError>;
}

impl PublicKey {
    /// Verify a signature against a message.
    pub fn verify(&self, signature: &Signature, message: &[u8]) -> bool;

    /// Compute a deterministic address from this public key.
    /// Used as the Scratchpad address on Autonomi.
    pub fn to_address(&self) -> ContentAddress;

    /// Display as shortened hex (first 8 chars) for UX.
    pub fn short_hex(&self) -> String;
}
```

### BLS Simulation

For development and simulation, we use a simplified BLS:

- `SecretKey::generate()` fills 32 random bytes
- `public_key()` hashes the secret key with BLAKE3 and pads to 48 bytes
- `sign()` hashes `(secret_key || message)` and pads to 96 bytes
- `verify()` recomputes the expected signature from the public key

This is NOT cryptographically secure — it's structurally correct for testing protocol logic. When integrating with Autonomi, these types will convert to/from real BLS types via the data layer.

## Identity Registry Types (`identity.rs`)

One key = total loss is not acceptable for ordinary humans (doc 09 §2.6). The on-chain `IdentityRegistry` contract (doc 00 contract list) gives every account a **stable identity id** — the genesis public key — that can be re-pointed to a new key:

- **Rotation**: `rotate(new_key)`, signed by the *current* key, re-points the identity to `new_key`.
- **Social recovery (opt-in)**: M-of-N guardians can initiate a recovery rotation if the current key is lost. A veto window (`RECOVERY_VETO_EPOCHS`) follows, during which the current key can cancel — so a compromised guardian set cannot silently steal an identity whose owner still holds the key.
- **Signature semantics**: content signatures verify against the key that was *current at write time* — the chain records the block of every rotation, so any verifier can determine which key was valid when. Indexers resolve identity → current key for display and addressing.

```rust
/// Epochs during which the current key can cancel a pending guardian recovery.
pub const RECOVERY_VETO_EPOCHS: u64 = 2;

/// A key rotation record (on-chain).
/// Re-points a stable identity to a new key. Signed by the current key
/// (or executed by the IdentityRegistry after an unvetoed guardian recovery).
#[derive(Clone, Serialize, Deserialize)]
pub struct KeyRotation {
    /// The stable identity id (the genesis public key).
    pub identity: PublicKey,
    /// The key being rotated away from (must be the current key).
    pub old_key: PublicKey,
    /// The new current key.
    pub new_key: PublicKey,
    /// Signature by `old_key` over the fields above.
    pub signature: Signature,
}

/// Opt-in M-of-N social recovery configuration (on-chain).
/// `threshold` of `guardians` can initiate a recovery rotation; the current
/// key can veto within RECOVERY_VETO_EPOCHS. The invitation tree provides
/// natural guardian candidates (doc 09 §2.6).
#[derive(Clone, Serialize, Deserialize)]
pub struct RecoveryConfig {
    pub guardians: Vec<PublicKey>,
    pub threshold: u8,
}
```

## Address Types (`address.rs`)

```rust
/// Content-addressed location (32 bytes, like Autonomi's XorName).
/// Used for immutable data (Chunks on IPFS/Autonomi).
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ContentAddress(pub [u8; 32]);

/// Key-addressed location (derived from a PublicKey).
/// Used for mutable data (Scratchpads, Pointers, GraphEntries).
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
/// Stored as an immutable Chunk on IPFS/Autonomi (off-chain content storage).
#[derive(Clone, Serialize, Deserialize)]
pub struct Post {
    /// Author's public key.
    pub author: PublicKey,

    /// Post content (plaintext, max 4000 chars).
    pub content: String,

    /// Optional: address of parent post (makes this a reply).
    pub reply_to: Option<ContentAddress>,

    /// Monotonic counter per author (prevents replay).
    pub sequence: u64,

    /// Timestamp (informational, not trusted for protocol logic).
    pub created_at: chrono::DateTime<chrono::Utc>,

    /// BLS signature over all fields above.
    pub signature: Signature,
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
        content: String,
        reply_to: Option<ContentAddress>,
        sequence: u64,
    ) -> Self;

    /// Verify the post's signature.
    pub fn verify(&self) -> bool;

    /// Compute the content address (hash of serialized post).
    pub fn content_address(&self) -> ContentAddress;

    /// The bytes that are signed (all fields except signature).
    pub fn signable_bytes(&self) -> Vec<u8>;
}
```

### Validation Rules

- `content.len() <= 4000` (characters, not bytes)
- `author` must match the signing key
- `signature` must verify against `author` and `signable_bytes()`
- `sequence` must be strictly greater than the author's last known sequence
- `reply_to`, if present, must reference an existing post

Posting carries no protocol fee — costs sit on amplification and scarce namespace, never on existence (doc 10 §1.2).

## Profile Types (`profile.rs`)

```rust
/// User profile stored in a Scratchpad (off-chain, mutable).
/// User can update freely.
#[derive(Clone, Serialize, Deserialize)]
pub struct UserProfile {
    /// The owner's public key (also the Scratchpad address).
    pub owner: PublicKey,

    /// Human-readable display name (max 64 chars).
    pub display_name: String,

    /// Short bio (max 256 chars).
    pub bio: String,

    /// Content address of avatar image Chunk (optional).
    pub avatar: Option<ContentAddress>,

    /// Monotonic version counter.
    pub version: u64,

    /// Signature over all fields above.
    pub signature: Signature,
}
```

## Social Types (`social.rs`)

```rust
/// A user's follow list, stored in a Scratchpad (off-chain).
#[derive(Clone, Serialize, Deserialize)]
pub struct FollowList {
    pub owner: PublicKey,
    pub following: Vec<PublicKey>,
    pub version: u64,
    pub signature: Signature,
}

/// A user's feed index, stored in a Scratchpad (off-chain).
/// Maps to the last N posts by this user (rolling window).
#[derive(Clone, Serialize, Deserialize)]
pub struct FeedIndex {
    pub owner: PublicKey,
    /// Ordered list of post addresses, newest first.
    /// 4MB Scratchpad ≈ 125K entries.
    pub posts: Vec<ContentAddress>,
    pub version: u64,
    pub signature: Signature,
}
```

## Token Types (`token.rs`)

All token operations happen on-chain via smart contracts. These types represent the on-chain data structures that the smart contract manages. Token Y is the sole token — there is no separate reputation token.

```rust
/// A tip to a post's creator (on-chain).
/// Tips transfer existing Y from sender to creator with a small flat burn.
/// Nothing is minted against tips (doc 10 §1.1).
#[derive(Clone, Serialize, Deserialize)]
pub struct Tip {
    /// The user sending the tip. May be a one-time derived key for privacy
    /// (doc 09 §2.7).
    pub sender: PublicKey,
    /// 32-byte memo: content address of the post being rewarded, so indexers
    /// can attribute tips to content.
    pub post_ref: ContentAddress,
    /// The creator who receives the tip.
    pub creator: PublicKey,
    /// Total amount of Y tipped.
    pub amount: u64,
    /// Fraction burned (1%, TIP_BURN_RATE_BPS).
    pub burn_amount: u64,
    /// Remainder transferred to the creator.
    pub creator_amount: u64,
}

/// A promotion burn on a post (on-chain).
/// Pay-to-amplify: the amount is a protocol fee routed through the referral
/// split — ≥90% burned, with no return path. An advertising cost, not an
/// investment (replaces bonding, doc 09 §2.3).
#[derive(Clone, Serialize, Deserialize)]
pub struct Promotion {
    /// The user paying to promote the post.
    pub promoter: PublicKey,
    /// Content hash of the post being promoted.
    pub post_hash: ContentAddress,
    /// Amount of Y paid (fee-split, then burned).
    pub amount: u64,
}

/// A name registration (on-chain).
/// Pays Y (via the fee split) to claim a unique human-readable name for one
/// term. Names lapse past a grace period and recycle (doc 03 §D).
#[derive(Clone, Serialize, Deserialize)]
pub struct NameRegistration {
    /// The user claiming the name.
    pub owner: PublicKey,
    /// The registered name (lowercase alphanumeric + hyphens, 1-32 chars).
    pub name: String,
    /// Amount of Y paid to register this name.
    pub burn_cost: u64,
    /// The epoch through which this registration is paid
    /// (registration epoch + NAME_TERM_EPOCHS).
    pub paid_through_epoch: u64,
}

/// A name renewal (on-chain).
/// Pays the tier price to extend a name's exclusivity by one term.
#[derive(Clone, Serialize, Deserialize)]
pub struct NameRenewal {
    /// The current owner of the name.
    pub owner: PublicKey,
    /// The name being renewed.
    pub name: String,
    /// Amount of Y paid (the tier price, doc 03 §D).
    pub cost: u64,
    /// The new paid-through epoch (previous paid_through + NAME_TERM_EPOCHS).
    pub new_paid_through_epoch: u64,
}

/// An invitation record (on-chain).
/// The registry records who vouched for whom; `invited_at_epoch` anchors the
/// referral term (doc 05).
#[derive(Clone, Serialize, Deserialize)]
pub struct OnChainInvitation {
    /// The user issuing the invitation.
    pub inviter: PublicKey,
    /// The user being invited.
    pub invitee: PublicKey,
    /// Y fee paid to issue this invitation (routed through the fee split).
    pub y_fee: u64,
    /// The epoch in which the invitation was recorded.
    pub invited_at_epoch: u64,
}
```

### Validation Rules

**Tip:**
- `amount > 0`
- `burn_amount + creator_amount == amount`
- `burn_amount` must match `amount * TIP_BURN_RATE_BPS / 10_000` (1%, doc 03 §B)
- `sender` must have sufficient Y balance on-chain
- `post_ref` is an informational memo; indexers attribute tips to content by it

**Promotion:**
- `amount` must meet the configured minimum promotion (doc 03 §C)
- `promoter` must have sufficient Y balance on-chain
- The full amount is fee-split (≥90% burned); nothing is returned

**NameRegistration:**
- `name` must match `^[a-z0-9-]{1,32}$`
- `name` must not be registered, or its previous registration must be expired
  (past `paid_through_epoch + NAME_GRACE_PERIOD_EPOCHS`, doc 03 §D)
- `burn_cost` must match the tier price for the name's length
- `paid_through_epoch == registration_epoch + NAME_TERM_EPOCHS`
- `owner` must have sufficient Y balance on-chain

**NameRenewal:**
- `name` must be registered to `owner` and within its term or grace period
- `cost` must match the tier price for the name's length
- `new_paid_through_epoch == paid_through_epoch + NAME_TERM_EPOCHS`
- `owner` must have sufficient Y balance on-chain

**OnChainInvitation:**
- `inviter` must be an existing invited user (or genesis)
- `invitee` must not already be invited
- `y_fee` must match `EpochConfig::invitation_cost_y`
- `invited_at_epoch` must be the current epoch at inclusion

## Epoch Types (`epoch.rs`)

Epochs are block-based: the smart contract advances the epoch after a fixed number of blocks. The usage rebate drop is distributed on-chain at epoch boundaries, **pro-rata to eligible protocol fees burned that epoch** (doc 03 §E) — not to creators by any social metric.

```rust
/// Configuration constants for epoch mechanics (on-chain, set at contract deployment).
/// Changes only through governance or contract migration.
pub struct EpochConfig {
    /// Number of blockchain blocks per epoch.
    pub epoch_duration_blocks: u64,
    /// Burn rate for tips (basis points, 100 = 1%, doc 03 §B).
    pub tip_burn_rate_bps: u64,
    /// Share of protocol fees paid to the payer's direct inviter (basis points, 1000 = 10%).
    pub referral_share_bps: u64,
    /// Epochs during which an invitee's fees pay their inviter (208 ≈ 4 years).
    pub referral_term_epochs: u64,
    /// Y cost to issue an invitation.
    pub invitation_cost_y: u64,
    /// Y bond required to participate in moderation (10 Y, doc 06).
    pub moderation_bond_y: u64,
}

/// Usage rebate drop schedule — fixed at contract deployment, halving-based.
/// Enforced on-chain by the RebatePool contract (doc 11 §1.1).
pub struct RebateSchedule {
    /// Total Y in the usage rebate pool (in atomic units).
    pub total_pool: u64,                 // 6_300_000 * 10^6 (30% of supply, doc 10 §3.2)
    /// Y dropped per epoch (before any halving).
    pub initial_drop_per_epoch: u64,     // 30_000 * 10^6
    /// Number of epochs between halvings (~2 years).
    pub halving_interval: u64,           // 104
}
```

### Rebate Drop Calculation

```rust
impl RebateSchedule {
    /// Compute the rebate drop for a given epoch number.
    /// This logic is mirrored in dsn-token-y and the smart contract (doc 03 §A).
    pub fn rebate_drop_for_epoch(&self, epoch: u64) -> u64 {
        let halvings = epoch / self.halving_interval;
        // After ~20 halvings, the drop is effectively zero
        if halvings >= 20 { return 0; }
        self.initial_drop_per_epoch >> halvings
    }

    /// Compute total Y dropped up to (not including) a given epoch.
    pub fn total_dropped_before_epoch(&self, epoch: u64) -> u64;
}
```

## Chain Events (`chain_events.rs`)

Events emitted by the smart contracts, consumed by the off-chain indexer. These represent the canonical on-chain state transitions.

```rust
/// Events emitted by smart contracts, consumed by the indexer.
#[derive(Clone, Serialize, Deserialize)]
pub enum ChainEvent {
    /// A Y token transfer between two accounts.
    Transfer {
        from: PublicKey,
        to: PublicKey,
        amount: u64,
    },
    /// A promotion burn on a post (pay-to-amplify).
    Promotion {
        promoter: PublicKey,
        post_hash: ContentAddress,
        amount: u64,
    },
    /// A tip sent to a post's creator (transfer + flat burn).
    Tip {
        sender: PublicKey,
        post_ref: ContentAddress,
        creator: PublicKey,
        amount: u64,
        burn: u64,
    },
    /// A unique name registered on-chain.
    NameRegistered {
        owner: PublicKey,
        name: String,
        cost: u64,
        paid_through_epoch: u64,
    },
    /// A name renewed for another term.
    NameRenewed {
        owner: PublicKey,
        name: String,
        cost: u64,
        new_paid_through_epoch: u64,
    },
    /// A name lapsed past its grace period and became registrable again.
    NameExpired {
        name: String,
    },
    /// An invitation issued on-chain.
    Invitation {
        inviter: PublicKey,
        invitee: PublicKey,
        fee: u64,
        epoch: u64,
    },
    /// A referral cut paid to an inviter from a direct invitee's protocol fee.
    ReferralPaid {
        inviter: PublicKey,
        invitee: PublicKey,
        amount: u64,
    },
    /// The epoch counter advanced.
    EpochAdvanced {
        epoch: u64,
        drop: u64,
    },
    /// Usage rebate distributed to an account for an epoch
    /// (pro-rata to eligible fees burned, doc 03 §E).
    RebateDistributed {
        epoch: u64,
        account: PublicKey,
        amount: u64,
    },
    /// An identity re-pointed to a new key (IdentityRegistry).
    KeyRotated {
        identity: PublicKey,
        old_key: PublicKey,
        new_key: PublicKey,
    },
    /// A service (indexer) registered with a stake (doc 11).
    ServiceRegistered {
        service_key: PublicKey,
        stake: u64,
    },
    /// A service slashed on a verified fraud proof (doc 11 §3.4).
    ServiceSlashed {
        service_key: PublicKey,
        burned: u64,
        bounty: u64,
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
| Off-chain content storage (IPFS/Autonomi Chunks) | `bincode` | Compact, fast, deterministic |
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
pub const MAX_REGISTERED_NAME_CHARS: usize = 32;
pub const MAX_SCRATCHPAD_SIZE: usize = 4 * 1024 * 1024; // 4MB (off-chain storage limit)
pub const PUBLIC_KEY_SIZE: usize = 48;
pub const SECRET_KEY_SIZE: usize = 32;
pub const SIGNATURE_SIZE: usize = 96;
pub const CONTENT_ADDRESS_SIZE: usize = 32;
```
