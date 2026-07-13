# Proposal: Tri-Token Economy — Y / HEART / LIKES

**Status: exploratory proposal (non-normative).** This document captures a redesign of the
token economy developed through first-principles analysis of the current spec
([03-token-y.md](../03-token-y.md), [05-invitation.md](../05-invitation.md)). Nothing here is
adopted; it exists so the reasoning — including everything considered and rejected — survives.
If adopted, it would substantially rework docs 03/05 and touch 06/07/08.

---

## 1. Why revisit the current design

Analysis of the shipped spec surfaced three structural defects:

1. **Emissions cannot matter to creators.** The emission match cap (4%) must stay below the
   donation fee (5%) or wash-trading prints money. That invariant means emission is forever a
   ≤ ~4.2% top-up on donation income — a fee rebate, not a creator subsidy. The docs' framing of
   emission as "the creator subsidy that pays for curation" is unachievable under the cap, and the
   cap cannot be lifted without subsidizing wash loops.
2. **The circulating float drains permanently.** Apply the wash arithmetic to the whole network
   (itself a closed coalition): fees pull ≥ 5% of donation volume into the Reward Pool every epoch,
   while the capped channel releases at most 4% of *weighted* volume back out (the cap clips
   scheduled emission and drip combined). The donation economy is a net sink of ≥ 1% of volume per
   epoch, forever. After the treasury slice sunsets (epoch 260) there is no uncapped exit: circulating
   supply monotonically drains into the pool — the deflationary-hoarding trap the design explicitly
   set out to avoid, rebuilt in a different costume.
3. **One token cannot be both cash and equity.** Y must appreciate with the network (the way a
   new network beats an incumbent) *and* circulate at high velocity through likes (or curation dies).
   These are behaviorally antagonistic (Gresham/Thiers: people spend the depreciating asset and hoard
   the appreciating one). A like is a pure gift — the most deferrable spend that exists — so an
   appreciating like-token kills likes first. Empirical: Bitcoin tipping culture died as the asset
   appreciated. Single-token mitigations (demurrage, liquid/staked states, tiny denominations) each
   fail; see §12.

## 2. Architecture overview

Three assets, each with exactly one job:

| Asset | Nature | Supply | Job |
|---|---|---|---|
| **Y** | Growth asset (store of value) | Hard cap 140B, halving emission schedule (unchanged); deflationary via HEART-mint burns | Captures network growth. Hoarding is harmless and intended. Creators are paid in Y. |
| **HEART** | Capacity asset (perpetual membership) | Minted by spending Y (φ burned + (1−φ) locked); retired by unlocks, buybacks, and HEART sinks | 1 HEART yields a fixed allowance of `c` LIKES per epoch, forever. "Buy once, participate forever." Fully transferable. |
| **LIKES** | Consumable (the network's cash) | Issued each epoch by HEART allowances; **use-or-lose** (expire after `LIKES_TTL` epochs); burned by every economic action | Unit of account for all protocol prices. High velocity by construction. Fully transferable. |

Gresham's law now works *for* the design: people hoard Y, spend LIKES — likes flow precisely
because the spending asset is the one nobody wants to hold.

Normal users see none of this machinery: "daily likes: 47 remaining · handle rent: auto-paid."
They buy HEART or LIKES on the market (or receive starter grants); the Y layer is for the
economically interested, per the Venice observation (§13).

## 3. HEART minting and the arbitrage band

**Mint:** spend 1 Y → `MINT_BURN_SHARE` (φ, straw-man 30%) is burned and **recycled into the
creator-emission pool**; (1−φ) is locked in a per-address position; receive ρ(t) HEART.

**Unlock:** burn the same amount of HEART you minted (per-address bookkeeping; multiple mints use
your weighted-average rate — the Venice DIEM rule, which is the only redemption rule with no
money pump) → recover your locked (1−φ) Y. Partial unlocks allowed.

This produces two arbitrage trigger prices for HEART (in Y per HEART):

- **Mint ceiling `1/ρ`** — above it, mint-and-sell returns more liquid Y than spent, immediately
  and risklessly; arbs flood supply until the price is back under the ceiling. Every such mint
  pays φ into the pool.
- **Unlock floor `(1−φ)/ρ_vintage`** (per address, at *your historical* rate) — below it, buying
  HEART back and burning to unlock releases more Y than the HEART costs; arbs retire supply.

Between the two lies the **no-arbitrage band, whose width is exactly φ**. That is what the burn
share *is*: the space in which HEART has independent price discovery instead of being arb-welded
to Y (the failure of naive lock-mint designs, §12). Small φ → HEART tracks Y; large φ → more
independence, pricier capacity, bigger pool. φ is a launch-simulation parameter; start low and
ramp with adoption to avoid an early-network dead zone where minting never pays.

**The vintage ladder.** Because floors are per-vintage, controller rate increases progressively
drag the market below *older* vintages' floors, firing their buy-and-burn arbs oldest-first —
an automatic, staggered contraction mechanism requiring no altruism.

Worked round trip (ρ = 100, φ = 0.30): mint 100 Y → 30 burned to pool, 70 locked, 10,000 HEART.
Sell at 0.0130 (above ceiling 0.0100) → 130 Y banked (+30). Later HEART sags to 0.0050 (below
floor 0.0070): buy 10,000 for 50 Y, burn, unlock 70 (+20). End: 150 Y. The arb supplied capacity
when scarce and destroyed it when glutted; the pool kept 30 Y either way. Worst case after leg 1
is walk-away at +30 — which is why the ceiling is hard.

## 4. LIKES: allowance, expiry, transferability

- Each HEART yields `c` LIKES per epoch (`HEART_ALLOWANCE`), automatically.
- LIKES expire `LIKES_TTL` epochs after issuance (straw-man: 4). Expiry (a) forces velocity,
  (b) prevents stockpiling for burst attacks, (c) provides the controller's demand signal (§5).
  TTL must be multi-epoch, not instant: anyone *earning* LIKES (indexers, creators taking income
  in LIKES) needs time to spend or sell them — expiring money cannot pay salaries at TTL=1.
- LIKES are transferable. This creates a spot market for unused allowance, which **restores the
  costly-signal property**: every like spent is one you could have sold. Opportunity cost does the
  job the old design's "pure donor loss" did.
- All protocol prices are denominated in LIKES, making LIKES stable *in service units* by
  construction (the only stability available without an oracle; USD price floats and that is
  accepted — LIKES balances are meant to be small, arcade-token sized).

## 5. Monetary control system

The mint rate alone is a **one-sided instrument**: in a LIKES glut, HEART trades below parity, so
minting has already stopped and the rate dial is disconnected. Contraction needs separate, funded
instruments. The full system:

| Condition | Instrument | Funded by |
|---|---|---|
| LIKES scarce (utilization high) | Controller raises ρ (cheaper HEART) → mint arb expands capacity | Minters' Y (φ per mint → pool) |
| LIKES glutted (utilization low) | Vintage-ladder unlock arbs (free) + **pool buyback**: reverse auction, protocol buys HEART with pool Y and burns it (the OlympusDAO "inverse bond" shape) | The pool the booms filled |
| Always | HEART sinks: invitations burn HEART (fitting: growing the population that demands capacity costs capacity); optionally Harberger-tier rent | Users |
| Catastrophe | Circuit breaker: allowance floor — `c` may degrade in extreme sustained glut, never below `c_min` (e.g. 50%) | Pre-agreed haircut |

**Controller metric (oracle-free):** utilization `u = burned / (burned + expired)` per epoch,
EMA-smoothed, targeting `u* ≈ 0.85`. Expired-unspent LIKES are a direct, unfakeable oversupply
measure. Update: `ρ(t+1) = ρ(t) · (1 + k·(EMA(u) − u*))`, clamped per epoch; buyback auctions
trigger when EMA(u) stays below a lower band. Manipulating u means burning LIKES you could have
sold — costly and bounded, same profile as EIP-1559. Budget symmetry: minting booms (which create
future glut risk) automatically stockpile the Y that funds the eventual contraction.

The controller is not just monetary policy — **it is the anti-gaming perimeter** (§11): if LIKES
ever become free, emission direction becomes free. Controller failure = signal failure.

## 6. Creator rewards: burn-to-direct emission, uncapped

A like **burns** the donor's LIKES and directs the epoch's Y emission toward the creator, weighted
by the existing invitation-tree machinery (pairwise weights + lineage-family concavity from
[05-invitation.md](../05-invitation.md) — all of it survives unchanged). Key differences from the
current design:

- **No emission match cap, no 5% fee.** The cap existed because donation-directed emission with a
  creator pass-through needed `cap < fee` to make closed loops lossy. With burns, profitability
  self-regulates through open competition: everyone burning LIKES competes for the same fixed
  emission, so marginal emission value per weighted-LIKE converges to the LIKES' own cost, and
  tree-weight discounts push related-account wash strictly below margin. Creators receive **100%
  of emission** instead of a ≤4% rebate — fixing defect #1.
- **Perpetual funding.** The epoch emission pot = halving-schedule emission + recycled Y (the φ
  burned by every HEART mint). As the schedule fades, capacity demand funds creator rewards
  forever — fixing defect #2 (the flow is circular in Y-space with no capped bottleneck) and
  preserving the reason halving-to-zero was originally rejected.
- Creators may toggle auto-conversion of emission into HEART/LIKES at prevailing rates, so
  low-interest creators never handle the volatile asset.

Fair launch is preserved: Y is still 100% emitted to creators (schedule + recycling), no premine,
no sale. The Reward Pool's fee-recycling role is replaced by burn-recycling; the treasury slice
can persist as a time-boxed share of the emission pot exactly as today.

## 7. Fees and sinks map

| Action | Old (03) | New |
|---|---|---|
| Like/donation | 95% to creator, 5% fee → pool | 100% of LIKES **burned**; directs Y emission |
| Handle rent | Y → pool | LIKES burned; **auto-debited from allowance** |
| Invitation | Y → pool | **HEART burned** (steady organic HEART retirement) |
| Force-buy fee / floor excess / arrears | Y → pool | LIKES burned |
| Indexer query & media fees | Y to indexer | LIKES (multi-epoch TTL) or HEART to indexer — *payments, not sinks*; never force providers to hold same-day-expiring money |
| HEART mint | — | φ·Y burned → recycled to emission pool |

## 8. Names

The two-tier registry survives with two upgrades unlocked by the stack:

- **Rent denominated in LIKES** — rent finally has stable real cost instead of swinging with the
  growth asset (today a 10,000 Y floor changes meaning yearly).
- **Auto-pay from allowance** — rent debits from the holder's daily LIKES before anything else.
  Any HEART holder's handle is self-sustaining forever ("hold without worrying"), while a squatter
  with 10,000 handles bleeds real scarce LIKES every epoch. Harberger force-buy still prices
  premium short names; flat-rent safe harbor (≥7 chars) still protects ordinary users.

## 9. Invitations and starter grants

Invitations burn HEART. Starter grants (HEART and/or LIKES) come **from the inviter's own
balance** as a client convention — exactly like today's 5 Y grant — never protocol-minted.
Protocol-granted starter capacity would be a Sybil faucet; conservation is the Sybil defense
(inviting costs burned HEART + gifting costs your own holdings, so puppet armies are strictly
expensive).

## 10. Perpetual-participation product

"1 HEART = c LIKES/epoch, forever" is the sellable product (homeownership vs. rent; Venice DIEM
demonstrated real demand for perpetual capacity). Honest caveats: the fixed rate is defensible
*only* because the control system (§5) has real contraction authority; the circuit-breaker floor
converts an unkeepable absolute promise into a credible bounded one. Implicitly, holding enough Y
with a standing order self-manufactures the same product (if Y grows exponentially,
`Σ n/ρ(t)` converges — a finite Y holding funds participation forever); HEART securitizes that
bundle for people who want to pay once and stop thinking.

## 11. Anti-gaming: will creators self-like via Sybils?

The attack: a creator controls N accounts, acquires LIKES, and burns them on their own posts to
capture emission. Defense in depth:

1. **Cost is real.** LIKES are scarce (controller) and transferable (opportunity cost). There is
   no free wash inventory; expiry prevents stockpiling cheap LIKES for bursts.
2. **Tree weights (unchanged from 05).** Self-likes: weight 0. Puppets sit in the attacker's
   subtree: 0.25 (ancestor/descendant) or 0.5 (siblings), and *all* collapse into one lineage
   family flattened by `^0.5` — splitting across more puppets buys nothing (the worked examples
   in 05 apply verbatim). Each puppet also costs a burned-HEART invitation.
3. **Competitive dilution.** Emission per weighted-LIKE, `e = E / Σ weighted burns`, is
   arbitraged: if e ever exceeds the LIKES cost, more burning floods in (honest and otherwise)
   until it doesn't. A washer at weight ≤ 0.5 always earns strictly less per LIKE than the
   marginal honest burner at 1.0 — within-family washing operates **below** margin: a guaranteed
   relative loss at any equilibrium.

**The honest residual (unchanged in kind from the current design):** reciprocal collusion between
*genuinely unrelated* accounts — like-for-like rings across distinct lineage families at pairwise
weight 1.0 — is not bounded by tree math (05 acknowledges the same gap today). What bounds it here
is the zero-profit equilibrium: ring members pay full LIKES cost and receive ~e per unit; at
equilibrium e ≈ cost, so professional rings converge to a **zero-economic-profit industry**, minus
invitation overhead, coordination cost, and client-side reputation risk. Two systemic notes:

- The pool **cannot be stolen below cost** — every emission Y extracted is paid for in LIKES whose
  value flowed to HEART holders and (via minting) the pool. Structurally this resembles PoW mining:
  zero-profit conversion of a costly input into the emission asset, except the "electricity"
  payment stays inside the network's own economy.
- The trade against the old design, stated plainly: the 4%-cap gave a *guaranteed ≥1% loss* on all
  washing but made emission irrelevant to creators; this design makes emission fully meaningful
  and bounds gaming by *competition to zero profit* rather than to guaranteed loss. Ring share of
  emission is capped by how much honest burning happens (honest likes have consumption value;
  emission is their bonus), and wash-liked content gains no reach (ranking is client-side, and
  rankers can discount by the same tree features).
- **Leak to monitor in simulation:** wash demand is indistinguishable from real demand in the
  utilization metric, so heavy ring activity expands L — the controller partially accommodates its
  own attacker. Bounding this is a launch-simulation task.
- The depth-1/genesis caveat from 05 §Anti-Gaming (family roots assume honest genesis invitees)
  carries over unchanged.

## 12. Considered and rejected (the trail)

| Design | Why rejected |
|---|---|
| **Single token + patches** (demurrage; liquid/staked states; tiny denominations; adaptive fees) | Demurrage kills the growth asset; two-state is two tokens in disguise and the liquid asset still appreciates; denominations don't survive appreciation; the gift-deferral psychology is behavioral, not mechanical. |
| **Fixed-rate two-way peg** (1 Y ⇌ k credits) | Arb chains the prices; credits become a Y-denomination. Any *fixed* conversion channel welds the assets; only variable, controller-governed channels decouple. |
| **Pooled/average-rate redemption** | Money pump: mint at today's rate, redeem at the average, whenever rates move. Redemption must be per-address at personal (weighted-average) rates — the Venice DIEM rule. |
| **100%-lock mint (no burn)** | A zero-interest, 100%-LTV, non-recourse loan with a free perpetual option: mint-and-dump strictly dominates selling Y, so credits trade at parity minus a volatility-dependent option discount (inheriting Y vol); crash-procyclical supply; redemption liabilities fight deflationary sinks (short-squeeze dynamics); locked Y can't fund perpetual emission. The φ-burn is what creates the no-arb band and arms the buyback defense. |
| **Transferable perpetual fixed-rate capacity without contraction instruments** | The faucet ratchet: issuance = c × stock, which only grows; a boom mints permanent faucets that flood the bust. In decline, LIKES glut → free likes → emission strip-mining. Perpetual guarantees with no reserves are insurance whose premium is charged to third parties in the bad state. Cured only by the §5 control system (which is why it exists). |
| **Share-based HEART** (pro-rata slice of a controlled budget) | Economically cleaner (controls the level, not the derivative) but a worse product ("a share of a floating budget" vs "10 likes/day"); superseded by fixed-rate + full control system. Falls back into play if simulation shows the control system can't defend the fixed rate. |
| **Soulbound-only membership** | Kills the secondary market that gives LIKES/HEART price discovery and creators a buyer base; transferable + expiring achieves the velocity goal with market benefits. (Soulbound was a valid intermediate step; transferability won.) |
| **Rewarding early likers / curation mining** | Recreates the greater-fool payoff the repo already rejected with bonding; turns likes into speculative bets (Steem's curation-reward bots). Social recognition stays client-side. |
| **Old-design invariants** (donation fee + emission match cap) | Superseded: the cap<fee invariant guaranteed wash losses but permanently capped creator emission at irrelevance and net-drained the float (§1). |

## 13. Precedent research

- **Venice AI (VVV → DIEM → API credits)** — the closest shipped analogue, three layers deep.
  DIEM: lock sVVV → mint at `BaseRate × e^(k·(S/S_target)³)`; unlock by burning DIEM at your
  per-address weighted-average mint rate; 80% staking yield while locked. Findings: DIEM is
  deliberately **not** stable (~$1,246 vs $1/day utility ≈ 3.7-year payback — a capitalized
  perpetuity, i.e. a second growth asset); the *stable* layer is the API credits, anchored by a
  centralized USD commitment a decentralized protocol cannot copy. Reused here: per-address
  redemption bookkeeping; supply-target mint curves (with endogenized target and flattened
  exponent — the cubic engineers a mint race). Their app-staking layer (pro-rata daily allocation,
  midnight refresh, no rollover) is the use-or-lose precedent.
- **Helium (HNT → Data Credits), Factom (FCT → Entry Credits)** — burn-and-mint equilibrium:
  one-way burns, credits stable in service units. Helium pinned DC at $0.00001 via oracle; this
  design replaces the oracle with the utilization controller.
- **Steem (STEEM / Steem Power / SBD)** — three-token social precedent. Lessons: peg defense must
  work both directions (SBD broke *upward* to $14); token multiplicity confused everyone (hence:
  hide the machinery); curation rewards bred bot rings (hence: no donor-side rewards).
- **Terra/UST** — reflexive mint-redeem death spiral; avoided here because nothing redeems into
  freshly minted Y.
- **Axie (SLP/AXS)** — a price-insensitive faucet against demand-driven sinks hyperinflates the
  consumable; two tokens don't fix source/sink imbalance. Hence use-or-lose issuance and the
  contraction instruments.
- **MakerDAO / OlympusDAO** — CDP bookkeeping and inverse-bond buybacks respectively; the buyback
  is this design's funded contraction instrument, with an endogenous trigger instead of an oracle.

## 14. Open questions & simulation checklist

1. **Controller tuning**: k, u*, EMA window, clamp width; oscillation and stampede scenarios;
   controller accommodation of wash demand (§11).
2. **φ curve**: launch value, ramp schedule; early-network dead zone vs pool/war-chest adequacy.
3. **Severe correlated collapse**: Y and HEART down together, pool spending devalued Y; does the
   circuit breaker hold the line before free-LIKES strip-mining?
4. **Reciprocal-ring economics** at zero-profit equilibrium: realistic ring share of emission
   under honest-burn distributions (successor to the old §Wash-trading simulation mandate).
5. **HEART market microstructure**: thin early order books, cornering the LIKES float before
   high-value auctions/rents; bounded by the mint ceiling but "bounded" needs numbers.
6. **c, LIKES_TTL, HEART auction/mint tranche sizing**; invitation price in HEART.
7. **Deterministic integer forms** for all rate math (the f64/`powf` gap already flagged for 05
   applies here too; controllers must be fixed-point).
8. **Bootstrap sequencing**: genesis Y split (unchanged), initial ρ(0) (sets the price level;
   arbitrary), first HEART mints before any LIKES market exists.

## 15. Impact on existing docs if adopted

- **03-token-y.md**: emission schedule and tree-weight consumption survive; donation fee, match
  cap, Reward Pool drip, and fee-recycling replaced by §6–7. Name-registry pricing re-denominated.
- **05-invitation.md**: weighting spec unchanged (consumed by §6); invitation cost re-denominated
  to burned HEART.
- **06/07**: label/ranking layers unchanged; indexer payment denominations per §7.
- **08-cli.md**: wallet/UX surfaces for allowance, auto-rent, HEART positions.
- **archive/**: the current 03 economic design would be archived with the same care as the
  bonding post-mortem — the cap<fee invariant analysis (§1 here) is worth preserving verbatim.
