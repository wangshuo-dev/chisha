const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '1024mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));

// ============ DATABASE ============
const db = new Database(path.join(__dirname, 'data', 'chisha.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  -- 用户表
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    goal TEXT DEFAULT '',
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 活动表
  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('eat', 'study', 'free')),
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    time_slot TEXT DEFAULT '',
    status TEXT DEFAULT 'open' CHECK(status IN ('open', 'closed', 'done')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS activity_joins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL,
    member TEXT NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(activity_id, member)
  );

  -- 打卡表
  CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('study', 'eat', 'free')),
    duration_min INTEGER DEFAULT 0,
    note TEXT DEFAULT '',
    study_content TEXT DEFAULT '',
    rating INTEGER DEFAULT 0,
    date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 复习项（艾宾浩斯遗忘曲线）
  CREATE TABLE IF NOT EXISTS review_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member TEXT NOT NULL,
    content TEXT NOT NULL,
    first_studied TEXT NOT NULL,
    next_review_date TEXT NOT NULL,
    review_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'mastered')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 实时状态（同伴效应）
  CREATE TABLE IF NOT EXISTS member_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT '离开',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME
  );

  -- 连续打卡（强化理论）
  CREATE TABLE IF NOT EXISTS streaks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member TEXT UNIQUE NOT NULL,
    current_streak INTEGER DEFAULT 0,
    longest_streak INTEGER DEFAULT 0,
    last_checkin_date TEXT DEFAULT ''
  );

  -- 每日目标（目标设置理论）
  CREATE TABLE IF NOT EXISTS daily_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member TEXT NOT NULL,
    content TEXT NOT NULL,
    target_min INTEGER DEFAULT 60,
    date TEXT NOT NULL,
    completed INTEGER DEFAULT 0
  );

  -- 群聊消息
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL DEFAULT 'group',
    sender TEXT NOT NULL,
    content TEXT NOT NULL,
    is_ai INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 私聊消息
  CREATE TABLE IF NOT EXISTS private_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member TEXT NOT NULL,
    sender TEXT NOT NULL,
    content TEXT NOT NULL,
    is_ai INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ============ SEED USERS ============
const MEMBERS = [
  { name: '姜荣耀', goal: '考研·哲学', password: 'jry123' },
  { name: '李雪婷', goal: '学校兼职', password: 'lxt123' },
  { name: '龙', goal: '考研·会计学', password: 'long123' },
  { name: '马国恒', goal: '考研·通信学', password: 'mgh123' },
  { name: '邱茜', goal: '考公', password: 'qq123' },
  { name: '王朔', goal: '考研·教育学', password: 'ws123' }
];

function hashPwd(pwd) { return crypto.createHash('sha256').update(pwd).digest('hex'); }

const insertUser = db.prepare('INSERT OR IGNORE INTO users (name, goal, password) VALUES (?, ?, ?)');
const insertStreak = db.prepare('INSERT OR IGNORE INTO streaks (member) VALUES (?)');
const insertStatus = db.prepare('INSERT OR IGNORE INTO member_status (member, status) VALUES (?, ?)');
for (const m of MEMBERS) {
  insertUser.run(m.name, m.goal, hashPwd(m.password));
  insertStreak.run(m.name);
  insertStatus.run(m.name, '离开');
}

// ============ KIRO-RS AI CONFIG ============
const AI_CONFIG = {
  baseUrl: 'http://127.0.0.1:8990',
  apiKey: 'sk-kiro-rs-nSg4Xz2c1G3xZ1Qa5y-gXbicW9RLMdlt',
  model: 'claude-sonnet-4-6',
  systemPrompt: `你是"吃啥"小组的AI伙伴，名叫"小鼓"。你的职责是鼓励和陪伴6位朋友：
- 马国恒（考研·通信学）
- 姜荣耀（考研·哲学）
- 王朔（考研·教育学）
- 龙（考研·会计学）
- 李雪婷（学校兼职）
- 邱茜（考公）

你的风格：温暖、幽默、简短有力。用1-3句话回复。
- 鼓励学习时要具体，不要空洞
- 约饭时可以活泼一点
- 有人疲惫时给予理解和支持
- 偶尔用emoji但不要过多
- 记住每个人的目标，给出针对性建议`
};

// Call kiro-rs Anthropic Messages API
async function callAI(messages, systemPrompt) {
  const sys = systemPrompt || AI_CONFIG.systemPrompt;
  const body = JSON.stringify({
    model: AI_CONFIG.model,
    system: sys,
    messages: messages,
    max_tokens: 300
  });

  return new Promise((resolve, reject) => {
    const url = new URL(AI_CONFIG.baseUrl + '/v1/messages');
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': AI_CONFIG.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text || '（AI暂时无法回复）';
          resolve(text);
        } catch (e) {
          resolve('（AI暂时无法回复）');
        }
      });
    });
    req.on('error', () => resolve('（AI暂时无法回复）'));
    req.setTimeout(15000, () => { req.destroy(); resolve('（AI暂时无法回复）'); });
    req.write(body);
    req.end();
  });
}

// ============ AUTH ============
app.post('/api/login', (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  const user = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  if (user.password !== hashPwd(password)) return res.status(401).json({ error: '密码错误' });
  res.json({ name: user.name, goal: user.goal });
});

app.post('/api/change-password', (req, res) => {
  const { name, oldPassword, newPassword } = req.body;
  if (!name || !oldPassword || !newPassword) return res.status(400).json({ error: '缺少参数' });
  if (newPassword.length < 3) return res.status(400).json({ error: '新密码至少3位' });
  const user = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  if (!user || user.password !== hashPwd(oldPassword)) return res.status(401).json({ error: '原密码错误' });
  db.prepare('UPDATE users SET password = ? WHERE name = ?').run(hashPwd(newPassword), name);
  res.json({ ok: true });
});

// ============ MEMBERS ============
app.get('/api/members', (req, res) => {
  const members = db.prepare('SELECT name, goal FROM users').all();
  res.json(members);
});

// ============ STATUS (同伴效应) ============
app.get('/api/status', (req, res) => {
  const now = new Date().toISOString();
  const statuses = db.prepare('SELECT member, status, started_at, expires_at FROM member_status').all();
  // Auto-expire
  const result = statuses.map(s => ({
    ...s,
    status: (s.expires_at && s.expires_at < now) ? '离开' : s.status
  }));
  res.json(result);
});

app.post('/api/status', (req, res) => {
  const { member, status } = req.body;
  if (!member || !status) return res.status(400).json({ error: '缺少参数' });
  const now = new Date();
  const expires = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE member_status SET status = ?, started_at = ?, expires_at = ? WHERE member = ?')
    .run(status, now.toISOString(), expires, member);
  res.json({ ok: true });
});

// ============ ACTIVITIES ============
app.get('/api/activities', (req, res) => {
  const activities = db.prepare(`SELECT * FROM activities ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT 50`).all();
  const joins = db.prepare('SELECT activity_id, member FROM activity_joins').all();
  const joinMap = {};
  for (const j of joins) { if (!joinMap[j.activity_id]) joinMap[j.activity_id] = []; joinMap[j.activity_id].push(j.member); }
  res.json(activities.map(a => ({ ...a, participants: joinMap[a.id] || [] })));
});

app.post('/api/activities', (req, res) => {
  const { creator, type, title, description, time_slot } = req.body;
  if (!creator || !type || !title) return res.status(400).json({ error: '缺少必填项' });
  const result = db.prepare('INSERT INTO activities (creator, type, title, description, time_slot) VALUES (?, ?, ?, ?, ?)').run(creator, type, title, description || '', time_slot || '');
  db.prepare('INSERT INTO activity_joins (activity_id, member) VALUES (?, ?)').run(result.lastInsertRowid, creator);
  res.json({ id: result.lastInsertRowid });
});

app.post('/api/activities/:id/join', (req, res) => {
  const { member } = req.body;
  db.prepare('INSERT OR IGNORE INTO activity_joins (activity_id, member) VALUES (?, ?)').run(req.params.id, member);
  res.json({ ok: true });
});

app.post('/api/activities/:id/leave', (req, res) => {
  const { member } = req.body;
  db.prepare('DELETE FROM activity_joins WHERE activity_id = ? AND member = ?').run(req.params.id, member);
  res.json({ ok: true });
});

app.post('/api/activities/:id/status', (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE activities SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

// ============ CHECKINS ============
app.post('/api/checkins', (req, res) => {
  const { member, type, duration_min, note, study_content, rating } = req.body;
  if (!member || !type) return res.status(400).json({ error: '缺少必填项' });
  const date = new Date().toISOString().split('T')[0];

  db.prepare('INSERT INTO checkins (member, type, duration_min, note, study_content, rating, date) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(member, type, duration_min || 0, note || '', study_content || '', rating || 0, date);

  // If study type with content, create review item (艾宾浩斯)
  if (type === 'study' && study_content) {
    const nextReview = addDays(date, 1);
    db.prepare('INSERT INTO review_items (member, content, first_studied, next_review_date) VALUES (?, ?, ?, ?)')
      .run(member, study_content, date, nextReview);
  }

  // Update streak (强化理论)
  if (type === 'study') {
    const streak = db.prepare('SELECT * FROM streaks WHERE member = ?').get(member);
    if (streak) {
      const yesterday = addDays(date, -1);
      if (streak.last_checkin_date === date) {
        // Already checked in today, no change
      } else if (streak.last_checkin_date === yesterday) {
        const newStreak = streak.current_streak + 1;
        const longest = Math.max(newStreak, streak.longest_streak);
        db.prepare('UPDATE streaks SET current_streak = ?, longest_streak = ?, last_checkin_date = ? WHERE member = ?')
          .run(newStreak, longest, date, member);
      } else {
        db.prepare('UPDATE streaks SET current_streak = 1, last_checkin_date = ? WHERE member = ?').run(date, member);
      }
    }
  }

  res.json({ ok: true });
});

app.get('/api/checkins', (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  res.json(db.prepare('SELECT * FROM checkins WHERE date = ? ORDER BY created_at DESC').all(date));
});

// ============ REVIEW ITEMS (艾宾浩斯) ============
const REVIEW_INTERVALS = [1, 2, 4, 7, 15]; // days after each review

app.get('/api/review-items', (req, res) => {
  const { member } = req.query;
  if (!member) return res.status(400).json({ error: '缺少member' });
  const today = new Date().toISOString().split('T')[0];
  const due = db.prepare("SELECT * FROM review_items WHERE member = ? AND status = 'active' AND next_review_date <= ? ORDER BY next_review_date").all(member, today);
  const upcoming = db.prepare("SELECT * FROM review_items WHERE member = ? AND status = 'active' AND next_review_date > ? ORDER BY next_review_date LIMIT 10").all(member, today);
  const mastered = db.prepare("SELECT * FROM review_items WHERE member = ? AND status = 'mastered' ORDER BY created_at DESC LIMIT 20").all(member);
  res.json({ due, upcoming, mastered });
});

app.post('/api/review-items/:id/review', (req, res) => {
  const item = db.prepare('SELECT * FROM review_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: '未找到' });

  const newCount = item.review_count + 1;
  if (newCount >= 5) {
    db.prepare("UPDATE review_items SET status = 'mastered', review_count = ? WHERE id = ?").run(newCount, item.id);
  } else {
    const today = new Date().toISOString().split('T')[0];
    const interval = REVIEW_INTERVALS[newCount] || 15;
    const nextDate = addDays(today, interval);
    db.prepare('UPDATE review_items SET review_count = ?, next_review_date = ? WHERE id = ?').run(newCount, nextDate, item.id);
  }
  res.json({ ok: true });
});

// ============ DAILY GOALS (目标设置) ============
app.get('/api/daily-goals', (req, res) => {
  const { member } = req.query;
  const date = req.query.date || new Date().toISOString().split('T')[0];
  if (!member) return res.status(400).json({ error: '缺少member' });
  const goals = db.prepare('SELECT * FROM daily_goals WHERE member = ? AND date = ?').all(member, date);
  // Calculate actual study minutes today
  const todayStudy = db.prepare("SELECT COALESCE(SUM(duration_min), 0) as total FROM checkins WHERE member = ? AND date = ? AND type = 'study'").get(member, date);
  res.json({ goals, todayStudyMin: todayStudy.total });
});

app.post('/api/daily-goals', (req, res) => {
  const { member, content, target_min } = req.body;
  if (!member || !content) return res.status(400).json({ error: '缺少必填项' });
  const date = new Date().toISOString().split('T')[0];
  db.prepare('INSERT INTO daily_goals (member, content, target_min, date) VALUES (?, ?, ?, ?)').run(member, content, target_min || 60, date);
  res.json({ ok: true });
});

app.post('/api/daily-goals/:id/complete', (req, res) => {
  db.prepare('UPDATE daily_goals SET completed = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ============ STREAKS ============
app.get('/api/streaks', (req, res) => {
  res.json(db.prepare('SELECT * FROM streaks').all());
});

// ============ STATS ============
app.get('/api/stats', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const member = req.query.member || '';
  const stats = db.prepare(`SELECT member, type, SUM(duration_min) as total_min, COUNT(*) as count, ROUND(AVG(CASE WHEN rating > 0 THEN rating END), 1) as avg_rating FROM checkins WHERE date >= date('now', '-' || ? || ' days') GROUP BY member, type`).all(days);
  // Hide other people's ratings
  res.json(stats.map(s => ({
    ...s,
    avg_rating: s.member === member ? s.avg_rating : null
  })));
});

// ============ CHAT ROOMS (加密聊天) ============
// 新表：聊天室 + 消息（服务端只存密文）
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('private', 'group')),
    creator TEXT NOT NULL,
    include_ai INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS room_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    member TEXT NOT NULL,
    UNIQUE(room_id, member)
  );
  CREATE TABLE IF NOT EXISTS room_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    sender TEXT NOT NULL,
    content TEXT NOT NULL,
    iv TEXT DEFAULT '',
    is_encrypted INTEGER DEFAULT 0,
    is_ai INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed: create a default "全员群" if not exists
const defaultRoom = db.prepare("SELECT id FROM chat_rooms WHERE name = '全员群'").get();
if (!defaultRoom) {
  const r = db.prepare("INSERT INTO chat_rooms (name, type, creator) VALUES ('全员群', 'group', '系统')").run();
  const roomId = r.lastInsertRowid;
  const names = ['马国恒','姜荣耀','王朔','龙','李雪婷','邱茜'];
  for (const n of names) db.prepare('INSERT OR IGNORE INTO room_members (room_id, member) VALUES (?, ?)').run(roomId, n);
}

// Get my rooms
app.get('/api/rooms', (req, res) => {
  const { member } = req.query;
  if (!member) return res.status(400).json({ error: '缺少member' });
  const rooms = db.prepare(`
    SELECT r.*, GROUP_CONCAT(rm2.member) as members_str
    FROM chat_rooms r
    JOIN room_members rm ON r.id = rm.room_id AND rm.member = ?
    LEFT JOIN room_members rm2 ON r.id = rm2.room_id
    GROUP BY r.id
    ORDER BY r.created_at DESC
  `).all(member);
  res.json(rooms.map(r => ({ ...r, members: r.members_str ? r.members_str.split(',') : [] })));
});

// Create room (private or group)
app.post('/api/rooms', (req, res) => {
  const { creator, name, type, members, include_ai } = req.body;
  if (!creator || !name || !type || !members || members.length === 0) return res.status(400).json({ error: '缺少参数' });

  // For private chat, check if room already exists between these 2 people
  if (type === 'private' && members.length === 2) {
    const existing = db.prepare(`
      SELECT r.id FROM chat_rooms r
      WHERE r.type = 'private'
      AND (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) = 2
      AND EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = r.id AND rm.member = ?)
      AND EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id = r.id AND rm.member = ?)
    `).get(members[0], members[1]);
    if (existing) return res.json({ id: existing.id, existed: true });
  }

  const r = db.prepare('INSERT INTO chat_rooms (name, type, creator, include_ai) VALUES (?, ?, ?, ?)').run(name, type, creator, include_ai !== false ? 1 : 0);
  const roomId = r.lastInsertRowid;
  for (const m of members) {
    db.prepare('INSERT OR IGNORE INTO room_members (room_id, member) VALUES (?, ?)').run(roomId, m);
  }
  res.json({ id: roomId });
});

// Add member to room
app.post('/api/rooms/:id/add-member', (req, res) => {
  const { member } = req.body;
  db.prepare('INSERT OR IGNORE INTO room_members (room_id, member) VALUES (?, ?)').run(req.params.id, member);
  res.json({ ok: true });
});

// Get messages in a room
app.get('/api/rooms/:id/messages', (req, res) => {
  const { member } = req.query;
  const roomId = req.params.id;
  // Verify membership
  const isMember = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND member = ?').get(roomId, member);
  if (!isMember) return res.status(403).json({ error: '无权访问' });
  const limit = parseInt(req.query.limit) || 50;
  const messages = db.prepare('SELECT * FROM room_messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?').all(roomId, limit);
  res.json(messages.reverse());
});

// Send message to room (content may be encrypted client-side)
app.post('/api/rooms/:id/messages', async (req, res) => {
  const { sender, content, iv, is_encrypted, call_ai } = req.body;
  const roomId = req.params.id;
  if (!sender || !content) return res.status(400).json({ error: '缺少参数' });

  // Verify membership
  const isMember = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND member = ?').get(roomId, sender);
  if (!isMember) return res.status(403).json({ error: '无权发送' });

  // Save message
  const r = db.prepare('INSERT INTO room_messages (room_id, sender, content, iv, is_encrypted, is_ai) VALUES (?, ?, ?, ?, ?, 0)')
    .run(roomId, sender, content, iv || '', is_encrypted ? 1 : 0);

  let aiMsg = null;
  // If call_ai is true, content is NOT encrypted, and room has AI enabled
  if (call_ai && !is_encrypted) {
    const room = db.prepare('SELECT * FROM chat_rooms WHERE id = ?').get(roomId);
    if (room && room.include_ai) {
      const recent = db.prepare("SELECT sender, content, is_ai FROM room_messages WHERE room_id = ? AND is_encrypted = 0 ORDER BY created_at DESC LIMIT 10").all(roomId).reverse();
      const aiMessages = recent.map(m => ({
        role: m.is_ai ? 'assistant' : 'user',
        content: m.is_ai ? m.content : `${m.sender}说：${m.content}`
      }));

      let sys = AI_CONFIG.systemPrompt;
      if (room.type === 'private') {
        const user = db.prepare('SELECT goal FROM users WHERE name = ?').get(sender);
        sys += `\n\n你现在在和${sender}私聊。TA的目标是${user?.goal || '未知'}。更加个性化地鼓励和帮助TA。`;
      }

      const aiReply = await callAI(aiMessages, sys);
      db.prepare('INSERT INTO room_messages (room_id, sender, content, iv, is_encrypted, is_ai) VALUES (?, ?, ?, ?, 0, 1)')
        .run(roomId, '小鼓', aiReply, '');
      aiMsg = { sender: '小鼓', content: aiReply, is_ai: 1 };
    }
  }

  res.json({ id: r.lastInsertRowid, aiMsg });
});

// Delete message
app.delete('/api/rooms/:roomId/messages/:msgId', (req, res) => {
  const { member } = req.body;
  const { roomId, msgId } = req.params;
  // Only sender can delete their own message, or any member can delete AI messages
  const msg = db.prepare('SELECT * FROM room_messages WHERE id = ? AND room_id = ?').get(msgId, roomId);
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  if (msg.sender !== member && !msg.is_ai) return res.status(403).json({ error: '只能删除自己的消息' });
  db.prepare('DELETE FROM room_messages WHERE id = ?').run(msgId);
  res.json({ ok: true });
});

// ============ HELPERS ============
function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// ============ IMAGE UPLOAD + AI RECOGNITION ============
const uploadsDir = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.post('/api/upload-image', async (req, res) => {
  const { image, member } = req.body; // image is base64 data URL
  if (!image || !member) return res.status(400).json({ error: '缺少参数' });

  // Save image
  const matches = image.match(/^data:image\/(.*?);base64,(.*)$/);
  if (!matches) return res.status(400).json({ error: '无效图片格式' });
  const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
  const data = matches[2];
  const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(data, 'base64'));

  // Ask AI to recognize study content from image
  const aiMessages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: `image/${matches[1]}`, data: data } },
      { type: 'text', text: '这是一张学习相关的图片。请用简短的一句话描述图片中的学习内容（比如"高等数学-定积分"、"教育心理学-知识建构"等）。只输出内容描述，不要其他解释。' }
    ]
  }];

  const body = JSON.stringify({
    model: AI_CONFIG.model,
    messages: aiMessages,
    max_tokens: 100
  });

  const aiText = await new Promise((resolve) => {
    const url = new URL(AI_CONFIG.baseUrl + '/v1/messages');
    const options = {
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': AI_CONFIG.apiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
    };
    const req2 = http.request(options, (r) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d).content?.[0]?.text || '学习内容'); } catch(e) { resolve('学习内容'); } });
    });
    req2.on('error', () => resolve('学习内容'));
    req2.setTimeout(20000, () => { req2.destroy(); resolve('学习内容'); });
    req2.write(body); req2.end();
  });

  res.json({ filename, url: `/uploads/${filename}`, study_content: aiText });
});

// Chat file upload (每人最多2GB)
app.post('/api/upload-chat-file', (req, res) => {
  const { data, name, mime, member } = req.body;
  if (!data) return res.status(400).json({ error: '缺少文件数据' });

  const matches = data.match(/^data:(.*?);base64,(.*)$/);
  if (!matches) return res.status(400).json({ error: '无效文件格式' });

  const base64Data = matches[2];
  const fileSize = Buffer.byteLength(base64Data, 'base64');

  // Check user storage quota (2GB per person)
  if (member) {
    const userDir = path.join(uploadsDir, member);
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    let totalSize = 0;
    try {
      const files = fs.readdirSync(userDir);
      for (const f of files) {
        totalSize += fs.statSync(path.join(userDir, f)).size;
      }
    } catch(e) {}
    if (totalSize + fileSize > 2 * 1024 * 1024 * 1024) {
      return res.status(413).json({ error: '存储空间已满（每人最多2GB）' });
    }
    const origExt = name ? name.split('.').pop() : 'bin';
    const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${origExt}`;
    fs.writeFileSync(path.join(userDir, filename), Buffer.from(base64Data, 'base64'));
    return res.json({ url: `/uploads/${member}/${filename}`, filename });
  }

  const origExt = name ? name.split('.').pop() : 'bin';
  const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${origExt}`;
  fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(base64Data, 'base64'));
  res.json({ url: `/uploads/${filename}`, filename });
});

// ============ START ============
const PORT = process.env.PORT || 3099;
app.listen(PORT, () => console.log(`吃啥组合系统 running on port ${PORT}`));
