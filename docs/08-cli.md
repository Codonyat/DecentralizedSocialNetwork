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
│   ├── token_y.rs      # Donate, tip, view balance, emission info
│   ├── bond.rs         # Place bonds, view bonds, check prices
│   ├── name.rs         # Register names, lookup, cost check
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
    /// Token Y operations
    #[command(name = "y")]
    TokenY(TokenYCommand),
    /// Bonding on posts
    Bond(BondCommand),
    /// Name registration
    Name(NameCommand),
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

### Bond Subcommands (`bond.rs`)

```rust
#[derive(Subcommand)]
pub enum BondAction {
    /// Place a bond on a post
    Place {
        /// Content address of the post to bond on
        #[arg(long)]
        post: String,
        /// Amount of Y to bond
        #[arg(long)]
        amount: u64,
    },
    /// View bonds on a post
    View {
        /// Content address of the post
        post: String,
    },
    /// View your active bond positions
    Mine,
    /// Check the current bond price for a post
    Price {
        /// Content address of the post
        post: String,
    },
}
```

### Name Subcommands (`name.rs`)

```rust
#[derive(Subcommand)]
pub enum NameAction {
    /// Burn Y to claim a name
    Register {
        /// The name to register
        name: String,
    },
    /// Resolve a name to a public key
    Lookup {
        /// The name to look up
        name: String,
    },
    /// Check pricing for a name
    Cost {
        /// The name to check pricing for
        name: String,
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
    },
    /// View your invitation chain (who invited you, who you invited)
    Chain,
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

    /// Fetch epoch info (current epoch, emission schedule).
    pub async fn epoch_info(&self) -> Result<EpochInfo, IndexerError>;

    // --- Bond queries ---

    /// Fetch bonds placed on a post.
    pub async fn get_bonds(
        &self,
        post: &ContentAddress,
    ) -> Result<BondInfo, IndexerError>;

    /// Fetch the current bond price for a post.
    pub async fn bond_price(
        &self,
        post: &ContentAddress,
    ) -> Result<BondPrice, IndexerError>;

    /// Fetch a user's active bond positions.
    pub async fn my_bonds(
        &self,
        user: &PublicKey,
    ) -> Result<Vec<BondPosition>, IndexerError>;

    // --- Name queries ---

    /// Resolve a name to a public key.
    pub async fn name_lookup(
        &self,
        name: &str,
    ) -> Result<Option<PublicKey>, IndexerError>;

    /// Fetch the cost to register a name.
    pub async fn name_cost(
        &self,
        name: &str,
    ) -> Result<NameCost, IndexerError>;

    // --- Donation queries ---

    /// Fetch donation totals for a post.
    pub async fn post_donations(
        &self,
        post: &ContentAddress,
    ) -> Result<DonationInfo, IndexerError>;

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
    pub bond_count: u64,
    pub total_bonded: u64,
    pub donation_total: u64,
}

/// Detailed post view.
pub struct PostDetail {
    pub post: Post,
    pub address: ContentAddress,
    pub author_profile: Option<UserProfile>,
    pub reply_count: u64,
    pub bonds: Vec<BondSummary>,
    pub total_bonded: u64,
    pub donation_total: u64,
    pub flags: Vec<FlagInfo>,
}

/// Thread view: root post plus nested replies.
pub struct ThreadView {
    pub root: PostDetail,
    pub replies: Vec<ThreadView>,  // Recursive nesting
}
```

## Spot-Check Verification Flow (`spot_check.rs`)

The CLI does not blindly trust indexer results. It performs probabilistic spot-checks by reading raw data from Autonomi (via dsn-data) and on-chain data (via dsn-chain) and verifying the indexer's claims.

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

    /// Verify a post exists on Autonomi and matches the indexer's version.
    pub async fn verify_post(
        &self,
        indexer_post: &PostDetail,
    ) -> Result<SpotCheckResult, SpotCheckError>;

    /// Verify bond data reported by the indexer against on-chain records.
    pub async fn verify_bonds(
        &self,
        post: &ContentAddress,
        indexer_bonds: &BondInfo,
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

1. Read the Chunk at the content address from Autonomi via `ChunkStore::get()`
2. Deserialize the Chunk into a `Post`
3. Verify the signature (`Post::verify()`)
4. Compare author, content, and timestamp against the indexer's response
5. If any field mismatches, flag the indexer result as untrustworthy

**Bond verification:**

1. Read bond records for the post from on-chain data via `dsn-chain`
2. Compare the total bonded amount and individual bond positions against the indexer's report
3. If any values mismatch, flag the indexer result as untrustworthy

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
    BondData,
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

  Replies: 3 | Bonds: 7 (1,250 Y) | Donations: 450 Y
  Address: 0xabcd1234...
```

**JSON**: Machine-readable, piped to `jq` or consumed by scripts.

```json
{
  "address": "abcd1234...",
  "author": "a1b2c3d4...",
  "content": "This is my first post on the decentralized social network!",
  "reply_count": 3,
  "bond_count": 7,
  "total_bonded": 1250,
  "donation_total": 450,
  "created_at": "2026-01-15T10:32:00Z"
}
```

**Table**: Compact tabular format for listing commands.

```
ADDRESS      AUTHOR       CONTENT (preview)                      REPLIES  BONDS   DONATED
abcd1234..   alice (a1b2) This is my first post on the decent..  3        7       450 Y
ef567890..   bob (e5f6)   Replying to the above — great to se..  1        2       120 Y
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

  Replies: 0 | Bonds: 0 | Donations: 0 Y

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
    Replies: 2 | Bonds: 5 (800 Y) | Donations: 320 Y

[2] Charlie (c9d0e1f2...) — 20 min ago
    Interesting paper on sybil resistance: https://...
    Replies: 7 | Bonds: 12 (3,400 Y) | Donations: 1,050 Y
```

### Bonding

```bash
# Check the current bond price for a post
$ dsn bond price abcd1234efgh5678
Post: abcd1234efgh5678
Current bond price: 15 Y
Total bonded: 800 Y
Bond count: 5

# Place a bond on a post
$ dsn bond place --post abcd1234efgh5678 --amount 100
Enter passphrase: ********
Bond placed.
  Post: abcd1234efgh5678
  Amount: 100 Y
  Your Y after bond: 1,150 Y

# View bonds on a post
$ dsn bond view abcd1234efgh5678
Post: abcd1234efgh5678
Total bonded: 900 Y
Bonders: 6
  a1b2c3d4... (Alice) — 100 Y
  e5f6a7b8... (Bob)   — 200 Y
  c9d0e1f2... (Charlie) — 350 Y
  [3 more]

# View your active bond positions
$ dsn bond mine
Your bond positions:
  abcd1234efgh5678 — 100 Y (placed epoch 43)
  5678dcba4321...   — 50 Y  (placed epoch 41)
Total bonded: 150 Y
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

# Tip a user
$ dsn y tip --to e5f6a7b8... --amount 25000000
Enter passphrase: ********
Tip sent: 25.000000 Y to e5f6a7b8... (Bob)

# View Y transaction history
$ dsn y history --limit 5
TYPE      AMOUNT       TO/POST                  EPOCH
donate    25.000000    abcd1234efgh5678         43
tip       25.000000    e5f6a7b8... (Bob)        43
bond      100.000000   abcd1234efgh5678         43
emission  87.500000    (auto)                   42
tip       10.000000    c9d0e1f2... (Charlie)    41

# View emission info
$ dsn y emission
Current epoch: 43
Epoch emission rate: 1,000 Y
Your share (last epoch): 87.500000 Y
Distribution: automatic per epoch
```

### Name Registration

```bash
# Check cost to register a name
$ dsn name cost alice
Name: alice
Cost: 500 Y (short name premium)

# Register a name (burns Y)
$ dsn name register alice
Enter passphrase: ********
Name registered.
  Name: alice
  Burned: 500 Y
  Your Y after: 750 Y

# Look up a name
$ dsn name lookup alice
Name: alice
Owner: a1b2c3d4e5f6a7b8...
```

### Invitations

```bash
# Invite a new user (costs Y)
$ dsn invite send --to f3a4b5c6...
Enter passphrase: ********
Invitation sent.
  Invitee: f3a4b5c6...
  Y cost deducted from balance.

# View your invitation chain
$ dsn invite chain
You (a1b2c3d4...) — invited by d7e8f9a0... (epoch 12)
├── e5f6a7b8... (Bob) — invited epoch 20
├── c9d0e1f2... (Charlie) — invited epoch 25
│   └── f3a4b5c6... (Dave) — invited epoch 38
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

# View flags on a post
$ dsn mod flags abcd1234efgh5678
Post: abcd1234efgh5678
Flags: 3
  [spam]   by a1b2c3d4... — epoch 43
  [spam]   by e5f6a7b8... — epoch 43
  [abuse]  by c9d0e1f2... — epoch 44

Counter-flags: 1
  by g1h2i3j4... — epoch 44
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
                                              ┌─┴───────┴─┐
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
5. `spot_check.rs` probabilistically verifies a subset of results against Autonomi and on-chain data
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
| `dsn-chain` | workspace | On-chain data reading (bonds, donations, names) |
| `dsn-token-y` | workspace | Y balance validation, transfer verification |
| `dsn-invitation` | workspace | Invitation chain operations |
| `dsn-moderation` | workspace | Content flagging operations |
