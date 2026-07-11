# Verifiable Indexer Service (`dsn-indexer`)

## Purpose

Signed content objects carry no query capability on their own. Clients cannot ask a raw object stream "give me Alice's feed" or "search for posts about Rust." The indexer bridges this gap: it ingests client-published signed objects, syncs the corpus from peer indexers, listens to blockchain events, builds queryable indices locally, and exposes a REST API for clients. Indexers double as the network's hot storage — they store what they serve (see `docs/12-storage-and-anchoring.md`, which governs storage semantics).

Because ALL source content is a signed, content-addressed object (posts, mutable records, signed edges) and all economic activity (bonds, donations, transfers, emissions) is recorded on-chain, any indexer output can be independently verified against the source. This makes indexers **verifiable**: verifiability = local signature verification (every object carries its author's signature and hashes to its own address) + cross-indexer checks + anchor proofs (`docs/12`) that bind a post to a provable existed-before time. Clients spot-check any result the indexer returns by re-verifying the underlying signed object, cross-checking a second indexer, or querying the blockchain.

Multiple competing indexers can run simultaneously. No single indexer can censor content without clients noticing — they simply switch to a different indexer, verify signatures locally, or re-publish from their own local copy.

## Module Structure

```
crates/indexer/src/
├── lib.rs              # Re-exports, IndexerService construction
├── config.rs           # Configuration: sync settings, chain settings, moderation policy, storage paths
├── chain_listener.rs   # Listens to blockchain events, populates local index
├── ingest.rs           # Ingest & sync: verify + store published objects, backfill from peers, anchor loop
├── publish.rs          # POST /publish handler: signature-verified object intake
├── stream.rs           # GET /stream handler: ordered object stream for peer backfill
├── store.rs            # Local index storage (SQLite-backed)
├── models.rs           # Internal data model: indexed posts, profiles, engagement
├── api/
│   ├── mod.rs          # Axum router assembly
│   ├── feeds.rs        # GET /feeds/:user_pk — home feed, user timeline
│   ├── profiles.rs     # GET /profiles/:user_pk — profile + stats
│   ├── posts.rs        # GET /posts/:address — single post + thread
│   ├── search.rs       # GET /search?q=... — full-text search
│   ├── engagement.rs   # GET /engagement/:post_address — bonds, donations
│   ├── moderation.rs   # GET /moderation/:post_address — flag status, verdicts
│   ├── names.rs        # GET /names/:handle — handle resolution + lifecycle state
│   ├── epoch.rs        # GET /epoch — scheduled emission, Reward Pool balance, drip, treasury
│   ├── creators.rs     # GET /creators/:pk/supporters — donor recognition (not protocol)
│   ├── spotcheck.rs    # GET /spotcheck/... — raw signed object + signature proof; anchor branch
│   └── health.rs       # GET /health — indexer status, ingest stats
├── feed_builder.rs     # Feed ranking: chronological, donated, bonded
└── error.rs            # Indexer error types
```

## Chain Listener (`chain_listener.rs`)

The chain listener subscribes to blockchain events and populates the local index with on-chain activity. This is the authoritative source for all economic data (bonds, donations, emissions, transfers, invitations, handle lifecycle events, and Reward Pool state).

### Event Types

The listener processes the following on-chain events:

Variant names and payload fields below are canonical in `docs/01-core-types.md`; this table and the match arms mirror them field-for-field. Every fee-bearing event carries `referral_to: Option<IdentityId>` and `referral_amount: u64` — the referral cut is split off to the inviter's `referral_earnings` **before** the remainder is added to the Reward Pool (see 05 Referral Annuity; `REFERRAL_BPS = 1000`, first `REFERRAL_TERM_EPOCHS = 208` epochs).

| Event | Description | Index Action |
|---|---|---|
| **Bond** | User bonds Y tokens to a post; the fee portion (10%; the entire first bond) routes to the Reward Pool, net of the referral cut | `route_referral`, `upsert_bond`, `add_pool_inflow` |
| **Donation** | User donates Y tokens to an author via a post; the 5% fee routes to the Reward Pool, net of the referral cut | `route_referral`, `upsert_donation`, `add_pool_inflow` |
| **EmissionDistributed** | Scheduled emission plus creator drip distributed to a creator | Update recipient's `y_balance` |
| **Transfer** | Y tokens transferred between users | Update sender/receiver `y_balance` |
| **Invitation** | New user invited to the network; the invite fee routes to the Reward Pool, net of the referral cut (paid by the inviter — carries a cut to THEIR inviter) | `route_referral`, `ensure_user_known`, `record_invitation`, `add_pool_inflow` |
| **EpochAdvanced** | Epoch boundary crossed | `update_epoch_state` (scheduled emission, gross drip, treasury slice, pool balance) |
| **NameClaimed** | User claims an unowned @handle (sets assessed value, pays first-epoch rent) | `upsert_name` |
| **AssessmentChanged** | Owner changes a handle's assessed value (decreases take effect after the lookback window) | `update_name_assessment` |
| **NameRentPaid** | Handle rent paid through an epoch (→ Reward Pool, net of referral) | `route_referral`, `record_rent_payment` |
| **ForceBuyInitiated** | A Harberger-tier handle receives a force-buy bid (fee → pool, net of referral) | `route_referral`, `mark_force_buy` |
| **NameTransferred** | Handle ownership changes (force-buy completes or manual transfer; fee → pool, net of referral) | `route_referral`, `transfer_name` (appends to `name_history`) |
| **NameLapsed** | Handle rent unpaid past grace; handle returns to unowned | `lapse_name` |
| **KeyRotated** | An identity rotates its signing key (effective next epoch; prior objects stay valid) | `rotate_key` (update `current_key`) |
| **GuardiansSet** | An identity sets/updates its recovery guardians and threshold | `set_guardians` |
| **RecoveryProposed** | A guardian-driven recovery is proposed (starts the veto window once approvals reach M) | `open_recovery` |
| **RecoveryApproved** | A guardian approves the active recovery proposal | `record_recovery_approval` |
| **RecoveryVetoed** | The current key vetoes an active recovery proposal | `cancel_recovery` |
| **RecoveryExecuted** | A recovery completes at the deadline; the new key becomes `current_key` | `execute_recovery` |
| **KeyRevoked** | An identity marks an old key compromised as of a block; objects signed by it are valid only if anchored/on-chain before that block | `revoke_key` |
| **Anchored** | An indexer anchors a Merkle root of newly indexed content addresses (`AnchorLog`, `docs/12 §4`) | `record_anchor` |

### Reorg Handling

The chain listener tracks a configurable **confirmation depth** (e.g., 12 blocks). Events are only considered final once they are buried under N confirmations. If the chain reorganizes:

1. The listener detects that a previously seen block hash no longer matches the canonical chain.
2. All events from reorged blocks are rolled back from the local index.
3. The listener replays events from the new canonical chain starting at the fork point.

```rust
/// The main chain listener loop. Polls the blockchain for new events.
pub async fn run_chain_listener(
    index: Arc<dyn IndexStore>,
    config: &ChainConfig,
) -> Result<(), IndexerError> {
    let provider = Provider::new(&config.rpc_url).await?;
    let mut last_confirmed_block = index.last_indexed_block().await?.unwrap_or(config.start_block);

    loop {
        let latest_block = provider.get_block_number().await?;
        let confirmed_up_to = latest_block.saturating_sub(config.confirmation_depth);

        if confirmed_up_to > last_confirmed_block {
            // Check for reorgs: verify stored block hashes match canonical chain
            let fork_point = detect_reorg(&provider, &index, last_confirmed_block).await?;
            if let Some(fork_block) = fork_point {
                tracing::warn!(fork_block, "chain reorg detected, rolling back");
                index.rollback_to_block(fork_block).await?;
                last_confirmed_block = fork_block;
            }

            // Process new confirmed blocks
            let events = fetch_events(
                &provider,
                &config.contract_address,
                last_confirmed_block + 1,
                confirmed_up_to,
            ).await?;

            for event in &events {
                process_chain_event(&index, event).await?;
            }

            last_confirmed_block = confirmed_up_to;
            index.update_last_indexed_block(confirmed_up_to).await?;
        }

        tokio::time::sleep(Duration::from_secs(config.chain_poll_interval_secs)).await;
    }
}

/// Process a single blockchain event into the local index.
async fn process_chain_event(
    index: &Arc<dyn IndexStore>,
    event: &ChainEvent,
) -> Result<(), IndexerError> {
    // The referral cut (`referral_to`/`referral_amount`) is split off to the
    // inviter's earnings BEFORE the net fee is added to the Reward Pool.
    match event {
        // --- Economic events (fee portions feed the Reward Pool, net of referral) ---
        ChainEvent::Bond { bonder, post_hash, amount, referral_to, referral_amount, fee_to_pool, block_number } => {
            route_referral(index, referral_to, *referral_amount).await?;
            index.upsert_bond(bonder, post_hash, *amount, *block_number).await?;
            index.add_pool_inflow(fee_to_pool.saturating_sub(*referral_amount)).await?;
        }
        ChainEvent::Donation { donor, post_hash, author, amount, referral_to, referral_amount, fee_to_pool, block_number } => {
            route_referral(index, referral_to, *referral_amount).await?;
            index.upsert_donation(donor, post_hash, author, *amount, *block_number).await?;
            index.add_pool_inflow(fee_to_pool.saturating_sub(*referral_amount)).await?;
        }
        ChainEvent::EmissionDistributed { creator, amount, .. } => {
            // Per-epoch total = scheduled emission + creator drip; both land here.
            index.add_y_balance(creator, *amount).await?;
        }
        ChainEvent::Transfer { from, to, amount, .. } => {
            index.transfer_y_balance(from, to, *amount).await?;
        }
        ChainEvent::Invitation { inviter, invitee, cost, referral_to, referral_amount } => {
            // The invite fee is paid by the inviter; when an invitee later invites
            // others, that fee carries a cut to THEIR inviter.
            route_referral(index, referral_to, *referral_amount).await?;
            index.ensure_user_known(invitee).await?;
            index.record_invitation(inviter, invitee).await?;
            index.add_pool_inflow(cost.saturating_sub(*referral_amount)).await?;
        }
        ChainEvent::EpochAdvanced { epoch, scheduled_emission, gross_drip, treasury_slice, pool_balance } => {
            // gross_drip = pool × 2%; treasury_slice → Treasury (0 after epoch 260);
            // creator_drip = gross_drip − treasury_slice. treasury_balance is read
            // from the disclosed Treasury address.
            index.update_epoch_state(*epoch, *scheduled_emission, *gross_drip, *treasury_slice, *pool_balance).await?;
        }

        // --- Handle lifecycle events (six events; see 01/03 for the on-chain model) ---
        ChainEvent::NameClaimed { owner, handle, assessed_value, epoch, .. } => {
            index.upsert_name(owner, handle, *assessed_value, *epoch).await?;
        }
        ChainEvent::AssessmentChanged { handle, new_value, effective_epoch, .. } => {
            index.update_name_assessment(handle, *new_value, *effective_epoch).await?;
        }
        ChainEvent::NameRentPaid { handle, paid_through_epoch, referral_to, referral_amount, fee_to_pool, .. } => {
            route_referral(index, referral_to, *referral_amount).await?;
            index.record_rent_payment(handle, *paid_through_epoch).await?;
            index.add_pool_inflow(fee_to_pool.saturating_sub(*referral_amount)).await?;
        }
        ChainEvent::ForceBuyInitiated { handle, bidder, bid, deadline_epoch, referral_to, referral_amount, fee_to_pool } => {
            route_referral(index, referral_to, *referral_amount).await?;
            index.mark_force_buy(handle, bidder, *bid, *deadline_epoch).await?;
            index.add_pool_inflow(fee_to_pool.saturating_sub(*referral_amount)).await?;
        }
        ChainEvent::NameTransferred { handle, from, to, referral_to, referral_amount } => {
            // Appends the prior owner's span to name_history, then sets the new owner.
            route_referral(index, referral_to, *referral_amount).await?;
            index.transfer_name(handle, from, to).await?;
        }
        ChainEvent::NameLapsed { handle, epoch, .. } => {
            index.lapse_name(handle, *epoch).await?;
        }

        // --- Identity events (rotation + M-of-N social recovery; see 01 Identity Registry) ---
        ChainEvent::KeyRotated { identity, new_key, scheme_id, effective_epoch, .. } => {
            // Rotation never invalidates prior objects; only the current key changes.
            index.rotate_key(identity, new_key, *scheme_id, *effective_epoch).await?;
        }
        ChainEvent::GuardiansSet { identity, guardians, threshold } => {
            index.set_guardians(identity, guardians, *threshold).await?;
        }
        ChainEvent::RecoveryProposed { identity, proposal_id, proposed_key, scheme_id, veto_deadline_epoch } => {
            index.open_recovery(identity, *proposal_id, proposed_key, *scheme_id, *veto_deadline_epoch).await?;
        }
        ChainEvent::RecoveryApproved { identity, proposal_id, guardian } => {
            index.record_recovery_approval(identity, *proposal_id, guardian).await?;
        }
        ChainEvent::RecoveryVetoed { identity, proposal_id } => {
            index.cancel_recovery(identity, *proposal_id).await?;
        }
        ChainEvent::RecoveryExecuted { identity, proposal_id, new_key, scheme_id, epoch } => {
            index.execute_recovery(identity, *proposal_id, new_key, *scheme_id, *epoch).await?;
        }
        ChainEvent::KeyRevoked { identity, key, block } => {
            // Objects signed by `key` are valid iff anchored or referenced on-chain
            // before `block` (the revocation tx's block); the boundary is objective.
            index.revoke_key(identity, key, *block).await?;
        }

        // --- Anchoring (proves existed-before; see docs/12 §4 and the anchor loop) ---
        ChainEvent::Anchored { sender, root } => {
            index.record_anchor(sender, root).await?;
        }
    }
    Ok(())
}

/// Route a referral cut to the inviter's `referral_earnings` before the net
/// fee is deposited to the Reward Pool. No-op when the payer is out of term.
async fn route_referral(
    index: &Arc<dyn IndexStore>,
    referral_to: &Option<IdentityId>,
    referral_amount: u64,
) -> Result<(), IndexerError> {
    if let Some(inviter) = referral_to {
        index.add_referral_earnings(inviter, referral_amount).await?;
    }
    Ok(())
}
```

## Ingest & Sync (`ingest.rs`, `publish.rs`, `stream.rs`)

Content reaches an indexer two ways: clients **publish** their signed objects directly (`POST /api/v1/publish`), and indexers **sync** the corpus from peers (`GET /api/v1/stream?cursor=`). There is no polling of a storage network — the indexer stores what it serves. Content handling never touches economic data (bonds, donations, balances, emissions); that stays the chain listener's responsibility.

### `POST /api/v1/publish` — signature-verified intake

A client signs an object (post, mutable-record version, or signed edge — each carries `author_identity`, `claimed_epoch`, `version`, `payload`, `signature`; see 02) and POSTs it. The handler:

1. Recomputes the content address (`blake3` of the object bytes) and rejects a mismatch.
2. Verifies the signature against a key in the author-identity's registry history that was **not revoked** — rotation never invalidates anything; validity is per-key, not per-epoch (see 01 Identity Registry). `claimed_epoch` is display metadata only and never enters validity.
3. For an object signed by a **revoked** key: it is valid only if it carries an anchor proof (Merkle branch) or an on-chain reference predating the revocation transaction's block. If no such pre-revocation proof is available yet, the object is **quarantined** — stored but not served — until any indexer produces one (proofs are fetched lazily, see below).
4. Stores the object, keeps the highest-version valid record per logical address, and indexes it.

```rust
/// Verify + store one client-published signed object.
pub async fn ingest_object(
    index: &Arc<dyn IndexStore>,
    object: &SignedObject,
) -> Result<IngestOutcome, IndexerError> {
    if object.content_address() != object.claimed_address {
        return Err(IndexerError::SpotCheckFailed { reason: "address mismatch".into() });
    }
    // Resolve the author's non-revoked key history and any revocation block.
    let author_keys = index.author_keys(&object.author_identity).await?;
    match author_keys.verify(object) {
        KeyValidity::Valid => {
            index.store_object(object).await?;
            Ok(IngestOutcome::Indexed)
        }
        // Signed by a revoked key: needs a pre-revocation anchor/on-chain proof.
        KeyValidity::RevokedNeedsProof => {
            index.quarantine_object(object).await?; // stored, not served
            Ok(IngestOutcome::Quarantined)
        }
        KeyValidity::Invalid => {
            Err(IndexerError::SpotCheckFailed { reason: "invalid signature".into() })
        }
    }
}
```

### `GET /api/v1/stream?cursor=` — peer backfill

Indexers replicate the full text corpus (posts, profiles, follow graph) from one another. The stream is an ordered feed of signed objects; the `cursor` is the caller's last-seen position, and anchor roots serve as checkpoint markers within it — so "give me everything since root R" is the cursor contract. Every streamed item is verified **item-by-item** exactly as in publish intake (signatures and addresses are self-checking), so a peer cannot inject forgeries. Discovery of new authors comes from chain **Invitation** events (the primary channel — everyone enters through the invitation tree) and from peer exchange; there is no follow-list walk or priority queue.

### Anchor loop (`ingest.rs`)

Each anchoring interval, the indexer computes the Merkle root (`dsn-core merkle_root`) of the content addresses it **newly indexed** — posts, each mutable-record VERSION (hash of the signed record bytes), and signed edges (per `docs/12 §4` and A8/B2) — and submits it to the `AnchorLog` contract:

```rust
/// Each interval: anchor a Merkle root of newly indexed content addresses.
pub async fn run_anchor_loop(
    index: Arc<dyn IndexStore>,
    chain: Arc<dyn ChainClient>,
    config: &SyncConfig,
) -> Result<(), IndexerError> {
    loop {
        let addresses = index.newly_indexed_addresses().await?;
        if !addresses.is_empty() {
            let root = merkle_root(&addresses);
            chain.post_anchor(root).await?;                 // AnchorLog.anchor(root) → Anchored
            index.store_anchor_branches(root, &addresses).await?; // branches served lazily
        }
        tokio::time::sleep(config.anchor_interval).await;
    }
}
```

Objects circulate un-anchored at first and are marked unproven until the next interval; their Merkle branches become fetchable **lazily** on demand via `GET /api/v1/spotcheck/anchor/:address` from any indexer whose anchor includes the object — peers re-request proofs as needed, there is no proof-update stream. Anchor proofs travel with the objects during peer backfill and re-seeding, so legitimate pre-revocation objects re-propagate without any reputation-based attestations.

### Retract handling

A signed **retract** tombstone (see 02 Privacy & Data Lifecycle) is ingested and streamed like any other object. A compliant indexer stops serving the retracted target, renders a thread placeholder in its place, and MAY drop the stored bytes; any moderation score on the retracted content becomes moot. Retracts appear in `GET /api/v1/stream` alongside every other object so peers converge on the same tombstone. Honoring a retract is a convention, not consensus — a mirror MAY retain bytes (stated honestly).

## Internal Data Model (`models.rs`, `store.rs`)

### What Gets Indexed

The indexer builds a local relational index from two sources: ingested signed content objects (from client publishes and peer sync), and on-chain economic events. The local store uses SQLite for persistence across restarts.

### Schema

```rust
/// A fully indexed user record.
pub struct IndexedUser {
    /// Canonical identity: the IdentityId (the genesis public key), resolved
    /// through the IdentityRegistry. The handle is a mutable label resolved at
    /// render time (see 01 Identity Principle). Every `:user_pk` this record is
    /// keyed by is an IdentityId, never a rotated signing key.
    pub identity_id: IdentityId,
    /// The key currently valid for signature verification (from KeyRotated /
    /// RecoveryExecuted events); may differ from `identity_id` after a rotation.
    pub current_key: PublicKey,
    /// On-chain @handle, if one is currently claimed (from handle lifecycle events).
    pub handle: Option<String>,
    /// Assessed value backing the handle, in atomic Y. `None` (stored as 0) in the
    /// flat tier, where the value is meaningless.
    pub handle_assessed_value: Option<u64>,
    /// Pricing tier the handle falls under, derived from its length.
    pub handle_tier: Option<HandleTier>,
    /// Current rent standing of the handle. Ownership history lives in `name_history`.
    pub handle_rent_status: Option<HandleRentStatus>,
    /// Latest profile data (`display_name` is cosmetic and off-chain).
    pub display_name: String,
    pub bio: String,
    pub avatar: Option<ContentAddress>,
    pub profile_version: u64,
    /// Social stats (denormalized for fast API responses).
    pub follower_count: u64,
    pub following_count: u64,
    pub post_count: u64,
    /// Trust distance from seed users in the invitation graph.
    pub trust_distance: u32,
    /// Token state (from on-chain events).
    pub y_balance: u64,
    pub y_nonce: u64,
    /// Aggregate donation stats (from on-chain events).
    pub total_donations_received: u64,
    pub total_donations_given: u64,
    /// Lifetime referral annuity earned as a direct inviter (10% of invitees'
    /// protocol fees during their first 208 epochs; see 05 Referral Annuity).
    /// Atomic Y; rendered as a JSON string.
    pub referral_earnings: u64,
    /// Invitation chain.
    pub invited_by: Option<IdentityId>,
    pub invitation_depth: u32,
    /// Moderation state.
    pub active_flags: u32,
    /// Ingest metadata.
    pub last_indexed_at: chrono::DateTime<chrono::Utc>,
    pub mutable_record_versions: MutableRecordVersions,
}

/// Version counters for incremental ingest (highest valid version wins).
pub struct MutableRecordVersions {
    pub profile: u64,
    pub feed_index: u64,
    pub follow_list: u64,
}

/// A fully indexed post record.
pub struct IndexedPost {
    /// Content address (primary key).
    pub address: ContentAddress,
    /// Author's public key.
    pub author: PublicKey,
    /// Post content.
    pub content: String,
    /// Public keys mentioned in the post. Mirrors `Post.mentions` from 01:
    /// clients resolve @handles to PublicKeys at write time and embed the keys,
    /// so mentions survive handle changes; the indexer renders them back to
    /// current handles at read time.
    pub mentions: Vec<PublicKey>,
    /// Attached media, mirroring `Post.media` from 01. Each entry references a
    /// content-addressed blob plus optional hints for where to fetch it; a blob
    /// that hashes wrong is rejected on fetch (see 02 Media, docs/12 §3).
    pub media: Vec<MediaRef>,
    /// Threading.
    pub reply_to: Option<ContentAddress>,
    pub reply_count: u64,
    /// Sequence in author's post history.
    pub sequence: u64,
    /// Timestamp (informational).
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Bond metrics (from on-chain events).
    pub total_bonded: u64,
    pub bond_count: u64,
    /// Donation metrics (from on-chain events).
    pub total_donated: u64,
    pub unique_donors: u32,
    /// Moderation state.
    pub flag_count: u32,
    pub moderation_verdict: Option<ModerationVerdict>,
}

/// A structural reference to a media blob (mirrors `Post.media` / `MediaRef`
/// from 01). `hash` is the content address; `server_hints` are where to try
/// fetching it — never authoritative, since content addressing catches a
/// lying server on first fetch. No media-server role (see docs/12 §3).
pub struct MediaRef {
    pub hash: ContentAddress,
    pub server_hints: Vec<String>,
}

/// Engagement detail for a post.
pub struct IndexedEngagement {
    pub post_address: ContentAddress,
    pub bonds: Vec<IndexedBond>,
    pub donations: Vec<IndexedDonation>,
}

pub struct IndexedBond {
    pub bonder: PublicKey,
    pub amount: u64,
    pub block_number: u64,
}

pub struct IndexedDonation {
    pub donor: PublicKey,
    pub amount: u64,
    pub block_number: u64,
}

/// A thread is a root post plus all its nested replies.
pub struct IndexedThread {
    pub root: IndexedPost,
    pub replies: Vec<IndexedThreadReply>,
}

pub struct IndexedThreadReply {
    pub post: IndexedPost,
    pub depth: u32,
    pub parent_address: ContentAddress,
}

/// Moderation verdict as determined by this indexer's policy.
#[derive(Clone, Serialize, Deserialize)]
pub enum ModerationVerdict {
    /// No flags, content visible.
    Clean,
    /// Flagged but below threshold, content visible with warning.
    Warned { flag_count: u32 },
    /// Flags exceed threshold, content hidden by this indexer.
    Hidden { flag_count: u32 },
}

/// Handle pricing tier, derived from handle length (see 03 §E Name Registry).
#[derive(Clone, Serialize, Deserialize)]
pub enum HandleTier {
    /// Length 1–6: Harberger tax on the assessed value; force-buyable.
    Harberger,
    /// Length ≥ 7: flat 1 Y/epoch for all lengths; no force-buy (safe harbor).
    Flat,
}

/// Rent standing for a claimed handle, derived from on-chain rent events.
#[derive(Clone, Serialize, Deserialize)]
pub enum HandleRentStatus {
    /// Rent paid through the current epoch.
    Paid,
    /// Rent unpaid but still within the grace window.
    Grace { epochs_left: u32 },
    /// Grace expired; the handle has returned to unowned.
    Lapsed,
}
```

### SQLite Tables (Logical)

| Table | Primary Key | Purpose |
|---|---|---|
| `users` | `public_key` | User profiles, stats, token balances |
| `posts` | `address` | Post content, engagement counts |
| `follows` | `(follower, followee)` | Follow relationships |
| `bonds` | `(bonder, post_address, block_number)` | Bond records (from chain) |
| `donations` | `(donor, post_address, block_number)` | Donation records (from chain) |
| `names` | `handle` | Current handle ownership: owner, assessed value, tier, rent status, last-paid epoch, force-buy state (from chain) |
| `name_history` | `(handle, claimed_at_epoch)` | Past ownership spans of a handle ("formerly @x") |
| `supporters` | `(creator, supporter)` | Per-creator lifetime donation totals — donor recognition (derived from `donations`) |
| `reply_links` | `(parent_address, child_address)` | Thread structure |
| `invitations` | `(inviter, invitee)` | Invitation graph |
| `flags` | `(flagger, post_address)` | Content flags |
| `reward_pool` | singleton | Reward Pool balance, current epoch, last scheduled emission, last gross drip, treasury slice, treasury balance |
| `identities` | `identity_id` | Registry mirror: current key, key history (with per-key revocation block), guardians/threshold, active recovery proposal |
| `chain_state` | singleton | Last indexed block number, block hashes for reorg detection |
| `ingest_state` | `identity_id` | Per-user ingest metadata (last indexed at, mutable-record versions) |
| `sync_cursors` | `peer_url` | Last-seen stream cursor / anchor-root checkpoint per peer indexer |
| `peers` | `peer_url` | Known peer indexers for backfill and object exchange |
| `anchors` | `(root, address)` | Merkle branches for anchored content addresses (served lazily via spotcheck/anchor) |
| `quarantine` | `address` | Stored-not-served objects awaiting a pre-revocation anchor/on-chain proof |
| `posts_fts` | (virtual) | Full-text search index on `posts.content` |

### Index Store Trait

```rust
/// Abstraction over the local index storage.
/// Allows swapping SQLite for an in-memory store in tests.
#[async_trait]
pub trait IndexStore: Send + Sync {
    // --- Write operations (used by ingest & sync) ---
    async fn upsert_user(&self, pk: &IdentityId, profile: &Option<UserProfile>,
                         follows: &Option<FollowList>) -> Result<(), IndexerError>;
    async fn upsert_post(&self, post: &SignedPost) -> Result<(), IndexerError>;
    async fn upsert_reply_link(&self, entry: &GraphEntryData) -> Result<(), IndexerError>;
    async fn ensure_user_known(&self, pk: &IdentityId) -> Result<(), IndexerError>;
    async fn update_moderation_verdict(&self, post: &ContentAddress,
                                        verdict: ModerationVerdict) -> Result<(), IndexerError>;
    /// Store a verified, servable signed object (highest valid version wins).
    async fn store_object(&self, object: &SignedObject) -> Result<(), IndexerError>;
    /// Store a revoked-key object that lacks a pre-revocation proof: kept but not served.
    async fn quarantine_object(&self, object: &SignedObject) -> Result<(), IndexerError>;
    /// Resolve an author-identity's non-revoked key history + revocation blocks,
    /// used by ingest to verify signatures (rotation never invalidates; the
    /// revocation transaction's block is the only cutoff — see 01/A8/B1).
    async fn author_keys(&self, identity: &IdentityId) -> Result<AuthorKeys, IndexerError>;

    // --- Write operations (used by chain listener) ---
    async fn upsert_bond(&self, user: &PublicKey, post: &ContentAddress,
                         amount: u64, block_number: u64) -> Result<(), IndexerError>;
    async fn upsert_donation(&self, donor: &PublicKey, post: &ContentAddress,
                             author: &PublicKey, amount: u64, block_number: u64) -> Result<(), IndexerError>;
    // Handle lifecycle (six on-chain events). All atomic Y amounts are u64.
    async fn upsert_name(&self, owner: &PublicKey, handle: &str,
                         assessed_value: u64, claimed_at_epoch: u64) -> Result<(), IndexerError>;
    async fn update_name_assessment(&self, handle: &str, new_value: u64,
                                    effective_epoch: u64) -> Result<(), IndexerError>;
    async fn record_rent_payment(&self, handle: &str, paid_through_epoch: u64) -> Result<(), IndexerError>;
    async fn mark_force_buy(&self, handle: &str, bidder: &PublicKey, bid: u64,
                            deadline_epoch: u64) -> Result<(), IndexerError>;
    async fn transfer_name(&self, handle: &str, from: &PublicKey, to: &PublicKey) -> Result<(), IndexerError>;
    async fn lapse_name(&self, handle: &str, at_epoch: u64) -> Result<(), IndexerError>;
    async fn record_invitation(&self, inviter: &IdentityId, invitee: &IdentityId) -> Result<(), IndexerError>;
    async fn add_y_balance(&self, user: &IdentityId, amount: u64) -> Result<(), IndexerError>;
    async fn transfer_y_balance(&self, from: &IdentityId, to: &IdentityId, amount: u64) -> Result<(), IndexerError>;
    /// Add a protocol fee (bond/donation/invite/rent/force-buy) to the Reward Pool total.
    /// Callers pass the fee NET of the referral cut (see `add_referral_earnings`).
    async fn add_pool_inflow(&self, fee: u64) -> Result<(), IndexerError>;
    /// Credit a direct inviter's referral annuity earnings (10% of an in-term
    /// invitee's protocol fee, split off before the pool deposit; see 05).
    async fn add_referral_earnings(&self, inviter: &IdentityId, amount: u64) -> Result<(), IndexerError>;
    /// Snapshot the authoritative epoch state on each EpochAdvanced event.
    /// `gross_drip = pool × 2%`; `treasury_slice` (0 after epoch 260) accumulates
    /// into the mirrored treasury balance; `creator_drip = gross_drip − treasury_slice`.
    async fn update_epoch_state(&self, epoch: u64, scheduled_emission: u64,
                                gross_drip: u64, treasury_slice: u64,
                                pool_balance: u64) -> Result<(), IndexerError>;

    // --- Identity registry (rotation + M-of-N social recovery; see 01) ---
    async fn rotate_key(&self, identity: &IdentityId, new_key: &PublicKey,
                        scheme_id: u8, effective_epoch: u64) -> Result<(), IndexerError>;
    async fn set_guardians(&self, identity: &IdentityId, guardians: &[IdentityId],
                           threshold: u32) -> Result<(), IndexerError>;
    async fn open_recovery(&self, identity: &IdentityId, proposal_id: u64,
                           proposed_key: &PublicKey, scheme_id: u8,
                           veto_deadline_epoch: u64) -> Result<(), IndexerError>;
    async fn record_recovery_approval(&self, identity: &IdentityId, proposal_id: u64,
                                       guardian: &IdentityId) -> Result<(), IndexerError>;
    async fn cancel_recovery(&self, identity: &IdentityId, proposal_id: u64) -> Result<(), IndexerError>;
    async fn execute_recovery(&self, identity: &IdentityId, proposal_id: u64,
                              new_key: &PublicKey, scheme_id: u8, epoch: u64) -> Result<(), IndexerError>;
    /// Mark `key` revoked as of `block`; objects it signed are valid only if
    /// anchored / referenced on-chain before that block (A8/B1).
    async fn revoke_key(&self, identity: &IdentityId, key: &PublicKey, block: u64) -> Result<(), IndexerError>;

    // --- Anchoring (see docs/12 §4 and the anchor loop) ---
    /// Record an observed on-chain `Anchored` event (root + anchoring indexer).
    async fn record_anchor(&self, sender: &PublicKey, root: &[u8; 32]) -> Result<(), IndexerError>;
    async fn rollback_to_block(&self, block_number: u64) -> Result<(), IndexerError>;
    async fn last_indexed_block(&self) -> Result<Option<u64>, IndexerError>;
    async fn update_last_indexed_block(&self, block_number: u64) -> Result<(), IndexerError>;

    // --- Read operations (used by API) ---
    async fn get_user(&self, pk: &PublicKey) -> Result<Option<IndexedUser>, IndexerError>;
    async fn get_post(&self, address: &ContentAddress) -> Result<Option<IndexedPost>, IndexerError>;
    async fn get_thread(&self, root: &ContentAddress, max_depth: u32) -> Result<IndexedThread, IndexerError>;
    async fn get_user_timeline(&self, pk: &PublicKey, cursor: Option<u64>,
                                limit: u32) -> Result<Vec<IndexedPost>, IndexerError>;
    async fn get_home_feed(&self, pk: &PublicKey, cursor: Option<u64>,
                           limit: u32, ranking: FeedRanking) -> Result<Vec<IndexedPost>, IndexerError>;
    async fn search_posts(&self, query: &str, cursor: Option<u64>,
                          limit: u32) -> Result<Vec<IndexedPost>, IndexerError>;
    async fn get_engagement(&self, post: &ContentAddress) -> Result<IndexedEngagement, IndexerError>;
    async fn get_bonds_for_post(&self, post: &ContentAddress) -> Result<Vec<IndexedBond>, IndexerError>;
    async fn get_donations_for_post(&self, post: &ContentAddress) -> Result<Vec<IndexedDonation>, IndexerError>;
    async fn get_moderation_status(&self, post: &ContentAddress) -> Result<ModerationVerdict, IndexerError>;
    async fn get_flagged_posts(&self, min_flags: u32, cursor: Option<u64>,
                                limit: u32) -> Result<Vec<IndexedPost>, IndexerError>;
    /// Resolve a handle to its current owner plus lifecycle state and ownership history.
    async fn resolve_name(&self, handle: &str) -> Result<Option<ResolvedHandle>, IndexerError>;
    /// Ownership history for a handle (most recent first), backing "formerly @x" hints.
    async fn name_history(&self, handle: &str) -> Result<Vec<HandleOwnership>, IndexerError>;
    /// Donor recognition (NOT protocol): supporters of a creator, ranked by lifetime donated.
    async fn get_creator_supporters(&self, creator: &PublicKey, cursor: Option<u64>,
                                    limit: u32) -> Result<Vec<Supporter>, IndexerError>;
    /// Top-N supporters of a creator (the leaderboard view).
    async fn get_supporter_leaderboard(&self, creator: &PublicKey,
                                       limit: u32) -> Result<Vec<Supporter>, IndexerError>;
    /// Current epoch, scheduled emission, gross drip, treasury slice, pool
    /// balance, and treasury balance (read path for CLI `epoch_info` and
    /// `GET /api/v1/epoch`).
    async fn get_epoch_info(&self) -> Result<EpochInfo, IndexerError>;

    // --- Ingest & sync coordination ---
    /// Content addresses indexed since the last anchor interval (anchor loop input).
    async fn newly_indexed_addresses(&self) -> Result<Vec<[u8; 32]>, IndexerError>;
    /// Store the Merkle branches for an anchored root (served lazily via spotcheck/anchor).
    async fn store_anchor_branches(&self, root: [u8; 32], addresses: &[[u8; 32]]) -> Result<(), IndexerError>;
    /// Fetch the Merkle branch + anchor tx reference for one content address.
    async fn get_anchor_branch(&self, address: &ContentAddress) -> Result<Option<AnchorBranch>, IndexerError>;
    /// Advance/read a peer's sync cursor (last-seen position / anchor-root checkpoint).
    async fn get_sync_cursor(&self, peer: &str) -> Result<Option<String>, IndexerError>;
    async fn set_sync_cursor(&self, peer: &str, cursor: &str) -> Result<(), IndexerError>;
    async fn known_peers(&self) -> Result<Vec<String>, IndexerError>;
    async fn filter_unknown_posts(&self, addresses: &[ContentAddress]) -> Result<Vec<ContentAddress>, IndexerError>;
    async fn ingest_stats(&self) -> Result<IngestStats, IndexerError>;
}

pub struct IngestStats {
    pub total_users: u64,
    pub total_posts: u64,
    pub total_bonds: u64,
    pub total_donations: u64,
    pub last_sync_completed: Option<chrono::DateTime<chrono::Utc>>,
    pub last_sync_duration_ms: u64,
    pub last_indexed_block: u64,
}

/// Handle resolution result: current owner plus full lifecycle state.
pub struct ResolvedHandle {
    pub handle: String,
    pub owner: PublicKey,
    pub assessed_value: u64,          // atomic Y; 0 in the flat tier
    pub tier: HandleTier,
    pub rent_status: HandleRentStatus,
    pub rent_per_epoch: u64,          // atomic Y; rate × max(V, floor) or the flat 1 Y
    pub force_buy: Option<ForceBuyState>,
    pub history: Vec<HandleOwnership>,
    /// True if ownership changed within the last few epochs (impersonation warning).
    pub recently_changed_owner: bool,
}

pub struct ForceBuyState {
    pub bidder: PublicKey,
    pub bid: u64,                     // atomic Y, escrowed for the notice window
    pub deadline_epoch: u64,
}

/// One ownership span of a handle. `released_at_epoch` is `None` for the current owner.
pub struct HandleOwnership {
    pub public_key: PublicKey,
    pub claimed_at_epoch: u64,
    pub released_at_epoch: Option<u64>,
}

/// A supporter's cumulative donations to one creator (donor recognition, derived).
pub struct Supporter {
    pub public_key: PublicKey,
    pub lifetime_donated: u64,        // atomic Y, summed across all donations to the creator
    pub donation_count: u64,
}

/// Current epoch / emission / Reward Pool snapshot. Backs `GET /api/v1/epoch`.
pub struct EpochInfo {
    pub epoch: u64,
    pub scheduled_emission: u64,      // atomic Y minted this epoch by the schedule
    pub gross_drip: u64,              // atomic Y = pool × 2% (before the treasury slice)
    pub treasury_slice: u64,          // atomic Y routed to the Treasury (0 after epoch 260)
    pub pool_balance: u64,            // atomic Y currently held by the Reward Pool
    pub treasury_balance: u64,        // atomic Y held by the disclosed Treasury address
}

/// A Merkle branch proving a content address was included in an anchored root,
/// plus a reference to the on-chain `Anchored` transaction that carried it.
pub struct AnchorBranch {
    pub address: ContentAddress,
    pub root: [u8; 32],
    pub branch: Vec<MerkleProofNode>,   // dsn-core node type
    pub anchor_tx: String,              // the AnchorLog transaction hash
    pub anchored_block: u64,            // the anchor tx's block (the existed-before bound)
}

/// An author-identity's key material for ingest-time signature verification.
/// `history` holds every key ever current; a revoked key carries the block at
/// which it was revoked. Validity is per-key, not per-epoch (A8/B1).
pub struct AuthorKeys {
    pub identity_id: IdentityId,
    pub current_key: PublicKey,
    pub history: Vec<KeyRecord>,
}

pub struct KeyRecord {
    pub key: PublicKey,
    pub scheme_id: u8,
    pub revoked_at_block: Option<u64>,  // Some(block) once KeyRevoked seen
}

/// Result of `author_keys.verify(object)`.
pub enum KeyValidity {
    Valid,
    RevokedNeedsProof, // signed by a revoked key with no pre-revocation proof yet
    Invalid,
}

pub enum IngestOutcome {
    Indexed,
    Quarantined,
}
```

## Feed Builder (`feed_builder.rs`)

Server-side ranked feeds exist for **thin clients** (low-power devices, simple integrations). The reference architecture ranks **client-side**: the indexer serves raw candidate sets (see the Candidates endpoint) and the client's local model does the ordering — see 09-client-ranking.md. Everything in this section is the thin-client path.

### Feed Ranking Strategies

Clients choose a ranking strategy when requesting feeds. The indexer supports multiple strategies:

```rust
#[derive(Clone, Serialize, Deserialize)]
pub enum FeedRanking {
    /// Reverse chronological. No algorithmic sorting.
    Chronological,
    /// Weighted by donation volume and donor diversity.
    Donated,
    /// Weighted by bond volume (staked visibility).
    Bonded,
    /// Combined: donations + bonds + recency, with configurable weights.
    Blended {
        recency_weight: f64,
        donation_weight: f64,
        bond_weight: f64,
    },
}
```

### Home Feed Construction

A user's home feed is built from the posts of all users they follow:

```rust
/// Build a home feed for a user.
pub async fn build_home_feed(
    index: &dyn IndexStore,
    user_pk: &PublicKey,
    ranking: FeedRanking,
    cursor: Option<u64>,
    limit: u32,
) -> Result<Vec<IndexedPost>, IndexerError> {
    // 1. Get user's follow list from the index
    // 2. Gather recent posts from all followed users
    // 3. Apply moderation filtering (hide posts that exceed flag threshold)
    // 4. Rank by selected strategy
    // 5. Paginate with cursor
    index.get_home_feed(user_pk, cursor, limit, ranking).await
}
```

### Ranking Score Computation

```rust
/// Compute a blended ranking score for a post.
pub fn blended_score(
    post: &IndexedPost,
    now: chrono::DateTime<chrono::Utc>,
    weights: &BlendedWeights,
) -> f64 {
    // Recency: exponential decay, half-life of ~24 hours
    let age_hours = (now - post.created_at).num_hours().max(0) as f64;
    let recency = (-age_hours / 24.0).exp();

    // Donation signal: log-scaled total donated, weighted by donor diversity
    let donation = (1.0 + post.total_donated as f64).ln()
        * (1.0 + post.unique_donors as f64).ln();

    // Bond signal: log-scaled total bonded
    let bond = (1.0 + post.total_bonded as f64).ln();

    recency * weights.recency_weight
        + donation * weights.donation_weight
        + bond * weights.bond_weight
}
```

Note: this global ranking formula is intentionally **unchanged** by donor recognition. Donation-based prominence applies only *within a single thread* (see Donor Recognition below); it never feeds into `blended_score` or any home-feed / timeline / search ranking. A donation buys a donor higher placement in the replies to the post they supported — nowhere else.

## Donor Recognition (client/indexer convention — NOT protocol)

Donor recognition is a **presentation layer** built entirely from public chain data. It is emphatically **not** part of the protocol and confers **no** on-chain rights: the protocol keeps a donation a pure financial loss (the donor pays the 5% fee to the Reward Pool and directs emission to the recipient — nothing flows back). These features are conventions an indexer or client *may* implement; a different indexer may ignore them, and because every number is recomputable from on-chain donations, any client can verify or reproduce them independently.

**Private (anonymous) donations.** A donor who gives from a **fresh standalone keypair** outside their invitation tree carries zero emission weight by construction (tree-external → `pairwise_weight` 0.0; see 05/03), so the donation's creator share and 5% pool fee are unchanged but the donor is not linkable to their main identity. Such donors surface in supporter features as **anonymous supporters**: the donation flow is visible (it is on-chain), but no badge, leaderboard entry, or thread prominence ties back to a real identity. Unlinkability is at the donation layer only — the funding transfer is public and private donors pay their own gas (see 03/05).

### Thread-scoped superchat prominence

Within the replies to a given post, an indexer may rank a donor's replies higher **in that thread only**, proportional to how much that donor has donated to the thread's author. This is the "superchat" pattern: paying to stand out where you already gave support.

The prominence is deliberately **thread-local and never global**. It must not raise a donor's reach in home feeds, timelines, or search. The reason is anti-corruption: if Y could buy general reach, the network would degrade into pay-for-distribution and the ranking signals (bonds, donations, recency) would stop reflecting genuine engagement. Confining bought prominence to the one thread the donation supported keeps the incentive honest — it rewards supporting a creator's conversation without letting money purchase audience elsewhere.

```rust
/// Thread-local prominence weight for a donor's replies under `thread_author`'s post.
/// Purely presentational: derived from public donation totals, applied ONLY when
/// ordering replies within this thread, never to global feed ranking.
pub fn thread_donor_prominence(
    donor_lifetime_to_author: u64, // atomic Y this donor has donated to thread_author
) -> f64 {
    (1.0 + donor_lifetime_to_author as f64).ln()
}
```

### Supporter badges

An indexer may attach a **verifiable badge** to a donor, summarizing their lifetime donations to a creator (e.g. bronze / silver / gold tiers by cumulative atomic Y). Badges are computed from the public `donations` table — no privileged state — so they carry the same verifiability guarantee as any other indexed economic figure: a client can recompute the lifetime total from on-chain donations and confirm the badge.

### Per-creator leaderboards

An indexer may publish a **per-creator supporter leaderboard** ranking a creator's supporters by lifetime donated. Like badges, this is derived and reproducible from chain data; it is subjective only in the cosmetic sense (tier cutoffs, display), not in the underlying totals.

```
GET /api/v1/creators/:pk/supporters?cursor=0&limit=20

Response:
{
    "creator": "pk_hex",
    "supporters": [
        {
            "public_key": "pk_hex",
            "lifetime_donated": "25000000000",
            "donation_count": 34,
            "badge": "gold"
        },
        {
            "public_key": "pk_hex",
            "lifetime_donated": "4200000000",
            "donation_count": 9,
            "badge": "silver"
        }
    ],
    "next_cursor": 20,
    "has_more": true
}
```

Donor annotations (badge, thread prominence rank) also appear inline on donation entries in thread and engagement responses, so clients can render "superchat" styling without a second request. These annotations are advisory client hints, not economic facts, and are clearly separable from the verifiable donation amounts they accompany.

## REST API Endpoints (`api/`)

All endpoints return JSON. Pagination uses cursor-based pagination with `?cursor=<sequence>&limit=<n>`.

**API convention — `:user_pk` is an IdentityId.** Every `:user_pk` path parameter and every `public_key`/author field in a response is the user's **IdentityId** (the genesis public key that anchors the invitation tree, handle ownership, flags, and donation tuples), never a rotated signing key. The current signing key is consulted only for signature verification via the registry (see 01 Identity Principle, A9). Clients resolve display handles from the IdentityId at render time.

**API convention — atomic Y amounts are JSON strings.** Every token amount (balances, donation/bond totals, assessed values, rent, emission, pool balances) is a **base-10 string of atomic Y** (6 decimals, so `"1000000"` = 1 Y). At the 140B-Y hard cap the supply is `140_000_000_000_000_000` atomic, which exceeds JSON's safe integer range (2^53 ≈ 9.0×10^15); serializing these as numbers would silently lose precision in JavaScript clients. Counts, block numbers, epochs, and other small integers remain JSON numbers. All sample responses below follow this convention.

### Feeds

```
GET /api/v1/feeds/:user_pk/home?ranking=chronological&cursor=0&limit=20

Response:
{
    "posts": [IndexedPost],
    "next_cursor": 20,
    "has_more": true
}
```

```
GET /api/v1/feeds/:user_pk/timeline?cursor=0&limit=20

Response:
{
    "posts": [IndexedPost],
    "next_cursor": 20,
    "has_more": true
}
```

### Candidates (for client-side ranking)

Bulk, un-ranked recall for clients that run their own ranking model (09-client-ranking.md). The indexer claims **no ordering** — candidates are grouped by source, each carrying the economic metadata the local ranker consumes as features. Cheap to serve (no per-user ranking state), which is what makes it the commodity product of the query-fee market below.

```
GET /api/v1/candidates/:user_pk?sources=follows,lineage,bonded,mentions&since=<epoch>&limit=2000

Response:
{
    "candidates": [
        {
            "post": IndexedPost,
            "source": "follows" | "lineage" | "bonded" | "mentions",
            "total_donated": "2000000",
            "unique_donors": 14,
            "total_bonded": "150000000",
            "author_lineage_hops": 3
        }
    ],
    "next_cursor": 2000,
    "has_more": true
}
```

Sources: `follows` (recent posts from the follow list), `lineage` (the user's invitation-tree neighborhood, decaying by lineage distance — the cold-start source), `bonded` (top recently-bonded posts network-wide), `mentions` (posts whose `mentions` include the user). Completeness has the same trust status as feeds: not guaranteed, detectable by querying multiple indexers.

### Profiles

```
GET /api/v1/profiles/:user_pk

Response:
{
    "public_key": "hex...",
    "handle": "alice" | null,
    "handle_assessed_value": "15000000000" | null,
    "handle_tier": "harberger" | "flat" | null,
    "handle_rent_status": "Paid" | null,
    "display_name": "Alice",
    "bio": "...",
    "avatar": "content_address_hex or null",
    "follower_count": 42,
    "following_count": 15,
    "post_count": 128,
    "y_balance": "50000000000",
    "trust_distance": 2,
    "total_donations_received": "12000000000",
    "total_donations_given": "3500000000",
    "referral_earnings": "900000000",
    "invited_by": "hex or null"
}
```

```
GET /api/v1/profiles/:user_pk/followers?cursor=0&limit=50

Response:
{
    "followers": [{ "public_key": "hex...", "display_name": "..." }],
    "next_cursor": 50,
    "has_more": false
}
```

```
GET /api/v1/profiles/:user_pk/following?cursor=0&limit=50

Response:
{
    "following": [{ "public_key": "hex...", "display_name": "..." }],
    "next_cursor": 50,
    "has_more": false
}
```

### Posts and Threads

```
GET /api/v1/posts/:content_address

Response:
{
    "post": IndexedPost,
    "author_profile": { "display_name": "...", "handle": "alice" | null }
}
```

```
GET /api/v1/posts/:content_address/thread?max_depth=10

Response:
{
    "root": IndexedPost,
    "replies": [
        {
            "post": IndexedPost,
            "depth": 1,
            "parent_address": "hex..."
        },
        ...
    ],
    "total_replies": 47
}
```

### Search

```
GET /api/v1/search?q=decentralized+social&cursor=0&limit=20

Response:
{
    "posts": [IndexedPost],
    "next_cursor": 20,
    "has_more": true,
    "total_estimate": 142
}
```

Full-text search is powered by SQLite FTS5 on post content. The indexer tokenizes and indexes post content during ingest.

### Engagement

```
GET /api/v1/engagement/:post_address

Response:
{
    "post_address": "hex...",
    "total_bonded": "1500000000",
    "bond_count": 3,
    "bonds": [
        {
            "bonder": "pk_hex",
            "amount": "500000000",
            "block_number": 12345
        }
    ],
    "total_donated": "2000000000",
    "unique_donors": 8,
    "donations": [
        {
            "donor": "pk_hex",
            "amount": "250000000",
            "block_number": 12340,
            "donor_badge": "gold"
        }
    ]
}
```

The `donor_badge` field is an advisory donor-recognition hint (see Donor Recognition); it is not an economic fact and is derived from public donation totals. The verifiable amounts (`amount`, `total_donated`) are the economic data.

### Names

Resolves an @handle to its current owner plus full Harberger lifecycle state.

```
GET /api/v1/names/:handle

Response:
{
    "handle": "alice",
    "public_key": "hex...",
    "assessed_value": "15000000000",
    "tier": "harberger",
    "rent_status": "Paid",
    "rent_per_epoch": "15000000",
    "force_buy_pending": null,
    "ownership_history": [
        {
            "public_key": "hex...",
            "claimed_at_epoch": 12,
            "released_at_epoch": 34
        },
        {
            "public_key": "hex...",
            "claimed_at_epoch": 34,
            "released_at_epoch": null
        }
    ],
    "recently_changed_owner": false
}
```

`tier` is `"harberger"` (length 1–6) or `"flat"` (length ≥ 7). `rent_status` is `"Paid"`, `{ "Grace": { "epochs_left": 2 } }`, or `"Lapsed"`. `force_buy_pending`, when a bid is outstanding, is `{ "bidder": "hex...", "bid": "20000000000", "deadline_epoch": 39 }` (Harberger tier only; the flat tier is a safe harbor with no force-buy). `recently_changed_owner` warns clients that the handle recently changed hands — useful for impersonation checks, since the current owner may differ from the one a reader remembers.

### Epoch and Reward Pool

```
GET /api/v1/epoch

Response:
{
    "epoch": 37,
    "scheduled_emission": "1400000000000000",
    "gross_drip": "170000000000",
    "treasury_slice": "25500000000",
    "creator_drip": "144500000000",
    "total_emission": "1400144500000000",
    "pool_balance": "8500000000000",
    "treasury_balance": "612000000000"
}
```

Reports the current epoch's economics: `scheduled_emission` is the schedule's mint for this epoch (1.4B Y = `"1400000000000000"` atomic while epoch < 50, halving every 50 epochs); `gross_drip` is 2% of the Reward Pool balance; `treasury_slice` is 15% of the gross drip routed to the disclosed Treasury address (`TREASURY_DRIP_SHARE_BPS = 1500`, dropping to 0 after `TREASURY_TERM_EPOCHS = 260`); `creator_drip = gross_drip − treasury_slice` is what reaches creators; `total_emission` is `scheduled_emission + creator_drip`; `pool_balance` is the pool's current holdings; and `treasury_balance` is the balance mirrored from the Treasury address (auto-returns to the pool at `TREASURY_RECLAIM_EPOCH = 416`). All amounts are atomic-Y strings. This is the read path behind the CLI `epoch_info` command.

### Bonds and Donations per User/Post

```
GET /api/v1/users/:pk/bonds?cursor=0&limit=20

Response:
{
    "bonds": [
        {
            "post_address": "hex...",
            "amount": "500000000",
            "block_number": 12345
        }
    ],
    "next_cursor": 20,
    "has_more": false
}
```

```
GET /api/v1/users/:pk/donations?cursor=0&limit=20

Response:
{
    "donations": [
        {
            "post_address": "hex...",
            "author": "pk_hex",
            "amount": "250000000",
            "block_number": 12340
        }
    ],
    "next_cursor": 20,
    "has_more": false
}
```

```
GET /api/v1/posts/:addr/bonds?cursor=0&limit=20

Response:
{
    "bonds": [IndexedBond],
    "next_cursor": 20,
    "has_more": false
}
```

```
GET /api/v1/posts/:addr/donations?cursor=0&limit=20

Response:
{
    "donations": [IndexedDonation],
    "next_cursor": 20,
    "has_more": false
}
```

### Moderation Status

```
GET /api/v1/moderation/:post_address

Response:
{
    "post_address": "hex...",
    "verdict": "Clean" | "Warned" | "Hidden",
    "flag_count": 2,
    "flags": [
        {
            "flagger": "pk_hex",
            "reason_hash": "hex..."
        }
    ],
    "policy": "default-v1"
}
```

The verdict depends on this indexer's moderation policy configuration (see Configuration section). Different indexers may reach different verdicts for the same content -- this is by design.

### Spot-Check (Verification) API

```
GET /api/v1/spotcheck/post/:content_address

Response:
{
    "indexed_post": IndexedPost,
    "object_proof": {
        "raw_object_b64": "base64...",
        "content_address_recomputed": "hex...",
        "signature_valid": true,
        "author_identity": "hex..."
    },
    "match": true
}
```

```
GET /api/v1/spotcheck/anchor/:content_address

Response:
{
    "address": "hex...",
    "root": "hex...",
    "branch": [{ "hash": "hex...", "is_left": true }],
    "anchor_tx": "0x...",
    "anchored_block": 128740,
    "verified": true
}
```

Returns the Merkle branch from a post's content address to an anchored root (`docs/12 §4`), plus the `AnchorLog` transaction that carried it. A client recomputes the root from the branch and confirms it matches the on-chain `Anchored` event — proving the object existed before `anchored_block`. If the object is not yet anchored (published within the current interval), the indexer returns `404` with `unproven` until the next anchor loop. Any indexer whose anchor includes the object can serve the branch, so proofs are fetched lazily and re-seed across peers with the objects they prove.

```
GET /api/v1/spotcheck/engagement/:post_address

Response:
{
    "indexed_bond_count": 3,
    "indexed_donation_count": 8,
    "chain_proof": {
        "bonds_on_chain": 3,
        "donations_on_chain": 8,
        "bonds_match": true,
        "donations_match": true
    },
    "match": true
}
```

The spot-check API lets any client verify that the indexer is not fabricating or omitting data. For content, the indexer returns the raw signed object; the client recomputes its content address, re-verifies the author signature locally, and cross-checks a second indexer or the anchor branch. For engagement metrics, the indexer's counts can be verified against on-chain events.

### Publish (client → indexer)

Clients upload their own signed objects here; the indexer verifies the signature and content address at intake (see Ingest & Sync). This is the write surface — the indexer stores what it serves.

```
POST /api/v1/publish
Content-Type: application/json

Body:
{
    "object": {
        "author_identity": "hex...",
        "claimed_epoch": 37,
        "version": 12,
        "payload": "base64...",
        "signature": "hex..."
    }
}

Response (202 Accepted):
{
    "content_address": "hex...",
    "status": "indexed" | "quarantined"
}
```

`status` is `"quarantined"` when the object is signed by a revoked key and no pre-revocation anchor/on-chain proof is available yet (stored but not served). A bad signature or address mismatch returns `400`. A client publishes to K ≥ 3 indexers of its choosing and keeps a local copy, so a dropped indexer is a re-publish event, not data loss.

### Stream (peer → peer sync)

Ordered feed of signed objects for peer backfill. The `cursor` is the caller's last-seen position; anchor roots act as checkpoint markers, so passing the last-seen root is equivalent to "give me everything since root R". Every item is re-verified by the receiver.

```
GET /api/v1/stream?cursor=<position-or-root>&limit=1000

Response:
{
    "objects": [
        {
            "author_identity": "hex...",
            "claimed_epoch": 37,
            "version": 12,
            "payload": "base64...",
            "signature": "hex..."
        }
    ],
    "next_cursor": "hex...",
    "has_more": true
}
```

Retract tombstones (see Ingest & Sync) travel through this stream like any other object, so peers converge on the same set of retractions.

### Health

```
GET /api/v1/health

Response:
{
    "status": "healthy",
    "version": "0.1.0",
    "ingest_stats": {
        "total_users": 1250,
        "total_posts": 48000,
        "total_bonds": 5200,
        "total_donations": 31000,
        "last_sync_completed": "2026-03-03T12:00:00Z",
        "last_sync_duration_ms": 45000,
        "last_indexed_block": 128500
    },
    "moderation_policy": "default-v1",
    "uptime_seconds": 86400
}
```

### Router Assembly (`api/mod.rs`)

```rust
/// Build the full Axum router for the indexer API.
pub fn build_router(index: Arc<dyn IndexStore>, storage: Arc<dyn Storage>) -> Router {
    Router::new()
        // Feeds
        .route("/api/v1/feeds/:user_pk/home", get(feeds::home_feed))
        .route("/api/v1/feeds/:user_pk/timeline", get(feeds::user_timeline))
        // Candidates (un-ranked recall for client-side ranking)
        .route("/api/v1/candidates/:user_pk", get(feeds::candidates))
        // Profiles
        .route("/api/v1/profiles/:user_pk", get(profiles::get_profile))
        .route("/api/v1/profiles/:user_pk/followers", get(profiles::get_followers))
        .route("/api/v1/profiles/:user_pk/following", get(profiles::get_following))
        // Posts & Threads
        .route("/api/v1/posts/:address", get(posts::get_post))
        .route("/api/v1/posts/:address/thread", get(posts::get_thread))
        .route("/api/v1/posts/:address/bonds", get(engagement::get_post_bonds))
        .route("/api/v1/posts/:address/donations", get(engagement::get_post_donations))
        // Search
        .route("/api/v1/search", get(search::search_posts))
        // Names (handle resolution + Harberger lifecycle state)
        .route("/api/v1/names/:handle", get(names::resolve_name))
        // Epoch & Reward Pool
        .route("/api/v1/epoch", get(epoch::get_epoch))
        // Donor recognition (client convention, not protocol)
        .route("/api/v1/creators/:pk/supporters", get(creators::get_supporters))
        // Users — bonds & donations
        .route("/api/v1/users/:pk/bonds", get(engagement::get_user_bonds))
        .route("/api/v1/users/:pk/donations", get(engagement::get_user_donations))
        // Engagement
        .route("/api/v1/engagement/:address", get(engagement::get_engagement))
        // Moderation
        .route("/api/v1/moderation/:address", get(moderation::get_status))
        // Spot-check
        .route("/api/v1/spotcheck/post/:address", get(spotcheck::verify_post))
        .route("/api/v1/spotcheck/engagement/:address", get(spotcheck::verify_engagement))
        .route("/api/v1/spotcheck/anchor/:address", get(spotcheck::anchor_branch))
        // Ingest surface: client publish + peer sync stream
        .route("/api/v1/publish", post(publish::publish_object))
        .route("/api/v1/stream", get(stream::object_stream))
        // Health
        .route("/api/v1/health", get(health::health_check))
        // Shared state
        .with_state(AppState { index, storage })
        // CORS (indexers are public APIs, any origin can access)
        .layer(CorsLayer::permissive())
}

/// Shared state accessible by all handlers.
#[derive(Clone)]
pub struct AppState {
    pub index: Arc<dyn IndexStore>,
    pub storage: Arc<dyn Storage>,
}
```

## Configuration (`config.rs`)

```rust
/// Full configuration for the indexer service.
#[derive(Clone, Serialize, Deserialize)]
pub struct IndexerConfig {
    /// Network binding address for the REST API.
    pub bind_address: String,          // default: "0.0.0.0:3000"
    /// Port for the REST API.
    pub bind_port: u16,                // default: 3000

    /// Blockchain settings.
    pub chain: ChainConfig,

    /// Ingest & sync settings.
    pub sync: SyncConfig,

    /// Moderation policy.
    pub moderation: ModerationPolicyConfig,

    /// Local storage path for SQLite index and served objects.
    pub db_path: String,               // default: "./indexer.db"
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ChainConfig {
    /// RPC endpoint for the blockchain node.
    pub rpc_url: String,               // e.g. "https://rpc.example.com"

    /// Contract address for DSN events.
    pub contract_address: String,      // e.g. "0xabc..."

    /// How often to poll for new blocks, in seconds.
    pub chain_poll_interval_secs: u64, // default: 12

    /// Block number to start indexing from.
    pub start_block: u64,              // default: 0

    /// Number of confirmations before considering events final.
    pub confirmation_depth: u64,       // default: 12
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SyncConfig {
    /// Peer indexers to backfill the text corpus from (via GET /api/v1/stream).
    pub peer_indexers: Vec<String>,    // default: empty; base URLs

    /// How often to poll each peer's stream for new objects.
    pub stream_poll_interval: Duration, // default: 30 seconds

    /// How often to anchor a Merkle root of newly indexed content (anchor loop).
    pub anchor_interval: Duration,     // default: 1 hour

    /// Ingest limits (backpressure on publish + peer sync).
    pub max_concurrent_ingest: usize,  // default: 50
    /// Maximum accepted object size, in bytes.
    pub max_object_bytes: usize,       // default: 1 MiB

    /// Seed identities: IdentityIds to bootstrap discovery.
    /// At least one seed is needed for a fresh indexer.
    pub seed_users: Vec<String>,       // hex-encoded IdentityIds
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ModerationPolicyConfig {
    /// Policy name (for display in /health endpoint).
    pub policy_name: String,           // default: "default-v1"

    /// Minimum number of flags required to trigger a "Warned" verdict.
    pub warn_threshold_flags: u32,     // default: 3

    /// Minimum number of flags required to trigger a "Hidden" verdict.
    pub hide_threshold_flags: u32,     // default: 10

    /// Minimum number of unique flaggers required (regardless of count).
    pub min_unique_flaggers: u32,      // default: 3

    /// Custom blocked public keys (operator-level override).
    /// Posts from these users are always hidden.
    pub blocked_users: Vec<String>,    // hex-encoded public keys

    /// Custom blocked content addresses (operator-level override).
    /// These specific posts are always hidden.
    pub blocked_posts: Vec<String>,    // hex-encoded content addresses
}
```

### Configuration Loading

```rust
impl IndexerConfig {
    /// Load configuration from a TOML file.
    pub fn from_file(path: &str) -> Result<Self, IndexerError>;

    /// Load with environment variable overrides.
    /// Env vars use prefix DSN_INDEXER_, e.g. DSN_INDEXER_BIND_PORT=8080.
    pub fn from_file_with_env(path: &str) -> Result<Self, IndexerError>;

    /// Generate a default config file for new operators.
    pub fn write_default(path: &str) -> Result<(), IndexerError>;
}
```

### Example Configuration File

```toml
bind_address = "0.0.0.0"
bind_port = 3000
db_path = "./indexer.db"

[chain]
rpc_url = "https://rpc.example.com"
contract_address = "0xabc123..."
chain_poll_interval_secs = 12
start_block = 0
confirmation_depth = 12

[sync]
peer_indexers = [
    "https://indexer.example.org"
]
stream_poll_interval_secs = 30
anchor_interval_secs = 3600
max_concurrent_ingest = 50
max_object_bytes = 1048576
seed_users = [
    "a1b2c3d4..."
]

[moderation]
policy_name = "default-v1"
warn_threshold_flags = 3
hide_threshold_flags = 10
min_unique_flaggers = 3
blocked_users = []
blocked_posts = []
```

### Moderation Policy Design

Each indexer operator chooses their own moderation policy. This is a feature, not a bug:

- **Strict indexers** may set low thresholds and aggressively hide flagged content
- **Permissive indexers** may set high thresholds and show everything
- **Community indexers** may maintain curated block lists for specific communities
- **Unmoderated indexers** may disable moderation entirely (set thresholds to `u32::MAX`)

Clients choose which indexer to use based on the moderation policy they prefer. The `/health` endpoint exposes the policy name so clients can make informed choices.

## Error Types (`error.rs`)

```rust
#[derive(Debug, thiserror::Error)]
pub enum IndexerError {
    #[error("data layer error: {0}")]
    Data(#[from] DataError),

    #[error("serialization error: {0}")]
    Serialization(String),

    #[error("database error: {0}")]
    Database(String),

    #[error("chain listener error: {0}")]
    ChainError(String),

    #[error("user not found: {pk}")]
    UserNotFound { pk: String },

    #[error("post not found: {address}")]
    PostNotFound { address: String },

    #[error("name not found: {name}")]
    NameNotFound { name: String },

    #[error("invalid public key: {0}")]
    InvalidPublicKey(String),

    #[error("invalid content address: {0}")]
    InvalidContentAddress(String),

    #[error("ingest error for user {user}: {reason}")]
    IngestFailed { user: String, reason: String },

    #[error("configuration error: {0}")]
    ConfigError(String),

    #[error("spot-check verification failed: {reason}")]
    SpotCheckFailed { reason: String },

    #[error("full-text search error: {0}")]
    SearchError(String),

    #[error("feed construction error: {0}")]
    FeedError(String),

    #[error("rate limit exceeded")]
    RateLimited,
}

impl IndexerError {
    /// Map to an HTTP status code for API responses.
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::UserNotFound { .. } | Self::PostNotFound { .. } | Self::NameNotFound { .. } => StatusCode::NOT_FOUND,
            Self::InvalidPublicKey(_) | Self::InvalidContentAddress(_) => StatusCode::BAD_REQUEST,
            Self::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

/// Standard API error response body.
#[derive(Serialize)]
pub struct ApiErrorResponse {
    pub error: String,
    pub code: u16,
}
```

## Service Entrypoint (`lib.rs`)

```rust
/// The top-level indexer service. Owns the chain listener, ingest & sync loop,
/// anchor loop, index store, and API server.
pub struct IndexerService {
    config: IndexerConfig,
    storage: Arc<dyn Storage>,
    index: Arc<dyn IndexStore>,
    chain: Arc<dyn ChainClient>,
}

impl IndexerService {
    /// Create a new indexer service with the given configuration.
    pub async fn new(config: IndexerConfig) -> Result<Self, IndexerError>;

    /// Start the indexer: launches the chain listener, ingest & sync loop, anchor
    /// loop, and API server concurrently.
    pub async fn run(&self) -> Result<(), IndexerError> {
        let chain_handle = tokio::spawn({
            let index = self.index.clone();
            let config = self.config.chain.clone();
            async move {
                run_chain_listener(index, &config).await
            }
        });

        // Backfills the text corpus from peer indexers (GET /api/v1/stream) and
        // discovers authors from chain Invitation events + peer exchange.
        let ingest_and_sync_handle = tokio::spawn({
            let storage = self.storage.clone();
            let index = self.index.clone();
            let config = self.config.sync.clone();
            async move {
                run_ingest_and_sync(storage, index, &config).await
            }
        });

        // Anchors a Merkle root of newly indexed content each interval (AnchorLog).
        let anchor_handle = tokio::spawn({
            let index = self.index.clone();
            let chain = self.chain.clone();
            let config = self.config.sync.clone();
            async move {
                run_anchor_loop(index, chain, &config).await
            }
        });

        let api_handle = tokio::spawn({
            let index = self.index.clone();
            let storage = self.storage.clone();
            let bind = format!("{}:{}", self.config.bind_address, self.config.bind_port);
            async move {
                let router = build_router(index, storage);
                let listener = tokio::net::TcpListener::bind(&bind).await?;
                axum::serve(listener, router).await
            }
        });

        // All four tasks run indefinitely. If any exits, shut down.
        tokio::select! {
            result = chain_handle => {
                tracing::error!("chain listener exited: {:?}", result);
            }
            result = ingest_and_sync_handle => {
                tracing::error!("ingest & sync exited: {:?}", result);
            }
            result = anchor_handle => {
                tracing::error!("anchor loop exited: {:?}", result);
            }
            result = api_handle => {
                tracing::error!("API server exited: {:?}", result);
            }
        }

        Ok(())
    }
}
```

## Indexer Economics

Indexing is a service, not a protocol role — the protocol cannot verify "this indexer served correct, complete results to that client", so indexer payment is **market-enforced, not consensus-enforced**. This is a deliberate design position:

- **Hosting is part of the priced service, not a new layer**: an indexer stores what it serves, so hot storage is already covered by the query-fee market — no separate storage token, no staking. Full (registered) indexers replicate the entire **text** corpus as the normative expectation (it is small — a few hundred GB at very large scale — and it *is* the product); at roughly ~1 GB/day of text network-wide this adds no new economic layer. Priced **retention** applies to media blobs and to light/specialized indexers that choose not to hold everything (retention terms are a market feature; see `docs/12 §3` and 02).
- **What the protocol contributes**: Y as the low-friction payment rail, and the spot-check verifiability that turns service quality into something clients can measure. Detection → reputation → churn is the enforcement mechanism, the same one every service market (RPC providers, ISPs) runs on.
- **Payment mechanics (convention, not consensus)**: clients pay per-query with signed vouchers — small signed IOUs accumulated off-chain and settled in Y on-chain periodically — or buy a subscription for an epoch. The reference client speaks Y-vouchers natively; keeping that the zero-friction default is what keeps Y the de facto unit of account, since nothing at the protocol level prevents an indexer charging out-of-band.
- **What was rejected**: a Reward Pool slice for indexers ("proof of indexing" is either gameable or requires The Graph-scale staking/slashing/dispute machinery — disproportionate for a social network), and free-rider reliance on altruism (the Nostr relay experience: chronically underfunded infrastructure drifts toward corporate subsidy and the influence-monetization incentive).
- **Cost profile**: candidate serving and data queries are cheap and commodity-priced; server-side ranked feeds for thin clients are the premium tier. Running an indexer must stay within hobbyist reach — that, plus verifiability, is what keeps the market competitive rather than oligopolistic.

## Trust Model Summary

The indexer is an **untrusted convenience layer**. Its trust model is:

| Property | Guarantee |
|---|---|
| **Data integrity** | Every indexed content item is a signed, content-addressed object: it hashes to its own address and carries its author's signature. Every indexed economic event traces back to an on-chain transaction. Clients verify any item via the spot-check API (re-verifying the raw signed object locally), by cross-checking a second indexer, or by querying the blockchain — no trusted source is required. |
| **Completeness** | NOT guaranteed by a single indexer, but omission is maximally detectable: since full indexers replicate the whole text corpus, any peer can produce a missing item **plus its anchor proof**, publicly demonstrating the omission. Omission disputes therefore carry anchor proofs as evidence. Clients detect gaps by querying multiple indexers. |
| **Timestamp provability** | An indexer periodically anchors a Merkle root of newly indexed content addresses on-chain (`AnchorLog`, `docs/12 §4`). A Merkle branch to an anchored root proves a post existed before that block; an optional `freshness_anchor` proves it was created after one. Anchors from indexers that later disappear remain valid forever, so prior timestamps stay provable. |
| **Ranking fairness** | NOT guaranteed. An indexer may bias feed rankings. Clients can request `Chronological` ranking as a neutral baseline. |
| **Moderation accuracy** | Subjective by design. Each indexer applies its own moderation policy. Clients choose the indexer whose policy they agree with. |
| **Donor recognition** | Derived and subjective, like moderation — NOT part of the economic-accuracy guarantee. Badges, thread-scoped superchat prominence, and per-creator leaderboards are presentation conventions, not protocol, and confer no on-chain rights. The underlying donation totals they summarize are verifiable against the chain, but their display (tier cutoffs, prominence weighting, thread-local ordering) is the indexer's choice; a different indexer may show them differently or not at all. |
| **Economic accuracy** | On-chain events are the source of truth for bonds, donations, emissions, transfers, handle rent, referral routing, and Reward Pool / Treasury flows. The indexer merely mirrors this data for queryability. Any discrepancy can be detected by checking the chain directly. |
| **Availability & durability** | NOT guaranteed by any single indexer. Durability comes from independently chosen indexers + the author's local copy + trustless third-party mirrors (mirroring is trustless because objects are self-authenticating) + permissionless republication — any dropped indexer is a re-publish event, not data loss. No storage venue is normative; out-of-protocol archival services may exist but none is required. |
| **Censorship-resistance** | Suppressing a user requires suppressing **every** indexer AND their permissionless ability to republish (from a local copy, to any indexer, including one they run themselves); anchors keep prior timestamps provable forever. |
