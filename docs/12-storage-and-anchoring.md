# Storage & Anchoring

> **Scope:** this document settles two questions the earlier docs left
> implicit or answered by naming a storage network: (1) where off-chain
> content actually lives, and (2) how a post's creation time can be proven
> rather than merely claimed. Earlier revisions of docs 00, 02, and 07
> referred to Autonomi or IPFS as the storage foundation; those references
> have since been removed from docs 00/02/07, and "the network" is the
> indexer layer.

## 1. Decisions

1. **No storage network in the protocol.** Autonomi/IPFS are dropped as
   foundations. The protocol specifies a *data format* (signed,
   content-addressed objects, docs 01–02) and stays silent on transport.
   An indexer may use any storage backend it likes; none is normative.
2. **Indexers store what they serve.** Publishing a post means uploading it
   to one or more indexers. Registered indexers replicate the full text
   corpus. There is no separate host, archive, or gateway role.
3. **Clients keep their own data.** A client retains a full local copy of
   everything its user has signed (posts, profile, follow list). Losing an
   indexer is an availability blip, never data loss. This rule is normative.
   (Voluntary removal is a separate, signed-object convention — retract
   tombstones — not data loss; see doc 02, Privacy & Data Lifecycle.)
4. **Timestamps come from the chain, not from signatures.** Indexers
   periodically anchor a Merkle root of newly indexed content on-chain, on
   the chosen L2 (see 00 Deployment Targets — decision deferred behind the
   ChainClient trait). A Merkle branch to an anchored root proves a post
   existed before that block; an optional embedded block hash proves it was
   created after one.

## 2. Why no storage network

The protocol needs exactly two properties from storage:

- **Integrity** — you get the bytes you asked for. This is a property of
  the data format, not the transport: a post's address is the hash of its
  bytes, and its author's signature is inside it. It holds identically over
  any network, disk, or CDN, and any client verifies it for free.
- **Availability** — someone will serve the bytes. No storage network
  actually enforces this: IPFS pinning is voluntary, and "pay once, store
  forever" is an economic bet, not a cryptographic guarantee.

Choosing a storage network therefore buys a dependency without buying a
guarantee. Availability is an economic problem, and the design already has
an economic answer: indexers are paid for query access in Y (doc 07,
Indexer Economics), which makes holding and serving the corpus their
business. Nostr, AT Protocol, and Farcaster each reached the same
conclusion independently: signed, self-authenticating data; storage as an
ordinary, paid service obligation at the edge.

What Filecoin-class systems solve — provable unique replicas of arbitrary
private cold data for strangers — is a different and much harder problem
that this network does not have: our data is public, small, hot, and
self-verifying, so any copy is as good as any other and ordinary reads
exercise availability continuously.

### What we consciously give up

Content persists **while someone cares** — the author (local copy), an
indexer that serves it, or any third party that mirrors it (mirroring is
trustless because data is self-authenticating). There is no
permanence-by-construction for content nobody wants. The docs should say
"replicability", not "permanence". If endowed permanent archiving is ever
wanted, it is an ordinary paid service any operator can offer (optionally
warehousing on Arweave/Filecoin as a backend) and requires no protocol
change — explicitly out of scope now.

## 3. The edge: indexers store and serve

One role — the indexer of doc 07, unchanged in its economics and trust
model (verifiable via spot-check; kept honest by competition and client
switching, not by staking — see doc 07's rejection of staking/slashing
machinery as disproportionate). The refinements:

### Publish path

```
client signs post → uploads to ≥1 indexers → keeps local copy
```

An indexer accepts the post if the signature verifies and the sequence
number advances (doc 01 validation rules). The indexer a user publishes to
is simply the first indexer to index the post — there is no distinct
"host" role.

### Read path

Unchanged from doc 07: clients query indexers, verify anything they care
about via the spot-check API or the chain, and switch indexers freely.

### Full text replication

The complete text corpus of a social network is small (a few hundred GB at
very large scale; Farcaster runs full replication on commodity hardware).
Registered indexers replicate **all** post/profile/graph text, obtained
from client uploads and by syncing from peer indexers. Consequences:

- "Can this indexer return the data?" is trivially yes for text.
- Omission becomes maximally detectable: any peer indexer can produce the
  missing item plus its anchor proof (§4), publicly demonstrating the
  omission — the cross-indexer verification doc 07 already relies on, with
  evidence attached.
- No routing, no DHT, no placement problem. Sync is "give me everything
  since root R", verified item-by-item since all items are signed.

### Media

Media blobs (images/video) are stored by indexers **at their discretion
and price** — media hosting fees are an indexer revenue line alongside
query access (doc 07, Indexer Economics). The protocol-level rule is
inherent to content addressing: bytes that don't hash to the requested
address are rejected by every honest client, so a lying media server is
caught on first fetch. A post references media by content address; a blob
with no paying owner and no interested indexer may die. Same honest
guarantee as §2.

### Sole-indexer failure

If every indexer holding a user's content drops it (bankruptcy or
deplatforming), the user still holds signed originals locally and
republishes to any willing indexer — including one they run themselves;
the protocol is permissionless. Nothing is lost, and prior anchors (§4)
still prove the original timestamps.

## 4. Anchoring: proving *when*, not just *who*

A signature proves authorship, never time — a post claiming to be from
2020 could have been signed yesterday. The post's `created_at` field is
explicitly informational (doc 01). Fix, in two independent halves:

### Created-before-T (the anchor)

Each anchoring interval (e.g. hourly), an indexer computes the Merkle root
(dsn-core `merkle_root`) of all content addresses it newly indexed, and
calls a minimal contract on the chosen L2 (see 00 Deployment Targets —
decision deferred behind the ChainClient trait):

```solidity
// AnchorLog — event-only, no storage writes beyond the log
function anchor(bytes32 root) external;   // emits Anchored(sender, root, block)
```

Proof of existence for post P = the Merkle branch from `P.address` to an
anchored root. The block timestamp of the anchor transaction is the bound.
Properties:

- **Free for users.** One transaction per indexer per interval, regardless
  of post volume — sub-cent on the chosen L2. Posting itself stays free.
- **Part of the indexer product.** Indexers anchor because provable
  timestamps make their index more valuable; clients and paying API
  consumers prefer indexers whose content is anchored. Anchoring is
  permissionless — anyone (including an author, for high-stakes content)
  can anchor any root directly.
- **Redundant witnesses.** N indexers anchor independently; any one honest
  anchor suffices, and anchors from indexers that later disappear remain
  valid forever.
- **Precision = cadence.** Timestamps are provable to the anchoring
  interval. Sufficient for a social network.

Indexers store the Merkle branches and serve them via the spot-check API
(`GET /api/v1/spotcheck/anchor/:post_address`). Note that on-chain economic
activity already anchors implicitly — a donation referencing a post hash
proves the post pre-dates that transaction's block. §4 extends
the guarantee from "posts someone paid attention to" to everything.

### Created-after-T (optional freshness)

A post MAY set an optional field `freshness_anchor: Option<[u8; 32]>` — a
recent block hash from the chosen L2, included under the signature. The
author could not have known that hash earlier, so the post provably
post-dates the block.
Combined with the anchor above, creation time is bracketed. Optional
because most posts don't need it; clients expose it where priority matters
(original work, predictions, disputes).

### New surface (delta to docs 00/01)

- Contract #7: **AnchorLog** — `anchor(bytes32)`, event-only (doc 00 list).
- `ChainEvent::Anchored { sender: PublicKey, root: [u8; 32] }`.
- `ChainClient::post_anchor(root)` and anchor-event queries.
- `Post.freshness_anchor: Option<[u8; 32]>` in dsn-core (signed field).
- Indexer: anchor loop (interval Merkle root + branch storage), the
  `spotcheck/anchor` route, and peer text-sync.
- Key-revocation timing (doc 01, Identity Registry): an object signed by a
  revoked key is valid only if it carries an anchor proof (or on-chain
  reference) predating the revocation transaction's block.

## 5. Impact on the workspace

| Piece | Change |
|---|---|
| `dsn-core` | Add `freshness_anchor` to `Post`; key scheme resolved: doc 01 now specifies ed25519 with versioned schemes via the IdentityRegistry |
| `dsn-data` | Traits stay (they describe what an indexer's storage backend must do); the indexer backend (`indexer.rs`) replaces the dropped storage-network backend and per-key derivation sections; `MutableStore` semantics simplify to "latest owner-signed version, highest counter wins" |
| `dsn-chain` | Add `post_anchor` + `Anchored` event |
| `dsn-indexer` | Anchor duty, `spotcheck/anchor` route, peer text-sync; ingest comes from client publishes and peer-to-peer sync (see 02, Storage Model — the relay pattern), not from a storage-network client |
| Docs 00/02/07 | No longer reference an external storage network; indexer-served storage and anchoring are described directly in each doc (this doc governs storage semantics) |

## 6. What was considered and rejected

- **Autonomi / IPFS as foundation** — dependency without guarantee (§2).
  Either may still serve as a private backend or optional mirror; neither
  is part of the protocol.
- **Per-post on-chain hashes** — costs per post and scales badly; batched
  roots give the same proof at ~zero marginal cost (§4).
- **Separate Host / Archive / Gateway roles** — premature decomposition.
  One role (indexer, full text replication) covers launch; any future
  specialization is just another service business and needs no protocol
  change.
- **Staking/slashing to enforce availability** — already rejected in doc
  07's Indexer Economics as disproportionate; anchoring plus full
  replication makes omission and backdating *detectable with evidence*,
  and competition does the enforcing. The archived parallel spec
  (docs/archive/11) documents the staking design should it ever be needed.
