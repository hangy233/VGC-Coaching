import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {QUALIFICATION_RESEARCH_ENV,QUALIFICATION_SETUP_TOOL,qualificationResearchCaseSchema} from './qualification-research.mjs';

// Offline qualification connects only to the calculation/report MCP server.
// This creates no authenticated battle client, search, or login attempt.
export async function connectOfflineNumericClient({qualificationOnly=false}={}) {
  const [{Client}, {StdioClientTransport}] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const client = new Client({name: 'offline-saved-position-numerics', version: '2.0.0'});
  const transport = new StdioClientTransport({command: process.execPath,
    args: [resolve(root, 'dist/index.js')], cwd: root, stderr: 'pipe',
    env: {VGC_TIMING_TEAM: '',[QUALIFICATION_RESEARCH_ENV]:qualificationOnly===true?'1':''}});
  transport.stderr?.resume();
  try { await client.connect(transport); }
  catch (error) { await client.close().catch(() => {}); throw error; }
  return {client, close: () => client.close(),...(qualificationOnly===true?{
    qualificationAuthority:{mode:'child-local-saved-research',liveQuotaExercised:false,liveDescriptorAccessed:false},
    async registerQualificationCase(input){
      const spec=qualificationResearchCaseSchema.parse(input);
      const reply=await client.callTool({name:QUALIFICATION_SETUP_TOOL,arguments:spec},undefined,{timeout:Math.max(1,Math.min(5000,spec.deadlineAt-Date.now()))});
      const result=reply?.structuredContent;
      if(reply?.isError||result?.status!=='registered'||result.caseId!==spec.caseId||result.sourceSha256!==spec.sourceSha256||result.factsSha256!==spec.factsSha256||result.liveQuotaExercised!==false||result.liveDescriptorAccessed!==false)throw Error('Owned offline saved-source registration unavailable');
      return result;
    },
  }:{})};
}
