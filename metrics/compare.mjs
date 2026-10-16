import {getTeamReport} from './store.mjs';
import {loadMetricsTeam} from './import.mjs';
const fields=['species','item','ability','nature','level','gender','shiny','happiness','moves','evs','ivs'];
/** Descriptive exact-version comparison; no damage or Speed calculations. */
export async function compareTeamReports({workspace,teamA,teamB,...filters}={}){
  if(!/^[a-f0-9]{64}$/u.test(teamA)||! /^[a-f0-9]{64}$/u.test(teamB)||teamA===teamB)throw new Error('Choose two distinct exact team fingerprints.');
  const [a,b]=await Promise.all([getTeamReport({workspace,...filters,teamId:teamA,touch:false}),getTeamReport({workspace,...filters,teamId:teamB,touch:false})]);
  async function sheet(teamId){try{return {status:'verified',sets:(await loadMetricsTeam({workspace,teamId})).team};}catch{return {status:'missing-or-invalid',sets:null};}}
  const [snapshotA,snapshotB]=await Promise.all([sheet(teamA),sheet(teamB)]);
  let setChanges=null;
  if(snapshotA.sets&&snapshotB.sets){
    const remaining=[...snapshotB.sets];setChanges=[];
    for(const oldSet of snapshotA.sets){const index=remaining.findIndex(next=>next.species===oldSet.species);if(index<0){setChanges.push({species:oldSet.species,change:'removed',before:oldSet});continue;}const [next]=remaining.splice(index,1);const changes=fields.filter(field=>JSON.stringify(oldSet[field])!==JSON.stringify(next[field])).map(field=>({field,before:oldSet[field]??null,after:next[field]??null}));if(changes.length)setChanges.push({species:oldSet.species,change:'modified',changes});}
    for(const set of remaining)setChanges.push({species:set.species,change:'added',after:set});
  }
  return {schemaVersion:1,teamA:{...a,snapshot:snapshotA},teamB:{...b,snapshot:snapshotB},setChanges,statPointUnit:'Champions native stat points, as saved in the verified Showdown export; no conversion to ordinary EVs or calculated stats.',comparison:{gamesA:a.totals.games,gamesB:b.totals.games,winRateDifferencePercentagePoints:a.totals.winRate===null||b.totals.winRate===null?null:b.totals.winRate-a.totals.winRate},interpretation:'Descriptive samples use identical filters and exact team versions. Different opponents, pilots, time windows and sample sizes prevent a causal claim that a roster change improved performance. Read turn evidence before tactical conclusions.'};
}
