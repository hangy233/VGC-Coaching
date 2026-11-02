import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Offline qualification connects only to the calculation/report MCP server.
// This creates no authenticated battle client, search, or login attempt.
export async function connectOfflineNumericClient() {
  const [{Client}, {StdioClientTransport}] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const client = new Client({name: 'offline-saved-position-numerics', version: '2.0.0'});
  const transport = new StdioClientTransport({command: process.execPath,
    args: [resolve(root, 'dist/index.js')], cwd: root, stderr: 'pipe',
    env: {VGC_TIMING_TEAM: ''}});
  transport.stderr?.resume();
  try { await client.connect(transport); }
  catch (error) { await client.close().catch(() => {}); throw error; }
  return {client, close: () => client.close()};
}
