# Data Layer Design (`dsn-data`)

## Purpose

Abstracts off-chain content storage behind traits, enabling:
1. In-memory mock for fast unit tests and simulation
2. Indexer backend (`indexer.rs`) for testnet/mainnet — clients publish signed objects to indexers, which double as hot storage
3. Clean separation of protocol logic from storage mechanics

Design goals:
- **Simplicity is an explicit goal.** The protocol specifies a data format (signed, content-addressed objects) and stays silent on transport — no bespoke storage network.
- **Storage is other participants' responsibility.** Indexers are the hot-storage tier, priced by the existing query-fee market (doc 07); the client always keeps a full local copy of everything its user signs. `docs/12-storage-and-anchoring.md` governs storage semantics; this document aligns with it.

On-chain operations (tokens, bonds, donations, names, invitations, epochs, identity, anchoring) are handled by the `dsn-chain` crate and its `ChainClient` trait. This document focuses on the off-chain content layer.

## Module Structure

```
crates/data/src/
├── lib.rs              # Re-exports
├── traits.rs           # Storage trait definitions
├── memory.rs           # In-memory implementation
├── indexer.rs          # Indexer backend: publish to K indexers, query, sync
└── error.rs            # Data layer errors
```

## Storage Model — The Relay Pattern

Publishing is a relay, not a write to a storage network:

1. The client signs an object and publishes it to K chosen indexers via `POST /api/v1/publish`. Indexers verify the signature at ingest and reject anything that doesn't check out.
2. Indexers sync and backfill from each other over an ordered cursor stream, `GET /api/v1/stream?cursor=` — "give me everything since this position" — verified item-by-item because every object is signed.
3. The client always keeps a full local copy. A dead indexer is a re-publish event, not data loss: the client re-publishes its originals to any willing indexer (including one it runs itself).

The full text corpus is small (≈ 1 GB/day network-wide even at scale), and registered indexers replicate all of it. Hosting is already paid for by the query-fee market (doc 07, Indexer Economics) — the relay adds no new economic layer.

### Durability (best-effort, honest)

The client default publishes to **K ≥ 3** indexers, runs a periodic liveness check against them, and automatically re-publishes to a fresh indexer whenever one drops below target. Retention is part of the priced indexer service, so retention terms are a market feature: full (registered) indexers replicate the entire text corpus as the normative expectation, while priced retention applies to media blobs and to light/specialized indexers. Without a funded long-term host, durability is best-effort — it comes from independently chosen indexers plus the author's local copy plus any trustless third-party mirror, not from a permanence guarantee. See "Replicability, not permanence" below.

## Signed-Object Envelope

Every published object shares one envelope shape:

```
{ author_identity, claimed_epoch, version, payload, signature }
```

This is a **normalization, not a second signature**: the existing per-type `signature` field *is* the envelope signature. Each type's signable bytes are redefined to cover `(author_identity ‖ claimed_epoch ‖ version ‖ payload)`. Concretely, `Post`, `MutableData`, and `GraphEntryData` each carry a `claimed_epoch` field inside their signed bytes — no wrapper struct, no double signing.

- `author_identity` — the author's IdentityId (doc 01). The current signing key is resolved through the IdentityRegistry for verification only.
- `claimed_epoch` — **display metadata only**. It never enters validity: existence/time bounds come from anchors (doc 12 §4) and validity from the un-revoked-key rule (doc 01). Ingest surfaces it as the author's claim, nothing more.
- `version` — monotonic counter for mutable records (immutable objects use 0).

Ingest verifies the single signature against the key current for `author_identity` in the IdentityRegistry, then indexes the object.

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

    /// Check if a content object exists.
    async fn exists(&self, address: &ContentAddress) -> Result<bool, DataError>;
}
```

### MutableStore

Handles all mutable, logically-addressed data (profiles, follow lists, feed indices).

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
    /// The implementation must verify the caller owns the entry and bump `version`.
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

/// Metadata returned alongside mutable content (envelope fields above).
pub struct MutableData {
    pub owner: PublicKey,          // author_identity (IdentityId)
    pub content_type: ContentType,
    pub claimed_epoch: u64,        // display-only; inside signed bytes
    pub version: u64,              // monotonic; highest valid version wins
    pub data: Vec<u8>,             // payload
    pub signature: Signature,      // the envelope signature
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

/// A DSN protocol object: a signed directed edge (reply threading, content
/// flags). A native DSN type — no association with any external network.
#[derive(Clone, Serialize, Deserialize)]
pub struct GraphEntryData {
    pub owner: PublicKey,          // author_identity (IdentityId)
    pub parents: Vec<PublicKey>,
    pub claimed_epoch: u64,        // display-only; inside signed bytes
    /// 32 bytes of content — typically the ContentAddress of a content object.
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

## Hash-Based Logical Addressing

A single user has multiple mutable records (profile, feed, follows). Each is placed at a deterministic logical address derived from the user's identity key and a purpose tag — there are **no child keys**, and **one identity key signs everything**:

```rust
/// Compute the logical address of one of a user's mutable records.
/// Any client can compute this for any user from public data.
pub fn logical_address(root_pk: &PublicKey, purpose: ContentType) -> KeyAddress {
    // address = blake3(root_pk || purpose_tag)
    KeyAddress(blake3(root_pk.as_bytes(), (purpose as u32).to_le_bytes()))
}
```

| Purpose tag | Contents |
|---|---|
| `UserProfile` | Serialized `UserProfile` |
| `FeedIndex` | Serialized `FeedIndex` |
| `FollowList` | Serialized `FollowList` |

The address is `blake3(root_pk ‖ purpose_tag)`. Because it is a pure hash of public inputs, any client looks up any user's records without key derivation; because a single identity key signs every record, there are no per-purpose child keys to track.

## On-Chain Operations (`dsn-chain`)

The `ChainClient` trait is defined in the `dsn-chain` crate and provides access to all on-chain state. It is documented here by reference for completeness.

`ChainClient` covers the following operations:

- **Y token**: balance queries, transfers between accounts
- **Bonds**: placing bonds on posts, querying bond state and bonding curves
- **Donations**: executing donations from donor to creator (protocol fee routed to the Reward Pool, after the referral cut), querying donation history
- **Names**: claiming/assessing/renting handles (Harberger), resolving handle to public key
- **Invitations**: creating invitations, querying tree position (depth, ancestry)
- **Epochs**: querying current epoch info, emission schedule, treasury drip
- **Reward Pool**: querying pool balance, per-epoch drip, and the treasury slice
- **Identity (IdentityRegistry)**: resolving `IdentityId → current key`; `rotate`; `set_guardians`; `recover`
- **Referral**: querying referral earnings owed to an inviter
- **Treasury**: querying the disclosed treasury address and its balance
- **Anchoring**: `post_anchor(root)` and anchor-event queries (Merkle-root timestamp anchors, doc 12 §4)
- **Events**: listening for on-chain events (bonds, donations, epoch transitions, identity events, `Anchored`)

See the `dsn-chain` crate documentation for the full trait definition and implementation details.

## In-Memory Implementation (`memory.rs`)

```rust
pub struct MemoryContentStorage {
    /// Content objects: keyed by content address.
    content: RwLock<HashMap<ContentAddress, Vec<u8>>>,

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

## Indexer Backend (`indexer.rs`)

The real backend relays signed objects to a set of configured indexers. Not implemented in Phase 1-3.

1. **Publish.** `put`/`create`/`update` sign the object (envelope above) and `POST /api/v1/publish` to the K configured indexers. Each indexer verifies the signature at ingest.
2. **Query.** Reads hit indexers' query APIs; the client verifies content addresses and signatures locally, so any indexer's answer is checkable and no indexer is trusted.
3. **Retry / backoff across peers.** A failed or slow indexer is retried with exponential backoff, and the request fails over to another peer.
4. **Dead peer → re-publish.** Liveness checks against the K ≥ 3 target trigger automatic re-publish of the local originals to a fresh indexer.

`MemoryContentStorage` is unchanged and remains the default backend for tests and simulation.

## Data Mapping Summary

| Core Type | Storage Layer | Key | Notes |
|---|---|---|---|
| `UserProfile` | Signed object, hosted by indexers | logical address blake3(root_pk‖tag) | Mutable, free updates |
| `Post` | Signed object, hosted by indexers | content hash | Immutable |
| `FeedIndex` | Signed object, hosted by indexers | logical address blake3(root_pk‖tag) | Rolling list of post addresses |
| `FollowList` | Signed object, hosted by indexers | logical address blake3(root_pk‖tag) | Mutable list |
| Reply link | Signed object (graph), hosted by indexers | blake3(root_pk‖tag) | Immutable edge parent→child |
| Content flag | Signed object (graph), hosted by indexers | blake3(root_pk‖tag) | Immutable moderation flag |
| Y Balance | On-chain | smart contract | ERC-20 token |
| Bonds | On-chain | smart contract | Per-post bonding curve |
| Donations | On-chain | smart contract | Donor→creator, fee to Reward Pool |
| Names | On-chain | smart contract | Handle→public key mapping (Harberger) |
| Invitations | On-chain | smart contract | Invitation tree |
| Epochs/Emission | On-chain | smart contract | Auto-distributed |

## Error Types (`error.rs`)

```rust
#[derive(Debug, thiserror::Error)]
pub enum DataError {
    #[error("mutable entry not found for {owner:?}")]
    MutableNotFound { owner: PublicKey },

    #[error("content object not found: {address:?}")]
    ContentNotFound { address: ContentAddress },

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
    owner: reply_object_id,              // blake3(root_pk ‖ tag ‖ ref)
    parents: [post_author_pk],           // Points to parent post's author
    content: reply_content_address,      // 32-byte address of the reply content object
    descendants: [],                     // Replies to this reply will point back
}
```

### Content Flag

```
GraphEntry {
    owner: flag_object_id,               // blake3(root_pk ‖ tag ‖ ref)
    parents: [flagger_pk],               // Who flagged
    content: flagged_post_address,       // 32-byte address of the flagged content object
    descendants: [(post_author_pk, flag_reason_hash)],
}
```

## Concurrency Model

- All trait methods are `async` and take `&self` (shared reference)
- Implementations use interior mutability (`RwLock`)
- Multiple concurrent readers, exclusive writers
- The in-memory backend supports running thousands of simulated agents concurrently

Mutable records carry a monotonic `version`. Indexers keep the highest-version record that has a valid signature; same-version conflicts resolve deterministically by lowest object hash (a safety tiebreak, since a single writer per record is the expected case, not a merge strategy).

## Media

Media blobs (images, video) are **content-addressed** and stored/served by indexers — or by anyone — at their discretion and price; media hosting is an indexer revenue line alongside query access (doc 07), not a separate role. The guarantee is inherent to content addressing: bytes that don't hash to the requested address are rejected by every honest client, so a lying server is caught on first fetch. Posts reference media by content address plus optional server hints, never by a bare URL:

```rust
pub struct MediaRef {
    pub hash: ContentAddress,       // the only thing that authenticates the bytes
    pub server_hints: Vec<String>,  // where to try fetching; advisory only
}
```

A blob with no paying owner and no interested host may die — the same honest guarantee as text. There is no separate media-server role and no named media pattern.

## Replicability, not permanence

Content persists **while someone cares** — the author's local copy, an indexer that serves it, or any trustless third-party mirror (mirroring is trustless because objects are self-authenticating). There is no permanence-by-construction for content nobody wants; the guarantee is replicability, not permanence. Durability = independently chosen indexers + the author's local copy + trustless mirrors, and provable history comes from anchors (doc 12 §4), which keep prior timestamps provable forever. Out-of-protocol archival services may exist — endowed permanent archiving is an ordinary paid service any operator can offer — but none is normative and none is required by the protocol. See `docs/12-storage-and-anchoring.md`.

## Privacy & Data Lifecycle

### Retract

A user can publish a signed **retract** tombstone against one of their own objects. The tombstone rides the ordinary publish/stream path (`POST /api/v1/publish`, and it appears in `GET /api/v1/stream`) like any signed object. On seeing a retract:

- Compliant indexers stop serving the target and render a placeholder in threads; hosts MAY drop the stored bytes.
- Trustless mirrors may retain the bytes — stated honestly: a retract is a convention, not consensus, so it cannot force deletion off machines the author doesn't control.
- The default client treats its own retract as a delete.
- Moderation scores on retracted content become moot.

### Private follows (roadmap)

Follow lists are public today. Private follow lists — encrypted to the owner and opaque to indexers — are a roadmap item; they require an encryption scheme and a private-read path not yet specified.

### Erasure / GDPR (best-effort)

Legal erasure is in tension with a permissionless, self-authenticating, mirrorable corpus. Compliant indexers honor retracts and ingest-time hash blocklists, but the protocol cannot guarantee that every trustless mirror or local copy deletes on request. The design offers best-effort erasure (retract plus honest indexer/host behavior), stated honestly, rather than a guarantee it cannot keep.

### Private donations

Tree-external donations use a fresh standalone keypair and carry zero emission weight by construction (docs 03 and 05); they appear as anonymous supporters. Privacy here is unlinkability at the donation layer, not chain-analysis resistance — the funding transfer itself is public.
