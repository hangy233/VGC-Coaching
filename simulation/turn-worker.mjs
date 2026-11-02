import {parentPort,workerData} from 'node:worker_threads';
import {simulateNativeTurn,simulateNativeTurnBatch} from './turn-simulator.mjs';
import {createTimingRecorder,timingSpan,timingEvent} from '../observability/timing.mjs';
const traced=!!workerData?.timingContext&&!!workerData?.input;
const recorder=traced?createTimingRecorder({component:'simulation-worker'}):null;
if(traced)parentPort.postMessage({type:'vgc-timing',phase:'ready'});
const execute=()=>{
  if(traced)parentPort.postMessage({type:'vgc-timing',phase:'core-begin'});
  timingEvent('simulation.worker_core_begin');
  try{
    const result=timingSpan('simulation.worker_core').run(()=>workerData?.mode==='batch'?simulateNativeTurnBatch(workerData.input):simulateNativeTurn(traced?workerData.input:workerData));
    timingEvent('simulation.worker_core_end',{outcome:'completed'});
    parentPort.postMessage({ok:true,result,...(recorder?{timing:recorder.snapshot()}:{})});
  }catch(error){
    const engineEntered=recorder?.snapshot().some(event=>event.name==='simulation.native_engine'&&event.event==='span.start');
    timingEvent('simulation.worker_core_end',{outcome:engineEntered?'engine-error':'refused-before-engine'});
    parentPort.postMessage({ok:false,error:error?.message??'Native turn simulation failed',...(recorder?{timing:recorder.snapshot()}:{})});
  }
};
if(recorder)recorder.run(workerData.timingContext,execute);else execute();
