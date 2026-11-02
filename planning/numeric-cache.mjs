import {resolve} from 'node:path';

// Cache lifetime belongs to its registration/caller. Weak references allow
// catalog deletion to invalidate live maps without keeping an MCP server alive.
const registrations=new Set(),metadata=new WeakMap();
const workspaceKey=value=>{const path=resolve(value??process.cwd());return process.platform==='win32'?path.toLowerCase():path;};
export function registerPlanningNumericCache({workspace,cache=new Map()}={}){
  if(!(cache instanceof Map))throw new TypeError('Planning numerical cache must be a Map');
  let state=metadata.get(cache);
  if(!state){state={generation:0,workspaces:new Set()};metadata.set(cache,state);registrations.add(new WeakRef(cache));}
  state.workspaces.add(workspaceKey(workspace));
  for(const ref of registrations)if(!ref.deref())registrations.delete(ref);
  while(cache.size>256)cache.delete(cache.keys().next().value);
  return cache;
}
export function planningNumericCacheGeneration(cache){return metadata.get(cache)?.generation??0;}
export function invalidatePlanningTeamCaches({workspace,teamId}={}){
  if(!/^[a-f0-9]{64}$/u.test(teamId??''))throw new TypeError('Planning cache invalidation requires an exact team fingerprint');
  const scope=workspaceKey(workspace);let removed=0;
  for(const ref of registrations){
    const cache=ref.deref();if(!cache){registrations.delete(ref);continue;}
    const state=metadata.get(cache);if(!state?.workspaces.has(scope))continue;
    // Any invalidation changes the write generation. Existing valid entries
    // owned by other teams stay reusable, but pre-deletion in-flight work may
    // no longer insert results after cleanup has removed its owner.
    state.generation++;
    for(const [key,entry] of cache)if(entry?.ownerTeamId===teamId&&(entry.ownerWorkspace===undefined||entry.ownerWorkspace===null||entry.ownerWorkspace===scope)){cache.delete(key);removed++;}
  }
  return {removed};
}
