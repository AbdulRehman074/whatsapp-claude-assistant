import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);

db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,              -- short slug, e.g. "mounir"
  label TEXT NOT NULL,              -- shown on the inbox page
  owner_name TEXT NOT NULL,         -- used to sign drafts
  inbox_token TEXT NOT NULL UNIQUE, -- secret part of the inbox link
  setup_token TEXT NOT NULL UNIQUE, -- secret part of the one-time setup link
  webhook_secret TEXT NOT NULL,     -- secret part of the webhook URL
  d360_api_key TEXT,                -- pasted by the number owner on the setup page
  display_number TEXT,              -- filled from the first webhook
  summary_to TEXT,                  -- WhatsApp number (digits) that receives the daily summary
  summary_time TEXT DEFAULT '18:00',
  summary_template TEXT DEFAULT 'daily_summary',
  summary_template_lang TEXT DEFAULT 'en',
  knowledge_file TEXT,
  last_summary_date TEXT,
  owner_last_inbound INTEGER,       -- last time summary_to wrote to this number (24h window)
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS private_contacts (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (channel_id, phone)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,              -- WhatsApp message id
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  contact TEXT NOT NULL,            -- customer phone (digits)
  direction TEXT NOT NULL,          -- in | out
  type TEXT,
  text TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_contact ON messages(channel_id, contact, ts);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  contact TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL,             -- pending | open | done | personal
  category TEXT,
  urgent INTEGER DEFAULT 0,
  language TEXT,
  source TEXT,
  summary TEXT,
  draft TEXT,
  needs_info TEXT,                  -- JSON array of things Mounir must fill in
  last_msg_ts INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  done_reason TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS items_open ON items(channel_id, status);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);
for (const col of ['knowledge_text TEXT', 'inbox_revealed INTEGER DEFAULT 0']) {
  try { db.exec(`ALTER TABLE channels ADD COLUMN ${col}`); } catch { /* already there */ }
}
export const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
export const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

export const now = () => Date.now();
export const token = (n = 24) => crypto.randomBytes(n).toString('base64url');
export const digits = (s) => String(s || '').replace(/\D/g, '');

export function getChannelBy(field, value) {
  if (!['id', 'inbox_token', 'setup_token'].includes(field)) throw new Error('bad field');
  return db.prepare(`SELECT * FROM channels WHERE ${field} = ?`).get(value);
}
export const listChannels = () => db.prepare('SELECT * FROM channels ORDER BY created_at').all();

export function addChannel({ id, label, ownerName, summaryTo, summaryTime, knowledgeFile, knowledgeText }) {
  db.prepare(`INSERT INTO channels (id,label,owner_name,inbox_token,setup_token,webhook_secret,summary_to,summary_time,knowledge_file,knowledge_text,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, label, ownerName, token(), token(), token(18), digits(summaryTo) || null,
    summaryTime || '18:00', knowledgeFile || 'template.md', knowledgeText ?? null, now());
  return getChannelBy('id', id);
}
export function updateChannel(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE channels SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}

export const isPrivate = (channelId, phone) =>
  !!db.prepare('SELECT 1 FROM private_contacts WHERE channel_id = ? AND phone = ?').get(channelId, digits(phone));

export function addPrivate(channelId, phone, note = null) {
  const p = digits(phone);
  if (!p) return;
  db.prepare('INSERT OR IGNORE INTO private_contacts (channel_id, phone, note) VALUES (?,?,?)').run(channelId, p, note);
  // Forget everything stored about this contact.
  db.prepare('DELETE FROM messages WHERE channel_id = ? AND contact = ?').run(channelId, p);
  db.prepare('DELETE FROM items WHERE channel_id = ? AND contact = ?').run(channelId, p);
}
export const removePrivate = (channelId, phone) =>
  db.prepare('DELETE FROM private_contacts WHERE channel_id = ? AND phone = ?').run(channelId, digits(phone));
export const listPrivate = (channelId) =>
  db.prepare('SELECT phone, note FROM private_contacts WHERE channel_id = ? ORDER BY phone').all(channelId);

export function saveMessage(m) {
  db.prepare(`INSERT OR IGNORE INTO messages (id, channel_id, contact, direction, type, text, ts) VALUES (?,?,?,?,?,?,?)`)
    .run(m.id, m.channelId, m.contact, m.direction, m.type, m.text, m.ts);
}
export const recentMessages = (channelId, contact, limit = 14) =>
  db.prepare('SELECT * FROM messages WHERE channel_id = ? AND contact = ? ORDER BY ts DESC LIMIT ?')
    .all(channelId, contact, limit).reverse();

export function purgeOld(days) {
  const cutoff = now() - days * 86400000;
  db.prepare('DELETE FROM messages WHERE ts < ?').run(cutoff);
  db.prepare("DELETE FROM items WHERE status IN ('done','personal') AND updated_at < ?").run(cutoff);
  // Items flagged personal are only kept a day so he can correct a wrong guess.
  db.prepare("DELETE FROM items WHERE status = 'personal' AND updated_at < ?").run(now() - 86400000);
}
