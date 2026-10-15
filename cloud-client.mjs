import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const client = new Client({ name: 'cloud-coaching-client', version: '1.0.0' }, { capabilities: {} });
const env = getDefaultEnvironment();
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS']) {
  if (process.env[key]) env[key] = process.env[key];
}
const transport = new StdioClientTransport({ command: process.execPath, args: ['--use-env-proxy', fileURLToPath(new URL('dist/index.js', import.meta.url))], cwd: root, env });
try {
  await client.connect(transport);
  const name = process.argv[2] ?? 'list';
  const result = name === 'list'
    ? await client.listTools()
    : await client.callTool({ name, arguments: JSON.parse(process.argv[3] ?? '{}') }, undefined, { timeout: 120000 });
  console.log(JSON.stringify(result, null, 2));
  if (result.isError) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
