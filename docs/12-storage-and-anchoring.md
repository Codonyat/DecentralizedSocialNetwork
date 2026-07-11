# Storage & Anchoring — First-Principles Revision

> **Design canon:** this document revises the storage and timestamping design.
> Where older phrasing conflicts (docs 00, 02, 07 references to Autonomi or
> IPFS as the storage foundation), this document governs, the same way docs
> 09–11 govern the economy.

## 1. Decisions

1. **No storage network in the protocol.** Autonomi/IPFS are dropped as
   foundations. The protocol specifies a *data format* (signed,
   content-addressed objects) and stays silent on transport. Any storage
   network may be used by an operator as a backend; none is normative.
2. **Indexers store what they serve.** There is one edge role: the staked
   indexer of doc 07/11. Publishing a post means uploading it to one or more
   indexers. An indexer must be able to return anything it has attested to —
   same stake, same signed claims, same fraud proofs as doc 11.
3. **Clients keep their own data.** A client retains a full local copy of
   everything its user has signed (posts, profile, follow list). Losing an
   indexer is an availability blip, never data loss. This rule is normative.
4. **Timestamps come from the chain, not from signatures.** Indexers
   periodically anchor a Merkle root of all newly indexed content on-chain.
   A Merkle branch to an anchored root proves a post existed before that
   block ("created before T"). A post may optionally embed a recent block
   hash to prove "created after T".

Everything else in this document is justification and mechanics for those
four sentences.

## 2. Why no storage network

The protocol needs exactly two properties from storage:

- **Integrity** — you get the bytes you asked for. This is a property of the
  data format, not the transport: a post's address is the BLAKE3 hash of its
  bytes, and its author's signature is inside it. It holds identically over
  any network, disk, or CDN. It is already fully specified in docs 01–02.
- **Availability** — someone will serve the bytes. No storage network
  actually enforces this: IPFS pinning is voluntary, and "pay once, store
  forever" is an economic bet, not a cryptographic guarantee. Availability
  is an economic problem, and this design already has an economic
  accountability layer (doc 11). We use it.

Choosing a storage network would therefore buy a dependency without buying a
guarantee. Nostr, AT Protocol, and Farcaster each reached the same
conclusion independently: signed, self-authenticating data; storage as an
ordinary service obligation.

What Filecoin-class systems solve — provable unique replicas of arbitrary
private cold data for strangers — is a different and much harder problem
that this network does not have: our data is public, small, hot, and
self-verifying, so any copy is as good as any other and ordinary reads
exercise availability continuously.

### What we consciously give up

Content persists **while someone cares** — the author (local copy), an
indexer that serves it, or any third party that mirrors it (mirroring is
trustless because data is self-authenticating). There is no
permanence-by-construction for content nobody wants. This is the honest
guarantee; docs should say "replicability", not "permanence". If endowed
permanent archiving is ever wanted, it is one more staked service under the
doc 11 ServiceRegistry pattern (pay once, possession challenges, slashing)
and requires no protocol change — explicitly out of scope now.

## 3. The edge: indexers store and serve

One role, already specified in docs 07 and 11. The refinements:

### Publish path

```
client signs post → uploads to ≥1 indexers → keeps local copy
```

An indexer accepts the post if the signature verifies and the sequence
number advances (doc 01 validation rules). There is no separate "host"
role: the indexer a user publishes to is simply the first indexer to index
the post.

### Read path

Unchanged from doc 07: clients query any indexer; every response is a
signed claim; spot-checks escalate to fraud proofs.

### Full text replication

The complete text corpus of a social network is small (a few hundred GB at
very large scale). Registered indexers replicate **all** post/profile/graph
text, obtained by syncing from peers and from client uploads. Consequences:

- "Can this indexer return the data?" is trivially yes for text.
- Omission becomes maximally detectable: any peer indexer can produce the
  missing item plus its anchor proof (§4) and submit fraud proof F3.
- No routing, no DHT, no placement problem. Sync is "give me everything
  after root R", verified item-by-item since all items are signed.

### Media

Media blobs (images/video) are stored by indexers **at their discretion and
price** — storage rent, paid in Y, is the endorsed fee sink (doc 09 §5).
The only protocol-level rule is the existing one: serving bytes whose hash
does not match the requested address is slashable (doc 11 §5). A post
references media by content address; a media blob with no paying owner and
no interested indexer may die. Same honest guarantee as §2.

### Sole-indexer failure

If every indexer holding a user's content drops it (bankruptcy or
deplatforming), the user still holds signed originals locally and republishes
to any willing indexer — including one they run themselves; the protocol is
permissionless. Nothing is lost, and prior anchors (§4) still prove the
original timestamps.

## 4. Anchoring: proving *when*, not just *who*

A signature proves authorship, never time — a post claiming to be from 2020
could have been signed today. Fix, in two independent halves:

### Created-before-T (the anchor)

Each anchoring interval (e.g. hourly), a registered indexer computes the
Merkle root (dsn-core `merkle_root`) of all content addresses it newly
indexed, and calls a minimal on-chain function:

```solidity
// AnchorLog — event-only, no storage writes beyond the log
function anchor(bytes32 root) external;   // emits Anchored(indexer, root, block)
```

Proof of existence for post P = the Merkle branch from `P.address` to an
anchored root. The block timestamp of the anchor transaction is the bound.
Properties:

- **Free for users.** One transaction per indexer per interval, regardless
  of post volume. Posting stays free (doc 10 §1.2 — no cost on existence).
- **Anchor duty.** Anchoring every interval is a registered-indexer duty
  (doc 11 duties list). Indexers store the branches and serve them via the
  spot-check API (`GET /spotcheck/anchor/:post_address`).
- **Redundant witnesses.** N indexers anchor independently; any one honest
  anchor suffices, and anyone may anchor permissionlessly (a user can anchor
  a single post hash directly for high-stakes content).
- **Precision = cadence.** Timestamps are provable to the anchoring
  interval. Sufficient for a social network.

Note tips already anchor implicitly — an on-chain tip's `post_ref` memo
proves the post pre-dates the tip's block. §4 extends that guarantee from
"posts someone paid attention to" to everything.

### Created-after-T (optional freshness)

A post MAY set an optional field `freshness_anchor: Option<[u8; 32]>` — a
recent chain block hash, included under the signature. The author could not
have known it earlier, so the post provably post-dates that block. Combined
with the anchor above, creation time is bracketed. Optional because most
posts don't need it; clients expose it for content where priority matters.

### New chain surface (delta to docs 00/01/03)

- Contract #9: **AnchorLog** — `anchor(bytes32)`, event-only.
- `ChainEvent::Anchored { indexer: PublicKey, root: [u8; 32] }`.
- `ChainClient::post_anchor(root)` and anchor-event queries.
- `Post.freshness_anchor: Option<[u8; 32]>` in dsn-core (signed field).
- Indexer duty + F-series addition: an indexer that attests an anchor proof
  that does not verify is slashable under the existing F1 shape.

## 5. Impact on the workspace

| Piece | Change |
|---|---|
| `dsn-core` | Add `freshness_anchor` to `Post`; keys no longer need BLS-for-Autonomi — key scheme may align with the target chain (secp256k1/Ed25519); revisit in doc 01 before implementation |
| `dsn-data` | Traits stay (they describe what an indexer's storage must do); `autonomi.rs` and the Scratchpad key-derivation section are dropped; `MutableStore` semantics simplify to "latest owner-signed version, highest counter wins" |
| `dsn-chain` | Add `post_anchor` + `Anchored` event |
| `dsn-indexer` | Add anchor duty (interval Merkle root + branch storage), `spotcheck/anchor` route, peer text-sync |
| Docs 00/02/07 | Read "off-chain (IPFS/Autonomi)" as "off-chain (indexer-served, doc 12)" |

## 6. What was considered and rejected

- **Autonomi / IPFS as foundation** — dependency without guarantee (§2).
- **Per-post on-chain hashes** — violates free posting, scales badly;
  batched roots give the same proof for ~zero marginal cost (§4).
- **Separate Host / Archive / Gateway roles** — premature decomposition.
  One staked role (indexer) with full text replication covers launch; any
  future specialization (endowed archives, dedicated media gateways) is
  just another registrant under the same ServiceRegistry pattern and needs
  no protocol change now.
