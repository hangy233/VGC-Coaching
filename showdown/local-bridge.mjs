import net from 'node:net';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {mkdir, open, readFile, unlink,chmod} from 'node:fs/promises';
import {dirname,join,basename,resolve} from 'node:path';
import {StringDecoder} from 'node:string_decoder';

const MAX_REQUEST = 100000;
// Only a private research settlement may carry its bounded exact cached result.
// Ordinary commands retain their original request bound after framing/parsing.
const MAX_RESEARCH_SETTLE_RESULT = 1024*1024;
const MAX_RESEARCH_SETTLE_REQUEST = MAX_RESEARCH_SETTLE_RESULT+16384;
const requestLimit=command=>command?.op==='research-settle'?MAX_RESEARCH_SETTLE_REQUEST:MAX_REQUEST;
const equal = (a,b) => typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a),Buffer.from(b));

/** Only a local control capability is persisted. Never login credentials/assertions. */
export async function serveLocalSession(session, {descriptorPath} = {}) {
  if (!descriptorPath) throw new Error('Session descriptor path required');
  await mkdir(dirname(descriptorPath),{recursive:true});
  // Exclusive ownership prevents accidentally replacing a running signed-in session.
  let handle;
  try {handle = await open(descriptorPath,'wx',0o600);}catch(error){
    if(error.code==='EEXIST')throw new Error('A battle session descriptor already exists. Close the previous session first. After a crash, verify its recorded PID has stopped before removing '+descriptorPath);
    throw error;
  }
  const capability = randomBytes(32).toString('hex'), sockets = new Set();
  // OS-local IPC avoids opening a TCP listener or depending on proxy/firewall routing.
  const address=process.platform==='win32' ? '\\\\.\\pipe\\vgc-battle-'+randomBytes(16).toString('hex') : join(dirname(descriptorPath),'.vgc-'+randomBytes(8).toString('hex')+'.sock');
  let closed=false;
  const server = net.createServer(socket => {
    sockets.add(socket);socket.on('error',()=>{});
    const abort = new AbortController();socket.once('close',()=>{sockets.delete(socket);abort.abort();});
    socket.setTimeout(35000,()=>socket.destroy());
    const decoder=new StringDecoder('utf8');let data='', dispatched=false;
    socket.on('data',chunk=>{
      if (dispatched) return;
      data+=decoder.write(chunk);
      if (Buffer.byteLength(data)>MAX_RESEARCH_SETTLE_REQUEST+1) {socket.destroy();return;}
      const end=data.indexOf('\n');if(end<0)return;
      dispatched=true;
      let message;
      try {message=JSON.parse(data.slice(0,end));}catch{socket.end(JSON.stringify({ok:false,error:'Invalid local request'})+'\n');return;}
      if(Buffer.byteLength(data.slice(0,end))>requestLimit(message?.command)){socket.end(JSON.stringify({ok:false,error:'Local request exceeds its command bound'})+'\n');return;}
      if(message?.command?.op==='research-settle'&&message.command.result!==undefined&&Buffer.byteLength(JSON.stringify(message.command.result))>MAX_RESEARCH_SETTLE_RESULT){socket.end(JSON.stringify({ok:false,error:'Research settlement result exceeds its cache bound'})+'\n');return;}
      if (!message || typeof message!=='object' || Array.isArray(message) || !equal(message.capability,capability)) {socket.end(JSON.stringify({ok:false,error:'Local session access denied'})+'\n');return;}
      Promise.resolve().then(()=>session.execute(message.command,{signal:abort.signal})).then(reply=>{
        if (!socket.destroyed) socket.end(JSON.stringify(reply)+'\n');
        if(message.command?.op==='stop' && reply.ok && reply.result?.stopped===true && session.stopped) setTimeout(()=>close(),25).unref();
      },()=>{if(!socket.destroyed)socket.end(JSON.stringify({ok:false,error:'Local session command failed'})+'\n');});
    });
  });
  server.on('error',()=>{});
  const close = async () => {
    if(closed)return;closed=true;
    for(const socket of sockets)socket.destroy();
    await new Promise(resolve=>server.close(()=>resolve()));
    try { const current=JSON.parse(await readFile(descriptorPath,'utf8'));if(current.sessionId===session.id)await unlink(descriptorPath); }catch{}
  };
  try {
    await new Promise((resolvePromise,reject)=>{server.once('error',reject);server.listen(address,()=>{server.off('error',reject);resolvePromise();});});
    if(process.platform!=='win32')await chmod(address,0o600);
    await handle.writeFile(JSON.stringify({version:1,pid:process.pid,sessionId:session.id,address,capability}));
    await handle.close();
    return {close,descriptorPath};
  }catch(error){await handle.close().catch(()=>{});await close();await unlink(descriptorPath).catch(()=>{});throw error;}
}

export async function callLocalSession(descriptorPath, command, {timeoutMs=35000,signal} = {}) {
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>35000)throw new TypeError('Local session timeoutMs must be positive and at most 35000');
  if(signal!==undefined&&!(signal instanceof AbortSignal))throw new TypeError('Local session signal must be an AbortSignal');
  const lifetime=new AbortController();
  const aborted=()=>Object.assign(new Error('Local session request aborted; execution may be uncertain. Inspect status before retrying any action. Do not replay an uncertain action.'),{name:'AbortError',code:'ABORT_ERR'});
  const abort=()=>lifetime.abort(aborted());
  if(signal?.aborted)throw aborted();
  signal?.addEventListener('abort',abort,{once:true});
  const timeout=setTimeout(()=>lifetime.abort(Object.assign(new Error('Local session did not reply; inspect status before retrying any action. Do not replay an uncertain action.'),{name:'TimeoutError',code:'ETIMEDOUT'})),timeoutMs);
  try {
    let descriptor;
    try {descriptor=JSON.parse(await readFile(descriptorPath,{encoding:'utf8',signal:lifetime.signal}));}
    catch {if(lifetime.signal.aborted)throw lifetime.signal.reason;throw new Error('No available battle session. Start showdown/session.mjs and sign in in your terminal.');}
    if(lifetime.signal.aborted)throw lifetime.signal.reason;
    const validAddress=typeof descriptor?.address==='string' && (process.platform==='win32' ? /^\\\\\.\\pipe\\vgc-battle-[a-f0-9]{32}$/.test(descriptor.address) : resolve(dirname(descriptor.address))===resolve(dirname(descriptorPath)) && /^\.vgc-[a-f0-9]{16}\.sock$/.test(basename(descriptor.address)));
    if(descriptor?.version!==1 || !validAddress || !/^[a-f0-9]{64}$/.test(descriptor.capability) || typeof descriptor.sessionId!=='string')throw new Error('Invalid local session descriptor');
    return await new Promise((resolve,reject)=>{
      const socket=net.createConnection(descriptor.address);
      const decoder=new StringDecoder('utf8');let response='',done=false;
      const finish=(error,reply)=>{
        if(done)return;done=true;lifetime.signal.removeEventListener('abort',cancel);socket.destroy();
        if(error)reject(error);else resolve(reply);
      };
      const cancel=()=>finish(lifetime.signal.reason);
      const fail=()=>finish(new Error('Battle session is unavailable; check the user terminal. Do not replay an uncertain action.'));
      lifetime.signal.addEventListener('abort',cancel,{once:true});
      socket.on('error',fail);socket.on('end',fail);socket.on('close',fail);
      socket.on('connect',()=>{if(!done&&!lifetime.signal.aborted){const text=JSON.stringify({capability:descriptor.capability,command});if(Buffer.byteLength(text)>requestLimit(command)||command?.op==='research-settle'&&command.result!==undefined&&Buffer.byteLength(JSON.stringify(command.result))>MAX_RESEARCH_SETTLE_RESULT){finish(new Error('Local request exceeds its command bound'));return;}socket.write(text+'\n');}});
      socket.on('data',chunk=>{
        if(done)return;
        response+=decoder.write(chunk);
        if(Buffer.byteLength(response)>2000000){fail();return;}
        const end=response.indexOf('\n');if(end<0)return;
        try {finish(null,JSON.parse(response.slice(0,end)));}catch{finish(new Error('Invalid local session reply'));}
      });
      if(lifetime.signal.aborted)cancel();
    });
  } finally {clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
}
