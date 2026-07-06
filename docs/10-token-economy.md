# Token Y: Economy, Functions, and Distribution

Builds on doc 09. Premise accepted from that review: **the money layer
measures nothing subjective.** That single constraint is what makes the three
winning properties simultaneously achievable:

1. **Alignment** — users who make Y grow hold the asset that grows.
2. **No arbitrary changes** — possible only because no rule needs a tuner
   (nothing in the money layer requires human judgment to keep working).
3. **Predictability** — fixed supply, published schedule, deterministic
   formulas, no admin keys over monetary rules.

Note the causality: predictability is not a marketing choice, it is a
*consequence* of removing subjective measurement. Any mechanism that needs
tuning (doc 09 §3) cannot be promised immutable; any mechanism that is
immutable but mismeasures becomes a permanent exploit. So the monetary core
must be small, dumb, and objective — then it can be carved in stone.

---

## 1. The four functions of Y

### 1.1 Social money — tips

The atomic social-economic act: a tip is a transfer of existing Y from fan to
creator with a small flat burn (e.g. 1%).

- Nothing is minted against tips, so wash-tipping is strictly pointless: you
  pay the burn to move your own money. (Contrast doc 09 §2.1.)
- Tips are the honest replacement for the "like with value": a costly signal
  that is costly *because it is money leaving your wallet*, not because a
  protocol formula says so.
- Tips are also legitimate edge-layer ranking fuel: an indexer may rank by
  tips received. Inflating your own rank via self-tips is then just paid
  promotion at full price — an ad buy, not an exploit.
- Privacy: tips SHOULD be sendable from one-time derived keys (doc 09 §2.7)
  so the public ledger shows flows without a linkable donor identity by
  default.

### 1.2 Resource money — fees (all burned)

Y is the only asset accepted for the network's scarce resources. All of these
are **pure burns** with deterministic, immutable price formulas:

| Sink | What it prices | Notes |
|---|---|---|
| Name registration | global uniqueness | tiered by length (as in doc 03) |
| Name **renewal** | continued exclusivity | annual; lapse → name recycles (fixes squatting + lost keys, doc 09 §2.8) |
| Invitation | account creation externality | flat; also the referral-attribution event (§3.3) |
| Promotion | attention amplification | pay-to-boost, burned, no return path — replaces bonding curves (doc 09 §2.3) |
| Service registration | entry to staked-service registry | flat, anti-squat for the registry itself |

Deliberately **excluded** from protocol fees: joining, posting, following,
tipping eligibility. Costs sit on amplification and scarce namespace, never
on existence (doc 09 §2.4).

### 1.3 Security money — staking

Indexers (later: gateways, media hosts) register in an on-chain **service
registry** by staking Y:

- The stake is the service's bond of honesty. Because all content is signed,
  *fabrication is cryptographically provable*: an indexer that serves a post
  or follow-edge that verifies against no valid signature can be slashed by
  submitting the fraudulent response (signed by the indexer's registry key)
  to the registry contract. Slash: part burned, part to the prover.
- Omission and ranking bias are NOT slashable (they are not provable and not
  objective) — those remain market-disciplined by client switching, per
  doc 07's trust model. The stake only enforces what can be proven.
- Effect on the economy: staking locks supply in proportion to service-layer
  activity, and gives Y demand that scales with network usage rather than
  speculation alone.

### 1.4 Bootstrap equity — the distribution itself

Early users acquire Y cheaply (by earning tips, collecting rebates, referral
annuities, or buying early). Appreciation via the burn/stake loop is the main
early-adopter reward — the Bitcoin model, and the only reward channel with
literally zero gaming surface. Everything in §3 is engineered so that its
*fully-adversarial* outcome is still acceptable (§3.1).

### 1.5 What Y deliberately is NOT

- **Not a governance token over money.** There is no vote that can change
  supply, schedules, burn rates, or slash conditions. Upgrades happen by
  deploying *new opt-in contracts* that clients and indexers choose to honor
  (versioning + adoption = fork-choice governance). This is what "not subject
  to arbitrary changes" means mechanically: there is no lever, so no one can
  be pressured to pull it.
- **Not a claim on content revenue.** Y does not entitle holders to anyone's
  earnings; that keeps creators sovereign and keeps Y further from a
  security-like profit-share.
- **Not required to read.** Consuming the network is free forever; Y gates
  writing-with-amplification and service provision only.

### 1.6 The value loop (and its honest weak point)

Usage → fee burns + stake lockups → supply shrinks / floats less → holders
gain → early users are the largest holder class among actual humans → they
recruit (referral annuity, §3.3) → more usage.

Weak point to state honestly: a pure medium-of-exchange token has a
**velocity problem** (recipients sell immediately, holders never need to
hold). The counters are structural: burns (supply decays with usage), stakes
(supply locked by service demand), prepaid renewals (supply parked in
namespace), and the psychological one — tips received feel like earnings and
are held by default. If usage grows and velocity stays finite, the loop
closes; if the network doesn't grow, no tokenomics saves it (§5, doc 09 §8).

---

## 2. The monetary constitution (immutable at genesis)

Carved in stone, verifiable by anyone, admin-keyless:

1. Total supply: **21,000,000 Y** (6 decimals), all accounted for in §3. No
   mint function exists outside the distribution schedule.
2. Distribution schedule: fully deterministic (§3.2), block-based epochs,
   no discretionary faucet anywhere on-chain.
3. Burn rates and fee formulas: fixed constants (tip burn, name tiers,
   renewal, invite, promotion unit, registration).
4. Slashing conditions: closed list of cryptographically provable faults.
5. Referral terms: fixed percentage, fixed duration, depth 1 (§3.3).

Anything not on this list is either **versioned** (new sinks/roles via new
opt-in contracts) or **off-chain entirely** (ranking, moderation, clients —
doc 09 §3). The treasury (§3.4) holds *allocated tokens*, not levers: it can
spend its budget, never alter rules.

---

## 3. Distribution of the 21M

### 3.1 The design test for every channel

> **Assume every distribution channel is attacked by a rational, well-funded
> adversary from block 1. The channel is acceptable only if its fully-gamed
> equilibrium is still an outcome we'd accept.**

Doc 09 §2.1 failed this test (equilibrium: emission captured by wash-miners,
signal destroyed). Every channel below passes it — the worst case of each
degrades into "a token sale at market price" or "a fee discount for early
users," never into theft or signal corruption.

### 3.2 Allocation (strawman numbers — ratios are the proposal, exact values to be debated)

| Bucket | % | Amount | Mechanism | Unlock |
|---|---|---|---|---|
| **Usage rebate pool** | 30% | 6.3M | pro-rata fee rebate per epoch (§3.2.1) | ~12y, halving every 2y |
| **Service provider pool** | 10% | 2.1M | per-epoch to staked, proven-live indexers (§3.2.2) | same schedule |
| **Treasury** | 20% | 4.2M | client dev, grants, retroactive rewards (§3.4) | 5y linear; **unspent burns at y8** |
| **Founders/team** | 15% | 3.15M | genesis grant | 1y cliff, 4y vest |
| **Liquidity + public sale** | 15% | 3.15M | DEX liquidity + open sale at genesis | immediate |
| **Genesis community drops** | 10% | 2.1M | retroactive drops by treasury during bootstrap | sunsets at y3; remainder → burn |

Why a usage-linked pool at all, given §1.4 says appreciation is the main
reward? Because a network where only buyers hold tokens aligns *investors*,
not *users*. The two on-chain pools put Y specifically into the hands of
people who used and served the network — the alignment pillar made literal —
and they are the two channels engineered below.

#### 3.2.1 Usage rebate pool — distribution by fees burned

Each epoch, a scheduled drop `D(epoch)` (halving every ~2 years) is
distributed **pro-rata to Y burned in protocol fees that epoch** (names,
renewals, invites, promotion — the §1.2 list, with one exclusion below).

Adversarial analysis, in full:

- Identity is irrelevant: splitting your fee-burning across a thousand Sybil
  accounts changes your pro-rata share not at all. **Sybils gain zero.** No
  personhood oracle needed anywhere.
- The only "attack" is burning fees purely to harvest the drop. That is
  profitable while `D > total_fees_burned`, so fee volume inflates until
  `total_fees ≈ D`. At that equilibrium the marginal harvester pays 1 Y of
  fees for ~1 Y of drop: they are **buying tokens from the protocol at
  market price** — a continuous, permissionless auction. Acceptable outcome.
- Side effect on genuine users: while `D > fees`, real usage is rebated at
  >100% — i.e. **names, invites, and promotion are effectively free-to-
  negative-cost in the early network**, decaying smoothly toward full price
  as adoption grows. That *is* the early-adopter subsidy, expressed as a
  formula instead of a judgment.
- Precedent honesty: this rhymes with FCoin's "trans-fee mining," which
  died. The differences are load-bearing: FCoin rebated *fiat-denominated
  trading fees* with an uncapped mint and no sinks — a money pump. Here the
  harvester burns Y to receive scheduled Y (circular, capped by the halving
  schedule), and Y has independent sinks. The failure mode is bounded to
  "the pool was sold at market price."
- **Exclusion rule:** only *pure burns* count. Resource-consuming fees
  (storage rent, anything that makes the network do work per fee paid) are
  NOT rebate-eligible — otherwise the harvest equilibrium manufactures spam
  load (junk storage, junk registrations that cost the network real
  resources). Name fees are borderline (squat-harvesting) — mitigated by
  renewal burns being rebate-*ineligible* after year 1 of any given name, so
  harvesting namespace has a carrying cost. This exclusion list is part of
  the immutable constitution (§2.3).

#### 3.2.2 Service provider pool

Per-epoch drop split among registered, staked indexers that posted validity
proofs for the epoch (liveness attestations + answered spot-check challenges
sampled from chain randomness). This is emission attached to *verifiable
work* (doc 09 §5) — the Filecoin/Helium pattern, kept deliberately small
(10%) because service-proof gaming is a known arms race. Worst case: lazy
indexers run minimal honest infrastructure to farm the pool — which still
adds redundant serving capacity. Acceptable degradation.

#### 3.2.3 What is deliberately absent

No emission points at donations, likes, followers, content, engagement,
"quality," or any other social quantity. Not because those don't matter —
because minting against them destroys them (doc 09 §2.1). Social value flows
through Y as *tips* (existing supply changing hands), never out of the mint.

### 3.3 The referral annuity (distribution amplifier, not an allocation)

The inviter of an account receives **10% of the protocol fees that account
burns during its first 4 years** (direct invites only, depth 1; paid from the
fee before the remaining 90% burns).

- Costs the supply schedule nothing — it redirects fees, it doesn't mint.
- Objective, oracle-free, and unfakeable at a profit: routing your own fees
  through a Sybil invitee returns 10% of money that was 100% yours.
- This is the "smart distribution to early adopters" criterion made concrete:
  the people who build the network's population own annuities on its usage —
  and the annuity is worthless unless the invitee *actually uses* the
  network, so recruiting quality beats recruiting quantity.
- Depth 1 + fixed 10% + fixed term keeps it a referral program, structurally
  incapable of MLM dynamics (no compounding tree income).

### 3.4 The honest centralized components, with expiry dates

Two buckets involve human judgment, and both are engineered to disappear:

- **Treasury (20%)**: funds the flagship client, infrastructure grants, and
  audits. It holds tokens, not powers (§2). Its discipline is the burn
  clause: unspent balance is destroyed at year 8, so it cannot become a
  perpetual foundation.
- **Genesis community drops (10%)**: retroactive rewards to early
  contributors/users decided by the treasury during years 0–3 (the Optimism
  RPGF pattern). This is the bootstrap-era answer to "reward early adopters
  by criteria too subjective for a formula" — done by a visible, named,
  expiring party instead of a gameable algorithm. Sunsets at year 3;
  remainder burns.

Everything else — 70% of supply — distributes by formula or market from
block 1.

### 3.5 Day-one user onboarding (how a normal person first touches Y)

1. Their inviter burned the invite fee and typically gifts them pocket Y
   (client default: "invite + starter tip" as one action) — rational for the
   inviter, who owns the referral annuity on this person's future fees.
2. Reading is free; posting is free; earning tips requires nothing.
3. First Y earned via tips received; first Y bought via the DEX pool only if
   and when they want a name or promotion.

No step requires an exchange account before the network has demonstrated
value to the user.

---

## 4. Why this wins against X (the three pillars, restated mechanically)

| Pillar | X | Y |
|---|---|---|
| Alignment | Value accrues to $TWTR/xAI shareholders; users are inventory | Users, inviters, and service operators hold the appreciating asset; 40% of supply reaches them by formula, more via tips/sale |
| Arbitrary change | API pricing, reach algorithms, monetization terms, bans — changeable overnight by one owner | Monetary constitution is admin-keyless and immutable; subjective layers are per-indexer *choices* users can exit individually |
| Predictability | Platform risk is unhedgeable | Supply, schedule, fees, slash conditions are computable to the year 2040 by anyone |

And the fourth, implicit pillar from doc 09 §4: **exit rights**. Identity,
graph, and money are user-held; the worst any indexer, client, or the
treasury can do to a user is inconvenience them into switching providers.

## 5. Open decisions

1. **Exact allocation ratios and constants** (§3.2 numbers are strawmen; the
   *structure* — pass/fail under §3.1 — is the proposal).
2. **Sale mechanics** (fixed-price, LBP, or auction) and jurisdictional
   review — a utility-shaped token with fee sinks and no profit-share is
   deliberately far from Howey, but §3.2.2/§3.3 need counsel review.
3. **Chain choice** (doc 09 §8.2) — sub-cent fees are a hard requirement for
   tip-sized transactions; this decides L2 vs app-chain before any contract
   is written.
4. **Epoch length and halving cadence** — pick once, forever (constitution).
5. **Whether the service pool ships at genesis** or activates in a later
   versioned contract once spot-check proof formats are battle-tested
   (recommendation: later; start with 40% usage-rebate pool split 30/10 held
   in a timelocked reserve for it).

*One-line summary: Y is social money + resource money + security money on an
immutable monetary constitution; it distributes 70% by formula and market
(fee rebates that Sybils can't game, service proofs, sale, schedule), 30% by
visible humans whose mandates expire and unspent balances burn — so early
adopters are rewarded by cheap acquisition, fee subsidies, referral
annuities, and appreciation, and nobody, ever, has a lever to change the
rules.*
