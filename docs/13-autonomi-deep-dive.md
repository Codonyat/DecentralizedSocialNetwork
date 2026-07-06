# Autonomi Deep Dive: Is It Dead? Are Its Problems Fixable?

Research date: **6 July 2026**. Follow-up to doc 12 §1/§6–8, based on a
forensic research pass: MaidSafe's 20-year record, a dated timeline of the
1.0 collapse, the storage-economics mechanism, corporate filings/announcements,
2.0 vital signs, and community sentiment. Method caveat: this environment's
proxy blocks direct fetches of forum.autonomi.community, autonomi.com,
Companies House and archive.org, so forum/company items rest on search-index
extracts; GitHub and token figures are directly measured. Load-bearing claims
are linked and dated.

## 1. Verdict first

**Is it a dead network? No — but "it" is four different things in four
different states:**

| Layer | State (July 2026) | Grade |
|---|---|---|
| **Codebase / engineering** | Very much alive: new GitHub org (WithAutonomi), 1,846 commits since the 2.0 launch (7 Apr 2026), ~20/21 repos active in 90 days, weekly releases, new Android/Swift/browser-extension work | Alive |
| **Network / economy** | Critical: node count unpublished for 2.0 (last known: <8,000 in Feb 2026, down from ~1.5M official pre-pause — a >99% collapse); emissions frozen since 20 Jan 2026; storage fees demonstrably cannot sustain nodes alone | Critical |
| **Company (MaidSafe)** | Winding down: closure announced, successor entity (Autonomi Labs Ltd) + Swiss Autonomi Foundation hold IP/token; shareholders paid in ANT; **defunded its own community forum June 2026**; investor dispute (BnkToTheFuture) open | Dying |
| **Attention / ecosystem** | Externally dead: zero crypto-press, HN, or Reddit coverage of the collapse OR the 2.0 relaunch; one confirmed active third-party app (Formicaio); a loyal but small forum community (~200 topics in 5.5 months) now self-funding | Dead outside, warm core inside |

On a five-point scale (thriving / healthy-niche / **critically endangered** /
zombie / dead): **critically endangered, with an unusually active engineering
core**. The honest one-liner: *Autonomi today is a well-funded-by-token
open-source project and a barely-there network.* That combination can
recover (the code is real, the community core is loyal, 233M ANT of unspent
emissions exist as dry powder) — but nothing about its 20-year base rate
suggests betting on it.

## 2. The 20-year base rate

Founded 2006 (David Irvine, Scotland — pre-Bitcoin). Crowdsale 2014 (~$7M,
called "a wildly successful $7 million disaster" by
[Forbes](https://www.forbes.com/sites/kashmirhill/2014/06/03/mastercoin-maidsafe-crowdsale/)
after most proceeds landed in illiquid MSC). First alpha **2016** — ten years
in, client-only. Language and consensus rewrites through 2017–2020 (PARSEC
abandoned). Office closures and redundancies 2019. First real testnet
(Fleming) **2021**. Mainnet **Feb 2025** — nineteen years after founding.
Sunset of that mainnet: **thirteen months later**. The team's own community
concedes "timescales have always been wrong." New CEO Sarah "Bux" Buxton
(ex-Gala Games) took over ~Jan 2025; Irvine moved to Chair.

Pattern: this organization ships eventually, honestly, and slowly — and has
now twice replaced its own architecture *after* shipping it (PARSEC→CRDTs
pre-launch; 1.0→2.0 post-launch). The engineering persistence is genuinely
exceptional; the delivery risk is exactly as exceptional.

## 3. The collapse, forensically (this is the part that matters)

The 1.0 collapse was not an accident or an attack. It was a **controlled
natural experiment on Autonomi's core economic claim**, and the claim failed:

1. **The subsidy was the network — by design.** Emissions (~54,000 ANT/day)
   were a **uniform-random per-node lottery** (rounds every 120 s selecting
   100 random nodes each), completely decoupled from bytes stored — so every
   extra empty node was another lottery ticket. Peak: **~3,374,700 nodes /
   ~103 PB offered** (Oct 2025,
   [forum](https://forum.autonomi.community/t/update-2nd-october-2025/42457/59));
   still ~1.55M on the official counter on 6 Jan 2026
   ([forum](https://forum.autonomi.community/t/network-size-today/42723)).
   A Nov 2025 vulnerability let nodes wipe and re-register as fresh
   identities to farm harder, and large farms ran modified code that blocked
   network upgrades.
2. **The fees were negligible.** A user who uploaded ~1 TB in Feb 2026 paid
   **~$0.10 in ANT storage fees** (plus ~$200 in Arbitrum gas — 99.95% of
   the cost leaking to Ethereum, not to storage providers)
   ([forum](https://forum.autonomi.community/t/thoughts-on-current-ant-upload-pricing-and-long-term-sustainability/42785)).
   One terabyte of "perpetual" storage generated ten cents of provider
   revenue, once.
3. **Emissions paused 20 Jan 2026** (2.94% of the 240M pool spent)
   ([team](https://autonomi.com/publications/autonomi-2026-built-for-this-moment)).
4. **>99% of nodes left within weeks** — below 8,000 by mid-Feb
   ([forum](https://forum.autonomi.community/t/node-count-how-low-is-too-low/42777)),
   confirming the node base was emission farms, not storage providers.
5. **The data died with them.** 1.0 shipped without working replication; the
   team had already posted *"Data Persistence Is Not Guaranteed Yet"* in Dec
   2025 ([forum](https://forum.autonomi.community/t/important-notice-data-persistence-is-not-guaranteed-yet/42666)).
   19 Feb 2026: final 1.0 update; ~5 Mar: official sunset. The team stated
   1.0→2.0 data transfer was **"not possible"** and retro-framed 1.0 uploads
   as made "without guarantee of permanence"
   ([team](https://autonomi.com/publications/autonomi-2026-built-for-this-moment));
   no refund program was found, and no "last reset" pledge or 2.0→3.0
   migration guarantee exists. The ANT token (ERC-20 on Arbitrum) was
   unaffected.
6. **2.0 launched 7 Apr 2026**: post-quantum crypto (ML-DSA-65/ML-KEM-768),
   working automatic replication, geographic diversity in the DHT, Merkle
   batch payments (100 chunks per gas transaction — a real fix for the gas
   leak), zero-config home nodes.

Read carefully, the experiment demonstrated the exact thesis of our doc 10:
**unpriced (or one-shot-priced) perpetual storage does not survive contact
with reality; recurring, usage-priced storage does.** Autonomi accidentally
ran the control group for our design.

## 4. The economics have no endowment — the "forever" is vibes

Arweave's pay-once model is backed by an explicit **storage endowment**: fees
are escrowed and released to miners over decades against an assumption of
declining hardware costs — a bet, but a structured, solvent-under-stated-
assumptions bet. **Autonomi has no equivalent.** The one-time upload fee is
paid **immediately and entirely to the nodes currently holding the chunk**
([docs](https://docs.autonomi.com/learn/how-it-works/payments-and-transactions/data-payments)).
Year-10 storage of year-1 data is funded by nothing except the hope that
future upload flow keeps nodes around and that storage is "spare capacity"
costing nobody anything. Their own FAQ confirms nodes earn **only from new
uploads** — storing existing data is uncompensated. The team's post-collapse
response was not to add rent or an endowment but: batch payments, a network
reset, and a strategic pivot toward "agentic payments" as ANT's demand story
— with the future of node emissions **explicitly undecided** as of Feb 2026.
As of July 2026, "pay once, store forever" remains the marketed model.

## 5. Corporate reality

- MaidSafe announced its own closure/wind-down; **Autonomi Labs Ltd**
  created as successor; network IP and token custody moved to the Swiss
  non-profit **Autonomi Foundation**; per docs, MaidSafe receives no token
  emissions ([docs FAQ](https://docs.autonomi.com/learn-more/faqs)).
- Shareholders were compensated in ANT (unlocks May/Aug 2025) — equity
  effectively converted to token exposure. An open dispute: BnkToTheFuture
  (which held 2016-era investor equity) announced it has "no intention of
  giving ANT anytime soon" to its investors
  ([forum](https://forum.autonomi.community/t/bnktothefuture-announcement/42789)).
- **June 2026: MaidSafe stopped funding the community forum** — its
  10+-year-old town square — which the community is now taking over
  ([forum](https://forum.autonomi.community/t/important-community-announcement-the-future-of-the-forum-is-in-our-hands/42932)).
  Replies were practical (donations, Open Collective), not rage-quits, but
  as a cash signal it is loud.
- Unresolved: a community post claims the company was "dissolved" while a
  Companies House snippet (SC297540) still shows "active" — check directly
  from an unblocked network before treating either as fact.

## 6. Fixable vs unfixable

| # | Problem | Verdict | Reasoning |
|---|---|---|---|
| 1 | **Pay-once economics without an endowment** | **FIXABLE-BUT-BREAKS-PROMISE** | The Jan 2026 experiment proved fees-as-designed don't sustain nodes. Fixes exist — rent, renewal, an Arweave-style endowment, or resuming emissions as a permanent subsidy from the 233M pool — but every durable fix either abandons "pay once, store forever" or turns it into "subsidized until the pool runs out." The team has so far chosen neither. |
| 2 | **Emission farming (sybil node inflation)** | FIXABLE — and 2.0 changed the design | The 1.0 flaw was a uniform per-node lottery decoupled from stored bytes. 2.0 replaced it: node income now comes from upload payments tied to actually storing data, with fullness-based dynamic pricing and geographic-diversity anti-sybil in the DHT. Plausible fix, unproven at scale — and emissions themselves remain paused (their future "undecided"), so the fixed mechanism has never run. |
| 3 | **Gas coupling to Arbitrum** | LARGELY FIXED | Merkle batch payments (Mar 2026) collapse 100 chunk payments into one transaction — the 99.95%-leak problem is addressed. The deeper "native token without a blockchain" promise (historically DBCs) remains unshipped after two decades and is genuinely hard without consensus: treat as UNKNOWN/aspirational. |
| 4 | **The reset precedent** | **STRUCTURAL (reputational)** | Not a code problem and not fixable by code: a network that sunset its "permanent" mainnet once cannot re-earn permanence credibility except by years of not doing it again. Any future 2.0→3.0 break re-runs the same destruction unless a data-migration guarantee is engineered and honored; none has been committed to. |
| 5 | **Mutable-data consistency (Pointer/Scratchpad staleness, lost updates)** | FIXABLE | Quorum/replication tuning, CRDT semantics, or version-history are ordinary distributed-systems engineering; 2.0's working replication is a prerequisite it now has. Still unproven at scale, and our MutableStore depends on exactly this. |
| 6 | **No deletion (illegal-content/GDPR liability)** | STRUCTURAL by design | Content-addressed, replicated, owner-less storage is deliberately deletion-proof; node-level ingest blocklists could be added but conflict with the network's founding ideology, and nothing on the roadmap suggests them. |
| 7 | **Single company, single implementation** | STRUCTURAL today, mitigable | Open source (GPL) means the code outlives the company, and the community core is real — but there is no second implementation, no independent protocol spec, and the company is winding down into a foundation. Survival currently equals "the ~same small team keeps shipping." |

**Net: the two problems that killed 1.0 (economics, farming) are fixable on
paper but unfixed in fact; the two deepest problems (reset-credibility and
deletion) are structural; and the network's continuity now rests on a
foundation-funded team with an externally invisible project.**

## 7. What this means for Y

1. **Doc 12's posture survives contact with the deep dive, strengthened.**
   Adapter, not foundation; partnership, not dependency. The collapse is
   direct empirical validation of our Tier-1 choice (staked, *rent-paid*
   storage nodes — doc 10 reserved storage rent as a first-class fee for
   exactly this reason) over pay-once permanence.
2. **The community-as-founding-cohort play (doc 12 §6) is still real** —
   arguably more so: a loyal, technically literate community whose company
   just defunded their forum is a community looking for a new project to
   believe in. Engaging them costs us nothing architecturally.
3. **A concrete partnership angle worth exploring**: the Foundation holds
   ~233M unspent ANT explicitly earmarked for "future ecosystem utility."
   A flagship social network is the strongest utility story they could buy.
   Any such deal must be structured so Y survives Autonomi's failure
   (grants/co-marketing yes; exclusivity or data-layer dependency no).
4. **Re-evaluation triggers (unchanged from doc 12, now dated):** published
   2.0 node counts on a public dashboard; emissions/economics decision
   shipped and survived 6+ months; a second independent implementation or
   binding data-migration commitment; mutable-read consistency demonstrated
   under churn. Absent those by ~mid-2027, drop Autonomi to archive-tier
   candidate only.

## 8. Bottom line

Not dead — **critically endangered, with a paradox at its center**: the
engineering organism is healthier than it has been in years (focused,
shipping weekly, post-quantum ahead of everyone), while the economic organism
has already died once and is running on treasury life-support with its core
promise ("pay once, store forever") empirically falsified by its own
emissions pause and never yet repaired. Its unfixable problems are not
technical: they are a permanence promise with no funding mechanism, a
credibility reset that only time can heal, and a one-organization bus factor.
Build with it as an option and an ally; do not build on it as a foundation.
