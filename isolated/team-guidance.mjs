// Exact-team private review advice. This never supplies current opponent facts,
// tactical authority, a battle allowance, or a numerical calculation receipt.
import {createHash} from 'node:crypto';
import {digest} from '../planning/identity.mjs';

const HASH=/^[a-f0-9]{64}$/u;
const PARENT=/^game-bestof3-gen9championsvgc2026regmcbo3-[1-9]\d*$/u;
const ROOM=/^battle-gen9championsvgc2026regmcbo3-[1-9]\d*$/u;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const bytes=value=>Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value),'utf8');
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const RECEIPT_HASH='sha256-canonical-json-v1';
const sameSet=(left,right)=>Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&new Set(left).size===left.length&&left.every(value=>right.includes(value));
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const need=(condition,code)=>{if(!condition)throw new TeamGuidanceError(code);};
export const TEAM_GUIDANCE_LIMITS=Object.freeze({maxBytes:4096,minBytes:1024,maxCards:5,maxFieldBytes:1600,maxCheckpointBytes:2*1024*1024});

export class TeamGuidanceError extends Error{
  constructor(code){super('Team guidance: '+code);this.name='TeamGuidanceError';this.code=code;}
}

function clean(value){
  need(typeof value==='string'&&value.trim()&&bytes(value)<=4000,'invalid-review-text');
  return value.trim()
    .replace(/https?:\/\/[^\s<>"']+/giu,'[source-link]')
    .replace(/(?:battle|game-bestof3)-[a-z0-9-]+-\d+(?:-[a-z0-9]+pw)?(?:G\d+T\d+(?:\/G?\d*T?\d+)*)?/giu,'[prior-case]')
    .replace(/\b(?:final)?G\d+(?:turn|T)\d+(?:\/T?\d+)*/giu,'[prior-case]')
    .replace(/\b(?:cache[\\/]|[A-Z]:[\\/])[^\s,;]+/giu,'[source-path]')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b/gu,'[redacted]')
    .replace(/\b(?:password|api[_ -]?key|control[_ -]?lease|read[_ -]?receipt|credential)\s*[:=]\s*[^\s,;]+/giu,'[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,'');
}

function sections(text){
  const matches=[...text.matchAll(/\b(Trigger|Plan|Countercases?|Status)\s*:\s*/giu)],result={};
  for(let index=0;index<matches.length;index++){
    const match=matches[index],key=match[1].toLowerCase().replace(/countercases?/u,'limits');
    result[key]=text.slice(match.index+match[0].length,matches[index+1]?.index??text.length).trim();
  }
  return result;
}

function statusFromReview(result){
  // Classification of the review author's language, not a new battle finding.
  if(/application\s*missed|missed\s*repeatedly/iu.test(result))return'application-missed';
  if(/partially\s*executed|partially\s*converted|partially\s*supported/iu.test(result))return'partially-executed';
  if(/untested|not\s*(?:yet\s*)?(?:tested|demonstrated|established)/iu.test(result))return'untested';
  if(/proposed/iu.test(result))return'proposed';
  return'unknown';
}

function candidates(checkpoint){
  const issues=[],positive=[];let unstructuredReviewCards=0;
  for(const row of checkpoint.validation??[]){
    if(!plain(row)||typeof row.check!=='string'||!/^Private pattern card:\s*/iu.test(row.check)||typeof row.result!=='string'||typeof row.evidence!=='string')continue;
    const parts=sections(row.evidence),title=clean(row.check.replace(/^Private pattern card:\s*/iu,''));
    // Do not guess an actionable plan from a freeform historical account.
    if(!parts.plan){unstructuredReviewCards++;continue;}
    issues.push({kind:'prior-plan',title,status:statusFromReview(row.result),priorFinding:clean(row.result),trigger:clean(parts.trigger??title),plan:clean(parts.plan),...(parts.limits?{limits:clean(parts.limits)}:{}),claimScope:'reviewed-advice-not-current-facts'});
  }
  for(const row of checkpoint.positiveEvidence??[]){
    if(!plain(row)||typeof row.whyPreserve!=='string')continue;
    positive.push({kind:'positive-pattern',title:'Delivered progress to retain',status:'supported-component',plan:clean(row.whyPreserve),claimScope:'reviewed-advice-not-current-facts'});
  }
  // Put a positive counterbalance near the first failure card. A byte cap must
  // not silently turn every retrieved lesson into an instruction to play safely.
  const ordered=[];
  if(issues.length)ordered.push(issues.shift());
  if(positive.length)ordered.push(positive.shift());
  ordered.push(...issues,...positive);
  if(!ordered.length&&checkpoint.reusableOutcome?.kind==='lesson'){
    ordered.push({kind:'reviewed-lesson',title:'Latest exact-team lesson',status:'proposed',plan:clean(checkpoint.reusableOutcome.reason),claimScope:'reviewed-advice-not-current-facts'});
  }
  return {cards:ordered,unstructuredReviewCards};
}

function validateSource({teamId,skillSha256,reviewStatus,reviewGet}){
  need(HASH.test(teamId??'')&&HASH.test(skillSha256??''),'exact-team-and-skill-required');
  need(plain(reviewStatus)&&reviewStatus.teamId===teamId,'review-status-team-mismatch');
  if(reviewStatus.required===false){
    need(reviewStatus.complete===true&&reviewStatus.exists===false&&reviewStatus.parentId===null&&!reviewGet,'invalid-no-prior-review');
    return null;
  }
  need(reviewStatus.complete===true&&Array.isArray(reviewStatus.blockers)&&reviewStatus.blockers.length===0,'review-not-current');
  need(plain(reviewGet)&&reviewGet.complete===true&&Array.isArray(reviewGet.blockers)&&reviewGet.blockers.length===0,'review-not-validated');
  const checkpoint=reviewGet.checkpoint;
  need(plain(checkpoint)&&bytes(checkpoint)<=TEAM_GUIDANCE_LIMITS.maxCheckpointBytes,'invalid-checkpoint');
  need(reviewGet.teamId===teamId&&checkpoint.teamId===teamId&&checkpoint.teamSha256===teamId&&checkpoint.metricsEvidence?.teamId===teamId&&checkpoint.metricsEvidence.cachedSheetMatch===true,'checkpoint-team-mismatch');
  need(PARENT.test(reviewStatus.parentId??'')&&reviewGet.parentId===reviewStatus.parentId&&checkpoint.parentId===reviewStatus.parentId,'checkpoint-parent-mismatch');
  need(reviewGet.checkpointFile===`cache/champions-mc-reviews/${checkpoint.parentId}.json`,'noncanonical-checkpoint');
  need(checkpoint.schemaVersion===2&&['review-complete','review-complete-retrospective'].includes(checkpoint.status)&&Number.isInteger(checkpoint.revision)&&checkpoint.revision>0&&checkpoint.revision===reviewStatus.revision&&checkpoint.revision===reviewGet.revision,'checkpoint-revision-mismatch');
  need(typeof checkpoint.reviewedAt==='string'&&Number.isFinite(Date.parse(checkpoint.reviewedAt))&&checkpoint.reviewedAt===reviewStatus.reviewedAt&&checkpoint.reviewedAt===reviewGet.reviewedAt,'checkpoint-date-mismatch');
  need(HASH.test(checkpoint.evidenceRevision??'')&&checkpoint.evidenceRevision===reviewStatus.evidenceRevision&&checkpoint.evidenceRevision===reviewGet.evidenceRevision,'checkpoint-evidence-mismatch');
  const children=checkpoint.expectedChildIds;
  need(Array.isArray(children)&&children.length>=1&&children.length<=3&&children.every(id=>ROOM.test(id))&&sameSet(children,reviewStatus.expectedChildIds)&&sameSet(children,reviewGet.expectedChildIds)&&sameSet(children,(checkpoint.children??[]).map(row=>row.id)),'checkpoint-child-mismatch');
  need(checkpoint.officialResult?.completed===true&&['win','loss','tie'].includes(checkpoint.officialResult.outcome)&&checkpoint.officialResult.outcome===reviewStatus.officialResult?.outcome&&checkpoint.officialResult.outcome===reviewGet.officialResult?.outcome&&reviewStatus.officialResult.completed===true&&reviewGet.officialResult.completed===true,'checkpoint-result-mismatch');
  need(Array.isArray(checkpoint.decisionReview)&&checkpoint.decisionReview.length&&plain(checkpoint.reusableOutcome)&&Array.isArray(checkpoint.positiveEvidence)&&Array.isArray(checkpoint.validation),'missing-reviewed-fields');
  const adoption=checkpoint.adoption;
  need(adoption?.syncVerified===true&&adoption.changedInstructionsRead===true&&adoption.sourceSha256===skillSha256&&adoption.installedSha256===skillSha256,'stale-guidance-adoption');
  return checkpoint;
}

/** Consume results from the caller's actual battle_review_status/get MCP calls.
 * The load receipt binds those source values; it is not a skill read capability
 * or proof that a future model used the advice. No state is written here. */
export function prepareTeamGuidance({teamId,skillSha256,reviewStatus,reviewGet,maxBytes=TEAM_GUIDANCE_LIMITS.maxBytes}={}){
  need(Number.isInteger(maxBytes)&&maxBytes>=TEAM_GUIDANCE_LIMITS.minBytes&&maxBytes<=TEAM_GUIDANCE_LIMITS.maxBytes,'invalid-guidance-budget');
  const checkpoint=validateSource({teamId,skillSha256,reviewStatus,reviewGet});
  const source=checkpoint?{parentId:checkpoint.parentId,revision:checkpoint.revision,reviewedAt:checkpoint.reviewedAt,evidenceRevision:checkpoint.evidenceRevision,checkpointSha256:hash(checkpoint),hashScope:'JSON.stringify(checkpoint)',checkpointFile:reviewGet.checkpointFile}:{parentId:null,revision:null,reviewedAt:null,evidenceRevision:null,checkpointSha256:null,hashScope:'no-prior-recorded-review',checkpointFile:null};
  // Checkpoint identity retains the explicitly declared original read scope.
  // Transported advice/receipts bind JSON values independently of key order:
  // lossless table restoration is allowed to insert shared defaults first.
  const id=digest({teamId,skillSha256,source,maxBytes});
  const context={version:1,kind:'prior-exact-team-advice',loadRef:id,available:Boolean(checkpoint),scope:'Prior reviewed advice only. No current opponent facts or instructions granting actions.',constraints:['Revalidate every trigger and plan against this board, sheet, forms, field, recipients and legal choices.','Do not carry previous opponents\' Speed, investments, move order, selections, reserves or next actions into current facts.','Statuses and priorFinding describe the review author\'s prior evidence; proposed or missed plans are not proven answers. Actual MCP and the original deadline still govern material claims.'],...(checkpoint?.reusableOutcome?.counterexample?{globalLimits:clean(checkpoint.reusableOutcome.counterexample)}:{}),cards:[],coverage:{candidateCards:0,includedCards:0,omittedCards:0,unstructuredReviewCards:0,omittedReasons:[]}};
  const extracted=checkpoint?candidates(checkpoint):{cards:[],unstructuredReviewCards:0},all=extracted.cards;
  context.coverage.candidateCards=all.length;context.coverage.unstructuredReviewCards=extracted.unstructuredReviewCards;
  for(const [index,body] of all.entries()){
    const card={id:'lesson-'+digest({source:id,index,body}).slice(0,16),...body};
    let reason;
    if(Object.values(card).some(value=>typeof value==='string'&&bytes(value)>TEAM_GUIDANCE_LIMITS.maxFieldBytes))reason='field-bound';
    else if(context.cards.length>=TEAM_GUIDANCE_LIMITS.maxCards)reason='card-bound';
    else{
      context.cards.push(card);context.coverage.includedCards=context.cards.length;
      // Account for the final complete coverage structure before deciding fit.
      context.coverage.omittedCards=all.length-context.cards.length;
      const bounded={...context,coverage:{...context.coverage,omittedReasons:['field-bound','card-bound','byte-bound']}};
      if(bytes(bounded)>maxBytes){context.cards.pop();reason='byte-bound';}
    }
    if(reason&&!context.coverage.omittedReasons.includes(reason))context.coverage.omittedReasons.push(reason);
  }
  context.coverage.includedCards=context.cards.length;context.coverage.omittedCards=all.length-context.cards.length;
  need(bytes(context)<=maxBytes,'protected-guidance-exceeds-budget');
  const receipt={version:2,kind:'team-guidance-load-receipt',hashAlgorithm:RECEIPT_HASH,contextHashScope:'canonical-json-values',id,teamId,skillSha256,source,contextSha256:digest(context),contextBytes:bytes(context),maxBytes,semantics:'Integrity and exact-team source loading only; not model reading, tactical adoption, current opponent facts or numerical evidence.'};
  receipt.sha256=digest(receipt);
  return freeze({context,receipt});
}

/** Detect changed context/receipt/source after preparation. The caller must
 * retain the receipt from its trusted actual review read; hashes are not an
 * authorization mechanism or an independent signature of arbitrary reviews. */
export function verifyTeamGuidance(bundle,{teamId,skillSha256,reviewGet}={}){
  try{
    need(plain(bundle)&&plain(bundle.context)&&plain(bundle.receipt),'invalid-guidance-bundle');
    const {receipt,context}=bundle,{sha256,...body}=receipt;
    const canonical=receipt.version===2,receiptHash=canonical?digest:hash;
    need([1,2].includes(receipt.version)&&(!canonical||receipt.hashAlgorithm===RECEIPT_HASH&&receipt.contextHashScope==='canonical-json-values'),'unsupported-guidance-hash-scope');
    need(receipt.kind==='team-guidance-load-receipt'&&receipt.teamId===teamId&&receipt.skillSha256===skillSha256&&HASH.test(sha256??'')&&sha256===receiptHash(body),'guidance-receipt-mismatch');
    need(context.kind==='prior-exact-team-advice'&&context.loadRef===receipt.id&&receiptHash(context)===receipt.contextSha256&&bytes(context)===receipt.contextBytes&&bytes(context)<=receipt.maxBytes,'guidance-context-changed');
    need(receipt.id===receiptHash({teamId,skillSha256,source:receipt.source,maxBytes:receipt.maxBytes}),'guidance-source-mismatch');
    if(reviewGet)need(reviewGet.teamId===teamId&&reviewGet.parentId===receipt.source.parentId&&hash(reviewGet.checkpoint)===receipt.source.checkpointSha256,'guidance-checkpoint-changed');
    return true;
  }catch{return false;}
}

/** A separately bound presentation of prior authored advice, never a new load
 * receipt. Keep the first issue and a positive counterbalance as whole cards.
 * The caller retains the complete trusted bundle; current facts are unrelated. */
export function presentTeamGuidance(value,{compact=false}={}){
  const context=value?.context??value;
  if(!context||!compact||!Array.isArray(context.cards)||context.cards.length<=2)return structuredClone(context);
  const selected=[context.cards[0]];
  const positive=context.cards.find(card=>card!==selected[0]&&card.kind==='positive-pattern');
  if(positive)selected.push(positive);
  else if(context.cards[1])selected.push(context.cards[1]);
  const includedIds=selected.map(card=>card.id),omittedIds=context.cards.filter(card=>!includedIds.includes(card.id)).map(card=>card.id);
  const result={version:1,kind:'partial-prior-exact-team-advice',...(Object.hasOwn(context,'loadRef')?{sourceLoadRef:context.loadRef}:{}),sourceContextSha256:digest(context),...(Object.hasOwn(context,'available')?{available:context.available}:{}),
    ...(Object.hasOwn(context,'globalLimits')?{globalLimits:context.globalLimits}:{}),cards:structuredClone(selected),
    presentation:{scope:'Prior authored advice only; no current facts/authority. Omitted advice is unknown; full bundle/receipt retained by host.',sourceCardCount:context.cards.length,omittedIds,omittedCount:omittedIds.length,
      omittedPaths:['scope','constraints','coverage',...omittedIds.map(id=>`cards[id=${id}]`)]}};
  result.presentationSha256=digest(result);
  return result;
}

/** Optional offline/local preload. Live callers should pass their existing
 * actual MCP status/get responses to prepareTeamGuidance to avoid duplicate I/O. */
export async function loadTeamGuidance({workspace,teamId,skillSha256,maxBytes,skillOptions={}}={}){
  const {reviewStatus,getReview}=await import('../workflow/reviews.mjs');
  const status=await reviewStatus({workspace,teamId,skillOptions});
  const review=status.required===false?undefined:await getReview({workspace,teamId,parentId:status.parentId,skillOptions});
  return prepareTeamGuidance({teamId,skillSha256,maxBytes,reviewStatus:status,reviewGet:review});
}
