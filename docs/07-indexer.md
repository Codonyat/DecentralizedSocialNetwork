# Verifiable Indexer Service (`dsn-indexer`)

## Purpose

Signed content objects carry no query capability on their own. Clients cannot ask a raw object stream "give me Alice's feed" or "search for posts about Rust." The indexer bridges this gap: it ingests client-published signed objects, syncs the corpus from peer indexers, listens to blockchain events, builds queryable indices locally, and exposes a REST API for clients. Indexers double as the network's hot storage — they store what they serve (see `docs/12-storage-and-anchoring.md`, which governs storage semantics).

Because ALL source content is a signed, content-addressed object (posts, mutable records, signed edges) and all economic activity (tips, stakes, like settlements, issuance, transfers) is recorded on-chain, any indexer output can be independently verified against the source. This makes indexers **verifiable**: verifiability = local signature verification (every object carries its author's signature and hashes to its own address) + cross-indexer checks + anchor proofs (`docs/12`) that bind a post to a provable existed-before time. Clients spot-check any result the indexer returns by re-verifying the underlying signed object, cross-checking a second indexer, or querying the blockchain.

Multiple competing indexers can run simultaneously. No single indexer can censor content without clients noticing — they simply switch to a different indexer, verify signatures locally, or re-publish from their own local copy.

## Module Structure

```
crates/indexer/src/
├── lib.rs              # Re-exports, IndexerService construction
├── config.rs           # Configuration: sync settings, chain settings, label policy, storage paths
├── chain_listener.rs   # Listens to blockchain events, populates local index
├── ingest.rs           # Ingest & sync: verify + store published objects, backfill from peers, anchor loop
├── publish.rs          # POST /publish handler: signature-verified object intake
├── stream.rs           # GET /stream handler: ordered object stream for peer backfill
├── store.rs            # Local index storage (SQLite-backed)
├── models.rs           # Internal data model: indexed posts, profiles, engagement
├── api/
│   ├── mod.rs          # Axum router assembly
│   ├── feeds.rs        # GET /feeds/:user_pk, /candidates/:user_pk — home feed, timeline, budget recall
│   ├── explore.rs      # GET /explore?topic= — labelled exploration slot (topic indexers)
│   ├── profiles.rs     # GET /profiles/:user_pk — profile + stats, vouches
│   ├── posts.rs        # GET /posts/:address — single post + thread
│   ├── search.rs       # GET /search?q=... — full-text search
│   ├── engagement.rs   # GET /engagement/:post_address, /posts/:address/{likes,tips}, /users/:pk/tips
│   ├── labels.rs       # GET /labels/:address — raw labels + this indexer's visibility verdict
│   ├── names.rs        # GET /names/:handle — handle resolution + lifecycle state
│   ├── epoch.rs        # GET /epoch — issuance, fee pool, stake totals, treasury
│   ├── economy.rs      # GET /users/:pk/economy — balance, stake, power, unclaimed rewards, genesis
│   ├── creators.rs     # GET /creators/:pk/supporters — supporter recognition (not protocol)
│   ├── spotcheck.rs    # GET /spotcheck/... — raw signed object + signature proof; anchor branch
│   └── health.rs       # GET /health — indexer status, ingest stats
├── feed_builder.rs     # Feed ranking: chronological, budget
├── budget.rs           # Attention budget + why-paths (algorithm canonical in 09)
└── error.rs            # Indexer error types
```

## Chain Listener (`chain_listener.rs`)

The chain listener subscribes to blockchain events and populates the local index with on-chain activity. This is the authoritative source for all economic data (tips, stakes, like settlements, issuance, genesis claims, transfers, handle lifecycle events, and fee pool state).

### Event Types

The listener processes the following on-chain events:

Variant names and payload fields below are canonical in `docs/01-core-types.md`; this table and the match arms mirror them field-for-field. Every fee-bearing event (`Tip` / `TipEscrowed` `protocol_fee`, `NameRentPaid` `amount`, `ForceBuyInitiated` `fee_to_pool`) routes its fee to the fee pool in full; the listener adds it to the fee-pool mirror, and each `EpochAdvanced` resets the mirror to the authoritative `fee_pool_balance`. `y_balance` mirrors YToken `Transfer` events only (every balance movement emits one — mints from the zero address, stake and escrow custody, fee-pool payouts), so the economic arms below record their own tables and never touch balances; nothing is counted twice.

| Event | Description | Index Action |
|---|---|---|
| **Transfer** | Y moved between accounts (mints from the zero address; contract custody included) | `transfer_y_balance` |
| **Tip** | A tip to an identity, optionally on a post: `protocol_fee` (1%, rounded up) → fee pool, `facilitator_fee` (0–5%, payer-authorized) → the originating client/indexer, the rest → `recipient` (03 §C) | `record_tip`, `add_fee_pool_inflow` |
| **TipEscrowed** | A tip to a foreign key (Ethereum address): fees taken on the gross `amount`; the escrow holds the net `escrowed` until `refund_after` | `open_tip_escrow`, `add_fee_pool_inflow` |
| **TipEscrowClaimed** | The foreign key's owner claims the net escrow to `destination` | `claim_tip_escrow` (the tip now counts toward `destination`) |
| **TipEscrowRefunded** | Unclaimed after 30 days; the net refunds to the tipper | `refund_tip_escrow` |
| **Staked** | Y deposited into the Like contract; its power starts empty | `record_stake` |
| **UnstakeRequested** | Withdrawal requested; regeneration stops on `amount`, stored power clamps to the new cap | `request_unstake` |
| **Unstaked** | Withdrawal completed after the unstake delay | `record_unstake` |
| **LikesSettled** | A staker's daily like batch landed: `power_spent` (= Σ `allocations`) credited to each recipient for `epoch` | `record_settlement` |
| **CreatorRewardsClaimed** | A creator pulled its issuance (`minted`) and `fee_reward` for a closed epoch | `record_creator_claim` |
| **GenesisActivated** | An eligible foreign key activated its genesis entitlement to an account | `ensure_user_known`, `record_genesis_activation` |
| **GenesisTrancheClaimed** | An account claimed its tranche within that tranche's epoch | `record_genesis_tranche` |
| **EntitlementSplit** | Nominal genesis entitlement moved between accounts, counted from `effective_epoch` (future tranches only) | `ensure_user_known`, `record_entitlement_split` |
| **EpochAdvanced** | Epoch boundary crossed (lazily, by the first transaction after it): the closed epoch's power spent, stake-time, mint budget, fee drip and fee reserve; current pool balance, mint rate, base rent | `record_epoch_close` (`epochs` row + `economy` snapshot) |
| **NameClaimed** | User claims an unowned @handle (sets assessed value, pays first-epoch rent) | `upsert_name` |
| **AssessmentChanged** | Owner changes a handle's assessed value (decreases take effect after the lookback window) | `update_name_assessment` |
| **NameRentPaid** | Handle rent paid through an epoch (`amount` → fee pool) | `record_rent_payment`, `add_fee_pool_inflow` |
| **ForceBuyInitiated** | A Harberger-tier handle receives a force-buy bid (`fee_to_pool` → fee pool) | `mark_force_buy`, `add_fee_pool_inflow` |
| **NameTransferred** | Handle ownership changes (force-buy completes or manual transfer; any fee reaches the fee pool and shows in the next `fee_pool_balance`) | `transfer_name` (appends to `name_history`) |
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
    match event {
        // --- Balances (the only source of y_balance) ---
        ChainEvent::Transfer { from, to, amount } => {
            index.transfer_y_balance(from, to, *amount).await?;
        }

        // --- Tips (03 §C; protocol fees feed the fee pool) ---
        ChainEvent::Tip { tipper, recipient, post_hash, amount, protocol_fee, facilitator, facilitator_fee } => {
            // recipient receives amount − protocol_fee − facilitator_fee.
            index.record_tip(tipper, recipient, post_hash.as_ref(), *amount, *protocol_fee,
                             facilitator.as_ref(), *facilitator_fee).await?;
            index.add_fee_pool_inflow(*protocol_fee).await?;
        }
        ChainEvent::TipEscrowed { escrow_id, tipper, recipient_key, post_hash, amount, protocol_fee,
                                  facilitator, facilitator_fee, escrowed, refund_after } => {
            // Fees are taken at escrow time on the gross amount; the escrow holds the net.
            index.open_tip_escrow(*escrow_id, tipper, recipient_key, post_hash.as_ref(), *amount,
                                  *protocol_fee, facilitator.as_ref(), *facilitator_fee,
                                  *escrowed, *refund_after).await?;
            index.add_fee_pool_inflow(*protocol_fee).await?;
        }
        ChainEvent::TipEscrowClaimed { escrow_id, destination, amount } => {
            index.claim_tip_escrow(*escrow_id, destination, *amount).await?;
        }
        ChainEvent::TipEscrowRefunded { escrow_id, tipper, amount } => {
            index.refund_tip_escrow(*escrow_id, tipper, *amount).await?;
        }

        // --- Like power (03 §B; the store replays each staker's PowerMeter) ---
        ChainEvent::Staked { staker, amount } => {
            index.record_stake(staker, *amount).await?;
        }
        ChainEvent::UnstakeRequested { staker, amount, available_at } => {
            index.request_unstake(staker, *amount, *available_at).await?;
        }
        ChainEvent::Unstaked { staker, amount } => {
            index.record_unstake(staker, *amount).await?;
        }
        ChainEvent::LikesSettled { staker, nonce, epoch, n_likes, power_spent, allocations } => {
            // power_spent = Σ allocations; each allocation is `received` for `epoch`.
            index.record_settlement(staker, *nonce, *epoch, *n_likes, *power_spent, allocations).await?;
        }
        ChainEvent::CreatorRewardsClaimed { creator, epoch, minted, fee_reward } => {
            index.record_creator_claim(creator, *epoch, *minted, *fee_reward).await?;
        }

        // --- Genesis (03 §A) ---
        ChainEvent::GenesisActivated { key, cohort, account, entitlement } => {
            index.ensure_user_known(account).await?;
            index.record_genesis_activation(key, *cohort, account, *entitlement).await?;
        }
        ChainEvent::GenesisTrancheClaimed { account, epoch, amount } => {
            index.record_genesis_tranche(account, *epoch, *amount).await?;
        }
        ChainEvent::EntitlementSplit { from, to, amount, effective_epoch } => {
            index.ensure_user_known(to).await?;
            index.record_entitlement_split(from, to, *amount, *effective_epoch).await?;
        }

        // --- Epoch close (authoritative snapshot; resets the fee-pool mirror) ---
        ChainEvent::EpochAdvanced { epoch, closed_power_spent, closed_stake_time, closed_mint_budget,
                                    closed_fee_drip, closed_fee_reserved, fee_pool_balance,
                                    mint_rate_ppb, base_rent } => {
            index.record_epoch_close(*epoch, *closed_power_spent, *closed_stake_time,
                                     *closed_mint_budget, *closed_fee_drip, *closed_fee_reserved,
                                     *fee_pool_balance, *mint_rate_ppb, *base_rent).await?;
        }

        // --- Handle lifecycle events (six events; see 01/03 for the on-chain model) ---
        ChainEvent::NameClaimed { owner, handle, assessed_value, epoch, .. } => {
            index.upsert_name(owner, handle, *assessed_value, *epoch).await?;
        }
        ChainEvent::AssessmentChanged { handle, new_value, effective_epoch, .. } => {
            index.update_name_assessment(handle, *new_value, *effective_epoch).await?;
        }
        ChainEvent::NameRentPaid { handle, amount, paid_through_epoch, .. } => {
            index.record_rent_payment(handle, *paid_through_epoch).await?;
            index.add_fee_pool_inflow(*amount).await?;
        }
        ChainEvent::ForceBuyInitiated { handle, bidder, bid, deadline_epoch, fee_to_pool } => {
            index.mark_force_buy(handle, bidder, *bid, *deadline_epoch).await?;
            index.add_fee_pool_inflow(*fee_to_pool).await?;
        }
        ChainEvent::NameTransferred { handle, from, to } => {
            // Appends the prior owner's span to name_history, then sets the new owner.
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
```

## Ingest & Sync (`ingest.rs`, `publish.rs`, `stream.rs`)

Content reaches an indexer two ways: clients **publish** their signed objects directly (`POST /api/v1/publish`), and indexers **sync** the corpus from peers (`GET /api/v1/stream?cursor=`). There is no polling of a storage network — the indexer stores what it serves. Content handling never touches economic data (tips, balances, stakes, issuance); that stays the chain listener's responsibility. A Like object is content: it moves money only when a settlement lands on-chain as `LikesSettled`, and the indexer never infers a payout from Like objects.

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

Indexers replicate the full text corpus (posts, profiles, follow graph, likes, vouches, power delegations, labels, retract tombstones) from one another. The stream is an ordered feed of signed objects; the `cursor` is the caller's last-seen position, and anchor roots serve as checkpoint markers within it — so "give me everything since root R" is the cursor contract. Every streamed item is verified **item-by-item** exactly as in publish intake (signatures and addresses are self-checking), so a peer cannot inject forgeries. Discovery of new authors comes from ingested **Vouch** objects (each names a voucher and a vouchee), from registry and stake events on-chain (`KeyRotated`, `GuardiansSet`, `Staked`, `GenesisActivated`, …), and from peer exchange; there is no follow-list walk or priority queue.

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

A signed **retract** tombstone (see 02 Privacy & Data Lifecycle) is ingested and streamed like any other object. A compliant indexer stops serving the retracted target, renders a thread placeholder in its place, and MAY drop the stored bytes; any label-derived visibility verdict on the retracted content becomes moot. Retracts appear in `GET /api/v1/stream` alongside every other object so peers converge on the same tombstone. Honoring a retract is a convention, not consensus — a mirror MAY retain bytes (stated honestly). Un-liking is a retract of the Like object: the like leaves `like_count` and every graph count; any power already settled for it stays settled.

### Likes, vouches and delegations

`Like`, `Vouch` and `PowerDelegation` (types in 01 `like.rs` / `vouch.rs`; semantics canonical in 05) are signed objects ingested, verified and streamed like posts, then indexed:

- **Like** — one per `(liker, target)`, first-seen wins (ties broken by lowest object hash, as for labels). `recipients` is empty (100% to the author) or sums to 10_000 bps; otherwise the object is rejected (`400`). A `sponsor` is valid only under a live PowerDelegation (sponsor → liker, 01); a Like whose delegation this indexer has not yet seen is quarantined until the delegation arrives through publish or peer sync. A Like is a ranking edge whatever the liker holds: it counts in `graph_likes` for every viewer whose budget graph contains the liker, and nowhere else (09).
- **Vouch** — both signatures verified (`voucher_signature` by the voucher, `signature` by the vouchee, whose publishing is the acceptance); one per `(voucher, vouchee)`, first-seen wins (05). Feeds `vouched_by_count`, `GET /api/v1/profiles/:user_pk/vouches`, and author discovery.
- **PowerDelegation** — signed by the sponsor; the latest `expires_epoch` per `(sponsor, delegate)` is kept. Used only to validate `Like.sponsor`; the sponsor's own settlement spends the power (03 §B), so the indexer holds no allowance state.

## Internal Data Model (`models.rs`, `store.rs`)

### What Gets Indexed

The indexer builds a local relational index from two sources: ingested signed content objects (posts, records, edges, likes, vouches, delegations, labels — from client publishes and peer sync), and on-chain economic events. The local store uses SQLite for persistence across restarts.

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
    /// Distinct accounts vouching for this user (from ingested Vouch objects, 05).
    pub vouched_by_count: u32,
    /// Token state (from on-chain events). `y_balance` is liquid Y (Transfer
    /// events only); `stake` is eligible stake in the Like contract.
    pub y_balance: u64,
    pub y_nonce: u64,
    pub stake: u64,
    /// Aggregate tip stats (from on-chain events). Received is net (Σ
    /// `recipient_amount`, claimed escrows included); given is gross (Σ `amount`).
    pub tips_received: u64,
    pub tips_given: u64,
    /// Advisory status score computed by THIS indexer from public likes under
    /// its own policy (05 Aura). Never a ranking, reach or money input.
    pub aura: Option<u64>,
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
    /// Repost/quote target (mirrors `Post.repost_of` from 01). Set = this post
    /// reposts or quotes another; `reply_to` and `repost_of` are mutually
    /// exclusive. Reposts flow through feeds/candidates as ordinary posts.
    pub repost_of: Option<ContentAddress>,
    /// Number of posts that repost or quote this post (from ingested reposts).
    pub repost_count: u64,
    /// Sequence in author's post history.
    pub sequence: u64,
    /// Timestamp (informational).
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Network-wide engagement counts: DISPLAY data, not default ranking
    /// features (09 ranks on the viewer-relative `graph_likes` /
    /// `graph_tippers` served with candidates).
    pub like_count: u64,              // live Like objects (retracts removed)
    pub tip_total: u64,               // gross atomic Y (on-chain tips, claimed escrows included)
    pub unique_tippers: u32,
    /// Label state: count of distinct labels applied to this post and this
    /// indexer's local, non-normative visibility verdict derived from them.
    pub label_count: u32,
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
    pub like_count: u64,
    pub tip_total: u64,
    pub unique_tippers: u32,
    pub tips: Vec<IndexedTip>,
}

/// A like as indexed (the signed Like object is canonical, 01 `like.rs`).
pub struct IndexedLike {
    pub address: ContentAddress,               // the Like object's content address
    pub liker: IdentityId,
    pub target: ContentAddress,
    pub recipients: Vec<(IdentityId, u16)>,    // empty = 100% to the author
    pub sponsor: Option<IdentityId>,
    pub claimed_epoch: u64,
}

/// A tip as indexed from Tip / TipEscrowed (+ claim / refund) events. All
/// amounts atomic Y; `recipient_amount = amount − protocol_fee − facilitator_fee`.
pub struct IndexedTip {
    pub tipper: IdentityId,
    pub recipient: TipRecipient,               // as sent (01 token.rs); Foreign for escrowed tips
    pub post: Option<ContentAddress>,
    pub amount: u64,                           // gross
    pub protocol_fee: u64,
    pub facilitator: Option<PublicKey>,
    pub facilitator_fee: u64,
    pub recipient_amount: u64,
    pub escrow: Option<TipEscrowState>,        // Some for tips to a foreign key
    pub block_number: u64,
}

pub enum TipEscrowState {
    Open { escrow_id: u64, refund_after: u64 },
    Claimed { escrow_id: u64, destination: IdentityId },
    Refunded { escrow_id: u64 },
}

pub enum TipDirection {
    Received,
    Given,
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

/// This indexer's LOCAL, NON-NORMATIVE visibility decision for a target,
/// derived from the public label record under this indexer's own policy (see
/// 06 Content Labels). The protocol mandates nothing here; another indexer may
/// decide differently, and a client can recompute or override it.
#[derive(Clone, Serialize, Deserialize)]
pub enum ModerationVerdict {
    /// No labels above policy thresholds; content visible.
    Clean,
    /// Labeled but below the hide threshold; content visible with warning.
    Warned { label_count: u32 },
    /// Labels exceed the hide threshold; content hidden by this indexer.
    Hidden { label_count: u32 },
}

/// Handle pricing tier, derived from handle length (see 03 §D Name Registry).
#[derive(Clone, Serialize, Deserialize)]
pub enum HandleTier {
    /// Length 1–6: Harberger tax on the assessed value; force-buyable.
    Harberger,
    /// Length ≥ 7: pays the controller-set base rent per epoch (03 §D); no force-buy (safe harbor).
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
| `users` | `public_key` | User profiles, stats, token balances, stake, tip totals, advisory aura |
| `posts` | `address` | Post content, engagement counts |
| `follows` | `(follower, followee)` | Follow relationships (the budget graph's edges) |
| `likes` | `(liker, target)` | Like objects (first-seen wins; a retract removes the row): recipients, sponsor, object address |
| `vouches` | `(voucher, vouchee)` | Vouch objects (first-seen wins, 05) |
| `delegations` | `(sponsor, delegate)` | PowerDelegation objects (latest `expires_epoch` kept); validates `Like.sponsor` |
| `tips` | `(block_number, log_index)` | Tip records (from chain): tipper, recipient, post, gross amount, protocol and facilitator fees, net amount |
| `tip_escrows` | `escrow_id` | Foreign-key escrows: recipient key, net `escrowed`, `refund_after`, state (open / claimed to a destination / refunded) |
| `stakes` | `staker` | Mirrored `PowerMeter` per staker (eligible stake, pending unstake, `available_at`, stored power, last update, settle nonce) |
| `settlements` | `(staker, nonce)` | LikesSettled batches: epoch, `n_likes`, `power_spent`, allocations |
| `creator_rewards` | `(creator, epoch)` | Power `received` per closed epoch (Σ settled allocations) and what was claimed (`minted`, `fee_reward`) |
| `genesis` | `account` | Activation (foreign key, cohort, entitlement), nominal entitlement after splits, tranches claimed |
| `epochs` | `epoch` | Per-epoch EpochAdvanced totals (power spent, stake-time, mint budget, fee drip, fee reserve) — the denominators for creator claims |
| `economy` | singleton | Current epoch, mint rate, minted total, issuance capacity, fee pool balance, last fee drip / reserve, base rent, total stake, treasury balance |
| `names` | `handle` | Current handle ownership: owner, assessed value, tier, rent status, last-paid epoch, force-buy state (from chain) |
| `name_history` | `(handle, claimed_at_epoch)` | Past ownership spans of a handle ("formerly @x") |
| `supporters` | `(creator, supporter)` | Per-creator lifetime tip totals — supporter recognition (derived from `tips`) |
| `reply_links` | `(parent_address, child_address)` | Thread structure |
| `labels` | `(author, target, label)` | Content labels (signed objects; one per `(author, target, label)`, first-seen wins) |
| `identities` | `identity_id` | Registry mirror: current key, key history (with per-key revocation block), guardians/threshold, active recovery proposal |
| `chain_state` | singleton | Last indexed block number, block hashes for reorg detection |
| `ingest_state` | `identity_id` | Per-user ingest metadata (last indexed at, mutable-record versions) |
| `sync_cursors` | `peer_url` | Last-seen stream cursor / anchor-root checkpoint per peer indexer |
| `peers` | `peer_url` | Known peer indexers for backfill and object exchange |
| `anchors` | `(root, address)` | Merkle branches for anchored content addresses (served lazily via spotcheck/anchor) |
| `quarantine` | `address` | Stored-not-served objects awaiting a pre-revocation anchor/on-chain proof, or a Like awaiting its PowerDelegation |
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
    /// Record a verified Label object into the `labels` table (one per
    /// (author, target, label); first-seen wins, ties broken by lowest object
    /// hash — see 06 Content Labels).
    async fn store_label(&self, label: &Label) -> Result<(), IndexerError>;
    /// Record this indexer's local, non-normative visibility verdict for a
    /// target, computed from its labels under the operator's policy.
    async fn update_moderation_verdict(&self, post: &ContentAddress,
                                        verdict: ModerationVerdict) -> Result<(), IndexerError>;
    /// Record a verified Like (one per (liker, target); first-seen wins, ties
    /// broken by lowest object hash). Maintains `like_count`.
    async fn store_like(&self, like: &Like) -> Result<(), IndexerError>;
    /// Record a verified Vouch (one per (voucher, vouchee); first-seen wins — 05).
    async fn store_vouch(&self, vouch: &Vouch) -> Result<(), IndexerError>;
    /// Record a verified PowerDelegation (latest `expires_epoch` per (sponsor, delegate)).
    async fn store_delegation(&self, delegation: &PowerDelegation) -> Result<(), IndexerError>;
    /// Store a verified, servable signed object (highest valid version wins).
    async fn store_object(&self, object: &SignedObject) -> Result<(), IndexerError>;
    /// Store a revoked-key object that lacks a pre-revocation proof: kept but not served.
    async fn quarantine_object(&self, object: &SignedObject) -> Result<(), IndexerError>;
    /// Resolve an author-identity's non-revoked key history + revocation blocks,
    /// used by ingest to verify signatures (rotation never invalidates; the
    /// revocation transaction's block is the only cutoff — see 01/A8/B1).
    async fn author_keys(&self, identity: &IdentityId) -> Result<AuthorKeys, IndexerError>;

    // --- Write operations (used by chain listener). All atomic Y amounts and
    // power / stake-time values are u64; every row is stamped with its event's
    // block (number, timestamp) for rollback and meter replay. ---
    /// Mirror a YToken Transfer (the only source of `y_balance`); a transfer
    /// from the zero address is a mint (no debit).
    async fn transfer_y_balance(&self, from: &IdentityId, to: &IdentityId, amount: u64) -> Result<(), IndexerError>;
    // Tips (03 §C).
    async fn record_tip(&self, tipper: &IdentityId, recipient: &IdentityId,
                        post: Option<&ContentAddress>, amount: u64, protocol_fee: u64,
                        facilitator: Option<&PublicKey>, facilitator_fee: u64) -> Result<(), IndexerError>;
    async fn open_tip_escrow(&self, escrow_id: u64, tipper: &IdentityId, recipient_key: &ForeignKey,
                             post: Option<&ContentAddress>, amount: u64, protocol_fee: u64,
                             facilitator: Option<&PublicKey>, facilitator_fee: u64,
                             escrowed: u64, refund_after: u64) -> Result<(), IndexerError>;
    /// Marks the escrow claimed; the tip counts toward `destination` from here on.
    async fn claim_tip_escrow(&self, escrow_id: u64, destination: &IdentityId, amount: u64) -> Result<(), IndexerError>;
    async fn refund_tip_escrow(&self, escrow_id: u64, tipper: &IdentityId, amount: u64) -> Result<(), IndexerError>;
    // Like power (03 §B). Each call first replays `accrue(meter, block_timestamp)`
    // on the mirrored PowerMeter, then applies the event.
    async fn record_stake(&self, staker: &IdentityId, amount: u64) -> Result<(), IndexerError>;
    async fn request_unstake(&self, staker: &IdentityId, amount: u64, available_at: u64) -> Result<(), IndexerError>;
    async fn record_unstake(&self, staker: &IdentityId, amount: u64) -> Result<(), IndexerError>;
    /// Debit the staker's mirrored meter by `power_spent` and add each
    /// allocation to `creator_rewards[(recipient, epoch)].received`.
    async fn record_settlement(&self, staker: &IdentityId, nonce: u64, epoch: u64, n_likes: u32,
                               power_spent: u64, allocations: &[(IdentityId, u64)]) -> Result<(), IndexerError>;
    /// Record a pulled reward; `minted` also adds to the economy's minted total.
    async fn record_creator_claim(&self, creator: &IdentityId, epoch: u64, minted: u64,
                                  fee_reward: u64) -> Result<(), IndexerError>;
    // Genesis (03 §A).
    async fn record_genesis_activation(&self, key: &ForeignKey, cohort: u8, account: &IdentityId,
                                       entitlement: u64) -> Result<(), IndexerError>;
    /// `amount` also adds to the economy's minted total.
    async fn record_genesis_tranche(&self, account: &IdentityId, epoch: u64, amount: u64) -> Result<(), IndexerError>;
    async fn record_entitlement_split(&self, from: &IdentityId, to: &IdentityId, amount: u64,
                                      effective_epoch: u64) -> Result<(), IndexerError>;
    /// Add a protocol fee (tip, escrowed tip, rent, force-buy) to the fee-pool mirror.
    async fn add_fee_pool_inflow(&self, fee: u64) -> Result<(), IndexerError>;
    /// Snapshot EpochAdvanced: writes the `epochs` row, resets the fee-pool
    /// mirror to `fee_pool_balance`, subtracts `closed_mint_budget` from the
    /// issuance capacity (the budget is reserved at close, claimed or not), and
    /// stores `mint_rate_ppb` and `base_rent`.
    async fn record_epoch_close(&self, epoch: u64, closed_power_spent: u64, closed_stake_time: u64,
                                closed_mint_budget: u64, closed_fee_drip: u64,
                                closed_fee_reserved: u64, fee_pool_balance: u64,
                                mint_rate_ppb: u64, base_rent: u64) -> Result<(), IndexerError>;
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
    async fn get_home_feed(&self, pk: &PublicKey, cursor: Option<u64>, limit: u32,
                           ranking: FeedRanking, explore_topics: &[String]) -> Result<Vec<FeedEntry>, IndexerError>;
    async fn search_posts(&self, query: &str, cursor: Option<u64>,
                          limit: u32) -> Result<Vec<IndexedPost>, IndexerError>;
    async fn get_engagement(&self, post: &ContentAddress) -> Result<IndexedEngagement, IndexerError>;
    async fn get_likes_for_post(&self, post: &ContentAddress, cursor: Option<u64>,
                                limit: u32) -> Result<Vec<IndexedLike>, IndexerError>;
    async fn get_tips_for_post(&self, post: &ContentAddress, cursor: Option<u64>,
                               limit: u32) -> Result<Vec<IndexedTip>, IndexerError>;
    async fn get_tips_for_user(&self, pk: &IdentityId, direction: TipDirection,
                               cursor: Option<u64>, limit: u32) -> Result<Vec<IndexedTip>, IndexerError>;
    /// Follow edges out to `hops` from `viewer` (the input `attention_budget` walks).
    async fn get_follow_subgraph(&self, viewer: &IdentityId, hops: usize)
        -> Result<HashMap<IdentityId, Vec<IdentityId>>, IndexerError>;
    /// An account's own items since `since_epoch`: the posts, repost objects and
    /// quote posts it signed (09: every budget item is signed by `hops.last()`),
    /// each tagged with its `Via`. A repost object carries its target in `repost_of`.
    async fn get_own_items(&self, account: &IdentityId, since_epoch: u64)
        -> Result<Vec<(IndexedPost, Via)>, IndexerError>;
    /// Distinct likers and distinct tippers of `post` among `graph` (each account
    /// counted once) → (`graph_likes`, `graph_tippers`).
    async fn graph_engagement(&self, post: &ContentAddress, graph: &HashSet<IdentityId>)
        -> Result<(u32, u32), IndexerError>;
    /// Posts whose `mentions` include `pk` (notifications view only).
    async fn get_mentions(&self, pk: &IdentityId, since_epoch: u64,
                          limit: u32) -> Result<Vec<IndexedPost>, IndexerError>;
    /// Exploration items for a topic this indexer declares (its own policy).
    async fn get_explore(&self, topic: &str, cursor: Option<u64>,
                         limit: u32) -> Result<Vec<IndexedPost>, IndexerError>;
    async fn get_vouches(&self, pk: &IdentityId, cursor: Option<u64>,
                         limit: u32) -> Result<VouchSet, IndexerError>;
    /// Per-user economy (backs `GET /api/v1/users/:pk/economy`); `now` is the
    /// latest indexed block timestamp.
    async fn get_user_economy(&self, pk: &IdentityId, now: u64) -> Result<UserEconomy, IndexerError>;
    /// Raw public label record for a target (all labels applied to it), backing
    /// `GET /api/v1/labels/:address`.
    async fn get_labels(&self, target: &ContentAddress) -> Result<Vec<Label>, IndexerError>;
    async fn get_moderation_status(&self, post: &ContentAddress) -> Result<ModerationVerdict, IndexerError>;
    /// Posts carrying at least `min_count` instances of `label`.
    async fn get_labeled_posts(&self, label: &str, min_count: u32, cursor: Option<u64>,
                                limit: u32) -> Result<Vec<IndexedPost>, IndexerError>;
    /// Resolve a handle to its current owner plus lifecycle state and ownership history.
    async fn resolve_name(&self, handle: &str) -> Result<Option<ResolvedHandle>, IndexerError>;
    /// Ownership history for a handle (most recent first), backing "formerly @x" hints.
    async fn name_history(&self, handle: &str) -> Result<Vec<HandleOwnership>, IndexerError>;
    /// Supporter recognition (NOT protocol): supporters of a creator, ranked by lifetime tipped.
    async fn get_creator_supporters(&self, creator: &PublicKey, cursor: Option<u64>,
                                    limit: u32) -> Result<Vec<Supporter>, IndexerError>;
    /// Top-N supporters of a creator (the leaderboard view).
    async fn get_supporter_leaderboard(&self, creator: &PublicKey,
                                       limit: u32) -> Result<Vec<Supporter>, IndexerError>;
    /// The `economy` snapshot (read path for CLI `epoch_info` and `GET /api/v1/epoch`).
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
    pub total_likes: u64,
    pub total_tips: u64,
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
    pub rent_per_epoch: u64,          // atomic Y; handle_rent_per_epoch(len, V, base_rent) (03 §D)
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

/// A supporter's cumulative tips to one creator (supporter recognition, derived).
pub struct Supporter {
    pub public_key: PublicKey,
    pub lifetime_tipped: u64,         // gross atomic Y, summed across all tips to the creator
    pub tip_count: u64,
}

/// Current epoch / issuance / fee-pool snapshot (the `economy` singleton).
/// Backs `GET /api/v1/epoch`. The first nine fields mirror the latest
/// EpochAdvanced field-for-field (`closed_*` describe the epoch that closed),
/// except `fee_pool_balance`, which adds fee inflows mirrored since; the last
/// four are derived by the indexer.
pub struct EpochInfo {
    pub epoch: u64,
    pub closed_power_spent: u64,      // Σ settled power (= Σ allocations) in the closed epoch
    pub closed_stake_time: u64,       // S_e, in power units
    pub closed_mint_budget: u64,      // atomic Y reserved for creator claims
    pub closed_fee_drip: u64,         // atomic Y = FEE_POOL_DRIP_BPS of the pool balance at close
    pub closed_fee_reserved: u64,     // drip × spent / max(S_e, spent), moved to the claim reserve
    pub fee_pool_balance: u64,        // last snapshot + fee inflows mirrored since
    pub mint_rate_ppb: u64,           // k for the current epoch
    pub base_rent: u64,               // atomic Y; flat-tier rent, Harberger floors are multiples
    pub minted_total: u64,            // Σ GenesisTrancheClaimed.amount + Σ CreatorRewardsClaimed.minted
    pub issuance_capacity: u64,       // SupplySchedule.issuance_capacity − Σ closed_mint_budget
    pub total_stake: u64,             // Σ Staked − Σ Unstaked (pending unstakes included)
    pub treasury_balance: u64,        // y_balance of the disclosed treasury account (03 §A)
}

/// Per-user economy. Backs `GET /api/v1/users/:pk/economy`. Power and
/// unclaimed rewards are recomputed with 03's formulas over mirrored events:
/// advisory, the Like contract is authoritative.
pub struct UserEconomy {
    pub identity_id: IdentityId,
    pub y_balance: u64,
    pub stake: u64,                   // eligible stake
    pub pending_unstake: u64,
    pub unstake_available_at: Option<u64>, // unix seconds (block time)
    pub power: u64,                   // accrue(meter, now) (03 §B)
    pub power_cap: u64,               // power_cap(stake) (03 §B)
    pub unclaimed: UnclaimedRewards,
    pub genesis: Option<GenesisStatus>,
}

/// Closed-epoch rewards not yet pulled (no expiry), per 03 §B creator claims:
/// minted = mint_budget_e × received / spent_e; fee = drip_e × received / max(S_e, spent_e).
pub struct UnclaimedRewards {
    pub minted: u64,
    pub fee_reward: u64,
    pub epochs: Vec<u64>,
}

pub struct GenesisStatus {
    pub key: Option<ForeignKey>,      // None when the entitlement arrived only by split
    pub cohort: Option<u8>,
    pub entitlement: u64,             // nominal, after splits in and out
    pub tranche_this_epoch: u64,      // genesis_tranche(entitlement, epoch) (03 §A)
    pub claimed_this_epoch: bool,     // missed tranches are never minted
    pub claimed_total: u64,
}

/// Vouches for and by one account (05). `address` is the Vouch object's
/// content address; clients re-verify both signatures from the raw object.
pub struct VouchSet {
    pub vouched_by: Vec<VouchEdge>,   // other party = voucher
    pub vouched_for: Vec<VouchEdge>,  // other party = vouchee
    pub next_cursor: Option<u64>,
    pub has_more: bool,
}

pub struct VouchEdge {
    pub address: ContentAddress,
    pub account: IdentityId,
    pub issued_epoch: u64,
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

## Feed Builder (`feed_builder.rs`, `budget.rs`)

Server-side ranked feeds exist for **thin clients** (low-power devices, simple integrations). The reference architecture ranks **client-side**: the indexer serves raw candidate sets (see the Candidates endpoint) and the client's local model does the ordering — see 09-client-ranking.md. Everything in this section except `budget.rs`, which also backs the Candidates endpoint, is the thin-client path.

### Feed Ranking Strategies

Clients choose a ranking strategy when requesting feeds:

```rust
#[derive(Clone, Serialize, Deserialize)]
pub enum FeedRanking {
    /// Reverse chronological over the follow list. No algorithmic sorting:
    /// the neutral baseline.
    Chronological,
    /// The default feed of 09: FEED_BUDGET of the page drawn from budget recall
    /// in proportion to `budget_share`, EXPLORE_BUDGET from labelled `/explore`
    /// items (see Attention Budget below).
    Budget,
}
```

Neither strategy reads stake, tips or network-wide like counts.

### Home Feed Construction

```rust
/// Build a home feed for a user.
pub async fn build_home_feed(
    index: &dyn IndexStore,
    user_pk: &IdentityId,
    ranking: FeedRanking,
    explore_topics: &[String],
    cursor: Option<u64>,
    limit: u32,
) -> Result<Vec<FeedEntry>, IndexerError> {
    // 1. Load the viewer's follow subgraph (MAX_BUDGET_HOPS deep for Budget,
    //    one hop for Chronological)
    // 2. Budget: attention_budget + budget_items; Chronological: followed users' posts
    // 3. Apply label-visibility filtering (hide posts per this indexer's label policy)
    // 4. Order by the selected strategy; Budget fills its EXPLORE_BUDGET slots from
    //    THIS indexer's own /explore for `explore_topics`, each labelled with
    //    provider and topic
    // 5. Paginate with cursor
    index.get_home_feed(user_pk, cursor, limit, ranking, explore_topics).await
}

/// One thin-client feed entry: a budget item carries its why-path, an
/// exploration item its label; a Chronological entry carries neither.
pub struct FeedEntry {
    pub post: IndexedPost,
    pub why_path: Option<WhyPath>,
    pub explore: Option<ExploreLabel>,
}

pub struct ExploreLabel {
    pub provider: String,
    pub topic: String,
}
```

The thin-client feed draws exploration only from the serving indexer's own topics. A viewer who wants competing topic indexers uses the client-side path: candidates from any indexer, plus `/explore` from the providers the viewer chose (09).

### Attention Budget (`budget.rs`)

Implements the conserved attention budget whose canonical specification is 09; where this summary and 09 differ, 09 wins. The constants are reference-client defaults, not protocol — conservation is the invariant.

```rust
/// Reference-client defaults (09).
pub const FEED_BUDGET: f64 = 0.80;      // split over the viewer's chosen sources
pub const EXPLORE_BUDGET: f64 = 0.20;   // labelled exploration from topic indexers
pub const OWN_ITEMS_SHARE: f64 = 0.50;  // part of a received share an account keeps for its own items
pub const MAX_BUDGET_HOPS: usize = 2;   // viewer → source → followee, no further

/// The item's relation to `hops.last()`, which signed it: no `repost_of` -> Post;
/// `repost_of` with empty content -> Repost (the account's own repost object);
/// with content -> Quote (01).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Via { Post, Repost, Quote }

#[derive(Clone, Serialize, Deserialize)]
pub struct WhyPath {
    pub hops: Vec<IdentityId>,  // [viewer, source] or [viewer, source, hop-2 account]
    pub via: Via,
}

pub struct PathBudget {
    pub hops: Vec<IdentityId>,  // as WhyPath::hops
    pub share: f64,             // fraction of the page
}

/// Exactly 09's function: pure, no I/O. `sources`: the viewer's follows with
/// weights (default 1.0). `follows(a)`: the signed FollowList of a. `has_items(a)`:
/// a signed posts/reposts/quotes in the window. Returns every non-empty path,
/// already renormalized: sum of shares == FEED_BUDGET, or empty if no path has items.
pub fn attention_budget(
    viewer: &IdentityId,
    sources: &[(IdentityId, f64)],
    follows: &dyn Fn(&IdentityId) -> Vec<IdentityId>,
    has_items: &dyn Fn(&IdentityId) -> bool,
) -> Vec<PathBudget>;

/// Attach each path's items (everything `hops.last()` signed in the window).
/// An item reachable by several paths is kept once, under its largest-share
/// path. Each item carries its PATH's share, not a per-item split: the client
/// allocates slots per path (09, Default feed composition).
pub fn budget_items(
    paths: &[PathBudget],
    items_of: &dyn Fn(&IdentityId) -> Vec<(ContentAddress, Via)>,
) -> Vec<(ContentAddress, f64, WhyPath)>;
```

Rules (09 canonical):

1. **Sources.** FEED_BUDGET is divided over `sources` in proportion to their weights — in the reference client, the viewer's follow list with equal weights. Each source sits at hop 1.
2. **Passing.** An account holding share `s` below MAX_BUDGET_HOPS keeps `OWN_ITEMS_SHARE × s` for its own items (posts, reposts, quotes) and splits the rest equally over the accounts it follows; at MAX_BUDGET_HOPS it keeps all of `s`.
3. **Dead edges.** An edge to the viewer, or back to an account already on the path, carries nothing; that part stays with the passer for its own items. Cycles therefore stop.
4. **Empty shares.** A share whose account has no items in the window is dropped and the remaining shares are renormalized to FEED_BUDGET; if no path is non-empty, the whole page is exploration.
5. **One entry per item.** An item reachable by several paths appears once, under the path with the largest share.
6. **Conservation.** Before renormalization the shares sum to exactly FEED_BUDGET and no share exceeds what its parent passed: splitting never increases a share, so creating accounts or edges cannot raise anyone's slice of a viewer's attention. This bounds outsiders; it does not stop accounts a viewer follows from colluding or selling endorsements (09).

**Money never enters recall.** No server path — feeds, candidates, search — reads stake, tips or network-wide like counts as a reach input. A like counts only in `graph_likes` for viewers whose budget graph contains the liker, so a whale's like pays the creator (03 §B) and reaches no one beyond the viewers who already route budget through the whale. Tip-based prominence applies only *within a single thread* (see Supporter Recognition below): a tip buys the tipper higher placement in the replies to the post they supported — nowhere else.

## Supporter Recognition (client/indexer convention — NOT protocol)

Supporter recognition is a **presentation layer** built entirely from public on-chain tips. It is emphatically **not** part of the protocol and confers **no** on-chain rights: a tip pays its recipient, minus the 1% protocol fee to the fee pool and any facilitator fee (03 §C), and nothing flows back to the tipper. These features are conventions an indexer or client *may* implement; a different indexer may ignore them, and because every number is recomputable from on-chain tips, any client can verify or reproduce them independently. A creator's lifetime totals count tips to its IdentityId plus escrowed tips once claimed to it; refunded escrows never count.

**Anonymous supporters.** A tip sent from a **fresh standalone key** pays the same fees and delivers the same net amount; only the link to the tipper's main identity is absent. Such tippers surface as **anonymous supporters**: the tip is visible (it is on-chain), but no badge, leaderboard entry, or thread prominence ties back to a real identity. Unlinkability is at the tip layer only — funding the fresh key is a public transfer, and the tipper pays its own gas (see 02).

### Thread-scoped superchat prominence

Within the replies to a given post, an indexer may rank a supporter's replies higher **in that thread only**, proportional to how much that supporter has tipped the thread's author. This is the "superchat" pattern: paying to stand out where you already gave support.

The prominence is deliberately **thread-local and never global**. It must not raise a supporter's reach in home feeds, timelines, candidates, or search. The reason is anti-corruption: if Y could buy general reach, the network would degrade into pay-for-distribution and the attention budget would stop reflecting whom viewers chose to follow. Confining bought prominence to the one thread the tip supported keeps the incentive honest — it rewards supporting a creator's conversation without letting money purchase audience elsewhere.

```rust
/// Thread-local prominence weight for a supporter's replies under `thread_author`'s post.
/// Purely presentational: derived from public tip totals, applied ONLY when
/// ordering replies within this thread, never to feed or candidate recall.
pub fn thread_supporter_prominence(
    supporter_lifetime_to_author: u64, // gross atomic Y this supporter has tipped thread_author
) -> f64 {
    (1.0 + supporter_lifetime_to_author as f64).ln()
}
```

### Supporter badges

An indexer may attach a **verifiable badge** to a supporter, summarizing their lifetime tips to a creator (e.g. bronze / silver / gold tiers by cumulative atomic Y). Badges are computed from the public `tips` table — no privileged state — so they carry the same verifiability guarantee as any other indexed economic figure: a client can recompute the lifetime total from on-chain tips and confirm the badge.

### Per-creator leaderboards

An indexer may publish a **per-creator supporter leaderboard** ranking a creator's supporters by `lifetime_tipped`. Like badges, this is derived and reproducible from chain data; it is subjective only in the cosmetic sense (tier cutoffs, display), not in the underlying totals.

```
GET /api/v1/creators/:pk/supporters?cursor=0&limit=20

Response:
{
    "creator": "pk_hex",
    "supporters": [
        {
            "public_key": "pk_hex",
            "lifetime_tipped": "25000000000",
            "tip_count": 34,
            "badge": "gold"
        },
        {
            "public_key": "pk_hex",
            "lifetime_tipped": "4200000000",
            "tip_count": 9,
            "badge": "silver"
        }
    ],
    "next_cursor": 20,
    "has_more": true
}
```

Supporter annotations (badge, thread prominence rank) also appear inline on tip entries in thread and engagement responses, so clients can render "superchat" styling without a second request. These annotations are advisory client hints, not economic facts, and are clearly separable from the verifiable tip amounts they accompany.

## REST API Endpoints (`api/`)

All endpoints return JSON. Pagination uses cursor-based pagination with `?cursor=<sequence>&limit=<n>`.

**API convention — `:user_pk` is an IdentityId.** Every `:user_pk` path parameter and every `public_key`/author field in a response is the user's **IdentityId** (the genesis public key that anchors vouches, likes, tips, labels, and handle ownership), never a rotated signing key. The current signing key is consulted only for signature verification via the registry (see 01 Identity Principle, A9). Clients resolve display handles from the IdentityId at render time.

**API convention — atomic Y amounts are JSON strings.** Every token amount (balances, stakes, tip amounts and fees, assessed values, rent, issuance, fee pool balances) is a **base-10 string of atomic Y** (6 decimals, so `"1000000"` = 1 Y). At the 140B-Y hard cap the supply is `140_000_000_000_000_000` atomic, which exceeds JSON's safe integer range (2^53 ≈ 9.0×10^15); serializing these as numbers would silently lose precision in JavaScript clients. Power and stake-time values use the same string encoding (their magnitudes match atomic Y). Counts, block numbers, epochs, `mint_rate_ppb`, `budget_share` (a fraction) and `aura` remain JSON numbers. All sample responses below follow this convention.

### Feeds

```
GET /api/v1/feeds/:user_pk/home?ranking=chronological|budget&explore=<topic,...>&cursor=0&limit=20

Response:
{
    "entries": [
        {
            "post": IndexedPost,
            "why_path": { "hops": ["viewer_pk", "alice_pk"], "via": "repost" } | null,
            "explore": { "provider": "indexer.example.org", "topic": "rust" } | null
        }
    ],
    "next_cursor": 20,
    "has_more": true
}
```

`explore=` names topics this indexer serves (`[explore]` config); with `ranking=budget` every entry carries either its why-path or its exploration label (`FeedEntry`).

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

Bulk, un-ranked recall for clients that run their own ranking model (09-client-ranking.md). The indexer claims **no ordering**: it computes the viewer's attention budget (`budget.rs`, above) and returns every item the budget reaches, each with its share, the why-path that put it there, and the viewer-relative engagement counts the local ranker consumes as features. Cheap to serve (a two-hop walk of the public follow graph, no stored per-user ranking state), so it is served free (see Indexer Economics).

```
GET /api/v1/candidates/:user_pk?sources=budget&since=<epoch>&limit=2000

Response:
{
    "candidates": [
        {
            "post": IndexedPost,
            "source": "budget",
            "budget_share": 0.0125,
            "why_path": { "hops": ["viewer_pk", "alice_pk", "bob_pk"], "via": "repost" },
            "graph_likes": 4,
            "graph_tippers": 1
        }
    ],
    "next_cursor": 2000,
    "has_more": true
}
```

Sources:

- `budget` — the default feed's recall: FEED_BUDGET of the viewer's budget over the viewer's follow list, equal weights (the 09 reference default; a client weighting its sources differently recomputes the budget locally from the same public graph). `budget_share` is the share of the item's **path** (09 `PathBudget.share`), not a per-item split: every item of a path carries the same value, and the client allocates slots per path. `why_path.hops` runs viewer → … → the account that signed the item; `via` is the item's relation to that account (`post`: no `repost_of`; `repost`: its own repost object, empty content, target in `repost_of`; `quote`: its quote post). An item reachable by several paths appears once, under the path with the largest share (09). `graph_likes` / `graph_tippers` count distinct accounts inside the viewer's budget graph (the viewer plus every account `attention_budget` reached) that liked / tipped the post, each account counted once — never network-wide totals.
- `mentions` — posts whose `mentions` include the user, for the **notifications view only**. Requested on its own (`?sources=mentions`), never by the default feed; items carry `"source": "mentions"` and no `budget_share`, `why_path` or graph counts.

The exploration part of the default feed (EXPLORE_BUDGET) is not a candidate source; it comes from `GET /api/v1/explore` (below). Why-paths are recomputable from public signed objects (follow lists, reposts, quotes), so a client re-derives any path and share (09) and rejects a fabricated one. Completeness has the same trust status as feeds: not guaranteed, detectable by querying multiple indexers.

### Explore (labelled exploration)

```
GET /api/v1/explore?topic=rust&cursor=0&limit=50

Response:
{
    "provider": "indexer.example.org",
    "topic": "rust",
    "policy": "explore-v1",
    "items": [
        {
            "post": IndexedPost,
            "source": "explore",
            "provider": "indexer.example.org",
            "topic": "rust"
        }
    ],
    "next_cursor": 50,
    "has_more": true
}
```

Fills the EXPLORE_BUDGET slot of the default feed. Served by **topic indexers**: indexers that declare the topics they serve (`[explore]` config, listed in `/health`); a topic an indexer does not serve returns `404`. Selection is the provider's declared `policy`, not protocol, and every item is labelled with provider and topic so clients render it as exploration, never mixed into budget shares. Clients choose topic indexers the way they choose any indexer; whatever a provider selects, it fills at most EXPLORE_BUDGET of the feed.

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
    "stake": "20000000000",
    "vouched_by_count": 3,
    "tips_received": "12000000000",
    "tips_given": "3500000000",
    "aura": 0.42 | null
}
```

`stake` is the user's eligible stake in the Like contract. `tips_received` is net (Σ `recipient_amount`, claimed escrows included); `tips_given` is gross (Σ `amount`). `aura` is advisory: this indexer's own computation from public likes under its own policy (05 Aura), never a ranking, reach or money input; `null` when the indexer computes none.

```
GET /api/v1/profiles/:user_pk/vouches?cursor=0&limit=50

Response:
{
    "vouched_by": [{ "account": "hex...", "issued_epoch": 12, "address": "hex..." }],
    "vouched_for": [{ "account": "hex...", "issued_epoch": 20, "address": "hex..." }],
    "next_cursor": 50,
    "has_more": false
}
```

`address` is the Vouch object's content address; a client re-verifies both signatures from the raw object (05). `vouched_by_count` on the profile is the length of `vouched_by`.

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
    "like_count": 57,
    "tip_total": "2000000000",
    "unique_tippers": 8,
    "tips": [
        {
            "tipper": "pk_hex",
            "amount": "250000000",
            "protocol_fee": "2500000",
            "facilitator": "pk_hex" | null,
            "facilitator_fee": "5000000",
            "recipient_amount": "242500000",
            "block_number": 12340,
            "supporter_badge": "gold"
        }
    ]
}
```

`like_count`, `tip_total` (gross) and `unique_tippers` are network-wide **display** data, not default ranking features — 09 ranks on the viewer-relative `graph_likes` / `graph_tippers` served with candidates. The `supporter_badge` field is an advisory supporter-recognition hint (see Supporter Recognition); it is not an economic fact and is derived from public tip totals. The verifiable amounts (`amount`, fees, `recipient_amount`, `tip_total`) are the economic data.

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

### Epoch, Issuance and Fee Pool

```
GET /api/v1/epoch

Response:
{
    "epoch": 37,
    "closed_power_spent": "4000000000000000",
    "closed_stake_time": "19500000000000000",
    "closed_mint_budget": "20000000000000",
    "closed_fee_drip": "17000000000",
    "closed_fee_reserved": "3487179487",
    "fee_pool_balance": "846512820513",
    "mint_rate_ppb": 5000000,
    "base_rent": "1000000",
    "minted_total": "3120000000000000",
    "issuance_capacity": "83900000000000000",
    "total_stake": "20000000000000000",
    "treasury_balance": "412000000000"
}
```

Reports the latest `EpochAdvanced` field-for-field plus four derived figures (03 §A, §B, Fee Pool). The `closed_*` fields describe the epoch that closed: settled power, stake-time `S_e`, the mint budget reserved for creator claims (`min(k × spent, remaining capacity)`), the fee drip (`FEE_POOL_DRIP_BPS` of the pool balance at close) and the part of it reserved for claims (`drip × spent / max(S_e, spent)`; the rest stays in the pool). `mint_rate_ppb` is the current `k`, halving every `MINT_HALVING_EPOCHS`; `base_rent` is the controller-set flat-tier rent that Harberger floors multiply. `fee_pool_balance` is the last snapshot plus fee inflows mirrored since. `minted_total` sums genesis tranches and creator mints; `issuance_capacity` is the capacity left after every reserved mint budget; `total_stake` includes pending unstakes; `treasury_balance` is the balance of the disclosed treasury account (a genesis leaf, 03 §A). Amounts, power and stake-time are strings. This is the read path behind the CLI `epoch_info` command.

### Per-User Economy

```
GET /api/v1/users/:pk/economy

Response:
{
    "identity_id": "hex...",
    "y_balance": "50000000000",
    "stake": "20000000000",
    "pending_unstake": "0",
    "unstake_available_at": null,
    "power": "2610000000",
    "power_cap": "2857142857",
    "unclaimed": {
        "minted": "31000000",
        "fee_reward": "4100000",
        "epochs": [35, 36]
    },
    "genesis": {
        "key": "0x..." | null,
        "cohort": 1 | null,
        "entitlement": "1040000000000",
        "tranche_this_epoch": "5000000000",
        "claimed_this_epoch": false,
        "claimed_total": "185000000000"
    } | null
}
```

`power` and `power_cap` apply 03 §B's `accrue` and `power_cap` to the mirrored `PowerMeter` at the latest block timestamp; `unclaimed` applies the creator-claim formulas to the mirrored `received` and `epochs` totals (closed epochs, no expiry); `tranche_this_epoch` is `genesis_tranche(entitlement, epoch)` on the nominal entitlement after splits, claimable only within the current epoch. All are advisory recomputations — the Like and GenesisClaim contracts are authoritative.

### Tips and Likes per User/Post

```
GET /api/v1/users/:pk/tips?direction=received|given&cursor=0&limit=20

Response:
{
    "tips": [
        {
            "tipper": "pk_hex",
            "recipient": "pk_hex" | { "foreign": "0x..." },
            "post_address": "hex..." | null,
            "amount": "250000000",
            "protocol_fee": "2500000",
            "facilitator": "pk_hex" | null,
            "facilitator_fee": "5000000",
            "recipient_amount": "242500000",
            "escrow": null | { "escrow_id": 91, "state": "open" | "claimed" | "refunded" },
            "block_number": 12340
        }
    ],
    "next_cursor": 20,
    "has_more": false
}
```

`direction` defaults to `received`. Received tips include escrowed tips once claimed to this user; given tips include open and refunded escrows, marked by `escrow`.

```
GET /api/v1/posts/:addr/tips?cursor=0&limit=20

Response:
{
    "tips": [IndexedTip],
    "next_cursor": 20,
    "has_more": false
}
```

```
GET /api/v1/posts/:addr/likes?cursor=0&limit=50

Response:
{
    "post_address": "hex...",
    "like_count": 57,
    "likes": [
        {
            "address": "hex...",
            "liker": "pk_hex",
            "claimed_epoch": 37,
            "sponsor": "pk_hex" | null
        }
    ],
    "next_cursor": 50,
    "has_more": true
}
```

Each like's `address` is its signed Like object's content address; a client re-verifies it from the raw object (spot-check or stream) like any content. A Like object itself carries no payment; whether it paid anything is visible solely in the liker's (or sponsor's) on-chain `LikesSettled` batches.

### Content Labels

```
GET /api/v1/labels/:address

Response:
{
    "target": "hex...",
    "labels": [
        {
            "author": "pk_hex",
            "label": "spam",
            "claimed_epoch": 37
        }
    ],
    "label_count": 2,
    "verdict": "Clean" | "Warned" | "Hidden",
    "policy": "default-v1"
}
```

`labels` is the raw, public label record — each an immutable, content-addressed signed object (see 06 Content Labels). `verdict` is this indexer's LOCAL, NON-NORMATIVE visibility decision derived from those labels under its own `policy`; the protocol mandates nothing here. Different indexers may reach different verdicts for the same target -- this is by design, and a client can recompute the verdict from the same public labels or apply its own filter (see 06, 09).

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
    "indexed_tip_count": 8,
    "indexed_tip_total": "2000000000",
    "chain_proof": {
        "tips_on_chain": 8,
        "tip_total_on_chain": "2000000000",
        "tips_match": true
    },
    "match": true
}
```

The spot-check API lets any client verify that the indexer is not fabricating or omitting data. For content, the indexer returns the raw signed object; the client recomputes its content address, re-verifies the author signature locally, and cross-checks a second indexer or the anchor branch. For engagement, tip counts and totals are checked against on-chain `Tip` events (and `TipEscrowClaimed` for escrowed tips); likes are signed objects, checked like content — re-verify each entry of `/posts/:addr/likes` and cross-check a second indexer.

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
        "total_likes": 412000,
        "total_tips": 31000,
        "last_sync_completed": "2026-03-03T12:00:00Z",
        "last_sync_duration_ms": 45000,
        "last_indexed_block": 128500
    },
    "label_policy": "default-v1",
    "explore": { "provider": "indexer.example.org", "policy": "explore-v1", "topics": ["rust"] },
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
        // Candidates (un-ranked budget recall for client-side ranking; mentions)
        .route("/api/v1/candidates/:user_pk", get(feeds::candidates))
        // Explore (labelled exploration slot; topic indexers)
        .route("/api/v1/explore", get(explore::explore))
        // Profiles
        .route("/api/v1/profiles/:user_pk", get(profiles::get_profile))
        .route("/api/v1/profiles/:user_pk/followers", get(profiles::get_followers))
        .route("/api/v1/profiles/:user_pk/following", get(profiles::get_following))
        .route("/api/v1/profiles/:user_pk/vouches", get(profiles::get_vouches))
        // Posts & Threads
        .route("/api/v1/posts/:address", get(posts::get_post))
        .route("/api/v1/posts/:address/thread", get(posts::get_thread))
        .route("/api/v1/posts/:address/likes", get(engagement::get_post_likes))
        .route("/api/v1/posts/:address/tips", get(engagement::get_post_tips))
        // Search
        .route("/api/v1/search", get(search::search_posts))
        // Names (handle resolution + Harberger lifecycle state)
        .route("/api/v1/names/:handle", get(names::resolve_name))
        // Epoch, issuance & fee pool
        .route("/api/v1/epoch", get(epoch::get_epoch))
        // Supporter recognition (client convention, not protocol)
        .route("/api/v1/creators/:pk/supporters", get(creators::get_supporters))
        // Users — tips and economy
        .route("/api/v1/users/:pk/tips", get(engagement::get_user_tips))
        .route("/api/v1/users/:pk/economy", get(economy::get_user_economy))
        // Engagement
        .route("/api/v1/engagement/:address", get(engagement::get_engagement))
        // Content labels
        .route("/api/v1/labels/:address", get(labels::get_labels))
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

    /// Label visibility policy.
    pub labels: LabelPolicyConfig,

    /// Topics this indexer serves on /explore (empty = not a topic indexer).
    pub explore: ExploreConfig,

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

    /// The disclosed treasury genesis leaf's account (03 §A); its y_balance
    /// is reported as `treasury_balance` on /epoch.
    pub treasury_account: String,      // e.g. "0xdef..."
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

/// Indexer-local label visibility policy. Labels are public protocol data (see
/// 06 Content Labels); how this indexer aggregates them into a visibility
/// verdict is its own choice — indexer-local, NOT protocol. Operator blocklists
/// are likewise local config.
#[derive(Clone, Serialize, Deserialize)]
pub struct LabelPolicyConfig {
    /// Policy name (for display in /health endpoint).
    pub policy_name: String,           // default: "default-v1"

    /// Minimum number of matching labels to trigger a "Warned" verdict.
    /// Optional: an indexer may disable label-based visibility entirely.
    pub warn_threshold_labels: u32,    // default: 3

    /// Minimum number of matching labels to trigger a "Hidden" verdict.
    pub hide_threshold_labels: u32,    // default: 10

    /// Minimum number of distinct label authors required (regardless of count).
    pub min_unique_authors: u32,       // default: 3

    /// Custom blocked public keys (operator-level override).
    /// Posts from these users are always hidden.
    pub blocked_users: Vec<String>,    // hex-encoded public keys

    /// Custom blocked content addresses (operator-level override).
    /// These specific posts are always hidden.
    pub blocked_posts: Vec<String>,    // hex-encoded content addresses

    /// Content-hash blocklists applied at INGEST (e.g. published CSAM hash
    /// lists). An object whose content address matches is refused at intake —
    /// this is the host's legal responsibility and edge policy at each host's
    /// discretion, NOT protocol-level deletion (see 06).
    pub ingest_hash_blocklists: Vec<String>, // hex-encoded content addresses / list URLs
}

/// Exploration this indexer serves as a topic indexer. Selection is the
/// operator's declared policy, NOT protocol; every item is labelled with
/// `provider` and topic (see Explore).
#[derive(Clone, Serialize, Deserialize)]
pub struct ExploreConfig {
    /// Provider label attached to every explore item.
    pub provider: String,              // e.g. "indexer.example.org"
    /// Policy name (for display in /health and /explore responses).
    pub policy_name: String,           // default: "explore-v1"
    /// Topics served; any other topic returns 404.
    pub topics: Vec<String>,           // default: empty
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
treasury_account = "0xdef456..."

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

[labels]
policy_name = "default-v1"
warn_threshold_labels = 3
hide_threshold_labels = 10
min_unique_authors = 3
blocked_users = []
blocked_posts = []
ingest_hash_blocklists = []

[explore]
provider = "indexer.example.org"
policy_name = "explore-v1"
topics = ["rust"]
```

### Label Visibility Policy

Labels are public, immutable signed objects (see 06 Content Labels); the protocol only records them. Each indexer computes its own visibility defaults over that public record — strict operators hide aggressively, permissive ones show everything, and an unmoderated indexer applies no thresholds at all. Clients may ignore the indexer's verdict and run their own label filters (see 06, 09), and users choose indexers whose visibility policy they agree with. The `/health` endpoint exposes the policy name so those choices are informed.

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
        // discovers authors from ingested Vouch objects, registry/stake events,
        // and peer exchange.
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

- **Reading is free**: feeds, candidates, explore, profiles, threads, search and spot-checks are served without payment; a reader needs no Y. Charging readers is a toll on growth, and the network's hosts are funded where money already moves.
- **Facilitator fees**: every tip carries a facilitator fee of 0–5%, set per transaction by the originating client and authorized by the payer (03 §C); the client or indexer that originated the tip names itself as `facilitator`. This is how clients and indexers earn from use, and it is what recoups the acquisition costs clients take on for newcomers (paymaster gas, first handle rent — 05).
- **Bulk API access**: heavy consumers (other clients' backends, full-corpus mirrors, research, topic indexers building their own exploration) buy bulk access on the operator's terms — rate limits, subscriptions, or out-of-band billing. Payment vouchers (small signed IOUs accumulated off-chain and settled in Y on-chain periodically) are an optional convention for this bulk tier only, never the read path.
- **Hosting is part of the funded service, not a new layer**: an indexer stores what it serves, so hot storage is covered by the same revenue — no separate storage token, no staking. Full (registered) indexers replicate the entire **text** corpus as the normative expectation (it is small — a few hundred GB at very large scale — and it *is* the product); at roughly ~1 GB/day of text network-wide this adds no new economic layer. Priced **retention** applies to media blobs and to light/specialized indexers that choose not to hold everything (retention terms are a market feature; see `docs/12 §3` and 02).
- **What the protocol contributes**: Y as the low-friction payment rail (tips with an in-protocol facilitator split), and the spot-check verifiability that turns service quality into something clients can measure. Detection → reputation → churn is the enforcement mechanism, the same one every service market (RPC providers, ISPs) runs on.
- **What was rejected**: a fee-pool share for indexers ("proof of indexing" is either gameable or requires The Graph-scale staking/slashing/dispute machinery — disproportionate for a social network), and unfunded hosting that relies on altruism (the Nostr relay experience: chronically underfunded infrastructure drifts toward corporate subsidy and the influence-monetization incentive). Reading is free to the reader, not to the host; facilitator fees and bulk access are what fund it.
- **Cost profile**: candidate serving (a two-hop budget walk) and data queries are cheap enough to serve free; bulk access is the paid tier. Running an indexer must stay within hobbyist reach — that, plus verifiability, is what keeps the market competitive rather than oligopolistic.

## Trust Model Summary

The indexer is an **untrusted convenience layer**. Its trust model is:

| Property | Guarantee |
|---|---|
| **Data integrity** | Every indexed content item is a signed, content-addressed object: it hashes to its own address and carries its author's signature. Every indexed economic event traces back to an on-chain transaction. Clients verify any item via the spot-check API (re-verifying the raw signed object locally), by cross-checking a second indexer, or by querying the blockchain — no trusted source is required. |
| **Completeness** | NOT guaranteed by a single indexer, but omission is maximally detectable: since full indexers replicate the whole text corpus, any peer can produce a missing item **plus its anchor proof**, publicly demonstrating the omission. Omission disputes therefore carry anchor proofs as evidence. Clients detect gaps by querying multiple indexers. |
| **Timestamp provability** | An indexer periodically anchors a Merkle root of newly indexed content addresses on-chain (`AnchorLog`, `docs/12 §4`). A Merkle branch to an anchored root proves a post existed before that block; an optional `freshness_anchor` proves it was created after one. Anchors from indexers that later disappear remain valid forever, so prior timestamps stay provable. |
| **Ranking fairness** | NOT guaranteed. An indexer may bias feed rankings or omit candidates. Every budget item carries a why-path and share recomputable from public signed objects (follow lists, reposts, quotes), so a fabricated or inflated path is detectable (09); explore items are labelled with their provider and topic and fill at most EXPLORE_BUDGET of the feed. `Chronological` stays the neutral baseline. |
| **Visibility policy** | Indexer-local by design. Each indexer derives its own visibility verdict from the public label record under its own policy; the protocol mandates nothing. Because the label record is public and auditable, any hiding decision can be compared against it, and a client can recompute or override it (see 06, 09). |
| **Supporter recognition** | Derived and subjective, like the visibility policy — NOT part of the economic-accuracy guarantee. Badges, thread-scoped superchat prominence, and per-creator leaderboards are presentation conventions, not protocol, and confer no on-chain rights. The underlying tip totals they summarize are verifiable against the chain, but their display (tier cutoffs, prominence weighting, thread-local ordering) is the indexer's choice; a different indexer may show them differently or not at all. The profile's advisory `aura` has the same status (05). |
| **Economic accuracy** | On-chain events are the source of truth for tips, stakes, like settlements, issuance, the fee pool, genesis claims, transfers, and handle rent. The indexer merely mirrors this data for queryability; derived figures (power, unclaimed rewards, genesis tranches) are recomputed with 03's formulas and are advisory. Any discrepancy can be detected by checking the chain directly. |
| **Availability & durability** | NOT guaranteed by any single indexer. Durability comes from independently chosen indexers + the author's local copy + trustless third-party mirrors (mirroring is trustless because objects are self-authenticating) + permissionless republication — any dropped indexer is a re-publish event, not data loss. No storage venue is normative; out-of-protocol archival services may exist but none is required. |
| **Censorship-resistance** | Suppressing a user requires suppressing **every** indexer AND their permissionless ability to republish (from a local copy, to any indexer, including one they run themselves); anchors keep prior timestamps provable forever. |
