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
│   ├── post.rs         # Post create, read, reply, thread view
│   ├── social.rs       # Follow, unfollow, feed view
│   ├── curation.rs     # Stake R on posts, view curation results
│   ├── token_y.rs      # Claim emissions, tip, boost, view balance
│   ├── token_r.rs      # View R balance, view R history
│   ├── invitation.rs   # Invite users, view invitation chain
│   └── moderation.rs   # Flag content, counter-flag, view flags
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
    /// Curation staking
    Curation(CurationCommand),
    /// Token Y operations
    #[command(name = "y")]
    TokenY(TokenYCommand),
    /// Token R operations
    #[command(name = "r")]
    TokenR(TokenRCommand),
    /// Invitation management
    Invite(InviteCommand),
    /// Content moderation
    Mod(ModCommand),
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
    /// Generate a new BLS keypair and store in local keyfile
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
    /// Show key info (public key, short ID, derived addresses)
    Info,
}
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
    },
    /// Reply to an existing post
    Reply {
        /// Content address of the parent post
        #[arg(long)]
        to: String,
        /// Reply content
        content: String,
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
    },
    /// View followers (users who follow you) — requires indexer
    Followers,
}
```

### Curation Subcommands (`curation.rs`)

```rust
#[derive(Subcommand)]
pub enum CurationAction {
    /// Stake R on a post (curate it)
    Stake {
        /// Content address of the post to curate
        #[arg(long)]
        post: String,
        /// Amount of R to stake
        #[arg(long)]
        r_amount: u64,
        /// Amount of Y to stake alongside R (optional amplifier)
        #[arg(long, default_value = "0")]
        y_amount: u64,
    },
    /// View your active curation stakes
    Active,
    /// View resolved curation results for a post
    Results {
        /// Content address of the post
        post: String,
    },
    /// View DiversityScore for a post
    Score {
        /// Content address of the post
        post: String,
    },
}
```

### Token Y Subcommands (`token_y.rs`)

```rust
#[derive(Subcommand)]
pub enum TokenYAction {
    /// View your Y balance
    Balance,
    /// Claim Y from epoch emissions
    Claim {
        /// Epoch number to claim from
        #[arg(long)]
        epoch: u64,
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
    /// Boost a post by burning Y
    Boost {
        /// Content address of the post to boost
        #[arg(long)]
        post: String,
        /// Amount of Y to burn
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

### Token R Subcommands (`token_r.rs`)

```rust
#[derive(Subcommand)]
pub enum TokenRAction {
    /// View your R balance (self-claimed + verified)
    Balance,
    /// View R balance for another user
    BalanceOf {
        /// Public key of the user
        user: String,
    },
    /// View R earning history per epoch
    History {
        /// Number of epochs to show
        #[arg(long, default_value = "10")]
        limit: usize,
    },
    /// Recompute and update your R balance
    Recompute,
}
```

### Invitation Subcommands (`invitation.rs`)

```rust
#[derive(Subcommand)]
pub enum InviteAction {
    /// Send an invitation to a new user (stakes your R)
    Send {
        /// Public key of the invitee
        #[arg(long)]
        to: String,
        /// Amount of R to stake on this invitation
        #[arg(long)]
        r_stake: u64,
    },
    /// View your invitation chain (who invited you, who you invited)
    Chain,
    /// View your remaining invitation capacity
    Capacity,
}
```

### Moderation Subcommands (`moderation.rs`)

```rust
#[derive(Subcommand)]
pub enum ModAction {
    /// Flag a post for rule violation
    Flag {
        /// Content address of the post to flag
        #[arg(long)]
        post: String,
        /// Reason category
        #[arg(long)]
        reason: FlagReason,
    },
    /// Counter-flag (dispute a flag)
    CounterFlag {
        /// Content address of the flag to dispute
        #[arg(long)]
        flag: String,
    },
    /// View flags on a post
    Flags {
        /// Content address of the post
        post: String,
    },
    /// View your flagging history
    History,
}

#[derive(Clone, clap::ValueEnum)]
pub enum FlagReason {
    Spam,
    Abuse,
    Illegal,
    Impersonation,
}
```

## Key Storage Design (`keystore.rs`)

### Keyfile Format

The local keyfile stores the user's BLS secret key encrypted with a passphrase. The file lives at `~/.dsn/key.enc` by default.

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
3. Encrypt the 32-byte BLS secret key with XChaCha20-Poly1305
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

### Key Derivation for Scratchpads

When the CLI needs to write to a specific Scratchpad (profile, balance, etc.), it derives the purpose-specific child key from the root secret key using `dsn-data::derive_scratchpad_key()`. This is transparent to the user.

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

    /// Fetch R balance for a user (as reported by indexer).
    pub async fn r_balance(
        &self,
        user: &PublicKey,
    ) -> Result<RBalanceSummary, IndexerError>;

    /// Fetch epoch info (current epoch, emission schedule).
    pub async fn epoch_info(&self) -> Result<EpochInfo, IndexerError>;

    // --- Curation queries ---

    /// Fetch DiversityScore and curation list for a post.
    pub async fn curation_info(
        &self,
        post: &ContentAddress,
    ) -> Result<CurationInfo, IndexerError>;

    // --- Moderation queries ---

    /// Fetch flags for a post.
    pub async fn get_flags(
        &self,
        post: &ContentAddress,
    ) -> Result<Vec<FlagInfo>, IndexerError>;

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
    pub curation_count: u64,
    pub diversity_score: Option<f64>,
    pub y_boosted: u64,
}

/// Detailed post view.
pub struct PostDetail {
    pub post: Post,
    pub address: ContentAddress,
    pub author_profile: Option<UserProfile>,
    pub reply_count: u64,
    pub curations: Vec<CurationSummary>,
    pub diversity_score: Option<f64>,
    pub flags: Vec<FlagInfo>,
}

/// Thread view: root post plus nested replies.
pub struct ThreadView {
    pub root: PostDetail,
    pub replies: Vec<ThreadView>,  // Recursive nesting
}
```

## Spot-Check Verification Flow (`spot_check.rs`)

The CLI does not blindly trust indexer results. It performs probabilistic spot-checks by reading raw data from Autonomi (via dsn-data) and verifying the indexer's claims.

### Strategy

```rust
pub struct SpotChecker {
    storage: Arc<dyn Storage>,
    /// Probability of spot-checking any given indexer result (0.0..=1.0).
    check_probability: f64,
    /// Results of recent spot-checks.
    recent_results: Mutex<VecDeque<SpotCheckResult>>,
    /// Maximum stored results.
    max_results: usize,
}

impl SpotChecker {
    pub fn new(storage: Arc<dyn Storage>, check_probability: f64) -> Self;

    /// Decide whether to spot-check a given item (probabilistic).
    fn should_check(&self) -> bool;

    /// Verify a post exists on Autonomi and matches the indexer's version.
    pub async fn verify_post(
        &self,
        indexer_post: &PostDetail,
    ) -> Result<SpotCheckResult, SpotCheckError>;

    /// Verify a Y balance reported by the indexer.
    pub async fn verify_y_balance(
        &self,
        user: &PublicKey,
        indexer_balance: u64,
    ) -> Result<SpotCheckResult, SpotCheckError>;

    /// Verify an R balance reported by the indexer.
    pub async fn verify_r_balance(
        &self,
        user: &PublicKey,
        indexer_balance: u64,
    ) -> Result<SpotCheckResult, SpotCheckError>;

    /// Verify a DiversityScore reported by the indexer.
    pub async fn verify_diversity_score(
        &self,
        post: &ContentAddress,
        indexer_score: f64,
    ) -> Result<SpotCheckResult, SpotCheckError>;

    /// Return a summary of recent spot-check results.
    pub fn summary(&self) -> SpotCheckSummary;
}
```

### Spot-Check Verification Steps

**Post verification:**

1. Read the Chunk at the content address from Autonomi via `ChunkStore::get()`
2. Deserialize the Chunk into a `Post`
3. Verify the signature (`Post::verify()`)
4. Compare author, content, and timestamp against the indexer's response
5. If any field mismatches, flag the indexer result as untrustworthy

**Y balance verification:**

1. Derive the user's Y balance Scratchpad address: `derive_scratchpad_key(root_pk, YBalance)`
2. Read the Scratchpad via `ScratchpadStore::get()`
3. Deserialize into `YBalance`
4. Validate the signature and hash chain via `dsn-token-y::validate_balance()`
5. Compare the balance against the indexer's reported value
6. Optionally check for fraud proofs via `dsn-token-y::check_for_fraud()`

**R balance verification:**

1. Read the user's self-claimed R from their R balance Scratchpad
2. Compare against the indexer's reported value
3. Optionally recompute R from scratch via `dsn-token-r::compute_r_from_scratch()` (expensive, done infrequently)

**DiversityScore verification:**

1. Fetch all curation GraphEntries for the post from Autonomi
2. Fetch each curator's R balance
3. Recompute the DiversityScore via `dsn-token-r::diversity_score()`
4. Compare against the indexer's reported score

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
    /// Could not verify (e.g., Autonomi data not found, network error).
    Inconclusive {
        check_type: CheckType,
        target: String,
        reason: String,
    },
}

pub enum CheckType {
    PostContent,
    PostSignature,
    YBalance,
    RBalance,
    DiversityScore,
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

# HTTP timeout for Autonomi reads during spot-checks (seconds)
autonomi_timeout_secs = 60
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
    pub autonomi_timeout: Duration,
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

  Replies: 3 | Curations: 7 | DiversityScore: 24.5
  Address: 0xabcd1234...
```

**JSON**: Machine-readable, piped to `jq` or consumed by scripts.

```json
{
  "address": "abcd1234...",
  "author": "a1b2c3d4...",
  "content": "This is my first post on the decentralized social network!",
  "reply_count": 3,
  "curation_count": 7,
  "diversity_score": 24.5,
  "created_at": "2026-01-15T10:32:00Z"
}
```

**Table**: Compact tabular format for listing commands.

```
ADDRESS      AUTHOR       CONTENT (preview)                      REPLIES  CURATIONS  SCORE
abcd1234..   alice (a1b2) This is my first post on the decent..  3        7          24.5
ef567890..   bob (e5f6)   Replying to the above — great to se..  1        2          8.1
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
Profile scratchpad address: 7f8e9d0c...
```

### Posting and Reading

```bash
# Create a post
$ dsn post create "Hello, decentralized world!"
Enter passphrase: ********
Post published.
Content address: abcd1234efgh5678...

# View a post
$ dsn post view abcd1234efgh5678
Post by Alice (a1b2c3d4...)
  2026-01-15 10:32:00 UTC

  Hello, decentralized world!

  Replies: 0 | Curations: 0

# Reply to a post
$ dsn post reply --to abcd1234efgh5678 "Welcome, Alice!"
Enter passphrase: ********
Reply published.
Content address: 9876fedc...

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
    Replies: 2 | Curations: 5 | Score: 18.3

[2] Charlie (c9d0e1f2...) — 20 min ago
    Interesting paper on sybil resistance: https://...
    Replies: 7 | Curations: 12 | Score: 41.7
```

### Curation

```bash
# Stake R on a post you think is valuable
$ dsn curation stake --post abcd1234efgh5678 --r-amount 10 --y-amount 50
Enter passphrase: ********
Curation stake placed.
  Post: abcd1234efgh5678
  R staked: 10
  Y staked: 50
  Cooling period ends: epoch 47

# View DiversityScore
$ dsn curation score abcd1234efgh5678
Post: abcd1234efgh5678
DiversityScore: 24.5 (threshold: 10.0) — PASSING
Curators: 7 unique
Top curators:
  a1b2c3d4... (R: 120) — staked 10 R
  e5f6a7b8... (R: 85)  — staked 5 R
  c9d0e1f2... (R: 340) — staked 20 R, 100 Y
```

### Token Operations

```bash
# View Y balance
$ dsn y balance
Y Balance: 1,250.000000
Nonce: 14
Last tx: Claim (epoch 42, amount 87.500000)

# Claim Y from an epoch
$ dsn y claim --epoch 43
Enter passphrase: ********
Claimed 92.300000 Y from epoch 43.
New balance: 1,342.300000

# Tip a user
$ dsn y tip --to e5f6a7b8... --amount 25000000
Enter passphrase: ********
Tip sent: 25.000000 Y to e5f6a7b8... (Bob)
Awaiting confirmation window...
Transfer will be confirmed after ~5,000 Scratchpad writes.

# View R balance
$ dsn r balance
R Balance: 142
Computed at epoch: 43
Rank: top 12% of active users (via indexer)

# View R history
$ dsn r history --limit 5
EPOCH  R START  EARNED  DECAYED  SLASHED  R END
  43      148      12      -15        0    142 (current, recomputed pending)
  42      155       8      -15        0    148
  41      160      10      -16        0    155 (curation success: 2 posts)
  40      140      36      -14        0    160 (discovery bonus: 1 post)
  39      120      34      -12        0    140
```

### Invitations

```bash
# Invite a new user (stakes your R)
$ dsn invite send --to f3a4b5c6... --r-stake 20
Enter passphrase: ********
Invitation sent.
  Invitee: f3a4b5c6...
  R staked: 20
  Your R after stake: 122

# View your invitation chain
$ dsn invite chain
You (a1b2c3d4...) — invited by d7e8f9a0... (epoch 12)
├── e5f6a7b8... (Bob) — invited epoch 20, R staked: 15
├── c9d0e1f2... (Charlie) — invited epoch 25, R staked: 10
│   └── f3a4b5c6... (Dave) — invited epoch 38, R staked: 20
└── [2 more invitees]
```

### Moderation

```bash
# Flag a post
$ dsn mod flag --post abcd1234efgh5678 --reason spam
Enter passphrase: ********
Flag submitted.
  Post: abcd1234efgh5678
  Reason: spam
  Your R weight: 142

# View flags on a post
$ dsn mod flags abcd1234efgh5678
Post: abcd1234efgh5678
Flags: 3 (total R weight: 285)
  [spam]   by a1b2c3d4... (R: 142) — epoch 43
  [spam]   by e5f6a7b8... (R: 85)  — epoch 43
  [abuse]  by c9d0e1f2... (R: 58)  — epoch 44

Counter-flags: 1 (total R weight: 340)
  by g1h2i3j4... (R: 340) — epoch 44
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

    // --- Protocol errors ---
    #[error("token Y error: {0}")]
    TokenY(#[from] TokenYError),

    #[error("token R error: {0}")]
    TokenR(#[from] CurationError),

    #[error("moderation error: {0}")]
    Moderation(String),

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
| Indexer unreachable | Warn and fall back to direct Autonomi reads where possible |
| Indexer data fails spot-check | Warn user, show both indexer and on-chain values |
| Insufficient Y/R balance | Show current balance and required amount |
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
                                    │               │
                              ┌─────┴─────┐   ┌─────┴─────┐
                              │  Indexer   │   │ dsn-data  │
                              │  REST API  │   │ (Storage  │
                              │  (remote)  │   │  traits)  │
                              └───────────┘   └─────┬─────┘
                                                    │
                                              ┌─────┴─────┐
                                              │ Autonomi  │
                                              │ Network   │
                                              └───────────┘
```

### Write Path (e.g., creating a post)

1. User runs `dsn post create "Hello world"`
2. CLI loads config, unlocks keyfile (passphrase prompt)
3. `commands/post.rs` constructs a `Post`, signs it with the secret key
4. CLI writes the post Chunk via `dsn-data::ChunkStore::put()`
5. CLI updates the user's FeedIndex Scratchpad via `dsn-data::ScratchpadStore::update()`
6. CLI prints the content address to stdout

### Read Path (e.g., viewing feed)

1. User runs `dsn social feed`
2. CLI loads config, reads public key from keyfile (no passphrase needed)
3. `commands/social.rs` calls `IndexerClient::feed()` with the public key
4. Indexer returns a list of `FeedItem` objects
5. `spot_check.rs` probabilistically verifies a subset of results against Autonomi
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
| `dsn-token-y` | workspace | Y balance validation, claim verification |
| `dsn-token-r` | workspace | R computation, DiversityScore verification |
| `dsn-invitation` | workspace | Invitation chain operations |
| `dsn-moderation` | workspace | Content flagging operations |
