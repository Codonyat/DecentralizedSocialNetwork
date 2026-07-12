# Content Labels (`dsn-core::label`)

## Purpose

Content moderation separates **existence** from **visibility**. Existence is
guaranteed by portable signed objects replicated across independently chosen
indexers, the author's own local copies, and trustless third-party mirrors —
anyone may re-publish, and anchors keep prior timestamps provable forever.
Visibility is decided at the edge: indexers choose what to serve, and every
client can filter further.

The protocol's contribution to moderation is deliberately minimal, for the same
reason ranking needs no consensus (09-client-ranking.md): **visibility, like a
feed, is consumed by exactly one person**. What is hidden from you is hidden
for you alone — nobody else needs to verify or agree with your filter. A
network-wide moderation verdict is therefore not just unnecessary machinery; it
is a quasi-consensus layer on an inherently per-viewer question. The protocol
specifies only a **data format** — one signed object, the Label — so that
reports are portable across indexers and every visibility decision is auditable
against a public record. Everything above the data format (aggregation,
weighting, thresholds, reputation) is client and indexer policy.

## The Label Object

```rust
/// A signed content label: one user attaching one string to one object.
/// An ordinary immutable, content-addressed signed object (envelope of 02,
/// version 0), published, synced, anchored, and retracted like any other.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Label {
    /// The labeler's IdentityId (genesis public key).
    pub author: IdentityId,

    /// Content address of the labeled object (usually a post).
    pub target: ContentAddress,

    /// The label string: `^[a-z0-9-]{1,64}$`. Open namespace; well-known
    /// values below are conventions, not an enum.
    pub label: String,

    /// Epoch the author claims the label was created in. Display metadata
    /// only — never enters validity (anchors prove time; see 12 §4).
    pub claimed_epoch: u64,

    /// ed25519 signature over all fields above (verified against the
    /// author's registry key history per the validity rule, 01).
    pub signature: Signature,
}
```

### Validation

- `label` matches `^[a-z0-9-]{1,64}$`.
- `target` is a well-formed content address.
- `signature` verifies per the validity rule (01) — any non-revoked key in the
  author's registry history; revoked-key labels need a pre-revocation proof
  like every other object (07, ingest).
- Anyone may label anything, including their own content — there are no
  eligibility gates, because weighting is the consumer's job, not the
  protocol's. Labeling your own post `dispute` is the rebuttal convention.

### Uniqueness (an indexing rule, not an addressing rule)

A Label is content-addressed like any object (its address is the hash of its
bytes). Indexers additionally keep **one label per `(author, target, label)`**:
the first-seen object wins, and a duplicate triple with different bytes
resolves deterministically by lowest object hash — the same tiebreak 02 uses
for same-version mutable records. Republishing a label is idempotent.

### Retraction

A signed retract tombstone (02, Privacy & Data Lifecycle) against one's own
label withdraws it; compliant indexers drop it from their label sets. The same
honesty caveat applies: a retract is a convention, not consensus.

### Well-Known Label Values (convention)

| Label | Meaning |
|---|---|
| `spam` | Unsolicited commercial content, bot-generated spam |
| `harassment` | Targeted abuse, threats, or doxxing |
| `violence` | Content depicting or promoting violence |
| `illegal` | Content illegal in most jurisdictions (e.g., CSAM) |
| `nsfw` | Nudity or explicit material (not inherently rule-breaking) |
| `dispute` | The author's (or anyone's) rebuttal of other labels on the target |

The namespace is open: indexers and communities can mint labels (`ai-generated`,
`satire`, `unverified-claim`, …) without a protocol change, and unrecognized
labels are simply ignored by consumers that don't understand them. There is no
truth category by design — truth-by-plebiscite invites brigading; disputes over
accuracy are label vocabularies and client filters, not protocol state.

## Consuming Labels (client/indexer policy, non-normative)

Everything in this section is a convention layered on the public label record.
Different indexers and clients will do it differently; that is the design.

- **Indexer defaults.** An indexer MAY compute a visibility verdict per post
  (e.g., `Clean` / `Warned` / `Hidden`) from labels under its own thresholds
  and weighting, advertise the policy, and apply it to the feeds it serves
  (07). This is an indexer-local convenience — primarily for thin clients —
  not a protocol verdict. Users who disagree switch indexers.
- **Client-side filtering.** The stronger path mirrors 09: a client weights the
  public labels itself — for example by the labeler's proximity in the user's
  follow graph or invitation lineage, by an explicit trust list of labelers, or
  by any published "moderation ranker" installed like a feed ranker. A brigade
  of strangers has approximately zero weight in a graph-proximity filter, which
  handles coordinated flagging better than any global quorum can.
- **Labeler reputation.** The full label history of every author is public, so
  any consumer can compute its own reputation view (e.g., "how often do I end
  up agreeing with this labeler?"). Reputation is a derived, local view — never
  protocol state.
- **Auditability.** Because labels are public signed objects and indexer
  policies are advertised, anyone can compare what an indexer hides against
  the public label record. Censorship beyond the advertised policy is
  detectable with evidence, the same cross-indexer verification 07 relies on.

## Host Policy (retained, out of protocol)

Indexers, media hosts, and mirrors MAY apply ingest-time hash blocklists (for
example, published CSAM hash lists), declining to store or serve matching
bytes — hosts carry legal responsibility for what they serve regardless of
what this spec says. This is edge policy at each host's discretion, not
protocol-level deletion (07, Configuration). Operator-level blocked-user and
blocked-post lists are likewise indexer-local configuration.

## What Was Removed, and Why

Earlier revisions of this document specified eligibility gates (invitation +
account age + donation history), uniform-weight flag aggregation, counter-flag
objects, community review votes with quorums and lineage-family spans,
overturn cycles, and flagger accuracy scores. All of it is deleted, for three
reasons stated honestly:

1. **It was consensus where none is needed.** Each indexer already chose its
   own policy, so the "global" verdict was a fiction; and the viewer is the
   only consumer of a visibility decision, so per-viewer weighting is both
   sufficient and more faithful to what moderation is.
2. **The machinery was attack surface.** Quorum-gated reviews failed toward
   the flaggers (a brigade wins whenever reviewers don't assemble), and every
   gate, cycle, and accuracy rule was a parameter to game.
3. **Simplicity.** One object type replaces five, and the `dsn-moderation`
   crate disappears — the Label type lives in `dsn-core`, and consumption is
   ordinary indexer/client code.

Trade-off owned: thin clients that rely on an indexer's defaults get that
indexer's judgment — the same trust they already extend for feed completeness,
and equally auditable.

## Integration

- **`dsn-core`** — defines `Label` (`label.rs`), validated like every signed
  object.
- **`dsn-data` / storage** — labels are ordinary immutable signed objects; no
  dedicated store. GraphStore remains for reply threading only.
- **`dsn-indexer`** — ingests labels via publish/stream like any object,
  maintains a `labels (author, target, label)` index, serves
  `GET /api/v1/labels/:post_address` (raw labels plus this indexer's own
  non-normative visibility verdict), and applies its advertised defaults to
  the feeds it builds (07).
- **`dsn-cli`** — `dsn label add <post> <label>`, `dsn label list <post>` (08).
