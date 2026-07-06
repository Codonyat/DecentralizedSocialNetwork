# Service Registry & Staking: Making Indexer Honesty Enforceable

Builds on docs 07, 09, 10. Answers two questions precisely:

1. **Where must state live?** Everything that touches Y atomically must share
   one execution layer. Names, stakes, invites, and the Y ledger are one
   contract suite on one chain. Content never touches Y, so it stays
   off-chain.
2. **How does staking turn "verifiable indexer" into an enforced property
   rather than a promise?** Signed responses + fraud proofs + slashing.

---

## 1. The co-location rule

> **Any rule that consumes, locks, or pays Y must execute in the same place
> as the Y balance it touches.**

A name registration burns Y *and* writes the name in one atomic transaction.
If the name registry lived anywhere else (another chain, off-chain storage),
"paid" and "registered" would be separate events needing a bridge or oracle
to connect them — a trusted party inside the monetary constitution, which
doc 10 §2 forbids. Same logic for renewals (expiry must be checkable against
the same clock that accepted the burn), stakes (slash must seize the exact
escrow), rebates, and referral annuities (fee-split at burn time).

### 1.1 The on-chain contract suite (one execution layer)

| Contract | State it owns | Y interaction |
|---|---|---|
| `YToken` | balances, total supply | transfers, burns |
| `NameRegistry` | name → (pubkey, expiry) | registration + renewal burns; expiry frees name |
| `InvitationRegistry` | invitee → (inviter, block) | invite burn; referral attribution root |
| `ReferralRouter` | inviter annuity terms | splits 10% of eligible fees to inviter, burns 90% |
| `RebatePool` | epoch fee-burn accounting | pays scheduled drop pro-rata to fees burned (doc 10 §3.2.1) |
| `ServiceRegistry` | service key → (stake, URI, status) | stake escrow, slashing, bounties, service-pool payout |
| `TipRouter` | — (stateless) | transfer + 1% burn, with 32-byte content-ref memo |

These contracts call each other synchronously; that composability *is* the
enforcement. This layer should be small enough to audit exhaustively — it is
the entire trusted computing base of the economy.

### 1.2 What deliberately does NOT live there

Posts, profiles, follow lists, feed indices, flags, media — all off-chain
(doc 02), because none of them consume Y (posting/following are free by
design, doc 10 §1.2). The two layers connect by **reference, not by bridge**:

- On-chain objects carry 32-byte content addresses (a tip's memo names the
  post it rewards; a stake record names the indexer's policy document).
- Off-chain objects carry chain facts by simply being checkable against the
  chain (a client verifies a name claim by reading `NameRegistry`).

References are one-directional lookups anyone can verify; no oracle exists in
either direction. That is why the chain can stay tiny and immutable while the
content layer stays free and unbounded.

### 1.3 Consequence for chain choice

The suite needs: cheap transactions (tips are cents), synchronous
composability among these contracts, and credible neutrality/longevity. This
sharpens doc 09 §8.2: one L2 (or app-chain) hosts the entire suite; splitting
the suite across chains is architecturally excluded by the co-location rule.

---

## 2. Staking: the problem it solves

Doc 07's trust model says indexers guarantee *integrity* (can't fabricate,
because content is signed) but not *completeness* (can omit). The gap: a
client only gets the integrity guarantee **if it verifies every response** —
re-checking signatures, re-fetching from the content layer. Real clients
won't. An unverified lie that nobody checks is free.

Staking closes the gap by changing the economics of lying:

> The indexer posts a bond. Every response it serves is signed — a
> **confession-in-advance**. If any response ever contains a provable lie,
> anyone holding that response can submit it on-chain and take part of the
> bond. So the indexer must be honest with *every* requester, because *any*
> requester might be a bounty hunter.

This converts "every client must verify everything" into "someone, somewhere,
occasionally verifies anything" — and one catch is fatal. Verification
becomes a public good supplied by profit-motivated watchdogs instead of a tax
on every user.

## 3. The mechanism, step by step

### 3.1 Registration

An operator calls `ServiceRegistry.register()`, providing:

- a **service key** — the keypair that will sign every API response;
- a **stake** ≥ `MIN_STAKE` (Y, escrowed in the contract);
- a **service record** — endpoint URI + content address of its policy
  metadata (moderation policy id, coverage claims, fee schedule if it
  charges for API access).

A small registration fee burns (anti-squat). The registry is the network's
phone book: clients discover indexers here, not from a hardcoded list.

### 3.2 Signed responses (the load-bearing detail)

Every API response includes a signature by the service key over a canonical
**claim commitment**:

```
claim = (request_hash, merkle_root(items), chain_height, epoch, expiry)
```

where each `item` is a canonically-encoded unit of the response (a post, a
follow edge, an engagement total, an attested absence). Canonical binary
encoding matters: fraud proofs require the contract to parse one item and one
Merkle branch, not a JSON blob. Responses without a valid claim signature are
treated by clients as anonymous gossip — the registry listing obliges signing.

### 3.3 Slashable faults (closed list — part of the constitution, doc 10 §2.4)

Only *cryptographically decidable* faults are slashable. Each fraud proof is
a self-contained on-chain verification:

| Fault | Proof submitted | Contract checks |
|---|---|---|
| **F1: Forged content** | signed claim + Merkle branch + the item | indexer signature valid ∧ item's alleged author signature INVALID |
| **F2: Equivocation** | two signed claims | same request_hash + overlapping height, contradictory item sets, both correctly signed |
| **F3: Provable omission** | signed claim containing a *completeness attestation* for user U at feed-version V + U's signed FeedIndex at version V + Merkle non-inclusion of an entry | indexer attested completeness ∧ user-signed data proves an entry existed at that exact version |
| **F4: False chain fact** | signed claim asserting a `NameRegistry`/balance/stake fact + nothing else | contract reads its own state; mismatch is self-evident |

F3 deserves emphasis because it upgrades the doc 07 trust model: since users
sign their own FeedIndex with a version counter, an indexer that says "I
serve U, version V, and this is *all* of it" while silently dropping one post
is provably lying. **Targeted, post-level censorship becomes slashable.**
Completeness attestations are opt-in per response — but clients and indexer
directories can treat "refuses to attest completeness" as the disclosure it
is. What remains honestly unprovable: refusing to index a user at all
("we don't carry U" — visible, so users switch), serving stale versions
("best effort as of V−3" — detectable by cross-indexer comparison), and
ranking bias (subjective forever; the chronological baseline is the audit
tool, per doc 07).

### 3.4 Slashing economics

On a verified fraud proof:

- **50% of stake burned** — so self-slashing games are strictly lossy and a
  slash always hurts even if prover and cheater collude;
- **50% to the prover** — the bounty. Provers need no permission, no stake of
  their own for F1/F2/F4 (the proof is decidable, so there is nothing to
  grief); expected provers are competing indexers, watchdog bots, and
  ordinary clients that spot-check opportunistically.

Deterrence arithmetic: cheating pays only if
`(value per lie) × (lies before caught) > stake × P(any recipient ever
submits one response)`. The indexer cannot know which requester is a
watchdog, so every response carries the full tail risk. With a meaningful
stake, rational operators don't lie *at all*, and the network's observed
fraud-proof rate should be ~zero — the mechanism succeeds by never firing,
like most good security.

### 3.5 Unbonding

Withdrawal has a delay (e.g. 30–60 days) ≥ the useful life of outstanding
signed claims (bounded by the `expiry` field in §3.2). During unbonding the
stake remains slashable. Without this, the strategy "lie massively, exit
before proofs land" is free; with it, every signed claim stays collateralized
until it can no longer be a fresh lie.

### 3.6 What the stake earns (why anyone stakes)

1. **Service-pool emission** (doc 10 §3.2.2): the per-epoch drop splits
   pro-rata to `stake × liveness` among registered indexers. Liveness = the
   indexer answered its epoch challenges: challenges are sampled from chain
   randomness (e.g., "prove you serve content address X / user U" for X, U
   drawn from recent chain events), posted on-chain, answered with signed
   claims within the epoch. Unanswered challenges don't slash — they zero
   that epoch's reward (lying about a challenge, of course, slashes via
   F1–F4). Challenge submission costs a small fee to prevent grief-spam.
2. **API business**: indexers may charge clients for premium access
   (rate limits, search, firehose) — priced in Y, adding a demand loop.
3. **Directory ranking**: stake size is the natural sort key in client
   indexer-pickers — skin in the game as a legible quality signal. A large
   stake is an advertisement that cannot be faked and is expensive to abandon.

### 3.7 Lifecycle summary

```
register(stake, service_key, uri)
      │
      ▼
ACTIVE ──── every response signed ────────────────┐
  │  earns: service pool + API fees               │
  │  duty: answer epoch challenges                │
  │                                               ▼
  │                              anyone submits fraud proof (F1–F4)
  │                                               │
  ├── request_unbond() ──► UNBONDING (30–60d) ──► withdraw()
  │                            still slashable
  ▼
SLASHED: 50% burn / 50% prover; registry status = slashed (permanent record)
```

### 3.8 Extension to other service roles

The same pattern (stake → signed claims → decidable fraud proofs → slash)
generalizes to later versioned roles without touching the constitution:
media gateways (fraud = serving bytes whose hash ≠ the address claimed),
notification relays (fraud = forged event attestations), archive nodes
(fraud = failing a possession challenge for content they attested to hold).
Each new role is a new opt-in contract per doc 10 §1.5 — added by deployment
and adoption, not by governance over existing rules.

---

## 4. Honest limits, stated once

- Staking enforces **truthfulness**, not **quality**: a slow, badly-ranked,
  ugly-but-honest indexer is unslashably bad. Markets handle quality.
- Coarse censorship ("we don't serve these users at all") is legal and
  visible; the remedy is the exit right, which is the point of the whole
  architecture (doc 09 §4).
- F1/F2/F4 proofs must stay cheap enough to verify on-chain; this constrains
  the canonical encoding (§3.2) and is a real engineering task, not a detail.
- A cartel of all indexers refusing a user is not slashable — it is mitigated
  by permissionless entry (anyone can stake and index; the data is public) —
  the same defense every open network ultimately rests on.
