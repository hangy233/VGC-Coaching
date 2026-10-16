import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {registerBattleTools} from '../../showdown/mcp-tools.mjs';
import {registerMetricsTools} from '../../metrics/mcp-tools.mjs';
import {registerWorkflowTools} from '../../workflow/mcp-tools.mjs';
import {registerSpeedTools} from '../../dist/speed/tools.js';
import {recordCalculation} from '../../workflow/calculations.mjs';

const server=new McpServer({name:'report-cycle-fixture',version:'1'});
const workspace=process.argv[2];
registerBattleTools(server,{workspace});
registerMetricsTools(server,{workspace});
registerWorkflowTools(server,{workspace,skillOptions:process.argv[3]?{target:process.argv[3]}:{}});
registerSpeedTools(server,{recordEvidence:entry=>recordCalculation({workspace,...entry})});
await server.connect(new StdioServerTransport());
