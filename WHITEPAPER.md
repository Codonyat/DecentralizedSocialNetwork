# Y: A Fairly-Launched Social Network

**Draft whitepaper — July 2026. Status: design exploration, not a launch
announcement. Full specification in `/docs`.**

---

## Abstract

Y is a decentralized social network with a fixed-supply token distributed
with no sale, no team allocation, and no discretionary drops: 80% of supply
can only be earned by using or serving the network, and the remaining 20% is
a single disclosed treasury that unlocks linearly to fund the client and
infrastructure — and burns whatever it has not spent by year 8. Its design rests on one rule learned from a decade of
failed token-social experiments: **the money layer must measure nothing
subjective.** On-chain contracts enforce only objective facts — balances,
burns, unique names, invitations, service stakes — while everything
requiring judgment (ranking, moderation, "quality") lives at the network's
edge, where competing service operators are disciplined by staking,
cryptographic fraud proofs, and users' freedom to switch. The token
appreciates only if the network is used, because its only sources are usage
and service, and its only sinks are usage fees that burn.

## 1. Why another network

X demonstrates that a global town square is valuable. It also demonstrates
the cost of renting one: reach, monetization, API access, and speech survive
at an owner's pleasure, and the platform's economics accrue to shareholders
while the people who create its value are inventory. Every property that
makes this tolerable is revocable.

Decentralized alternatives exist and taught us what fails. Steemit minted
tokens against social approval and was strip-mined by vote-selling rings.
BitClout and friend.tech attached bonding curves to people and collapsed as
the pyramids they were. Nostr proved relays and signed data work — and that
volunteer infrastructure starves (~95% of relays cannot cover costs).
Bluesky proved portable identity works — and that 99.99% of users still sit
on one company's servers. Farcaster proved storage rent works — and
consolidated to a permissioned validator set now owned by a single firm.

Y's thesis: take the architecture these networks validated (signed data,
user-held identity, competing service nodes), take the economics none of
them dared (Bitcoin's: fixed supply, fair launch, rules carved in stone),
and refuse the mistake all of them shared (minting or privileging anything
based on a subjective judgment).

## 2. Design rule: objective chain, competitive edge

Every rule in Y belongs to exactly one of two worlds:

**The chain (small, dumb, immutable).** One contract suite on Ethereum or a
maximally trustless L2 (permissionless proving, no upgrade keys or
exit-length timelocks, forced-inclusion path): token, tips, name registry
with renewals, invitation registry, referral routing, rebate pool, service
registry with staking/slashing, identity registry with key rotation and
social recovery. Admin-keyless. Nothing here requires a human judgment to
keep working, which is precisely why it can be immutable — there is no
tuner, so there is nothing to capture. Upgrades ship as *new opt-in
contracts* that clients and operators choose to adopt: governance by
adoption, not by vote.

**The edge (plural, subjective, competitive).** Indexers crawl the signed
content and serve feeds, search, and moderation views — each under its own
published policy. Users pick their indexer and client the way they pick a
Bitcoin node or a Nostr relay. "The algorithm" is not a protocol constant;
it is a market. Anyone may enter this market from block 1 by staking.

Content itself is signed by its author and replicated across staked storage
nodes, with a cold permanent archive (append-only, anyone can fund, anyone
can re-seed from) preserving history independent of any operator's
lifespan. Existence is guaranteed by signatures plus permissionless
re-hosting; visibility is each indexer's editorial choice; the two are
never confused.

## 3. Identity and the social graph

An identity is a keypair, wrapped in an on-chain registry that supports key
rotation and opt-in M-of-N social recovery — because "lose your key, lose
your life" is how decentralized systems stay hobbies. Handles are on-chain
names: burned-for, annually renewed, expiring back into the commons when
abandoned. Names resolve to identities, not raw keys, so rotation never
orphans them.

Your follow list is a document you sign; it needs no consensus because it
has one author — you. The reverse direction (who follows me) is an index,
built by indexers who **cannot forge an edge** (they can't fake your
signature) and **can be caught omitting one** (see §5). Raw follower counts
are Sybil-inflatable everywhere, including here; Y's answer is honesty —
expose the verifiable raw number, let indexers compete on trust-weighted
views — rather than pretending a global scoreboard can be both open and
unfakeable.

## 4. The economy: everything earned, everything burned

**Supply.** 21,000,000 Y, fixed forever. 80% is distributed by formula
through two earned pools on a halving schedule (~2-year halvings); 20% is a
disciplined treasury:

- **Usage rebate pool — 60%.** Each epoch's drop is divided pro-rata among
  accounts by the protocol fees they burned that epoch. Sybil-splitting a
  pro-rata share changes nothing — no personhood oracle exists or is
  needed. The only "attack" is burning fees to harvest the drop, which is
  profitable exactly until total fees equal the drop; past that point a
  harvester is simply buying tokens from the protocol at market price. The
  same curve is the early-adopter reward: while the drop exceeds total
  fees, real usage is rebated at more than 100% — the young network is
  effectively free, decaying smoothly to full price as it grows. The
  subsidy is a formula, not a committee.
- **Service pool — 20%.** Split each epoch among staked service operators
  (indexers, storage nodes, media hosts, archivers) that answered
  liveness challenges drawn from chain randomness. Emission attached to
  verifiable work — never to social metrics.
- **Treasury — 20%.** The single, named exception to "everything earned":
  it funds the reference client, infrastructure, audits, and grants. Its
  discipline is what makes it defensible — linear unlock over five years,
  public spending, **anything unspent burns at year 8**, and it holds
  tokens, never powers: no key or vote it controls can change a monetary
  rule. It is provably temporary.

No sale, ever. No separate team allocation — contributors, founders
included, are paid from the treasury in the open or earn like any user. The
deployer retains no keys over the rules after genesis. Markets form
organically from earned supply, as Bitcoin's did.

**Flows.** All social money *moves*; only fees *mint against the schedule*:

- **Tips** are the like-button: a transfer of existing Y to a creator with
  a 1% burn and a memo naming the post. Nothing is minted against tips, so
  wash-tipping is strictly lossy — the signal cannot be mined, only paid
  for, which makes it a signal.
- **Fees burn**: name registration and renewals, invitations, promotion
  (pay-to-amplify with no return path — an ad, never an investment), and
  storage rent. Fixed formulas, no discretion.
- **Referral annuity**: an inviter receives 10% of the protocol fees their
  *direct* invitees burn for four years (depth 1 — a referral program,
  structurally incapable of MLM compounding). Recruiting people who
  actually use the network is the one growth behavior worth paying for,
  and it is measured in burned fees, which cannot be faked at a profit.
- **Rent, not "forever."** Y prices storage as a recurring cost with
  deterministic quotas and pruning, because 2025–26 provided a controlled
  experiment on the alternative: a pay-once-store-forever network paused
  its node subsidies and lost >99% of its nodes within weeks, then sunset
  the "permanent" network entirely. Permanence in Y is a *tier* (the
  funded public archive), not a promise the hot layer cannot keep.

**Why the token has value iff the network lives:** its only faucets are
schedule-bound and earned; its sinks (burns, stakes, prepaid renewals) all
scale with real usage. No usage → no burns, no stakes, no rebate demand —
nothing propping it. Heavy usage → shrinking float against fixed supply.
The token cannot be worth much while the network is worthless, and cannot
stay cheap while the network is indispensable. That is the entire trick,
and it requires no oracle, no committee, and no faith in the founders —
whose only privileged bag is a public-budget treasury that self-destructs
on schedule.

## 5. Enforced honesty: staked services and fraud proofs

Every registered service signs every response over a canonical claim
commitment (request hash, Merkle root of returned items, chain height,
expiry). That signature is a confession-in-advance, and a closed list of
faults is *cryptographically decidable* on-chain against the service's
stake:

- **Forgery** — serving content whose author-signature does not verify;
- **Equivocation** — signing contradictory responses to the same query;
- **Provable omission** — attesting completeness for a user's feed at
  version V while dropping an entry the user's own signed feed-index at V
  contains (targeted censorship becomes slashable);
- **False chain facts** — misreporting registry state the contract can
  read itself.

Slash: half burned, half to whoever submitted the proof — so verification
is a bounty-hunting business, not a tax on every client, and an indexer
must be honest with everyone because anyone might be a cop. What is *not*
slashable is equally deliberate: ranking taste, moderation policy, and
coarse "we don't serve X" choices are visible, legal, and answered by
switching — subjectivity is disciplined by markets, never by juries wired
into the money layer.

Moderation follows the same split. Flags, counter-flags, and community
review are signed public data with objective eligibility (invitation,
account age, a small refundable bond); each indexer applies its own
published thresholds; a review that overturns a flag nullifies it; serial
bad flaggers and bad reviewers lose their standing symmetrically. The
protocol never decides what is true — it makes every moderation act
auditable and every moderation regime escapable.

## 6. What Y does not promise

- **Not free-speech absolutism**: existence of data is protected;
  amplification is every operator's own editorial and legal choice.
  Illegal-content handling lives at the storage layer (ingest hash-lists,
  prunable hot replicas), which rent makes tractable and "permanence
  everywhere" would not.
- **Not a global truth machine**: no vote decides facts here.
- **Not instant decentralization theater**: the registry is permissionless
  from day 1, but early on the founders will likely run some of the
  infrastructure — as unprivileged registrants anyone can out-stake,
  undercut, or replace.
- **Not financial advice, not a sale**: there is nothing to buy from us.
  There never will be.

## 7. Status

Y is a design under exploration, not a product under construction. The full
specification — architecture (docs 00–08), economic constitution (09–11),
implementation evidence including the storage-network study and the
Autonomi post-mortem (12–13), and the founding decisions (14) — is public
in this repository. Criticism is the contribution we are soliciting;
the mechanisms above are meant to be attacked on paper before they are
attacked with money.
