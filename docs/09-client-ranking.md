# Client-Side Ranking (Local Feed Algorithm)

## Purpose

Feed ranking is the one function of a social network that needs **no consensus**: a feed is consumed by exactly one person, so nobody else ever needs to verify it. That observation dissolves the "AI can't be decentralized" problem — ranking doesn't need decentralized *compute*, it needs user-*owned* compute. The ranking model runs on the user's device, is fine-tuned on behavior that never leaves the device, and is swappable like a file.

The one-sentence differentiator: **your algorithm lives on your device, not on our servers.**

There is no network-wide algorithm. What replaces it is three layers:

| Layer | What it is | Who runs it |
|---|---|---|
| Signals | Every follow, repost, quote, like and tip is a public signed object or on-chain record | Nobody — a commons |
| Recall | Which posts can reach the viewer: a **conserved attention budget** flowing along edges the viewer authorized, plus a labelled exploration slot; every item carries a verifiable why-path | Competing indexers, verifiable by recomputation |
| Ranking | Which of those the viewer sees first, from public features plus private local history | The viewer's device |

Design evidence (non-normative): docs/proposals/2026-09-29-pillars-review.md §1, §5 P4, §6a, §6b.

## Architecture Split

Twitter-style architecture (candidate sources → heavy ranker) cut along decentralization boundaries instead of datacenter boundaries:

| Stage | Where | Trust requirement |
|---|---|---|
| Money (like-power settlement, tips, rent, snapshot claims) | On-chain | Consensus |
| Recall (attention budget, exploration) | Indexers | Verifiable — why-paths and shares recompute from signed objects (07-indexer.md) |
| Ranking (precision) | User's device | None — user-owned |

- **Indexers stay dumb.** They serve bulk, un-ranked candidate sets carrying budget metadata (`GET /api/v1/candidates/:user_pk?sources=budget`, see 07-indexer.md) and topic exploration sets (`GET /api/v1/explore?topic=`). Cheap, commodity, verifiable. An indexer that omits candidates is detectable by cross-querying, same as feed completeness; one that forges a path fails recomputation.
- **The client ranks.** A local model orders the candidates using features from the metadata plus the user's private interaction history.
- **Server-side ranked feeds remain** as the thin-client path (07-indexer.md, Feed Builder: `FeedRanking::{Chronological, Budget}`) for devices that can't run a model.
- **Reach is never bought.** Money and recall are separate layers. Deposits, like power, balances and tip sizes never enter the budget; a like or tip is a ranking feature, never a recall edge. A whale's like pays the creator (03-token-y.md §B) and reaches only viewers whose budget graph already contains the whale (they follow it, or one of their sources does), where it counts once like anyone else's. Recommenders are not paid: a like pays the author, and reposting earns nothing.
- **Mentions** feed the notifications view (`sources=mentions`), never the feed budget.

## Attention Budget

This section is the canonical home of the budget algorithm; `budget.rs` in dsn-indexer (07-indexer.md) implements it and the client recomputes it. The numbers are **reference-client defaults, not protocol**: a client may choose others, but every choice keeps the conservation invariant.

### Algorithm

1. **Sources.** The viewer's sources are the accounts in the viewer's signed `FollowList` (01-core-types.md), default equal weights. The viewer may reweight locally; a path's share is linear in its hop-1 source's weight, so the client rescales indexer-supplied shares per source and weights never leave the device.
2. **Split.** `FEED_BUDGET` (80% of each page) is split across sources by weight: `share(s) = FEED_BUDGET × w_s / Σw`.
3. **Hop 1.** Source `s` keeps `OWN_ITEMS_SHARE` of `share(s)` for its own posts, reposts and quotes (path `[viewer, s]`) and passes the rest equally along the edges of its follow list: `(1 − OWN_ITEMS_SHARE) × share(s) / |follows(s)|` per edge. An edge to the viewer or back up the path (to `s` itself) carries nothing; that share stays with `s`. A source that follows no one keeps its whole share.
4. **Hop 2.** Each account `a` that `s` follows gets path `[viewer, s, a]` and keeps all it receives for its own items. `MAX_BUDGET_HOPS = 2`: nothing passes further, so cycles stop. An account on several paths (hop 1 and hop 2, or hop 2 via two sources) holds each path separately.
5. **Renormalize.** Paths whose last account has no items in the window are dropped; the remaining shares scale by `FEED_BUDGET / Σ remaining`. With no non-empty path (a new account), the whole page is exploration.
6. **Items.** A path's share is spent on its last account's posts, reposts and quotes. An item reachable by several paths appears once, charged to and labelled with its largest-share path.

**Invariant — conservation.** Every step divides a share into parts that sum to it, so path shares always sum to `FEED_BUDGET`, and splitting never increases a share: an account receives at most what the account passing to it received, and adding an out-edge only divides that pass further.

```rust
// Reference-client defaults (not protocol). dsn-indexer `budget.rs` (07) implements;
// the client recomputes with the same function.
pub const FEED_BUDGET: f64 = 0.80;      // of each page, split across the viewer's sources
pub const EXPLORE_BUDGET: f64 = 0.20;   // labelled exploration slot
pub const OWN_ITEMS_SHARE: f64 = 0.50;  // a hop-1 source's share kept for its own items
pub const MAX_BUDGET_HOPS: usize = 2;

pub enum Via { Post, Repost, Quote }

pub struct WhyPath {
    pub hops: Vec<IdentityId>,  // [viewer, source] or [viewer, source, hop-2 account]
    pub via: Via,               // the item's relation to hops.last()
}

pub struct PathBudget {
    pub hops: Vec<IdentityId>,  // as WhyPath::hops
    pub share: f64,             // fraction of the page
}

/// Pure, no I/O. `sources`: the viewer's follows with local weights (default 1.0).
/// `follows(a)`: a's signed FollowList. `has_items(a)`: a has posts/reposts/quotes in the window.
/// Returns every non-empty path; Σ share == FEED_BUDGET, or empty if no path has items.
pub fn attention_budget(
    viewer: &IdentityId,
    sources: &[(IdentityId, f64)],
    follows: &dyn Fn(&IdentityId) -> Vec<IdentityId>,
    has_items: &dyn Fn(&IdentityId) -> bool,
) -> Vec<PathBudget>;
```

### Why-paths

Every budget item carries `why_path {hops: [viewer, source, (hop-2 account)], via: post|repost|quote}` beside its `budget_share`. The client renders it as the hop names followed by `via`: "via you → Alice → repost", "via you → Alice → Bob → quote".

Verification needs no trust in the indexer — the client recomputes from public signed objects:
- `hops[0]` is the viewer; `2 ≤ hops.len() ≤ MAX_BUDGET_HOPS + 1`; no account repeats.
- Each `hops[i+1]` is in the current signed `FollowList` of `hops[i]`.
- The item is signed by `hops.last()`, and `via` matches it: no `repost_of` → post; `repost_of` with empty content → repost; with content → quote (01-core-types.md).
- `budget_share` equals `attention_budget` over the same follow lists (within float tolerance).

A failed check drops the item and flags the indexer, handled like an omission: cross-query another indexer. A stale follow list resolves by fetching its newest signed version (02-data-layer.md). The client may verify every item or a random sample.

### Sybil bound and honest limits

- **Bound.** Creating accounts cannot raise anyone's share. A new account receives budget only when an account already on the viewer's path follows it, and then only by splitting a share that account already held. A thousand accounts that nobody on the path follows receive nothing.
- **Limit: outsiders only.** Trusted accounts — the viewer's sources and the accounts they follow — can collude (follow each other's sock puppets, repost rings) or sell endorsements (a paid repost or follow). The budget routes their share as they direct, and the same accounts inflate the viewer-relative features: puppets a source follows sit inside the budget graph, so each adds one to `graph_likes` / `graph_tippers`. Why-paths make every such route visible, and reweighting or unfollowing is local; nothing in the protocol detects it.
- **Limit: cold-start influence.** The default client chooses a new user's first sources and exploration providers, so it holds acknowledged influence. Portability limits it — the lists are published, editable, and another client can offer different ones — but does not remove it.

### Default feed composition

The default client fills each page so that `EXPLORE_BUDGET` of the slots are exploration and each path's slots are proportional to its share; fractional shares carry across pages (deficit round-robin), so a path worth 0.1 slot gets one slot every ten pages. The ranker picks which of a path's items fill its slots and orders the page. A ranker manifest declares `honors_budget`: whether it keeps this composition and only orders within it, or replaces composition (e.g. a strictly chronological ranker). The client displays the declaration.

### Exploration

`EXPLORE_BUDGET` (20%) comes from topic indexers the viewer chose, via `GET /api/v1/explore?topic=`. Exploration items carry no why-path; they are always labelled with provider and topic ("explore · art · indexer.example"). Competing topic indexers supply them, so no single provider decides what lies outside the viewer's graph. The default client's initial topics and providers are acknowledged influence, replaceable in settings. An exploration item enters the budget only when the viewer follows its author.

## The Local Model

### Starter model

Ranking quality does not require a large model to beat chronological. The reference client ships a small feature-based scorer over, per candidate:

- recency (exponential decay)
- path and budget share: `budget_share`, hop count, `via`, exploration or budget
- viewer-relative likes and tips: `graph_likes`, `graph_tippers` — distinct accounts inside the viewer's budget graph that liked or tipped the item, each counted once regardless of power spent or amount, log-scaled
- label signals: counts of labels on the candidate, weighted by which labelers
  the user's filter trusts (visibility filtering is client-side for the same
  no-consensus reason ranking is — see 06-moderation.md)
- relationship signals: author followed? previously liked or tipped by the viewer? hop count
- thread signals: replies from accounts the viewer tips (thread-local only: orders replies within a thread, never lifts a thread into recall; a *feature*, not a rule — the local ranker is free to ignore it)
- local history: the user's past dwell/reply/like/tip pattern per author and topic

**Excluded from the default feature set:**
- Global like or tip totals. A network-wide count would sell reach at the price of a like or tip; only viewer-relative, per-account-capped counts are features.
- Aura (05-invitation.md). It is a status score and never a ranking feature.
- Anything money-weighted: deposit, like power, balance, tip size. Money never buys reach. The one money-sized ordering anywhere is an indexer's thread-local supporter prominence (07, Supporter Recognition): presentation among the replies to one post, never recall or feed ranking.

### Upgrade path

A small quantized transformer (3–8B class runs on 2026 phones and laptops) replaces the linear scorer where hardware allows, fine-tuned on-device with the same interaction log. Model tiers are a client capability, not a protocol concern.

### The interaction log

The client records dwell time, opens, replies, likes, tips, follows, mutes — locally only. This log is the training signal and **never leaves the device**. Privacy here is an architecture fact, not a policy promise: there is no server that ever sees behavior.

## Swappable Rankers

A ranker is **weights + a declared feature schema**, executed by the client's fixed runtime — never arbitrary code. Consequences:

- Anyone can publish a ranker ("slow feed", "no engagement bait", "art only", "maximize source diversity"); users install it like a file. This is the algorithm marketplace, with none of the server-side trust that Bluesky feed generators require — a ranker cannot exfiltrate data or phone home, because it has no I/O; the runtime feeds it candidates and it returns scores.
- Ranker manifests declare which features they read and whether they honor budget shares, so a client can display "this algorithm considers: recency, likes from your graph, your history; keeps your budget" truthfully.
- The default ranker is open-weights and reproducible; its training recipe is published.

## Cold Start

A new account has no follows and no interaction log, so it has no budget paths. Three things fill the gap:

1. **The voucher is the offered first follow.** The account that vouched for the newcomer (05-invitation.md, Vouch) is suggested as the first source; following it is the newcomer's choice. The vouch is a public signed object, so the relationship it reveals is public too.
2. **Starter sources.** The default client offers a published, editable list of starter sources — acknowledged influence, portable, as above.
3. **Exploration.** Until a path has items, the whole page is exploration (Algorithm, step 5).

## Non-Goals

- **No consensus on ranking.** Nothing here touches the chain or the protocol; this document describes the reference client and the indexer's candidate surface only. The budget is a reference-client default, not a protocol rule.
- **No server-side personalization.** An indexer that offers "smart feeds" is a thin-client convenience, not the architecture. A single server-side algorithm is precisely the centralization this design exists to avoid — decentralizing the *algorithm* (pluralism + local execution) matters more than decentralizing its compute.
- **No paid reach.** No promoted slot, boost, or money-weighted recall.
- **No zkML / verifiable inference.** Wrong tool: verification is only needed where others must trust the result, and nobody but the user consumes their own feed. Why-paths are verified by recomputation, not proofs.

## Crate Mapping

Client-side ranking lives in `dsn-cli` (and future GUI clients): a `ranker` module holding the runtime, the default weights, budget recomputation and why-path verification (reusing dsn-indexer's `budget.rs`), the interaction log store, and the fetch client for `GET /api/v1/candidates/:user_pk?sources=budget` and `GET /api/v1/explore?topic=`. The indexer's involvement is the candidates and explore endpoints and `budget.rs` (dsn-indexer, 07-indexer.md).
