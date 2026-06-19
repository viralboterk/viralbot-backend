const { Pool } = require('pg');
const logger = require('./logger');

// PostgreSQL connection pool
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set. Please add a PostgreSQL database in Railway.');
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

// =====================
// CORE HELPERS
// =====================

async function run(sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function get(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows[0] || null;
  } finally {
    client.release();
  }
}

async function all(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    client.release();
  }
}

// =====================
// INIT DATABASE
// =====================

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE,
        category TEXT,
        access_token TEXT,
        refresh_token TEXT,
        status TEXT DEFAULT 'pending',
        daily_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      -- Migration: the production accounts table already existed before the
      -- followers column was added, so CREATE TABLE IF NOT EXISTS alone won't
      -- add it to existing rows.
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS followers INTEGER DEFAULT 0;
      -- Adaptive pacing: each account starts at the default 20 min interval
      -- between posts. Hitting spam_risk widens it (capped); going 3+ days
      -- without hitting it brings it back down to the default.
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS post_interval_min INTEGER DEFAULT 20;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_spam_risk_at TIMESTAMPTZ;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS total_views BIGINT DEFAULT 0;

      CREATE TABLE IF NOT EXISTS published_videos (
        id SERIAL PRIMARY KEY,
        video_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT,
        published_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(video_id, account_id)
      );

      CREATE TABLE IF NOT EXISTS video_queue (
        id SERIAL PRIMARY KEY,
        video_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        category TEXT NOT NULL,
        mix_type TEXT NOT NULL,
        title TEXT,
        description TEXT,
        tags TEXT,
        r2_url TEXT,
        status TEXT DEFAULT 'pending',
        scheduled_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE video_queue ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;

      CREATE TABLE IF NOT EXISTS scan_log (
        id SERIAL PRIMARY KEY,
        category TEXT NOT NULL,
        videos_found INTEGER DEFAULT 0,
        videos_selected INTEGER DEFAULT 0,
        videos_rejected INTEGER DEFAULT 0,
        scanned_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS scanned_videos (
        id SERIAL PRIMARY KEY,
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
        scanned_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(video_id, category)
      );

      CREATE TABLE IF NOT EXISTS system_stats (
        id SERIAL PRIMARY KEY,
        key TEXT UNIQUE,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS channel_blacklist (
        channel TEXT PRIMARY KEY,
        reason TEXT,
        rejected_count INTEGER DEFAULT 1,
        first_rejected_at TIMESTAMPTZ DEFAULT NOW(),
        last_rejected_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    logger.info('PostgreSQL database initialized');
  } finally {
    client.release();
  }
}

// =====================
// DB HELPERS
// =====================

const dbHelpers = {

  // ── ACCOUNTS ──────────────────────────────────────────────
  getAllActiveAccounts: async () => {
    return all(
      "SELECT * FROM accounts WHERE status = 'active' AND access_token IS NOT NULL"
    );
  },

  getAccountByHandle: async (handle) => {
    return get('SELECT * FROM accounts WHERE handle = $1', [handle]);
  },

  updateAccount: async (handle, fields) => {
    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    await run(
      `UPDATE accounts SET ${setClause} WHERE handle = $${keys.length + 1}`,
      [...values, handle]
    );
  },

  // ── PUBLISHED VIDEOS ──────────────────────────────────────
  isPublished: async (videoId, accountId) => {
    const row = await get(
      'SELECT id FROM published_videos WHERE video_id = $1 AND account_id = $2',
      [videoId, accountId]
    );
    return !!row;
  },

  markPublished: async (videoId, accountId, category, title) => {
    await run(
      'INSERT INTO published_videos (video_id, account_id, category, title) VALUES ($1, $2, $3, $4) ON CONFLICT (video_id, account_id) DO NOTHING',
      [videoId, accountId, category, title]
    );
  },

  getTodayCount: async (accountId) => {
    const row = await get(
      'SELECT COUNT(*) as cnt FROM published_videos WHERE account_id = $1 AND published_at::date = CURRENT_DATE',
      [accountId]
    );
    return row ? parseInt(row.cnt) : 0;
  },

  // ── VIDEO QUEUE ───────────────────────────────────────────
  addToQueue: async (item) => {
    await run(
      `INSERT INTO video_queue (video_id, account_id, category, mix_type, title, description, tags, r2_url, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [item.videoId, item.accountId, item.category, item.mixType,
       item.title, item.description, item.tags, item.r2Url, item.scheduledAt]
    );
  },

  getPendingQueue: async (accountId) => {
    return all(
      "SELECT * FROM video_queue WHERE account_id = $1 AND status = 'pending' ORDER BY scheduled_at ASC",
      [accountId]
    );
  },

  markQueueDone: async (id, status) => {
    await run(
      'UPDATE video_queue SET status = $1, published_at = NOW() WHERE id = $2',
      [status, id]
    );
  },

  // ── SCAN LOG ──────────────────────────────────────────────
  logScan: async (category, found, selected, rejected) => {
    await run(
      'INSERT INTO scan_log (category, videos_found, videos_selected, videos_rejected) VALUES ($1, $2, $3, $4)',
      [category, found, selected, rejected]
    );
  },

  // ── SCANNED VIDEOS ────────────────────────────────────────
  saveScannedVideos: async (category, videos, mixType) => {
    for (const v of videos) {
      try {
        await run(
          `INSERT INTO scanned_videos (video_id, category, mix_type, title, channel, views, likes, comments, duration, score, thumbnail, lang)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (video_id, category) DO UPDATE SET
             title = EXCLUDED.title, views = EXCLUDED.views, score = EXCLUDED.score,
             scanned_at = NOW()`,
          [v.id, category, mixType, v.title, v.channelTitle,
           v.views || 0, v.likes || 0, v.comments || 0,
           v.duration || 0, v.score || 0, v.thumbnail || '', v.lang || 'EN']
        );
      } catch (e) {
        logger.error('saveScannedVideos error: ' + e.message);
      }
    }
  },

  getScannedVideos: async (category, mixType, limit) => {
    let sql = 'SELECT * FROM scanned_videos WHERE 1=1';
    const params = [];
    if (category) { params.push(category); sql += ` AND category = $${params.length}`; }
    if (mixType) { params.push(mixType); sql += ` AND mix_type = $${params.length}`; }
    params.push(limit || 240);
    sql += ` ORDER BY score DESC, scanned_at DESC LIMIT $${params.length}`;
    return all(sql, params);
  },

  // ── SYSTEM STATS ──────────────────────────────────────────
  getStat: async (key) => {
    const row = await get('SELECT value FROM system_stats WHERE key = $1', [key]);
    return row ? row.value : null;
  },

  setStat: async (key, value) => {
    await run(
      'INSERT INTO system_stats (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
      [key, value]
    );
  },

  // ── DASHBOARD STATS ───────────────────────────────────────
  getDashboardStats: async () => {
    const totalScanned = await get('SELECT COUNT(*) as cnt FROM scanned_videos');
    const totalSelected = await get('SELECT COUNT(*) as cnt FROM video_queue');
    const publishedToday = await get(
      "SELECT COUNT(*) as cnt FROM published_videos WHERE published_at::date = CURRENT_DATE"
    );
    const strikes = await get(
      "SELECT COUNT(*) as cnt FROM accounts WHERE status = 'strike'"
    );
    return {
      totalScanned: totalScanned ? parseInt(totalScanned.cnt) : 0,
      totalSelected: totalSelected ? parseInt(totalSelected.cnt) : 0,
      publishedToday: publishedToday ? parseInt(publishedToday.cnt) : 0,
      activeStrikes: strikes ? parseInt(strikes.cnt) : 0,
    };
  },

  // ── CHANNEL BLACKLIST ─────────────────────────────────────
  isChannelBlacklisted: async (channel) => {
    if (!channel) return false;
    const row = await get('SELECT channel FROM channel_blacklist WHERE channel = $1', [channel]);
    return !!row;
  },

  recordChannelRejection: async (channel, reason) => {
    if (!channel) return;
    await run(
      `INSERT INTO channel_blacklist (channel, reason, rejected_count, first_rejected_at, last_rejected_at)
       VALUES ($1, $2, 1, NOW(), NOW())
       ON CONFLICT (channel) DO UPDATE SET
         rejected_count = channel_blacklist.rejected_count + 1,
         last_rejected_at = NOW()`,
      [channel, reason]
    );
  },

  getBlacklistedChannels: async () => {
    return all('SELECT * FROM channel_blacklist ORDER BY last_rejected_at DESC');
  },

  // ── RAW ACCESS ────────────────────────────────────────────
  run,
  get,
  all,
};

module.exports = { initDb, dbHelpers, pool };
