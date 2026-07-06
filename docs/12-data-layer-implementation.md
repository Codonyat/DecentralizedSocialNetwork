# Data Layer Implementation Study: Autonomi, IPFS, and What Actually Works

Research date: **July 2026**. This doc evaluates concrete backends for the
`dsn-data` traits (doc 02: `ContentStore` immutable chunks, `MutableStore`
versioned key-addressed records, `GraphStore` signed edges), against three
bodies of evidence: the current state of Autonomi (the spec's assumed
backend), the current state of the alternatives, and how production
decentralized social networks actually store data. Sources are linked inline;
all figures are dated.

**Headline conclusions:**

1. **Autonomi is not production-ready as the sole backend.** The network the
   spec assumed no longer exists in its launched form: v1.0 (Feb 2025) was
   sunset in March 2026 and replaced by a rebuilt, post-quantum v2.0 in
   April 2026, with no confirmed data migration — "pay once, store forever"
   has already failed once. Its primitives still fit our traits almost
   one-to-one, so it stays as a feature-gated adapter, not the foundation.
2. **No successful decentralized social network uses a general-purpose
   storage network as its primary content store.** All survivors converged
   on protocol-specific replicated service nodes + explicit rent/pruning,
   with media on hash-addressed HTTP servers. The one project that tried
   (Lens on IPFS/Arweave) retreated to a self-run cluster.
3. **Therefore: promote our own staked service layer (doc 11) to be the
   primary content store** — a "storage node" role with Y-denominated
   storage rent (doc 10 already reserves this fee, rebate-ineligible),
   Blossom-style media servers (doc 11 §3.8 already anticipated media
   gateways), and an optional Arweave cold-archive tier for permanence.
   General-purpose networks (Autonomi 2.0, Walrus) remain adapters behind
   the trait abstraction, adoptable if they mature.

---

## 1. Autonomi: state as of July 2026

Mainnet 1.0 launched 11 Feb 2025 after 19 years of development. What happened
next is the load-bearing fact:

- Nov 2025: official claims of ~3.37M nodes / 103 PB — inflated by
  token-emission farming (many virtual nodes per operator).
- 20 Jan 2026: node emissions paused → node count collapsed to **under
  8,000** by Feb 2026, triggering replication storms
  ([forum](https://forum.autonomi.community/t/node-count-how-low-is-too-low/42777)).
- ~5 Mar 2026: **v1.0 officially sunset**
  ([forum](https://forum.autonomi.community/t/update-from-bux-march-5-2026/42825)).
- 7 Apr 2026: **Autonomi 2.0 launched** — a rebuilt network with full
  post-quantum crypto (ML-DSA-65 signatures, ML-KEM-768; no classical
  fallback) and enforced geographic diversity
  ([announcement](https://forum.autonomi.community/t/autonomi-2-0-is-live-autonomi/42882)).
  No evidence found that 1.0 data auto-migrated; the PQC change breaks
  1.0's BLS-signed types.
- Jul 2026: 2.0 reported "fast and stable" (~1 GB/min downloads), nodes
  filling, upload prices rising
  ([weekly update](https://forum.autonomi.community/t/weekly-update-july-2-2026/42936)).
  Node counts not published.

**Primitives** (still a near-perfect fit for doc 02's traits): Chunk
(immutable, ≤4 MB, pay-once), Pointer (mutable 32-byte target, free updates,
monotonic counter), Scratchpad (mutable ≤4 MB, free updates, versioned, no
history), GraphEntry (immutable signed DAG entry). Registers deprecated as a
native type.

**Costs** (Feb 2026 figures): ANT storage ~\$0.0001/GB — but **Arbitrum gas
dominates at ~\$0.20/GB (~\$0.0008/chunk)**, and a 1 KB post costs the same
gas as a 4 MB chunk
([pricing thread](https://forum.autonomi.community/t/thoughts-on-current-ant-upload-pricing-and-long-term-sustainability/42785)).
Mutations are free after creation. Paymasters (app-sponsored gasless uploads)
were planned, unconfirmed shipped.

**Performance**: pre-2.0, mutable-record operations took ~1 minute (10 min
for multi-step), with a known quorum bug returning stale/no data when only
one node held the latest version
([forum](https://forum.autonomi.community/t/why-is-the-network-so-slow/42710)).
Post-2.0 reports are much better, but **no one reports sub-second mutable
reads** — feed-speed UX requires a caching/indexer layer regardless.

**SDK**: Rust crate `autonomi` 0.10.2 (Feb 2026), ~29k downloads, 0.x with
frequent breaking changes; development moved orgs (maidsafe → WithAutonomi)
and the SDK is being renamed (Ant-SDK). Python bindings lag.

**Risk list for us**: (1) network continuity — the "permanent" network was
sunset 13 months after launch; (2) node economics unproven now that
emissions are paused; (3) mutable-data consistency is weakest exactly where
our `MutableStore` needs it; (4) permanence-without-deletion is a legal
liability (doc 09 §2.5); (5) per-chunk L2 gas makes micro-posts costly
without paymasters. Also spec-relevant: **2.0's move to ML-DSA-65 breaks our
docs 01/02 assumption that identity keys are BLS-because-Autonomi** — see
§5, action A5.

## 2. Alternatives: state as of July 2026

| Candidate | Cost / 4KB write | Mutable records | Read latency | Permanence | Rust SDK | Maturity (1–5) | Biggest risk |
|---|---|---|---|---|---|---|---|
| **IPFS + pinning / IPNS** | ~\$0 marginal (GB-month rent) | IPNS: **median ~11 s resolution** ([ProbeLab](https://www.probelab.network/blog/ipns-performance-amino-dht)) — unusable | fast if pinned + gateway | rent (pin) | no first-class Rust node | 4 | mutable layer forces re-centralization on own gateways |
| **Arweave + bundler** | free <100 KiB via Irys-style bundlers; else ~\$0.00001–0.00003 (\$2–8/GB one-time) | none native; ArNS/tag patterns are gateway-trusted | good via ar.io gateways | **pay-once forever** (endowment) | weak (JS-first) | 4 | endowment economics; bundler churn (Irys pivoted to own L1, Nov 2025) |
| **Walrus (Sui)** | near-zero via Quilt batching (~420× cheaper for 10 KB blobs, [Quilt](https://www.walrus.xyz/blog/introducing-quilt)); raw tiny blobs punitive | **yes** — Sui objects as versioned pointers, cheap updates | sub-second via aggregators | **rent**, ≤53 epochs (~2 y), renewable | best-in-class (Rust node; community crates) | 3.5 | Mysten-dominated; renewal automation for billions of blobs; couples us to Sui |
| **Swarm** | prepaid stamps; small-chunk bucket waste | **yes** — native feeds | seconds | rent (stamp top-ups) | none | 2.5 | shrinking network (~5k staking nodes, declining) |
| **Codex/Logos Storage** | n/a | no | n/a | testnet only | no (Nim) | 1 | missed 2025 mainnet; renamed/rearchitecting |
| **Shelby (Aptos/Jump)** | TBD | planned | designed for hot reads | TBD | TBD | 1.5 | not in production yet (2026 target); watch |

Notable: **Walrus + Sui pointers is the only shipped system** that matches
both our immutable-batch and cheap-mutable requirements with Rust-first code
— at the price of rent-based permanence and a hard dependency on Sui.
**Arweave is the only credible permanence layer**, and at tweet size it is
effectively free through bundlers.

## 3. What production networks actually do (the decisive evidence)

| Network | Content store | Blob/media store | Permanence model | Scale reality (2026) |
|---|---|---|---|---|
| **Farcaster** | Snapchain — Rust BFT chain, 11 validators, ~200 GB state ([repo](https://github.com/farcasterxyz/snapchain)) | client-chosen centralized CDNs (protocol stores URLs only) | **rent**: ~\$7/unit/yr; oldest messages pruned on overflow | ~40–60k DAU, declining; ~2 main node operators; acquired by Neynar Jan 2026 |
| **Bluesky** | PDS signed repos (MST/CAR); **99.99% of users on Bluesky PBC infra** | PDS ≤1 MB images + app CDNs; video via central CDN | host-dependent; no protocol permanence | 27.5M MAU; relays now cheap (**full-network relay on a \$34/mo VPS** after Sync v1.1, [ref](https://whtwnd.com/bnewbold.net/3lo7a2a4qxg2l)) but hosting never decentralized |
| **Nostr** | ~950 volunteer relays; outbox model | **Blossom**: sha256-addressed HTTP mediaservers, user-mirrorable ([spec](https://github.com/hzrd149/blossom)) | none — relays prune freely; paid relays sell retention | works, but ~1/3 of relays died and **~95% can't cover costs** |
| **Lens v3** | Lens Chain + **Grove: a private IPFS cluster run by Lens Labs** | Grove | mutable/deletable, custodial | niche; stewardship handed to Mask Network Jan 2026 |

Three lessons, each directly applicable:

1. **The winning shape is protocol-specific service nodes, not general-
   purpose storage.** Our doc 11 ServiceRegistry — staked, slashable,
   fee-earning nodes — is already that shape. The implementation move is to
   let that layer *carry* the content, not merely index it.
2. **Unpriced storage kills operators; priced storage works.** Nostr's
   volunteer relays run at a loss and die; Farcaster's ~\$7/yr rent held up
   technically. Doc 10 §1.2 already reserves **storage rent** as a fee sink
   (rebate-ineligible, doc 03 §E) — this study confirms it must be a live
   mechanism, not a placeholder.
3. **Everyone punts on media; the honest version is Blossom.** Hash-
   addressed blobs on plain HTTP servers, user-driven mirroring, paid
   hosting. Doc 11 §3.8 already anticipated "media gateways" as a staked
   role; adopt the Blossom pattern for it rather than promising decentralized
   permanence we would quietly centralize later.

## 4. Recommended architecture

Keep the doc 02 trait abstraction exactly as designed (it is what makes this
whole question reversible). Implement the backends in this order:

### Tier 1 — DSN storage nodes (primary, interactive)

Extend the staked service layer (doc 11) with a **storage node** role:

- Stores and replicates all signed protocol objects (posts ≤4 KB, profiles,
  follow lists, feed indices, graph entries). Text at social scale is small:
  1M posts/day ≈ ~1 GB/day network-wide — trivial for a few dozen nodes.
- **Replication**: signed objects gossip/sync between registered storage
  nodes; learn from Snapchain and Jetstream — an ordered, filterable event
  stream makes replication and backfill cheap (\$34/mo relay economics, not
  2 TB-mirror economics).
- **Payment**: storage rent in Y per account quota (Farcaster-style units,
  deterministic pruning of oldest-over-quota), flowing through the standard
  fee split (10% referral / 90% burn). Rent is rebate-ineligible (doc 03 §E)
  precisely so nobody mines spam storage. New users get a small free quota
  (bundled with the invitation, like the starter tip — doc 10 §3.5).
- **Honesty**: same stake/fraud-proof machinery as indexers (doc 11 §3.3);
  possession challenges (F-archive of doc 11 §3.8) make "I store what I
  charge rent for" provable.
- Indexers (doc 07) crawl these nodes instead of a global DHT; an indexer
  and a storage node will often be the same operator wearing two registry
  roles.

### Tier 2 — media servers (Blossom pattern)

sha256-addressed blobs over plain HTTP; staked media-gateway role (doc 11
§3.8: fraud = serving bytes whose hash ≠ address); users/clients choose and
mirror across ≥1 servers; paid in Y (rent or per-GB). Protocol objects
reference media by hash + server hints, never by bare URL — so a dead server
is a re-hosting problem, not a broken-content problem.

### Tier 3 — cold permanence archive (Arweave via bundler)

A background archiver role writes the compact signed-object stream to
Arweave (tweet-sized objects are free-to-negligible via bundlers; a year of
1M-posts/day text is ~365 GB ≈ \$700–3,000 one-time at 2026 prices). This
restores the censorship-resistance story the rent model gives up: even if
every storage node prunes or dies, the signed history exists somewhere
nobody can edit, and anyone can re-seed Tier 1 from it. Fund it from the
treasury initially; later, an on-chain "archive bounty" fee anyone can pay.

### Adapters — Autonomi 2.0 and Walrus (feature-gated, non-blocking)

- Keep `autonomi.rs` (doc 02) as an experimental `ContentStorage` backend;
  re-evaluate after 2.0 has 6–12 months of stability, published node counts,
  and a shipped paymaster story.
- Add a `walrus.rs` prototype (Quilt for post batches, Sui objects for
  mutable pointers) — the strongest external candidate on primitives-fit and
  the only Rust-native one.
- Trigger to reconsider promotion: an external network beats Tier 1 on cost
  AND read latency AND has survived >18 months without a reset.

### What this changes in the trust story

Doc 06's premise "data on Autonomi is permanent and uncensorable" weakens
to something more honest and, for the illegal-content problem, actually
better: **existence = signed objects replicated across N staked,
economically motivated nodes, plus an append-only public archive**.
Censorship of a live user requires suppressing every storage node AND the
archive AND permissionless re-hosting (data is signed and portable — anyone
can stand up a storage node from the archive). Meanwhile rent + pruning +
per-node blocklists give storage operators the legal compliance tools that
pure permanence denies them (doc 09 §2.5) — Tier 3 archivers, not every
node, carry the hard-permanence tradeoff, and they can apply hash blocklists
(e.g. CSAM lists) at ingest.

## 5. Actions on the existing spec

- **A1 (doc 02)**: replace "IPFS/Autonomi" framing with the three-tier
  design; `ContentStorage` gains a DSN-storage-node backend as the primary
  implementation; Autonomi/Walrus become feature-gated adapters. Traits
  unchanged.
- **A2 (docs 10/11)**: storage rent graduates from "future fee" to a
  specified mechanism: quota units, pricing function, pruning rule, free
  starter quota; new ServiceRegistry roles (storage node, media server,
  archiver) as versioned contracts per doc 11 §3.8.
- **A3 (doc 06)**: soften "Autonomi stores everything permanently" to the
  §4 trust story (staked replication + archive); moderation machinery is
  unaffected.
- **A4 (doc 07)**: crawler reads from registered storage nodes' event
  streams instead of DHT scratchpad polling — strictly simpler.
- **A5 (docs 01/02)**: make the signature scheme a versioned parameter of
  identity rather than hard-coded BLS. Autonomi 2.0's PQC break (BLS →
  ML-DSA-65) is a live demonstration of why; our IdentityRegistry rotation
  mechanism (doc 01) is also the natural migration path to PQ signatures
  later.
- **A6 (doc 09 §8.2 chain choice, unchanged but sharpened)**: none of this
  affects the L2 contract suite; it does add a reason to prefer an L2 with
  cheap calldata, since storage-rent payments are frequent small
  transactions.

## 6. Bottom line

Build the boring thing the evidence supports: **our own staked, rent-paid,
slashable storage/media nodes as the hot layer** (the shape every surviving
network converged on — but permissionless and priced, fixing Nostr's
economics and Farcaster's 11-validator consortium), **Arweave as the cheap
permanent cold layer**, and the trait abstraction keeping Autonomi 2.0 and
Walrus one adapter away if either earns it. Nothing in the token design
(doc 10) changes; storage rent and the media/archiver roles were already
reserved in it — this study fills them in with evidence.
