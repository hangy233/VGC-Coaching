import {randomBytes, timingSafeEqual} from 'node:crypto';

const check=(condition,message)=>{if(!condition)throw new Error(message);};

/** A revocable local operator lease. Labels are descriptive, never credentials. */
export class ControllerLease {
  constructor({now=Date.now,required=true}={}){
    this.now=now;this.required=required;this.generation=0;this.current=null;
  }
  status(){return {required:this.required,owner:this.current?.owner??null,generation:this.generation,claimedAt:this.current?.claimedAt??null};}
  claim({controllerId,takeover=false,expectedGeneration}={}){
    check(typeof controllerId==='string'&&/^[A-Za-z0-9 _.-]{1,64}$/.test(controllerId),'Supply a short controller label');
    check(typeof takeover==='boolean','Takeover must be boolean');
    if(takeover)check(Number.isInteger(expectedGeneration)&&expectedGeneration===this.generation,'Controller generation changed; inspect fresh control status before takeover');
    check(!this.current||takeover,'Another controller owns this session; use an explicit generation-checked takeover');
    this.current={owner:controllerId,token:randomBytes(32).toString('hex'),claimedAt:this.now()};this.generation++;
    return {controllerLease:this.current.token,...this.status()};
  }
  assert(token){
    if(!this.required&&!this.current)return;
    check(typeof token==='string'&&/^[a-f0-9]{64}$/.test(token)&&this.current&&timingSafeEqual(Buffer.from(token),Buffer.from(this.current.token)),'A current controller lease is required; claim control or inspect takeover status');
  }
  release(token){this.assert(token);this.current=null;this.generation++;return this.status();}
}
