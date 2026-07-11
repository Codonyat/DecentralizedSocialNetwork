> **ARCHIVED — NON-NORMATIVE.** This document belongs to the same later parallel-session research effort as `12-data-layer-implementation.md` and `13-autonomi-deep-dive.md` (post-2026-07-11); it is that session's running founder-decisions record. **Adopted** into the normative spec from this record: decision D6's chain-criteria approach (survived as binding criteria plus a build-time deferral behind `ChainClient`, not a Base commitment — see `docs/00-master-plan.md`, Deployment Targets), the referral annuity, and the fair-launch/no-sale spirit (100% of supply earned, no team allocation, no sale). **Superseded**: D5's 20% treasury premine (replaced by a sunsetting slice of the Reward Pool drip — 15% of drip until epoch 260, unspent balance auto-reclaimed to the pool at epoch 416 — see `docs/03-token-y.md`), D4's open/permissionless staked service registry (replaced by market-priced indexer fees / hosting-as-a-service, no staking or slashing), and any residual Base/single-chain commitment elsewhere in this record (replaced by criteria + deferral). Internal doc-number references (e.g. "doc 09–13") mean other files from this same parallel session, not the current normative docs.

# Decision Record (July 2026)

Founder decisions taken after the docs 09–13 research arc. These govern the
spec where earlier docs offered options; conflicting older text is amended or
superseded as noted.

| # | Decision | Choice | Consequences |
|---|---|---|---|
| D1 | **Project mode** | Exploration — serious design work, no launch pressure, not (yet) a venture | Optimize for correctness and clarity over speed; no timelines in the spec |
| D2 | **Wedge community** (doc 09 §8.1) | Decentralization believers (Autonomi / Nostr / crypto-native communities) | Whitepaper voice + reference client target this audience; the Autonomi founding-cohort play (doc 13 §7) is the go-to-community motion |
| D3 | **Token timing** | Token live at genesis — **with no sale of any kind** | The token is present from block 1; all circulation is earned (D5); price discovery is fully organic |
| D4 | **Launch shape** | Service registry **open/permissionless from day 1** | No trust-us phase for infrastructure; anyone can stake and run storage/indexer nodes at genesis. We may still *also* run nodes — as ordinary registrants with no privileges |
| D5 | **Genesis allocation** *(revised — see D5 history below)* | **Fair launch + one disclosed treasury: 80% of supply earned, 20% sunsetting treasury** | No team allocation, no sale, no discretionary drops. A single treasury premine funds the client, infrastructure, and audits under sunset-and-burn discipline. Doc 10 §3.2/§3.4 amended accordingly |
| D6 | **Chain** | Ethereum L1 or a **maximally trustless L2** (criteria below) | Contract suite deploys where our admin-keyless constitution isn't undermined by someone else's admin keys |
| D7 | **Reference client** | **Hosted web client** (plus the spec'd CLI as the power tool) | Lowest onboarding friction; hosting is a self-funded goodwill act with no protocol privileges — the client speaks only public protocol, and anyone can host a rival |
| D8 | **Next deliverables** | Reconcile the spec + write the whitepaper | Simulation and production crates deferred |

## D5 in detail: the allocation (revised)

**Decision history:** D5 was first taken as a pure fair launch (100%
earned). On reflection — the "nobody pays for the client" tension of D7 —
it was revised the same day to reinstate **one treasury premine** while
keeping the rest of the fair-launch posture (no sale, no team allocation,
no discretionary drops). Parameters below use the recommended defaults
(20%, sunset-and-burn); they are strawmen until genesis.

| Pool | % | Amount | Mechanism |
|---|---|---|---|
| **Usage rebate pool** | 60% | 12,600,000 Y | per-epoch drop pro-rata to eligible fees burned (doc 10 §3.2.1) |
| **Service provider pool** | 20% | 4,200,000 Y | per-epoch to staked, proven-live service nodes (doc 10 §3.2.2) |
| **Treasury** | 20% | 4,200,000 Y | client development, hosting, audits, grants — under the discipline below |

**Treasury discipline (what makes a premine defensible):**

- **Linear unlock over 5 years; anything unspent burns at year 8.** The
  treasury provably cannot become a perpetual foundation or an indefinite
  overhang.
- **Tokens, not powers**: the monetary constitution (doc 10 §2) remains
  admin-keyless; the treasury can spend its budget, never alter rules.
- **Disclosed control**: held by the steward (founder) initially — named,
  visible, with spending published; migrate to a multisig as contributors
  materialize. Honest centralization with an expiry beats pretended
  neutrality (doc 09 §3).
- **What it funds**: the reference web client (D7), infrastructure
  bootstrapping, security audits, and grants — including seeding the
  doc 12 archive bounty escrow.

Unchanged from the original D5:

- No sale, ever; no team allocation — founders are compensated by treasury
  *salary/grants like any contributor* (disclosed), plus what any early
  user earns: rebates, referral annuities, service income, appreciation.
- Referral annuities remain fee-redistribution — no allocation needed.
- The early-adopter subsidy stays structural (rebates >100% while
  `drop > fees`), not discretionary.
- External grants (e.g. the Autonomi Foundation angle, doc 13 §7) remain
  welcome and compatible.

## D6 in detail: chain criteria

"Maximally trustless" means, concretely (evaluate at implementation time,
e.g. via L2Beat stages):

1. **Stage-2 rollup properties or L1 itself**: permissionless fraud/validity
   proving; no upgrade keys, or upgrades only behind exit-length timelocks.
2. **No sequencer censorship power** over our transactions: forced-inclusion
   path to L1 must exist and be usable.
3. **Fee reality**: tip-sized transactions (cents) must be economical —
   which likely rules out L1 for the tip path and implies a trustless L2,
   or an L1-settled design where tips batch.
4. **Longevity/neutrality**: no dependence on a single company's continued
   goodwill (the doc 13 lesson, applied to chains).

If no live L2 meets 1–3 when building starts, prototype behind the
`ChainClient` trait (doc 02) and revisit — exploration mode makes this free.

## D7 in detail: the hosted client, squared with purism

A hosted web client is a *convenience*, not an authority: it holds no
protocol role, no privileged keys, and no data users can't take elsewhere;
keys are client-side (browser keystore/passkeys with the doc 01 rotation +
social-recovery path); anyone can fork and host a competitor from the same
public protocol. The CLI (doc 08) remains the sovereignty tool for users who
trust no one's hosting. The trust model stays: the client you use is a choice
you can exit (doc 09 §4).
