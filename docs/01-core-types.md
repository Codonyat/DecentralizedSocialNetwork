# Core Types & Crypto Primitives (`dsn-core`)

## Module Structure

```
crates/core/src/
├── lib.rs              # Re-exports all public types
├── identity.rs         # BLS key wrappers, user identity
├── post.rs             # Post, reply, thread types
├── profile.rs          # User profile
├── social.rs           # Follow, like, curation stake types
├── token.rs            # Y balance, R balance, transfer types
├── epoch.rs            # Event-based epoch definitions
├── crypto.rs           # Hashing, signing helpers
├── address.rs          # Content addresses, Scratchpad addresses
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
/// The handle is NOT unique or verified — it's purely cosmetic.
/// The PublicKey is the only canonical identity.
#[derive(Clone, Serialize, Deserialize)]
pub struct UserIdentity {
    pub public_key: PublicKey,
    pub display_name: String,   // max 64 chars
    pub bio: String,            // max 256 chars
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

    /// Derive a child key for a specific purpose (e.g., "y-balance", "curation").
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

## Address Types (`address.rs`)

```rust
/// Content-addressed location (32 bytes, like Autonomi's XorName).
/// Used for immutable data (Chunks).
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
/// Stored as an immutable Chunk on Autonomi.
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

## Profile Types (`profile.rs`)

```rust
/// User profile stored in a Scratchpad.
/// Mutable — user can update freely.
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
/// A user's follow list, stored in a Scratchpad.
#[derive(Clone, Serialize, Deserialize)]
pub struct FollowList {
    pub owner: PublicKey,
    pub following: Vec<PublicKey>,
    pub version: u64,
    pub signature: Signature,
}

/// A user's feed index, stored in a Scratchpad.
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

/// A user's like list, stored in a Scratchpad.
#[derive(Clone, Serialize, Deserialize)]
pub struct LikeList {
    pub owner: PublicKey,
    pub likes: Vec<LikeEntry>,
    pub version: u64,
    pub signature: Signature,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct LikeEntry {
    pub post_address: ContentAddress,
    pub liked_at_sequence: u64, // author's like sequence counter
}

/// A curation stake record (user stakes R on a post).
/// Stored in user's curation Scratchpad.
#[derive(Clone, Serialize, Deserialize)]
pub struct CurationStake {
    /// The post being curated.
    pub post_address: ContentAddress,
    /// Amount of R staked.
    pub r_staked: u64,
    /// Optional: amount of Y staked alongside R (amplifier).
    pub y_staked: u64,
    /// Epoch number when stake was placed.
    pub staked_at_epoch: u64,
    /// Author's curation sequence counter.
    pub sequence: u64,
}

/// A user's full curation record, stored in a Scratchpad.
#[derive(Clone, Serialize, Deserialize)]
pub struct CurationRecord {
    pub owner: PublicKey,
    pub stakes: Vec<CurationStake>,
    pub version: u64,
    pub signature: Signature,
}
```

## Token Types (`token.rs`)

```rust
/// Token Y balance stored in a Scratchpad (plaintext mode for public verifiability).
#[derive(Clone, Serialize, Deserialize)]
pub struct YBalance {
    pub owner: PublicKey,
    /// Current balance in atomic units (no decimals, u64).
    pub balance: u64,
    /// Monotonic transaction counter (nonce). Incremented on every debit or credit.
    pub nonce: u64,
    /// Hash of the previous state (chain for tamper detection).
    pub prev_hash: ContentAddress,
    /// The most recent transaction that changed this balance.
    pub last_tx: Option<YTransaction>,
    /// Signature over all fields above.
    pub signature: Signature,
}

/// An immutable record of a Y state transition.
/// Stored as a Chunk on Autonomi (permanent, content-addressed).
/// Forms a linked list: each receipt points to the previous one.
#[derive(Clone, Serialize, Deserialize)]
pub struct YReceipt {
    /// The full YBalance state AFTER this transition.
    pub state: YBalance,
    /// Content address of the previous receipt (linked list).
    /// None for the genesis receipt (nonce 0).
    pub prev_receipt: Option<ContentAddress>,
}

/// What gets written to the Y Balance Scratchpad.
/// Wraps the signed balance with a pointer to the latest receipt Chunk.
#[derive(Clone, Serialize, Deserialize)]
pub struct YScratchpadPayload {
    /// The signed Y balance (unchanged from current design).
    pub balance: YBalance,
    /// Content address of the latest receipt Chunk for this balance.
    /// Not covered by YBalance.signature — it's metadata for discoverability.
    pub latest_receipt: ContentAddress,
}

/// A single Y transaction (embedded in YBalance updates).
#[derive(Clone, Serialize, Deserialize)]
pub enum YTransaction {
    /// Claim Y from epoch emission.
    Claim {
        epoch: u64,
        amount: u64,
        /// Hash of the computation proving correctness.
        proof_hash: ContentAddress,
    },
    /// Debit: send Y to another user.
    Debit {
        recipient: PublicKey,
        amount: u64,
    },
    /// Credit: receive Y from another user.
    Credit {
        sender: PublicKey,
        amount: u64,
        /// Reference to sender's debit nonce.
        sender_debit_nonce: u64,
        /// Content address of the sender's debit receipt.
        /// Pins this credit to a specific, unambiguous debit state.
        sender_debit_receipt: ContentAddress,
    },
    /// Burn: spend Y on boosting (deflationary).
    Burn {
        amount: u64,
        purpose: BurnPurpose,
    },
    /// Reclaim: recover Y from expired pending transfer.
    Reclaim {
        original_debit_nonce: u64,
        amount: u64,
        /// Content address of the original debit receipt being reclaimed.
        original_debit_receipt: ContentAddress,
    },
}

#[derive(Clone, Serialize, Deserialize)]
pub enum BurnPurpose {
    PostBoost { post_address: ContentAddress },
}

/// Token R balance (soulbound reputation).
/// Deterministically computable from public data — self-claimed, watcher-verified.
#[derive(Clone, Serialize, Deserialize)]
pub struct RBalance {
    pub owner: PublicKey,
    /// Current R balance.
    pub balance: u64,
    /// Epoch at which this R was last computed.
    pub computed_at_epoch: u64,
    /// Hash of the computation inputs (for verification).
    pub computation_hash: ContentAddress,
    /// Signature.
    pub signature: Signature,
}
```

## Epoch Types (`epoch.rs`)

```rust
/// An epoch boundary marker, stored as an immutable Chunk on Autonomi.
#[derive(Clone, Serialize, Deserialize)]
pub struct EpochBoundary {
    /// Epoch number (0-indexed).
    pub epoch: u64,
    /// Total curations since previous epoch boundary.
    pub curation_count: u64,
    /// Merkle root of all curation GraphEntries in this epoch.
    pub curation_merkle_root: ContentAddress,
    /// Address of the previous epoch boundary Chunk (forms a chain).
    pub previous_epoch: Option<ContentAddress>,
    /// Total R earned across all users this epoch.
    pub total_r_earned: u64,
    /// Y emission for this epoch (from the halving schedule).
    pub y_emission: u64,
    /// Publisher's public key + signature (anyone can publish, first valid wins).
    pub publisher: PublicKey,
    pub signature: Signature,
}

/// Configuration constants for epoch mechanics.
/// These are FIXED at launch — changes only through voluntary software forks.
pub struct EpochConfig {
    /// Number of curations per epoch.
    pub curations_per_epoch: u64,           // e.g., 10_000
    /// Cooling period in epochs (for curation evaluation).
    pub cooling_period_epochs: u64,         // e.g., 2
    /// R decay rate per epoch (basis points, e.g., 1000 = 10%).
    pub r_decay_bps: u64,                   // e.g., 1000
    /// Confirmation window for Y transfers (in network Scratchpad writes).
    pub y_confirmation_window: u64,         // e.g., 5_000
    /// Transfer expiry in epochs.
    pub transfer_expiry_epochs: u64,        // e.g., 5
    /// Maximum R any single user can hold.
    pub r_cap: u64,                         // e.g., 1_000
}

/// Y emission schedule — fixed at launch, halving-based.
pub struct EmissionSchedule {
    /// Total supply of Y (in atomic units).
    pub total_supply: u64,                  // e.g., 21_000_000 * 10^6
    /// Y emitted per epoch (before any halving).
    pub initial_emission_per_epoch: u64,    // e.g., 10_000
    /// Number of epochs between halvings.
    pub halving_interval: u64,              // e.g., 52
}
```

### Emission Calculation

```rust
impl EmissionSchedule {
    /// Compute Y emission for a given epoch number.
    pub fn emission_for_epoch(&self, epoch: u64) -> u64 {
        let halvings = epoch / self.halving_interval;
        // After ~20 halvings, emission is effectively zero
        if halvings >= 20 { return 0; }
        self.initial_emission_per_epoch >> halvings
    }

    /// Compute total Y emitted up to (not including) a given epoch.
    pub fn total_emitted_before_epoch(&self, epoch: u64) -> u64;
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
}
```

## Serialization Strategy

| Context | Format | Why |
|---|---|---|
| Network storage (Chunks, Scratchpads) | `bincode` | Compact, fast, deterministic |
| Signature computation | `bincode` | Must be deterministic across all clients |
| Indexer API responses | `serde_json` | Human-readable, web-compatible |
| Local key storage | Hex strings | Easy to copy/paste, grep in files |
| Debug/logging | `Debug` derive | Automatic from Rust derives |

**Critical invariant**: All types that are signed MUST serialize deterministically. `bincode` with default config produces deterministic output for the same input. We define a `signable_bytes(&self) -> Vec<u8>` method on every signed type that produces the canonical byte representation.

## Constants

```rust
pub const MAX_POST_CONTENT_CHARS: usize = 4_000;
pub const MAX_DISPLAY_NAME_CHARS: usize = 64;
pub const MAX_BIO_CHARS: usize = 256;
pub const MAX_SCRATCHPAD_SIZE: usize = 4 * 1024 * 1024; // 4MB
pub const PUBLIC_KEY_SIZE: usize = 48;
pub const SECRET_KEY_SIZE: usize = 32;
pub const SIGNATURE_SIZE: usize = 96;
pub const CONTENT_ADDRESS_SIZE: usize = 32;
```
