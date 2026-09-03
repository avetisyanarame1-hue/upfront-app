// In-memory data backend — used automatically when DATABASE_URL isn't set.
//
// This exists for two reasons:
//   1. It lets you run the app locally with zero setup (no database to
//      install or configure) to try things out or debug.
//   2. It shares the exact same function interface as db-postgres.js, so
//      the entire rest of the server (routing, auth, business logic) can
//      be tested against this backend and behaves identically either way.
//
// Data here is NOT persistent — it's wiped every time the process
// restarts. For real, durable storage, set the DATABASE_URL environment
// variable to a Postgres connection string; see db-postgres.js.

let nextUserId = 1;
let nextFolderId = 1;
let nextMessageId = 1;
let nextPostId = 1;
let nextCommentId = 1;

const users = [];
const sessions = new Map();      // token -> {token, user_id, created_at}
const contactPairs = new Set();  // "userId:contactId"
const folders = [];              // {id, user_id, name, created_at}
const folderContactPairs = new Set(); // "folderId:contactId"
const messages = [];             // {id, sender_id, recipient_id, text, created_at}
const posts = [];                // {id, user_id, image, caption, created_at}
const postLikePairs = new Set(); // "postId:userId"
const comments = [];             // {id, post_id, user_id, text, created_at}

function nowIso() {
  return new Date().toISOString();
}

async function init() {
  // nothing to set up for an in-memory store
}

async function getUserByUsername(username) {
  const lower = username.toLowerCase();
  return users.find(u => u.username.toLowerCase() === lower) || null;
}

async function getUserById(id) {
  return users.find(u => u.id === id) || null;
}

async function createUser(username, passwordHash, salt) {
  const user = {
    id: nextUserId++,
    username,
    password_hash: passwordHash,
    salt,
    bio: '',
    mood: 'happy',
    avatar: null,
    theme: 'classic',
    text_scale: 100,
    is_ai_person: false,
    created_at: nowIso(),
  };
  users.push(user);
  return user;
}

async function createAiPerson(username, bio, mood, avatar) {
  const user = {
    id: nextUserId++,
    username,
    password_hash: 'ai-person-no-login',
    salt: 'ai-person-no-login',
    bio,
    mood,
    avatar,
    theme: 'classic',
    text_scale: 100,
    is_ai_person: true,
    created_at: nowIso(),
  };
  users.push(user);
  return user;
}

async function updateUsername(id, newUsername) {
  const user = await getUserById(id);
  if (user) user.username = newUsername;
}

async function updateProfile(id, { bio, mood, avatar, theme, text_scale }) {
  const user = await getUserById(id);
  if (!user) return null;
  user.bio = bio;
  user.mood = mood;
  user.avatar = avatar;
  user.theme = theme;
  user.text_scale = text_scale;
  return user;
}

async function createSession(token, userId) {
  sessions.set(token, { token, user_id: userId, created_at: nowIso() });
}

async function getSession(token) {
  return sessions.get(token) || null;
}

async function deleteSession(token) {
  sessions.delete(token);
}

async function searchUsers(query, excludeUserId) {
  const q = query.toLowerCase();
  return users
    .filter(u => u.id !== excludeUserId && u.username.toLowerCase().includes(q))
    .slice(0, 20)
    .map(u => ({ id: u.id, username: u.username, bio: u.bio, mood: u.mood, avatar: u.avatar, is_ai_person: u.is_ai_person }));
}

async function addContact(userId, contactId) {
  contactPairs.add(`${userId}:${contactId}`);
}

async function listContacts(userId) {
  const result = [];
  for (const key of contactPairs) {
    const [uid, cid] = key.split(':').map(Number);
    if (uid === userId) {
      const u = await getUserById(cid);
      if (u) result.push({ id: u.id, username: u.username, bio: u.bio, mood: u.mood, avatar: u.avatar, is_ai_person: u.is_ai_person });
    }
  }
  return result;
}

async function isContact(userId, contactId) {
  return contactPairs.has(`${userId}:${contactId}`);
}

async function getLastMessageBetween(a, b) {
  const between = messages.filter(
    m => (m.sender_id === a && m.recipient_id === b) || (m.sender_id === b && m.recipient_id === a)
  );
  if (between.length === 0) return null;
  between.sort((x, y) => y.created_at.localeCompare(x.created_at) || y.id - x.id);
  return between[0];
}

async function getConversation(a, b) {
  return messages
    .filter(m => (m.sender_id === a && m.recipient_id === b) || (m.sender_id === b && m.recipient_id === a))
    .sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id - y.id);
}

async function createMessage(senderId, recipientId, text) {
  const msg = { id: nextMessageId++, sender_id: senderId, recipient_id: recipientId, text, created_at: nowIso() };
  messages.push(msg);
  return msg;
}

async function listFolders(userId) {
  return folders.filter(f => f.user_id === userId).map(f => ({ id: f.id, name: f.name }));
}

async function getFolderContactIds(folderId) {
  const ids = [];
  for (const key of folderContactPairs) {
    const [fid, cid] = key.split(':').map(Number);
    if (fid === folderId) ids.push(cid);
  }
  return ids;
}

async function createFolder(userId, name) {
  const folder = { id: nextFolderId++, user_id: userId, name, created_at: nowIso() };
  folders.push(folder);
  return { id: folder.id, name: folder.name };
}

async function addFolderContact(folderId, contactId) {
  folderContactPairs.add(`${folderId}:${contactId}`);
}

async function getFolder(id, userId) {
  return folders.find(f => f.id === id && f.user_id === userId) || null;
}

async function deleteFolderContacts(folderId) {
  for (const key of [...folderContactPairs]) {
    const [fid] = key.split(':').map(Number);
    if (fid === folderId) folderContactPairs.delete(key);
  }
}

async function deleteFolder(folderId) {
  const idx = folders.findIndex(f => f.id === folderId);
  if (idx !== -1) folders.splice(idx, 1);
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------
async function createPost(userId, image, caption) {
  const post = { id: nextPostId++, user_id: userId, image, caption: caption || '', created_at: nowIso() };
  posts.push(post);
  return post;
}

async function getPost(id) {
  return posts.find(p => p.id === id) || null;
}

async function deletePost(id) {
  const idx = posts.findIndex(p => p.id === id);
  if (idx !== -1) posts.splice(idx, 1);
  for (const key of [...postLikePairs]) {
    if (Number(key.split(':')[0]) === id) postLikePairs.delete(key);
  }
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].post_id === id) comments.splice(i, 1);
  }
}

async function likeCount(postId) {
  let n = 0;
  for (const key of postLikePairs) if (Number(key.split(':')[0]) === postId) n++;
  return n;
}

async function hasLiked(postId, userId) {
  return postLikePairs.has(`${postId}:${userId}`);
}

async function likePost(postId, userId) {
  postLikePairs.add(`${postId}:${userId}`);
}

async function unlikePost(postId, userId) {
  postLikePairs.delete(`${postId}:${userId}`);
}

async function commentCount(postId) {
  return comments.filter(c => c.post_id === postId).length;
}

async function addComment(postId, userId, text) {
  const comment = { id: nextCommentId++, post_id: postId, user_id: userId, text, created_at: nowIso() };
  comments.push(comment);
  return comment;
}

async function listComments(postId) {
  const rows = comments
    .filter(c => c.post_id === postId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  const enriched = [];
  for (const c of rows) {
    const author = await getUserById(c.user_id);
    enriched.push({
      id: c.id,
      post_id: c.post_id,
      user_id: c.user_id,
      text: c.text,
      created_at: c.created_at,
      username: author ? author.username : null,
      avatar: author ? author.avatar : null,
    });
  }
  return enriched;
}

async function listPosts(viewerId, filter) {
  let pool = posts.slice();

  if (filter === 'contacts') {
    const myContacts = new Set();
    myContacts.add(viewerId);
    for (const key of contactPairs) {
      const [uid, cid] = key.split(':').map(Number);
      if (uid === viewerId) myContacts.add(cid);
    }
    pool = pool.filter(p => myContacts.has(p.user_id));
  }

  const enriched = [];
  for (const p of pool) {
    const author = await getUserById(p.user_id);
    if (!author) continue;
    enriched.push({
      id: p.id,
      image: p.image,
      caption: p.caption,
      created_at: p.created_at,
      author: { id: author.id, username: author.username, avatar: author.avatar, mood: author.mood, is_ai_person: author.is_ai_person },
      like_count: await likeCount(p.id),
      liked_by_me: await hasLiked(p.id, viewerId),
      comment_count: await commentCount(p.id),
    });
  }

  if (filter === 'liked') {
    enriched.sort((a, b) => b.like_count - a.like_count || b.created_at.localeCompare(a.created_at));
  } else {
    enriched.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  return enriched;
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
