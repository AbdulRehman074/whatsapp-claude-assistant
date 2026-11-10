import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader (no dependencies).
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).replace(/\s+#.*$/, '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(path.resolve(process.cwd(), '.env'));

const env = process.env;
export const config = {
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, ''),
  port: Number(env.PORT || 3000),
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  anthropicBase: (env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/$/, ''),
  model: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  timezone: env.TIMEZONE || 'Europe/Amsterdam',
  debounceSeconds: Number(env.DEBOUNCE_SECONDS || 60),
  retentionDays: Number(env.RETENTION_DAYS || 30),
  d360Base: (env.D360_BASE_URL || 'https://waba-v2.360dialog.io').replace(/\/$/, ''),
  mockClaude: env.MOCK_CLAUDE === '1',
  dryRunSend: env.DRY_RUN_SEND === '1',
  dbPath: env.DB_PATH || './data/assistant.db',
  knowledgeDir: env.KNOWLEDGE_DIR || './knowledge',
};
