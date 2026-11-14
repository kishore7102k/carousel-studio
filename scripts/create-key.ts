// Creates an agent API key for the MCP server.  npm run key:create -- "claude-code"
import { getDb, schema } from '@/db';
import { newApiKey, sha256 } from '@/lib/auth';

(async () => {
  const name = process.argv[2];
  if (!name) { console.error('usage: npm run key:create -- <agent-name>'); process.exit(1); }
  const key = newApiKey();
  await getDb().insert(schema.apiKeys).values({ name, hash: await sha256(key) });
  console.log(`API key for "${name}" (shown once, store it in the agent's MCP config):\n${key}`);
})();
