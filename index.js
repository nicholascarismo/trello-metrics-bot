import 'dotenv/config';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import express from 'express';
import boltPkg from '@slack/bolt';

const { App } = boltPkg;

/* =========================
   Env & Config
========================= */
const {
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,         // xapp-... (App-level token for Socket Mode)
  SLACK_SIGNING_SECRET,    // not required for Socket Mode, but we keep it for parity
  WATCH_CHANNEL_ID,        // optional: default channel to post into

  TRELLO_KEY,
  TRELLO_TOKEN,
  TRELLO_BOARD_ID,         // Board that contains each teammate's To-Do list (as separate Lists)
  PORT = 3000
} = process.env;

function mustHave(name) {
  if (!process.env[name] || String(process.env[name]).trim() === '') {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
}
mustHave('SLACK_BOT_TOKEN');
mustHave('SLACK_APP_TOKEN');
mustHave('TRELLO_KEY');
mustHave('TRELLO_TOKEN');
mustHave('TRELLO_BOARD_ID');

/* =========================
   Paths & Persistence (./data)
========================= */
const DATA_DIR = path.resolve('./data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json'); // { listIds: string[], updatedAt: ISO }
const CACHE_LISTS = path.join(DATA_DIR, 'lists-cache.json'); // cached lists from the board

async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    const txt = await fsp.readFile(file, 'utf8');
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/* =========================
   Slack App (Socket Mode)
========================= */
const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  socketMode: true,
  processBeforeResponse: true
});

app.error((e) => {
  console.error('⚠️ Bolt error:', e?.stack || e?.message || e);
});

/* =========================
   Express HTTP (health & optional future webhooks)
========================= */
const server = express();
server.use(express.json({ limit: '1mb' }));

// Health / readiness
server.get('/healthz', (_, res) => res.status(200).json({ ok: true, name: 'trello-metrics-bot' }));
server.get('/readyz',  (_, res) => res.status(200).json({ ok: true }));

server.listen(PORT, () => {
  console.log(`[http] listening on :${PORT}`);
});

/* =========================
   Trello REST helpers
========================= */
const TRELLO_BASE = 'https://api.trello.com/1';

async function trelloGET(pathname, params = {}) {
  const url = new URL(TRELLO_BASE + pathname);
  url.searchParams.set('key', TRELLO_KEY);
  url.searchParams.set('token', TRELLO_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  // Simple backoff for Trello (429/5xx)
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    const r = await fetch(url, { method: 'GET' });
    if (r.ok) return r.json();

    if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
      const retryAfter = Math.min(500 * attempt, 4000);
      console.warn(`[trello] ${r.status} ${r.statusText} -> retrying in ${retryAfter}ms (attempt ${attempt}) ${url}`);
      await new Promise(res => setTimeout(res, retryAfter));
      if (attempt < 5) continue;
    }

    const text = await r.text().catch(() => '');
    throw new Error(`Trello GET ${url} -> ${r.status} ${r.statusText} ${text}`);
  }
}

/* =========================
   Trello Data helpers
========================= */
// Cache the board lists (name + id) locally; refresh on-demand.
async function fetchBoardLists() {
  const lists = await trelloGET(`/boards/${encodeURIComponent(TRELLO_BOARD_ID)}/lists`, {
    fields: 'name,id,closed,pos',
    filter: 'open'
  });
  // Save to cache for quick reference
  try {
    await ensureDataDir();
    await writeJsonAtomic(CACHE_LISTS, { at: new Date().toISOString(), lists });
  } catch (e) {
    console.warn('⚠️ Failed to write lists cache:', e?.message || e);
  }
  return lists;
}

async function getCachedBoardLists() {
  const cached = await readJson(CACHE_LISTS, null);
  if (cached?.lists && Array.isArray(cached.lists) && cached.lists.length) return cached.lists;
  return fetchBoardLists();
}

async function getConfig() {
  await ensureDataDir();
  const cfg = await readJson(CONFIG_PATH, null);
  // structure: { listIds: string[], updatedAt: ISO }
  return cfg || null;
}

async function setConfigLists(listIds) {
  if (!Array.isArray(listIds) || listIds.length !== 6) {
    throw new Error('You must provide exactly 6 Trello List IDs.');
  }
  const deduped = Array.from(new Set(listIds.map(s => String(s).trim()).filter(Boolean)));
  if (deduped.length !== 6) throw new Error('List IDs must be 6 unique values.');
  const payload = { listIds: deduped, updatedAt: new Date().toISOString() };
  await ensureDataDir();
  await writeJsonAtomic(CONFIG_PATH, payload);
  return payload;
}

// Pull all open cards for a given list id
async function fetchOpenCardsForList(listId) {
  const cards = await trelloGET(`/lists/${encodeURIComponent(listId)}/cards`, {
    fields: 'id,name,dateLastActivity,closed'
  });
  // only open
  return (cards || []).filter(c => !c.closed);
}

/* =========================
   Age utilities
========================= */
// Trello card creation timestamp can be derived from id: first 8 hex chars = seconds since epoch.
function cardCreatedAtFromId(cardId) {
  try {
    const tsHex = cardId.substring(0, 8);
    const secs = parseInt(tsHex, 16);
    if (Number.isFinite(secs)) return new Date(secs * 1000);
  } catch {}
  return null;
}

function diffMs(a, b) {
  return Math.max(0, a.getTime() - b.getTime());
}

function ageToHuman(ms) {
  const days = ms / (1000 * 60 * 60 * 24);
  if (days < 7) {
    // days, 1 decimal
    return `${Math.round(days * 10) / 10}d`;
  }
  // weeks, 1 decimal
  const weeks = days / 7;
  return `${Math.round(weeks * 10) / 10}w`;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/* =========================
   Metrics computation
========================= */
async function computeListMetrics(listId) {
  const now = new Date();
  const cards = await fetchOpenCardsForList(listId);

  const agesMs = [];
  const cardRows = []; // for "comprehensive list"

  for (const c of cards) {
    const createdAt = cardCreatedAtFromId(c.id) || new Date(c.dateLastActivity || now);
    const ms = diffMs(now, createdAt);
    agesMs.push(ms);
    cardRows.push({
      id: c.id,
      title: c.name || '(untitled)',
      createdAt: createdAt.toISOString(),
      ageMs: ms
    });
  }

  const count = cards.length;
  const avgMs = count ? mean(agesMs) : 0;
  const maxMs = count ? Math.max(...agesMs) : 0;

  return {
    count,
    avg: count ? ageToHuman(avgMs) : '—',
    oldest: count ? ageToHuman(maxMs) : '—',
    cardRows
  };
}

/* =========================
   Slack blocks & flows
========================= */
function blocksHeader(text) {
  return [{ type: 'header', text: { type: 'plain_text', text } }];
}

function blocksDivider() {
  return [{ type: 'divider' }];
}

function blocksSectionMrkdwn(text) {
  return [{ type: 'section', text: { type: 'mrkdwn', text } }];
}

function chunk(arr, n) {
  const out = [];
  let cur = [];
  for (const x of arr) {
    cur.push(x);
    if (cur.length === n) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

// Build the main metrics report
async function buildMetricsReport() {
  const cfg = await getConfig();
  if (!cfg?.listIds?.length) {
    return {
      text: 'This app has not been configured with 6 Trello List IDs yet.',
      blocks: [
        ...blocksHeader('Trello Metrics — Not Configured'),
        ...blocksDivider(),
        ...blocksSectionMrkdwn(
          'Use `/trellometrics lists` to see all Lists on the board, then configure exactly 6 List IDs with:\n' +
          '`/trellometrics set <ID1> <ID2> <ID3> <ID4> <ID5> <ID6>`'
        )
      ]
    };
  }

  const lists = await getCachedBoardLists();
  const byId = new Map(lists.map(l => [l.id, l]));
  const nowNameStamp = new Date().toLocaleString();

  const rows = [];
  for (const listId of cfg.listIds) {
    const md = await computeListMetrics(listId);
    const nm = byId.get(listId)?.name || listId;
    rows.push({ listId, name: nm, ...md });
  }

  // Compose blocks
  const blocks = [
    ...blocksHeader('Trello Metrics'),
    ...blocksDivider()
  ];

  // Summary table rendered as sections
  for (const r of rows) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${r.name}*\n• Cards: *${r.count}*\n• Avg age: *${r.avg}*\n• Oldest: *${r.oldest}*`
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Show card ages' },
        action_id: 'show_cards_for_list',
        value: JSON.stringify({ listId: r.listId })
      }
    });
  }

  // Global button to show all cards across all lists
  blocks.push(...blocksDivider());
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Show ALL card titles & ages' },
        action_id: 'show_all_cards_all_lists',
        value: JSON.stringify({ at: Date.now() })
      }
    ]
  });
  blocks.push(...blocksDivider());
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_Last updated: ${nowNameStamp}_` }] });

  return {
    text: 'Trello Metrics',
    blocks
  };
}

function renderCardAgesBlocks(listName, rows) {
  if (!rows.length) {
    return [
      ...blocksHeader(`${listName} — Card Ages`),
      ...blocksDivider(),
      ...blocksSectionMrkdwn('_No open cards on this list._')
    ];
  }

  const fields = rows.map(r => ({
    type: 'mrkdwn',
    text: `*${r.title}*\n${ageToHuman(r.ageMs)}`
  }));

  const blocks = [
    ...blocksHeader(`${listName} — Card Ages`),
    ...blocksDivider()
  ];

  const chunks = chunk(fields, 10);
  for (const ch of chunks) {
    blocks.push({ type: 'section', fields: ch });
  }

  return blocks;
}

/* =========================
   Slack Command: /trellometrics
   Subcommands:
     - (none)         → show metrics for configured 6 lists
     - lists          → list all open lists on the board (name + id)
     - set <6 IDs>    → persist the 6 list IDs
     - refresh        → refresh local cache of lists
     - help           → quick help
========================= */
app.command('/trellometrics', async ({ ack, body, client }) => {
  await ack();

  const channel = WATCH_CHANNEL_ID || body.channel_id;
  const text = (body.text || '').trim();

  try {
    const [cmd, ...rest] = text.split(/\s+/).filter(Boolean);

    if (!cmd) {
      // show metrics
      const report = await buildMetricsReport();
      await client.chat.postMessage({ channel, text: report.text, blocks: report.blocks });
      return;
    }

    if (/^help$/i.test(cmd)) {
      const lines = [
        '*Usage*',
        '• `/trellometrics` — show metrics for the 6 configured lists',
        '• `/trellometrics lists` — show all open lists on the board (name + id)',
        '• `/trellometrics set <ID1> <ID2> <ID3> <ID4> <ID5> <ID6>` — configure exactly 6 list IDs',
        '• `/trellometrics refresh` — refresh internal cache of lists'
      ];
      await client.chat.postMessage({ channel, text: lines.join('\n') });
      return;
    }

    if (/^lists$/i.test(cmd)) {
      const lists = await fetchBoardLists();
      const lines = ['*Open Lists on Board*'];
      for (const l of lists) lines.push(`• *${l.name}* — \`${l.id}\``);
      await client.chat.postMessage({ channel, text: lines.join('\n') });
      return;
    }

    if (/^refresh$/i.test(cmd)) {
      await fetchBoardLists();
      await client.chat.postMessage({ channel, text: '✅ Refreshed board lists cache.' });
      return;
    }

    if (/^set$/i.test(cmd)) {
      const ids = rest;
      try {
        const saved = await setConfigLists(ids);
        await client.chat.postMessage({
          channel,
          text: `✅ Saved 6 list IDs.\nUpdated: ${saved.updatedAt}\n${saved.listIds.map((x, i)=>`#${i+1}: \`${x}\``).join('\n')}`
        });
      } catch (e) {
        await client.chat.postMessage({ channel, text: `❌ ${e.message}` });
      }
      return;
    }

    // Unknown subcommand
    await client.chat.postMessage({ channel, text: `Unrecognized command. Try \`/trellometrics help\`.` });
  } catch (e) {
    console.error('command /trellometrics failed:', e);
    try {
      await client.chat.postMessage({ channel, text: `❌ Error: ${e?.message || e}` });
    } catch {}
  }
});

/* =========================
   Slack Actions
========================= */
app.action('show_cards_for_list', async ({ ack, body, client }) => {
  await ack();
  const channel = body.channel?.id || WATCH_CHANNEL_ID;
  const thread_ts = body.message?.ts;

  let listId = '';
  try {
    const payload = JSON.parse(body.actions?.[0]?.value || '{}');
    listId = payload.listId || '';
  } catch {}

  try {
    const lists = await getCachedBoardLists();
    const map = new Map(lists.map(l => [l.id, l.name]));
    const name = map.get(listId) || listId;

    const metrics = await computeListMetrics(listId);
    const blocks = renderCardAgesBlocks(name, metrics.cardRows);
    await client.chat.postMessage({ channel, thread_ts, text: `${name} — card ages`, blocks });
  } catch (e) {
    console.error('show_cards_for_list failed:', e);
    await client.chat.postMessage({ channel, thread_ts, text: `❌ Failed: ${e?.message || e}` });
  }
});

app.action('show_all_cards_all_lists', async ({ ack, body, client }) => {
  await ack();
  const channel = body.channel?.id || WATCH_CHANNEL_ID;
  const thread_ts = body.message?.ts;

  try {
    const cfg = await getConfig();
    if (!cfg?.listIds?.length) {
      await client.chat.postMessage({ channel, thread_ts, text: 'App is not configured with 6 list IDs yet.' });
      return;
    }

    const lists = await getCachedBoardLists();
    const map = new Map(lists.map(l => [l.id, l.name]));

    for (const listId of cfg.listIds) {
      const name = map.get(listId) || listId;
      const metrics = await computeListMetrics(listId);
      const blocks = renderCardAgesBlocks(name, metrics.cardRows);
      await client.chat.postMessage({ channel, thread_ts, text: `${name} — card ages`, blocks });
    }
  } catch (e) {
    console.error('show_all_cards_all_lists failed:', e);
    await client.chat.postMessage({ channel, thread_ts, text: `❌ Failed: ${e?.message || e}` });
  }
});

/* =========================
   Start
========================= */
(async () => {
  await ensureDataDir();

  // Light Trello connectivity check
  try {
    await trelloGET(`/boards/${encodeURIComponent(TRELLO_BOARD_ID)}`, { fields: 'name,id' });
    console.log('[trello] connectivity ok');
  } catch (e) {
    console.error('⚠️ Trello connectivity failed:', e?.message || e);
  }

  await app.start();
  console.log('✅ trello-metrics-bot running (Socket Mode)');
})();