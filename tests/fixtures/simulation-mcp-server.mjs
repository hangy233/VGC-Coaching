import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {registerSimulationTools} from '../../simulation/mcp-tools.mjs';
import {registerWorkflowTools} from '../../workflow/mcp-tools.mjs';
import {recordCalculation} from '../../workflow/calculations.mjs';
import {createPlanningToolClient} from '../../planning/tool-client.mjs';
import {registerPlanningTools} from '../../planning/mcp-tools.mjs';
import {createResearchBudgetToolClient} from '../../planning/research-budget.mjs';
const workspace=process.argv[2],server=new McpServer({name:'isolated-native-simulation-fixture',version:'1'});
const nativeTools=createResearchBudgetToolClient(createPlanningToolClient(server),{workspace});
registerSimulationTools(nativeTools,{workspace,recordEvidence:entry=>recordCalculation({workspace,...entry}),
  callTool:Object.assign((name,args,options)=>nativeTools.callTool(name,args,options),{runtimeVersion:nativeTools.runtimeVersion})});
const planningCall=Object.assign((name,args,options)=>nativeTools.callTool(name,args,options),{runtimeVersion:nativeTools.runtimeVersion});
registerPlanningTools(server,{workspace,callTool:planningCall});
registerWorkflowTools(server,{workspace});
await server.connect(new StdioServerTransport());
