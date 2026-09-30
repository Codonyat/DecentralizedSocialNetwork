// Macro simulation of the normative Token Y flows (docs/03-token-y.md), in whole Y.
// Tracks: user float, Reward Pool, Treasury. One epoch ~ 1 week (260 epochs ~ 5y per the spec).
// Assumptions are the MOST GENEROUS to creators: every donation has pairwise weight 1.0 and
// every creator is clipped exactly at the match cap (release = 4% of volume, if the pool can pay).

const INITIAL_EMISSION = 1.4e9, HALVING = 50;
const DRIP = 0.02, TREASURY_SHARE = 0.15, TREASURY_TERM = 260, RECLAIM = 416;
const FEE = 0.05, CAP = 0.04;

function emission(e) { const h = Math.floor(e / HALVING); return h >= 51 ? 0 : INITIAL_EMISSION / 2 ** h; }

// turnover: fraction of user float donated per epoch
// treasurySpend: fraction of treasury balance spent into user float per epoch
// otherFees: fraction of float paid per epoch as rent/invite fees (to pool)
function run({ turnover, treasurySpend, otherFees = 0 }) {
  let float = 0, pool = 0, treasury = 0, minted = 0;
  let cumTreasuryIn = 0, cumCreatorRelease = 0, cumFees = 0;
  const rows = [];
  for (let e = 0; e <= 520; e++) {
    const sched = emission(e); minted += sched;
    if (e === 0) { float += sched; rows.push(snap(e)); continue; } // genesis split
    const gross = pool * DRIP;
    const tSlice = e < TREASURY_TERM ? gross * TREASURY_SHARE : 0;
    const creatorDrip = gross - tSlice;
    const distributable = sched + creatorDrip;
    const volume = float * turnover;
    const fees = volume * FEE + float * otherFees;
    const release = Math.min(distributable, volume * CAP);
    // pool: loses gross drip, gains scheduled emission + undistributed + fees
    pool = pool - gross + (distributable - release) + fees;
    treasury += tSlice; cumTreasuryIn += tSlice;
    float += release - fees; cumCreatorRelease += release; cumFees += fees;
    const spend = treasury * treasurySpend; treasury -= spend; float += spend;
    if (e === RECLAIM) { pool += treasury; treasury = 0; }
    if ([1, 50, 100, 150, 200, 260, 416, 520].includes(e)) rows.push(snap(e));
  }
  function snap(e) {
    return { epoch: e, minted_B: b(minted), float_B: b(float), pool_B: b(pool), treasury_B: b(treasury),
      cumTreasuryIn_B: b(cumTreasuryIn), cumCreatorRelease_B: b(cumCreatorRelease), cumFees_B: b(cumFees) };
  }
  return rows;
}
const b = x => +(x / 1e9).toFixed(2);

const scenarios = [
  { name: 'A: 10% weekly turnover, treasury hoards', turnover: 0.10, treasurySpend: 0 },
  { name: 'B: 10% weekly turnover, treasury spends 2%/epoch', turnover: 0.10, treasurySpend: 0.02 },
  { name: 'C: 100% weekly turnover (absurdly high), treasury spends 2%/epoch', turnover: 1.0, treasurySpend: 0.02 },
  { name: 'D: 10% turnover + 0.2%/epoch rent+invite fees, treasury spends 2%/epoch', turnover: 0.10, treasurySpend: 0.02, otherFees: 0.002 },
];
for (const s of scenarios) { console.log('\n== ' + s.name); console.table(run(s)); }
