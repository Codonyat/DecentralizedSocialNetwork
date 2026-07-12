# CLI Client Design (`dsn-cli`)

## Purpose

The CLI client is the primary user-facing interface for interacting with the decentralized social network. It manages local key material, signs transactions, publishes data to the network (via dsn-data), queries indexers for aggregated feeds, and performs spot-check verification of indexer results to maintain trust minimization.

## Module Structure

```
crates/cli/src/
├── main.rs             # Entry point, tokio runtime, clap dispatch
├── commands/
│   ├── mod.rs          # Command enum re-exports
│   ├── key.rs          # Key generation, import, export
│   ├── profile.rs      # Profile create, update, view
│   ├── post.rs         # Post create, read, reply, repost, thread view
│   ├── social.rs       # Follow, unfollow, feed view
│   ├── token_y.rs      # Donate, tip, view balance, emission info
│   ├── name.rs         # Claim/assess handles, rent status, pay rent, force-buy, lookup(+history)
│   ├── invitation.rs   # Invite users, view invitation chain
│   └── label.rs        # Add/list content labels
├── config.rs           # Configuration loading (file + env + flags)
├── keystore.rs         # Local encrypted keyfile management
├── indexer_client.rs   # HTTP client for indexer REST API
├── spot_check.rs       # Spot-check verification of indexer results
├── output.rs           # Formatted output (table, JSON, human-readable)
└── error.rs            # CLI error types
```

## Command Hierarchy (clap Subcommands)

The CLI uses `clap` with the derive API. Every subcommand maps to a handler function in the corresponding `commands/` module.

```rust
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "dsn", version, about = "Decentralized Social Network CLI")]
pub struct Cli {
    /// Path to config file (default: ~/.dsn/config.toml)
    #[arg(long, global = true)]
    pub config: Option<PathBuf>,

    /// Path to keyfile (overrides config)
    #[arg(long, global = true)]
    pub keyfile: Option<PathBuf>,

    /// Indexer URL (overrides config)
    #[arg(long, global = true)]
    pub indexer: Option<String>,

    /// Output format
    #[arg(long, global = true, default_value = "human")]
    pub format: OutputFormat,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Key management
    Key(KeyCommand),
    /// Profile management
    Profile(ProfileCommand),
    /// Posts
    Post(PostCommand),
    /// Social graph
    Social(SocialCommand),
    /// Token Y operations
    #[command(name = "y")]
    TokenY(TokenYCommand),
    /// Handle management (Harberger-rented @handles)
    Name(NameCommand),
    /// Invitation management
    Invite(InviteCommand),
    /// Content labels
    Label(LabelCommand),
    /// View a creator's supporters (donor recognition; indexer convenience, NOT protocol)
    Supporters {
        /// Public key of the creator (short hex or full hex)
        creator: String,
    },
}
```

### Key Subcommands (`key.rs`)

```rust
#[derive(Parser)]
pub struct KeyCommand {
    #[command(subcommand)]
    pub action: KeyAction,
}

#[derive(Subcommand)]
pub enum KeyAction {
    /// Generate a new ed25519 keypair and store in local keyfile.
    /// The genesis public key becomes your permanent IdentityId.
    Generate {
        /// Path to write keyfile (default: ~/.dsn/key.enc)
        #[arg(long)]
        output: Option<PathBuf>,
    },
    /// Import an existing secret key from hex
    Import {
        /// Hex-encoded secret key
        #[arg(long)]
        hex: String,
    },
    /// Export the public key (safe to share)
    ExportPub,
    /// Export the secret key as hex (DANGER: reveals secret)
    ExportSecret {
        /// Confirm you understand the risk
        #[arg(long)]
        i_understand: bool,
    },
    /// Rotate the signing key: generate a fresh ed25519 keypair, register it in
    /// the IdentityRegistry (effective next epoch), and rewrite the keyfile.
    /// Your IdentityId is unchanged and previously signed objects stay valid.
    Rotate {
        /// Path to write the new keyfile (default: overwrite the current one)
        #[arg(long)]
        output: Option<PathBuf>,
    },
    /// Opt in to M-of-N social recovery by registering guardians (their
    /// IdentityIds) and a threshold. Signed by your current key.
    RecoverySetup {
        /// Guardian IdentityId in hex (repeatable). Invitation-tree neighbors
        /// are the natural choice.
        #[arg(long = "guardian")]
        guardians: Vec<String>,
        /// Number of guardian approvals required (M of N).
        #[arg(long)]
        threshold: u32,
    },
    /// Guardian-side: propose a new key for an identity whose owner lost access.
    /// Once M approvals land, a RECOVERY_VETO_EPOCHS = 2 veto window opens;
    /// execution is automatic at the deadline (no separate command).
    RecoveryPropose {
        /// IdentityId being recovered (hex)
        #[arg(long)]
        identity: String,
        /// New public key to install (hex)
        #[arg(long)]
        new_key: String,
        /// Signature scheme of the new key (1 = ed25519)
        #[arg(long, default_value = "1")]
        scheme_id: u8,
    },
    /// Guardian-side: approve an open recovery proposal.
    RecoveryApprove {
        /// IdentityId being recovered (hex)
        #[arg(long)]
        identity: String,
        /// Proposal id to approve
        #[arg(long)]
        proposal_id: String,
    },
    /// Owner-side: veto the active recovery proposal on your identity with your
    /// current key. The current key's veto always wins during the veto window
    /// (this is what makes recovery safe against loss but not against theft of
    /// an active key).
    RecoveryVeto {
        /// IdentityId whose active recovery to veto (defaults to your own)
        #[arg(long)]
        identity: Option<String>,
    },
    /// Show key info: IdentityId (genesis key), current signing key + scheme,
    /// and recovery status (guardians and any open recovery proposal).
    Info,
}
```

Sample transcript (rotation and recovery setup):

```bash
# Rotate the signing key (IdentityId is permanent; old objects stay valid)
$ dsn key rotate
Enter passphrase: ********
Key rotated. IdentityId unchanged: a1b2c3d4e5f6a7b8...
  New signing key: 9f8e7d6c...   (ed25519, effective epoch 44)
  Previously signed objects remain valid.

# Register 2-of-3 guardians for social recovery
$ dsn key recovery-setup --guardian b0c1d2e3... --guardian c1d2e3f4... --guardian d2e3f4a5... --threshold 2
Enter passphrase: ********
Guardians set: 2-of-3. Recovery proposals enter a RECOVERY_VETO_EPOCHS = 2
veto window before taking effect; execution is automatic at the deadline.

# Inspect identity + recovery status
$ dsn key info
IdentityId (genesis):  a1b2c3d4e5f6a7b8...
Current signing key:   9f8e7d6c...   (ed25519, scheme 1)
Recovery:              2-of-3 guardians set; no active proposal
```

### Profile Subcommands (`profile.rs`)

```rust
#[derive(Subcommand)]
pub enum ProfileAction {
    /// Create initial profile (one-time setup)
    Create {
        #[arg(long)]
        name: String,
        #[arg(long)]
        bio: String,
    },
    /// Update display name and/or bio
    Update {
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        bio: Option<String>,
    },
    /// View a user's profile by public key (short hex or full)
    View {
        /// Public key (short hex or full hex)
        user: String,
    },
    /// View your own profile
    Me,
}
```

### Post Subcommands (`post.rs`)

```rust
#[derive(Subcommand)]
pub enum PostAction {
    /// Create a new post
    Create {
        /// Post content (max 4000 chars)
        content: String,
        /// Mention a user by @handle (repeatable). Resolved to the user's
        /// public key at write time and stored in `Post.mentions` — mentions
        /// hold public keys, never handles, so they survive handle changes.
        #[arg(long)]
        mention: Vec<String>,
        /// Attach media by file path or existing content hash (repeatable).
        /// A file is hashed locally and added to `Post.media` as a `MediaRef`
        /// (content hash + optional server hints); bytes are published to a
        /// media-hosting indexer and served honestly by content addressing.
        #[arg(long)]
        media: Vec<String>,
    },
    /// Reply to an existing post
    Reply {
        /// Content address of the parent post
        #[arg(long)]
        to: String,
        /// Reply content
        content: String,
        /// Mention a user by @handle (repeatable); resolved to a public key at write time.
        #[arg(long)]
        mention: Vec<String>,
    },
    /// Repost or quote an existing post. `repost_of` is set on the new post;
    /// `reply_to` and `repost_of` may never both be set. Omit `--quote` for a
    /// pure repost (empty content); pass it to create a quote post.
    Repost {
        /// Content address of the post to repost
        address: String,
        /// Add commentary to create a quote post
        #[arg(long)]
        quote: Option<String>,
    },
    /// View a single post by content address
    View {
        /// Content address of the post
        address: String,
    },
    /// View a thread (post + all replies)
    Thread {
        /// Content address of the root post
        address: String,
    },
    /// List recent posts by a user
    By {
        /// Public key of the author
        user: String,
        /// Number of posts to show
        #[arg(long, default_value = "20")]
        limit: usize,
    },
}
```

### Social Subcommands (`social.rs`)

```rust
#[derive(Subcommand)]
pub enum SocialAction {
    /// Follow a user
    Follow {
        /// Public key of user to follow
        user: String,
    },
    /// Unfollow a user
    Unfollow {
        /// Public key of user to unfollow
        user: String,
    },
    /// View your follow list
    Following,
    /// View your feed (posts from followed users)
    Feed {
        /// Number of posts to show
        #[arg(long, default_value = "50")]
        limit: usize,
        /// Show only posts after this content address
        #[arg(long)]
        after: Option<String>,
        /// Rank locally: fetch un-ranked candidates from the indexer and
        /// order them with the on-device model (see 09-client-ranking.md).
        /// Without this flag the indexer's server-side ranking is used
        /// (thin-client path).
        #[arg(long)]
        local: bool,
        /// Ranker to use with --local (a weights file installed in the
        /// ranker directory; defaults to the bundled open-weights ranker).
        #[arg(long)]
        ranker: Option<String>,
    },
    /// View followers (users who follow you) — requires indexer
    Followers,
}
```

**Local ranking mode.** With `--local`, the CLI calls `GET /api/v1/candidates/:user_pk` instead of the feed endpoint and ranks on-device using the local interaction log (dwell, replies, donations — recorded locally, never uploaded). Rankers are weights + a declared feature schema executed by the CLI's fixed runtime — never code — and are swappable per invocation. Full design: 09-client-ranking.md.

### Token Y Subcommands (`token_y.rs`)

```rust
#[derive(Subcommand)]
pub enum TokenYAction {
    /// View your Y balance
    Balance,
    /// Donate Y to a post's creator
    Donate {
        /// Content address of the post
        #[arg(long)]
        post: String,
        /// Amount of Y to donate
        #[arg(long)]
        amount: u64,
        /// Donate privately: the client generates a fresh standalone keypair,
        /// funds it, and donates from it. The donation carries zero emission
        /// weight (the fresh key is outside your invitation tree) and appears
        /// anonymous in supporter features. Privacy is unlinkability at the
        /// donation layer only, NOT chain-analysis resistance (the funding
        /// transfer is public); private donors pay their own gas.
        #[arg(long)]
        private: bool,
    },
    /// Tip Y to another user
    Tip {
        /// Recipient public key
        #[arg(long)]
        to: String,
        /// Amount of Y to send
        #[arg(long)]
        amount: u64,
    },
    /// View Y transaction history
    History {
        /// Number of transactions to show
        #[arg(long, default_value = "20")]
        limit: usize,
    },
    /// View the current epoch emission info
    Emission,
}
```

### Name Subcommands (`name.rs`)

```rust
#[derive(Subcommand)]
pub enum NameAction {
    /// Claim an unowned @handle. Sets the self-assessed value V (Harberger)
    /// and pays the first epoch's rent into the Reward Pool at claim time.
    Claim {
        /// The @handle to claim (given without the leading @)
        handle: String,
        /// Self-assessed value V in Y (atomic units). Mandatory and must be
        /// >= the tier floor for short handles (len 1-6). Omit for the flat
        /// tier (len >= 7), where V is meaningless: flat 1 Y/epoch rent, no
        /// force-buy.
        #[arg(long)]
        value: Option<u64>,
    },
    /// Change the self-assessed value V of a handle you own. Increases take
    /// effect immediately; decreases take effect only after the lookback
    /// window (26 epochs).
    Assess {
        /// The @handle to reassess
        handle: String,
        /// New self-assessed value V in Y (atomic units)
        #[arg(long)]
        value: u64,
    },
    /// Pay rent on a handle you own, extending its paid-through epoch.
    /// Rent flows to the Reward Pool.
    PayRent {
        /// The @handle to pay rent on
        handle: String,
        /// Number of epochs of rent to prepay
        #[arg(long, default_value = "1")]
        epochs: u32,
    },
    /// Show rent status for a handle: per-epoch rent, paid-through epoch,
    /// and grace/lapse state.
    RentStatus {
        /// The @handle to check
        handle: String,
    },
    /// Force-buy a short (Harberger-tier) handle at its deterministic price
    /// = max(V, floor). Escrows the bid for the notice window and pays a
    /// non-refundable 1% fee to the Reward Pool. Not available for flat-tier
    /// handles (len >= 7 are a safe harbor).
    ForceBuy {
        /// The @handle to force-buy
        handle: String,
    },
    /// Resolve a handle to its owner, with live rent status and ownership history.
    Lookup {
        /// The @handle to look up
        handle: String,
    },
}
```

### Invitation Subcommands (`invitation.rs`)

```rust
#[derive(Subcommand)]
pub enum InviteAction {
    /// Send an invitation to a new user (costs Y)
    Send {
        /// Public key of the invitee
        #[arg(long)]
        to: String,
        /// Starter grant: a plain Y transfer from inviter to invitee sent
        /// alongside the invitation, so the new account can immediately donate
        /// and rent a handle. Reference-client convention (default 5 Y), not a
        /// contract rule — a starter grant is just a transfer.
        #[arg(long, default_value = "5000000")]
        grant: u64,
    },
    /// View your invitation chain (who invited you, who you invited)
    Chain,
}
```

### Label Subcommands (`label.rs`)

```rust
#[derive(Subcommand)]
pub enum LabelAction {
    /// Attach a label to a post: an ordinary signed, content-addressed object
    /// (see 06-moderation.md), not a protocol-adjudicated flag. Label strings
    /// match `^[a-z0-9-]{1,64}$`; common values by convention are spam,
    /// harassment, violence, illegal, nsfw, and dispute (the author-rebuttal
    /// convention) — the namespace is open, not an enum.
    Add {
        /// Content address of the post to label
        post: String,
        /// Label string (e.g. spam, harassment, dispute)
        label: String,
    },
    /// View labels on a post: the raw public label record. Aggregation,
    /// thresholds, and any visibility verdict are client/indexer policy, not
    /// protocol (see 06-moderation.md, 07-indexer.md).
    List {
        /// Content address of the post
        post: String,
    },
}
```

### Donor Recognition Display (client convention, NOT protocol)

Donor recognition is a **presentation-layer convenience** computed by the client and
indexer from public chain data. It is verifiable but carries **no economic-accuracy
guarantee** — the protocol still treats a donation as a pure financial loss with no
on-chain privilege. The CLI surfaces three conventions:

- **Thread-level prominence.** A donor's replies rank higher *within the donated
  thread only*, proportional to the amount donated (a "superchat"). This never
  buys global reach — confining the boost to the thread prevents pay-for-reach
  corruption of the wider feed.
- **Supporter badges.** A user's lifetime Y donated to a creator, shown as a badge
  on that creator's threads. Derived from public donations, so anyone can recompute it.
- **Creator leaderboards.** `dsn supporters <creator>` renders the creator's ranked
  supporter list from the indexer's `GET /api/v1/creators/:pk/supporters` endpoint.

## Key Storage Design (`keystore.rs`)

### Keyfile Format

The local keyfile stores the user's ed25519 secret key encrypted with a passphrase. The file lives at `~/.dsn/key.enc` by default.

```rust
/// On-disk keyfile structure.
/// Stored as JSON for human-inspectability of the metadata fields.
#[derive(Serialize, Deserialize)]
pub struct KeyFile {
    /// Format version (for future migration).
    pub version: u32,               // Currently 1

    /// The public key in hex (allows identifying the account without decryption).
    pub public_key_hex: String,

    /// Salt for passphrase-based key derivation (32 bytes, hex).
    pub salt: String,

    /// Nonce for AEAD encryption (24 bytes for XChaCha20-Poly1305, hex).
    pub nonce: String,

    /// Encrypted secret key bytes (XChaCha20-Poly1305 ciphertext, hex).
    pub ciphertext: String,
}
```

### Encryption Scheme

1. User provides a passphrase at key generation or when unlocking
2. Derive an encryption key: `Argon2id(passphrase, salt) -> 32-byte key`
3. Encrypt the 32-byte ed25519 secret key with XChaCha20-Poly1305
4. Store the result as a JSON keyfile

### Key Operations

```rust
pub struct Keystore {
    path: PathBuf,
}

impl Keystore {
    /// Create a new Keystore at the given path.
    pub fn new(path: PathBuf) -> Self;

    /// Generate a new keypair, encrypt, and write to disk.
    /// Prompts for passphrase on stdin.
    pub fn generate(&self) -> Result<PublicKey, KeystoreError>;

    /// Import a secret key from hex, encrypt, and write to disk.
    pub fn import_hex(&self, hex: &str) -> Result<PublicKey, KeystoreError>;

    /// Load and decrypt the secret key.
    /// Prompts for passphrase on stdin.
    pub fn load(&self) -> Result<SecretKey, KeystoreError>;

    /// Read the public key without decryption (from keyfile metadata).
    pub fn public_key(&self) -> Result<PublicKey, KeystoreError>;

    /// Export the public key as hex.
    pub fn export_public_hex(&self) -> Result<String, KeystoreError>;

    /// Export the secret key as hex (after passphrase verification).
    pub fn export_secret_hex(&self) -> Result<String, KeystoreError>;

    /// Check if a keyfile exists at the configured path.
    pub fn exists(&self) -> bool;
}
```

### Passphrase Handling

- Passphrases are read from stdin via `rpassword` (no echo)
- For non-interactive use (scripts, CI), support the `DSN_PASSPHRASE` environment variable
- The passphrase is zeroized from memory after use via `zeroize`
- The decrypted secret key is held in memory only for the duration of the command

## Indexer Client (`indexer_client.rs`)

The CLI queries an indexer's REST API for aggregated data (feeds, search, statistics). The indexer is described in `07-indexer.md`. The CLI treats the indexer as an untrusted convenience layer.

### Client Structure

```rust
pub struct IndexerClient {
    base_url: String,
    http: reqwest::Client,
    /// Maximum time to wait for a response.
    timeout: Duration,
}

impl IndexerClient {
    pub fn new(base_url: String, timeout: Duration) -> Self;

    // --- Feed queries ---

    /// Fetch the personalized feed for a user (posts from followed accounts,
    /// ranked by the indexer).
    pub async fn feed(
        &self,
        user: &PublicKey,
        limit: usize,
        after: Option<&ContentAddress>,
    ) -> Result<Vec<FeedItem>, IndexerError>;

    /// Fetch the global trending feed.
    pub async fn trending(
        &self,
        limit: usize,
    ) -> Result<Vec<FeedItem>, IndexerError>;

    // --- Post queries ---

    /// Fetch a single post by content address.
    pub async fn get_post(
        &self,
        address: &ContentAddress,
    ) -> Result<PostDetail, IndexerError>;

    /// Fetch a thread (root post + all replies, nested).
    pub async fn get_thread(
        &self,
        root: &ContentAddress,
    ) -> Result<ThreadView, IndexerError>;

    /// Fetch recent posts by a user.
    pub async fn posts_by_user(
        &self,
        user: &PublicKey,
        limit: usize,
    ) -> Result<Vec<PostDetail>, IndexerError>;

    // --- Profile queries ---

    /// Fetch a user's profile.
    pub async fn get_profile(
        &self,
        user: &PublicKey,
    ) -> Result<UserProfile, IndexerError>;

    /// Fetch a user's followers list.
    pub async fn get_followers(
        &self,
        user: &PublicKey,
    ) -> Result<Vec<PublicKey>, IndexerError>;

    // --- Token queries ---

    /// Fetch Y balance for a user (as reported by indexer).
    pub async fn y_balance(
        &self,
        user: &PublicKey,
    ) -> Result<YBalanceSummary, IndexerError>;

    /// Fetch epoch info via `GET /api/v1/epoch`: current epoch, scheduled
    /// emission, Reward Pool drip (2% of balance), and Reward Pool balance.
    pub async fn epoch_info(&self) -> Result<EpochInfo, IndexerError>;

    // --- Handle queries ---

    /// Resolve an @handle to its current owner's public key.
    pub async fn name_lookup(
        &self,
        handle: &str,
    ) -> Result<Option<PublicKey>, IndexerError>;

    /// Fetch the full Harberger status of an @handle: owner, self-assessed
    /// value, tier, per-epoch rent, rent status, any pending force-buy, and
    /// ownership history.
    pub async fn name_status(
        &self,
        handle: &str,
    ) -> Result<NameStatus, IndexerError>;

    // --- Donation queries ---

    /// Fetch donation totals for a post.
    pub async fn post_donations(
        &self,
        post: &ContentAddress,
    ) -> Result<DonationInfo, IndexerError>;

    /// Fetch a creator's supporter leaderboard (donor recognition; derived
    /// from public chain data, NOT under the economic-accuracy guarantee).
    pub async fn creator_supporters(
        &self,
        creator: &PublicKey,
    ) -> Result<CreatorSupporters, IndexerError>;

    // --- Label queries ---

    /// Fetch labels attached to a post (raw public record; see 06-moderation.md).
    pub async fn get_labels(
        &self,
        post: &ContentAddress,
    ) -> Result<Vec<LabelInfo>, IndexerError>;

    // --- Invitation queries ---

    /// Fetch the invitation chain for a user.
    pub async fn invitation_chain(
        &self,
        user: &PublicKey,
    ) -> Result<InvitationChain, IndexerError>;
}
```

### Indexer Response Types

```rust
/// A post in a feed listing.
pub struct FeedItem {
    pub post: Post,
    pub address: ContentAddress,
    pub author_profile: Option<UserProfile>,
    pub reply_count: u64,
    /// Content address of the original post, if this is a repost or quote.
    pub repost_of: Option<ContentAddress>,
    /// Count of reposts/quotes of this post.
    pub repost_count: u64,
    pub donation_total: u64,
    /// Donor-recognition badge for the author (client convention, NOT protocol).
    pub author_badge: Option<SupporterBadge>,
}

/// Detailed post view.
pub struct PostDetail {
    pub post: Post,
    pub address: ContentAddress,
    pub author_profile: Option<UserProfile>,
    pub reply_count: u64,
    /// Content address of the original post, if this is a repost or quote.
    pub repost_of: Option<ContentAddress>,
    /// Count of reposts/quotes of this post.
    pub repost_count: u64,
    pub donation_total: u64,
    pub labels: Vec<LabelInfo>,
    /// Donor-recognition badge for the author (client convention, NOT protocol).
    pub author_badge: Option<SupporterBadge>,
    /// Thread-scoped donor prominence (atomic Y donated to this thread's root
    /// author); used only to rank this reply within its thread, never globally.
    pub thread_prominence: Option<u64>,
}

/// Thread view: root post plus nested replies.
pub struct ThreadView {
    pub root: PostDetail,
    /// Nested replies, ordered by thread-scoped donor prominence then recency.
    pub replies: Vec<ThreadView>,
    /// True if this node was surfaced by thread-level donor prominence
    /// (superchat-style boost, confined to this thread only).
    pub donor_boosted: bool,
}

/// Donor-recognition badge, computed from public chain data. Verifiable but
/// NOT part of the protocol's economic-accuracy guarantee.
pub struct SupporterBadge {
    /// Lifetime Y donated to the creator in context (atomic units, JSON string).
    pub lifetime_donated: u64,
    /// Rank on the creator's supporter leaderboard, if ranked.
    pub rank: Option<u32>,
}

/// A creator's supporter leaderboard.
pub struct CreatorSupporters {
    pub creator: PublicKey,
    pub supporters: Vec<SupporterEntry>,
}

pub struct SupporterEntry {
    pub supporter: PublicKey,
    pub profile: Option<UserProfile>,
    pub lifetime_donated: u64,  // atomic Y
    pub rank: u32,
}

/// Full Harberger status of an @handle (returned by `name_status`).
pub struct NameStatus {
    pub handle: String,
    /// None if the handle is unowned or has lapsed.
    pub owner: Option<PublicKey>,
    /// Self-assessed value V in atomic Y; 0 for the flat tier.
    pub assessed_value: u64,
    pub tier: HandleTier,
    /// Rent per epoch in atomic Y (0.1% of max(V, floor) for Harberger; flat 1 Y).
    pub rent_per_epoch: u64,
    pub rent_status: RentState,
    /// Present while a force-buy is in its notice window.
    pub force_buy_pending: Option<ForceBuyState>,
    pub ownership_history: Vec<OwnershipRecord>,
    /// True if ownership changed within the lookback window (26 epochs).
    pub recently_changed_owner: bool,
}

pub enum HandleTier {
    /// len 1-6: rent = 0.1% of max(V, floor), force-buyable.
    Harberger,
    /// len >= 7: flat 1 Y/epoch, no force-buy (safe harbor).
    Flat,
}

pub enum RentState {
    Paid { through_epoch: u64 },
    Grace { epochs_left: u32 },
    Lapsed,
}

pub struct ForceBuyState {
    pub bidder: PublicKey,
    pub bid: u64,             // escrowed, atomic Y
    pub deadline_epoch: u64,
}

pub struct OwnershipRecord {
    pub owner: PublicKey,
    pub claimed_at_epoch: u64,
    pub released_at_epoch: Option<u64>,
}
```

## Spot-Check Verification Flow (`spot_check.rs`)

The CLI does not blindly trust indexer results. It performs probabilistic spot-checks by fetching the raw signed object from an alternate indexer or the local store (via dsn-data), verifying its signature locally against the key current for the author's IdentityId, and cross-checking on-chain data (via dsn-chain) against the indexer's claims. Where an existed-before bound matters, it also fetches the object's anchor proof via `GET /api/v1/spotcheck/anchor/:address` (a Merkle branch to an on-chain anchor root) — see 07-indexer.md.

### Strategy

```rust
pub struct SpotChecker {
    storage: Arc<dyn Storage>,
    chain: Arc<dyn ChainReader>,
    /// Probability of spot-checking any given indexer result (0.0..=1.0).
    check_probability: f64,
    /// Results of recent spot-checks.
    recent_results: Mutex<VecDeque<SpotCheckResult>>,
    /// Maximum stored results.
    max_results: usize,
}

impl SpotChecker {
    pub fn new(
        storage: Arc<dyn Storage>,
        chain: Arc<dyn ChainReader>,
        check_probability: f64,
    ) -> Self;

    /// Decide whether to spot-check a given item (probabilistic).
    fn should_check(&self) -> bool;

    /// Verify a post: fetch the signed object from an alternate indexer or the
    /// local store, check its signature locally, and match it against the
    /// indexer's version.
    pub async fn verify_post(
        &self,
        indexer_post: &PostDetail,
    ) -> Result<SpotCheckResult, SpotCheckError>;

    /// Verify a post's existed-before bound via its anchor proof
    /// (`GET /api/v1/spotcheck/anchor/:address`): recompute the content address,
    /// walk the Merkle branch to the anchor root, and confirm the anchoring
    /// transaction's block predates any claimed timestamp dispute.
    pub async fn verify_anchor(
        &self,
        post: &ContentAddress,
    ) -> Result<SpotCheckResult, SpotCheckError>;

    /// Verify donation data reported by the indexer against on-chain records.
    pub async fn verify_donations(
        &self,
        post: &ContentAddress,
        indexer_donations: &DonationInfo,
    ) -> Result<SpotCheckResult, SpotCheckError>;

    /// Return a summary of recent spot-check results.
    pub fn summary(&self) -> SpotCheckSummary;
}
```

### Spot-Check Verification Steps

**Post verification:**

1. Fetch the signed object at the content address from an alternate indexer (or the local store) via `ContentStore::get()`
2. Deserialize the object into a `Post`
3. Verify the signature locally (`Post::verify()`) against the key current for the author's IdentityId at the object's epoch
4. Compare author, content, and timestamp against the indexer's response
5. If any field mismatches, flag the indexer result as untrustworthy

**Anchor verification (existed-before bound):**

1. Fetch the anchor proof via `GET /api/v1/spotcheck/anchor/:address` from any indexer whose anchor includes the object
2. Recompute the content address from the signed bytes and confirm it is the Merkle-branch leaf
3. Confirm the branch resolves to an on-chain anchor root; the anchoring transaction's block gives a trustless "existed before" bound (independent of the informational `claimed_epoch`)
4. An un-anchored object is reported Inconclusive until the next anchor interval

**Donation verification:**

1. Read donation records for the post from on-chain data via `dsn-chain`
2. Compare the total donated amount and individual donations against the indexer's report
3. If any values mismatch, flag the indexer result as untrustworthy

### Result Types

```rust
pub enum SpotCheckResult {
    /// Indexer data matches on-chain data.
    Match {
        check_type: CheckType,
        target: String,
    },
    /// Indexer data differs from on-chain data.
    Mismatch {
        check_type: CheckType,
        target: String,
        indexer_value: String,
        onchain_value: String,
    },
    /// Could not verify (e.g., object not found on any source, not yet
    /// anchored, network error).
    Inconclusive {
        check_type: CheckType,
        target: String,
        reason: String,
    },
}

pub enum CheckType {
    PostContent,
    PostSignature,
    PostAnchor,
    DonationData,
}

pub struct SpotCheckSummary {
    pub total_checks: usize,
    pub matches: usize,
    pub mismatches: usize,
    pub inconclusive: usize,
    /// Trust score: matches / (matches + mismatches). Inconclusive excluded.
    pub trust_score: f64,
}
```

### Trust Degradation

The CLI tracks spot-check results across the session. If the trust score drops below a configurable threshold (default: 0.8), the CLI prints a warning on every indexer query:

```
WARNING: Indexer trust score is 0.65 (13/20 verified). Results may be unreliable.
Consider switching indexers with: dsn --indexer <url> ...
```

## Configuration (`config.rs`)

### Config File

Located at `~/.dsn/config.toml` by default. All values can be overridden via CLI flags or environment variables.

```toml
# ~/.dsn/config.toml

# Indexer to query for aggregated data
indexer_url = "http://localhost:3000"

# Path to encrypted keyfile
keyfile = "~/.dsn/key.enc"

# Output format: "human", "json", or "table"
default_format = "human"

# Spot-check probability (0.0 to 1.0)
# Higher = more verification, slower; Lower = faster, less trust assurance
spot_check_probability = 0.1

# Minimum trust score before warnings appear
min_trust_score = 0.8

# HTTP timeout for indexer queries (seconds)
indexer_timeout_secs = 30

# HTTP timeout for alternate-source (indexer/local-store) reads during spot-checks (seconds)
alt_source_timeout_secs = 60
```

### Config Loading Precedence

Values are resolved in this order (later overrides earlier):

1. Compiled defaults
2. Config file (`~/.dsn/config.toml`)
3. Environment variables (`DSN_INDEXER_URL`, `DSN_KEYFILE`, etc.)
4. CLI flags (`--indexer`, `--keyfile`, etc.)

```rust
pub struct Config {
    pub indexer_url: String,
    pub keyfile: PathBuf,
    pub default_format: OutputFormat,
    pub spot_check_probability: f64,
    pub min_trust_score: f64,
    pub indexer_timeout: Duration,
    pub alt_source_timeout: Duration,
}

#[derive(Clone, clap::ValueEnum)]
pub enum OutputFormat {
    Human,
    Json,
    Table,
}

impl Config {
    /// Load config with full precedence chain:
    /// defaults -> config file -> env vars -> CLI overrides.
    pub fn load(cli: &Cli) -> Result<Self, ConfigError>;
}
```

### Environment Variables

| Variable | Maps To | Example |
|---|---|---|
| `DSN_INDEXER_URL` | `indexer_url` | `http://indexer.example.com:3000` |
| `DSN_KEYFILE` | `keyfile` | `/home/user/.dsn/key.enc` |
| `DSN_FORMAT` | `default_format` | `json` |
| `DSN_PASSPHRASE` | passphrase (non-interactive) | `my-secret-passphrase` |
| `DSN_SPOT_CHECK_PROB` | `spot_check_probability` | `0.2` |

## Output Formatting (`output.rs`)

### Formats

The CLI supports three output modes selectable via `--format`:

**Human** (default): Readable, colorized output for terminal use.

```
Post by alice (a1b2c3d4...)
  2026-01-15 10:32:00 UTC

  This is my first post on the decentralized social network!

  Replies: 3 | Reposts: 2 | Donations: 450 Y
  Address: 0xabcd1234...
```

**JSON**: Machine-readable, piped to `jq` or consumed by scripts.

```json
{
  "address": "abcd1234...",
  "author": "a1b2c3d4...",
  "content": "This is my first post on the decentralized social network!",
  "reply_count": 3,
  "repost_of": null,
  "repost_count": 2,
  "donation_total": 450,
  "created_at": "2026-01-15T10:32:00Z"
}
```

**Table**: Compact tabular format for listing commands.

```
ADDRESS      AUTHOR       CONTENT (preview)                      REPLIES  REPOSTS  DONATED
abcd1234..   alice (a1b2) This is my first post on the decent..  3        2        450 Y
ef567890..   bob (e5f6)   Replying to the above — great to se..  1        0        120 Y
```

### Implementation

```rust
pub trait Renderable {
    fn render_human(&self, writer: &mut dyn Write) -> io::Result<()>;
    fn render_json(&self, writer: &mut dyn Write) -> io::Result<()>;
    fn render_table(&self, writer: &mut dyn Write) -> io::Result<()>;
}

/// Top-level render dispatch.
pub fn render<T: Renderable>(item: &T, format: OutputFormat) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    match format {
        OutputFormat::Human => item.render_human(&mut stdout),
        OutputFormat::Json => item.render_json(&mut stdout),
        OutputFormat::Table => item.render_table(&mut stdout),
    }
}
```

## Example Command Usage

### First-time Setup

```bash
# Generate a new identity
$ dsn key generate
Enter passphrase: ********
Confirm passphrase: ********
Key generated successfully.
Public key: a1b2c3d4e5f6a7b8...
Keyfile written to: ~/.dsn/key.enc

# Create your profile
$ dsn profile create --name "Alice" --bio "Decentralization enthusiast"
Enter passphrase: ********
Profile created successfully.
Profile record address: 7f8e9d0c...
```

### Posting and Reading

```bash
# Create a post
$ dsn post create "Hello, decentralized world!"
Enter passphrase: ********
Post published.
Content address: abcd1234efgh5678...

# Create a post mentioning users by @handle (repeatable).
# The client resolves each handle to a public key at write time and stores the
# keys in Post.mentions — mentions travel as public keys, so they keep pointing
# at the same account even if a handle is later reassigned.
$ dsn post create "Welcome @alice and @bob!" --mention alice --mention bob
Enter passphrase: ********
Post published.
Content address: abcd1234efgh5678...
Mentions resolved: @alice -> a1b2c3d4..., @bob -> e5f6a7b8...

# Attach media by file (hashed locally into a MediaRef) or existing content hash
$ dsn post create "Ship day!" --media ./demo.png --media 5c6d7e8f...
Enter passphrase: ********
Post published.
Content address: bcde2345fghi6789...
Media attached: demo.png -> 4a5b6c7d... , 5c6d7e8f...

# View a post
$ dsn post view abcd1234efgh5678
Post by Alice (a1b2c3d4...)
  2026-01-15 10:32:00 UTC

  Hello, decentralized world!

  Replies: 0 | Reposts: 0 | Donations: 0 Y

# Reply to a post
$ dsn post reply --to abcd1234efgh5678 "Welcome, Alice!"
Enter passphrase: ********
Reply published.
Content address: 9876fedc...

# Repost a post (pure repost, no added commentary)
$ dsn post repost abcd1234efgh5678
Enter passphrase: ********
Repost published.
Content address: fedc9876...

# Quote a post (repost with commentary)
$ dsn post repost abcd1234efgh5678 --quote "This is worth reading."
Enter passphrase: ********
Repost published.
Content address: 1357bdf2...

# View thread
$ dsn post thread abcd1234efgh5678
Post by Alice (a1b2c3d4...) — abcd1234efgh5678
  Hello, decentralized world!
  └── Reply by Bob (e5f6a7b8...) — 9876fedc...
       Welcome, Alice!
```

### Social

```bash
# Follow a user
$ dsn social follow e5f6a7b8...
Enter passphrase: ********
Now following e5f6a7b8... (Bob)

# View your feed
$ dsn social feed --limit 10
[1] Bob (e5f6a7b8...) — 5 min ago
    Just deployed v0.2 of the indexer. Performance is 3x better!
    Replies: 2 | Reposts: 4 | Donations: 320 Y

[2] Charlie (c9d0e1f2...) — 20 min ago
    Interesting paper on sybil resistance: https://...
    Replies: 7 | Reposts: 9 | Donations: 1,050 Y
```

### Token Operations

```bash
# View Y balance
$ dsn y balance
Y Balance: 1,250.000000
Nonce: 14

# Donate Y to a post's creator
$ dsn y donate --post abcd1234efgh5678 --amount 25000000
Enter passphrase: ********
Donated 25.000000 Y to post abcd1234efgh5678 (creator: e5f6a7b8..., Bob)
  (5% fee to Reward Pool; the remainder weights the creator's next-epoch emission share)

# Donate privately (fresh standalone keypair; zero emission weight, anonymous)
$ dsn y donate --post abcd1234efgh5678 --amount 25000000 --private
Enter passphrase: ********
Generated a fresh standalone keypair and funded it.
Donated 25.000000 Y to post abcd1234efgh5678 (creator: e5f6a7b8..., Bob)
  (5% fee to Reward Pool; creator share unchanged)
  Weight: 0.0 — the fresh key is outside your invitation tree, so this donation
  carries no emission weight and appears anonymous in supporter features.
  WARNING: privacy is unlinkability at the donation layer only, NOT
  chain-analysis resistance — the funding transfer is public and its gas is
  paid by you (the sponsored-gas paymaster covers only invited accounts).

# Tip a user
$ dsn y tip --to e5f6a7b8... --amount 25000000
Enter passphrase: ********
Tip sent: 25.000000 Y to e5f6a7b8... (Bob)

# View Y transaction history
$ dsn y history --limit 5
TYPE      AMOUNT       TO/POST                  EPOCH
donate    25.000000    abcd1234efgh5678         43
tip       25.000000    e5f6a7b8... (Bob)        43
emission  87.500000    (auto)                   42
tip       10.000000    c9d0e1f2... (Charlie)    41

# View emission info (reads GET /api/v1/epoch via IndexerClient::epoch_info)
$ dsn y emission
Current epoch: 43
Scheduled emission: 1,400,000,000 Y      (epochs 0-49, before the first halving)
Reward Pool drip (2%): 250,000 Y         (pool balance: 12,500,000 Y)
Total epoch emission: 1,400,250,000 Y    (scheduled + drip)
Your share (last epoch): 87.500000 Y
Distribution: automatic per epoch, directed by donation weighting
```

### Handles (Harberger @handles)

Amounts are entered in atomic units (6 decimals) and echoed in human-readable Y.
Short handles (len 1-6) are Harberger-taxed; long handles (len >= 7) rent flat.

```bash
# Claim a short @handle (Harberger tier). Set the self-assessed value V and pay
# the first epoch's rent to the Reward Pool. V itself is NOT spent — it is the
# price at which you agree to be force-bought.
$ dsn name claim alice --value 10000000000
Enter passphrase: ********
Handle claimed: @alice
  Tier: Harberger (len 5, assessment floor 10,000 Y)
  Self-assessed value (V): 10,000.000000 Y
  First-epoch rent paid: 10.000000 Y   (0.1% of max(V, floor)) -> Reward Pool
  Rent paid through: epoch 43
  Your Y after: 1,240.000000 Y

# Raise the assessed value (increases take effect immediately).
$ dsn name assess alice --value 50000000000
Enter passphrase: ********
Assessment updated: @alice
  Self-assessed value (V): 50,000.000000 Y
  New rent: 50.000000 Y/epoch   (0.1% of 50,000 Y)
  Note: a decrease would take effect only after the 26-epoch lookback window.

# Check rent status.
$ dsn name rent-status alice
Handle: @alice
  Owner: a1b2c3d4e5f6a7b8... (you)
  Tier: Harberger (len 5)
  Self-assessed value (V): 50,000.000000 Y
  Rent: 50.000000 Y/epoch
  Rent paid through: epoch 43   (current epoch: 43)
  Status: Paid

# Prepay several epochs of rent.
$ dsn name pay-rent alice --epochs 3
Enter passphrase: ********
Rent paid: @alice
  3 epochs x 50.000000 Y = 150.000000 Y -> Reward Pool
  Rent paid through: epoch 46
  Your Y after: 1,090.000000 Y

# Force-buy someone else's short handle at its deterministic price = max(V, floor).
# The bid is escrowed for the 1-epoch notice window; the 1% fee is non-refundable.
$ dsn name force-buy chris
Enter passphrase: ********
Force-buy initiated on @chris
  Deterministic price (bid): 20,000.000000 Y   (max(V = 20,000, floor = 10,000))
  Escrowed until epoch 47 (1-epoch notice window): 20,000.000000 Y
  Non-refundable fee (1%): 200.000000 Y -> Reward Pool
  Total charged now: 20,200.000000 Y
  The owner may cancel by raising V to >= 22,000.000000 Y (110% of the bid).
  If uncontested, @chris transfers to you at epoch 47.

# (run by the current owner, @chris, to defend the handle)
# Cancel a force-buy by raising V to >= 110% of the bid and paying the
# retroactive rent on the increase over the 26-epoch lookback window.
$ dsn name assess chris --value 22000000000
Enter passphrase: ********
Assessment updated: @chris
  Self-assessed value (V): 22,000.000000 Y   (>= 110% of the 20,000 Y bid)
  Force-buy cancelled; the challenger's 20,000 Y bid is refunded (the 1% fee is not).
  New rent: 22.000000 Y/epoch
  Retroactive rent on the +2,000 Y increase over 26 epochs: 52.000000 Y -> Reward Pool

# If the owner does NOT cancel, the transfer executes at the deadline with a
# waterfall over the escrowed 20,000 Y bid (it can never exceed the bid or underflow).
# Example with 40 Y of rent arrears owed by the previous owner:
#   1. arrears -> Reward Pool:                   40.000000 Y
#   2. owner_share = min(V, bid - arrears):  19,960.000000 Y -> previous owner
#   3. remainder -> Reward Pool:                  0.000000 Y
# Under-assessing does not help a squatter: the owner payout is capped at
# min(V, ...), and any excess up to the floor-based bid goes to the Reward Pool.

# Look up a handle: owner, live rent status, and ownership history.
$ dsn name lookup nadia
Handle: @nadia
  ! Owner changed 2 epochs ago (within the 26-epoch lookback) — verify identity before trusting.
  Owner: 4d5e6f70a1b2c3d4...   (this account formerly went by @nad)
  Tier: Harberger (len 5) | V: 15,000.000000 Y | Rent: 15.000000 Y/epoch
  Status: Paid through epoch 48
  Ownership history:
    4d5e6f70... epoch 46 -> present   (acquired via force-buy)
    8899aabb... epoch 22 -> 46
```

Flat tier (len >= 7) — no assessed value, flat rent, and a permanent safe harbor:

```bash
# Claim a long @handle: omit --value; rent is a flat 1 Y/epoch for every length >= 7.
$ dsn name claim decentralist
Enter passphrase: ********
Handle claimed: @decentralist
  Tier: Flat (len 12)
  Rent: 1.000000 Y/epoch   (identical for every handle of length >= 7)
  First-epoch rent paid: 1.000000 Y -> Reward Pool
  Rent paid through: epoch 43
  Note: no self-assessed value and no force-buy — long handles cannot be taken.

# Force-buy is rejected for flat-tier handles.
$ dsn name force-buy decentralist
Error: force-buy not available for @decentralist (flat tier, len 12 — safe harbor)
```

### Invitations

```bash
# Invite a new user (costs Y; a 5 Y starter grant is sent alongside by default
# so the invitee can immediately donate and rent a handle)
$ dsn invite send --to f3a4b5c6...
Enter passphrase: ********
Invitation sent.
  Invitee: f3a4b5c6...
  Y cost deducted from balance.
  Starter grant: 5.000000 Y -> f3a4b5c6...   (plain transfer, not a protocol rule)

# Send a larger starter grant
$ dsn invite send --to f3a4b5c6... --grant 20000000
Enter passphrase: ********
Invitation sent.
  Invitee: f3a4b5c6...
  Y cost deducted from balance.
  Starter grant: 20.000000 Y -> f3a4b5c6...

# View your invitation chain
$ dsn invite chain
You (a1b2c3d4...) — invited by d7e8f9a0... (epoch 12)
├── e5f6a7b8... (Bob) — invited epoch 20
├── c9d0e1f2... (Charlie) — invited epoch 25
│   └── f3a4b5c6... (Dave) — invited epoch 38
└── [2 more invitees]
```

### Labels

```bash
# Attach a label to a post
$ dsn label add abcd1234efgh5678 spam
Enter passphrase: ********
Label published.
  Post: abcd1234efgh5678
  Label: spam

# View labels on a post
$ dsn label list abcd1234efgh5678
Post: abcd1234efgh5678
Labels: 3
  spam         by a1b2c3d4... — epoch 43
  spam         by e5f6a7b8... — epoch 43
  harassment   by c9d0e1f2... — epoch 44
```

### Supporters (Donor Recognition)

```bash
# View a creator's supporter leaderboard (derived from public donations;
# a client/indexer convenience, NOT a protocol privilege).
$ dsn supporters e5f6a7b8...
Supporters of Bob (e5f6a7b8...):
  RANK  SUPPORTER              LIFETIME DONATED
  1     a1b2c3d4... (Alice)    1,250.000000 Y
  2     c9d0e1f2... (Charlie)    640.000000 Y
  3     f3a4b5c6... (Dave)       180.000000 Y
  [12 more]
Note: badges and thread prominence are computed off-chain and verifiable, but
carry no economic-accuracy guarantee — a donation buys no on-chain privilege.
```

## Error Handling Strategy

### Error Type Hierarchy

```rust
#[derive(Debug, thiserror::Error)]
pub enum CliError {
    // --- User input errors ---
    #[error("no keyfile found at {path}; run `dsn key generate` first")]
    NoKeyfile { path: PathBuf },

    #[error("invalid public key format: {input}")]
    InvalidPublicKey { input: String },

    #[error("invalid content address format: {input}")]
    InvalidAddress { input: String },

    #[error("passphrase required but not provided")]
    PassphraseRequired,

    #[error("incorrect passphrase")]
    IncorrectPassphrase,

    // --- Config errors ---
    #[error("config error: {0}")]
    Config(#[from] ConfigError),

    // --- Indexer errors ---
    #[error("indexer unreachable at {url}: {reason}")]
    IndexerUnreachable { url: String, reason: String },

    #[error("indexer returned error {status}: {body}")]
    IndexerError { status: u16, body: String },

    #[error("indexer response failed spot-check verification")]
    SpotCheckFailed { details: String },

    // --- Storage / network errors ---
    #[error("network storage error: {0}")]
    Storage(#[from] DataError),

    // --- Chain errors ---
    #[error("chain error: {0}")]
    ChainError(String),

    // --- Protocol errors ---
    #[error("token Y error: {0}")]
    TokenY(#[from] TokenYError),

    #[error("label error: {0}")]
    Label(String),

    // --- Crypto errors ---
    #[error("crypto error: {0}")]
    Crypto(#[from] CoreError),

    // --- System errors ---
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serialization(String),
}
```

### Error Presentation

All errors are presented to the user with actionable context. The `main()` function catches `CliError` and formats it:

```rust
#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    if let Err(e) = run(cli).await {
        // Human-readable error with suggestion
        eprintln!("Error: {e}");

        // If there's a chain of causes, print them indented
        let mut source = e.source();
        while let Some(cause) = source {
            eprintln!("  Caused by: {cause}");
            source = cause.source();
        }

        // Exit with non-zero status for scripts
        std::process::exit(1);
    }
}
```

### Error Recovery Guidelines

| Error Category | CLI Behavior |
|---|---|
| Missing keyfile | Print setup instructions: `run dsn key generate` |
| Wrong passphrase | Allow up to 3 retries, then exit |
| Indexer unreachable | Warn and fall back to an alternate indexer or the local store, verifying signatures locally |
| Indexer data fails spot-check | Warn user, show both indexer and on-chain values |
| Insufficient Y balance | Show current balance and required amount |
| Post content too long | Show character count and maximum |
| Network timeout | Retry once with doubled timeout, then fail with suggestion |
| Conflicting nonce (concurrent update) | Re-read current state, reapply, retry up to 3 times |

## Data Flow Diagram

```
┌─────────┐     commands      ┌──────────────┐
│  User    │ ────────────────► │   dsn-cli    │
│ (shell)  │ ◄──────────────── │   (clap)     │
└─────────┘     output        └──────┬───────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
              ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
              │ keystore  │   │ indexer_   │   │ spot_     │
              │ (local    │   │ client    │   │ check     │
              │  keyfile) │   │ (reqwest) │   │ (verify)  │
              └───────────┘   └─────┬─────┘   └─────┬─────┘
                                    │           ┌───┴───┐
                              ┌─────┴─────┐  ┌──┴──┐ ┌──┴──┐
                              │  Indexer   │  │dsn- │ │dsn- │
                              │  REST API  │  │data │ │chain│
                              │  (remote)  │  └──┬──┘ └──┬──┘
                              └───────────┘     │       │
                                              ┌─┴───────┴──────┐
                                              │ Indexers        │
                                              │ (+ local store) │
                                              └────────────────┘
```

### Write Path (e.g., creating a post)

1. User runs `dsn post create "Hello world"`
2. CLI loads config, unlocks keyfile (passphrase prompt)
3. For each `--mention @handle`, the CLI resolves the handle to its current
   public key via `IndexerClient::name_lookup` (spot-checked) and collects the
   keys into `Post.mentions`. Mentions store public keys, never handles, so they
   keep pointing at the same account after a handle change; handles re-resolve to
   display text only at render time.
4. `commands/post.rs` constructs a `Post`, signs it with the current signing key
5. CLI publishes the signed post object to K configured indexers (`POST /api/v1/publish`, signature-verified at ingest) and keeps a copy in the local store — a dead indexer is a re-publish event, not data loss
6. CLI updates the user's FeedIndex mutable record via `dsn-data::MutableStore::update()`
7. CLI prints the content address to stdout

### Read Path (e.g., viewing feed)

1. User runs `dsn social feed`
2. CLI loads config, reads public key from keyfile (no passphrase needed)
3. `commands/social.rs` calls `IndexerClient::feed()` with the public key
4. Indexer returns a list of `FeedItem` objects
5. `spot_check.rs` probabilistically re-fetches a subset from an alternate indexer, verifies signatures locally, and cross-checks against on-chain and anchor data (`GET /api/v1/spotcheck/anchor/:address`)
6. CLI renders the feed via `output.rs` in the selected format

## Workspace Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| `clap` (derive) | latest | CLI argument parsing with derive macros |
| `reqwest` | latest | HTTP client for indexer API |
| `tokio` (full) | latest | Async runtime |
| `serde` + `serde_json` | latest | Serialization for indexer responses |
| `rpassword` | latest | Passphrase input without echo |
| `argon2` | latest | Passphrase-based key derivation (Argon2id) |
| `chacha20poly1305` | latest | Keyfile encryption (XChaCha20-Poly1305) |
| `zeroize` | latest | Secure memory wiping for secrets |
| `tracing` + `tracing-subscriber` | latest | Structured logging |
| `comfy-table` | latest | Table output formatting |
| `colored` | latest | Terminal colorization for human output |
| `toml` | latest | Config file parsing |
| `rand` | latest | Spot-check probability, nonce generation |
| `dsn-core` | workspace | Core types, crypto primitives |
| `dsn-data` | workspace | Storage trait abstractions |
| `dsn-chain` | workspace | On-chain data reading (donations, names) |
| `dsn-token-y` | workspace | Y balance validation, transfer verification |
| `dsn-invitation` | workspace | Invitation chain operations |
