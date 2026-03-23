# Master Implementation Plan

## Project Structure

```
DecentralizedSocialNetwork/
├── Cargo.toml                    # Workspace root
├── docs/                         # Design documents (this directory)
│   ├── 00-master-plan.md
│   ├── 01-core-types.md
│   ├── 02-data-layer.md
│   ├── 03-token-y.md
│   ├── 04-token-r.md
│   ├── 05-invitation.md
│   ├── 06-moderation.md
│   ├── 07-indexer.md
│   └── 08-cli.md
├── crates/
│   ├── core/                     # Types, crypto, serialization
│   ├── data/                     # Autonomi abstraction layer
│   ├── token-y/                  # Token Y emission + transfers
│   ├── token-r/                  # Token R reputation + curation
│   ├── invitation/               # Web of trust + Sybil resistance
│   ├── moderation/               # Content flagging + filtering
│   ├── indexer/                  # Crawler + REST API
│   └── cli/                      # CLI client
└── .gitignore
```

## Crate Dependency Graph

```
                    ┌──────────┐
                    │ dsn-core │
                    └────┬─────┘
                         │
                    ┌────┴─────┐
                    │ dsn-data │
                    └────┬─────┘
                         │
           ┌─────────────┼─────────────┬──────────────┐
           │             │             │              │
    ┌──────┴───────┐ ┌──┴──────┐ ┌────┴──────┐ ┌─────┴──────┐
    │ dsn-token-y  │ │dsn-token│ │dsn-invite  │ │dsn-moderate│
    │              │ │   -r    │ │            │ │            │
    └──────┬───────┘ └──┬──────┘ └────┬──────┘ └─────┬──────┘
           │             │             │              │
           └─────────────┴──────┬──────┴──────────────┘
                                │
                    ┌───────────┴───────────┐
                    │      dsn-indexer      │
                    └───────────┬───────────┘
                                │
                    ┌───────────┴───────────┐
                    │       dsn-cli         │
                    └───────────────────────┘
```

## Build Order

The crates must be implemented in this order (each depends on the previous):

1. **dsn-core** — Zero external crate dependencies within workspace. All other crates depend on this.
2. **dsn-data** — Depends only on dsn-core. Defines traits that all protocol crates use.
3. **dsn-token-y, dsn-token-r, dsn-invitation, dsn-moderation** — These four depend on core + data. They are independent of each other and can be built in parallel.
4. **dsn-indexer** — Depends on all protocol crates. Integrates everything.
5. **dsn-cli** — Depends on everything. Final integration point.

## Key Workspace Dependencies

| Dependency | Purpose | Used By |
|---|---|---|
| `serde` + `serde_json` + `bincode` | Serialization (JSON for human-readable, bincode for compact storage) | All crates |
| `sha2` + `blake3` | Hashing (SHA-256 for compatibility, BLAKE3 for speed) | core, token-y |
| `tokio` + `async-trait` | Async runtime + trait support | data, all protocol crates |
| `thiserror` | Typed errors | All crates |
| `chrono` | Timestamps (for local display; protocol uses event-based epochs) | core |
| `rand` | Key generation, testing | core |
| `axum` + `tower-http` | HTTP server for indexer REST API | indexer |
| `clap` | CLI argument parsing | cli |
| `reqwest` | HTTP client (CLI → indexer) | cli |
| `tracing` | Structured logging | All crates |

## Autonomi Integration Strategy

The Autonomi SDK (`autonomi` crate) is NOT a direct dependency at this stage. Instead:

1. **dsn-data** defines `trait` abstractions for all Autonomi operations
2. **dsn-data** provides a `MemoryStorage` implementation for testing and simulation
3. When ready for real network integration, we add an `AutonomiBacked` implementation behind those same traits
4. This allows all protocol logic to be developed, tested, and simulated without a running Autonomi network

### Why This Approach

- Autonomi testnet has 20-80s latency — unusable for rapid development iteration
- The protocol logic (token emission, reputation, fraud proofs) is complex and needs extensive unit testing
- Agent-based simulation (Phase 3 of roadmap) requires running thousands of agents — must be in-memory
- The abstraction layer naturally separates concerns and makes the code more testable

## Implementation Phases Mapped to Crates

| Roadmap Phase | Crates | What Gets Built |
|---|---|---|
| **Phase 1: Data Layer Proof** | core, data | Types, Autonomi traits, memory mock, real Autonomi backend |
| **Phase 2: Indexer + Web Client** | indexer, cli | Crawler, REST API, CLI client |
| **Phase 3: Token Simulation** | token-y, token-r | Token protocols + simulation harness (in-memory) |
| **Phase 4: Token Protocol + Watcher** | token-y, token-r, data | Fraud proofs, double-spend detection on testnet |
| **Phase 5: Launch** | invitation, moderation, cli | Web of trust, moderation, full CLI |

## Simulation-First Development

Token Y and Token R are the hardest parts of the system. They will be developed simulation-first:

1. Implement the protocol logic against `trait Storage` (in-memory)
2. Build agent-based simulation: honest agents, bot swarms, collusion rings
3. Tune parameters (DiversityScore threshold, halving schedule, decay rate, R cap)
4. Validate that honest strategies dominate
5. Only then connect to real Autonomi network

## Testing Strategy

| Level | Tool | Scope |
|---|---|---|
| Unit tests | `cargo test` | Each crate individually |
| Integration tests | `cargo test` (integration test files) | Cross-crate interactions |
| Simulation | Custom binary in token-y/token-r | 10,000-agent adversarial testing |
| Testnet | Manual + scripts | Real Autonomi network validation |

## File Naming Conventions

- Module files: `snake_case.rs`
- Type names: `PascalCase`
- Functions/methods: `snake_case`
- Constants: `SCREAMING_SNAKE_CASE`
- Crate names: `dsn-{name}` (kebab-case in Cargo, `dsn_{name}` in Rust code)
