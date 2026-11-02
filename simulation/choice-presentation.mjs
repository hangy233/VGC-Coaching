// One conditional native trajectory, without repeated world/sample metadata.
// Detailed engine inputs/results remain in the private calculation archive.
import {digest} from '../planning/identity.mjs';
const clone=value=>structuredClone(value);
export function presentSingleChoiceOutcome(result){
  if(result?.worlds?.length!==1||result.branches?.length!==1||result.worlds[0].samples?.length!==1)throw Error('Single-outcome presentation requires exactly one native trajectory');
  const world=result.worlds[0],sample=world.samples[0],coverage=sample.stateCoverage;
  const {assumptions=[],...coverageFlags}=coverage??{};
  const unique=new Map([...world.stateAssumptions??[],...assumptions].map(value=>[digest(value),value]));
  return {
    kind:'native-choice-outcome-v1',researchOutcome:'returned',source:clone(result.source),engine:clone(result.engine),
    authoredPair:clone(result.branches[0]),
    trajectory:{worldId:world.id,branchId:sample.branchId,seed:clone(sample.seed),profiles:clone(world.profiles),initial:clone(world.initialState)},
    outcome:{accepted:clone(sample.accepted),final:clone(sample.final),events:clone(sample.events),actionOutcomes:clone(sample.actionOutcomes),
      boundary:sample.boundary,turnComplete:sample.turnComplete,replacementRequest:clone(sample.replacementRequest),replacementDecisions:clone(sample.replacementDecisions),unusedContinuations:sample.unusedContinuations,
      pendingActions:clone(sample.pendingActions),pendingPhases:clone(sample.pendingPhases),noPendingContinuation:sample.noPendingContinuation,
      ...(sample.openingEvents?.length?{openingEvents:clone(sample.openingEvents)}:{}),initializationEvents:clone(sample.initializationEvents),stochastic:clone(sample.stochastic),hpHypotheses:clone(sample.hpHypotheses)},
    stateCoverage:{...clone(coverageFlags),available:coverage!==undefined,assumptions:clone([...unique.values()])},
    hypotheses:{labels:clone(world.assumptions),spreadRanges:clone(result.spreadRangeCoverage??[])},
    inference:clone(result.inference),
    coverage:clone(result.coverage),limitations:[
      'Exactly one deterministic conditional trajectory. This is not a spread range, knockout probability, exhaustive comparison, current tactical approval or guarantee.',
      'Unknown state and opposing allocations remain the explicit hypotheses below. A paused replacement leaves pending actions unresolved.',
    ],
  };
}
