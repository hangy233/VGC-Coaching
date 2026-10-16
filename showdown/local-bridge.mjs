import net from 'node:net';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {mkdir, open, readFile, unlink,chmod} from 'node:fs/promises';
import {dirname,join,basename,resolve} from 'node:path';

const MAX_REQUEST = 100000;
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
    let data='', dispatched=false;
    socket.on('data',chunk=>{
      if (dispatched) return;
      data+=chunk.toString('utf8');
      if (Buffer.byteLength(data)>MAX_REQUEST) {socket.destroy();return;}
      const end=data.indexOf('\n');if(end<0)return;
      dispatched=true;
      let message;
      try {message=JSON.parse(data.slice(0,end));}catch{socket.end(JSON.stringify({ok:false,error:'Invalid local request'})+'\n');return;}
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

export async function callLocalSession(descriptorPath, command) {
  let descriptor;
  try {descriptor=JSON.parse(await readFile(descriptorPath,'utf8'));}catch{throw new Error('No available battle session. Start showdown/session.mjs and sign in in your terminal.');}
  const validAddress=typeof descriptor?.address==='string' && (process.platform==='win32' ? /^\\\\\.\\pipe\\vgc-battle-[a-f0-9]{32}$/.test(descriptor.address) : resolve(dirname(descriptor.address))===resolve(dirname(descriptorPath)) && /^\.vgc-[a-f0-9]{16}\.sock$/.test(basename(descriptor.address)));
  if(descriptor?.version!==1 || !validAddress || !/^[a-f0-9]{64}$/.test(descriptor.capability) || typeof descriptor.sessionId!=='string')throw new Error('Invalid local session descriptor');
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(descriptor.address);
    const timeout=setTimeout(()=>{socket.destroy();reject(new Error('Local session did not reply; inspect status before retrying any action'));},35000);
    let response='',done=false;
    const fail=()=>{if(!done){done=true;clearTimeout(timeout);reject(new Error('Battle session is unavailable; check the user terminal. Do not replay an uncertain action.'));}};
    socket.on('error',fail);socket.on('end',()=>{if(!done)fail();});
    socket.on('connect',()=>socket.write(JSON.stringify({capability:descriptor.capability,command})+'\n'));
    socket.on('data',chunk=>{
      response+=chunk.toString('utf8');
      if(Buffer.byteLength(response)>2000000){socket.destroy();fail();return;}
      const end=response.indexOf('\n');if(end<0)return;
      done=true;clearTimeout(timeout);socket.destroy();
      try {const reply=JSON.parse(response.slice(0,end));resolve(reply);}catch{reject(new Error('Invalid local session reply'));}
    });
  });
}
