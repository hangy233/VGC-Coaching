import {createInterface} from 'node:readline';
/** Structured operator control. No raw commands, credentials or authentication operation. */
export class Controller {
  constructor(client) { this.client = client; this.results = new Map(); }
  async execute(input) {
    if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.id)) return {ok:false,error:'A unique command id is required'};
    if (this.results.has(input.id)) return this.results.get(input.id);
    // Reserve before any asynchronous operation, preventing duplicate execution.
    const task = this.dispatch(input).then(result=>({id:input.id,ok:true,result}),error=>({id:input.id,ok:false,error:error.message}));
    this.results.set(input.id, task);
    return task;
  }
  async dispatch({op, room='', confirmed=false, ...args}) {
    const c = this.client;
    const action = name => c.authorize(name,{room,confirmed});
    switch(op) {
      case 'status': return c.snapshot();
      case 'reconnect': await c.connect(); return {connected:c.connected,authenticated:false};
      case 'join': c.joinRoom(room); return {joined:room};
      case 'upload-team': if(room) throw new Error('Upload is global'); action(op); return c.uploadTeam(args.packed);
      case 'search': if(room) throw new Error('Search is global'); action(op); c.search(); return {status:'sent-not-acknowledged'};
      case 'cancel-search': if(room) throw new Error('Cancel is global'); action(op); c.cancelSearch(); return {status:'sent-not-acknowledged'};
      case 'choose': action(op); return c.choose(room,args);
      case 'ready': action(op); c.confirmReady(room); return {status:'sent-not-acknowledged'};
      case 'save-replay': action(op); c.saveReplay(room); return {status:'sent-not-acknowledged'};
      case 'verify-replay': return c.verifyReplay();
      case 'quit': c.close(); return {closed:true};
      default: throw new Error('Unsupported operation; authentication and raw commands are intentionally unavailable');
    }
  }
}
export async function runControl(client,{input=process.stdin,output=process.stdout}={}) {
  const controller = new Controller(client);
  const lines = createInterface({input});
  const emit = value => output.write(JSON.stringify(value)+'\n');
  try { for await (const line of lines) {
    if (line.length > 100000) { emit({ok:false,error:'Command exceeds size limit'}); continue; }
    let command; try { command=JSON.parse(line); } catch { emit({ok:false,error:'Invalid JSON'}); continue; }
    const reply = await controller.execute(command);
    emit(reply);
    if(command?.op === 'quit' && reply.ok && reply.result?.closed === true) break;
  }} finally { lines.close(); input.pause?.(); }
}
