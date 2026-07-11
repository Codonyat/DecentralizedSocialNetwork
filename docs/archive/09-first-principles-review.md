> **ARCHIVED — NON-NORMATIVE.** This document belongs to a parallel spec effort that reviewed/redesigned the pre-2026-07-11 spec (`f9b3820`). The harmonization decision (2026-07-11, recorded in the merge history) kept the concurrent redesign in docs 00–09 as the normative spec: Reward Pool fee recycling instead of burns, donation-directed emission with lineage-family weighting, Harberger @handles, 140B supply, bonding retained. This file is preserved because its adversarial arguments remain the sharpest known attacks on the normative design — read it as a standing red-team brief, not as the spec. Internal references to "doc 09/10/11" mean files in this archive directory; references to docs 00–08 describe the OLD spec, not the current one.

# First-Principles Review: What Breaks, What Survives, and What Y Can Honestly Be

This document is an adversarial review of the current spec (docs 00-08). It is
organized as: (1) what problem we are actually solving, (2) mechanisms in the
current design that break under adversarial pressure — with the math, (3) the
"who tunes the algorithm" question answered from first principles, (4) the
social-graph question, (5) what the token can honestly be, (6) early-adopter
rewards that are not mineable, (7) a keep/kill/change summary, and (8) the
product questions that no protocol mechanism can answer.

---

## 1. What are we actually building?

Decompose X's value from first principles. X is three markets stapled together:

1. **An attention market** — one shared arena where everyone competes for
   reach, and where reach is legible (follower counts, view counts). Status
   games only work if everyone agrees on the scoreboard.
2. **A real-time information discovery machine** — search, trends, breaking
   news. This is an *indexing* product, not a storage product.
3. **A social graph** — who follows whom. This is the part people usually
   point at, but it is the *least* defensible part (see §4).

A decentralized competitor must be honest about which of these decentralization
improves and which it damages:

- Decentralization **improves**: censorship resistance, identity portability,
  algorithmic choice, exit rights, protocol permanence.
- Decentralization **damages**: scoreboard legibility (whose follower count is
  real?), spam control, moderation speed, UX (keys, fees), and iteration speed.

Every mechanism in the spec should be justified by the first list and audited
against the second. Several current mechanisms fail that audit.

The empirical record matters here. The current design is, structurally:
**Steemit's economics** (emission distributed by social approval) +
**friend.tech's bonding curves** (speculation on people/content) +
**Nostr/ATProto's architecture** (signed data + competing indexers).
The architecture layer of that trio survived in the wild. Both economic layers
collapsed, in the same ways this review predicts below. That is not a
coincidence; they collapsed for first-principles reasons, not execution
reasons.

---

## 2. Mechanisms that break under adversarial pressure

### 2.1 Donation-weighted emission is a mining algorithm (critical)

The spec (03, §D): each epoch's emission E is split among creators pro-rata to
weighted donations received. Donations burn 5%; weight = 1.0 at graph distance
≥ 3.

Consider two accounts controlled by one party, at tree distance ≥ 3 (see §2.2
for why that is cheap). A donates `d` to B:

- Cost: `0.05·d` (burn). The other `0.95·d` stays inside the party's wallets.
- Revenue: B's emission share rises by `E·d/D`, where `D` is total weighted
  donations that epoch.

Wash-donating is profitable iff `E·d/D > 0.05·d`, i.e. iff **`D < 20·E`**.

So rational actors inject wash-donation volume until total donation volume is
~20× emission per epoch. At that equilibrium:

- The overwhelming majority of donation volume is wash traffic, because
  genuine donors donate what content is worth to them, while miners donate up
  to the profitability bound.
- Genuine creators' emission share is diluted to
  `genuine_volume / (genuine_volume + wash_volume)` — a small fraction.
- "Donations received" ceases to be a quality signal at all, which then
  poisons everything downstream that consumes it: feed ranking (`Donated`,
  `Blended`), moderation eligibility (`MIN_DONATION_COUNT`), and the social
  meaning of the number itself.
- The per-creator cap (`per_creator_cap_bps`) does not stop this; it only
  forces the miner to spread over more recipient accounts, and accounts are a
  one-time purchasable cost (§2.2).

The root cause is not the parameter values. It is a category error: **a
subjective quantity ("genuine appreciation") is being consumed by a
consensus-critical process (minting money)**. Any metric that mints tokens
becomes the thing people produce instead of the thing it was supposed to
measure (Goodhart's law, with a block explorer). Steemit ran exactly this
design at scale: within two years its "curation" was dominated by bid-bots,
vote-selling markets, and self-vote rings, and the honest signal drowned.

Note the crucial asymmetry: a donation is only a "pure loss for the donor"
(the property the spec relies on) when donor and recipient are *actually
different people* — which is precisely the fact no protocol can verify.

**Conclusion: emission must either be attached to objectively verifiable
work, or not exist. It cannot be attached to social approval.** See §5.

### 2.2 Invitation-tree distance measures topology, not identity

The Sybil defense weights donations by graph distance *in the invitation
tree*, on the theory that sock puppets are close together. Two failures:

**It fails against the adversary.** Invitations cost Y, so an invite market
will exist (people recoup costs by selling invites — this happened with every
scarce-invite system from Gmail resale to lobste.rs). An attacker who buys
invites from two unrelated strangers gets two accounts that are *far apart*
in the tree — distance ≥ 3, full 1.0 weight. Tree distance between two
accounts says nothing about whether the same human holds both keys. The real
Sybil cost is just the invite price, a one-time capital cost amortized against
the perpetual mining revenue of §2.1.

**It punishes the honest case.** Real users invite their actual friends, and
actual friends genuinely donate to each other. The weighting gives these
honest donations 0.5–0.75 weight while giving the stranger-bought Sybil pair
1.0. The mechanism is *inverted*: maximum penalty on the most natural honest
topology, minimum penalty on the adversarial one.

**It may not even be computable where it's needed.** Emission is on-chain,
so the contract must know the graph distance for every donation. Shortest
path in a growing tree is O(depth) per pair with ancestor tracking — per
donation, forever, at gas cost. If the practical answer becomes "an indexer
computes weights and submits them," then a trusted party now sits inside the
money layer. That is the "someone must tune it" failure mode, smuggled in as
an implementation detail.

The invitation tree is still valuable — as *data* (accountability chains,
"who vouched for whom", trust-informed client-side filtering, referral
attribution per §6). It just cannot carry Sybil-resistance weight for money.

### 2.3 Post bonding curves are a negative-sum pyramid (and a legal risk)

Spec 03 §C: later bonders pay into earlier bonders' positions, 10% burned,
non-redeemable. First-principles reading:

- A bonder's return comes exclusively from *subsequent* bonders. That is the
  definitional structure of a pyramid, made strictly worse by the 10% burn
  (negative-sum, so in aggregate bonders must lose).
- The rational strategy is a Keynesian beauty contest: bond on what *others
  will bond on*, i.e. predicted virality — not quality. Sensational and
  coordinated content wins; this recreates the engagement-bait dynamics of X
  with money attached.
- Securities exposure is real: investment of money, common enterprise, profit
  expectation from the efforts of others is close to a textbook Howey trip.
  BitClout creator coins and friend.tech keys both ran this shape; both
  produced bagholders, lawsuits/regulatory attention, and month-scale
  collapse of activity once number stopped going up.
- **Mandatory first bond = pay-to-post.** See §2.4.

If a "skin in the game on content" primitive is wanted, the sustainable
version is a *promotion burn* (pay to boost distribution, money destroyed, no
return path — an advertising fee, not an investment) — or nothing.

### 2.4 The cold-start design maximizes time-to-first-value

To become an active user today a person must: obtain an invitation (someone
burned 100 Y for them) → acquire Y (exchange? gift?) → pay a bond to make
their first post → into a network where there is nothing to read. Every
successful social product minimized time-to-first-value; this stacks four
walls in front of it, and the reward on the other side (token emission) is
the thing §2.1 shows will be captured by miners. Token incentives reliably
attract mercenary users who churn when emissions shift — this is documented
across Steemit, DeSo, friend.tech, and every liquidity-mined "SocialFi" app.

Costs are good for Sybil resistance and terrible for adoption. The resolution
is to put costs on *amplification and scarce resources* (names, promotion,
service registration, storage rent), never on *existence* (joining, posting,
following).

### 2.5 Moderation: purchasable eligibility, unaccountable juries, and one bug

The visibility/existence split and per-indexer policy sovereignty are the
strongest parts of the spec (see §3). The specific mechanisms need work:

- **Eligibility is purchasable.** `MIN_DONATION_COUNT = 5` with no minimum
  amount means five dust donations buy a moderation vote. Any
  donation-derived criterion also inherits the wash-traffic corruption of
  §2.1.
- **"Uncontested = upheld" inflates predator accuracy.** Flaggers who target
  users unlikely to counter-flag (newcomers, casual users) accumulate perfect
  accuracy. Accuracy should only move on *resolved reviews*.
- **Reviewers are stakeless and 5 votes decide.** A five-account cartel meets
  `MIN_REVIEW_VOTES` and flips reviews; reviewers face no consequence for
  provably bad verdicts (flaggers at least have accuracy tracking).
- **Arithmetic bug in overturn:** `net = flags + uphold − overturn` means a
  post with 15 flags that *wins* its review 8–3 still scores 15+3−8 = 10 →
  still hidden under the default policy. A successful overturn should nullify
  the flag score for that reason class, not merely subtract vote counts.
- **`Misinformation` by majority vote** is truth-by-plebiscite and will be
  the primary brigading target in any polarized topic. Indexer sovereignty
  contains the damage, but consider removing it as a protocol-level reason
  and leaving it to indexer-specific policy vocabularies.
- **Illegal content cannot be a pure "visibility" question.** "Existence is
  uncensorable" means storage nodes host CSAM permanently. That is legal
  exposure for node operators, indexers, and the project. This needs a real
  answer at the storage layer (e.g. chunk-level blocklist standards that
  storage nodes can adopt, hash-list integration), not a philosophical one.

### 2.6 Identity: one key, total loss

The BLS root key is identity + money + name, with no rotation and no
recovery. One compromised or lost key = permanent loss of the account, the
graph position, the balance, and the (permanently registered) name. Ordinary
humans lose keys constantly; this alone caps the network at crypto-natives.
Minimum bar: an on-chain identity record that lets a rotation event re-point
an identity to a new key, plus opt-in social recovery (M-of-N guardians —
the invitation tree provides natural guardian candidates). This must be
designed *early*: every signature in the data layer currently assumes the
root key is forever.

### 2.7 Privacy: the design publishes a financial intimacy graph

Donations are on-chain: who paid whom, how much, when, forever. That is far
more sensitive than a public like — it is a permanent, public map of
affinity with amounts attached (consider: donations to adult creators,
dissident journalists, ex-partners). Also: posts are immutable with no delete
concept (humans need delete even if archival copies exist — the *default
client behavior* matters), and permanent public follow lists leak association.
At minimum: tips via one-time derived sender keys, a protocol-level
"retract" object that compliant indexers honor, and private-follow support
should be on the roadmap. GDPR erasure over immutable storage is an unsolved
issue to acknowledge explicitly rather than discover later.

### 2.8 Names: permanent + cheap = squatted and fossilized

100 Y for every 5+ char name, once, forever: every celebrity handle and
dictionary word gets squatted at genesis for trivial cost, lost keys freeze
names permanently, and the sink stops sinking once the land grab ends. ENS
learned this: **renewal fees** (a) create an ongoing burn tied to real usage,
(b) recycle abandoned names, (c) make mass squatting a recurring cost.
Impersonation ("elonmusk" for ~$X) additionally needs an attestation story —
names prove uniqueness, not authenticity.

---

## 3. "Who tunes the algorithm?" — the actual answer

The question in the original prompt — *"if I wanted an algo that rewarded
users in a complicated way, would there be someone that must tune it?"* — has
a complete first-principles answer. There are exactly four options for any
rule in the system:

1. **No one tunes it (immutable constants).** Robust against capture, fragile
   against design error. This spec has ~15 magic numbers (burn rates,
   distance weights, thresholds, caps, halving schedule). The probability all
   are right at genesis is ~zero, and immutability converts every mistake
   into a permanent exploit. Bitcoin gets away with this because its one
   number (21M) doesn't have to *measure* anything about human behavior.
2. **Token-holder governance tunes it.** Plutocracy plus reflexivity: the
   accounts profiting from a broken parameter vote on whether to fix it.
   Wash-miners of §2.1 would be the largest, most motivated voting bloc on
   any proposal to fix §2.1. Governance is acceptable only over a *small*,
   *slow* (timelocked) parameter surface where attack profit < capture cost.
3. **Social consensus + forks tune it** (Bitcoin/Ethereum in practice). Real,
   but only available once there is a large community and client diversity.
   Not a genesis option.
4. **Nobody has to tune it, because it isn't in consensus.** Move the rule to
   the indexer/client layer, where "tuning" is ordinary competition and users
   tune by *switching*. This is already the best idea in the current spec
   (per-indexer moderation policy, per-request feed ranking, spot-check
   verifiability) and it is independently validated by Bluesky's feed
   generator marketplace and Nostr's relay choice.

This yields the design rule the whole spec should be refactored around:

> **On-chain rules must be objective, simple, and boring (balances, burns,
> uniqueness, registries, stakes). Anything subjective — ranking, moderation,
> "quality", "contribution" — must live at the edge, where it competes
> instead of being enforced.**

The emission mechanism of §2.1 violates this rule, and that — not parameter
choice — is why it's gameable. No tuner fixes it, because it is a subjective
judgment placed in the money layer. Conversely, feed ranking needs no
decentralized tuner at all, because it was correctly placed at the edge.

And one honest corollary: at genesis, someone *will* hold tuning power —
the contract deployer who seeds genesis accounts already exists in this spec.
Every credible "decentralized" network (Bitcoin included) began with a
centralized steward and decentralized progressively. The credible plan is not
to deny this but to constrain it: an explicit foundation/steward role, a
minimal timelocked parameter surface, published sunset triggers, and
immutability endgames. Fake genesis-decentralization is how projects end up
*permanently* centralized while claiming otherwise.

---

## 4. The social graph: the problem is not where it seems

The prompt worries that decentralization makes it "hard to force a single
source of truth for social graphs." Decompose it:

**The forward graph is trivially decentralized.** "A follows B" is a
statement owned by A. A's signed, versioned follow list under A's key *is*
the single source of truth — no consensus needed, because there is exactly
one author. The current spec already has this right (FollowList scratchpad).

**The reverse graph is inherently an index.** "Who follows B" requires
scanning everyone's lists — always an aggregation product. Signed edges give
it a one-sided guarantee: an indexer *cannot fabricate* a follower (it can't
forge A's signature) but *can omit*. Omission is detectable by cross-checking
indexers — the spot-check design generalizes here. This is a good trust
model; document it as such.

**The real problems are two others:**

1. **Scoreboard integrity.** Keys are free, so follows are free, so follower
   counts are Sybil-inflatable to meaninglessness — and the count is the
   status currency that makes a social network a game worth playing. There is
   no clean decentralized fix (that's the same "is this a distinct human"
   oracle that broke §2.1). Practical mitigations, all at the indexer layer:
   display *trust-weighted* reach (followers weighted by graph proximity to
   the viewer, or by invitation-tree citizenship, or by fee-paying activity)
   rather than raw counts; expose raw counts as the verifiable number and
   weighted reach as the meaningful one. Different indexers will weigh
   differently — that is acceptable, the same way §3 makes moderation
   acceptable.
2. **The moat was never the graph data.** ATProto, Nostr, and Farcaster all
   achieved portable graphs; none dethroned X, because X's lock-in is the
   unified attention arena and its inhabitants, not the edge list. Making the
   graph portable is *necessary* (it lowers switching cost into Y and,
   symmetrically, out of it — that exit right is a feature users can trust)
   but it is not the growth engine. The growth engine is §8.

Also honestly missing from the current spec, and all part of "what X is":
DMs (with real E2E encryption — harder than it looks with BLS identity keys),
media storage economics (images/video dominate storage cost), notifications,
and real-time delivery. None are blockers for a spec, but the architecture
should name where they will live (all four are edge-layer services).

---

## 5. What the token can honestly be

Split every token flow into two categories:

- **Money moving through the network** (user → user, user → burn): tips,
  fees, rents. Gaming these is pointless by construction — wash-tipping your
  own money costs fees and mints nothing.
- **Money minted by the network** (protocol → user): emission. Whatever the
  emission points at becomes a mining target (§2.1). Emission is only safe
  when it points at **objectively verifiable work** or at **nothing social
  at all** (pure schedule).

So Y's honest value model, requiring no social oracle anywhere:

1. **Fixed supply** (keep 21M — scarcity is the point) with most or all of it
   in existence per a dumb schedule, not a social-metric faucet.
2. **Fee sinks tied to real usage** (all objective, all already in or near
   the current design):
   - Name registration + **renewal** burns (§2.8).
   - Invitation burns (keep — as a fee, not as Sybil-proof).
   - **Storage rent** for hosted mutable state / media pinning (Farcaster's
     model; also the honest anti-spam mechanism — cost on footprint, not on
     existence).
   - **Promotion burns**: pay-to-amplify, destroyed, no return path. This
     replaces the bonding curve's "skin in the game" role without the
     pyramid (it is an ad fee, not an investment).
3. **Tipping as the social-money primitive** (replaces donation-emission):
   peer-to-peer transfers with a small flat burn. Zaps on Nostr demonstrate
   this works and stays un-gamed *because nothing is minted against it*.
   Tips can still drive edge-layer ranking — an indexer may rank by tips
   received — and Sybil tip-inflation there costs real money per unit of fake
   signal with no mint to recoup it, so it becomes ordinary paid promotion.
4. **Staking for service roles**: indexers (and later relays/gateways)
   register on-chain by staking Y; provable misbehavior (spot-check proof of
   fabrication — signed data makes fabrication *cryptographically provable*)
   slashes. This creates token demand proportional to service-layer activity
   and gives the verifiability story teeth.
5. **Governance** over the deliberately tiny timelocked parameter surface
   (§3).

Result: token value ≈ f(usage) through burn pressure and staking demand —
"a life of its own iff the network lives," which is exactly the stated goal,
achieved without a single subjective on-chain measurement.

If targeted emission is still wanted, the only defensible targets are
verifiable-work roles (storage proofs, indexer uptime/coverage proofs — the
Filecoin/Helium pattern), and note that even those ecosystems fought years of
proof-gaming. Emission toward "good content" should be treated as falsified
by both theory (§2.1) and history (Steemit).

## 6. Rewarding early adopters without creating a mine

Four mechanisms, composable, none requiring a social oracle:

1. **Time-based cheapness (the Bitcoin model).** Early believers acquire Y
   when it is cheap and worthless; appreciation is the reward. Zero
   mechanism, zero gaming surface. This is genuinely most of the answer.
2. **Referral fee-share (novel-ish, fits the existing invitation tree).**
   An inviter receives x% (say 10%) of the protocol *fees* their **direct**
   invitees burn (names, renewals, storage rent, promotion) for the
   invitee's first N years. Properties:
   - Objective and on-chain measurable — no oracle, no tuner.
   - Rewards exactly the behavior that grows the network: recruiting users
     who *actually use it* (fee-paying = usage, unfakeable at a profit:
     routing your own fees through a Sybil invitee returns 10% of money that
     is 100% yours — a strict loss).
   - Depth-capped at 1 (direct invites only) so it is a referral program,
     not an MLM.
   - Converts the invitation tree from a broken Sybil defense (§2.2) into a
     growth engine, which is what invitation systems are actually good at.
3. **Retroactive rewards with an honest custodian.** Periodic distributions
   to contributors decided by the explicitly-named, sunsetting foundation of
   §3 (the Optimism RPGF pattern). Centralized, yes — *visibly and
   temporarily*, which beats a "decentralized" algorithm that is secretly a
   mine (§2.1) or secretly tuned (§2.2's oracle).
4. **Genesis allocation with long lockups** for founders/builders/seed
   community — standard, should be published in the spec rather than left
   implicit in "genesis accounts seeded by contract deployer."

## 7. Keep / Kill / Change

| Verdict | Item | Why |
|---|---|---|
| **Keep** | Two-layer split: minimal objective chain + content off-chain | Correct consensus-minimization (§3) |
| **Keep** | Signed content, content addressing, derived-key scheme | Sound; enables fabrication-proofs |
| **Keep** | Verifiable indexers + spot-check API | The best idea in the spec; extend proofs to omission-detection and slashing (§5.4) |
| **Keep** | Per-indexer moderation sovereignty, client-chosen ranking | Subjectivity at the edge — the §3 rule done right |
| **Keep** | Fixed 21M supply | Scarcity narrative; harmless |
| **Keep** | Invitation tree *as data* + invite fee | Accountability + growth engine (§6.2) |
| **Kill** | Donation-weighted emission | Provable mining equilibrium at D≈20E (§2.1) |
| **Kill** | Graph-distance donation weighting | Inverted incentives; on-chain infeasible; oracle smuggling (§2.2) |
| **Kill** | Bonding curves on posts | Negative-sum pyramid; Howey exposure (§2.3) |
| **Kill** | Mandatory bond-to-post | Cold-start killer (§2.4) |
| **Change** | Donations → tips (transfer + small flat burn, one-time sender keys) | Un-mineable social money (§5.3); privacy (§2.7) |
| **Change** | Anti-spam → storage rent + edge-layer filtering + trust-informed rate limits | Cost on footprint, not existence (§2.4, §5.2) |
| **Change** | Names: add renewal fees + expiry recycling | Squatting, ongoing sink, key-loss recovery (§2.8) |
| **Change** | Moderation eligibility → stake-or-age based, minimum amounts; accuracy only from resolved reviews; overturn nullifies (not subtracts); reviewer accountability | §2.5 |
| **Change** | Identity: add key rotation + social recovery registry on-chain, *before* freezing data-layer signature assumptions | §2.6 |
| **Add** | Explicit steward/foundation role with timelocked minimal parameter surface and published sunset | §3 |
| **Add** | Promotion-burn primitive | Replaces bonding's legitimate use (§5.2) |
| **Add** | Referral fee-share on invitation tree | Early-adopter reward, un-mineable (§6.2) |
| **Add** | Illegal-content answer at the storage layer | §2.5, non-optional legally |
| **Acknowledge** | DMs, media economics, notifications, real-time as named edge-layer services | §4 |

## 8. The questions no mechanism can answer (decide these first)

1. **Who is user #1,000, and what do they suffer on X?** "Better X" is not a
   wedge. Censorship-exposed communities, crypto-native finance-adjacent
   discourse, creators demonetized by platform whim, communities banned by
   payment processors — pick one for whom decentralization is a *felt need*,
   and design the first client for them. Every surviving decentralized
   network (Nostr included) grew from such a wedge, not from ideology.
2. **Which chain?** An own L1 means bootstrapping consensus security *and* a
   social network simultaneously — two cold-start problems multiplied. An
   established L2 gives sub-cent fees without that. (Sub-cent matters: a
   $0.02 tip with $0.50 gas is not a product.) Same decision needed for
   Autonomi vs IPFS vs both behind the existing trait abstraction.
3. **Does emission need to exist at all?** Fixed supply + fee sinks +
   referral share + genesis allocation may be the entire economy. Every
   emission mechanism added after this review must pass the test: *does it
   point at something objectively verifiable?*
4. **Are we willing to be visibly centralized for 2–3 years** with a
   published decentralization schedule? (The alternative is being invisibly
   centralized indefinitely.)
5. **Who builds and funds the flagship client?** Protocols don't win users;
   clients do. This is a legitimate use of a genesis treasury allocation.

---

*Summary of the single most important refactor: move every subjective
judgment out of the money layer. The chain keeps balances, burns, names,
stakes, and the invitation registry. Humans and markets — clients, indexers,
and a sunsetting steward — keep everything that requires taste. The current
spec already discovered this principle at the indexer layer; the token design
just needs to obey it too.*
