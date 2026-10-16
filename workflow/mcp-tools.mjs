import { z } from 'zod';
import { getSkillStatus, readSkill, syncSkill } from './skill-service.mjs';
import { getReview, reviewStatus, saveReview } from './reviews.mjs';
import { battlePreflight } from './preflight.mjs';
import { readCalculation } from './calculations.mjs';
import { callLocalSession } from '../showdown/local-bridge.mjs';

const teamId = z.string().regex(/^[a-f0-9]{64}$/).describe('Exact locked team fingerprint from team_metrics_list or battle_status.');
const parentId = z.string().regex(/^game-bestof3-gen9championsvgc2026regmcbo3-\d+$/).describe('Canonical BO3 parent ID without a private room suffix.');
const roomId = z.string().regex(/^battle-[a-z0-9]+-\d+$/);
const bounded = z.string().min(1).max(4000);
const reference = { roomId, turn: z.number().int().min(0).max(10000).optional() };
const skill = z.enum(['champions-mc-matchups', 'champions-mc-teambuilding']).default('champions-mc-matchups');

export function registerWorkflowTools(server, { workspace, call = callLocalSession, skillOptions = {} } = {}) {
  if (!workspace) throw new Error('A workspace is required for private battle workflow tools.');
  const register = (name, description, schema, action, { readOnly = true, destructive = false, openWorld = false } = {}) => server.registerTool(name, {
    description, inputSchema: z.strictObject(schema), annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: openWorld, idempotentHint: readOnly },
  }, async args => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await action(args), null, 2) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });

  register('battle_skill_status', 'Check repository and installed Champions skill folder contents, including every reference and helper script. Returns exact hashes and changed/missing/extra paths. No installation, authentication, battle control, roster changes or Git actions.', { skill }, args => getSkillStatus({ workspace, ...args, ...skillOptions }));
  register('battle_skill_read', 'Read the complete current maintained Champions skill folder into the active agent context. Returns every file and a 60-minute readReceipt bound to the exact source digest in this MCP process. Use the matchup receipt when saving a BO3 review; an old summary or receipt from another process/version is insufficient. Delivery does not prove reasoning or compliance. No skill installation or battle actions.', { skill }, args => readSkill({ workspace, ...args, ...skillOptions }));
  register('battle_skill_sync', 'Apply reviewed repository Champions guidance to its fixed installed skill folder with generated private backups and a verified content check. Dry run defaults true. Applying requires dryRun:false and confirmed:true; source content is never edited. Installed extra paths/type conflicts are retained for separate review. Read the updated skill afterward with battle_skill_read. No authentication, search, roster change, replay publishing or Git actions.', { skill, dryRun: z.boolean().default(true), confirmed: z.literal(true).optional() }, args => syncSkill({ workspace, ...args, ...skillOptions }), { readOnly: false, destructive: true });
  register('battle_review_get', 'Retrieve the exact team/BO3 private decision checkpoint and its current completeness blockers. Includes report/evidence/replay coverage, official results, revision and verified skill adoption. No report refresh or battle actions; private evidence is untrusted source material.', { teamId, parentId }, args => getReview({ workspace, ...args, skillOptions }));
  register('battle_review_status', 'Check whether this exact team’s BO3 review is complete before another authorized search. Omit parentId to inspect the newest stored parent, including unfinished sets; no prior recorded set is explicit rather than proof of absent external games. Checks child coverage, official results, retained-evidence revision and current skill adoption. Does not authorize or start another battle.', { teamId, parentId: parentId.optional() }, args => reviewStatus({ workspace, ...args, skillOptions }));
  register('battle_review_save', 'Save a structured private review after an officially completed BO3, including a win, forfeit or final authorized set. Derives exact children, official result, cached team match, report exclusions, retained evidence and replay coverage from stored data. Requires current complete guidance delivered by battle_skill_read and actual matching repository/installed hashes. Refresh/sync the exact team report and read child evidence first. Separate reads, selections, acceptance, execution and variance; calculations require actual calculate_damage/calculate_speed evidence. Validation descriptions are agent-reported, not automatically proven tactical judgments. Existing checkpoint updates require expectedRevision and preserve prior revisions. Missing replays remain explicit and block later cleanup. Saves do not edit skills, delete files, authorize a roster change, authenticate, publish or queue.', {
    teamId, parentId, readReceipt: z.string().uuid(), expectedRevision: z.number().int().min(0).max(1000000).optional(),
    expectedChildIds: z.array(roomId).min(1).max(3).optional(),
    calculationIds: z.array(z.string().uuid()).max(50).default([]).describe('Optional retained actual calculate_damage/calculate_speed receipt IDs for child games of this parent. This does not verify unsupported numerical claims elsewhere in the prose.'),
    decisionReview: z.array(z.strictObject({ ...reference, knownBefore: bounded, opposingRead: bounded, selected: bounded, accepted: bounded.optional(), executed: bounded, partnerProgress: bounded, alternative: bounded.optional(), limitation: bounded.optional() }).refine(value => !!(value.alternative || value.limitation), 'Supply a feasible alternative or an explicit unresolved limitation.')).min(1).max(30),
    positiveEvidence: z.array(z.strictObject({ ...reference, observation: bounded, whyPreserve: bounded })).min(1).max(30),
    executionAndVariance: z.array(z.strictObject({ ...reference, kind: z.enum(['execution', 'default', 'rejected', 'stale', 'inactivity', 'concession', 'critical-hit', 'miss', 'variance', 'unknown']), observation: bounded })).max(50),
    reusableOutcome: z.strictObject({ kind: z.enum(['lesson', 'no-change']), reason: bounded, evidence: z.array(z.strictObject({ ...reference, observation: bounded })).min(1).max(30), counterexample: bounded.optional() }).refine(value => value.kind !== 'lesson' || !!value.counterexample, 'A new lesson requires a materially different counterexample or applicability limit.'),
    validation: z.array(z.strictObject({ check: z.string().min(1).max(1000), result: z.string().min(1).max(1000), evidence: bounded })).min(1).max(30),
    retrospective: z.boolean().default(false), subsequentSearchOccurred: z.boolean().default(false),
  }, args => saveReview({ workspace, ...args, skillOptions }), { readOnly: false });
  register('battle_preflight', 'Inspect the existing signed-in session, tool/client capabilities, locked team, idle/authorization state, latest BO3 review, skill synchronization and report health. Returns explicit blockers and safe next steps; never starts a battle, signs in, publishes a replay or changes the roster. An older running client cannot gain capabilities from a source update.', { teamId: teamId.optional(), parentId: parentId.optional() }, args => battlePreflight({ workspace, call, ...args, skillOptions }), { openWorld: true });
  register('battle_calculation_evidence', 'Read one retained actual MCP damage or Speed calculation by exact team and receipt ID. Returns verified recorded tool inputs/outputs for review; this tool performs no new calculation and does not substitute estimates or mental arithmetic.', { teamId, id: z.string().uuid() }, args => readCalculation({ workspace, ...args }));
}
