const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'viralbot.db');

let db;
let SQL;

// Save DB to disk
function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Auto-save every 30 seconds
setInterval(saveDb, 30000);

// Initialize database
async function initDb() {
  SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS published_videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT,
      published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(video_id, account_id)
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle TEXT NOT NULL UNIQUE,
      category TEXT,
      access_token TEXT,
      refresh_token TEXT,
      status TEXT DEFAULT 'pending',
      daily_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS video_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      category TEXT NOT NULL,
      mix_type TEXT NOT NULL,
      title TEXT,
      description TEXT,
      tags TEXT,
      r2_url TEXT,
      status TEXT DEFAULT 'pending',
      scheduled_at DATETIME,
      published_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scan_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      videos_found INTEGER DEFAULT 0,
      videos_selected INTEGER DEFAULT 0,
      videos_rejected INTEGER DEFAULT 0,
      scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    
    CREATE TABLE IF NOT EXISTS scanned_videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      category TEXT NOT NULL,
      mix_type TEXT NOT NULL,
      title TEXT,
      channel TEXT,
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      score INTEGER DEFAULT 0,
      thumbnail TEXT,
      lang TEXT DEFAULT 'EN',
      scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(video_id, category)
    );
    CREATE TABLE IF NOT EXISTS system_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  saveDb();
  return db;
}

// Helper: run query and return all rows
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// Helper: run query and return first row
function get(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] || null;
}

// Helper: run insert/update/delete
function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

const dbHelpers = {
  isPublished: (videoId, accountId) => {
    return !!get('SELECT id FROM published_videos WHERE video_id = ? AND account_id = ?', [videoId, accountId]);
  },

  markPublished: (videoId, accountId, category, title) => {
    run('INSERT OR IGNORE INTO published_videos (video_id, account_id, category, title) VALUES (?, ?, ?, ?)',
      [videoId, accountId, category, title]);
  },

  getAccountsByCategory: (category) => {
    return all("SELECT * FROM accounts WHERE category = ? AND status = 'active' AND access_token IS NOT NULL", [category]);
  },

  getAllActiveAccounts: () => {
    return all("SELECT * FROM accounts WHERE status = 'active' AND access_token IS NOT NULL");
  },

  updateAccount: (handle, data) => {
    const fields = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(data), handle];
    run(`UPDATE accounts SET ${fields} WHERE handle = ?`, values);
  },

  addToQueue: (item) => {
    run(`INSERT INTO video_queue (video_id, account_id, category, mix_type, title, description, tags, r2_url, scheduled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [item.videoId, item.accountId, item.category, item.mixType,
       item.title, item.description, item.tags, item.r2Url, item.scheduledAt]);
  },

  getPendingQueue: (accountId) => {
    return all("SELECT * FROM video_queue WHERE account_id = ? AND status = 'pending' ORDER BY scheduled_at ASC", [accountId]);
  },

  markQueueDone: (id, status) => {
    run('UPDATE video_queue SET status = ?, published_at = datetime("now") WHERE id = ?', [status, id]);
  },

  logScan: (category, found, selected, rejected) => {
    run('INSERT INTO scan_log (category, videos_found, videos_selected, videos_rejected) VALUES (?, ?, ?, ?)',
      [category, found, selected, rejected]);
  },

  getStat: (key) => {
    const row = get('SELECT value FROM system_stats WHERE key = ?', [key]);
    return row ? row.value : null;
  },

  setStat: (key, value) => {
    run('INSERT OR REPLACE INTO system_stats (key, value, updated_at) VALUES (?, ?, datetime("now"))', [key, String(value)]);
  },

  getTodayCount: (accountId) => {
    const row = get("SELECT COUNT(*) as cnt FROM published_videos WHERE account_id = ? AND DATE(published_at) = DATE('now')", [accountId]);
    return row ? row.cnt : 0;
  },

  getDashboardStats: () => {
    const totalPublished = get("SELECT COUNT(*) as cnt FROM published_videos WHERE DATE(published_at) = DATE('now')");
    const totalQueue = get("SELECT COUNT(*) as cnt FROM video_queue WHERE status = 'pending'");
    const lastScan = get('SELECT * FROM scan_log ORDER BY scanned_at DESC LIMIT 1');
    const accounts = all('SELECT * FROM accounts');
    return {
      totalPublished: totalPublished?.cnt || 0,
      totalQueue: totalQueue?.cnt || 0,
      lastScan,
      accounts,
    };
  },

  
  saveScannedVideos: (category, videos, mixType) => {
    videos.forEach(function(v) {
      try {
        run('INSERT OR REPLACE INTO scanned_videos (video_id, category, mix_type, title, channel, views, likes, comments, duration, score, thumbnail, lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [v.id, category, mixType, v.title, v.channelTitle, v.views || 0, v.likes || 0, v.comments || 0, v.duration || 0, v.score || 0, v.thumbnail || '', v.lang || 'EN']);
      } catch(e) {}
    });
  },

  getScannedVideos: (category, mixType, limit) => {
    let sql = 'SELECT * FROM scanned_videos WHERE 1=1';
    const params = [];
    if (category) { sql += ' AND category = ?'; params.push(category); }
    if (mixType) { sql += ' AND mix_type = ?'; params.push(mixType); }
    sql += ' ORDER BY score DESC, scanned_at DESC LIMIT ?';
    params.push(limit || 240);
    return all(sql, params);
  },

// Raw helpers for API routes
  all,
  get,
  run,
};

module.exports = { initDb, dbHelpers, saveDb };
