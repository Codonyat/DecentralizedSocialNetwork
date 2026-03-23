# Token Y Protocol Design (`dsn-token-y`)

## Purpose

Token Y is the native utility token with fixed supply, Bitcoin-style economics, and no governance. It lives entirely on Autonomi Scratchpads with detect-and-punish enforcement.

## Module Structure

```
crates/token-y/src/
├── lib.rs              # Re-exports
├── emission.rs         # Emission schedule, halving, epoch emission calculation
├── balance.rs          # YBalance state management
├── transfer.rs         # Transfer protocol (debit/credit/reclaim)
├── receipt.rs          # Immutable receipt chain (YReceipt storage and verification)
├── claim.rs            # Self-serve Y claiming from epoch emissions
├── fraud.rs            # Double-spend detection, fraud proof generation
├── watcher.rs          # Watcher logic: verify balances, detect fraud
├── epoch.rs            # Event-based epoch boundary computation
└── error.rs            # Token Y errors
```

## Emission Schedule (`emission.rs`)

### Fixed Parameters (hardcoded at launch)

```rust
pub const TOTAL_SUPPLY: u64 = 21_000_000_000_000;  // 21M Y with 6 decimal places
pub const INITIAL_EMISSION: u64 = 10_000_000_000;   // 10,000 Y per epoch
pub const HALVING_INTERVAL: u64 = 52;               // Halve every 52 epochs
pub const MAX_HALVINGS: u64 = 20;                    // After 20 halvings, emission = 0
```

### Emission Table (first 5 halvings)

| Epoch Range | Y per Epoch | Cumulative Y |
|---|---|---|
| 0-51 | 10,000 | 520,000 |
| 52-103 | 5,000 | 780,000 |
| 104-155 | 2,500 | 910,000 |
| 156-207 | 1,250 | 975,000 |
| 208-259 | 625 | 1,007,500 |

### Key Functions

```rust
/// Compute Y emission for a specific epoch.
pub fn emission_for_epoch(epoch: u64) -> u64 {
    let halvings = epoch / HALVING_INTERVAL;
    if halvings >= MAX_HALVINGS { return 0; }
    INITIAL_EMISSION >> halvings
}

/// Compute each user's Y claim for a given epoch.
/// Returns a map of (user_pk → claimable_y).
pub fn compute_epoch_claims(
    epoch: u64,
    r_earned: &HashMap<PublicKey, u64>,  // R earned per user this epoch
) -> HashMap<PublicKey, u64> {
    let emission = emission_for_epoch(epoch);
    let total_r: u64 = r_earned.values().sum();
    if total_r == 0 { return HashMap::new(); }

    r_earned.iter().map(|(pk, r)| {
        let claim = (emission as u128 * *r as u128 / total_r as u128) as u64;
        (pk.clone(), claim)
    }).collect()
}

/// Verify that a claimed amount is correct for a given epoch.
/// Used by watchers.
pub fn verify_claim(
    epoch: u64,
    claimer: &PublicKey,
    claimed_amount: u64,
    r_earned: &HashMap<PublicKey, u64>,
) -> Result<(), ClaimError>;
```

## Balance Management (`balance.rs`)

### State Machine

The Y balance Scratchpad follows a strict state machine:

```
┌─────────┐    claim     ┌─────────┐
│ balance  │ ──────────── │ balance  │
│ nonce=N  │              │ nonce=N+1│
│ prev=H   │              │ prev=H'  │
└─────────┘              └─────────┘
     │                        │
     │ debit                  │ credit
     ▼                        ▼
┌─────────┐              ┌─────────┐
│ balance  │              │ balance  │
│ nonce=N+1│              │ nonce=N+1│
│ prev=H'  │              │ prev=H'  │
└─────────┘              └─────────┘
```

Every state transition:
1. Increments `nonce` by 1
2. Sets `prev_hash` to hash of the previous state
3. Records the transaction type
4. Is signed by the owner

### Hash Chain

```rust
/// Compute the hash of a YBalance state (for prev_hash chain).
pub fn balance_state_hash(balance: &YBalance) -> ContentAddress {
    let bytes = bincode::serialize(&(
        &balance.owner,
        balance.balance,
        balance.nonce,
        &balance.prev_hash,
        &balance.last_tx,
    )).unwrap();
    ContentAddress(hash_blake3(&bytes))
}
```

The hash chain makes tampering detectable: changing any historical state breaks the chain.

### Balance Operations

```rust
/// Apply a transaction to a Y balance, producing a new state and a receipt.
/// The caller MUST:
///   1. Store the receipt as an immutable Chunk (gets receipt_address)
///   2. Update the Y Scratchpad with YScratchpadPayload { balance, latest_receipt: receipt_address }
pub fn apply_transaction(
    current: &YBalance,
    tx: YTransaction,
    sk: &SecretKey,
    prev_receipt_addr: Option<ContentAddress>,
) -> Result<(YBalance, YReceipt), TokenYError>;

/// Validate a Y balance state (signature, hash chain, nonce ordering).
pub fn validate_balance(balance: &YBalance) -> Result<(), TokenYError>;

/// Validate a full balance history by walking the receipt chain.
/// Fetches receipts from storage via walk_receipt_chain(), then verifies
/// each transition: signature, arithmetic, nonce monotonicity, hash chain.
pub fn validate_balance_history(
    receipts: &[YReceipt],
) -> Result<(), TokenYError>;
```

## Transfer Protocol (`transfer.rs`)

### Transfer Flow: Alice tips 5 Y to Bob

**Step 1: Alice creates debit**

```rust
pub struct PendingDebit {
    pub sender: PublicKey,
    pub recipient: PublicKey,
    pub amount: u64,
    pub sender_nonce: u64,     // Nonce AFTER this debit
    pub created_at_epoch: u64,
    pub expiry_epoch: u64,     // created_at_epoch + TRANSFER_EXPIRY_EPOCHS
}
```

Alice's Y Scratchpad transitions:
```
Before: { balance: 100, nonce: 5, prev_hash: H5 }
After:  { balance: 95,  nonce: 6, prev_hash: H6, last_tx: Debit { recipient: bob, amount: 5 } }
```

**Step 2: Confirmation window passes**

Measured in total network Scratchpad writes (e.g., 5,000 writes after Alice's debit). This gives watchers time to detect double-spend attempts.

**Step 3: Bob verifies and credits**

Bob's client:
1. Reads Alice's Y Scratchpad → gets `YScratchpadPayload` including `latest_receipt`
2. Walks Alice's receipt chain from `latest_receipt` to find the debit at the expected nonce
3. Verifies Alice's debit is valid (correct nonce, sufficient balance, valid signature)
4. Records `sender_debit_receipt` = content address of Alice's debit receipt Chunk
5. Checks no double-spend fork exists (no conflicting state at same nonce)
6. Credits Bob's own balance, referencing the specific debit receipt

Bob's Y Scratchpad transitions:
```
Before: { balance: 50, nonce: 3, prev_hash: H3 }
After:  { balance: 55, nonce: 4, prev_hash: H4, last_tx: Credit { sender: alice, amount: 5, sender_debit_nonce: 6, sender_debit_receipt: <receipt_addr> } }
```

**Step 4: Watchers verify both sides independently**

### Transfer Expiry and Reclaim

If Bob never credits within `TRANSFER_EXPIRY_EPOCHS`:

```rust
pub struct ReclaimTransaction {
    pub original_debit_nonce: u64,
    pub amount: u64,
    /// Content address of the original debit receipt being reclaimed.
    pub original_debit_receipt: ContentAddress,
    pub reason: ReclaimReason,
}

pub enum ReclaimReason {
    /// Recipient never credited within expiry window.
    RecipientTimeout,
}
```

Alice's client:
1. Verifies Bob's Y Scratchpad shows no credit referencing `sender_debit_nonce: 6` or `sender_debit_receipt: <alice_debit_receipt_addr>`
2. Posts a reclaim transaction to Alice's own balance, referencing both `original_debit_nonce: 6` and `original_debit_receipt: <alice_debit_receipt_addr>`
3. Watchers verify the reclaim is legitimate by fetching the referenced receipt Chunk and confirming the debit matches

### Transfer Validation

```rust
/// Validate a debit transaction.
pub fn validate_debit(
    before: &YBalance,
    after: &YBalance,
) -> Result<(), TransferError>;

/// Validate a credit transaction by checking the sender's debit.
/// Now also verifies that `sender_debit_receipt` (from the Credit variant)
/// exists as a Chunk on Autonomi and contains a matching Debit transaction
/// for the correct amount and recipient.
pub fn validate_credit(
    credit_balance: &YBalance,
    sender_balance: &YBalance,
    storage: &dyn Storage,
) -> Result<(), TransferError>;

/// Validate a reclaim transaction.
/// Now also verifies that `original_debit_receipt` (from the Reclaim variant)
/// exists as a Chunk on Autonomi and contains the original Debit being reclaimed.
pub fn validate_reclaim(
    reclaimer_balance: &YBalance,
    recipient_balance: &YBalance,
    current_epoch: u64,
    storage: &dyn Storage,
) -> Result<(), TransferError>;
```

## Receipt Chain (`receipt.rs`)

### Purpose

Scratchpads are mutable — each update overwrites the previous state. The receipt chain preserves every Y state transition as an immutable Chunk on Autonomi, enabling full history verification by anyone at any time (including late-joining indexers).

### Types

The `YReceipt` and `YScratchpadPayload` types are defined in `dsn-core` (see `01-core-types.md`). Key points:

- `YBalance` is **unchanged** — no `receipt_head` field, no circular dependency
- `YReceipt` wraps a `YBalance` snapshot plus a `prev_receipt` pointer (linked list)
- `YScratchpadPayload` wraps the balance + `latest_receipt` address on the Scratchpad
- Estimated receipt size: ~300-500 bytes per Chunk

### Receipt Operations

```rust
/// Create a receipt for a new balance state.
pub fn create_receipt(
    new_balance: &YBalance,
    prev_receipt_addr: Option<ContentAddress>,
) -> YReceipt {
    YReceipt {
        state: new_balance.clone(),
        prev_receipt: prev_receipt_addr,
    }
}

/// Walk the receipt chain from the latest receipt back to genesis.
/// Stops when a receipt with prev_receipt = None is reached (genesis).
pub async fn walk_receipt_chain(
    storage: &dyn Storage,
    latest_receipt: &ContentAddress,
) -> Result<Vec<YReceipt>, TokenYError>;

/// Walk the receipt chain incrementally, stopping at a previously-verified receipt.
/// Returns only the new receipts (newest first). Used by the indexer crawler
/// to avoid re-verifying the entire chain on every crawl cycle.
pub async fn walk_receipt_chain_incremental(
    storage: &dyn Storage,
    latest_receipt: &ContentAddress,
    stop_at: Option<ContentAddress>,
) -> Result<Vec<YReceipt>, TokenYError>;

/// Verify a receipt chain: signature, arithmetic, nonce monotonicity,
/// hash chain integrity across all transitions.
pub fn verify_receipt_chain(
    receipts: &[YReceipt],
) -> Result<(), TokenYError>;
```

### Genesis Receipt

At account creation, the first receipt records the initial zero-balance state:

- `state.balance = 0`, `state.nonce = 0`, `state.last_tx = None`
- `prev_receipt = None`
- Every Y account traces back to this genesis, ensuring all Y originates from valid Claims or Credits

### How Receipts Integrate with Transactions

1. User performs a transaction (debit, credit, claim, burn, reclaim)
2. Client computes new `YBalance` state, signs it
3. Client creates `YReceipt { state: new_balance, prev_receipt: prev_receipt_address }`
4. Client stores receipt as immutable Chunk → gets `receipt_address`
5. Client updates Y Scratchpad with `YScratchpadPayload { balance: new_balance, latest_receipt: receipt_address }`

### Receipt Storage Cost

Each receipt is ~300-500 bytes, stored as a single Chunk on Autonomi. Users pay the standard Chunk storage fee (one-time, permanent storage). For a user making ~100 transactions per epoch, this is negligible relative to the initial Scratchpad creation costs.

## Self-Serve Claiming (`claim.rs`)

### Claim Flow

1. Epoch N ends (epoch boundary Chunk published)
2. User computes their R earned during epoch N (from public Autonomi data)
3. User computes their Y claim: `(my_r / total_r) * epoch_emission`
4. User publishes a Claim transaction to their Y Scratchpad:
   ```
   { balance: old + claim, nonce: N+1, last_tx: Claim { epoch: N, amount: claim, proof_hash: H } }
   ```
5. `proof_hash` = hash of the full computation (all users' R, the formula, the result)

### Claim Validation

```rust
/// Verify a Y claim is correct.
pub fn verify_claim(
    claim: &YTransaction,          // The Claim variant
    claimer: &PublicKey,
    epoch_boundary: &EpochBoundary,
    all_r_earned: &HashMap<PublicKey, u64>,
) -> Result<(), ClaimError> {
    match claim {
        YTransaction::Claim { epoch, amount, proof_hash } => {
            // 1. Recompute expected claim
            let expected = compute_epoch_claims(*epoch, all_r_earned)
                .get(claimer)
                .copied()
                .unwrap_or(0);

            // 2. Verify amount matches
            if *amount != expected {
                return Err(ClaimError::IncorrectAmount { claimed: *amount, expected });
            }

            // 3. Verify proof hash matches our computation
            let expected_proof_hash = compute_proof_hash(*epoch, all_r_earned);
            if *proof_hash != expected_proof_hash {
                return Err(ClaimError::InvalidProof);
            }

            Ok(())
        }
        _ => Err(ClaimError::NotAClaim),
    }
}
```

### Double-Claim Prevention

- Each epoch can only be claimed once per user
- The `epoch` field in the Claim transaction + the nonce chain prevent replay
- Watchers verify that no user claims the same epoch twice

## Double-Spend Detection (`fraud.rs`)

### How Double-Spends Manifest

A double-spend requires the owner to create **two valid Scratchpad states at the same nonce**:

```
State A: { balance: 95, nonce: 6, last_tx: Debit(Bob, 5) }     ← signed by owner
State B: { balance: 95, nonce: 6, last_tx: Debit(Charlie, 5) } ← signed by owner
```

Both are valid individually. But having two states at the same nonce is a **fork**, which Autonomi's Scratchpad CRDT detects.

### Fraud Proof Structure

```rust
/// Cryptographic proof of a double-spend attempt.
/// Stored as an immutable Chunk on Autonomi (permanent, unforgeable).
#[derive(Clone, Serialize, Deserialize)]
pub struct FraudProof {
    /// The account that double-spent.
    pub offender: PublicKey,

    /// The two conflicting states (same nonce, different content).
    pub state_a: YBalance,
    pub state_b: YBalance,

    /// The nonce at which the fork occurred.
    pub forked_nonce: u64,

    /// Receipt addresses for the conflicting states (immutable evidence).
    /// Verifiers can fetch both receipts directly from Autonomi.
    pub receipt_a: ContentAddress,
    pub receipt_b: ContentAddress,

    /// Who detected this fraud.
    pub reporter: PublicKey,

    /// Reporter's signature over the proof.
    pub reporter_signature: Signature,
}
```

### Fraud Proof Validation

```rust
/// Verify a fraud proof is legitimate.
/// Can optionally fetch receipt Chunks from storage to verify receipt addresses.
pub async fn verify_fraud_proof(
    proof: &FraudProof,
    storage: &dyn Storage,
) -> Result<(), FraudError> {
    // 1. Both states must have the same owner
    assert_eq!(proof.state_a.owner, proof.state_b.owner);
    assert_eq!(proof.state_a.owner, proof.offender);

    // 2. Both states must have the same nonce
    assert_eq!(proof.state_a.nonce, proof.state_b.nonce);
    assert_eq!(proof.state_a.nonce, proof.forked_nonce);

    // 3. States must be different (otherwise not a fork)
    assert_ne!(
        bincode::serialize(&proof.state_a.last_tx),
        bincode::serialize(&proof.state_b.last_tx)
    );

    // 4. Both signatures must be valid (proving the owner signed both)
    assert!(proof.state_a.verify_signature());
    assert!(proof.state_b.verify_signature());

    // 5. Verify receipt addresses resolve to the conflicting states
    let receipt_a: YReceipt = fetch_and_deserialize(storage, &proof.receipt_a).await?;
    let receipt_b: YReceipt = fetch_and_deserialize(storage, &proof.receipt_b).await?;
    assert_eq!(receipt_a.state, proof.state_a);
    assert_eq!(receipt_b.state, proof.state_b);

    // 6. Reporter's signature must be valid
    assert!(proof.reporter.verify(&proof.reporter_signature, &proof.signable_bytes()));

    Ok(())
}
```

### Consequences of Fraud

When a valid fraud proof exists for a user:
1. **Y balance slashed to zero** — all clients and indexers treat the account's Y as 0
2. **R destroyed** — R balance set to 0
3. **Permanent flag** — the fraud proof Chunk is permanent on Autonomi; no un-doing it
4. **All pending transfers from this account are void**

This is enforced by every client and indexer checking for fraud proofs before trusting a balance.

## Watcher Logic (`watcher.rs`)

### What Watchers Do

Watchers verify the integrity of Y balances. There is no separate "watcher" role — every client and indexer performs watcher duties for the accounts they interact with.

```rust
/// Watcher: verify a Y balance is correct.
/// Reads the Y Scratchpad to get `latest_receipt`, walks the receipt chain
/// via walk_receipt_chain(), then verifies the full history.
pub async fn verify_balance(
    storage: &dyn Storage,
    user_pk: &PublicKey,
) -> Result<WatcherVerdict, WatcherError>;

/// Watcher: scan for fraud proofs against a user.
pub async fn check_for_fraud(
    storage: &dyn Storage,
    user: &PublicKey,
) -> Result<Option<FraudProof>, WatcherError>;

/// Watcher: verify all Y claims for an epoch.
pub async fn verify_epoch_claims(
    storage: &dyn Storage,
    epoch: u64,
) -> Result<Vec<ClaimVerdict>, WatcherError>;

pub enum WatcherVerdict {
    Valid,
    InvalidBalance { expected: u64, actual: u64 },
    InvalidNonceChain,
    InvalidSignature,
    FraudDetected(FraudProof),
}

pub enum ClaimVerdict {
    Valid { claimer: PublicKey, amount: u64 },
    Overclaim { claimer: PublicKey, claimed: u64, correct: u64 },
    DoubleClaim { claimer: PublicKey, epoch: u64 },
}
```

### Watcher Tiers

| Tier | Actor | Scope | Frequency |
|---|---|---|---|
| **Full watcher** | Indexers | All accounts | Every crawl cycle |
| **Interaction watcher** | Client receiving a tip | Sender's full history | On each incoming transfer |
| **Spot-check watcher** | Client viewing a profile | Random balance checks | On profile view |

## Event-Based Epochs (`epoch.rs`)

### Epoch Boundary Detection

```rust
/// Count curations since the last epoch boundary.
/// When count >= CURATIONS_PER_EPOCH, a new epoch can be declared.
pub async fn count_curations_since_boundary(
    storage: &dyn Storage,
    last_boundary: &EpochBoundary,
) -> Result<u64, EpochError>;

/// Attempt to publish an epoch boundary.
/// Returns the boundary if valid, None if not enough curations yet.
pub async fn try_publish_epoch_boundary(
    storage: &dyn Storage,
    last_boundary: &EpochBoundary,
    publisher_sk: &SecretKey,
) -> Result<Option<EpochBoundary>, EpochError>;

/// Get the current epoch number by walking the epoch chain.
pub async fn current_epoch(
    storage: &dyn Storage,
) -> Result<u64, EpochError>;
```

### Epoch Boundary Publication Race

Multiple users might try to publish the boundary simultaneously. Since epoch boundaries are stored as Chunks (content-addressed), identical boundaries produce the same address — so they naturally converge. Different boundaries (e.g., slightly different curation counts due to timing) are resolved by "first valid Chunk wins" — indexers accept the first valid boundary they see.

## Error Types (`error.rs`)

```rust
#[derive(Debug, thiserror::Error)]
pub enum TokenYError {
    #[error("insufficient balance: have {have}, need {need}")]
    InsufficientBalance { have: u64, need: u64 },

    #[error("invalid nonce: expected {expected}, got {actual}")]
    InvalidNonce { expected: u64, actual: u64 },

    #[error("broken hash chain at nonce {nonce}")]
    BrokenHashChain { nonce: u64 },

    #[error("invalid signature on balance state")]
    InvalidSignature,

    #[error("double-spend detected at nonce {nonce}")]
    DoubleSpend { nonce: u64 },

    #[error("transfer expired: created epoch {created}, current epoch {current}, expiry {expiry}")]
    TransferExpired { created: u64, current: u64, expiry: u64 },

    #[error("claim error: {0}")]
    Claim(#[from] ClaimError),

    #[error("receipt not found: {address:?}")]
    ReceiptNotFound { address: ContentAddress },

    #[error("broken receipt chain at nonce {at_nonce}")]
    BrokenReceiptChain { at_nonce: u64 },

    #[error("missing genesis receipt")]
    MissingGenesisReceipt,

    #[error("invalid debit receipt: expected nonce {expected_nonce}")]
    InvalidDebitReceipt { expected_nonce: u64 },

    #[error("data layer error: {0}")]
    Data(#[from] DataError),
}

#[derive(Debug, thiserror::Error)]
pub enum ClaimError {
    #[error("incorrect claim amount: claimed {claimed}, expected {expected}")]
    IncorrectAmount { claimed: u64, expected: u64 },

    #[error("invalid proof hash")]
    InvalidProof,

    #[error("epoch {epoch} already claimed")]
    AlreadyClaimed { epoch: u64 },

    #[error("not a claim transaction")]
    NotAClaim,
}

#[derive(Debug, thiserror::Error)]
pub enum TransferError {
    #[error("sender debit not found at nonce {nonce}")]
    DebitNotFound { nonce: u64 },

    #[error("credit amount {credit} doesn't match debit amount {debit}")]
    AmountMismatch { credit: u64, debit: u64 },

    #[error("confirmation window not yet passed")]
    ConfirmationPending,

    #[error("reclaim invalid: recipient already credited")]
    RecipientAlreadyCredited,
}
```

## Y Utility Implementation Notes

### Curation Staking with Y

When a user curates a post, they can optionally stake Y alongside R:
- Y staking amplifies curation weight (details in Token R doc)
- Staked Y is locked until the cooling period ends
- If curation succeeds (DiversityScore > threshold), staked Y is returned + bonus Y
- If curation fails, staked Y is slashed (partially burned)

### Post Boosting (Y Burn)

```rust
/// Burn Y to boost a post's visibility in indexer feeds.
pub fn create_boost_burn(
    current_balance: &YBalance,
    post_address: &ContentAddress,
    amount: u64,
    sk: &SecretKey,
) -> Result<YBalance, TokenYError>;
```

Burned Y is permanently removed from circulation (deflationary). Indexers see the burn and may prioritize the post in feeds (at their discretion — indexers are free agents).

### Tipping

Standard transfer protocol. No special mechanics beyond the debit/credit flow described above.
