> **NON-NORMATIVE PROPOSAL, pending founder decision.** Nothing here changes docs 00–12 until
> accepted. Produced 2026-09-29 by three rounds of Claude Fable 5.1 × GPT-6 Astra (reasoning effort
> xhigh). Astra was kept blind to this repo during the pillar rounds, so the pillars are
> first-principles, not a defence of the existing spec. The comparison with docs 00–12 (§3–§5) and
> proposal P7 are Claude's alone.

# First-Principles Pillars Review

## 1. The "algorithm" question

There is no network-wide algorithm, and there should not be one. A feed is consumed by exactly one
person, so ranking needs no consensus (doc 09 already says this; both designers re-derived it
independently). What replaces "the algorithm" is three layers:

| Layer | What it is | Who runs it |
|---|---|---|
| Signals | Every follow, repost, quote, reaction and tip is a public signed object | Nobody; it is a commons |
| Recall | Which posts could reach you. Your attention is a **conserved budget** that flows along edges you authorized | Competing indexers, verifiable |
| Ranking | Which of those you see first, using public features plus private local history | Your device |

The new idea is the **conserved attention budget with a verifiable why-path**. 80% of the default
feed is split among sources the viewer chose; each source divides *its existing share* among its own
posts, reposts and quotes and the accounts it follows, at most two hops, cycles stopped. 20% is
exploration supplied by competing topic indexers and labelled as such. Creating a thousand accounts
cannot raise anyone's share, because splitting a budget never increases it. Every item carries the
path that put it there ("via you → Alice → repost"), recomputable from public signed objects.
Limits, stated honestly: this bounds outsiders, it does not stop trusted accounts from colluding or
selling endorsements; and the default client chooses a new user's first sources, so it holds
acknowledged cold-start influence that portability limits but does not remove.

## 2. Converged pillars

1. **X-class public conversation with free basic participation.** Reading, posting and reacting
   need no token balance and no purchased name. Growth comes from readable public URLs, replies
   and sharing, seeded by communities with a recurring reason to talk.
2. **Identity and relationships survive any application or host.** Stable identifier, rotatable
   keys, explicit recovery, signed social records, exportable archives.
3. **The token is distributed by a fixed historical snapshot with declining wall-clock vesting.**
   Eligibility is a real sunk cost or age, provable from public chain data before a cutoff already
   in the past. Weekly claimable tranches; missed tranches are never minted; unvested entitlement
   can be voluntarily split with newcomers (conserved, so self-splitting creates nothing).
4. **Eligibility is reproducible and any treasury is explicit and bounded.** Dataset, rule, Merkle
   root and concentration analysis are published before deployment.
5. **No reward is ever minted from in-network activity.** Tips pay creators; a small protocol fee
   is burned; a per-transaction facilitator fee pays whoever built the client or indexer. No
   engagement emission, no creator-volume pool, no token vote over protocol rules.
6. **The default feed allocates conserved attention using ordinary social actions** (§1).
7. **Ranking belongs to the viewer; candidate generation is competitive.** A ranker is weights plus
   a declared feature schema run by a fixed client runtime, never code.
8. **Availability and historical authentication need funded, replaceable hosts.** No named storage
   network. Hosts batch timestamp anchors; after a key revocation, old-key objects are valid only
   with an anchor proof from the key's valid interval.
9. **Moderation and onboarding protect users without permanent gatekeepers.** Signed labels,
   blocks applied before ranking, hosts enforce their own rules. Invitations are recipient-accepted
   context. Sender-funded tips to a supported foreign key onboard the recipient.
10. **The immutable protocol stays small and expansion is explicit.** Canary deployment before the
    main one; new mechanisms (personhood, for example) arrive as successor versions with opt-in
    migration, never as administrative upgrades.

The lemma underneath 3 and 5: an attacker can play every role, so any rule that pays rewards as a
function of in-network actions can pay a coalition at most what that coalition irrecoverably spent
producing them. Such a rule is either a rebate smaller than the fee or it is farmed. Only an anchor
outside the system (pre-existing history, personhood, capital × time, accountable discretion) can
carry a net-positive distribution.

## 3. Findings in the current spec

### F1 (critical). The Reward Pool is a one-way sink and the Treasury becomes the main distributor

`EMISSION_MATCH_CAP_BPS (4%) < DONATION_FEE_BPS (5%)` makes washing a guaranteed loss, as intended.
The macro consequence was not drawn: in aggregate creators can never receive more than 4% of
donation volume while donors pay 5% of it, so on the creator side the pool is a net taker in
every epoch. Scheduled emission that the cap cannot release accrues to the pool too (03 §A). The
only net outflow is the treasury slice, 15% of a 2% drip of the *pool balance* (03 Reward Pool),
which is not subject to the cap. It ends at epoch 260, after which the pool only grows.

Simulation: `docs/proposals/pool_sim.js` (`node docs/proposals/pool_sim.js`). Assumptions favour
creators: every donation at pairwise weight 1.0 and every creator paid exactly at the cap, an
upper bound on what the spec's single-pass clip releases. Two simplifications, neither of which
changes the conclusion: the Treasury spends at most 2% of its balance per epoch, and donations
weight the same epoch's emission rather than the next. One epoch ≈ one week (inferred from
`TREASURY_TERM_EPOCHS = 260` ≈ 5 years; the spec never states the length). Figures in billions
of Y.

| Scenario | Treasury receives (cum.) | Creators receive (cum., epoch 520) | Fees paid (cum., epoch 520) | User float at epoch 260 → 416 → 520 |
|---|---|---|---|---|
| A: 10% of float donated weekly, treasury hoards | 57.8 | 2.3 | 2.8 | 1.1 → 0.9 → 0.8 |
| B: same, treasury spends 2%/epoch | 58.5 | 66.4 | 83.0 | 43.3 → 47.4 → 42.8 |
| C: 100% of float donated weekly, treasury spends | 63.0 | 242.1 | 302.7 | 22.9 → 9.4 → 3.3 |
| D: B plus rent and invite fees | 59.8 | 50.0 | 87.5 | 36.7 → 31.7 → 23.2 |

Consequences:

- The Treasury receives **58–63B Y, 41–45% of the 140B cap**, in every scenario. The spec
  describes it as a time-boxed slice and "not a premine"; it is in effect the largest allocation.
- Creators receive less than they pay in fees in every scenario, by construction. The emission
  does not bootstrap anything; it is a 4% rebate on a 5% fee.
- User float exists almost only because the Treasury spends. Once that stops (the slice ends at
  epoch 260, and unspent balance returns to the pool at 416) the float only shrinks. This is the
  deflationary trap 03 §Economic Design set out to avoid, and "no burns" is true only nominally.
- The halving schedule no longer shapes who gets what. It determines how fast the pool fills.
- At launch the whole float is the epoch-0 split among the deployer-seeded genesis accounts
  (count unspecified in 01/03).

### F2 (high). Global donation signals sell reach at the fee rate

A donation is a "pure loss for the donor" (03 §B) only when donor and creator are different
people. When one party controls both, displaying X of donations costs the 5% fee minus up to 4%
match: **1–5% of X**. The `donated` candidate source (07 Candidates: top recently-donated posts
network-wide) and the `total_donated` / `unique_donors` features (09 Starter model) therefore let
money buy network-wide discovery, which contradicts the anti-pay-for-reach rule in 07 Donor
Recognition.

### F3 (high). Four taxes on growth

| Friction | Where | Effect |
|---|---|---|
| Every like is an on-chain payment (`MIN_DONATION` 0.01 Y); no free reaction object exists | 03 §B, 01 | A 5 Y starter grant is at most 500 likes, then the user cannot react. Sparse signal starves the ranker |
| Inviting costs 100 Y and returns nothing | 05 | A newcomer holding 5 Y cannot invite anyone. Each honest invite pays the sybil tax |
| Readers pay indexers in Y, per query or by epoch subscription (a convention, not consensus) | 07 Indexer Economics | Reading is not free unless someone subsidises it |
| Long handles cost 1 Y/epoch | 03 §D | A 5 Y grant keeps a handle for 5 epochs plus 4 of grace |

The normative reference client is a CLI (08). The archived decision D7 chose a hosted web client
with passkeys; it never reached the normative docs.

### F4 (medium). Nominal prices frozen in a volatile unit

Invitation cost (100 Y), flat rent (1 Y/epoch), Harberger floors (10k / 100k / 1M Y) and
`MIN_DONATION` (0.01 Y) are constants in Y, and contracts are immutable (00). A 100× move in Y's
price in either direction makes them prohibitive or meaningless, and repricing takes a new
deployment plus opt-in migration.

## 4. What the current spec already gets right (keep)

| Area | Doc | Verdict |
|---|---|---|
| IdentityId, registry, rotation, guardian recovery with veto, the one validity rule | 01 | Matches pillar 2; more complete than either designer's sketch |
| No storage network, indexers store what they serve, clients keep originals, "replicability not permanence" | 12, 02 | Matches pillar 8. One scaling note: full replication by hobbyists holds to roughly Bluesky scale, not X scale; selective replication comes later |
| Merkle timestamp anchors, freshness anchor | 12 §4 | Keep. Astra first wanted them dropped, then accepted them as what makes revocation sound |
| Labels as a data format, all aggregation at the edge | 06 | Matches pillar 9 |
| Client-side ranking, ranker = weights + declared schema, no I/O | 09 | Matches pillar 7 exactly |
| Immutable contracts, no admin keys, migration by redeployment | 00 | Matches pillar 10; add the canary (P9) |
| L2 chosen at build time against binding criteria | 00 | Keep |
| Repost / quote primitive | 01 | Becomes the edge that spends attention budget (P4) |
| Retract tombstones, private donations via fresh keypair, honest GDPR note | 02, 03 | Keep |
| Harberger handles | 03 §D | Founder decision, not reopened. Only the fee destination (P2) and the frozen floors (P7) are touched |

## 5. Proposed changes

| # | Priority | Change | Replaces | Docs touched |
|---|---|---|---|---|
| P1 | Critical | **Snapshot entitlements.** Keep the 140B cap and a declining schedule (the existing halving curve can stay; only the recipient rule changes). Each eligible key gets an equal entitlement within its cohort, claimable in weekly tranches; unclaimed tranches are never minted; unvested entitlement can be split with newcomers | Donation-directed emission, Reward Pool, match cap, pairwise weights, lineage families, epoch-0 genesis split | 03 §A §C, 05, 01 epoch types, 00 contracts |
| P2 | Critical | **Fees: 1% of each canonical tip burned; facilitator fee 0–5% set per transaction by the originating client and authorised by the payer; name fees burned** | 5% donation fee into the pool; "no burns" | 03 §B, 07 Indexer Economics |
| P3 | High | **Free signed reaction object**, off-chain, no financial claim. Tips become a separate action and a capped, viewer-relative feature | "A like is a micro-donation" | 01, 02, 03 §B, 07, 09 |
| P4 | High | **Conserved attention budgets with why-paths** (§1). Remove the global `donated` source and raw donation totals from the default feature set; add a labelled 20% exploration slot | `donated` source, `total_donated` / `unique_donors` as global features | 09, 07 Candidates and Feed Builder |
| P5 | High | **Invitations become data.** A signed, recipient-accepted "A vouches for B" object used for cold-start context and the offered first follow. No invite fee, no on-chain tree. Sponsored gas and a newcomer's first name fee are paid by the client as acquisition cost, recouped from facilitator fees | InvitationTree contract, 100 Y invite fee, protocol paymaster gated by the tree | 05, 00 |
| P6 | High | **Reading is free.** Indexers and clients earn facilitator fees and sell bulk API access; reader-pays vouchers stop being the default | Per-query Y vouchers as the reference path | 07 Indexer Economics |
| P7 | Medium | **No frozen nominal prices.** Flat-tier rent set by a demand-targeting controller (price moves a fixed step up or down each epoch against a target number of registrations); Harberger floors expressed as multiples of it; `MIN_DONATION` removed. *Claude's proposal, not part of the Astra convergence* | Constants in Y | 03 §D |
| P8 | Medium | **Claimable tips to foreign keys.** Tip a supported pre-existing key (Ethereum address or ENS first); funds wait in escrow; the owner claims by signature; unclaimed escrow refunds to the sender after 30 days, no administrator. Unlocks no emission | New | 03, 00 contracts |
| P9 | Medium | **Canary deployment** with its own capped token before the immutable main deployment. The canary must show repeat conversation and voluntary tipping when claim reminders and price excitement are absent | New | 00 |
| P10 | Product | **Reference client is a web app with passkeys.** Every post and thread has a public URL readable logged-out; the weekly claim happens inside ordinary use | CLI as the only specified client | 08, new doc |

Contract count after P1–P8: YToken, EntitlementClaim, TipContract (with escrow), NameRegistry,
IdentityRegistry, AnchorLog, optional Treasury escrow. RewardPool, EmissionContract distribution,
DonationContract weighting and InvitationTree are removed.

## 6. Founder decision forks

**Fork 1. Who receives initial ownership.** Provisional shape from the convergence: 40%
Ethereum-history addresses (≥ 1 year of history and ≥ 0.01 ETH cumulative gas), 30% Farcaster ids
(≥ 180 days old), 20% ENS names (held ≥ 180 days), 10% treasury; equal share per eligible key
within a cohort; overlap across cohorts tolerated because it cannot be detected. Alternative: one
cohort, simpler but culturally and economically concentrated. Recommendation: three cohorts, with
thresholds and fractions validated against real population and concentration data before the root
is frozen. **Known cost: Nostr-only users, who sit inside the decentralization-first wedge (00),
are excluded unless they hold a qualifying Ethereum key**, because Nostr keys are free and their
timestamps do not prove age.

**Fork 2. Treasury.** Zero reserved supply (builders live on facilitator fees; audits and early
development need unpaid runway) or one disclosed operating entitlement capped at 10%, same
vesting, escrow whose remainder expires after five years, no protocol powers. Recommendation: the
explicit 10%. It is a quarter of what the current spec delivers by accident (F1). Limit stated
honestly: no contract can verify that a disbursement was really an operating expense.

**Fork 3. Burn.** The founder chose "no burns, all fees recycle" in the July 2026 harmonization. F1 is new
information: recycling to creators is a rebate below the fee or it is farmed, and the pool already
behaves as a burn. Options: (a) 1% burn, the only link between usage and token scarcity;
(b) no protocol fee at all, facilitator fee only. Recommendation: (a).

## 6a. Revision 2026-09-30: "like power" replaces P1–P3 (founder direction, Astra round 4)

The founder kept the snapshot for a **genesis** allocation only, and asked that newly created
tokens flow to quality accounts, old or new, through **one action** and **one token**. Mechanism,
after Astra's attack pass:

- **Stake Y → like power.** Deposit into the Like contract (7-day unstake delay; a withdrawal
  request stops regeneration on that amount). Power regenerates at `r` per epoch per staked Y up to
  24 hours' worth. Deposits start empty; moving stake never duplicates stored power. Power is a
  per-account meter, never transferable, never a token.
- **One button.** A like is a signed off-chain object (a ranking edge for everyone). For stakers it
  also spends 2% of current power. A plain Y transfer stays available from a menu.
- **Minting.** A weighted like mints `k(t) × power spent` to the creator; self-likes mint nothing;
  unspent power mints nothing. `k` is a **rate on staked capital** (Astra's starting point: 0.25%
  per week, halving every 104 weeks), not the absolute 1.4B/epoch schedule, which already sums to
  the whole 140B cap and leaves no room for a genesis allocation. Cumulative minting plus genesis
  is capped at 140B; burns never reopen mint capacity.
- **Fees recycle, no burn.** The 1% protocol fee funds the same rule from launch (separate
  accounting from minted rewards), allocated against **all eligible stake-time** so unspent power
  leaves the pool untouched.
- **Reach is never bought.** Exposure stays the conserved attention budget (§1); a whale's like pays
  the creator and reaches only the whale's own followers.
- **Newcomers.** Ranking weight immediately; money weight when they hold Y, or when a sponsor
  (inviter or client) authorises them to spend part of the sponsor's power budget. Delegation is
  conserved: all delegates debit the same allowance.
- **Curation.** No reward to earlier likers (a timing contest that invites prediction bots). If
  attribution is wanted: 10% of a like's mint goes to the repost or quote on the like's own
  why-path, out of that like's budget.
- **Settlement.** One batched transaction per staker per day, sponsored by the client; the contract
  computes accrual from stake and timestamps (supplied timestamps never set priority or rate),
  replay-protected, payouts rounded down, no minimum payout, constrained budgets allocated pro rata
  rather than first-come.

**Bound (Astra confirmed after the corrections above):** a coalition can direct at most
`k × r × its own controlled stake` per epoch, plus one day's carried power, whatever it does with
accounts or routing. **Equilibrium (Astra's hypothesis, not a measurement):** once harvesting tools
exist, most stake-directed issuance (its guess: over 80%) returns to stakers through second
accounts; creators receive what honestly-liking stake sends them. The honest description is
"holders may donate their inflation entitlement to creators". The canary's decisive metric is the
share of issuance reaching independent creators after harvesting tools appear.

Founder forks added: genesis-to-issuance split (Astra: 60/40; Claude: 30–40% genesis; the issuance
side is the harvestable one).

## 6b. Decisions taken 2026-09-30 and the removal list

Decided by the founder in discussion: **no payment to recommendation sources** (a like may still
carry a recipient list as a client convention, protocol enforces only that shares sum to the
budget); **aura** as a non-transferable status score computed by clients and indexers from public
likes, never feeding money or reach, its one scarce perk being extra invites; **invites scarce but
free**, quotas a client/host policy, since sybils gain nothing in the money or reach layers;
**invite-graph money weights removed** (they deter only lazy harvesters and tax honest friends).

**Fork 3 (burn) dissolves.** With like-power, fee recycling is safe because allocation is bounded by
stake, not by matching volume: fees flow to the pool, the pool releases a drip allocated against all
staked capital, unspent shares stay. Outflow scales with the pool, so it reaches a steady state
instead of sinking. The founder's original "no burns" stands.

What the current spec loses, for simplicity and robustness:

| Remove | Where | Replaced by |
|---|---|---|
| Donation-directed emission, `EMISSION_MATCH_CAP_BPS`, `distribution.rs`, single-pass clip | 03 §C, 01 EpochConfig | Like-power minting (§6a) |
| Pairwise weights, lineage families, `FAMILY_ROOT_DEPTH`, `BRANCH_FAMILY_EXPONENT`, LCA / ancestry machinery | 05 | Nothing; stake bounds the money layer |
| Invitation fee (100 Y), on-chain InvitationTree contract, trust distance | 05, 00 contracts | Signed, recipient-accepted vouch object; quotas at the edge |
| Absolute schedule (1.4B/epoch, halving every 50) | 03 §A | Rate on staked capital, halving, same 140B cap |
| Epoch-0 split to deployer-seeded genesis accounts | 03 §A, 01 | Snapshot Merkle-root genesis allocation |
| Treasury drip slice (`TREASURY_DRIP_SHARE_BPS`, term, reclaim) | 03 Reward Pool | Explicit, capped genesis entitlement if kept (Fork 2) |
| 5% donation fee, `MIN_DONATION`, the private-donation zero-weight construct | 03 §B | 1% protocol fee to the pool, facilitator fee 0–5%; a private tip is a transfer from any key |
| `donated` candidate source, `total_donated` / `unique_donors` as global features, `Donated` / `Blended` server rankings | 07, 09 | Conserved attention budgets; likes and tips as capped viewer-relative features; `Chronological` kept |
| Per-query Y vouchers as the reference read path | 07 Indexer Economics | Facilitator fees; vouchers optional for bulk API |
| Y-denominated constants (flat rent, floors) | 03 §D | Demand-targeting base price with fixed multipliers (P7) |

Untouched: identity and recovery (01), storage and anchoring (02, 12), labels (06), client-side
ranking runtime (09), Harberger mechanics (03 §D), retract tombstones, repost/quote.

Contracts after removal: YToken, Genesis claim, Like (stake, power, minting, fee pool), Tip (with
escrow and facilitator split), NameRegistry, IdentityRegistry, AnchorLog.

## 6c. Founder answers, 2026-09-30

| Item | Answer |
|---|---|
| Genesis cohorts and genesis-to-issuance split | TBD, needs population and concentration data |
| Treasury | Yes, as a piece of genesis: an explicit entitlement, same vesting, no protocol powers; size settled with the split (default ≤ 10%) |
| Canary parameters | Delegated to Claude; chosen below |
| Legal review | Deferred |
| First communities and the web client | TBD |

**Canary parameters (Claude's choice, starting values, tuned by the canary not by argument):**

| Parameter | Value | Reason |
|---|---|---|
| Self-liker yield `k × r` | 0.5% per week initially (≈ 30% a year compounded, at most) | Twice Astra's 0.25%: the founder's stated priority is bootstrap and early-adopter advantage, harvesting harm is bounded to dilution, and only spent power mints, so realised inflation sits well below the ceiling |
| Halving | every 104 weeks | Rate-based emission needs entry room beyond year one; the old 50-epoch period belonged to an absolute schedule |
| Spend per like | 2% of current power | About 35 rapid likes halve the meter; no hard wall |
| Power cap | 24 hours of regeneration | Daily use, no stockpiling |
| Unstake delay | 7 days; regeneration stops at the request | Blocks flash movement of stake |
| Fee pool drip | 2% of pool balance per epoch, allocated against all staked capital, unspent shares stay | Steady state, never a sink |
| Protocol fee / facilitator cap | 1% / 5% | As converged |
| Settlement | one batched transaction per staker per day | Sub-cent on the target L2 |

## 7. What neither designer solved

- **Product demand.** Distributing ownership to historical crypto users does not show that they
  will hold lasting public conversations or tip. Beneficiaries can automate claims and sell. The
  canary (P9) is the test.
- **Token demand is thin.** Tips, names and facilitator fees are modest sinks. If paid demand never
  develops the token thesis fails, whatever the distribution.
- **Later adopters receive no automatic token.** They benefit through a free product, tips they
  earn, and entitlement that holders choose to split with them. A per-person stream needs a
  personhood anchor; both designers rejected one for launch (identity-system dependency,
  complexity, legal exposure) and place it in a successor version.
- **Legal exposure.** A token distribution marketed as benefiting early adopters, a burn, and a
  spending treasury all carry securities-law risk that depends on jurisdiction. Counsel before the
  main deployment, and before any public language about returns.
- **Default-client concentration.** Almost nobody switches defaults. Portability limits that power;
  it does not remove it.
