import {z} from 'zod';
import {getTeamReport, listTeams, MAX_ACTIVE_TEAMS} from './store.mjs';
import {importBattleFiles, refreshMetricsSources, registerTeamFromFile} from './import.mjs';
import {importReplayUrls} from './replays.mjs';
import {exportReport, addTeamProfileLinks} from './dashboard.mjs';
import {updateTeamReport} from './live-reports.mjs';
import {getAgentTeamReport} from './agent-service.mjs';
import {readGameEvidence} from './retention.mjs';
import {finalizeBo3} from './finalize.mjs';

const teamId=z.string().regex(/^[a-f0-9]{64}$/).describe('Exact team fingerprint from team_metrics_list.');
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T.*)?$/).refine(value=>Number.isFinite(Date.parse(value)),'Use an ISO date or timestamp.');
const filters={
  teamId:teamId.optional(),
  opponentSpecies:z.string().min(1).max(100).optional().describe('Only games with this exact species/form on the opposing roster or positively observed in battle.'),
  selectedSpecies:z.string().min(1).max(100).optional().describe('Only games where this Pokémon was selected on your team.'),
  outcome:z.enum(['win','loss','tie','unknown']).optional(),
  includeIncomplete:z.boolean().default(false),
  includeOperational:z.boolean().default(false).describe('Include games flagged for inactivity, default choices or other operational problems; excluded by default.'),
  from:date.optional(),to:date.optional(),
};

export function registerMetricsTools(server,{workspace,replayImporter=importReplayUrls,bo3Finalizer=finalizeBo3}={}) {
  if (!workspace) throw new Error('A workspace is required for private team metrics.');
  const result=async action=>{
    try { return {content:[{type:'text',text:JSON.stringify(await action(),null,2)}]}; }
    catch(error) { return {isError:true,content:[{type:'text',text:error.message}]}; }
  };
  const register=(name,description,schema,readOnly,handler,{openWorld=false,teamChoice=false}={})=>server.registerTool(name,{
    description,inputSchema:teamChoice?z.strictObject(schema).refine(value=>Boolean(value.teamFile)!==Boolean(value.teamId),{message:'Supply exactly one of teamFile or teamId.'}):z.strictObject(schema),
    annotations:{readOnlyHint:readOnly,destructiveHint:false,openWorldHint:openWorld,idempotentHint:readOnly},
  },handler);
  register('team_metrics_list','List up to 10 active exact team versions in last-used order, sample sizes and profile metadata. Include archived versions to find recoverable older teams. Listing does not change usage order. Refreshes remembered local logs only; never logs in, searches, publishes or changes a battle.',{
    includeArchived:z.boolean().default(false),
  },true,args=>result(async()=>{const refresh=await refreshMetricsSources({workspace});const all=await listTeams({workspace,includeArchived:true});const teams=await addTeamProfileLinks({workspace,teams:args.includeArchived?all:all.filter(team=>team.active!==false)});return {teams,capacity:{maxActiveTeams:MAX_ACTIVE_TEAMS,activeTeams:all.filter(team=>team.active!==false).length,archivedTeams:all.filter(team=>team.archived).length},refresh};}));
  register('team_metrics_report','Report selection/leads, game and set results, executed move uses, direct and attributed indirect knockouts, and observed item removals by Pokémon. Failed/missed/blocked counts can overlap executed uses. Unknown selections and excluded incomplete/operational games remain explicit. Access marks this exact team version recently used, restores an archived version if requested, and refreshes its stable profile. Omitted teamId works only with one active team.',filters,true,args=>result(async()=>{const refresh=await refreshMetricsSources({workspace});const report=await getTeamReport({workspace,...args});const stableReport=report.team?.teamId?await updateTeamReport({workspace,teamId:report.team.teamId}):null;return {...report,stableReport,refresh};}));
  register('team_metrics_agent_report','Read an evidence-backed team review brief for an AI or agent: exact team version and immutable set snapshot, sample sizes and exclusions, metric definitions, descriptive review signals and supporting game IDs. Use filters to investigate matchups and includeGames for the included per-game observations. Read the cited turns and open sheets before attributing a loss or changing skills or a roster; use actual MCP calculate_damage and calculate_speed for numerical battle advice. This report does not make or authorize those changes. Refreshes remembered local logs, marks the requested team recently used and updates its stable profile; never authenticates, searches or publishes.',{
    ...filters,
    includeGames:z.boolean().default(false).describe('Include per-game measured observations in addition to the compact brief and cited game IDs.'),
    maxEvidence:z.number().int().min(1).max(20).default(5).describe('Maximum supporting game references per review signal.'),
  },true,args=>result(async()=>{const refresh=await refreshMetricsSources({workspace});const brief=await getAgentTeamReport({workspace,...args});const stableReport=brief.team?.teamId?await updateTeamReport({workspace,teamId:brief.team.teamId}):null;return {...brief,stableReport,refresh};}));
  register('team_metrics_register_team','Save a complete legal M-C team as an exact version before its first game and create its private stable report. Access marks it recently used; at most 10 team versions stay active, with older versions recoverably archived. Reads only the supplied local team file; never changes the signed-in battle team or starts a battle.',{
    teamFile:z.string().min(1).max(2048),name:z.string().min(1).max(120).optional(),
  },false,args=>result(()=>registerTeamFromFile({workspace,...args})));
  register('team_metrics_game_evidence','Read retained compact evidence for one exact team/game, optionally by turn range. Works after redundant local logs are cleaned. Returns sanitized protocol, known sheets and available decision observations; a public replay alone does not recover private selections or intent. No replay upload, authentication or battle control.',{
    teamId,roomId:z.string().regex(/^battle-[a-z0-9]+-\d+$/),
    fromTurn:z.number().int().min(0).max(10000).optional(),toTurn:z.number().int().min(0).max(10000).optional(),
  },true,args=>result(()=>readGameEvidence({workspace,...args})));
  register('team_metrics_finalize_bo3','Preserve useful data and clean explicitly listed temporary files after one officially completed, reviewed BO3. Dry run is the default and never uploads or deletes. With confirmed:true and dryRun:false, optionally save/verify child replays through the existing signed-in client, archive compact per-game evidence, refresh report links, and delete only eligible closed run files after verified evidence and skill checkpoint checks. Active/shared logs, session controls, teams, calculations, reviews and durable metrics are protected. Existing user authorization is required; never signs in, queues or changes the roster.',{
    teamId,parentId:z.string().regex(/^game-bestof3-gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?$/),
    checkpointFile:z.string().min(1).max(2048),sourceFiles:z.array(z.string().min(1).max(2048)).max(20).default([]),
    cleanupFiles:z.array(z.string().min(1).max(2048)).max(100).default([]),
    closedFiles:z.array(z.string().min(1).max(2048)).max(100).default([]).describe('Exact listed cleanup files whose separate writer is known to have closed. Needed for cleanup while the client stays open; never overrides active/shared source protections.'),
    dryRun:z.boolean().default(true),confirmed:z.literal(true).optional(),saveReplays:z.boolean().default(false),
  },false,args=>result(()=>bo3Finalizer({workspace,...args})),{openWorld:true});
  register('team_metrics_import','Import existing local Showdown protocol/event logs into the private metrics store. Paths must resolve inside this workspace. Requires the owner username and exactly one of a saved teamId or a complete teamFile. Saved IDs resolve the immutable validated team snapshot. Optional ledger flags operational games and official set results. Reads no credentials and performs no battle or network actions.',{
    files:z.array(z.string().min(1).max(2048)).min(1).max(20),
    username:z.string().min(1).max(30),teamFile:z.string().min(1).max(2048).optional(),teamId:teamId.optional(),
    ledgerFile:z.string().min(1).max(2048).optional(),name:z.string().min(1).max(120).optional(),
    remember:z.boolean().default(true).describe('Remember these workspace-local source paths and refresh their metrics when list/report/export is requested.'),
  },false,args=>result(()=>importBattleFiles({workspace,...args})),{teamChoice:true});
  register('team_metrics_import_replays','Read existing Pokémon Showdown replay URLs and import their protocol metrics into an exact local team version. Requires the owner username and exactly one of a saved teamId or complete local M-C teamFile. Saved IDs use the immutable validated snapshot, so the original export is not needed again. Fetches only supported replay endpoints; never publishes a replay, authenticates or queues a battle. Private replay access URLs are not returned or remembered.',{
    urls:z.array(z.string().min(1).max(2048)).min(1).max(20),
    username:z.string().min(1).max(30),teamFile:z.string().min(1).max(2048).optional(),teamId:teamId.optional(),
    ledgerFile:z.string().min(1).max(2048).optional(),name:z.string().min(1).max(120).optional(),
  },false,args=>result(async()=>{
    try{return await replayImporter({workspace,...args});}
    catch{throw new Error('Replay import failed. Check the supported replay URLs, owner username and saved team ID or local team file.');}
  }),{openWorld:true,teamChoice:true});
  register('team_metrics_export','Export a private standalone HTML dashboard, spreadsheet-friendly CSV, or JSON report. Writes a new file only in cache/team-metrics/reports, never overwrites files, and loads no network assets. Dashboard opponent/result filters recompute its aggregate summaries and all tables from the included game metrics.',{
    ...filters,format:z.enum(['html','csv','json']).default('html'),
    output:z.string().min(1).max(2048).optional().describe('Safe filename such as team-review.html in cache/team-metrics/reports; an existing file is never replaced.'),
  },false,args=>result(async()=>{const {format,output,...reportFilters}=args;const refresh=await refreshMetricsSources({workspace});const data=await getTeamReport({workspace,...reportFilters});const stableReport=data.team?.teamId?await updateTeamReport({workspace,teamId:data.team.teamId}):null;const report={...data,stableReport,refresh};return {...await exportReport({workspace,report,format,output}),stableReport,refresh};}));
}
