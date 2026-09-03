// Postgres data backend — used automatically when the DATABASE_URL
// environment variable is set (this is what Render provides when you
// attach a Postgres database to this web service).
//
// This is the real, persistent storage layer. Data here survives web
// service restarts and redeploys, because it lives in a separate managed
// database rather than on the web service's own (ephemeral, on the free
// tier) disk.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render's managed Postgres uses certificates that Node won't
  // recognize as a trusted CA by default; this is the standard, expected
  // way to connect to it (and to most managed Postgres providers).
  ssl: { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      mood TEXT NOT NULL DEFAULT 'happy',
      avatar TEXT,
      theme TEXT NOT NULL DEFAULT 'classic',
      text_scale INTEGER NOT NULL DEFAULT 100,
      is_ai_person BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS contacts (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, contact_id)
    );

    CREATE TABLE IF NOT EXISTS folders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS folder_contacts (
      folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (folder_id, contact_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id);
    CREATE INDEX IF NOT EXISTS idx_messages_pair2 ON messages(recipient_id, sender_id);

    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      image TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

    CREATE TABLE IF NOT EXISTS post_likes (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS post_comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id);
  `);
}

async function getUserByUsername(username) {
  const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createUser(username, passwordHash, salt) {
  const { rows } = await pool.query(
    `INSERT INTO users (username, password_hash, salt) VALUES ($1, $2, $3) RETURNING *`,
    [username, passwordHash, salt]
  );
  return rows[0];
}

async function createAiPerson(username, bio, mood, avatar) {
  const { rows } = await pool.query(
    `INSERT INTO users (username, password_hash, salt, bio, mood, avatar, is_ai_person)
     VALUES ($1, 'ai-person-no-login', 'ai-person-no-login', $2, $3, $4, true) RETURNING *`,
    [username, bio, mood, avatar]
  );
  return rows[0];
}

async function updateUsername(id, newUsername) {
  await pool.query('UPDATE users SET username = $1 WHERE id = $2', [newUsername, id]);
}

async function updateProfile(id, { bio, mood, avatar, theme, text_scale }) {
  const { rows } = await pool.query(
    `UPDATE users SET bio = $1, mood = $2, avatar = $3, theme = $4, text_scale = $5 WHERE id = $6 RETURNING *`,
    [bio, mood, avatar, theme, text_scale, id]
  );
  return rows[0];
}

async function createSession(token, userId) {
  await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
}

async function getSession(token) {
  const { rows } = await pool.query('SELECT * FROM sessions WHERE token = $1', [token]);
  return rows[0] || null;
}

async function deleteSession(token) {
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

async function searchUsers(query, excludeUserId) {
  const { rows } = await pool.query(
    `SELECT id, username, bio, mood, avatar, is_ai_person FROM users WHERE username ILIKE $1 AND id != $2 LIMIT 20`,
    [`%${query}%`, excludeUserId]
  );
  return rows;
}

async function addContact(userId, contactId) {
  await pool.query(
    `INSERT INTO contacts (user_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, contactId]
  );
}

async function listContacts(userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.bio, u.mood, u.avatar, u.is_ai_person
     FROM contacts c JOIN users u ON u.id = c.contact_id
     WHERE c.user_id = $1`,
    [userId]
  );
  return rows;
}

async function isContact(userId, contactId) {
  const { rows } = await pool.query('SELECT 1 FROM contacts WHERE user_id=$1 AND contact_id=$2', [userId, contactId]);
  return rows.length > 0;
}

async function getLastMessageBetween(a, b) {
  const { rows } = await pool.query(
    `SELECT text, sender_id, created_at FROM messages
     WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [a, b]
  );
  return rows[0] || null;
}

async function getConversation(a, b) {
  const { rows } = await pool.query(
    `SELECT id, sender_id, recipient_id, text, created_at FROM messages
     WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
     ORDER BY created_at ASC, id ASC`,
    [a, b]
  );
  return rows;
}

async function createMessage(senderId, recipientId, text) {
  const { rows } = await pool.query(
    `INSERT INTO messages (sender_id, recipient_id, text) VALUES ($1, $2, $3) RETURNING *`,
    [senderId, recipientId, text]
  );
  return rows[0];
}

async function listFolders(userId) {
  const { rows } = await pool.query('SELECT id, name FROM folders WHERE user_id = $1 ORDER BY created_at ASC', [userId]);
  return rows;
}

async function getFolderContactIds(folderId) {
  const { rows } = await pool.query('SELECT contact_id FROM folder_contacts WHERE folder_id = $1', [folderId]);
  return rows.map(r => r.contact_id);
}

async function createFolder(userId, name) {
  const { rows } = await pool.query(
    `INSERT INTO folders (user_id, name) VALUES ($1, $2) RETURNING id, name`,
    [userId, name]
  );
  return rows[0];
}

async function addFolderContact(folderId, contactId) {
  await pool.query(
    `INSERT INTO folder_contacts (folder_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [folderId, contactId]
  );
}

async function getFolder(id, userId) {
  const { rows } = await pool.query('SELECT * FROM folders WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows[0] || null;
}

async function deleteFolderContacts(folderId) {
  await pool.query('DELETE FROM folder_contacts WHERE folder_id = $1', [folderId]);
}

async function deleteFolder(folderId) {
  await pool.query('DELETE FROM folders WHERE id = $1', [folderId]);
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------
async function createPost(userId, image, caption) {
  const { rows } = await pool.query(
    `INSERT INTO posts (user_id, image, caption) VALUES ($1, $2, $3) RETURNING *`,
    [userId, image, caption || '']
  );
  return rows[0];
}

async function getPost(id) {
  const { rows } = await pool.query('SELECT * FROM posts WHERE id = $1', [id]);
  return rows[0] || null;
}

async function deletePost(id) {
  await pool.query('DELETE FROM posts WHERE id = $1', [id]);
}

async function likeCount(postId) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM post_likes WHERE post_id = $1', [postId]);
  return rows[0].n;
}

async function hasLiked(postId, userId) {
  const { rows } = await pool.query('SELECT 1 FROM post_likes WHERE post_id=$1 AND user_id=$2', [postId, userId]);
  return rows.length > 0;
}

async function likePost(postId, userId) {
  await pool.query('INSERT INTO post_likes (post_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [postId, userId]);
}

async function unlikePost(postId, userId) {
  await pool.query('DELETE FROM post_likes WHERE post_id=$1 AND user_id=$2', [postId, userId]);
}

async function commentCount(postId) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM post_comments WHERE post_id = $1', [postId]);
  return rows[0].n;
}

async function addComment(postId, userId, text) {
  const { rows } = await pool.query(
    `INSERT INTO post_comments (post_id, user_id, text) VALUES ($1,$2,$3) RETURNING *`,
    [postId, userId, text]
  );
  return rows[0];
}

async function listComments(postId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.post_id, c.user_id, c.text, c.created_at, u.username, u.avatar
     FROM post_comments c JOIN users u ON u.id = c.user_id
     WHERE c.post_id = $1 ORDER BY c.created_at ASC, c.id ASC`,
    [postId]
  );
  return rows;
}

async function listPosts(viewerId, filter) {
  let where = '';
  const params = [viewerId];
  if (filter === 'contacts') {
    where = `WHERE p.user_id = $1 OR p.user_id IN (SELECT contact_id FROM contacts WHERE user_id = $1)`;
  }
  const orderBy = filter === 'liked'
    ? 'ORDER BY like_count DESC, p.created_at DESC'
    : 'ORDER BY p.created_at DESC';

  const { rows } = await pool.query(
    `SELECT p.id, p.image, p.caption, p.created_at,
            u.id AS author_id, u.username AS author_username, u.avatar AS author_avatar,
            u.mood AS author_mood, u.is_ai_person AS author_is_ai_person,
            (SELECT COUNT(*)::int FROM post_likes pl WHERE pl.post_id = p.id) AS like_count,
            EXISTS(SELECT 1 FROM post_likes pl2 WHERE pl2.post_id = p.id AND pl2.user_id = $1) AS liked_by_me,
            (SELECT COUNT(*)::int FROM post_comments pc WHERE pc.post_id = p.id) AS comment_count
     FROM posts p JOIN users u ON u.id = p.user_id
     ${where}
     ${orderBy}`,
    params
  );

  return rows.map(r => ({
    id: r.id,
    image: r.image,
    caption: r.caption,
    created_at: r.created_at,
    author: { id: r.author_id, username: r.author_username, avatar: r.author_avatar, mood: r.author_mood, is_ai_person: r.author_is_ai_person },
    like_count: r.like_count,
    liked_by_me: r.liked_by_me,
    comment_count: r.comment_count,
  }));
}

module.exports = {
  init,
  getUserByUsername, getUserById, createUser, createAiPerson, updateUsername, updateProfile,
  createSession, getSession, deleteSession,
  searchUsers, addContact, listContacts, isContact,
  getLastMessageBetween, getConversation, createMessage,
  listFolders, getFolderContactIds, createFolder, addFolderContact,
  getFolder, deleteFolderContacts, deleteFolder,
  createPost, getPost, deletePost, likePost, unlikePost, hasLiked, likeCount,
  addComment, listComments, commentCount, listPosts,
};
