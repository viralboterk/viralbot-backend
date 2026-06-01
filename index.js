require('dotenv').config();
const express = require('express');
const path = require('path');
const { initDb, dbHelpers } = require('./database');
const { initScheduler } = require('./scheduler');
const { scanAllCategories } = require('./youtube-scanner');
const { getOAuthUrl, exchangeCodeForToken, getAccountInfo } = require('./tiktok-publisher');
const logger = require('./logger');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve dashboard from public folder
app.use(express.static(path.join(__dirname, 'public')));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// =====================
// API ROUTES
// =====================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});

// Dashboard stats
app.get('/api/stats', (req, res) => {
  try {
    const stats = dbHelpers.getDashboardStats();
    const accounts = dbHelpers.all('SELECT * FROM accounts');
    const recentLogs = dbHelpers.all('SELECT * FROM scan_log ORDER BY scanned_at DESC LIMIT 10');
    const recentPublished = dbHelpers.all('SELECT * FROM published_videos ORDER BY published_at DESC LIMIT 20');
    res.json({ stats, accounts, recentLogs, recentPublished, uptime: process.uptime() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all accounts
app.get('/api/accounts', (req, res) => {
  try {
    const accounts = dbHelpers.all('SELECT * FROM accounts');
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add account
app.post('/api/accounts', (req, res) => {
  const { handle, category } = req.body;
  if (!handle) return res.status(400).json({ error: 'handle required' });
  try {
    dbHelpers.run('INSERT OR IGNORE INTO accounts (handle, category) VALUES (?, ?)', [handle, category || null]);
    if (category) dbHelpers.run('UPDATE accounts SET category = ? WHERE handle = ?', [category, handle]);
    logger.info('Account added: ' + handle);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete account
app.delete('/api/accounts/:handle', (req, res) => {
  const handle = req.params.handle;
  try {
    dbHelpers.run('DELETE FROM accounts WHERE handle = ?', [handle]);
    dbHelpers.run('DELETE FROM video_queue WHERE account_id = ?', [handle]);
    logger.info('Account deleted: ' + handle);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assign category to account
app.put('/api/accounts/:handle/category', (req, res) => {
  const handle = req.params.handle;
  const { category } = req.body;
  try {
    dbHelpers.run('UPDATE accounts SET category = ? WHERE handle = ?', [category, handle]);
    logger.info('Category "' + category + '" assigned to ' + handle);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update account status
app.put('/api/accounts/:handle/status', (req, res) => {
  const handle = req.params.handle;
  const { status } = req.body;
  try {
    dbHelpers.run('UPDATE accounts SET status = ? WHERE handle = ?', [status, handle]);
    logger.info('Account ' + handle + ' status: ' + status);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TikTok OAuth — get connect URL
app.get('/api/tiktok/connect/:handle', (req, res) => {
  const handle = req.params.handle;
  const oauthUrl = getOAuthUrl(handle);
  res.json({ url: oauthUrl });
});

// TikTok OAuth callback
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  const handle = req.query.state;
  const error = req.query.error;

  if (error) return res.send('<h2>Erreur TikTok : ' + error + '</h2>');
  if (!code || !handle) return res.send('<h2>Parametres manquants</h2>');

  try {
    const redirectUri = (process.env.APP_URL || 'http://localhost:3000') + '/callback';
    const tokenData = await exchangeCodeForToken(code, redirectUri);
    if (!tokenData || !tokenData.access_token) return res.send('<h2>Echec echange token</h2>');

    dbHelpers.run(
      "INSERT OR REPLACE INTO accounts (handle, access_token, refresh_token, status) VALUES (?, ?, ?, 'active')",
      [handle, tokenData.access_token, tokenData.refresh_token]
    );
    logger.info('TikTok account connected: ' + handle);
    res.send([
      '<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f7f5ff">',
      '<h1 style="color:#7c3aed">Compte connecte !</h1>',
      '<p><strong>' + handle + '</strong> est maintenant lie a ViralBot.</p>',
      '<p style="color:#6b5fa0">Tu peux fermer cette fenetre.</p>',
      '</body></html>'
    ].join(''));
  } catch (err) {
    logger.error('OAuth callback error: ' + err.message);
    res.send('<h2>Erreur : ' + err.message + '</h2>');
  }
});

// Manual scan
app.post('/api/scan', async (req, res) => {
  res.json({ success: true, message: 'Scan lance en arriere-plan' });
  try {
    logger.info('Manual scan triggered');
    const results = await scanAllCategories();
    const { buildDailyQueue } = require('./scheduler');
    await buildDailyQueue(results);
    logger.info('Manual scan complete');
  } catch (err) {
    logger.error('Manual scan error: ' + err.message);
  }
});

// Get queue
app.get('/api/queue', (req, res) => {
  try {
    const queue = dbHelpers.all('SELECT * FROM video_queue ORDER BY scheduled_at ASC LIMIT 100');
    res.json(queue);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get scan logs
app.get('/api/logs', (req, res) => {
  try {
    const logs = dbHelpers.all('SELECT * FROM scan_log ORDER BY scanned_at DESC LIMIT 50');
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// System info
app.get('/api/system', (req, res) => {
  res.json({
    version: '1.0.0',
    phase: 'Phase 1 — YouTube uniquement',
    uptime: Math.floor(process.uptime()),
    lastScan: dbHelpers.getStat('last_scan'),
    categories: ['movies', 'stream', 'sports', 'divert', 'others'],
    schedule: '06:00 -> 22:00 - 1 video / 20 min - 48/jour/compte',
  });
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await initDb();
    logger.info('Database initialized');

    app.listen(PORT, () => {
      logger.info('ViralBot server running on port ' + PORT);
      logger.info('Dashboard available at http://localhost:' + PORT);
      logger.info('Phase 1 — YouTube uniquement');

      initScheduler();

      setTimeout(async () => {
        logger.info('Running initial scan...');
        try {
          const results = await scanAllCategories();
          const { buildDailyQueue } = require('./scheduler');
          await buildDailyQueue(results);
        } catch (err) {
          logger.error('Initial scan error: ' + err.message);
        }
      }, 5000);
    });
  } catch (err) {
    logger.error('Startup error: ' + err.message);
    process.exit(1);
  }
}

start();
module.exports = app;
