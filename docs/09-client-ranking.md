# Client-Side Ranking (Local Feed Algorithm)

## Purpose

Feed ranking is the one function of a social network that needs **no consensus**: a feed is consumed by exactly one person, so nobody else ever needs to verify it. That observation dissolves the "AI can't be decentralized" problem — ranking doesn't need decentralized *compute*, it needs user-*owned* compute. The ranking model runs on the user's device, is fine-tuned on behavior that never leaves the device, and is swappable like a file.

The one-sentence differentiator: **your algorithm lives on your device, not on our servers.**

## Architecture Split

Twitter-style architecture (candidate sources → heavy ranker) cut along decentralization boundaries instead of datacenter boundaries:

| Stage | Where | Trust requirement |
|---|---|---|
| Money (donations, rent, emission) | On-chain | Consensus |
| Candidate generation (recall) | Indexers | Verifiable, market-paid (07-indexer.md) |
| Ranking (precision) | User's device | None — user-owned |

- **Indexers stay dumb.** They serve bulk, un-ranked candidate sets with economic metadata (`GET /api/v1/candidates/:user_pk`, see 07-indexer.md). Cheap, commodity, verifiable. An indexer that omits candidates is detectable by cross-querying, same as feed completeness.
- **The client ranks.** A local model orders the candidates using features from the metadata plus the user's private interaction history.
- **Server-side ranked feeds remain** as the thin-client path (07-indexer.md, Feed Builder) for devices that can't run a model.

## The Local Model

### Starter model

Ranking quality does not require a large model to beat chronological. The reference client ships a small feature-based scorer over, per candidate:

- recency (exponential decay)
- source (follows / lineage / donated / mentions)
- economic signals: `total_donated`, `unique_donors` (log-scaled)
- label signals: counts of labels on the candidate, weighted by which labelers
  the user's filter trusts (visibility filtering is client-side for the same
  no-consensus reason ranking is — see 06-moderation.md)
- relationship signals: author followed? previously donated to? lineage hops
- thread signals: replies from accounts the user has donated to (donor prominence as a *feature*, not a rule — the local ranker is free to ignore it)
- local history: the user's past dwell/reply/donation pattern per author and topic

### Upgrade path

A small quantized transformer (3–8B class runs on 2026 phones and laptops) replaces the linear scorer where hardware allows, fine-tuned on-device with the same interaction log. Model tiers are a client capability, not a protocol concern.

### The interaction log

The client records dwell time, opens, replies, donations, follows, mutes — locally only. This log is the training signal and **never leaves the device**. Privacy here is an architecture fact, not a policy promise: there is no server that ever sees behavior.

## Swappable Rankers

A ranker is **weights + a declared feature schema**, executed by the client's fixed runtime — never arbitrary code. Consequences:

- Anyone can publish a ranker ("slow feed", "no engagement bait", "art only", "maximize lineage diversity"); users install it like a file. This is the algorithm marketplace, with none of the server-side trust that Bluesky feed generators require — a ranker cannot exfiltrate data or phone home, because it has no I/O; the runtime feeds it candidates and it returns scores.
- Ranker manifests declare which features they read, so a client can display "this algorithm considers: recency, donations, your history" truthfully.
- The default ranker is open-weights and reproducible; its training recipe is published.

## Cold Start

A new account has no follows and no interaction log. The bootstrap feed comes from the **invitation tree**: the `lineage` candidate source serves the inviter's neighborhood, decaying by lineage distance. Your first feed is, roughly, "what the person who invited you sees" — which mirrors how people actually join social networks. Stated trade-off: this seeds an echo chamber by construction and the tree is public (it mirrors real-world social circles — a deanonymization surface users should be told about); the `donated` source provides the counterweight of network-wide discovery from day one.

## Non-Goals

- **No consensus on ranking.** Nothing here touches the chain or the protocol; this document describes the reference client and the indexer's candidate surface only.
- **No server-side personalization.** An indexer that offers "smart feeds" is a thin-client convenience, not the architecture. A single server-side algorithm is precisely the centralization this design exists to avoid — decentralizing the *algorithm* (pluralism + local execution) matters more than decentralizing its compute.
- **No zkML / verifiable inference.** Wrong tool: verification is only needed where others must trust the result, and nobody but the user consumes their own feed.

## Crate Mapping

Client-side ranking lives in `dsn-cli` (and future GUI clients): a `ranker` module holding the runtime, the default weights, the interaction log store, and the candidate-fetch client for `GET /api/v1/candidates/:user_pk`. The indexer's only involvement is the candidates endpoint (dsn-indexer, 07-indexer.md).
