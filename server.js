// Upfront — real backend server
// Zero external dependencies: uses only Node.js built-in modules
// (http, node:sqlite, crypto, fs, path, url). Requires Node 22.5+.

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

function checkNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const tooOld = major < 22 || (major === 22 && minor < 5);
  if (tooOld) {
    console.error(
      `\nThis server needs Node.js 22.5 or newer (for the built-in node:sqlite module).\n` +
      `You're running Node ${process.versions.node}.\n\n` +
      `Check your version with: node -v\n` +
      `Update Node, then run this again with: node server.js\n`
    );
    process.exit(1);
  }
}
checkNodeVersion();

const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'upfront.db');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    mood TEXT NOT NULL DEFAULT 'happy',
    avatar TEXT,
    theme TEXT NOT NULL DEFAULT 'classic',
    text_scale INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contacts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, contact_id)
  );

  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS folder_contacts (
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (folder_id, contact_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id);
  CREATE INDEX IF NOT EXISTS idx_messages_pair2 ON messages(recipient_id, sender_id);
`);

// ---------------------------------------------------------------------------
// Password hashing (scrypt, built into Node's crypto — no bcrypt needed)
// ---------------------------------------------------------------------------
function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, salt, hash) {
  const attempt = Buffer.from(hashPassword(password, salt), 'hex');
  const actual = Buffer.from(hash, 'hex');
  if (attempt.length !== actual.length) return false;
  return crypto.timingSafeEqual(attempt, actual);
}
function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------
const stmts = {
  insertUser: db.prepare(`INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)`),
  findUserByUsername: db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`),
  findUserById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  updateUsername: db.prepare(`UPDATE users SET username = ? WHERE id = ?`),
  updateProfile: db.prepare(`UPDATE users SET bio = ?, mood = ?, avatar = ?, theme = ?, text_scale = ? WHERE id = ?`),

  insertSession: db.prepare(`INSERT INTO sessions (token, user_id) VALUES (?, ?)`),
  findSession: db.prepare(`SELECT * FROM sessions WHERE token = ?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),

  searchUsers: db.prepare(`SELECT id, username, bio, mood, avatar FROM users WHERE username LIKE ? COLLATE NOCASE AND id != ? LIMIT 20`),

  addContact: db.prepare(`INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)`),
  listContacts: db.prepare(`
    SELECT u.id, u.username, u.bio, u.mood, u.avatar, c.created_at as added_at
    FROM contacts c JOIN users u ON u.id = c.contact_id
    WHERE c.user_id = ?
  `),

  lastMessageBetween: db.prepare(`
    SELECT text, sender_id, created_at FROM messages
    WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    ORDER BY created_at DESC, id DESC LIMIT 1
  `),
  conversation: db.prepare(`
    SELECT id, sender_id, recipient_id, text, created_at FROM messages
    WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    ORDER BY created_at ASC, id ASC
  `),
  insertMessage: db.prepare(`INSERT INTO messages (sender_id, recipient_id, text) VALUES (?, ?, ?)`),

  myFolders: db.prepare(`SELECT id, name FROM folders WHERE user_id = ? ORDER BY created_at ASC`),
  folderContactIds: db.prepare(`SELECT contact_id FROM folder_contacts WHERE folder_id = ?`),
  insertFolder: db.prepare(`INSERT INTO folders (user_id, name) VALUES (?, ?)`),
  insertFolderContact: db.prepare(`INSERT OR IGNORE INTO folder_contacts (folder_id, contact_id) VALUES (?, ?)`),
  findFolder: db.prepare(`SELECT * FROM folders WHERE id = ? AND user_id = ?`),
  deleteFolderContacts: db.prepare(`DELETE FROM folder_contacts WHERE folder_id = ?`),
  deleteFolder: db.prepare(`DELETE FROM folders WHERE id = ?`),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    bio: u.bio,
    mood: u.mood,
    avatar: u.avatar,
    theme: u.theme,
    text_scale: u.text_scale,
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) { // 2MB cap (covers a reasonable base64 avatar upload)
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const VALID_USERNAME = /^[a-zA-Z0-9_.]{2,24}$/;

function getBearerToken(req) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function getAuthedUser(req) {
  const token = getBearerToken(req) || new URL(req.url, 'http://x').searchParams.get('token');
  if (!token) return null;
  const session = stmts.findSession.get(token);
  if (!session) return null;
  return stmts.findUserById.get(session.user_id);
}

// ---------------------------------------------------------------------------
// Real-time push (Server-Sent Events — no WebSocket library needed)
// ---------------------------------------------------------------------------
const sseClients = new Map(); // user_id -> Set<res>

function registerSSE(userId, res) {
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId).add(res);
}
function unregisterSSE(userId, res) {
  const set = sseClients.get(userId);
  if (set) {
    set.delete(res);
    if (set.size === 0) sseClients.delete(userId);
  }
}
function pushToUser(userId, eventObj) {
  const set = sseClients.get(userId);
  if (!set || set.size === 0) return;
  const payload = `data: ${JSON.stringify(eventObj)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch (e) { /* client gone, cleanup happens on 'close' */ }
  }
}

// ---------------------------------------------------------------------------
// Static file serving (the whole frontend is one HTML file)
// ---------------------------------------------------------------------------
function serveIndex(res) {
  const candidates = [
    path.join(__dirname, 'index.html'),        // flat layout: server.js and index.html side by side
    path.join(PUBLIC_DIR, 'index.html'),        // or inside a public/ subfolder
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(
      'Could not find index.html. Put it in the same folder as server.js\n' +
      '(or in a "public" subfolder next to server.js) and restart the server.'
    );
    return;
  }
  fs.readFile(found, (err, content) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Could not load index.html: ' + err.message);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
async function handleSignup(req, res) {
  const body = await readJsonBody(req);
  const username = (body.username || '').trim().replace(/^@/, '');
  const password = body.password || '';

  if (!VALID_USERNAME.test(username)) {
    return sendJson(res, 400, { error: 'Username must be 2-24 characters: letters, numbers, dots, or underscores.' });
  }
  if (password.length < 4) {
    return sendJson(res, 400, { error: 'Password must be at least 4 characters.' });
  }
  if (stmts.findUserByUsername.get(username)) {
    return sendJson(res, 409, { error: 'That username is already taken.' });
  }

  const salt = makeSalt();
  const hash = hashPassword(password, salt);
  const info = stmts.insertUser.run(username, hash, salt);
  const user = stmts.findUserById.get(info.lastInsertRowid);

  const token = makeToken();
  stmts.insertSession.run(token, user.id);
  return sendJson(res, 201, { token, user: publicUser(user) });
}

async function handleSignin(req, res) {
  const body = await readJsonBody(req);
  const username = (body.username || '').trim().replace(/^@/, '');
  const password = body.password || '';

  const user = stmts.findUserByUsername.get(username);
  if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
    return sendJson(res, 401, { error: 'Incorrect username or password.' });
  }
  const token = makeToken();
  stmts.insertSession.run(token, user.id);
  return sendJson(res, 200, { token, user: publicUser(user) });
}

async function handleLogout(req, res) {
  const token = getBearerToken(req);
  if (token) stmts.deleteSession.run(token);
  return sendJson(res, 200, { ok: true });
}

async function handleMe(req, res, user) {
  return sendJson(res, 200, { user: publicUser(user) });
}

async function handleUpdateMe(req, res, user) {
  const body = await readJsonBody(req);

  if (typeof body.username === 'string' && body.username.trim() && body.username.trim() !== user.username) {
    const newUsername = body.username.trim().replace(/^@/, '');
    if (!VALID_USERNAME.test(newUsername)) {
      return sendJson(res, 400, { error: 'Username must be 2-24 characters: letters, numbers, dots, or underscores.' });
    }
    const existing = stmts.findUserByUsername.get(newUsername);
    if (existing && existing.id !== user.id) {
      return sendJson(res, 409, { error: 'That username is already taken.' });
    }
    stmts.updateUsername.run(newUsername, user.id);
    user = stmts.findUserById.get(user.id);
  }

  const bio = typeof body.bio === 'string' ? body.bio.slice(0, 140) : user.bio;
  const mood = ['happy', 'sad', 'indifferent'].includes(body.mood) ? body.mood : user.mood;
  const avatar = typeof body.avatar === 'string' ? body.avatar : user.avatar;
  const theme = typeof body.theme === 'string' ? body.theme : user.theme;
  const text_scale = Number.isFinite(body.text_scale) ? body.text_scale : user.text_scale;

  stmts.updateProfile.run(bio, mood, avatar, theme, text_scale, user.id);
  const updated = stmts.findUserById.get(user.id);
  return sendJson(res, 200, { user: publicUser(updated) });
}

async function handleSearch(req, res, user) {
  const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
  if (!q.trim()) return sendJson(res, 200, { results: [] });
  const rows = stmts.searchUsers.all(`%${q.trim()}%`, user.id);
  return sendJson(res, 200, { results: rows });
}

async function handleAddContact(req, res, user) {
  const body = await readJsonBody(req);
  const username = (body.username || '').trim().replace(/^@/, '');
  const target = stmts.findUserByUsername.get(username);
  if (!target) return sendJson(res, 404, { error: 'No user with that username.' });
  if (target.id === user.id) return sendJson(res, 400, { error: "You can't add yourself." });
  stmts.addContact.run(user.id, target.id);
  return sendJson(res, 201, { contact: publicUser(target) });
}

async function handleListContacts(req, res, user) {
  const rows = stmts.listContacts.all(user.id);
  const folders = stmts.myFolders.all(user.id).map(f => ({
    id: f.id,
    name: f.name,
    contact_ids: stmts.folderContactIds.all(f.id).map(r => r.contact_id),
  }));
  const results = rows.map(c => {
    const last = stmts.lastMessageBetween.get(user.id, c.id, c.id, user.id);
    return {
      id: c.id,
      username: c.username,
      bio: c.bio,
      mood: c.mood,
      avatar: c.avatar,
      last_message: last ? { text: last.text, from_me: last.sender_id === user.id, time: last.created_at } : null,
    };
  });
  // most recent conversation first; contacts with no messages yet sort last
  results.sort((a, b) => {
    const ta = a.last_message ? a.last_message.time : '';
    const tb = b.last_message ? b.last_message.time : '';
    return tb.localeCompare(ta);
  });
  return sendJson(res, 200, { contacts: results, folders });
}

async function handleConversation(req, res, user, otherUsername) {
  const target = stmts.findUserByUsername.get(otherUsername);
  if (!target) return sendJson(res, 404, { error: 'No user with that username.' });
  const rows = stmts.conversation.all(user.id, target.id, target.id, user.id);
  const messages = rows.map(m => ({
    id: m.id,
    from: m.sender_id === user.id ? 'me' : 'them',
    text: m.text,
    time: m.created_at,
  }));
  return sendJson(res, 200, { user: publicUser(target), messages });
}

async function handleSendMessage(req, res, user) {
  const body = await readJsonBody(req);
  const toUsername = (body.to || '').trim().replace(/^@/, '');
  const text = (body.text || '').trim();
  if (!text) return sendJson(res, 400, { error: 'Message text is required.' });
  const target = stmts.findUserByUsername.get(toUsername);
  if (!target) return sendJson(res, 404, { error: 'No user with that username.' });
  if (target.id === user.id) return sendJson(res, 400, { error: "You can't message yourself." });

  const info = stmts.insertMessage.run(user.id, target.id, text);
  // both sides can now see each other in their chat list going forward
  stmts.addContact.run(user.id, target.id);
  stmts.addContact.run(target.id, user.id);

  const created = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);

  pushToUser(target.id, {
    type: 'message',
    from_username: user.username,
    text,
    time: created.created_at,
  });

  return sendJson(res, 201, { message: { id: created.id, from: 'me', text, time: created.created_at } });
}

async function handleListFolders(req, res, user) {
  const folders = stmts.myFolders.all(user.id).map(f => ({
    id: f.id,
    name: f.name,
    contact_ids: stmts.folderContactIds.all(f.id).map(r => r.contact_id),
  }));
  return sendJson(res, 200, { folders });
}

async function handleCreateFolder(req, res, user) {
  const body = await readJsonBody(req);
  const name = (body.name || '').trim();
  const contactIds = Array.isArray(body.contact_ids) ? body.contact_ids : [];
  if (!name) return sendJson(res, 400, { error: 'Folder name is required.' });

  const info = stmts.insertFolder.run(user.id, name);
  for (const cid of contactIds) {
    stmts.insertFolderContact.run(info.lastInsertRowid, cid);
  }
  return sendJson(res, 201, { folder: { id: info.lastInsertRowid, name, contact_ids: contactIds } });
}

async function handleDeleteFolder(req, res, user, folderId) {
  const folder = stmts.findFolder.get(folderId, user.id);
  if (!folder) return sendJson(res, 404, { error: 'Folder not found.' });
  stmts.deleteFolderContacts.run(folderId);
  stmts.deleteFolder.run(folderId);
  return sendJson(res, 200, { ok: true });
}

function handleStream(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 2000\n\n');
  registerSSE(user.id, res);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (e) { /* ignore */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unregisterSSE(user.id, res);
  });
}

// ---------------------------------------------------------------------------
// Server + router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      return res.end();
    }

    // ---- public auth routes ----
    if (req.method === 'POST' && pathname === '/api/signup') return await handleSignup(req, res);
    if (req.method === 'POST' && pathname === '/api/signin') return await handleSignin(req, res);

    // ---- SSE stream (auth via ?token=) ----
    if (req.method === 'GET' && pathname === '/api/stream') {
      const user = getAuthedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      return handleStream(req, res, user);
    }

    // ---- everything else under /api requires a Bearer token ----
    if (pathname.startsWith('/api/')) {
      if (req.method === 'POST' && pathname === '/api/logout') return await handleLogout(req, res);

      const user = getAuthedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });

      if (req.method === 'GET' && pathname === '/api/me') return await handleMe(req, res, user);
      if (req.method === 'PUT' && pathname === '/api/me') return await handleUpdateMe(req, res, user);
      if (req.method === 'GET' && pathname === '/api/search') return await handleSearch(req, res, user);
      if (req.method === 'POST' && pathname === '/api/contacts') return await handleAddContact(req, res, user);
      if (req.method === 'GET' && pathname === '/api/contacts') return await handleListContacts(req, res, user);
      if (req.method === 'POST' && pathname === '/api/messages') return await handleSendMessage(req, res, user);

      let m = pathname.match(/^\/api\/messages\/([^/]+)$/);
      if (req.method === 'GET' && m) return await handleConversation(req, res, user, decodeURIComponent(m[1]));

      if (req.method === 'GET' && pathname === '/api/folders') return await handleListFolders(req, res, user);
      if (req.method === 'POST' && pathname === '/api/folders') return await handleCreateFolder(req, res, user);

      m = pathname.match(/^\/api\/folders\/(\d+)$/);
      if (req.method === 'DELETE' && m) return await handleDeleteFolder(req, res, user, Number(m[1]));

      return sendJson(res, 404, { error: 'Not found.' });
    }

    // ---- static frontend ----
    if (req.method === 'GET') {
      return serveIndex(res);
    }

    sendJson(res, 404, { error: 'Not found.' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error: ' + err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Upfront server running at http://localhost:${PORT}`);
  console.log(`Database file: ${DB_PATH}`);
});
