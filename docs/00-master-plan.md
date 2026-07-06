# Master Implementation Plan

> **Design canon:** the economic and trust design was revised by docs
> 09 (first-principles review), 10 (token economy), and 11 (service registry
> & staking). Where any older phrasing conflicts, docs 09–11 govern.
> Summary of the revision: bonding curves and donation-weighted emission are
> removed; the economy is tips (transfer + flat burn), burned protocol fees
> (names + renewals, invitations, promotion), a usage rebate pool, referral
> annuities, and staked/slased indexers. The money layer contains nothing
> subjective (doc 09 §3).

## Architecture Overview

The system is split into two layers:

- **On-chain** (one execution layer, per the co-location rule of doc 11 §1): Token Y, tips, protocol fee sinks (names + renewals, invitations, promotion), usage rebate pool, referral routing, identity registry (key rotation/recovery), invitation registry, service registry (indexer staking/slashing)
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
│   ├── 08-cli.md
│   ├── 09-first-principles-review.md
│   ├── 10-token-economy.md
│   └── 11-service-registry-staking.md
├── crates/
│   ├── core/                     # Types, crypto, serialization
│   ├── data/                     # Off-chain content storage abstraction
│   ├── chain/                    # Blockchain abstraction layer
│   ├── token-y/                  # Token Y: tips, fees, rebates, referrals, names (pure math)
│   ├── invitation/               # On-chain invitation registry + referral annuity
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
| `dsn-token-y` | core | Pure computation: tip splits, fee splits, rebate distribution, referral math, name pricing/renewal |
| `dsn-invitation` | core, chain, token-y | On-chain invitation registry, referral annuity, informational tree queries |
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
- Tips (transfer + burn, with content-ref memo)
- Promotion burns
- Name registration, renewal, expiry, and resolution
- Invitation creation and registry queries
- Identity registry: key rotation, recovery configuration
- Service registry: stakes, slashing state, endpoint records
- Epoch info and rebate pool queries (rebates are auto-distributed)
- Chain event listening (for indexer)

A `MemoryChainClient` implementation enables testing without a real blockchain.

### What Lives Where

| Data | Layer | Rationale |
|---|---|---|
| Y token balances | On-chain | Atomic enforcement, no double-spend |
| Tips | On-chain | Burn enforcement; memo links to off-chain post |
| Promotion burns | On-chain | Burn enforcement; indexers read amplification signal |
| Name registry (+ renewals/expiry) | On-chain | Global uniqueness, expiry against the same clock that took the burn |
| Invitation registry | On-chain | Membership record, referral attribution |
| Referral routing | On-chain | Fee split must be atomic with the burn |
| Identity registry (rotation/recovery) | On-chain | Key rotation must be globally unambiguous |
| Service registry (stakes/slashes) | On-chain | Slash must seize the exact escrow (doc 11) |
| Epoch/rebate pool | On-chain | Deterministic, auto-distributed pro-rata to fees burned |
| Posts | Off-chain | Large content, cheap permanent storage; posting is free |
| Profiles | Off-chain | Mutable user data, no economic value |
| Follow graphs | Off-chain | User-signed, portable, no on-chain cost |
| Feed indices | Off-chain | Mutable convenience data |
| Moderation flags | Off-chain | GraphEntries, indexer-aggregated |

## Smart Contracts (documented, implemented separately)

The following smart contracts enforce on-chain rules (the contract suite of
doc 11 §1.1, all on one execution layer). They are not part of this Rust
workspace — they are implemented in a separate repo (Solidity/Vyper/etc.) and
deployed to the target blockchain. The monetary rules they encode are
immutable and admin-keyless (doc 10 §2); upgrades ship as new opt-in
contracts, never as changes to these.

1. **YToken** — fixed 21M supply, transfers, burn; genesis mint into allocation buckets only
2. **TipRouter** — tip(): transfer + flat burn, 32-byte content-ref memo
3. **NameRegistry** — register(), renew(), resolve(), expiry recycling, tiered pricing
4. **InvitationRegistry** — invite(), genesis seeding, invited_at_epoch records
5. **ReferralRouter** — splits every protocol fee: 10% to direct inviter (within term), rest burned
6. **RebatePool** — epoch tracking, scheduled drop distributed pro-rata to eligible fees burned
7. **ServiceRegistry** — indexer staking, signed-claim fraud proofs, slashing, liveness challenges (doc 11)
8. **IdentityRegistry** — stable identity ids, key rotation, M-of-N social recovery with veto window

## Cross-Cutting: What Replaces R? (and what replaced the replacements)

| Old (R was used for) | Current design (docs 09–11) |
|---|---|
| Curation weight (DiversityScore) | Tips (real money changing hands) + promotion burns; ranking is an edge-layer indexer choice |
| Y emission share | Removed. No emission targets social metrics (doc 09 §2.1). Distribution = usage rebates pro-rata to fees burned + service pool + schedule (doc 10 §3) |
| Invitation capacity | Y fee per invitation (fee sink + referral attribution) |
| Moderation flag/review weight | Uniform weighting with objective eligibility (invited + account age + moderation bond) |
| Spam prevention (R=0 = powerless) | Posting is FREE (doc 09 §2.4). Spam is handled at the edge: indexer/client filtering, trust-informed rate limits, and costs on amplification (promotion) rather than existence |

## Cross-Cutting: Epoch Model

Epochs are block-based (~1 week), determined by the smart contract. No
user-initiated epoch boundaries. The RebatePool advances the epoch
automatically and distributes the scheduled drop pro-rata to eligible
protocol fees burned during the epoch (doc 03 §E).

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
