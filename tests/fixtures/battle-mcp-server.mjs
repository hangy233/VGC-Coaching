import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {registerBattleTools} from '../../showdown/mcp-tools.mjs';
const server=new McpServer({name:'battle-fixture',version:'1'});
registerBattleTools(server,{workspace:process.argv[2]});
await server.connect(new StdioServerTransport());
