# Verifiable Indexer Service (`dsn-indexer`)

## Purpose

Autonomi is a content-addressed storage network with no built-in query capabilities. Clients cannot ask Autonomi "give me Alice's feed" or "search for posts about Rust." The indexer bridges this gap: it crawls Autonomi, builds queryable indices locally, and exposes a REST API for clients.

Because ALL source data lives on Autonomi (immutable Chunks, signed Scratchpads, GraphEntries), any indexer output can be independently verified against the source. This makes indexers **verifiable**: clients can spot-check any result the indexer returns by fetching the underlying Autonomi data themselves.

Multiple competing indexers can run simultaneously. No single indexer can censor content without clients noticing — they simply switch to a different indexer or verify against Autonomi directly.

## Module Structure

```
crates/indexer/src/
├── lib.rs              # Re-exports, IndexerService construction
├── config.rs           # Configuration: crawl frequency, moderation policy, storage paths
├── crawler.rs          # Crawl loop: discover users, fetch data, follow links
├── store.rs            # Local index storage (SQLite-backed)
├── models.rs           # Internal data model: indexed posts, profiles, engagement
├── api/
│   ├── mod.rs          # Axum router assembly
│   ├── feeds.rs        # GET /feeds/:user_pk — home feed, user timeline
│   ├── profiles.rs     # GET /profiles/:user_pk — profile + stats
│   ├── posts.rs        # GET /posts/:address — single post + thread
│   ├── search.rs       # GET /search?q=... — full-text search
│   ├── engagement.rs   # GET /engagement/:post_address — likes, curations, boosts
│   ├── moderation.rs   # GET /moderation/:post_address — flag status, verdicts
│   ├── spotcheck.rs    # GET /spotcheck/:post_address — raw Autonomi data for verification
│   └── health.rs       # GET /health — indexer status, crawl stats
├── watcher.rs          # Fraud/R/Y verification performed during crawl
├── feed_builder.rs     # Feed ranking: chronological, curated, boosted
└── error.rs            # Indexer error types
```

## Crawler Design (`crawler.rs`)

### Discovery Strategy

The crawler maintains a set of **known public keys** (the user registry) and discovers new users through three channels:

1. **Invitation graph traversal** — When the crawler encounters an invitation GraphEntry, it adds the invitee's public key to the known set. This is the primary discovery mechanism since all legitimate users enter through the invitation tree.

2. **Follow list expansion** — When crawling a user's FollowList Scratchpad, any followed public key not yet known is added to the crawl queue. This catches users discovered through social links.

3. **Reply graph traversal** — When a post references a `reply_to` address, the crawler resolves the parent post's author. If unknown, that author is added to the crawl queue.

### Crawl Loop

```rust
/// The main crawl loop. Runs continuously with configurable sleep between cycles.
pub async fn run_crawl_loop(
    storage: Arc<dyn Storage>,
    index: Arc<IndexStore>,
    config: &CrawlerConfig,
) -> Result<(), IndexerError> {
    loop {
        let cycle_start = Instant::now();

        // 1. Discover new users from invitation graph
        discover_new_users(storage.as_ref(), index.as_ref()).await?;

        // 2. Crawl all known users (prioritized by staleness)
        let users = index.users_by_staleness().await?;
        for user_pk in &users {
            crawl_user(storage.as_ref(), index.as_ref(), user_pk, config).await?;
        }

        // 3. Update epoch state
        sync_epoch_state(storage.as_ref(), index.as_ref()).await?;

        // 4. Run watcher checks on newly crawled data
        run_watcher_cycle(storage.as_ref(), index.as_ref()).await?;

        let elapsed = cycle_start.elapsed();
        tracing::info!(elapsed_ms = elapsed.as_millis(), users = users.len(), "crawl cycle complete");

        // Sleep until next cycle
        if elapsed < config.crawl_interval {
            tokio::time::sleep(config.crawl_interval - elapsed).await;
        }
    }
}
```

### Per-User Crawl

For each known user, the crawler fetches all their Scratchpads using derived key addresses:

```rust
/// Crawl a single user's data from Autonomi.
async fn crawl_user(
    storage: &dyn Storage,
    index: &IndexStore,
    user_pk: &PublicKey,
    config: &CrawlerConfig,
) -> Result<(), IndexerError> {
    // Fetch all Scratchpads in parallel (independent reads)
    let (profile, feed_index, follow_list, like_list, curation_record, y_balance, r_balance) =
        tokio::try_join!(
            fetch_scratchpad(storage, user_pk, ContentType::UserProfile),
            fetch_scratchpad(storage, user_pk, ContentType::FeedIndex),
            fetch_scratchpad(storage, user_pk, ContentType::FollowList),
            fetch_scratchpad(storage, user_pk, ContentType::LikeList),
            fetch_scratchpad(storage, user_pk, ContentType::CurationRecord),
            fetch_scratchpad(storage, user_pk, ContentType::YBalance),
            fetch_scratchpad(storage, user_pk, ContentType::RBalance),
        )?;

    // Verify signatures on all fetched data
    verify_all_signatures(user_pk, &profile, &feed_index, &follow_list,
                          &like_list, &curation_record, &y_balance, &r_balance)?;

    // Fetch new posts (only those not yet in the index)
    if let Some(feed) = &feed_index {
        let new_post_addresses = index.filter_unknown_posts(&feed.posts).await?;
        let posts = fetch_posts_parallel(storage, &new_post_addresses).await?;
        for post in &posts {
            // Verify post signature before indexing
            if !post.post.verify() {
                tracing::warn!(address = ?post.address, "invalid post signature, skipping");
                continue;
            }
            index.upsert_post(post).await?;
        }
    }

    // Fetch reply graph entries
    let reply_entries = storage.get_graph(user_pk).await?;
    for entry in &reply_entries {
        index.upsert_reply_link(entry).await?;
    }

    // Walk Y receipt chain incrementally (stop at last-verified receipt)
    if let Some(y) = &y_balance {
        let payload: YScratchpadPayload = bincode::deserialize(&y.data)?;
        let receipts = walk_receipt_chain_incremental(
            storage,
            &payload.latest_receipt,
            index.last_verified_receipt(user_pk).await?,
        ).await?;
        // Verify new receipts and update last-verified
        if let Some(latest) = receipts.first() {
            let latest_addr = ContentAddress::from_data(
                &bincode::serialize(latest)?
            );
            index.update_last_verified_receipt(user_pk, &latest_addr).await?;
        }
    }

    // Update index with latest user state
    index.upsert_user(user_pk, &profile, &follow_list, &like_list,
                      &curation_record, &y_balance, &r_balance).await?;

    // Queue newly discovered users from follow list
    if let Some(follows) = &follow_list {
        for followed_pk in &follows.following {
            index.ensure_user_known(followed_pk).await?;
        }
    }

    Ok(())
}
```

### Incremental Crawling

The indexer tracks the `version` field of each user's Scratchpads. On subsequent crawl cycles, it compares the stored version against the fetched version and only processes data that has changed. This avoids re-indexing unchanged profiles, follow lists, and balance states.

```rust
/// Check if a Scratchpad has been updated since we last indexed it.
fn needs_update(stored_version: u64, fetched_version: u64) -> bool {
    fetched_version > stored_version
}
```

### Crawl Prioritization

Users are crawled in priority order:

| Priority | Condition | Rationale |
|---|---|---|
| **1 (highest)** | Never crawled | New user, need initial data |
| **2** | Known Scratchpad writes since last crawl | Active user, likely has new content |
| **3** | High R balance | Influential user, feeds depend on their curations |
| **4** | High follower count | Popular user, many feeds reference their posts |
| **5 (lowest)** | Idle, low R | Inactive user, unlikely to have new data |

## Internal Data Model (`models.rs`, `store.rs`)

### What Gets Indexed

The indexer builds a local relational index from Autonomi's flat key-value data. The local store uses SQLite for persistence across restarts.

### Schema

```rust
/// A fully indexed user record.
pub struct IndexedUser {
    /// Primary identity.
    pub public_key: PublicKey,
    /// Latest profile data.
    pub display_name: String,
    pub bio: String,
    pub avatar: Option<ContentAddress>,
    pub profile_version: u64,
    /// Social stats (denormalized for fast API responses).
    pub follower_count: u64,
    pub following_count: u64,
    pub post_count: u64,
    pub like_count: u64,
    /// Token state.
    pub y_balance: u64,
    pub y_nonce: u64,
    pub r_balance: u64,
    pub r_computed_at_epoch: u64,
    /// Invitation chain.
    pub invited_by: Option<PublicKey>,
    pub invitation_depth: u32,
    /// Moderation state.
    pub fraud_proof: Option<ContentAddress>,
    pub active_flags: u32,
    /// Crawl metadata.
    pub last_crawled_at: chrono::DateTime<chrono::Utc>,
    pub scratchpad_versions: ScratchpadVersions,
}

/// Version counters for incremental crawling.
pub struct ScratchpadVersions {
    pub profile: u64,
    pub feed_index: u64,
    pub follow_list: u64,
    pub like_list: u64,
    pub curation_record: u64,
    pub y_balance: u64,
    pub r_balance: u64,
}

/// A fully indexed post record.
pub struct IndexedPost {
    /// Content address (primary key).
    pub address: ContentAddress,
    /// Author's public key.
    pub author: PublicKey,
    /// Post content.
    pub content: String,
    /// Threading.
    pub reply_to: Option<ContentAddress>,
    pub reply_count: u64,
    /// Sequence in author's post history.
    pub sequence: u64,
    /// Timestamp (informational).
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Engagement metrics (denormalized).
    pub like_count: u64,
    pub curation_count: u64,
    pub diversity_score: Option<f64>,
    /// Boost state.
    pub y_burned_boost: u64,
    /// Moderation state.
    pub flag_count: u32,
    pub moderation_verdict: Option<ModerationVerdict>,
}

/// Engagement detail for a post.
pub struct IndexedEngagement {
    pub post_address: ContentAddress,
    pub likers: Vec<PublicKey>,
    pub curations: Vec<IndexedCuration>,
    pub boost_burns: Vec<IndexedBoost>,
}

pub struct IndexedCuration {
    pub curator: PublicKey,
    pub r_staked: u64,
    pub y_staked: u64,
    pub staked_at_epoch: u64,
    pub outcome: Option<CurationOutcome>,
}

pub struct IndexedBoost {
    pub booster: PublicKey,
    pub y_burned: u64,
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

/// Epoch state tracked by the indexer.
pub struct IndexedEpoch {
    pub epoch: u64,
    pub boundary_address: ContentAddress,
    pub curation_count: u64,
    pub total_r_earned: u64,
    pub y_emission: u64,
    pub publisher: PublicKey,
}

/// Moderation verdict as determined by this indexer's policy.
#[derive(Clone, Serialize, Deserialize)]
pub enum ModerationVerdict {
    /// No flags, content visible.
    Clean,
    /// Flagged but below threshold, content visible with warning.
    Warned { flag_count: u32, flaggers_total_r: u64 },
    /// Flags exceed threshold, content hidden by this indexer.
    Hidden { flag_count: u32, flaggers_total_r: u64 },
}
```

### SQLite Tables (Logical)

| Table | Primary Key | Purpose |
|---|---|---|
| `users` | `public_key` | User profiles, stats, token balances |
| `posts` | `address` | Post content, engagement counts |
| `follows` | `(follower, followee)` | Follow relationships |
| `likes` | `(liker, post_address)` | Like records |
| `curations` | `(curator, post_address)` | Curation stakes and outcomes |
| `reply_links` | `(parent_address, child_address)` | Thread structure |
| `invitations` | `(inviter, invitee)` | Invitation graph |
| `flags` | `(flagger, post_address)` | Content flags |
| `fraud_proofs` | `offender` | Proven fraud |
| `epochs` | `epoch` | Epoch boundaries |
| `boost_burns` | `(booster, post_address)` | Y burn boosts |
| `crawl_state` | `public_key` | Per-user crawl metadata (includes `last_verified_receipt` address) |
| `posts_fts` | (virtual) | Full-text search index on `posts.content` |

### Index Store Trait

```rust
/// Abstraction over the local index storage.
/// Allows swapping SQLite for an in-memory store in tests.
#[async_trait]
pub trait IndexStore: Send + Sync {
    // --- Write operations (used by crawler) ---
    async fn upsert_user(&self, pk: &PublicKey, profile: &Option<UserProfile>,
                         follows: &Option<FollowList>, likes: &Option<LikeList>,
                         curations: &Option<CurationRecord>,
                         y: &Option<YScratchpadPayload>, r: &Option<RBalance>) -> Result<(), IndexerError>;
    async fn upsert_post(&self, post: &SignedPost) -> Result<(), IndexerError>;
    async fn upsert_reply_link(&self, entry: &GraphEntryData) -> Result<(), IndexerError>;
    async fn ensure_user_known(&self, pk: &PublicKey) -> Result<(), IndexerError>;
    async fn record_fraud_proof(&self, proof: &FraudProof) -> Result<(), IndexerError>;
    async fn update_moderation_verdict(&self, post: &ContentAddress,
                                        verdict: ModerationVerdict) -> Result<(), IndexerError>;

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
    async fn get_moderation_status(&self, post: &ContentAddress) -> Result<ModerationVerdict, IndexerError>;
    async fn get_flagged_posts(&self, min_flags: u32, cursor: Option<u64>,
                                limit: u32) -> Result<Vec<IndexedPost>, IndexerError>;

    // --- Receipt chain tracking ---
    async fn last_verified_receipt(&self, pk: &PublicKey) -> Result<Option<ContentAddress>, IndexerError>;
    async fn update_last_verified_receipt(&self, pk: &PublicKey, receipt: &ContentAddress) -> Result<(), IndexerError>;

    // --- Crawl coordination ---
    async fn users_by_staleness(&self) -> Result<Vec<PublicKey>, IndexerError>;
    async fn filter_unknown_posts(&self, addresses: &[ContentAddress]) -> Result<Vec<ContentAddress>, IndexerError>;
    async fn crawl_stats(&self) -> Result<CrawlStats, IndexerError>;
}

pub struct CrawlStats {
    pub total_users: u64,
    pub total_posts: u64,
    pub total_epochs: u64,
    pub last_crawl_completed: Option<chrono::DateTime<chrono::Utc>>,
    pub last_crawl_duration_ms: u64,
    pub fraud_proofs_found: u64,
}
```

## Feed Builder (`feed_builder.rs`)

### Feed Ranking Strategies

Clients choose a ranking strategy when requesting feeds. The indexer supports multiple strategies:

```rust
#[derive(Clone, Serialize, Deserialize)]
pub enum FeedRanking {
    /// Reverse chronological. No algorithmic sorting.
    Chronological,
    /// Weighted by DiversityScore (curated quality signal).
    Curated,
    /// Weighted by Y burn boosts (paid visibility).
    Boosted,
    /// Combined: Curated score + recency + boost, with configurable weights.
    Blended {
        recency_weight: f64,
        curation_weight: f64,
        boost_weight: f64,
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

    // Curation: log-scaled DiversityScore
    let curation = post.diversity_score
        .map(|ds| (1.0 + ds).ln())
        .unwrap_or(0.0);

    // Boost: log-scaled Y burned
    let boost = (1.0 + post.y_burned_boost as f64).ln();

    recency * weights.recency_weight
        + curation * weights.curation_weight
        + boost * weights.boost_weight
}
```

## REST API Endpoints (`api/`)

All endpoints return JSON. Pagination uses cursor-based pagination with `?cursor=<sequence>&limit=<n>`.

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

### Profiles

```
GET /api/v1/profiles/:user_pk

Response:
{
    "public_key": "hex...",
    "display_name": "Alice",
    "bio": "...",
    "avatar": "content_address_hex or null",
    "follower_count": 42,
    "following_count": 15,
    "post_count": 128,
    "y_balance": 5000,
    "r_balance": 250,
    "invited_by": "hex or null",
    "fraud_proof": null
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
    "author_profile": { "display_name": "...", "r_balance": 250 }
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

Full-text search is powered by SQLite FTS5 on post content. The indexer tokenizes and indexes post content during crawl.

### Engagement

```
GET /api/v1/engagement/:post_address

Response:
{
    "post_address": "hex...",
    "like_count": 15,
    "likers": ["pk_hex_1", "pk_hex_2", ...],
    "curation_count": 3,
    "curations": [
        {
            "curator": "pk_hex",
            "r_staked": 50,
            "y_staked": 100,
            "staked_at_epoch": 12,
            "outcome": "Success" | "Failure" | null
        }
    ],
    "diversity_score": 24.5,
    "boost_burns": [
        { "booster": "pk_hex", "y_burned": 500 }
    ],
    "total_y_burned": 500
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
    "flaggers_total_r": 180,
    "flags": [
        {
            "flagger": "pk_hex",
            "flagger_r": 100,
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
    "autonomi_proof": {
        "raw_chunk_data_b64": "base64...",
        "content_address_recomputed": "hex...",
        "signature_valid": true,
        "author_pk": "hex..."
    },
    "match": true
}
```

```
GET /api/v1/spotcheck/balance/:user_pk/y

Response:
{
    "indexed_y_balance": 5000,
    "indexed_y_nonce": 42,
    "receipt_chain_depth": 42,
    "latest_receipt_address": "hex...",
    "autonomi_proof": {
        "raw_scratchpad_data_b64": "base64...",
        "y_balance_from_source": 5000,
        "y_nonce_from_source": 42,
        "signature_valid": true,
        "hash_chain_valid": true,
        "receipt_chain_valid": true
    },
    "match": true
}
```

```
GET /api/v1/spotcheck/balance/:user_pk/r

Response:
{
    "indexed_r_balance": 250,
    "autonomi_proof": {
        "raw_scratchpad_data_b64": "base64...",
        "r_balance_from_source": 250,
        "r_computed_at_epoch": 15,
        "signature_valid": true,
        "recomputed_r": 250,
        "recomputation_matches": true
    },
    "match": true
}
```

```
GET /api/v1/spotcheck/engagement/:post_address

Response:
{
    "indexed_like_count": 15,
    "sampled_likers": [
        {
            "liker_pk": "hex...",
            "found_in_autonomi_like_list": true
        },
        ...
    ],
    "indexed_curation_count": 3,
    "sampled_curations": [
        {
            "curator_pk": "hex...",
            "found_in_autonomi_curation_record": true
        },
        ...
    ],
    "sample_size": 5,
    "all_samples_verified": true
}
```

The spot-check API lets any client verify that the indexer is not fabricating or omitting data. For engagement metrics, the indexer samples a subset of claimed likers/curators and provides proof that they exist in the source Autonomi data.

### Health

```
GET /api/v1/health

Response:
{
    "status": "healthy",
    "version": "0.1.0",
    "crawl_stats": {
        "total_users": 1250,
        "total_posts": 48000,
        "total_epochs": 16,
        "last_crawl_completed": "2026-03-03T12:00:00Z",
        "last_crawl_duration_ms": 45000,
        "fraud_proofs_found": 2
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
        // Profiles
        .route("/api/v1/profiles/:user_pk", get(profiles::get_profile))
        .route("/api/v1/profiles/:user_pk/followers", get(profiles::get_followers))
        .route("/api/v1/profiles/:user_pk/following", get(profiles::get_following))
        // Posts & Threads
        .route("/api/v1/posts/:address", get(posts::get_post))
        .route("/api/v1/posts/:address/thread", get(posts::get_thread))
        // Search
        .route("/api/v1/search", get(search::search_posts))
        // Engagement
        .route("/api/v1/engagement/:address", get(engagement::get_engagement))
        // Moderation
        .route("/api/v1/moderation/:address", get(moderation::get_status))
        // Spot-check
        .route("/api/v1/spotcheck/post/:address", get(spotcheck::verify_post))
        .route("/api/v1/spotcheck/balance/:user_pk/y", get(spotcheck::verify_y_balance))
        .route("/api/v1/spotcheck/balance/:user_pk/r", get(spotcheck::verify_r_balance))
        .route("/api/v1/spotcheck/engagement/:address", get(spotcheck::verify_engagement))
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

## Watcher Integration (`watcher.rs`)

The indexer is a **full watcher** by default. During every crawl cycle, it performs verification checks on the data it ingests. This is not a separate process -- it is integrated into the crawl pipeline.

### What the Watcher Verifies

| Check | When | Action on Failure |
|---|---|---|
| **Post signature** | On every post fetch | Skip post, log warning |
| **Profile signature** | On every profile fetch | Skip profile update, log warning |
| **Y balance signature** | On every Y Scratchpad fetch | Flag user, log error |
| **Y hash chain integrity** | On every Y Scratchpad fetch | Walk receipt chain from `latest_receipt`; flag user, generate fraud proof if fork detected |
| **Y nonce monotonicity** | On every Y Scratchpad fetch | Flag user, investigate for double-spend |
| **Receipt chain completeness** | On every Y Scratchpad fetch | Flag user if receipt chain has gaps or missing genesis |
| **R balance correctness** | Periodically (configurable) | Record discrepancy, mark R as unverified |
| **Claim amount correctness** | On every new epoch claim | Flag overclaim, publish fraud proof |
| **Double-spend detection** | On every Y balance update | Publish fraud proof as immutable Chunk |
| **Invitation chain validity** | On new user discovery | Reject user if invitation is invalid |
| **Content flag aggregation** | On every flag GraphEntry | Update moderation verdict per policy |

### Watcher Cycle

```rust
/// Run watcher verification on recently crawled data.
pub async fn run_watcher_cycle(
    storage: &dyn Storage,
    index: &IndexStore,
) -> Result<WatcherReport, IndexerError> {
    let mut report = WatcherReport::default();

    // 1. Check all Y balances updated since last watcher cycle
    let updated_y_users = index.users_with_updated_y_since_last_watch().await?;
    for user_pk in &updated_y_users {
        let verdict = verify_y_balance(storage, user_pk).await?;
        match verdict {
            WatcherVerdict::Valid => report.y_valid += 1,
            WatcherVerdict::FraudDetected(proof) => {
                // Publish fraud proof to Autonomi (permanent record)
                let proof_bytes = bincode::serialize(&proof)?;
                storage.put(&proof_bytes).await?;
                index.record_fraud_proof(&proof).await?;
                report.fraud_proofs_published += 1;
                tracing::error!(offender = ?proof.offender, "FRAUD PROOF PUBLISHED");
            }
            other => {
                tracing::warn!(user = ?user_pk, verdict = ?other, "Y balance verification failed");
                report.y_invalid += 1;
            }
        }
    }

    // 2. Spot-check R balances (random sample per cycle)
    let sample = index.random_user_sample(config.r_spotcheck_sample_size).await?;
    for user_pk in &sample {
        let r_verdict = verify_r_balance(storage, user_pk).await?;
        match r_verdict {
            RVerdict::Valid => report.r_valid += 1,
            RVerdict::Invalid { claimed, correct } => {
                tracing::warn!(
                    user = ?user_pk, claimed, correct,
                    "R balance mismatch"
                );
                report.r_mismatches += 1;
                // R mismatches are not fraud (R is self-claimed) but the indexer
                // uses the recomputed value for its own rankings
                index.override_r_balance(user_pk, correct).await?;
            }
        }
    }

    // 3. Verify epoch claims
    let latest_epoch = index.latest_epoch().await?;
    if let Some(epoch) = latest_epoch {
        let claim_verdicts = verify_epoch_claims(storage, epoch.epoch).await?;
        for verdict in &claim_verdicts {
            match verdict {
                ClaimVerdict::Overclaim { claimer, claimed, correct } => {
                    tracing::error!(
                        claimer = ?claimer, claimed, correct,
                        "Y overclaim detected"
                    );
                    report.overclaims += 1;
                }
                _ => {}
            }
        }
    }

    Ok(report)
}

#[derive(Default)]
pub struct WatcherReport {
    pub y_valid: u64,
    pub y_invalid: u64,
    pub r_valid: u64,
    pub r_mismatches: u64,
    pub fraud_proofs_published: u64,
    pub overclaims: u64,
}
```

### R Balance Override Strategy

Since R is deterministically computable, the indexer does NOT blindly trust the R value in a user's Scratchpad. The indexer:

1. Reads the self-claimed R balance from the Scratchpad
2. Periodically recomputes R from scratch using `compute_r_from_scratch()` from `dsn-token-r`
3. Uses the **recomputed value** for feed ranking and API responses
4. Reports discrepancies but does not publish fraud proofs for R (R is self-claimed, not a fraud-proof-able offense -- the indexer simply ignores incorrect values)

## Configuration (`config.rs`)

```rust
/// Full configuration for the indexer service.
#[derive(Clone, Serialize, Deserialize)]
pub struct IndexerConfig {
    /// Network binding address for the REST API.
    pub bind_address: String,          // default: "0.0.0.0:3000"
    /// Port for the REST API.
    pub bind_port: u16,                // default: 3000

    /// Crawler settings.
    pub crawler: CrawlerConfig,

    /// Moderation policy.
    pub moderation: ModerationPolicyConfig,

    /// Local storage path for SQLite index.
    pub db_path: String,               // default: "./indexer.db"

    /// Autonomi network connection (when using real backend).
    pub autonomi_peers: Vec<String>,   // default: empty (use mock)
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CrawlerConfig {
    /// Duration between crawl cycles.
    pub crawl_interval: Duration,      // default: 60 seconds

    /// Maximum number of users to crawl per cycle.
    /// 0 = unlimited (crawl all known users).
    pub max_users_per_cycle: u64,      // default: 0

    /// Maximum number of concurrent Autonomi reads.
    pub max_concurrent_reads: usize,   // default: 50

    /// Number of R balances to spot-check per cycle.
    pub r_spotcheck_sample_size: usize, // default: 100

    /// Whether to publish fraud proofs when detected.
    /// Operators may disable this if they want read-only mode.
    pub publish_fraud_proofs: bool,    // default: true

    /// Seed users: public keys to bootstrap discovery.
    /// At least one seed user is needed for a fresh indexer.
    pub seed_users: Vec<String>,       // hex-encoded public keys
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ModerationPolicyConfig {
    /// Policy name (for display in /health endpoint).
    pub policy_name: String,           // default: "default-v1"

    /// Minimum total R of flaggers required to trigger a "Warned" verdict.
    pub warn_threshold_r: u64,         // default: 50

    /// Minimum total R of flaggers required to trigger a "Hidden" verdict.
    pub hide_threshold_r: u64,         // default: 200

    /// Minimum number of unique flaggers required (regardless of R).
    pub min_unique_flaggers: u32,      // default: 3

    /// Whether to hide posts from users with active fraud proofs.
    pub hide_fraudulent_users: bool,   // default: true

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

[crawler]
crawl_interval_secs = 60
max_users_per_cycle = 0
max_concurrent_reads = 50
r_spotcheck_sample_size = 100
publish_fraud_proofs = true
seed_users = [
    "a1b2c3d4..."
]

[moderation]
policy_name = "default-v1"
warn_threshold_r = 50
hide_threshold_r = 200
min_unique_flaggers = 3
hide_fraudulent_users = true
blocked_users = []
blocked_posts = []
```

### Moderation Policy Design

Each indexer operator chooses their own moderation policy. This is a feature, not a bug:

- **Strict indexers** may set low thresholds and aggressively hide flagged content
- **Permissive indexers** may set high thresholds and show everything
- **Community indexers** may maintain curated block lists for specific communities
- **Unmoderated indexers** may disable moderation entirely (set thresholds to `u64::MAX`)

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

    #[error("user not found: {pk}")]
    UserNotFound { pk: String },

    #[error("post not found: {address}")]
    PostNotFound { address: String },

    #[error("invalid public key: {0}")]
    InvalidPublicKey(String),

    #[error("invalid content address: {0}")]
    InvalidContentAddress(String),

    #[error("crawl error for user {user}: {reason}")]
    CrawlError { user: String, reason: String },

    #[error("watcher error: {0}")]
    WatcherError(String),

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
            Self::UserNotFound { .. } | Self::PostNotFound { .. } => StatusCode::NOT_FOUND,
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
/// The top-level indexer service. Owns the crawler, index store, and API server.
pub struct IndexerService {
    config: IndexerConfig,
    storage: Arc<dyn Storage>,
    index: Arc<dyn IndexStore>,
}

impl IndexerService {
    /// Create a new indexer service with the given configuration.
    pub async fn new(config: IndexerConfig) -> Result<Self, IndexerError>;

    /// Start the indexer: launches the crawl loop and API server concurrently.
    pub async fn run(&self) -> Result<(), IndexerError> {
        let crawler_handle = tokio::spawn({
            let storage = self.storage.clone();
            let index = self.index.clone();
            let config = self.config.crawler.clone();
            async move {
                run_crawl_loop(storage, index, &config).await
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

        // Both tasks run indefinitely. If either exits, shut down.
        tokio::select! {
            result = crawler_handle => {
                tracing::error!("crawler exited: {:?}", result);
            }
            result = api_handle => {
                tracing::error!("API server exited: {:?}", result);
            }
        }

        Ok(())
    }
}
```

## Trust Model Summary

The indexer is an **untrusted convenience layer**. Its trust model is:

| Property | Guarantee |
|---|---|
| **Data integrity** | Every indexed item traces back to a signed Autonomi object. Clients can verify any item via the spot-check API or by reading Autonomi directly. |
| **Completeness** | NOT guaranteed. An indexer may omit posts (censorship). Clients detect this by querying multiple indexers or checking a user's FeedIndex Scratchpad directly. |
| **Ranking fairness** | NOT guaranteed. An indexer may bias feed rankings. Clients can request `Chronological` ranking as a neutral baseline. |
| **Moderation accuracy** | Subjective by design. Each indexer applies its own moderation policy. Clients choose the indexer whose policy they agree with. |
| **Fraud detection** | Best-effort. Indexers as full watchers increase fraud detection probability. Multiple indexers running simultaneously make fraud nearly impossible to hide. |
| **Availability** | NOT guaranteed by any single indexer. Multiple competing indexers provide redundancy. The source data on Autonomi is always available independently. |
