# Data Layer Design (`dsn-data`)

## Purpose

Abstracts off-chain content storage behind traits, enabling:
1. In-memory mock for fast unit tests and simulation
2. Real IPFS/Autonomi backend for testnet/mainnet
3. Clean separation of protocol logic from storage mechanics

On-chain operations (tokens, bonds, donations, names, invitations, epochs) are handled by the `dsn-chain` crate and its `ChainClient` trait. This document focuses on the off-chain content layer.

## Module Structure

```
crates/data/src/
├── lib.rs              # Re-exports
├── traits.rs           # Storage trait definitions
├── memory.rs           # In-memory implementation
├── autonomi.rs         # Real Autonomi implementation (feature-gated)
├── error.rs            # Data layer errors
└── conversion.rs       # Type conversion between dsn-core and Autonomi SDK types
```

## Core Storage Traits (`traits.rs`)

### ContentStore

Handles all immutable, content-addressed data (posts).

```rust
#[async_trait]
pub trait ContentStore: Send + Sync {
    /// Store immutable data. Returns the content address.
    async fn put(&self, data: &[u8]) -> Result<ContentAddress, DataError>;

    /// Retrieve data by content address.
    /// Returns None if not found.
    async fn get(&self, address: &ContentAddress) -> Result<Option<Vec<u8>>, DataError>;

    /// Check if a chunk exists.
    async fn exists(&self, address: &ContentAddress) -> Result<bool, DataError>;
}
```

### MutableStore

Handles all mutable, key-addressed data (profiles, follow lists, feed indices).

```rust
#[async_trait]
pub trait MutableStore: Send + Sync {
    /// Create a new mutable entry for the given owner and content type.
    async fn create(
        &self,
        owner: &PublicKey,
        content_type: ContentType,
        data: &[u8],
    ) -> Result<(), DataError>;

    /// Read a mutable entry by owner's public key and content type.
    /// Returns None if not found.
    async fn get(
        &self,
        owner: &PublicKey,
        content_type: ContentType,
    ) -> Result<Option<MutableData>, DataError>;

    /// Update an existing mutable entry.
    /// The implementation must verify the caller owns the entry.
    async fn update(
        &self,
        owner: &PublicKey,
        content_type: ContentType,
        data: &[u8],
    ) -> Result<(), DataError>;

    /// Check if a mutable entry exists.
    async fn exists(
        &self,
        owner: &PublicKey,
        content_type: ContentType,
    ) -> Result<bool, DataError>;
}

/// Metadata returned alongside mutable content.
pub struct MutableData {
    pub owner: PublicKey,
    pub content_type: ContentType,
    pub data: Vec<u8>,
}

/// Distinguishes different mutable data purposes at the storage level.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ContentType {
    UserProfile = 1,
    FeedIndex = 2,
    FollowList = 3,
}
```

### GraphStore

Handles directed graph edges (reply threading, content flags).

```rust
#[async_trait]
pub trait GraphStore: Send + Sync {
    /// Store a graph entry. Returns the address.
    async fn put(&self, entry: &GraphEntryData) -> Result<(), DataError>;

    /// Get all graph entries for an owner.
    /// May return multiple entries (each is immutable once stored).
    async fn get(&self, owner: &PublicKey) -> Result<Vec<GraphEntryData>, DataError>;

    /// Check if any graph entry exists for this owner.
    async fn exists(&self, owner: &PublicKey) -> Result<bool, DataError>;
}

/// Our representation of a graph entry.
#[derive(Clone, Serialize, Deserialize)]
pub struct GraphEntryData {
    pub owner: PublicKey,
    pub parents: Vec<PublicKey>,
    /// 32 bytes of content — typically a ContentAddress of a Chunk.
    pub content: [u8; 32],
    /// Outgoing edges: (target_owner, 32-byte metadata).
    pub descendants: Vec<(PublicKey, [u8; 32])>,
    pub signature: Signature,
}
```

### Combined Content Storage Trait

```rust
/// The full off-chain content storage backend combining all three stores.
/// Protocol crates that need off-chain data accept this trait.
pub trait ContentStorage: ContentStore + MutableStore + GraphStore {}

/// Blanket impl: anything implementing all three is a ContentStorage.
impl<T> ContentStorage for T where T: ContentStore + MutableStore + GraphStore {}
```

## Mutable Data Key Derivation

A single user has multiple mutable entries (profile, feed, follows). When using Autonomi Scratchpads, each is addressed by a derived public key since each public key can only have one Scratchpad.

### Strategy: Deterministic Child Keys

```rust
/// Derive a purpose-specific key from the user's root key.
/// Each ContentType gets its own child key → its own storage address.
pub fn derive_mutable_key(root_sk: &SecretKey, purpose: ContentType) -> SecretKey {
    root_sk.derive_child(&(purpose as u64).to_le_bytes())
}
```

| Purpose | Derivation Bytes | Contents |
|---|---|---|
| `UserProfile` | `[1, 0, 0, 0, 0, 0, 0, 0]` | Serialized `UserProfile` |
| `FeedIndex` | `[2, 0, 0, 0, 0, 0, 0, 0]` | Serialized `FeedIndex` |
| `FollowList` | `[3, 0, 0, 0, 0, 0, 0, 0]` | Serialized `FollowList` |

### Mapping Root Identity to Derived Keys

The user's **root public key** is their canonical identity (used in posts, follows, etc.). Their derived public keys are discoverable:

```rust
/// Given a user's root public key and a purpose, compute the derived storage address.
/// Any client can do this to look up any user's data.
pub fn mutable_address_for(root_pk: &PublicKey, purpose: ContentType) -> KeyAddress;
```

This requires that key derivation is deterministic and works on public keys too. In real BLS, this is possible via `MainPubkey::derive_child()`. In our simulation, we hash `(root_pk || purpose)`.

## On-Chain Operations (`dsn-chain`)

The `ChainClient` trait is defined in the `dsn-chain` crate and provides access to all on-chain state. It is documented here by reference for completeness.

`ChainClient` covers the following operations:

- **Y token**: balance queries, transfers between accounts
- **Bonds**: placing bonds on posts, querying bond state and bonding curves
- **Donations**: executing donations from donor to creator (with burn), querying donation history
- **Names**: registering human-readable names, resolving name to public key
- **Invitations**: creating invitations, querying trust distance in the invitation tree
- **Epochs**: querying current epoch info, emission schedule
- **Events**: listening for on-chain events (new bonds, donations, epoch transitions)

See the `dsn-chain` crate documentation for the full trait definition and implementation details.

## In-Memory Implementation (`memory.rs`)

```rust
pub struct MemoryContentStorage {
    /// Chunks: keyed by content address.
    chunks: RwLock<HashMap<ContentAddress, Vec<u8>>>,

    /// Mutable entries: keyed by (owner_pk, content_type).
    mutable: RwLock<HashMap<(PublicKey, ContentType), MutableData>>,

    /// Graph entries: keyed by owner, multiple entries per owner.
    graph_entries: RwLock<HashMap<PublicKey, Vec<GraphEntryData>>>,
}
```

### Capabilities

- Thread-safe via `RwLock` (supports concurrent agent simulation)
- Instant reads/writes (no network latency)
- Supports deliberate failure injection for testing error paths

```rust
impl MemoryContentStorage {
    pub fn new() -> Self;

    /// Inject a simulated failure for the next N operations (testing only).
    pub fn inject_failures(&self, count: usize);
}
```

## Autonomi Implementation (`autonomi.rs`)

Feature-gated behind `autonomi` feature flag. Not implemented in Phase 1-3.

```rust
#[cfg(feature = "autonomi")]
pub struct AutonomiBacked {
    client: autonomi::Client,
    wallet: autonomi::Wallet,
}
```

### Key Design Decisions for Autonomi Backend

1. **Encryption**: Most mutable entries are stored **unencrypted** (plaintext mode) because all data is intended to be publicly verifiable. The only exception might be draft posts or private follow lists (future feature).

2. **Mutable entry creation**: Each derived key's Scratchpad must be created (paid for) once. The user pays a one-time ANT fee per purpose. After that, updates are free.

3. **Counter management**: The `counter` field in Autonomi Scratchpads is a CRDT monotonic counter. The data layer must track the current counter and increment on each update.

4. **Error handling**: Autonomi can fail with network-level errors (timeout, quorum failure). The data layer retries with exponential backoff up to a configurable limit, then surfaces the error.

5. **Read-after-write**: Due to Autonomi's eventual consistency, a read immediately after a write may return the old value. The data layer provides an `await_confirmation()` method that polls until the write is visible or timeout.

## Data Mapping Summary

| Core Type | Storage Layer | Key | Notes |
|---|---|---|---|
| `UserProfile` | Off-chain (Mutable) | derived(root, Profile) | Mutable, free updates |
| `Post` | Off-chain (Content) | content hash | Immutable, pay once |
| `FeedIndex` | Off-chain (Mutable) | derived(root, Feed) | Rolling list of post addresses |
| `FollowList` | Off-chain (Mutable) | derived(root, Follow) | Mutable list |
| Reply link | Off-chain (Graph) | reply-specific key | Immutable edge parent→child |
| Content flag | Off-chain (Graph) | flag-specific key | Immutable moderation flag |
| Y Balance | On-chain | smart contract | ERC-20 token |
| Bonds | On-chain | smart contract | Per-post bonding curve |
| Donations | On-chain | smart contract | Donor→creator, with burn |
| Names | On-chain | smart contract | Name→public key mapping |
| Invitations | On-chain | smart contract | Invitation tree |
| Epochs/Emission | On-chain | smart contract | Auto-distributed |

## Error Types (`error.rs`)

```rust
#[derive(Debug, thiserror::Error)]
pub enum DataError {
    #[error("mutable entry not found for {owner:?}")]
    MutableNotFound { owner: PublicKey },

    #[error("chunk not found: {address:?}")]
    ChunkNotFound { address: ContentAddress },

    #[error("mutable entry already exists for {owner:?}")]
    MutableAlreadyExists { owner: PublicKey },

    #[error("data too large: {size} bytes, max {max}")]
    DataTooLarge { size: usize, max: usize },

    #[error("network error: {0}")]
    Network(String),

    #[error("timeout after {elapsed_ms}ms")]
    Timeout { elapsed_ms: u64 },

    #[error("serialization error: {0}")]
    Serialization(String),

    #[error("signature verification failed")]
    InvalidSignature,
}
```

## GraphEntry Usage Patterns

### Reply to a Post

```
GraphEntry {
    owner: reply_specific_key,
    parents: [post_author_pk],           // Points to parent post's author
    content: reply_chunk_address,        // 32-byte address of the reply Chunk
    descendants: [],                     // Replies to this reply will point back
}
```

### Content Flag

```
GraphEntry {
    owner: flag_specific_key,
    parents: [flagger_pk],               // Who flagged
    content: flagged_post_address,       // 32-byte address of flagged Chunk
    descendants: [(post_author_pk, flag_reason_hash)],
}
```

## Concurrency Model

- All trait methods are `async` and take `&self` (shared reference)
- Implementations use interior mutability (`RwLock`)
- Multiple concurrent readers, exclusive writers
- The in-memory backend supports running thousands of simulated agents concurrently
- The Autonomi backend naturally handles concurrency (each network request is independent)
