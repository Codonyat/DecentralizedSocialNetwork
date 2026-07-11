# Master Implementation Plan

## Architecture Overview

The system is split into two layers:

- **On-chain** (blockchain with smart contracts): Token Y, bonds, donations, name registry, invitation tree, epoch/emission management, anchor log (content timestamps)
- **Off-chain** (indexer-served, see 12-storage-and-anchoring.md): Content (posts), profiles, follow graphs, feed indices, moderation flags — signed, content-addressed, transport-agnostic

Smart contracts enforce economic rules atomically. Off-chain content is self-authenticating (content addresses + author signatures), stored and served by competing indexers, with clients keeping local copies of their own data. The indexer bridges both layers into a queryable REST API.

**Identity**: The canonical identity is the **IdentityId** (a user's genesis public key), resolved to a current signing key through the **IdentityRegistry** (rotation + M-of-N guardian recovery — see 01-core-types.md, Identity Registry, Rotation & Recovery). Every structural reference (invitation tree, donations, flags, handle ownership) embeds the IdentityId, never a rotatable signing key directly. On-chain @handles (claim/assess/rent/force-buy — see 01-core-types.md, 03-token-y.md §E) are a resolvable label layer on top, unchanged, never a structural reference.

**Ranking**: indexers serve verifiable data and candidate sets; feed ranking runs client-side on a user-owned, swappable model (see 09-client-ranking.md). Indexers are paid through a market for query access in Y, not by the protocol (see 07-indexer.md, Indexer Economics).

**Storage & timestamps**: there is no normative storage network — indexers store and serve all content (full text replication), clients keep local copies of their own signed data, and indexers periodically anchor Merkle roots of new content on-chain so any post's existence can be proven against a block timestamp (see 12-storage-and-anchoring.md).

## Deployment Targets

The `dsn-chain` trait abstraction keeps protocol logic chain-agnostic; the L2 that hosts the social economy is chosen at build time against binding criteria, not committed in this document.

- **Canonical token home: Ethereum L1.** The YToken contract of record (and the bridge escrow) lives on L1 — the deepest-security, most credibly neutral settlement layer. L1 is settlement only; no social-frequency traffic.
- **Social economy: an L2 meeting binding criteria (decision deferred behind `ChainClient`).** Donations, bonds, handle rent, invitations, epochs, and the Reward Pool need an L2 where fees are sub-cent. A candidate chain must clear all of: permissionless validity/fraud proofs; no upgrade keys and no exit-length timelocks that could strand users (Stage-2 rollup properties); usable forced inclusion (a censored user can force a transaction through L1 in bounded time); sub-cent fees; no single-company dependence for sequencing or upgrades.
  **July 2026 snapshot** (informational, not a commitment — re-evaluate at build time): Arbitrum One is the decentralization leader — permissionless BoLD fraud proofs and a walkaway-safe upgrade path — but a live deployment against the full criteria list hasn't landed. Base is the distribution leader (Farcaster/Zora ecosystem, Coinbase onboarding funnel, the most mature sponsored-gas infrastructure) but remains Stage 1, with a centralized Coinbase sequencer and OFAC-filtered transaction inclusion. **No live L2 clears every criterion today.** For a decentralization-first wedge audience, sequencer centralization is a real cost, not a rounding error — so the chain is selected at deployment time behind the `ChainClient` seam, not fixed here.
- **Onboarding: ERC-4337 sponsored gas, gated by the invitation tree.** A paymaster covers gas for invited accounts (per-account budget), so new users never need ETH; the invitation tree is the sybil gate that makes sponsorship non-drainable. The paymaster can also accept Y for gas beyond the sponsored budget.

## Project Structure

```
DecentralizedSocialNetwork/
├── Cargo.toml                    # Workspace root
├── docs/                         # Design documents (this directory)
│   ├── 00-master-plan.md
│   ├── 01-core-types.md
│   ├── 02-data-layer.md
│   ├── 03-token-y.md
│   ├── 05-invitation.md
│   ├── 06-moderation.md
│   ├── 07-indexer.md
│   ├── 08-cli.md
│   ├── 09-client-ranking.md
│   ├── 12-storage-and-anchoring.md
│   └── archive/                  # Non-normative: parallel-spec critique (standing red-team brief)
├── crates/
│   ├── core/                     # Types, crypto, serialization
│   ├── data/                     # Off-chain content storage abstraction
│   ├── chain/                    # Blockchain abstraction layer
│   ├── token-y/                  # Token Y: emission, bonding, donations, handle rent (pure math)
│   ├── invitation/               # On-chain invitation tree + trust distance
│   ├── moderation/               # Content flagging + filtering
│   ├── indexer/                  # Chain listener + ingest & sync + REST API
│   └── cli/                      # CLI client
└── .gitignore
```

## Crate Dependency Graph

```
                    ┌──────────┐
                    │ dsn-core │
                    └────┬─────┘
                         │
           ┌─────────────┼─────────────┐
           │             │             │
    ┌──────┴─────┐ ┌─────┴─────┐ ┌────┴───────┐
    │ dsn-data   │ │ dsn-chain │ │dsn-token-y │
    │(off-chain) │ │(on-chain) │ │(pure math) │
    └──────┬─────┘ └─────┬─────┘ └────┬───────┘
           │             │             │
           │        ┌────┴──────┐     │
           │        │dsn-invite │     │
           │        └────┬──────┘     │
           │             │            │
           │   ┌─────────┴──────┐    │
           │   │ dsn-moderation │    │
           │   └─────────┬──────┘    │
           │             │            │
           └─────────────┼────────────┘
                         │
             ┌───────────┴───────────┐
             │      dsn-indexer      │
             └───────────┬───────────┘
                         │
             ┌───────────┴───────────┐
             │       dsn-cli         │
             └───────────────────────┘
```

### Dependency Details

| Crate | Depends On | Role |
|---|---|---|
| `dsn-core` | (none) | Shared types, crypto primitives |
| `dsn-data` | core | Off-chain content storage traits + in-memory mock |
| `dsn-chain` | core | On-chain blockchain abstraction traits + in-memory mock |
| `dsn-token-y` | core | Pure computation: emission, bonding curves, donation math, handle rent math |
| `dsn-invitation` | core, chain | On-chain invitation tree, trust distance, donation weighting |
| `dsn-moderation` | core, data | Content flags, counter-flags, review, policies |
| `dsn-indexer` | core, data, chain, token-y, invitation, moderation | Chain listener, ingest & sync, REST API, feed ranking |
| `dsn-cli` | core, data, chain, token-y, invitation, moderation, indexer | User-facing CLI client |

## Build Order

The crates must be implemented in this order (each depends on the previous):

1. **dsn-core** — Zero internal workspace dependencies. All other crates depend on this.
2. **dsn-data, dsn-chain, dsn-token-y** — These three depend only on dsn-core. They are independent of each other and can be built in parallel.
3. **dsn-invitation, dsn-moderation** — These depend on core + chain or core + data. Independent of each other, can be built in parallel.
4. **dsn-indexer** — Depends on all protocol crates. Integrates everything.
5. **dsn-cli** — Depends on everything. Final integration point.

## Key Workspace Dependencies

| Dependency | Purpose | Used By |
|---|---|---|
| `serde` + `serde_json` + `bincode` | Serialization (JSON for API, bincode for compact storage) | All crates |
| `sha2` + `blake3` + `ed25519-dalek` | Hashing (SHA-256 for compatibility, BLAKE3 for speed) + ed25519 signature keypairs | core |
| `tokio` + `async-trait` | Async runtime + trait support | data, chain, indexer, cli |
| `thiserror` | Typed errors | All crates |
| `chrono` | Timestamps (for local display; epochs are block-based on-chain) | core |
| `rand` | Key generation, testing | core |
| `axum` + `tower-http` | HTTP server for indexer REST API | indexer |
| `clap` | CLI argument parsing | cli |
| `reqwest` | HTTP client (CLI → indexer) | cli |
| `tracing` | Structured logging | All crates |

## Storage Strategy

### Off-Chain (indexer-served, doc 12)

There is no normative storage network. Content is signed and
content-addressed, so integrity is transport-independent; indexers store
and serve it (full text replication), and clients keep local copies of
their own data. The `dsn-data` crate defines trait abstractions for
content storage (what an indexer's storage backend must do):
1. `ContentStore` — immutable, content-addressed data (posts)
2. `MutableStore` — mutable, key-addressed data (profiles, follows, feed indices)
3. `GraphStore` — directed graph edges (replies, content flags)

A `MemoryContentStorage` implementation enables fast testing and simulation without a real network.

### On-Chain (Blockchain)

The `dsn-chain` crate defines the `ChainClient` trait abstracting all blockchain operations:
- Y balance queries and transfers
- Bond placement and queries
- Donation execution and queries
- Handle claim / assessment / rent / force-buy and resolution
- Invitation creation and trust distance queries
- Epoch info queries (emission is auto-distributed)
- Anchor log: posting Merkle anchor roots, querying anchor events (doc 12)
- Chain event listening (for indexer)

A `MemoryChainClient` implementation enables testing without a real blockchain.

### What Lives Where

| Data | Layer | Rationale |
|---|---|---|
| Y token balances | On-chain | Atomic enforcement, no double-spend |
| Bonds | On-chain | Bonding curve state needs atomic updates |
| Donations | On-chain | Fee routing to Reward Pool, emission accounting |
| Name registry | On-chain | Global uniqueness guarantee |
| Invitation tree | On-chain | Sybil resistance, trust distance |
| Epoch/emission | On-chain | Deterministic, auto-distributed |
| Anchor roots | On-chain | Timestamp proofs for off-chain content (doc 12) |
| Posts | Off-chain | Signed object hosted by indexers (full replication), self-authenticating; timestamps via anchor roots (doc 12) |
| Profiles | Off-chain | Signed mutable object hosted by indexers, no economic value |
| Follow graphs | Off-chain | Signed object hosted by indexers, portable, no on-chain cost |
| Feed indices | Off-chain | Signed mutable object hosted by indexers, convenience data |
| Moderation flags | Off-chain | Signed object hosted by indexers, aggregated for scoring |

## Smart Contracts (documented, implemented separately)

The following smart contracts enforce on-chain rules. They are not part of this Rust workspace — they are implemented in a separate repo (Solidity/Vyper/etc.) and deployed to the target blockchain.

1. **YToken** — ERC-20 + mint (scheduled emission, hard 140B cap); tokens are never destroyed
2. **BondingContract** — bond(), bonding curve state per post hash
3. **DonationContract** — donate(), fee to Reward Pool, forward to creator
4. **EmissionContract** — epoch tracking, auto-distribution to creators
5. **NameRegistry** — Harberger registry: claim()/assess()/pay_rent()/force_buy()/resolve()
6. **InvitationTree** — invite(), trust distance, genesis seeding
7. **RewardPool** — receives all protocol fees after a 10% referral cut (REFERRAL_BPS, routed to the payer's direct inviter for the payer's first REFERRAL_TERM_EPOCHS); drips 2%/epoch into creator emission, of which 15% (TREASURY_DRIP_SHARE_BPS) routes to the Treasury until epoch 260 (TREASURY_TERM_EPOCHS), then 100% to creators
8. **AnchorLog** — event-only `anchor(bytes32 root)` for content timestamp proofs (doc 12 §4)
9. **IdentityRegistry** — `rotate()` / `set_guardians()` / `recover()`: key rotation plus M-of-N guardian social recovery with a RECOVERY_VETO_EPOCHS = 2 veto window for the current key
10. **Treasury** — a disclosed, timelocked address; holds tokens, not powers (no privileged protocol calls); unspent balance auto-reclaims to the Reward Pool at epoch 416 (TREASURY_RECLAIM_EPOCH)

## Cross-Cutting: Epoch Model

Epochs are block-based or time-based, determined by the smart contract. No user-initiated epoch boundaries. The EmissionContract advances the epoch automatically and distributes emission to creators.

## Testing Strategy

| Level | Tool | Scope |
|---|---|---|
| Unit tests | `cargo test` | Each crate individually |
| Integration tests | `cargo test` (integration test files) | Cross-crate interactions |
| Simulation | Custom binary using MemoryContentStorage + MemoryChainClient | Multi-agent adversarial testing |
| Testnet | Manual + scripts | Real blockchain + real content storage validation |

## File Naming Conventions

- Module files: `snake_case.rs`
- Type names: `PascalCase`
- Functions/methods: `snake_case`
- Constants: `SCREAMING_SNAKE_CASE`
- Crate names: `dsn-{name}` (kebab-case in Cargo, `dsn_{name}` in Rust code)
