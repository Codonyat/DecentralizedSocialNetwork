# Master Implementation Plan

## Architecture Overview

The system is split into two layers:

- **On-chain** (blockchain with smart contracts): Token Y, snapshot claims, like deposit/power/issuance and the fee pool, tips (with foreign-key escrow), name registry, identity registry, anchor log (content timestamps)
- **Off-chain** (indexer-served, see 12-storage-and-anchoring.md): Content (posts), profiles, follow graphs, likes, vouches, power delegations, feed indices, labels — signed, content-addressed, transport-agnostic

Smart contracts enforce economic rules atomically. Off-chain content is self-authenticating (content addresses + author signatures), stored and served by competing indexers, with clients keeping local copies of their own data. The indexer bridges both layers into a queryable REST API.

**Identity**: The canonical identity is the **IdentityId** (a user's genesis public key), resolved to a current signing key through the **IdentityRegistry** (rotation + M-of-N guardian recovery — see 01-core-types.md, Identity Registry, Rotation & Recovery). Every structural reference (vouches, likes, tips, labels, handle ownership) embeds the IdentityId, never a rotatable signing key directly. On-chain @handles (claim/assess/rent/force-buy — see 01-core-types.md, 03-token-y.md §D) are a resolvable label layer on top, unchanged, never a structural reference.

**Ranking**: indexers serve verifiable data and candidate sets; recall is a conserved attention budget with verifiable why-paths, and feed ranking runs client-side on a user-owned, swappable model (see 09-client-ranking.md). Reading is free: indexers and clients earn facilitator fees and sell bulk API access, and readers pay nothing (see 07-indexer.md, Indexer Economics).

**Storage & timestamps**: there is no normative storage network — indexers store and serve all content (full text replication), clients keep local copies of their own signed data, and indexers periodically anchor Merkle roots of new content on-chain so any post's existence can be proven against a block timestamp (see 12-storage-and-anchoring.md).

## Deployment Targets

The `dsn-chain` trait abstraction keeps protocol logic chain-agnostic; the L2 that hosts the social economy is chosen at build time against binding criteria, not committed in this document.

- **Canonical token home: Ethereum L1.** The YToken contract of record (and the bridge escrow) lives on L1 — the deepest-security, most credibly neutral settlement layer. L1 is settlement only; no social-frequency traffic.
- **Social economy: an L2 meeting binding criteria (decision deferred behind `ChainClient`).** Like settlements, tips, handle rent, snapshot claims, epochs, and the fee pool need an L2 where fees are sub-cent. A candidate chain must clear all of: permissionless validity/fraud proofs; no upgrade keys and no exit-length timelocks that could strand users (Stage-2 rollup properties); usable forced inclusion (a censored user can force a transaction through L1 in bounded time); sub-cent fees; no single-company dependence for sequencing or upgrades.
  **July 2026 snapshot** (informational, not a commitment — re-evaluate at build time): Arbitrum One is the decentralization leader — permissionless BoLD fraud proofs and a walkaway-safe upgrade path — but a live deployment against the full criteria list hasn't landed. Base is the distribution leader (Farcaster/Zora ecosystem, Coinbase onboarding funnel, the most mature sponsored-gas infrastructure) but remains Stage 1, with a centralized Coinbase sequencer and OFAC-filtered transaction inclusion. **No live L2 clears every criterion today.** For a decentralization-first wedge audience, sequencer centralization is a real cost, not a rounding error — so the chain is selected at deployment time behind the `ChainClient` seam, not fixed here.
- **Onboarding: ERC-4337 sponsored gas, run by the client.** The client's own paymaster covers a newcomer's gas and the client also pays the newcomer's first handle rent, both funded as acquisition cost and recouped from facilitator fees (05-invitation.md), so new users never need ETH. There is no protocol paymaster and no invitation-tree gate; the client's own abuse policy governs sponsorship. The paymaster can also accept Y for gas beyond the sponsored budget.

## Parameter Immutability & Upgrades

Every contract in the Smart Contracts list below is deployed immutable: no admin keys, no upgrade proxies, no post-deployment parameter setters. Where a doc marks a constant "(tunable)", that means tunable during design and simulation, frozen at deployment — no on-chain actor can change it afterward. A protocol change takes the form of a new deployment plus opt-in migration by users and indexers, the same standard the L2 selection criteria above demand of the underlying chain, applied here to our own contracts.

Immutability raises the stakes on calibration: a miscalibrated constant cannot be patched, only replaced through migration. This is why the design favors structural invariants that hold across parameter choices — e.g., the deposit bound on like-power issuance (03-token-y.md §B: a coalition's issuance is bounded by its own eligible deposit-time plus at most one day's carried power, whatever it does with accounts or routing) — over hand-tuned knobs whose safety depends on picking the right number.

### Canary deployment

Before the immutable main deployment, the same contracts deploy as a canary with their own, separately capped token. The canary must show repeat conversation and voluntary tipping when claim reminders and price excitement are absent; its decisive metric is the share of issuance reaching independent creators after harvesting tools appear. The 03-token-y.md constants taken from the canary parameter set (non-normative evidence: docs/proposals/2026-09-29-pillars-review.md §6c) are canary starting values, tuned by the canary, not by argument. The main deployment freezes what the canary validated, and cannot deploy while any `TBD` placeholder (03-token-y.md) is unset. Tipping is read against the canary token's price trend: a tipping decline while that token rises is the expected hoarding of an appreciating asset (03-token-y.md, Economic Design), not by itself evidence that users do not value creators.

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
│   ├── token-y/                  # Token Y: snapshot vesting, like power, issuance, fee pool, tips, handle rent (pure math)
│   ├── invitation/               # Vouch + power-delegation objects, quota/aura policy (off-chain)
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
          ┌──────────────┬──────┴───────┬──────────────┐
          │              │              │              │
    ┌─────┴──────┐ ┌─────┴──────┐ ┌─────┴──────┐ ┌─────┴──────┐
    │ dsn-data   │ │ dsn-chain  │ │dsn-token-y │ │dsn-invite  │
    │(off-chain) │ │(on-chain)  │ │(pure math) │ │(off-chain) │
    └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └─────┬──────┘
          │              │              │              │
          └──────────────┴──────┬───────┴──────────────┘
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
| `dsn-token-y` | core | Pure computation: snapshot vesting, like power, issuance, fee pool, tip split, handle rent math |
| `dsn-invitation` | core | Vouch and power-delegation objects, quota/aura policy (off-chain) |
| `dsn-indexer` | core, data, chain, token-y, invitation | Chain listener, ingest & sync, REST API, feed ranking |
| `dsn-cli` | core, data, chain, token-y, invitation, indexer | User-facing CLI client |

## Build Order

The crates must be implemented in this order (each depends on the previous):

1. **dsn-core** — Zero internal workspace dependencies. All other crates depend on this.
2. **dsn-data, dsn-chain, dsn-token-y, dsn-invitation** — These four depend only on dsn-core. They are independent of each other and can be built in parallel.
3. **dsn-indexer** — Depends on all protocol crates. Integrates everything.
4. **dsn-cli** — Depends on everything. Final integration point.

## Key Workspace Dependencies

| Dependency | Purpose | Used By |
|---|---|---|
| `serde` + `serde_json` + `bincode` | Serialization (JSON for API, bincode for compact storage) | All crates |
| `sha2` + `blake3` + `ed25519-dalek` | Hashing (SHA-256 for compatibility, BLAKE3 for speed) + ed25519 signature keypairs | core |
| `tokio` + `async-trait` | Async runtime + trait support | data, chain, indexer, cli |
| `thiserror` | Typed errors | All crates |
| `chrono` | Timestamps (for local display; on-chain epochs derive from block timestamps) | core |
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
3. `GraphStore` — directed graph edges (replies)

A `MemoryContentStorage` implementation enables fast testing and simulation without a real network.

### On-Chain (Blockchain)

The `dsn-chain` crate defines the `ChainClient` trait abstracting all blockchain operations:
- Y balance queries and transfers
- Tip execution and queries, foreign-key escrow claim / refund
- Deposit / withdraw, like-power queries, daily like settlement, creator reward claims
- Snapshot activation, tranche claims, entitlement splits
- Handle claim / assessment / rent / force-buy and resolution
- Epoch info queries (issuance and fee-pool rewards are pulled by creators after epoch close)
- Anchor log: posting Merkle anchor roots, querying anchor events (doc 12)
- Chain event listening (for indexer)

A `MemoryChainClient` implementation enables testing without a real blockchain.

### What Lives Where

| Data | Layer | Rationale |
|---|---|---|
| Y token balances | On-chain | Atomic enforcement, no double-spend |
| Tips | On-chain | Protocol fee to the fee pool, facilitator split, foreign-key escrow |
| Deposits / like power | On-chain | Power accrues from block timestamps; deposit bounds issuance |
| Like settlements | On-chain | Daily batched power spend; sets each creator's issuance claim |
| Snapshot entitlements | On-chain | Merkle-root allocation, weekly tranches |
| Fee pool | On-chain | Receives all protocol fees; drips against deposit-time |
| Name registry | On-chain | Global uniqueness guarantee |
| Epochs/issuance | On-chain | Deterministic from block timestamps; lazy close, pulled claims |
| Anchor roots | On-chain | Timestamp proofs for off-chain content (doc 12) |
| Posts | Off-chain | Signed object hosted by indexers (full replication), self-authenticating; timestamps via anchor roots (doc 12) |
| Profiles | Off-chain | Signed mutable object hosted by indexers, no economic value |
| Follow graphs | Off-chain | Signed object hosted by indexers, portable, no on-chain cost |
| Feed indices | Off-chain | Signed mutable object hosted by indexers, convenience data |
| Likes | Off-chain | Signed object hosted by indexers; a ranking signal for everyone, settled on-chain only for depositors and sponsors' delegates |
| Vouches | Off-chain | Signed object published by the vouchee; cold-start context (05) |
| Power delegations | Off-chain | Signed object; the sponsor settles its delegates' likes from its own meter (05) |
| Labels | Off-chain | Signed object hosted by indexers, aggregated client/indexer-side |

## Smart Contracts (documented, implemented separately)

The following smart contracts enforce on-chain rules. They are not part of this Rust workspace — they are implemented in a separate repo (Solidity/Vyper/etc.) and deployed to the target blockchain.

1. **YToken** — ERC-20; minted only by SnapshotClaim and Like; hard 140B cap; tokens are never destroyed
2. **SnapshotClaim** — snapshot Merkle root, weekly vesting tranches, entitlement split (03-token-y.md §A)
3. **Like** — deposit, like power, daily settlement, issuance, fee pool (03-token-y.md §B, Fee Pool)
4. **Tip** — protocol fee and facilitator split; foreign-key escrow with a 30-day refund (03-token-y.md §C)
5. **NameRegistry** — Harberger registry: claim()/assess()/pay_rent()/force_buy()/resolve(); base-rent controller with a per-epoch base-rent history (03-token-y.md §D)
6. **IdentityRegistry** — `rotate()` / `set_guardians()` / `recover()`: key rotation plus M-of-N guardian social recovery with a RECOVERY_VETO_EPOCHS = 2 veto window for the current key
7. **AnchorLog** — event-only `anchor(bytes32 root)` for content timestamp proofs (doc 12 §4)

The treasury is not a contract: it is a disclosed snapshot leaf (at most 10% of the snapshot allocation; exact size is the founder placeholder `TREASURY_SHARE_BPS`, 03-token-y.md §A) that vests like any other entitlement and holds tokens, not powers (no privileged protocol calls).

## Cross-Cutting: Epoch Model

An epoch is 604_800 s (one week) of L2 block time, derived from `block.timestamp`. No user-initiated epoch boundaries. Epoch close is lazy: the first transaction after the boundary closes the epoch and reserves that epoch's issuance budget and fee-pool share for creator claims, which creators pull afterwards (03-token-y.md §B, Fee Pool). No contract distributes automatically.

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
