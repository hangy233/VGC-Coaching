import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {registerBattleTools} from '../../showdown/mcp-tools.mjs';
import {registerMetricsTools} from '../../metrics/mcp-tools.mjs';

const server=new McpServer({name:'report-cycle-fixture',version:'1'});
const workspace=process.argv[2];
registerBattleTools(server,{workspace});
registerMetricsTools(server,{workspace});
await server.connect(new StdioServerTransport());
