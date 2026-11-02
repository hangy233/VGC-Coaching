// Pure offline reconstruction. The caller owns source/cutoff revalidation and
// the actual MCP transport; this module performs neither I/O nor native work.
import {simulationToolSchema,simulationBatchToolSchema} from '../simulation/schemas.mjs';
import {buildObservedPosition,bindObservedActions} from '../simulation/observed-position.mjs';
import {deliveryCheckSchema} from '../planning/delivery.mjs';
import {boundAction} from '../planning/source.mjs';
import {validateChoice} from '../showdown/choice-validation.mjs';
import {boardDigest,requestDigest,digest} from '../planning/identity.mjs';

const copy=structuredClone;
const check=(ok,message)=>{if(!ok)throw new Error(`Offline observed simulation: ${message}`);};
const tools=new Set(['simulate_turn','simulate_turn_batch','battle_check_plan']);

/** Reuse the maintained observed builder, but send an explicitly hypothetical
 * native request to the offline SDK. Original source claims remain separate. */
export function translateOfflineObservedSimulation(name,args,{observed,teamText,opposingSheet}={}){
  check(tools.has(name),'unsupported tool');
  check(args&&Buffer.byteLength(JSON.stringify(args))<=512*1024,'bounded authored input required');
  check(!Object.hasOwn(args,'evidenceContext'),'offline reconstruction cannot write calculation evidence');
  const parsed=(name==='battle_check_plan'?deliveryCheckSchema:name==='simulate_turn_batch'?simulationBatchToolSchema:simulationToolSchema).parse(args);
  const request=parsed.request;
  check(request.kind==='observed','an authored observed request is required');
  const source=request.source;
  check(observed?.teamSha256===source.teamId,'exact frozen team fingerprint required');
  const {action,board}=boundAction(observed,source);
  const foe=board.ownSide==='p1'?'p2':'p1';
  check(Array.isArray(board.opponentSheets?.[foe]),'exact frozen published sheet required');
  check(digest(board.opponentSheets[foe])===digest(opposingSheet),'published sheet differs from the frozen board');
  const {sessionId:_sessionId,...expected}=source;
  const built=buildObservedPosition({observed:{...copy(observed),opponentSheets:{[foe]:copy(opposingSheet)}},teamText,opposingSheet,hypotheses:request.hypotheses,expected});
  const bind=actions=>{
    const bound=bindObservedActions(actions,built);
    validateChoice({...action.legalActions,side:{...(action.legalActions.side??{}),pokemon:action.legalActions.pokemon}},bound);
    return bound;
  };
  const branches=values=>values.map(branch=>({...copy(branch),ourActions:bind(branch.ourActions)}));
  const nativeRequest={kind:'explicit',position:copy(built.position),hypotheses:copy(built.assumptions),
    ...(name==='simulate_turn_batch'?{cases:request.cases.map(entry=>({...copy(entry),branches:branches(entry.branches)}))}:{branches:branches(request.branches),seeds:copy(request.seeds)})};
  const input={...copy(args),request:nativeRequest,
    ...(name==='battle_check_plan'&&parsed.candidates?{candidates:parsed.candidates.map(candidate=>({...copy(candidate),ourActions:bind(candidate.ourActions)}))}:{})};
  // Parse constructed inputs too. Do not alter existing explicit raw calls or
  // rely on the SDK to silently repair a malformed reconstructed request.
  (name==='battle_check_plan'?deliveryCheckSchema:name==='simulate_turn_batch'?simulationBatchToolSchema:simulationToolSchema).parse(input);
  const boardHash=boardDigest(board,action.legalActions);
  return {input,translation:{kind:'offline-observed-to-explicit-native',constructedTool:name,authoredInputSha256:digest(args),constructedInputSha256:digest(input),
    source:{...copy(source),boardHash,requestDigest:requestDigest({...source,boardHash})},reconstruction:copy(built.provenance),
    semantics:'Exact frozen-reader reconstruction under authored hypotheses; actual native results remain explicit offline samples, without live freshness, server acceptance or calculation evidence.'}};
}
