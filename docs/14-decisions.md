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
| D5 | **Genesis allocation** | **Pure fair launch: 100% of supply is earned** | No team, treasury, foundation, sale, or discretionary-drop buckets. Doc 10 §3.2/§3.4 superseded (see below). Development, hosting, and audits are self-/externally funded, never protocol-funded |
| D6 | **Chain** | Ethereum L1 or a **maximally trustless L2** (criteria below) | Contract suite deploys where our admin-keyless constitution isn't undermined by someone else's admin keys |
| D7 | **Reference client** | **Hosted web client** (plus the spec'd CLI as the power tool) | Lowest onboarding friction; hosting is a self-funded goodwill act with no protocol privileges — the client speaks only public protocol, and anyone can host a rival |
| D8 | **Next deliverables** | Reconcile the spec + write the whitepaper | Simulation and production crates deferred |

## D5 in detail: the fair-launch allocation

The doc 10 §3.2 strawman (sale/treasury/team/genesis-drop buckets) is
**superseded**. New allocation of the 21M, preserving the 3:1 ratio between
the two earned pools:

| Pool | % | Amount | Mechanism (unchanged) |
|---|---|---|---|
| **Usage rebate pool** | 75% | 15,750,000 Y | per-epoch drop pro-rata to eligible fees burned (doc 10 §3.2.1) |
| **Service provider pool** | 25% | 5,250,000 Y | per-epoch to staked, proven-live service nodes (doc 10 §3.2.2) |

- Referral annuities remain fee-redistribution (doc 10 §3.3) — they need no
  allocation.
- **What founders get**: exactly what any early user gets — cheap early
  acquisition, fee rebates, referral annuities, service-pool income if they
  run nodes, and appreciation. Nothing else.
- **What disappears with the treasury**: protocol-funded client development,
  grants, audits, and discretionary retroactive drops. Replacements:
  self-funding, external grants (e.g. the Autonomi Foundation angle of
  doc 13 §7 — external money is compatible with fair launch; protocol
  allocations are not), and on-chain **bounty escrows** anyone can fund
  (e.g. the archive bounty of doc 12 Tier 3, previously treasury-seeded).
- **Steward role shrinks to deployer**: someone must deploy the contracts
  and seed genesis invitation accounts (doc 05). That role holds zero
  tokens and zero keys post-deployment — the constitution (doc 10 §2) is
  admin-keyless, so the deployer's power ends at block 1.
- **Bootstrapping the wedge cohort without a drop**: the early-network
  subsidy is structural, not discretionary — while `drop > fees`, usage is
  rebated at >100% (doc 10 §3.2.1), so the founding cohort's reward is
  earning cheap tokens by using and serving the network early. No committee
  decides who deserves what.

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
