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

  -- 活动匿名投票
  CREATE TABLE IF NOT EXISTS activity_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL,
    member TEXT NOT NULL,
    vote TEXT NOT NULL CHECK(vote IN ('support', 'decline')),
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

  -- 虚拟自习室
  CREATE TABLE IF NOT EXISTS study_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    floor INTEGER NOT NULL,
    name TEXT NOT NULL,
    total_seats INTEGER DEFAULT 20,
    description TEXT DEFAULT '',
    owner TEXT DEFAULT ''
  );

  -- 座位
  CREATE TABLE IF NOT EXISTS study_seats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    seat_number INTEGER NOT NULL,
    member TEXT DEFAULT '',
    scene TEXT DEFAULT '',
    seated_at DATETIME,
    UNIQUE(room_id, seat_number)
  );

  -- 自习记录
  CREATE TABLE IF NOT EXISTS study_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member TEXT NOT NULL,
    room_id INTEGER NOT NULL,
    seat_number INTEGER NOT NULL,
    scene TEXT DEFAULT '',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    duration_min INTEGER DEFAULT 0
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
  baseUrl: 'http://192.3.187.8:8990',
  apiKey: 'sk-kiro-rs-nSg4Xz2c1G3xZ1Qa5y-gXbicW9RLMdlt',
  model: 'claude-sonnet-4-6',
  systemPrompt: `你是"吃啥"小组的AI学习伙伴，名叫"小鼓"。你的职责是鼓励、陪伴和辅导6位朋友：
- 马国恒（考研·通信工程）：可以帮他解答信号与系统、通信原理、数电模电等问题
- 姜荣耀（考研·哲学）：可以帮他梳理马哲、中哲、西哲知识点
- 王朔（考研·教育学/333教育综合）：可以帮他梳理教育学原理、教育心理学、中外教育史知识点
- 龙（考研·会计学）：可以帮她解答会计学、财务管理、审计等问题
- 李雪婷（学校兼职）：鼓励她平衡工作和生活
- 邱茜（考公）：可以帮她梳理行测、申论知识点

你的风格：温暖、专业、简洁。
- 在群聊中用1-3句话回复，活泼鼓励
- 在私聊中可以更详细地解答学科问题，像一个耐心的学长/学姐
- 当用户问学科问题时，给出准确、有条理的解答
- 当用户疲惫时给予理解和支持
- 适当督促学习，但不要让人有压力
- 偶尔用emoji但不要过多`
};

// Read image as base64 for vision (max 1MB file)
function imageToBase64(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 5 * 1024 * 1024) return null; // skip files > 5MB
    const buf = fs.readFileSync(filePath);
    return buf.toString('base64');
  } catch(e) {
    console.error('Image read error:', e.message);
    return null;
  }
}

// Detect media type from extension
function getMediaType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp'};
  return map[ext] || 'image/jpeg';
}

// Build vision content block from image URL
function buildVisionContent(text, imageUrl) {
  // imageUrl is like /uploads/member/filename.jpg
  const filePath = path.join(__dirname, 'data', imageUrl);
  if (!fs.existsSync(filePath)) return [{ type: 'text', text: text || '（用户发了一张图片但无法读取）' }];
  
  const b64 = imageToBase64(filePath);
  if (!b64) return [{ type: 'text', text: text || '（用户发了一张图片，文件太大无法处理）' }];
  
  const content = [];
  if (text) content.push({ type: 'text', text });
  content.push({
    type: 'image',
    source: { type: 'base64', media_type: getMediaType(filePath), data: b64 }
  });
  return content;
}

// Call kiro-rs Anthropic Messages API (supports vision)
async function callAI(messages, systemPrompt) {
  const sys = systemPrompt || AI_CONFIG.systemPrompt;
  const body = JSON.stringify({
    model: AI_CONFIG.model,
    system: sys,
    messages: messages,
    max_tokens: 600
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
  db.prepare('UPDATE member_status SET status = ?, started_at = ?, expires_at = NULL WHERE member = ?')
    .run(status, now.toISOString(), member);
  res.json({ ok: true });
});

// ============ ACTIVITIES ============
app.get('/api/activities', (req, res) => {
  const activities = db.prepare(`SELECT * FROM activities ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT 50`).all();
  const joins = db.prepare('SELECT activity_id, member FROM activity_joins').all();
  const joinMap = {};
  for (const j of joins) { if (!joinMap[j.activity_id]) joinMap[j.activity_id] = []; joinMap[j.activity_id].push(j.member); }
  const votes = db.prepare('SELECT activity_id, vote, COUNT(*) as count FROM activity_votes GROUP BY activity_id, vote').all();
  const voteMap = {};
  for (const v of votes) { if (!voteMap[v.activity_id]) voteMap[v.activity_id] = {support:0,decline:0}; voteMap[v.activity_id][v.vote] = v.count; }
  // Also get current user's vote
  const member = req.query.member || '';
  const myVotes = member ? db.prepare('SELECT activity_id, vote FROM activity_votes WHERE member = ?').all(member) : [];
  const myVoteMap = {};
  for (const v of myVotes) myVoteMap[v.activity_id] = v.vote;
  res.json(activities.map(a => ({ ...a, participants: joinMap[a.id] || [], votes: voteMap[a.id] || {support:0,decline:0}, myVote: myVoteMap[a.id] || null })));
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

// Delete activity (creator only)
app.delete('/api/activities/:id', (req, res) => {
  const { member } = req.body;
  const act = db.prepare('SELECT * FROM activities WHERE id = ?').get(req.params.id);
  if (!act) return res.status(404).json({ error: '活动不存在' });
  if (act.creator !== member) return res.status(403).json({ error: '只有发起人可以删除' });
  db.prepare('DELETE FROM activity_joins WHERE activity_id = ?').run(req.params.id);
  db.prepare('DELETE FROM activity_votes WHERE activity_id = ?').run(req.params.id);
  db.prepare('DELETE FROM activities WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Anonymous vote on activity
app.post('/api/activities/:id/vote', (req, res) => {
  const { member, vote } = req.body;
  if (!member || !vote) return res.status(400).json({ error: '缺少参数' });
  if (!['support', 'decline'].includes(vote)) return res.status(400).json({ error: '无效投票' });
  // Can't vote on own activity
  const activity = db.prepare('SELECT creator FROM activities WHERE id = ?').get(req.params.id);
  if (activity && activity.creator === member) return res.status(400).json({ error: '不能给自己的活动投票' });
  db.prepare('INSERT OR REPLACE INTO activity_votes (activity_id, member, vote) VALUES (?, ?, ?)').run(req.params.id, member, vote);
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

// Toggle AI in room
app.post('/api/rooms/:id/toggle-ai', (req, res) => {
  const { include_ai } = req.body;
  db.prepare('UPDATE chat_rooms SET include_ai = ? WHERE id = ?').run(include_ai ? 1 : 0, req.params.id);
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
      
      // Build messages with vision support
      const aiMessages = [];
      for (const m of recent) {
        if (m.is_ai) {
          aiMessages.push({ role: 'assistant', content: m.content });
        } else {
          // Try to parse file/image messages
          let parsed = null;
          try { parsed = JSON.parse(m.content); } catch(e) {}
          
          if (parsed && parsed.file && parsed.isImage) {
            // Image message — build vision content
            const visionContent = buildVisionContent(
              parsed.text ? `${m.sender}说：${parsed.text}` : `${m.sender}发了一张图片，请描述和分析图片内容`,
              parsed.file
            );
            aiMessages.push({ role: 'user', content: visionContent });
          } else if (parsed && parsed.file && !parsed.isImage) {
            // File message — just describe it
            const desc = parsed.text ? `${m.sender}说：${parsed.text}（附件：${parsed.fileName || '文件'}）` : `${m.sender}发了一个文件：${parsed.fileName || '文件'}`;
            aiMessages.push({ role: 'user', content: desc });
          } else {
            aiMessages.push({ role: 'user', content: `${m.sender}说：${m.content}` });
          }
        }
      }

      let sys = AI_CONFIG.systemPrompt;
      if (room.type === 'private' || room.name?.startsWith('小鼓·')) {
        const user = db.prepare('SELECT goal FROM users WHERE name = ?').get(sender);
        sys += `\n\n你现在在和${sender}一对一私聊。TA的目标是${user?.goal || '未知'}。
在私聊模式下：
- 你是TA的专属学习辅导员，可以详细解答学科问题
- 如果TA发了图片（教材、笔记、题目等），仔细分析图片内容并给出解答
- 如果TA问考试相关的知识点，给出清晰、有条理的解答
- 如果TA只是闲聊，适当引导回学习，但不要太强硬
- 可以主动问TA今天学了什么、有什么困难
- 回复可以更长更详细（3-10句话）`;
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


// ============ STUDY ROOMS (虚拟自习室) ============
// Seed rooms
const existingRooms = db.prepare("SELECT COUNT(*) as c FROM study_rooms").get();
if (existingRooms.c === 0) {
  const rooms = [
    { floor: 1, name: '一楼自习室', total_seats: 20, description: '安静舒适的学习空间', owner: '' },
    { floor: 2, name: '二楼自习室', total_seats: 20, description: '明亮宽敞的学习区域', owner: '' },
    { floor: 3, name: '三楼自习室', total_seats: 20, description: '高层视野开阔', owner: '' },
    { floor: 4, name: '天台自习室', total_seats: 1, description: '顶楼天台，独享宁静', owner: '' }
  ];
  const insertRoom = db.prepare('INSERT INTO study_rooms (floor, name, total_seats, description, owner) VALUES (?, ?, ?, ?, ?)');
  for (const r of rooms) {
    const res = insertRoom.run(r.floor, r.name, r.total_seats, r.description, r.owner);
    // Create seats for each room
    const insertSeat = db.prepare('INSERT OR IGNORE INTO study_seats (room_id, seat_number) VALUES (?, ?)');
    for (let i = 1; i <= r.total_seats; i++) {
      insertSeat.run(res.lastInsertRowid, i);
    }
  }
}
// Fix: remove owner restriction from 天台
db.prepare("UPDATE study_rooms SET owner = '', description = '顶楼天台，独享宁静' WHERE name = '天台自习室'").run();

// Study room inline chat with AI
app.post('/api/study-rooms/chat', async (req, res) => {
  const { member, message, history } = req.body;
  if (!member || !message) return res.status(400).json({ error: '缺少参数' });
  
  const user = db.prepare('SELECT goal FROM users WHERE name = ?').get(member);
  const sys = AI_CONFIG.systemPrompt + `\n\n你现在在虚拟自习室里陪${member}学习。TA的目标是${user?.goal || '未知'}。
保持简短（1-3句话），像一个安静陪伴的学习伙伴。如果TA问学科问题可以详细回答。`;
  
  const messages = (history || []).slice(-8).map(m => ({
    role: m.sender === '小鼓' ? 'assistant' : 'user',
    content: m.sender === '小鼓' ? m.text : `${m.sender}：${m.text}`
  }));
  messages.push({ role: 'user', content: message });
  
  const reply = await callAI(messages, sys);
  res.json({ reply });
});

// Get all rooms with occupancy
app.get('/api/study-rooms', (req, res) => {
  const rooms = db.prepare('SELECT * FROM study_rooms ORDER BY floor').all();
  const seats = db.prepare("SELECT room_id, COUNT(*) as occupied FROM study_seats WHERE member != '' AND member IS NOT NULL AND member != '' GROUP BY room_id").all();
  const seatMap = {};
  for (const s of seats) seatMap[s.room_id] = s.occupied;
  res.json(rooms.map(r => ({ ...r, occupied: seatMap[r.id] || 0 })));
});

// Get seats for a room
app.get('/api/study-rooms/:id/seats', (req, res) => {
  const seats = db.prepare('SELECT * FROM study_seats WHERE room_id = ? ORDER BY seat_number').all(req.params.id);
  res.json(seats);
});

// Sit down (take a seat)
app.post('/api/study-rooms/:id/sit', (req, res) => {
  const { member, seat_number, scene } = req.body;
  const roomId = req.params.id;
  if (!member || !seat_number) return res.status(400).json({ error: '缺少参数' });

  // Check room ownership (4F is 王朔 exclusive)
  const room = db.prepare('SELECT * FROM study_rooms WHERE id = ?').get(roomId);
  if (room && room.owner && room.owner !== member) {
    return res.status(403).json({ error: `这是${room.owner}的专属自习室` });
  }

  // Check if already seated somewhere
  const existing = db.prepare("SELECT * FROM study_seats WHERE member = ?").get(member);
  if (existing) {
    // Leave current seat first
    db.prepare("UPDATE study_seats SET member = '', scene = '', seated_at = NULL WHERE member = ?").run(member);
    // End current session
    const session = db.prepare("SELECT * FROM study_sessions WHERE member = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get(member);
    if (session) {
      const duration = Math.round((Date.now() - new Date(session.started_at).getTime()) / 60000);
      db.prepare("UPDATE study_sessions SET ended_at = datetime('now'), duration_min = ? WHERE id = ?").run(duration, session.id);
    }
  }

  // Check seat availability
  const seat = db.prepare('SELECT * FROM study_seats WHERE room_id = ? AND seat_number = ?').get(roomId, seat_number);
  if (!seat) return res.status(404).json({ error: '座位不存在' });
  if (seat.member && seat.member !== member) return res.status(409).json({ error: '座位已被占用' });

  // Sit down
  db.prepare("UPDATE study_seats SET member = ?, scene = ?, seated_at = datetime('now') WHERE room_id = ? AND seat_number = ?")
    .run(member, scene || '大海', roomId, seat_number);

  // Start session
  db.prepare("INSERT INTO study_sessions (member, room_id, seat_number, scene) VALUES (?, ?, ?, ?)")
    .run(member, roomId, seat_number, scene || '大海');

  // Auto set status to 学习中
  db.prepare("UPDATE member_status SET status = '学习中', started_at = datetime('now'), expires_at = datetime('now', '+8 hours') WHERE member = ?").run(member);

  res.json({ ok: true });
});

// Leave seat
app.post('/api/study-rooms/leave', (req, res) => {
  const { member } = req.body;
  if (!member) return res.status(400).json({ error: '缺少参数' });

  db.prepare("UPDATE study_seats SET member = '', scene = '', seated_at = NULL WHERE member = ?").run(member);

  // End session
  const session = db.prepare("SELECT * FROM study_sessions WHERE member = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get(member);
  if (session) {
    const duration = Math.round((Date.now() - new Date(session.started_at).getTime()) / 60000);
    db.prepare("UPDATE study_sessions SET ended_at = datetime('now'), duration_min = ? WHERE id = ?").run(duration, session.id);
  }

  // Set status to 离开
  db.prepare("UPDATE member_status SET status = '离开' WHERE member = ?").run(member);

  res.json({ ok: true, duration: session ? Math.round((Date.now() - new Date(session.started_at).getTime()) / 60000) : 0 });
});

// Change scene while seated
app.post('/api/study-rooms/change-scene', (req, res) => {
  const { member, scene } = req.body;
  if (!member || !scene) return res.status(400).json({ error: '缺少参数' });
  db.prepare("UPDATE study_seats SET scene = ? WHERE member = ?").run(scene, member);
  db.prepare("UPDATE study_sessions SET scene = ? WHERE member = ? AND ended_at IS NULL").run(scene, member);
  res.json({ ok: true });
});

// Get current seat info for a member
app.get('/api/study-rooms/my-seat', (req, res) => {
  const { member } = req.query;
  if (!member) return res.status(400).json({ error: '缺少member' });
  const seat = db.prepare(`
    SELECT s.*, r.name as room_name, r.floor, r.description as room_desc
    FROM study_seats s
    JOIN study_rooms r ON s.room_id = r.id
    WHERE s.member = ?
  `).get(member);
  if (!seat || !seat.member) return res.json({ seated: false });
  const session = db.prepare("SELECT * FROM study_sessions WHERE member = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get(member);
  res.json({ seated: true, ...seat, session });
});


// ============ START ============
const PORT = process.env.PORT || 3099;
app.listen(PORT, () => console.log(`吃啥组合系统 running on port ${PORT}`));
