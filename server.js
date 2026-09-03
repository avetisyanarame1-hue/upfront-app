// Upfront — real backend server
// Persistence is pluggable: set DATABASE_URL to a Postgres connection
// string for real, durable storage (see db-postgres.js). Without it, the
// server runs against an in-memory store (db-memory.js) automatically —
// handy for local testing, but data resets when the process restarts.
//
// Optional: set ANTHROPIC_API_KEY to enable real Claude-powered replies
// for the built-in assistant and the AI-generated people. Without it,
// both fall back to a broad local rule-based / canned-reply system so
// the app stays fully functional either way.

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const usingPostgres = !!process.env.DATABASE_URL;
const db = usingPostgres ? require('./db-postgres') : require('./db-memory');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = 'claude-sonnet-5';

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
function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

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
    is_ai_person: !!u.is_ai_person,
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
    let rejected = false;
    const MAX_BYTES = 8_000_000; // ~8MB — enough for a typical phone photo as base64
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BYTES) {
        rejected = true;
        req.removeAllListeners('data');
        req.resume();
        reject(new Error('That file is too large. Please choose a smaller image (under ~6MB).'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (rejected) return;
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

async function getAuthedUser(req) {
  const token = getBearerToken(req) || new URL(req.url, 'http://x').searchParams.get('token');
  if (!token) return null;
  const session = await db.getSession(token);
  if (!session) return null;
  return await db.getUserById(session.user_id);
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
// Claude API (optional — only used if ANTHROPIC_API_KEY is set)
// ---------------------------------------------------------------------------
async function callClaude(systemPrompt, messages, maxTokens) {
  if (!ANTHROPIC_API_KEY) throw new Error('No ANTHROPIC_API_KEY configured.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens || 300,
      system: systemPrompt,
      messages,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.content || []).map(b => (b.type === 'text' ? b.text : '')).join('\n').trim();
}

// ---------------------------------------------------------------------------
// Built-in assistant — full app knowledge, with a local fallback so it
// always works even without an API key
// ---------------------------------------------------------------------------
const ASSISTANT_SYSTEM_PROMPT = `You are the built-in assistant inside "Upfront", a messenger app. Answer questions about the app clearly, warmly, and helpfully — like a knowledgeable, friendly guide, not a rigid script. Here is everything about the app:

- ABOUT THE COMPANY: Upfront was made in 2026 by Arame Avetisyan, who is the founder and CEO.
- WHO IT'S FOR: Upfront welcomes everyone, regardless of race or background — it doesn't matter who you are.
- WHAT MAKES IT SPECIAL: Upfront is fully customizable — you don't adjust for Upfront, Upfront adjusts for you (themes, text size, folders, etc.).
- MOOD instead of online status: every contact shows a mood dot instead of a plain "online" indicator — Happy (orange), Sad (blue), or Indifferent (grey). Set on the Profile page.
- CALLS: tap the phone icon on a contact's row or inside an open chat. Shows "Waiting…" with a ringtone, then "Connected" with a live timer once picked up. It's a simulated call, not real audio.
- SEARCH & ADD FRIENDS: the round search icon on the chat list expands into a field to look up people by username. New people show under "People on Upfront" with a + to add and start chatting.
- PROFILE: edit your photo, username (unique, required), bio, and mood from the Profile tab.
- SETTINGS: pick a chat color theme, create folders to organize chats, adjust text size, log out.
- VIEWING OTHER PROFILES: you can tap into any contact's profile to see their photo, mood, and bio up close.
- POSTS: a separate section (not chats) where users post one photo each, with an optional caption. Others can like and comment. There are filters to browse all posts, only from your contacts, or most liked. AI-generated people cannot post — only real human users can.
- AI-GENERATED PEOPLE: users can generate fictional AI "people" with a random name, random gender, a random generated bio and avatar, who chat like real people over text. They are clearly marked as AI so nobody is misled into thinking they're a real human.
- SIGN UP / SIGN IN / LOG OUT: sign up picks your real username; log out is in Settings.
- NAV RAIL (left edge): Chats, Profile, Settings, Posts, plus your own avatar.

If asked about something truly outside the app, gently steer back to what you can help with. Keep answers concise — a few sentences, not an essay — unless the person clearly wants more detail.`;

function localAssistantAnswer(text) {
  const t = text.toLowerCase();
  if (/found(ed|er)|who (made|started|created|built|owns)|\bceo\b/.test(t)) {
    return "Upfront was made in 2026 by Arame Avetisyan, who is the founder and CEO.";
  }
  if (/welcome|inclusiv|divers|everyone|anyone|race|background/.test(t)) {
    return "Upfront welcomes everyone, regardless of race or background — it doesn't matter who you are.";
  }
  if (/customiz|special|advantage|best (thing|part)|unique|why (should i|use)/.test(t)) {
    return "Upfront's biggest advantage is that it's fully customizable — you don't adjust for Upfront, Upfront adjusts for you.";
  }
  if (/\bcall\b|\bphone\b|\bring\b|\bdial\b/.test(t)) {
    return 'Tap the phone icon on a contact\'s row, or inside an open chat, to start a call. It rings, then connects with a live timer — it\'s simulated, not a real audio call.';
  }
  if (/\bmood\b|online status|presence|happy|indifferent|\bsad\b/.test(t)) {
    return 'Every contact shows a mood instead of a plain online dot — Happy, Sad, or Indifferent. Set yours on your Profile page.';
  }
  if (/\bfolder/.test(t)) {
    return 'In Settings you can create a folder, choose which chats belong to it, and it shows up as a filter tab above your chat list.';
  }
  if (/\btheme\b|\bcolor\b|\bcolour\b/.test(t)) {
    return 'Settings has a chat theme picker with several color options — pick one and the app re-tints instantly.';
  }
  if (/text size|font size|resize.*text/.test(t)) {
    return 'Settings has a text size slider that live-resizes text throughout the app.';
  }
  if (/search|find (a )?friend|add (a )?friend|username/.test(t)) {
    return 'Tap the search icon at the top of your chat list to look up people by username, and add anyone new right from the results.';
  }
  if (/\bprofile\b|\bbio\b|profile picture|change (my )?photo/.test(t)) {
    return 'Tap the Profile tab (or your own avatar) to edit your photo, username, bio, and mood. You can also tap into anyone else\'s profile to see their photo, mood, and bio up close.';
  }
  if (/\bpost/.test(t)) {
    return 'Posts are a separate section — one photo per post, with an optional caption. Others can like and comment, and you can filter between all posts, just your contacts, or most liked. AI people can\'t post — only real users can.';
  }
  if (/ai people|ai person|generate.*(person|people|friend)|bot/.test(t)) {
    return 'You can generate AI-powered people to chat with — random name, gender, bio, and avatar each time. They\'re clearly marked as AI and chat casually like real people, but they can\'t make posts.';
  }
  if (/log ?out|sign ?out/.test(t)) {
    return 'You can log out from the Account section at the bottom of Settings.';
  }
  if (/sign ?up|sign ?in|log ?in|create an account/.test(t)) {
    return 'The first screen is Sign In / Sign Up. Signing up asks you to pick your own real username.';
  }
  return "I can help with pretty much anything about Upfront — calls, moods, folders, themes, posts, AI people, your profile, or the app itself. What would you like to know?";
}

async function handleAssistant(req, res, user) {
  const body = await readJsonBody(req);
  const message = (body.message || '').trim();
  const history = Array.isArray(body.history) ? body.history : [];
  if (!message) return sendJson(res, 400, { error: 'Message is required.' });

  const apiMessages = history
    .filter(m => m && typeof m.text === 'string' && m.text.trim())
    .slice(-12)
    .map(m => ({ role: m.from === 'me' ? 'user' : 'assistant', content: m.text }))
    .concat([{ role: 'user', content: message }]);

  try {
    const reply = await callClaude(ASSISTANT_SYSTEM_PROMPT, apiMessages, 400);
    return sendJson(res, 200, { reply: reply || localAssistantAnswer(message), source: 'llm' });
  } catch (err) {
    return sendJson(res, 200, { reply: localAssistantAnswer(message), source: 'local' });
  }
}

// ---------------------------------------------------------------------------
// AI-generated people
// ---------------------------------------------------------------------------
const FIRST_NAMES = {
  female: ['Maya', 'Elena', 'Sofia', 'Zara', 'Amara', 'Priya', 'Lina', 'Noor', 'Ivy', 'Sana', 'Talia', 'Rosa'],
  male: ['Kai', 'Diego', 'Omar', 'Leo', 'Theo', 'Amir', 'Ravi', 'Milo', 'Nico', 'Jonas', 'Idris', 'Felix'],
  neutral: ['River', 'Sky', 'Rowan', 'Ari', 'Quinn', 'Sage', 'Remy', 'Eden', 'Kris', 'Noel', 'Robin', 'Casey'],
};
const LAST_INITIALS = ['A.', 'B.', 'K.', 'L.', 'M.', 'R.', 'S.', 'T.', 'V.', 'Z.'];
const CANNED_BIOS = [
  'Coffee first, questions later.',
  "Collects vinyl records nobody's heard of.",
  'Always down for a spontaneous road trip.',
  'Currently obsessed with true crime podcasts.',
  'Believes pineapple belongs on pizza.',
  'Plant parent to way too many succulents.',
  'Weekend hiker, weekday overthinker.',
  "Still hasn't finished that one book from last year.",
  'Making questionable decisions since forever.',
  'Professional napper, amateur chef.',
  'Into astrology but only when it\'s flattering.',
  "Trying to learn guitar. It's not going well.",
];
const GENERIC_HUMANLIKE_REPLIES = [
  'haha yeah totally',
  'omg same',
  'lol wait really?',
  "that's actually so real",
  'ngl I felt that',
  'wait tell me more',
  'honestly mood',
  "I'm just vibing tbh, you?",
];

function genAvatarServer(seed) {
  function hashSeed(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
    return h;
  }
  const h = hashSeed(seed);
  const hue1 = h % 360;
  const hue2 = (hue1 + 35 + ((h >> 3) % 70)) % 360;
  const hue3 = (hue1 + 190 + ((h >> 5) % 40)) % 360;
  const c1 = `hsl(${hue1} 72% 60%)`;
  const c2 = `hsl(${hue2} 78% 48%)`;
  const c3 = `hsl(${hue3} 65% 70%)`;
  const cx1 = 18 + (h % 22), cy1 = 12 + ((h >> 2) % 22);
  const cx2 = 55 + ((h >> 4) % 22), cy2 = 50 + ((h >> 6) % 24);
  const cx3 = 35 + ((h >> 8) % 20), cy3 = 65 + ((h >> 10) % 15);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 80'>`
    + `<defs><clipPath id='c'><rect width='80' height='80' rx='40'/></clipPath></defs>`
    + `<g clip-path='url(#c)'>`
    + `<rect width='80' height='80' fill='${c1}'/>`
    + `<circle cx='${cx1}' cy='${cy1}' r='30' fill='${c2}' opacity='0.85'/>`
    + `<circle cx='${cx2}' cy='${cy2}' r='26' fill='${c3}' opacity='0.7'/>`
    + `<circle cx='${cx3}' cy='${cy3}' r='20' fill='${c1}' opacity='0.5'/>`
    + `</g></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

async function generateAiPersonBio(name) {
  try {
    const text = await callClaude(
      'Reply with ONLY a short, casual one-line bio (under 90 characters) for a fictional person — human, specific, a hobby or quirk, not generic. No quotes, no preamble.',
      [{ role: 'user', content: `Name: ${name}` }],
      60
    );
    const cleaned = text.replace(/^"|"$/g, '').trim();
    return cleaned ? cleaned.slice(0, 140) : randomFrom(CANNED_BIOS);
  } catch (err) {
    return randomFrom(CANNED_BIOS);
  }
}

function personaSystemPrompt(aiUser) {
  return `You are ${aiUser.username}, a fictional AI-generated character on the Upfront messenger app. Your bio: "${aiUser.bio}". Your current mood: ${aiUser.mood}. Chat casually and briefly (1-3 short sentences) like a real person texting a friend, matching your bio and mood. If someone directly and sincerely asks whether you're an AI or a bot, be honest and say yes — you're one of Upfront's AI-generated people. Otherwise just chat naturally in character.`;
}

async function triggerAiPersonReply(aiUser, toUser) {
  try {
    const history = await db.getConversation(toUser.id, aiUser.id);
    const apiMessages = history.slice(-12).map(m => ({
      role: m.sender_id === aiUser.id ? 'assistant' : 'user',
      content: m.text,
    }));
    let replyText;
    try {
      replyText = await callClaude(personaSystemPrompt(aiUser), apiMessages, 150);
      if (!replyText) throw new Error('empty reply');
    } catch (err) {
      replyText = randomFrom(GENERIC_HUMANLIKE_REPLIES);
    }
    await new Promise(r => setTimeout(r, 900 + Math.random() * 1400)); // feel natural, not instant
    const created = await db.createMessage(aiUser.id, toUser.id, replyText);
    pushToUser(toUser.id, { type: 'message', from_username: aiUser.username, text: replyText, time: created.created_at });
  } catch (err) {
    console.error('AI person reply failed:', err);
  }
}

async function handleGenerateAiPerson(req, res, user) {
  const gender = randomFrom(['female', 'male', 'neutral']);
  const first = randomFrom(FIRST_NAMES[gender]);
  const last = randomFrom(LAST_INITIALS);
  const name = `${first} ${last}`;
  const mood = randomFrom(['happy', 'sad', 'indifferent']);
  const seed = `${first}${last}${Date.now()}${Math.random()}`;
  const avatar = genAvatarServer(seed);
  const bio = await generateAiPersonBio(name);

  let base = (first + last.replace('.', '')).toLowerCase().replace(/[^a-z0-9]/g, '');
  let username = base;
  let n = 1;
  while (await db.getUserByUsername(username)) {
    username = base + (n++);
  }

  const aiUser = await db.createAiPerson(username, bio, mood, avatar);
  await db.addContact(user.id, aiUser.id);

  return sendJson(res, 201, { person: publicUser(aiUser) });
}

// ---------------------------------------------------------------------------
// Static file serving (the whole frontend is one HTML file)
// ---------------------------------------------------------------------------
function serveIndex(res) {
  const candidates = [
    path.join(__dirname, 'index.html'),
    path.join(PUBLIC_DIR, 'index.html'),
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
// Route handlers — auth, profile, contacts, messages, folders
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
  if (await db.getUserByUsername(username)) {
    return sendJson(res, 409, { error: 'That username is already taken.' });
  }

  const salt = makeSalt();
  const hash = hashPassword(password, salt);
  const user = await db.createUser(username, hash, salt);

  const token = makeToken();
  await db.createSession(token, user.id);
  return sendJson(res, 201, { token, user: publicUser(user) });
}

async function handleSignin(req, res) {
  const body = await readJsonBody(req);
  const username = (body.username || '').trim().replace(/^@/, '');
  const password = body.password || '';

  const user = await db.getUserByUsername(username);
  if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
    return sendJson(res, 401, { error: 'Incorrect username or password.' });
  }
  const token = makeToken();
  await db.createSession(token, user.id);
  return sendJson(res, 200, { token, user: publicUser(user) });
}

async function handleLogout(req, res) {
  const token = getBearerToken(req);
  if (token) await db.deleteSession(token);
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
    const existing = await db.getUserByUsername(newUsername);
    if (existing && existing.id !== user.id) {
      return sendJson(res, 409, { error: 'That username is already taken.' });
    }
    await db.updateUsername(user.id, newUsername);
    user = await db.getUserById(user.id);
  }

  const bio = typeof body.bio === 'string' ? body.bio.slice(0, 140) : user.bio;
  const mood = ['happy', 'sad', 'indifferent'].includes(body.mood) ? body.mood : user.mood;
  const avatar = typeof body.avatar === 'string' ? body.avatar : user.avatar;
  const theme = typeof body.theme === 'string' ? body.theme : user.theme;
  const text_scale = Number.isFinite(body.text_scale) ? body.text_scale : user.text_scale;

  const updated = await db.updateProfile(user.id, { bio, mood, avatar, theme, text_scale });
  return sendJson(res, 200, { user: publicUser(updated) });
}

async function handleGetProfile(req, res, viewer, username) {
  const target = await db.getUserByUsername(username);
  if (!target) return sendJson(res, 404, { error: 'No user with that username.' });
  return sendJson(res, 200, { profile: publicUser(target) });
}

async function handleSearch(req, res, user) {
  const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
  if (!q.trim()) return sendJson(res, 200, { results: [] });
  const rows = await db.searchUsers(q.trim(), user.id);
  return sendJson(res, 200, { results: rows });
}

async function handleAddContact(req, res, user) {
  const body = await readJsonBody(req);
  const username = (body.username || '').trim().replace(/^@/, '');
  const target = await db.getUserByUsername(username);
  if (!target) return sendJson(res, 404, { error: 'No user with that username.' });
  if (target.id === user.id) return sendJson(res, 400, { error: "You can't add yourself." });
  await db.addContact(user.id, target.id);
  return sendJson(res, 201, { contact: publicUser(target) });
}

async function handleListContacts(req, res, user) {
  const rows = await db.listContacts(user.id);
  const folderRows = await db.listFolders(user.id);
  const folders = [];
  for (const f of folderRows) {
    const contact_ids = await db.getFolderContactIds(f.id);
    folders.push({ id: f.id, name: f.name, contact_ids });
  }

  const results = [];
  for (const c of rows) {
    const last = await db.getLastMessageBetween(user.id, c.id);
    results.push({
      id: c.id,
      username: c.username,
      bio: c.bio,
      mood: c.mood,
      avatar: c.avatar,
      is_ai_person: !!c.is_ai_person,
      last_message: last ? { text: last.text, from_me: last.sender_id === user.id, time: last.created_at } : null,
    });
  }
  results.sort((a, b) => {
    const ta = a.last_message ? String(a.last_message.time) : '';
    const tb = b.last_message ? String(b.last_message.time) : '';
    return tb.localeCompare(ta);
  });
  return sendJson(res, 200, { contacts: results, folders });
}

async function handleConversation(req, res, user, otherUsername) {
  const target = await db.getUserByUsername(otherUsername);
  if (!target) return sendJson(res, 404, { error: 'No user with that username.' });
  const rows = await db.getConversation(user.id, target.id);
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
  const target = await db.getUserByUsername(toUsername);
  if (!target) return sendJson(res, 404, { error: 'No user with that username.' });
  if (target.id === user.id) return sendJson(res, 400, { error: "You can't message yourself." });

  const created = await db.createMessage(user.id, target.id, text);
  await db.addContact(user.id, target.id);
  await db.addContact(target.id, user.id);

  if (target.is_ai_person) {
    triggerAiPersonReply(target, user); // fire-and-forget
  } else {
    pushToUser(target.id, {
      type: 'message',
      from_username: user.username,
      text,
      time: created.created_at,
    });
  }

  return sendJson(res, 201, { message: { id: created.id, from: 'me', text, time: created.created_at } });
}

async function handleListFolders(req, res, user) {
  const folderRows = await db.listFolders(user.id);
  const folders = [];
  for (const f of folderRows) {
    const contact_ids = await db.getFolderContactIds(f.id);
    folders.push({ id: f.id, name: f.name, contact_ids });
  }
  return sendJson(res, 200, { folders });
}

async function handleCreateFolder(req, res, user) {
  const body = await readJsonBody(req);
  const name = (body.name || '').trim();
  const contactIds = Array.isArray(body.contact_ids) ? body.contact_ids : [];
  if (!name) return sendJson(res, 400, { error: 'Folder name is required.' });

  const folder = await db.createFolder(user.id, name);
  for (const cid of contactIds) {
    await db.addFolderContact(folder.id, cid);
  }
  return sendJson(res, 201, { folder: { id: folder.id, name: folder.name, contact_ids: contactIds } });
}

async function handleDeleteFolder(req, res, user, folderId) {
  const folder = await db.getFolder(folderId, user.id);
  if (!folder) return sendJson(res, 404, { error: 'Folder not found.' });
  await db.deleteFolderContacts(folderId);
  await db.deleteFolder(folderId);
  return sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Route handlers — posts, likes, comments
// ---------------------------------------------------------------------------
async function handleCreatePost(req, res, user) {
  if (user.is_ai_person) return sendJson(res, 403, { error: 'AI people cannot create posts.' });
  const body = await readJsonBody(req);
  const image = body.image;
  const caption = typeof body.caption === 'string' ? body.caption.slice(0, 280) : '';
  if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
    return sendJson(res, 400, { error: 'A photo is required.' });
  }
  const post = await db.createPost(user.id, image, caption);
  return sendJson(res, 201, {
    post: {
      id: post.id, image: post.image, caption: post.caption, created_at: post.created_at,
      author: publicUser(user), like_count: 0, liked_by_me: false, comment_count: 0,
    },
  });
}

async function handleListPosts(req, res, user) {
  const filterParam = new URL(req.url, 'http://x').searchParams.get('filter') || 'all';
  const filter = ['all', 'contacts', 'liked'].includes(filterParam) ? filterParam : 'all';
  const posts = await db.listPosts(user.id, filter);
  return sendJson(res, 200, { posts });
}

async function handleDeletePost(req, res, user, postId) {
  const post = await db.getPost(postId);
  if (!post) return sendJson(res, 404, { error: 'Post not found.' });
  if (post.user_id !== user.id) return sendJson(res, 403, { error: 'You can only delete your own posts.' });
  await db.deletePost(postId);
  return sendJson(res, 200, { ok: true });
}

async function handleLikePost(req, res, user, postId) {
  const post = await db.getPost(postId);
  if (!post) return sendJson(res, 404, { error: 'Post not found.' });
  await db.likePost(postId, user.id);
  return sendJson(res, 200, { ok: true, like_count: await db.likeCount(postId) });
}

async function handleUnlikePost(req, res, user, postId) {
  const post = await db.getPost(postId);
  if (!post) return sendJson(res, 404, { error: 'Post not found.' });
  await db.unlikePost(postId, user.id);
  return sendJson(res, 200, { ok: true, like_count: await db.likeCount(postId) });
}

async function handleAddComment(req, res, user, postId) {
  const post = await db.getPost(postId);
  if (!post) return sendJson(res, 404, { error: 'Post not found.' });
  const body = await readJsonBody(req);
  const text = (body.text || '').trim().slice(0, 300);
  if (!text) return sendJson(res, 400, { error: 'Comment text is required.' });
  const comment = await db.addComment(postId, user.id, text);
  return sendJson(res, 201, {
    comment: { id: comment.id, text: comment.text, created_at: comment.created_at, author: publicUser(user) },
  });
}

async function handleListComments(req, res, user, postId) {
  const post = await db.getPost(postId);
  if (!post) return sendJson(res, 404, { error: 'Post not found.' });
  const rows = await db.listComments(postId);
  const comments = rows.map(c => ({
    id: c.id,
    text: c.text,
    created_at: c.created_at,
    author: { username: c.username, avatar: c.avatar },
  }));
  return sendJson(res, 200, { comments });
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

    if (req.method === 'POST' && pathname === '/api/signup') return await handleSignup(req, res);
    if (req.method === 'POST' && pathname === '/api/signin') return await handleSignin(req, res);

    if (req.method === 'GET' && pathname === '/api/stream') {
      const user = await getAuthedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });
      return handleStream(req, res, user);
    }

    if (pathname.startsWith('/api/')) {
      if (req.method === 'POST' && pathname === '/api/logout') return await handleLogout(req, res);

      const user = await getAuthedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Not signed in.' });

      if (req.method === 'GET' && pathname === '/api/me') return await handleMe(req, res, user);
      if (req.method === 'PUT' && pathname === '/api/me') return await handleUpdateMe(req, res, user);
      if (req.method === 'GET' && pathname === '/api/search') return await handleSearch(req, res, user);
      if (req.method === 'POST' && pathname === '/api/contacts') return await handleAddContact(req, res, user);
      if (req.method === 'GET' && pathname === '/api/contacts') return await handleListContacts(req, res, user);
      if (req.method === 'POST' && pathname === '/api/messages') return await handleSendMessage(req, res, user);
      if (req.method === 'POST' && pathname === '/api/assistant') return await handleAssistant(req, res, user);
      if (req.method === 'POST' && pathname === '/api/ai-people/generate') return await handleGenerateAiPerson(req, res, user);

      let m = pathname.match(/^\/api\/messages\/([^/]+)$/);
      if (req.method === 'GET' && m) return await handleConversation(req, res, user, decodeURIComponent(m[1]));

      m = pathname.match(/^\/api\/profile\/([^/]+)$/);
      if (req.method === 'GET' && m) return await handleGetProfile(req, res, user, decodeURIComponent(m[1]));

      if (req.method === 'GET' && pathname === '/api/folders') return await handleListFolders(req, res, user);
      if (req.method === 'POST' && pathname === '/api/folders') return await handleCreateFolder(req, res, user);

      m = pathname.match(/^\/api\/folders\/(\d+)$/);
      if (req.method === 'DELETE' && m) return await handleDeleteFolder(req, res, user, Number(m[1]));

      if (req.method === 'GET' && pathname === '/api/posts') return await handleListPosts(req, res, user);
      if (req.method === 'POST' && pathname === '/api/posts') return await handleCreatePost(req, res, user);

      m = pathname.match(/^\/api\/posts\/(\d+)$/);
      if (req.method === 'DELETE' && m) return await handleDeletePost(req, res, user, Number(m[1]));

      m = pathname.match(/^\/api\/posts\/(\d+)\/like$/);
      if (m && req.method === 'POST') return await handleLikePost(req, res, user, Number(m[1]));
      if (m && req.method === 'DELETE') return await handleUnlikePost(req, res, user, Number(m[1]));

      m = pathname.match(/^\/api\/posts\/(\d+)\/comments$/);
      if (m && req.method === 'GET') return await handleListComments(req, res, user, Number(m[1]));
      if (m && req.method === 'POST') return await handleAddComment(req, res, user, Number(m[1]));

      return sendJson(res, 404, { error: 'Not found.' });
    }

    if (req.method === 'GET') {
      return serveIndex(res);
    }

    sendJson(res, 404, { error: 'Not found.' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      const isTooLarge = /too large/i.test(err.message);
      sendJson(res, isTooLarge ? 413 : 500, { error: err.message });
    }
  }
});

(async () => {
  try {
    await db.init();
  } catch (err) {
    console.error('\nCould not set up the database:', err.message);
    if (usingPostgres) {
      console.error(
        'Double-check that DATABASE_URL is set correctly to a valid Postgres\n' +
        'connection string in your hosting platform\'s environment variables.\n'
      );
    }
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`Upfront server running at http://localhost:${PORT}`);
    console.log(usingPostgres
      ? 'Using Postgres for storage (DATABASE_URL is set) — data will persist across restarts.'
      : 'No DATABASE_URL set — using in-memory storage. Data will NOT persist across restarts.');
    console.log(ANTHROPIC_API_KEY
      ? 'ANTHROPIC_API_KEY is set — the assistant and AI people will use real Claude replies.'
      : 'No ANTHROPIC_API_KEY set — the assistant and AI people will use local fallback replies.');
  });
})();
