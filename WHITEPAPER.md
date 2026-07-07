# A Decentralized Social Network with an Objective Money Layer

**White Paper — Draft v0.1**

> Status: draft distilled from the project's design documents (`docs/00`–`docs/11`).
> All numeric parameters marked as strawman values are proposals; the *structure*
> of each mechanism is the design.

---

## Abstract

We describe a decentralized social network built from two strictly separated
layers: a small, immutable, on-chain economic layer, and a free, unbounded,
off-chain content layer. The economic layer is governed by a single design
rule: **the money layer measures nothing subjective**. It handles balances,
burns, unique names, invitations, referral annuities, and service stakes —
quantities that are objective and mechanically verifiable. Everything that
requires judgment — ranking, moderation, "quality" — lives at the edge, in
competing indexers and clients that users can switch between freely.

The native token, **Y**, has a fixed supply of 21 million. It functions as
social money (tips), resource money (burned protocol fees for names,
invitations, and promotion), and security money (stakes that make indexer
honesty enforceable through cryptographic fraud proofs and slashing). No
token is ever minted against a social metric: 70% of supply distributes by
formula and market from day one, and the remainder is administered by a
visible, named steward whose mandates expire and whose unspent balances burn.

The result is a network where identity, social graph, and money are held by
users; where the worst any operator can do to a user is inconvenience them
into switching providers; and where the monetary rules are computable to the
year 2040 by anyone, because no one holds a lever to change them.

---

## 1. Motivation

A centralized social platform is three markets stapled together: an attention
market with a legible scoreboard, a real-time information discovery machine,
and a social graph. Its users bear three structural risks:

- **Misalignment.** The value users create accrues to shareholders; users are
  inventory.
- **Arbitrary change.** Reach algorithms, API pricing, monetization terms,
  and bans can change overnight by decision of a single owner. Platform risk
  is unhedgeable.
- **No exit.** Identity, audience, and history are hostage to the platform.

Decentralization genuinely improves some of this — censorship resistance,
identity portability, algorithmic choice, exit rights, protocol permanence —
and genuinely damages other parts: spam control, moderation speed, scoreboard
legibility, and UX. An honest design must claim only the first list and
mitigate the second, rather than pretend the trade-off doesn't exist.

The empirical record shapes this design throughout. Architectures built on
signed data plus competing indexers (Nostr, ATProto, Farcaster) survived in
the wild. Economic layers that minted tokens against social approval
(Steemit) or sold speculative positions on people and content (BitClout,
friend.tech) collapsed — for first-principles reasons, not execution reasons.
This project adopts the surviving architecture and deliberately excludes the
failed economics. An earlier revision of this design included
donation-weighted emission and bonding curves on posts; an adversarial
first-principles review (doc 09) showed both to be structurally unsound, and
they were removed. Section 7.6 summarizes why.

### 1.1 The four pillars

| Pillar | Centralized platform | This network |
|---|---|---|
| Alignment | Value accrues to shareholders | Users, inviters, and service operators hold the appreciating asset |
| Arbitrary change | Rules changeable overnight by one owner | Monetary constitution is admin-keyless and immutable; subjective layers are per-indexer choices |
| Predictability | Platform risk unhedgeable | Supply, schedule, fees, and slashing conditions are computable decades ahead by anyone |
| Exit rights | Identity and audience are hostage | Identity, graph, and money are user-held; switching providers is the worst-case loss |

---

## 2. Design Principles

1. **Nothing subjective in the money layer.** On-chain rules must be
   objective, simple, and boring: balances, burns, uniqueness, registries,
   stakes. Any metric that mints money becomes the thing people produce
   instead of the thing it was meant to measure (Goodhart's law, with a block
   explorer). Anything subjective — ranking, moderation, quality,
   contribution — lives at the edge, where "tuning" is ordinary competition
   and users tune by switching.

2. **Costs on amplification, never on existence.** Joining, posting,
   following, replying, and reading are free forever. Protocol fees apply
   only to scarce resources and amplification: unique names, invitations, and
   paid promotion. This is both the adoption strategy and the honest
   anti-spam model: cost sits on footprint and reach, not on participation.

3. **Existence is separate from visibility.** Content, once stored, is
   permanent and uncensorable at the data layer. What gets *shown* is decided
   by indexers applying published, auditable moderation policies — and users
   choose their indexer.

4. **Verifiability with teeth.** All content is signed by its author; all
   economic events are on-chain. Indexers therefore cannot fabricate data
   undetected — and because registered indexers stake Y and sign every
   response, provable lies are not merely detectable but *slashable*.

5. **Honest, expiring centralization at genesis.** Every credible
   decentralized network began with a centralized steward. This design names
   that role explicitly, gives it tokens rather than levers, and attaches
   expiry dates and burn clauses — instead of claiming a decentralization at
   genesis that would in practice be fake.

---

## 3. Architecture

The system is two layers connected by **reference, not by bridge**.

```
┌────────────────────────────────────────────────────────────┐
│  ON-CHAIN (one execution layer)                            │
│  YToken · TipRouter · NameRegistry · InvitationRegistry    │
│  ReferralRouter · RebatePool · ServiceRegistry             │
│  IdentityRegistry                                          │
└──────────────────────────┬─────────────────────────────────┘
                           │  32-byte content references /
                           │  publicly checkable chain facts
┌──────────────────────────┴─────────────────────────────────┐
│  OFF-CHAIN (content-addressed storage: IPFS / Autonomi)    │
│  Posts · Profiles · Follow lists · Feed indices ·          │
│  Moderation flags                                          │
└──────────────────────────┬─────────────────────────────────┘
                           │  crawled + indexed
┌──────────────────────────┴─────────────────────────────────┐
│  EDGE (competing, permissionless)                          │
│  Staked indexers (REST APIs, feeds, search, moderation     │
│  policies) · Clients (ranking choice, spot-check           │
│  verification)                                             │
└────────────────────────────────────────────────────────────┘
```

### 3.1 The co-location rule

> Any rule that consumes, locks, or pays Y must execute in the same place as
> the Y balance it touches.

A name registration burns Y *and* writes the name in one atomic transaction.
If the name registry lived anywhere else, "paid" and "registered" would be
separate events needing a bridge or oracle to connect them — a trusted party
inside the monetary constitution, which the design forbids. The same logic
applies to renewals, stakes (a slash must seize the exact escrow), rebates,
and referral fee-splits. Consequently the entire contract suite lives on one
execution layer, small enough to audit exhaustively: it is the entire trusted
computing base of the economy.

### 3.2 What deliberately does not live on-chain

Posts, profiles, follow lists, feed indices, flags, and media never touch Y,
so they stay off-chain. On-chain objects carry 32-byte content addresses (a
tip's memo names the post it rewards); off-chain objects carry chain facts by
simply being checkable against the chain. References are one-directional
lookups anyone can verify; no oracle exists in either direction. That is why
the chain can stay tiny and immutable while the content layer stays free and
unbounded.

---

## 4. Identity

- **Keys.** A user's identity is a BLS keypair. The public key is the only
  canonical identity; display names are cosmetic. Purpose-specific child keys
  are deterministically derived from the root key (profile, feed, follows,
  flags, one-time tip senders), so anyone can locate any user's data from
  their root public key alone.

- **Rotation and recovery.** "One key, total loss" is unacceptable for
  ordinary humans, so the on-chain `IdentityRegistry` gives every account a
  *stable identity id* that can be re-pointed to a new key. Rotation is
  signed by the current key. Opt-in **M-of-N social recovery** lets guardians
  (the invitation tree provides natural candidates) recover a lost key,
  subject to a veto window during which the current key can cancel — so a
  compromised guardian set cannot silently steal a live identity. Content
  signatures verify against the key that was current at write time.

- **Names.** Human-readable names are registered on-chain for a burned fee,
  tiered by length, with **annual renewal** and expiry recycling. Renewal
  fees keep the sink alive, recycle abandoned names, and make mass squatting
  a recurring cost rather than a one-time land grab. Names resolve to the
  identity, not the raw key, so rotation never orphans a name. Names prove
  uniqueness, not authenticity; impersonation defense is an attestation
  concern at the edge layer.

---

## 5. Content and the Social Graph

- **Posts** are immutable, signed, content-addressed objects (up to 4,000
  characters), with optional reply threading via signed graph edges. Posting
  is free and carries a per-author monotonic sequence number to prevent
  replay.

- **The forward graph is trivially decentralized.** "A follows B" is a
  statement owned by A; A's signed, versioned follow list *is* the single
  source of truth — no consensus needed, because there is exactly one author.

- **The reverse graph is inherently an index.** "Who follows B" is always an
  aggregation product. Signed edges give it a one-sided guarantee: an indexer
  cannot *fabricate* a follower (it cannot forge a signature) but can *omit*
  one. Omission is detectable by cross-checking indexers, and — where the
  indexer attests completeness — provable and slashable (§8).

- **Feed indices.** Each user maintains a signed, versioned index of their
  own recent posts. This is what makes targeted censorship provable: an
  indexer that attests "this is all of user U's feed at version V" while
  dropping a post is committing a cryptographically demonstrable lie.

- **Scoreboards.** Follower counts are Sybil-inflatable in any open network;
  no protocol mechanism fixes this without an identity oracle. The design's
  answer is edge-layer honesty: indexers expose raw counts as the verifiable
  number and may display trust-weighted reach as the meaningful one.

---

## 6. Token Y: The Monetary Constitution

Y's design premise, inherited from the first-principles review: **the money
layer measures nothing subjective.** That single constraint is what makes
alignment, immutability, and predictability simultaneously achievable — a
mechanism that needs tuning cannot be promised immutable, and a mechanism
that is immutable but mismeasures becomes a permanent exploit. So the
monetary core is small, dumb, and objective — and therefore can be carved in
stone.

Carved in stone at genesis, admin-keyless:

1. **Total supply: 21,000,000 Y** (6 decimals). No mint function exists
   outside the genesis allocation buckets.
2. **Distribution schedule:** fully deterministic, block-based epochs
   (~1 week), no discretionary faucet anywhere on-chain.
3. **Burn rates and fee formulas:** fixed constants.
4. **Slashing conditions:** a closed list of cryptographically provable
   faults.
5. **Referral terms:** fixed percentage, fixed duration, depth 1.

There is no governance vote over any of the above. Upgrades ship as new
*opt-in* contracts that clients and indexers choose to adopt — versioning
plus adoption is the fork-choice governance. There is no lever, so no one can
be pressured to pull it.

### 6.1 The four functions of Y

**Social money — tips.** The atomic social-economic act: a transfer of
existing Y from fan to creator with a small flat burn (1%). Nothing is minted
against tips, so wash-tipping is strictly pointless — you pay the burn to
move your own money. Tips are the honest "like with value": costly because
money leaves your wallet, not because a protocol formula says so. Tips may
legitimately fuel edge-layer ranking; inflating your own rank via self-tips
is then just paid promotion at full price. For privacy, clients should send
tips from one-time derived keys, so the public ledger records flows without a
linkable donor identity by default.

**Resource money — burned fees.** Y is the only asset accepted for the
network's scarce resources, all priced by deterministic, immutable formulas:

| Sink | What it prices |
|---|---|
| Name registration | global uniqueness (tiered by length) |
| Name renewal | continued exclusivity (annual; lapse → name recycles) |
| Invitation | account-creation externality (flat; also the referral-attribution event) |
| Promotion | attention amplification (pay-to-boost, burned, no return path) |
| Service registration | entry to the staked-service registry (anti-squat) |

Deliberately excluded: joining, posting, following, reading, tipping
eligibility.

**Security money — staking.** Indexers (and, later, other service roles)
register on-chain by staking Y. Because all content is signed, fabrication is
cryptographically provable, and a provable lie forfeits stake (§8). Staking
locks supply in proportion to service-layer activity, giving Y demand that
scales with usage rather than speculation alone.

**Bootstrap equity — the distribution itself.** Early users acquire Y cheaply
(tips earned, rebates, referral annuities, early purchase). Appreciation
through the burn/stake loop is the primary early-adopter reward — the only
reward channel with literally zero gaming surface.

What Y deliberately is **not**: a governance token over money; a claim on
anyone's content revenue; or a requirement for reading. Consuming the network
is free forever.

### 6.2 Distribution of the 21M

Every distribution channel must pass one test:

> Assume every channel is attacked by a rational, well-funded adversary from
> block 1. The channel is acceptable only if its fully-gamed equilibrium is
> still an outcome we'd accept.

Allocation (strawman numbers; ratios are the proposal):

| Bucket | % | Mechanism | Unlock |
|---|---|---|---|
| Usage rebate pool | 30% | pro-rata rebate on protocol fees burned, per epoch | ~12 years, halving every ~2 years |
| Service provider pool | 10% | per-epoch drop to staked, proven-live indexers | same schedule |
| Treasury | 20% | client development, grants, retroactive rewards | 5y linear; **unspent burns at year 8** |
| Founders/team | 15% | genesis grant | 1y cliff, 4y vest |
| Liquidity + public sale | 15% | DEX liquidity + open sale | immediate |
| Genesis community drops | 10% | retroactive drops during bootstrap | sunsets year 3; remainder burns |

**The usage rebate pool** distributes each epoch's scheduled drop pro-rata to
protocol fees burned that epoch. Its adversarial analysis, in full: identity
is irrelevant (splitting fee-burning across a thousand Sybil accounts changes
a pro-rata share by exactly zero — no personhood oracle needed); and the only
"attack" — burning fees purely to harvest the drop — is profitable only while
the drop exceeds total fees, at which equilibrium the marginal harvester is
simply *buying tokens from the protocol at market price*. Meanwhile, while
the drop exceeds fees, genuine usage is rebated at over 100% — names,
invitations, and promotion are effectively free in the early network,
decaying smoothly toward full price as adoption grows. That is the
early-adopter subsidy, expressed as a formula instead of a judgment. Only
pure burns are rebate-eligible: resource-consuming fees (e.g., future storage
rent) are excluded so the harvest equilibrium cannot manufacture spam load,
tip burns are excluded to protect the tip signal, and name renewals after a
name's first year are excluded so squat-harvesting has a carrying cost.

**The service provider pool** is emission attached to *verifiable work*:
staked indexers that answered the epoch's liveness challenges (sampled from
chain randomness) split the drop. Kept deliberately small because
service-proof gaming is a known arms race; the worst case — operators running
minimal honest infrastructure to farm the pool — still adds redundant serving
capacity.

**What is deliberately absent:** no emission points at donations, likes,
followers, content, engagement, or any other social quantity — not because
those don't matter, but because minting against them destroys them. Social
value flows through Y as tips (existing supply changing hands), never out of
the mint.

### 6.3 The referral annuity

The inviter of an account receives **10% of the protocol fees that account
burns during its first ~4 years** (direct invites only, depth 1; paid from
the fee before the remaining 90% burns).

- Costs the supply schedule nothing — it redirects fees, it doesn't mint.
- Objective, oracle-free, and unfakeable at a profit: routing your own fees
  through a Sybil invitee returns 10% of money that was 100% yours.
- Pays for exactly the behavior that grows the network: recruiting people who
  *actually use it*. The annuity is worthless unless the invitee pays fees.
- Depth 1 + fixed rate + fixed term keeps it a referral program, structurally
  incapable of MLM dynamics — there is no downline.

### 6.4 The honest weak point

A pure medium-of-exchange token has a velocity problem (recipients sell,
holders never need to hold). The structural counters: burns (supply decays
with usage), stakes (supply locked by service demand), prepaid renewals
(supply parked in namespace), and tips received psychologically registering
as earnings held by default. If usage grows and velocity stays finite, the
value loop closes; if the network doesn't grow, no tokenomics saves it.

### 6.5 Day-one onboarding

1. An inviter burns the invitation fee and typically gifts pocket Y — the
   client bundles "invite + starter tip" as one action, which is individually
   rational because the inviter owns the referral annuity on this person's
   future fees.
2. Reading is free; posting is free; earning tips requires nothing.
3. First Y is earned via tips; a user buys Y only if and when they want a
   name or promotion.

No step requires an exchange account before the network has demonstrated
value to the user.

### 6.6 Design history: what was removed and why

Two mechanisms from an earlier revision were killed by adversarial analysis,
and the reasoning is retained as part of the design's justification:

- **Donation-weighted emission** (Steemit's model) is a mining algorithm:
  with a 5% donation burn and emission E split pro-rata to donations D,
  wash-donating between one party's own accounts is profitable whenever
  D < 20·E, so rational actors inject wash volume until real signal drowns.
  The root cause is categorical, not parametric: a subjective quantity
  ("genuine appreciation") was consumed by a consensus-critical process
  (minting money). No parameter fixes that.
- **Bonding curves on posts** (friend.tech's model) are a negative-sum
  pyramid — a bonder's return comes exclusively from later bonders, minus a
  burn — with textbook securities-law exposure. The legitimate need it served
  ("skin in the game on content") is met by the **promotion burn**: pay to
  amplify, money destroyed, no return path. An advertising fee, not an
  investment.

Relatedly, invitation-tree distance was dropped as a Sybil defense (invite
markets place an attacker's purchased accounts far apart while penalizing
genuine friends — the mechanism was inverted). The tree survives as *data*:
accountability chains, referral attribution, and optional edge-layer trust
heuristics. No monetary contract consults it.

---

## 7. Invitations and Growth

Every account enters through an on-chain invitation (or genesis seeding).
The invitation registry serves three roles:

1. **Membership and discovery** — indexers bootstrap user discovery from
   invitation events.
2. **Accountability data** — the tree records who vouched for whom, available
   to clients and indexers for display and trust-informed filtering, and
   never consulted by any monetary contract.
3. **The referral annuity** (§6.3) — converting the invitation system from a
   broken Sybil defense into what invitation systems are actually good at: a
   growth engine.

The invitation fee is a growth throttle and fee sink, not a Sybil proof.
Accounts are deliberately cheap; what Sybils could once earn no longer
exists, and pro-rata rebates are Sybil-invariant by construction.

---

## 8. Verifiable Indexers: Staking, Fraud Proofs, Slashing

Content-addressed storage has no query capability. Indexers bridge the gap:
they listen to chain events, crawl the content layer, build indices, and
expose REST APIs (feeds, profiles, threads, search, engagement, moderation
status, name resolution). Anyone can run one; clients discover them through
the on-chain service registry, not a hardcoded list.

### 8.1 The trust gap and how staking closes it

Signed content means an indexer cannot fabricate data *that a verifying
client would accept* — but real clients won't verify every response, and an
unverified lie nobody checks is free. Staking changes the economics:

> The indexer posts a bond. Every API response it serves is signed — a
> confession-in-advance. If any response ever contains a provable lie, anyone
> holding that response can submit it on-chain and take part of the bond. So
> the indexer must be honest with every requester, because any requester
> might be a bounty hunter.

This converts "every client must verify everything" into "someone, somewhere,
occasionally verifies anything" — and one catch is fatal.

### 8.2 Slashable faults (closed, constitutional list)

Only cryptographically decidable faults are slashable:

| Fault | What the proof shows |
|---|---|
| **F1 Forged content** | the indexer signed a response containing an item whose alleged author signature is invalid |
| **F2 Equivocation** | two correctly signed, contradictory responses to the same request at overlapping chain height |
| **F3 Provable omission** | the indexer attested completeness for a user's feed at version V, yet the user's own signed feed index at version V contains an entry the response omits — targeted censorship becomes slashable |
| **F4 False chain fact** | a signed claim about on-chain state that the contract can check against itself |

On a verified proof: 50% of the stake burns (so self-slashing games are
strictly lossy) and 50% goes to the prover as bounty. Unbonding is delayed
long enough that every outstanding signed claim stays collateralized.
Deterrence is probabilistic and total: the indexer cannot know which
requester is a watchdog, so every response carries the full tail risk, and
the mechanism succeeds by (almost) never firing.

What remains honestly unprovable — and is instead market-disciplined by
client switching: refusing to index a user at all (visible), serving stale
data (detectable by cross-indexer comparison), and ranking bias (subjective
forever; the chronological baseline is the audit tool).

### 8.3 Ranking is a client choice

Indexers offer multiple feed ranking strategies — chronological, tip-weighted,
promotion-weighted, blended — selected per request by the client. Ranking is
never consensus. Promotion is a paid-amplification signal, an ad rather than
a quality judgment, which clients and indexers may weight or ignore.

The same pattern (stake → signed claims → decidable fraud proofs → slash)
extends to future service roles — media gateways, notification relays,
archive nodes — each added as a new opt-in contract, never by governance over
existing rules.

---

## 9. Moderation: Existence vs. Visibility

Stored content is permanent (existence). Indexers decide what to serve
(visibility), each applying its own published `ModerationPolicy`, and users
who disagree switch indexers. The machinery is fully transparent: flags are
public, signed, permanent objects; scoring is deterministic; anyone can audit
the moderation history of any post.

- **Eligibility is objective.** To flag or review, an account must be
  invited, aged past a minimum number of epochs, and hold a locked
  **moderation bond** (10 Y, refundable after a cooldown). The bond puts a
  real per-identity capital cost on moderation power — a botnet must lock
  capital linearly per flagging identity. (An earlier donation-count
  criterion was purchasable with dust and was removed.)
- **Uniform influence.** Every eligible flagger and reviewer counts exactly
  1.0. No account dominates.
- **Contestability.** An author whose post is hidden can counter-flag,
  triggering a time-boxed community review. A successful overturn
  **nullifies** the covered flags entirely (not merely subtracts votes) and
  restores visibility.
- **Accountability on both sides.** Flaggers whose flags are overturned lose
  accuracy; below a threshold their flags are ignored entirely — retaliatory
  flaggers silence themselves, not their targets. Reviewers on the losing
  side of a decisive (≥2:1) verdict lose accuracy too, so brigading a review
  costs the brigade its reviewing power. Accuracy moves only on *resolved*
  reviews, so targeting users unlikely to contest earns no reputation.
- **No truth-by-plebiscite.** "Misinformation" is deliberately not a
  protocol-level flag reason: majority-voted truth was judged the primary
  brigading target in polarized topics. Indexers wanting such categories
  define them in their own published policy vocabularies.
- **The honest exception.** For illegal content (e.g., CSAM), "existence is
  uncensorable" is not an adequate answer; permanent storage is real legal
  exposure for node operators. Visibility machinery does not solve this;
  chunk-level blocklist standards and hash-list integration at the storage
  layer are required and tracked as an open protocol issue.

---

## 10. What This Design Does Not Claim

Stated once, honestly:

- **Sybil resistance for identity.** Accounts are cheap by design. The design
  is instead Sybil-*indifferent* everywhere money moves: no mechanism pays
  more for more accounts.
- **Scoreboard integrity.** Raw follower counts are inflatable;
  trust-weighted display is an edge-layer mitigation, not a protocol fix.
- **Moderation quality.** The protocol guarantees process (transparency,
  contestability, accountability), not verdicts. Indexer sovereignty contains
  damage; it does not eliminate disagreement.
- **Service quality.** Staking enforces truthfulness, not quality; a slow,
  badly ranked, ugly-but-honest indexer is unslashably bad. Markets handle
  quality.
- **Cartel immunity.** All indexers jointly refusing a user is not slashable;
  it is mitigated by permissionless entry — anyone can stake and index, and
  the data is public.
- **Privacy completeness.** One-time tip keys remove default donor
  linkability, but follow lists are public, posts are immutable (a
  protocol-level "retract" honored by compliant indexers is roadmap), and
  erasure over immutable storage (GDPR) is an acknowledged open problem.
- **Guaranteed token appreciation.** The value loop closes only if the
  network grows.

---

## 11. Implementation Status and Roadmap

The reference implementation is a Rust workspace of eight crates mirroring
the architecture: `core` (types, crypto), `data` (off-chain storage traits +
in-memory mock), `chain` (chain-client abstraction + in-memory mock),
`token-y` (pure economic math), `invitation`, `moderation`, `indexer` (chain
listener, crawler, REST API), and `cli`. In-memory backends enable
multi-agent adversarial simulation before any network integration. Smart
contracts (the §3.1 suite) are specified in the design documents and
implemented separately; the storage backend targets IPFS/Autonomi behind a
trait abstraction.

Open decisions, deliberately unresolved in this draft:

1. **Exact economic constants** — allocation ratios, epoch length, halving
   cadence, fee levels (structure is the proposal; numbers are strawmen).
2. **Chain choice** — sub-cent fees are a hard requirement for tip-sized
   transactions; the co-location rule requires the entire contract suite on
   one execution layer (L2 or app-chain).
3. **Sale mechanics and jurisdictional review** — the token is deliberately
   utility-shaped (fee sinks, no profit-share), but the service pool and
   referral annuity warrant counsel review.
4. **Service-pool activation** — likely in a later versioned contract once
   spot-check proof formats are battle-tested.
5. **The wedge community** — "a better X" is not a go-to-market; the first
   client must serve a community for whom censorship resistance and exit
   rights are a felt need, not an ideology.
6. **Named edge-layer services not yet specified** — DMs (with real E2E
   encryption), media storage economics, notifications, and real-time
   delivery.

---

## 12. Conclusion

The single organizing idea of this design is a division of labor: **the chain
keeps balances, burns, names, stakes, and registries; humans and markets —
clients, indexers, and a sunsetting steward — keep everything that requires
taste.** Every mechanism that placed a subjective judgment inside the money
layer was found, under adversarial analysis, to be a mine, a pyramid, or an
oracle in disguise — and was removed. What remains is small enough to be
immutable, objective enough to be Sybil-indifferent, and open enough at the
edge that every contested question ("what should I see?", "who should I
trust?") is answered by competition and exit rather than by authority.

---

*This white paper summarizes the full design documents in `docs/00`–`docs/11`
of the project repository, which include the complete type definitions,
mechanism specifications, adversarial analyses, and the first-principles
review that shaped the current design. Where this summary and those documents
differ, the design documents govern.*
