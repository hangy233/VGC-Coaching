// Repair one demonstrated scalar-calculator coverage gap using the executable
// move from the pinned Champions engine. This supplies no battle observation,
// legality decision, inferred faint count, or model-authored power override.
import PS from 'pokemon-showdown';

const FORMAT = 'gen9championsvgc2026regmc';
const champions = PS.Dex.forFormat(FORMAT);

export function resolveChampionsDamageMoveState({gen, move, attackerOptions} = {}) {
  if (gen !== 0) return null;
  const entry = champions.moves.get(move);
  if (entry.id !== 'lastrespects') return null;

  const alliesFainted = attackerOptions?.alliesFainted;
  // This existing public field represents the side's total faint events for
  // Last Respects, including repeated faints after revival. Unknown state must
  // never be silently converted to the zero-faint case. Larger totals remain
  // outside the public calculator contract and are explicitly unsupported.
  if (!Number.isInteger(alliesFainted) || alliesFainted < 0 || alliesFainted > 5) {
    throw new Error('Champions Last Respects requires explicit attackerOptions.alliesFainted (total side faint events, integer 0–5); missing or unsupported faint state cannot establish damage');
  }
  if (!entry.exists || typeof entry.basePowerCallback !== 'function') {
    throw new Error('Pinned Champions Last Respects basePowerCallback is unavailable');
  }

  let basePower;
  try {
    // The pinned callback currently consumes only side.totalFainted. A future
    // dependency on additional state fails here rather than inventing it.
    const attacker = Object.freeze({side: Object.freeze({totalFainted: alliesFainted})});
    basePower = entry.basePowerCallback.call(undefined, attacker, undefined, entry);
  } catch {
    throw new Error('Pinned Champions Last Respects callback requires unsupported state');
  }
  if (!Number.isSafeInteger(basePower) || basePower <= 0) {
    throw new Error('Pinned Champions Last Respects callback returned unsupported base power');
  }
  return {
    // Move.clone() reconstructs from overrides. Assigning move.bp after its
    // construction would lose the repair inside calculate().
    moveOptions: {overrides: {basePower}},
    projection: {
      kind: 'pinned-champions-move-state', move: entry.name, alliesFainted, basePower,
      source: {engine: 'pinned pokemon-showdown', format: FORMAT, mod: champions.currentMod,
        generationParameter: 0, callback: 'lastrespects.basePowerCallback'},
      scope: 'Explicit supplied faint-event total; conditional damage, not a verified battle observation',
    },
  };
}
