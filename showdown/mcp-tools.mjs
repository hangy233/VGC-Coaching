import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {callLocalSession} from './local-bridge.mjs';
import {loadMetricsTeam} from '../metrics/import.mjs';
import {readDecisionNotes} from './decision-notes.mjs';

const {Teams,TeamValidator}=createRequire(import.meta.url)('pokemon-showdown');

export function registerBattleTools(server, {workspace, call = callLocalSession} = {}) {
  const descriptorPath = join(workspace,'cache','showdown-session.json');
  const confirmed = z.literal(true).describe('True only within the battle scope explicitly authorized by the user.');
  const commandId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional().describe('Reuse this ID only to retrieve the same command result after an uncertain response.');
  const token = z.string().regex(/^[a-f0-9]{64}$/).describe('Current action token from battle_status/battle_wait; stale tokens are rejected.');
  const action = z.discriminatedUnion('type',[
    z.object({type:z.literal('move'),slot:z.number().int().min(1).max(4),target:z.union([z.literal(-2),z.literal(-1),z.literal(1),z.literal(2)]).optional(),mega:z.boolean().optional()}).strict(),
    z.object({type:z.literal('switch'),slot:z.number().int().min(1).max(6)}).strict(),
    z.object({type:z.literal('pass')}).strict(),
    z.object({type:z.literal('team'),order:z.array(z.number().int().min(1).max(6)).min(1).max(6)}).strict(),
  ]);
  const invoke = async (op,args={}) => {
    const {commandId,...fields}=args;
    try {
      const reply=await call(descriptorPath,{id:commandId || randomUUID(),op,...fields});
      return {isError:!reply.ok,content:[{type:'text',text:JSON.stringify(reply,null,2)}]};
    }catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}
  };
  const register=(name,description,schema,handler)=>server.registerTool(name,{description,inputSchema:z.strictObject(schema),annotations:{readOnlyHint:['battle_status','battle_wait','battle_capabilities','battle_decision_notes'].includes(name),destructiveHint:['battle_stop','battle_forfeit','battle_switch_team'].includes(name),openWorldHint:!['battle_decision_notes'].includes(name)}},handler);
  register('battle_capabilities','Read the capabilities and immutable build fingerprint of the actually loaded signed-in session. Old clients remain old until their next normal start; this tool never restarts, authenticates or searches.',{},()=>invoke('capabilities'));
  register('battle_status','Read the terminal-owned signed-in client: compact battle state, current action tokens, known/unknown stats, observed clocks and metrics recorder status/failures. Use team_metrics_sync_battles after a game or BO3 to confirm report persistence. Does not log in or queue.',{},()=>invoke('status'));
  register('battle_wait','Wait for a state revision change (up to 30 seconds), including urgent ready prompts, turns, errors or results. Pass the last observed revision to avoid polling raw logs.',{
    afterRevision:z.number().int().min(0).optional(),timeoutMs:z.number().int().min(0).max(30000).default(25000),
  },args=>invoke('wait',args));
  register('battle_start','Upload the terminal session’s locked approved team and search for ONE M-C BO3 set. Before calling, follow champions-mc-matchups: use battle_skill_status/read for current guidance, finish and verify the previous BO3 with battle_review_save/status (a justified no-change review is valid), then inspect battle_preflight blockers and warnings. Requires user authorization; never auto-queues another set. The transport checks scope/idle, not review completion.',{confirmed,commandId},args=>invoke('start',args));
  register('battle_authorize_sets','Extend the signed-in session’s set budget only after an explicit user request. Requires live, server-confirmed idle state with no pending match; keeps the same account and team, and never queues a search. Total budget is at most 100 sets.',{
    confirmed,commandId,additionalSets:z.number().int().min(1).max(100),
  },args=>invoke('authorize-sets',args));
  register('battle_set_replay_policy','Explicitly enable or disable saved-replay publication for future owned BO3s in this signed-in session while idle. Default is off. Enabling requires existing user authorization to save completed child replays with their current privacy; it never changes visibility, signs in, uploads old sets or queues. After each official parent ends and the server confirms idle, the client makes one bounded save/verify/preserve attempt, flushes its recorder and verifies exact report links plus local replay/canonical evidence. Policy persists through allowance extensions. Incomplete authorized preservation blocks the next search/team switch; retry the same parent with battle_save_replays, which reuses uncertain requests instead of uploading a child twice. Disabling affects future sets and does not clear existing incomplete obligations.',{
    confirmed,commandId:commandId.unwrap(),enabled:z.boolean(),
  },args=>invoke('set-replay-policy',args));
  register('battle_choose','Send a complete doubles decision for a current action token. Returns sent status; inspect server acceptance and execution evidence separately. No automatic battle choices.',{
    confirmed,commandId,token,actions:z.array(action).min(1).max(2),validForMs:z.number().int().min(100).max(30000).default(10000),
  },args=>invoke('choose',args));
  register('battle_note_decision','Optionally preserve private agent intent for an observed action token: opposing paired prediction, plan, alternatives, reason and actual MCP calculation evidence IDs. Notes never choose a move or delay battle_choose; submit deadline-sensitive choices first. Predictions stay agent claims; selected, accepted, execution and default evidence remain separate. An observed token can be annotated after submission or game completion.',{
    commandId:commandId.unwrap(),token,
    predictedOpposingActions:z.array(z.string().max(1000)).max(2).optional(),ourPlan:z.string().max(2000).optional(),reason:z.string().max(2000).optional(),alternatives:z.array(z.string().max(1000)).max(3).optional(),calculationRefs:z.array(z.string().uuid()).max(10).optional(),
  },args=>invoke('note-decision',args));
  register('battle_decision_notes','Read private saved agent decision notes for an exact team and child battle, including after its client closes. Notes describe intent and predictions; use team_metrics_game_evidence for observed actions and results. Does not restore deleted or evicted teams.',{
    teamId:z.string().regex(/^[a-f0-9]{64}$/),room:z.string().regex(/^battle-gen9championsvgc2026regmc(?:bo3)?-[1-9]\d*$/),fromTurn:z.number().int().min(0).max(10000).optional(),toTurn:z.number().int().min(0).max(10000).optional(),
  },async args=>{try{return {content:[{type:'text',text:JSON.stringify(await readDecisionNotes({workspace,...args}),null,2)}]};}catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}});
  register('battle_switch_team','Explicitly replace the approved team in the existing signed-in session while the server confirms idle. Supply exactly one full legal teamText or registered teamId. Preserves old game attribution, prepares the new report, resets upload state, and keeps the login and remaining set budget. Never uploads, searches, grants sets or changes an active/pending match. New capability requires the next normal client start; never restart an old client just for validation.',{
    confirmed,commandId:commandId.unwrap(),teamText:z.string().min(1).max(60000).optional(),teamId:z.string().regex(/^[a-f0-9]{64}$/).optional(),name:z.string().min(1).max(120).optional(),
  },async args=>{
    try{
      if(Boolean(args.teamText)===Boolean(args.teamId))throw new Error('Supply exactly one pasted teamText or registered teamId');
      let team,teamId;
      if(args.teamId)({team,teamId}=await loadMetricsTeam({workspace,teamId:args.teamId}));
      else {team=Teams.import(args.teamText);if(team?.length!==6||new TeamValidator('gen9championsvgc2026regmc').validateTeam(team)?.length)throw new Error('Supply a legal complete six-Pokemon M-C team');teamId=createHash('sha256').update(Teams.pack(team)).digest('hex');}
      return invoke('switch-team',{confirmed:args.confirmed,commandId:args.commandId,teamId,teamText:Teams.export(team),...(args.name?{name:args.name}:{})});
    }catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}
  });
  register('battle_ready','Confirm a current server-issued BO3 readiness token. Usually handled promptly by the session within the authorized set; never starts another matchmaking search.',{confirmed,commandId,token},args=>invoke('ready',args));
  register('battle_cancel_search','Cancel the current matchmaking search without forfeiting an existing battle.',{confirmed,commandId},args=>invoke('cancel-search',args));
  register('battle_forfeit','Forfeit the whole currently owned authorized BO3 using its parent room, including when no turn token is available. Requires explicit user authorization and a unique commandId. Keeps the signed-in connection open, blocks further choices/readiness for that set, and returns only sent status; inspect official parent result and server idle before considering it finished.',{
    confirmed,commandId:commandId.unwrap(),room:z.string().regex(/^game-bestof3-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/),
  },args=>invoke('forfeit',args));
  register('battle_save_replays','Save and verify official replay links for the one completed, owned M-C BO3 parent after the server confirms idle. This uploads its finished child replays with existing room privacy, keeps the signed-in client open, and never searches or logs in. Requires user authorization and a commandId. Reuse the same commandId after uncertain IPC; a new command may verify late responses without uploading a child twice. Returns its exact teamId, verified links, per-game failures and requiresReplayImport. For the current recording team, call team_metrics_sync_battles and confirm report rows before cleanup. If requiresReplayImport is true, append returned URLs with team_metrics_import_replays using the returned exact teamId, including historical parents after switching teams; confirm preservation before deleting evidence. Retain local evidence for every failure. Does not delete logs or replace the private review checkpoint.',{
    confirmed,commandId:commandId.unwrap(),room:z.string().regex(/^game-bestof3-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/),
  },args=>invoke('save-replays',args));
  register('battle_stop','Close the local battle session and its Showdown connection. During a battle this disconnects the player; it does not send a forfeit.',{confirmed,commandId},args=>invoke('stop',args));
}
