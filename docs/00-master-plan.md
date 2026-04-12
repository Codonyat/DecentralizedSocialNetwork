# Master Implementation Plan

## Architecture Overview

The system is split into two layers:

- **On-chain** (blockchain with smart contracts): Token Y, bonds, donations, name registry, invitation tree, epoch/emission management
- **Off-chain** (IPFS/Autonomi): Content (posts), profiles, follow graphs, feed indices, moderation flags

Smart contracts enforce economic rules atomically. Off-chain content storage provides cheap, permanent, content-addressed data. The indexer bridges both layers into a queryable REST API.

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
│   └── 08-cli.md
├── crates/
│   ├── core/                     # Types, crypto, serialization
│   ├── data/                     # Off-chain content storage abstraction
│   ├── chain/                    # Blockchain abstraction layer
│   ├── token-y/                  # Token Y: emission, bonding, donations, names (pure math)
│   ├── invitation/               # On-chain invitation tree + trust distance
│   ├── moderation/               # Content flagging + filtering
│   ├── indexer/                  # Chain listener + content crawler + REST API
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
| `dsn-token-y` | core | Pure computation: emission, bonding curves, donation math, name pricing |
| `dsn-invitation` | core, chain | On-chain invitation tree, trust distance, donation weighting |
| `dsn-moderation` | core, data | Content flags, counter-flags, review, policies |
| `dsn-indexer` | core, data, chain, token-y, invitation, moderation | Chain listener, content crawler, REST API, feed ranking |
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
| `sha2` + `blake3` | Hashing (SHA-256 for compatibility, BLAKE3 for speed) | core |
| `tokio` + `async-trait` | Async runtime + trait support | data, chain, indexer, cli |
| `thiserror` | Typed errors | All crates |
| `chrono` | Timestamps (for local display; epochs are block-based on-chain) | core |
| `rand` | Key generation, testing | core |
| `axum` + `tower-http` | HTTP server for indexer REST API | indexer |
| `clap` | CLI argument parsing | cli |
| `reqwest` | HTTP client (CLI → indexer) | cli |
| `tracing` | Structured logging | All crates |

## Storage Strategy

### Off-Chain (IPFS/Autonomi)

The `dsn-data` crate defines trait abstractions for content storage:
1. `ContentStore` — immutable, content-addressed data (posts)
2. `MutableStore` — mutable, key-addressed data (profiles, follows, feed indices)
3. `GraphStore` — directed graph edges (replies, content flags)

A `MemoryContentStorage` implementation enables fast testing and simulation without a real network.

### On-Chain (Blockchain)

The `dsn-chain` crate defines the `ChainClient` trait abstracting all blockchain operations:
- Y balance queries and transfers
- Bond placement and queries
- Donation execution and queries
- Name registration and resolution
- Invitation creation and trust distance queries
- Epoch info queries (emission is auto-distributed)
- Chain event listening (for indexer)

A `MemoryChainClient` implementation enables testing without a real blockchain.

### What Lives Where

| Data | Layer | Rationale |
|---|---|---|
| Y token balances | On-chain | Atomic enforcement, no double-spend |
| Bonds | On-chain | Bonding curve state needs atomic updates |
| Donations | On-chain | Burn enforcement, emission accounting |
| Name registry | On-chain | Global uniqueness guarantee |
| Invitation tree | On-chain | Sybil resistance, trust distance |
| Epoch/emission | On-chain | Deterministic, auto-distributed |
| Posts | Off-chain | Large content, cheap permanent storage |
| Profiles | Off-chain | Mutable user data, no economic value |
| Follow graphs | Off-chain | User-signed, portable, no on-chain cost |
| Feed indices | Off-chain | Mutable convenience data |
| Moderation flags | Off-chain | GraphEntries, indexer-aggregated |

## Smart Contracts (documented, implemented separately)

The following smart contracts enforce on-chain rules. They are not part of this Rust workspace — they are implemented in a separate repo (Solidity/Vyper/etc.) and deployed to the target blockchain.

1. **YToken** — ERC-20 + burn + mint (emission only)
2. **BondingContract** — bond(), bonding curve state per post hash
3. **DonationContract** — donate(), burn fraction, forward to creator
4. **EmissionContract** — epoch tracking, auto-distribution to creators
5. **NameRegistry** — register(), resolve(), tiered pricing
6. **InvitationTree** — invite(), trust distance, genesis seeding

## Cross-Cutting: What Replaces R?

| Old (R was used for) | New Replacement |
|---|---|
| Curation weight (DiversityScore) | Bonding (Y at risk) + donations (Y burned) |
| Y emission share | Donations received (weighted by donor trust distance) |
| Invitation capacity | Y burn cost per invitation |
| Moderation flag/review weight | Uniform weighting with eligibility thresholds |
| Spam prevention (R=0 = powerless) | Mandatory first bond (posting costs Y), donations cost Y, invitations cost Y |

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
