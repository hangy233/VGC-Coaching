import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {callLocalSession} from './local-bridge.mjs';

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
  const register=(name,description,schema,handler)=>server.registerTool(name,{description,inputSchema:z.strictObject(schema),annotations:{readOnlyHint:['battle_status','battle_wait'].includes(name),destructiveHint:['battle_stop','battle_forfeit'].includes(name),openWorldHint:true}},handler);
  register('battle_status','Read the terminal-owned signed-in client: compact battle state, current action tokens, known/unknown stats and observed clocks. Does not log in or queue.',{},()=>invoke('status'));
  register('battle_wait','Wait for a state revision change (up to 30 seconds), including urgent ready prompts, turns, errors or results. Pass the last observed revision to avoid polling raw logs.',{
    afterRevision:z.number().int().min(0).optional(),timeoutMs:z.number().int().min(0).max(30000).default(25000),
  },args=>invoke('wait',args));
  register('battle_start','Upload the terminal session’s locked approved team and search for ONE M-C BO3 set. Before calling, follow champions-mc-matchups: verify installed skill sync and complete the previous BO3 decision-review/update checkpoint, including a justified no-change review where appropriate. Requires user authorization; never auto-queues another set. The transport checks scope/idle, not review completion.',{confirmed,commandId},args=>invoke('start',args));
  register('battle_authorize_sets','Extend the signed-in session’s set budget only after an explicit user request. Requires live, server-confirmed idle state with no pending match; keeps the same account and team, and never queues a search. Total budget is at most 100 sets.',{
    confirmed,commandId,additionalSets:z.number().int().min(1).max(100),
  },args=>invoke('authorize-sets',args));
  register('battle_choose','Send a complete doubles decision for a current action token. Returns sent status; inspect server acceptance and execution evidence separately. No automatic battle choices.',{
    confirmed,commandId,token,actions:z.array(action).min(1).max(2),validForMs:z.number().int().min(100).max(30000).default(10000),
  },args=>invoke('choose',args));
  register('battle_ready','Confirm a current server-issued BO3 readiness token. Usually handled promptly by the session within the authorized set; never starts another matchmaking search.',{confirmed,commandId,token},args=>invoke('ready',args));
  register('battle_cancel_search','Cancel the current matchmaking search without forfeiting an existing battle.',{confirmed,commandId},args=>invoke('cancel-search',args));
  register('battle_forfeit','Forfeit the whole currently owned authorized BO3 using its parent room, including when no turn token is available. Requires explicit user authorization and a unique commandId. Keeps the signed-in connection open, blocks further choices/readiness for that set, and returns only sent status; inspect official parent result and server idle before considering it finished.',{
    confirmed,commandId:commandId.unwrap(),room:z.string().regex(/^game-bestof3-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/),
  },args=>invoke('forfeit',args));
  register('battle_save_replays','Save and verify official replay links for the one completed, owned M-C BO3 parent after the server confirms idle. This uploads its finished child replays with existing room privacy, keeps the signed-in client open, and never searches or logs in. Requires user authorization and a commandId. Reuse the same commandId after uncertain IPC; a new command may verify late responses without uploading a child twice. Returns verified links and per-game failures; retain local evidence for every failure. Does not delete logs or replace the private review checkpoint.',{
    confirmed,commandId:commandId.unwrap(),room:z.string().regex(/^game-bestof3-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/),
  },args=>invoke('save-replays',args));
  register('battle_stop','Close the local battle session and its Showdown connection. During a battle this disconnects the player; it does not send a forfeit.',{confirmed,commandId},args=>invoke('stop',args));
}
