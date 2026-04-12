# Core Types & Crypto Primitives (`dsn-core`)

## Module Structure

```
crates/core/src/
├── lib.rs              # Re-exports all public types
├── identity.rs         # BLS key wrappers, user identity
├── post.rs             # Post, reply, thread types
├── profile.rs          # User profile
├── social.rs           # Follow list, feed index
├── token.rs            # Bond, Donation, NameRegistration (on-chain types)
├── epoch.rs            # Block-based epoch definitions, emission schedule
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
/// (unique, verified, costs Y to register).
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

    /// The amount of Y the author bonds on this post at creation time.
    /// This is the mandatory first bond — recorded on-chain via a Bond transaction.
    pub initial_bond_amount: u64,

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
        initial_bond_amount: u64,
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
- `initial_bond_amount > 0` (every post must have a non-zero creator bond)

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
/// A bond placed on a post (on-chain).
/// Bonds are the primary curation signal. Bonding Y on a post signals
/// belief in its quality. A fraction of the bond is burned (deflationary).
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
/// Donations transfer Y to the creator with a fraction burned.
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
    /// Fraction burned (e.g., 5%).
    pub burn_amount: u64,
    /// Remainder transferred to the creator.
    pub creator_amount: u64,
}

/// A name registration (on-chain).
/// Burns Y to claim a unique human-readable name.
#[derive(Clone, Serialize, Deserialize)]
pub struct NameRegistration {
    /// The user claiming the name.
    pub owner: PublicKey,
    /// The registered name (lowercase alphanumeric + hyphens, 1-32 chars).
    pub name: String,
    /// Amount of Y burned to register this name.
    pub burn_cost: u64,
}

/// An invitation record (on-chain).
/// Invitations form a web-of-trust tree rooted at genesis users.
#[derive(Clone, Serialize, Deserialize)]
pub struct OnChainInvitation {
    /// The user issuing the invitation.
    pub inviter: PublicKey,
    /// The user being invited.
    pub invitee: PublicKey,
    /// Amount of Y burned to issue this invitation.
    pub y_cost: u64,
    /// Trust distance from genesis (inviter's distance + 1).
    pub trust_distance: u32,
}
```

### Validation Rules

**Bond:**
- `amount > 0`
- If `is_first_bond == true`, `bonder` must be the post author
- A post must have exactly one first bond (the creator bond)
- `bonder` must have sufficient Y balance on-chain

**Donation:**
- `amount > 0`
- `burn_amount + creator_amount == amount`
- `burn_amount` must match `amount * donation_burn_rate_bps / 10_000`
- `donor` must have sufficient Y balance on-chain
- `creator` must be the actual author of the referenced post

**NameRegistration:**
- `name` must match `^[a-z0-9-]{1,32}$`
- `name` must not already be registered
- `burn_cost` must meet the configured minimum
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
    /// Burn rate for bonds (basis points, e.g., 1000 = 10%).
    pub bond_burn_rate_bps: u64,
    /// Burn rate for donations (basis points, e.g., 500 = 5%).
    pub donation_burn_rate_bps: u64,
    /// Y cost to issue an invitation.
    pub invitation_cost_y: u64,
    /// Maximum percentage of epoch emission any single creator can receive (basis points).
    pub per_creator_emission_cap_bps: u64,
}

/// Y emission schedule — fixed at contract deployment, halving-based.
/// Enforced on-chain by the smart contract.
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
    /// This logic is mirrored in the smart contract.
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
    /// A bond placed on a post.
    Bond {
        bonder: PublicKey,
        post_hash: ContentAddress,
        amount: u64,
    },
    /// A donation made to a post's creator.
    Donation {
        donor: PublicKey,
        post_hash: ContentAddress,
        amount: u64,
    },
    /// A unique name registered on-chain.
    NameRegistered {
        owner: PublicKey,
        name: String,
        cost: u64,
    },
    /// An invitation issued on-chain.
    Invitation {
        inviter: PublicKey,
        invitee: PublicKey,
        cost: u64,
    },
    /// The epoch counter advanced.
    EpochAdvanced {
        epoch: u64,
        emission: u64,
    },
    /// Emission distributed to a creator for an epoch.
    EmissionDistributed {
        epoch: u64,
        creator: PublicKey,
        amount: u64,
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
