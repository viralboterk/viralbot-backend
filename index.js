require('dotenv').config();
const express = require('express');
const path = require('path');
const { initDb, dbHelpers } = require('./database');
const { initScheduler } = require('./scheduler');
const { scanAllCategories } = require('./youtube-scanner');
const { getOAuthUrl, exchangeCodeForToken } = require('./tiktok-publisher');
const logger = require('./logger');
const { isWithinCurrentQuotaWindow } = require('./quota-window');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
app.get('/.well-known/tiktok-site-verification', async (req, res) => {
  res.send('tiktok-developers-site-verification=VYFb5YJKJVo8yY0IOW4rhPFZqFw5QZBk');
});



// Terms and Privacy pages
app.get('/terms', async (req, res) => {
  res.type('text/html').send(`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>ViralBot — Terms of Service</title>
<style>body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:20px;color:#1a1035}h1{color:#7c3aed}</style>
</head>
<body>
<h1>Terms of Service — ViralBot</h1>
<p>Last updated: June 2025</p>
<h2>1. Acceptance</h2>
<p>By using ViralBot, you agree to these terms. ViralBot is an automated content management tool that identifies viral YouTube Shorts and republishes them on TikTok creator accounts for entertainment purposes.</p>
<h2>2. Use of Service</h2>
<p>ViralBot is intended for use by content creators who own and manage TikTok accounts. You are responsible for ensuring that all content published complies with TikTok's Community Guidelines and Terms of Service.</p>
<h2>3. Content</h2>
<p>ViralBot only republishes publicly available content from YouTube. We respect intellectual property rights and remove content upon valid copyright claims.</p>
<h2>4. Limitation of Liability</h2>
<p>ViralBot is provided as-is without warranties. We are not liable for any damages arising from the use of this service.</p>
<h2>5. Contact</h2>
<p>For any questions: kamel.elrhazi@gmail.com</p>
</body></html>`);
});

app.get('/privacy', async (req, res) => {
  res.type('text/html').send(`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>ViralBot — Privacy Policy</title>
<style>body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:20px;color:#1a1035}h1{color:#7c3aed}</style>
</head>
<body>
<h1>Privacy Policy — ViralBot</h1>
<p>Last updated: June 2025</p>
<h2>1. Data We Collect</h2>
<p>ViralBot collects only the TikTok account handles and OAuth tokens necessary to publish content on your behalf. We do not collect personal data from TikTok viewers or end users.</p>
<h2>2. How We Use Data</h2>
<p>TikTok account credentials are stored securely and used exclusively to publish automated content. They are never shared with third parties.</p>
<h2>3. Data Security</h2>
<p>All data is stored securely on Railway servers. We comply with GDPR regulations and applicable data protection laws.</p>
<h2>4. Third Party Services</h2>
<p>ViralBot uses the TikTok API and YouTube Data API. Please refer to their respective privacy policies for information on how they handle data.</p>
<h2>5. Contact</h2>
<p>For privacy concerns: kamel.elrhazi@gmail.com</p>
</body></html>`);
});


// Disable caching for all API routes
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});

// =====================
// TIKTOK DOMAIN VERIFICATION
// =====================
app.get('/tiktok-site-verification', async (req, res) => {
  res.type('text/plain').send('tiktok-developers-site-verification=eM7Hxpz9Fu27SQUseqTtmmoJipyslPko');
});
app.get('/tiktok-site-verification.txt', async (req, res) => {
  res.type('text/plain').send('tiktok-developers-site-verification=eM7Hxpz9Fu27SQUseqTtmmoJipyslPko');
});
app.get('/.well-known/tiktok-site-verification', async (req, res) => {
  res.type('text/plain').send('tiktok-developers-site-verification=eM7Hxpz9Fu27SQUseqTtmmoJipyslPko');
});
app.get('/.well-known/tiktok-site-verification.txt', async (req, res) => {
  res.type('text/plain').send('tiktok-developers-site-verification=eM7Hxpz9Fu27SQUseqTtmmoJipyslPko');
});



// =====================
// TIKTOK DOMAIN VERIFICATION — 3 URLs
// =====================

// 1. Web/Desktop URL: https://viralbot-backend-production.up.railway.app
// TikTok checks: /tiktokeM7Hxpz9Fu27SQUseqTtmmoJipyslPko.txt
app.get('/tiktokeM7Hxpz9Fu27SQUseqTtmmoJipyslPko.txt', async (req, res) => {
  res.type('text/plain').send('tiktok-developers-site-verification=eM7Hxpz9Fu27SQUseqTtmmoJipyslPko');
});

// 2. Terms URL: https://viralbot-backend-production.up.railway.app/terms
// TikTok checks: /terms/tiktoktVSrL4owGEeF5xkkuwe3L9NGt6wwG57o.txt
app.get('/terms/tiktoktVSrL4owGEeF5xkkuwe3L9NGt6wwG57o.txt', async (req, res) => {
  res.type('text/plain').send('tiktok-developers-site-verification=tVSrL4owGEeF5xkkuwe3L9NGt6wwG57o');
});

// 3. Privacy URL: https://viralbot-backend-production.up.railway.app/privacy
// TikTok checks: /privacy/tiktokHPEyP82J2tRXQBfFlktcfNVOs0tCWX64.txt
app.get('/privacy/tiktoktHPEyP82J2tRXQBfFlktcfNVOs0tCWX64.txt', async (req, res) => {
  res.type('text/plain').send('tiktok-developers-site-verification=HPEyP82J2tRXQBfFlktcfNVOs0tCWX64');
});

// =====================
// API ROUTES
// =====================

app.get('/tiktok-developers-site-verification.txt', async (req, res) => {
  res.type('text/plain').send('tiktok-developers-site-verification=eM7Hxpz9Fu27SQUseqTtmmoJipyslPko');
});

app.get('/health', async (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await dbHelpers.getDashboardStats();
    const accounts = await dbHelpers.all('SELECT * FROM accounts');
    const recentLogs = await dbHelpers.all('SELECT * FROM scan_log ORDER BY scanned_at DESC LIMIT 10');
    const recentPublished = await dbHelpers.all('SELECT * FROM published_videos ORDER BY published_at DESC LIMIT 20');
    res.json({ stats, accounts, recentLogs, recentPublished, uptime: process.uptime() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/accounts', async (req, res) => {
  try {
    const accounts = await dbHelpers.all('SELECT * FROM accounts');
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts', async (req, res) => {
  const { handle, category } = req.body;
  if (!handle) return res.status(400).json({ error: 'handle required' });
  try {
    await dbHelpers.run('INSERT INTO accounts (handle, category) VALUES ($1, $2) ON CONFLICT (handle) DO NOTHING', [handle, category || null]);
    if (category) await dbHelpers.run('UPDATE accounts SET category = $1 WHERE handle = $2', [category, handle]);
    logger.info('Account added: ' + handle);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:handle', async (req, res) => {
  const handle = req.params.handle;
  try {
    await dbHelpers.run('DELETE FROM accounts WHERE handle = $1', [handle]);
    await dbHelpers.run('DELETE FROM video_queue WHERE account_id = $1', [handle]);
    logger.info('Account deleted: ' + handle);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/accounts/:handle/category', async (req, res) => {
  const handle = req.params.handle;
  const { category } = req.body;
  try {
    await dbHelpers.run('UPDATE accounts SET category = $1 WHERE handle = $2', [category, handle]);
    logger.info('Category assigned to ' + handle + ': ' + category);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/accounts/:handle/status', async (req, res) => {
  const handle = req.params.handle;
  const { status } = req.body;
  try {
    await dbHelpers.run('UPDATE accounts SET status = $1 WHERE handle = $2', [status, handle]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tiktok/connect/:handle', async (req, res) => {
  const handle = req.params.handle;
  const oauthUrl = getOAuthUrl(handle);
  res.json({ url: oauthUrl });
});

app.get('/callback/')
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  const handle = req.query.state;
  const error = req.query.error;
  if (error) return res.send('<h2>Erreur TikTok : ' + error + '</h2>');
  if (!code || !handle) return res.send('<h2>Parametres manquants</h2>');
  try {
    const redirectUri = (process.env.APP_URL || 'https://viralbot-backend-production.up.railway.app') + '/callback';
    const tokenData = await exchangeCodeForToken(code, redirectUri);
    if (!tokenData || !tokenData.access_token) return res.send('<h2>Echec echange token</h2>');
    await dbHelpers.run(
      "INSERT INTO accounts (handle, access_token, refresh_token, status) VALUES ($1, $2, $3, 'active') ON CONFLICT (handle) DO UPDATE SET access_token = $2, refresh_token = $3, status = 'active'",
      [handle, tokenData.access_token, tokenData.refresh_token]
    );
    logger.info('TikTok account connected: ' + handle);
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f7f5ff"><h1 style="color:#7c3aed">Compte connecte !</h1><p><strong>' + handle + '</strong> est maintenant lie a ViralBot.</p><p>Tu peux fermer cette fenetre.</p></body></html>');
  } catch (err) {
    res.send('<h2>Erreur : ' + err.message + '</h2>');
  }
});

app.post('/api/scan', async (req, res) => {
  res.json({ success: true, message: 'Scan lance' });
  try {
    const results = await scanAllCategories();
    const { buildDailyQueue } = require('./scheduler');
    await buildDailyQueue(results);
    logger.info('Scan complete');
  } catch (err) {
    logger.error('Scan error: ' + err.message);
  }
});

app.get('/api/queue', async (req, res) => {
  try {
    res.json(await dbHelpers.all('SELECT * FROM video_queue ORDER BY scheduled_at ASC LIMIT 100'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    res.json(await dbHelpers.all('SELECT * FROM scan_log ORDER BY scanned_at DESC LIMIT 50'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:handle', async (req, res) => {
  const handle = req.params.handle;
  try {
    await dbHelpers.run('DELETE FROM accounts WHERE handle = $1', [handle]);
    await dbHelpers.run('DELETE FROM video_queue WHERE account_id = $1', [handle]);
    logger.info('Account deleted: ' + handle);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Delete account
app.delete(`/api/accounts/:handle`, async (req, res) => {
  const handle = req.params.handle;
  try {
    await dbHelpers.run(`DELETE FROM accounts WHERE handle = $1`, [handle]);
    await dbHelpers.run(`DELETE FROM video_queue WHERE account_id = $1`, [handle]);
    logger.info(`Account deleted: ` + handle);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Get videos for Top 48 display (from scanned_videos table)
app.get('/api/videos', async (req, res) => {
  try {
    const category = req.query.category || null;
    const mixType = req.query.mix || null;
    const videos = await dbHelpers.getScannedVideos(category, mixType, 240);
    res.json(videos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/system', async (req, res) => {
  res.json({
    version: '1.0.0',
    phase: 'Phase 1 — YouTube uniquement',
    uptime: Math.floor(process.uptime()),
    lastScan: await dbHelpers.getStat('last_scan'),
    categories: ['movies', 'stream', 'sports', 'divert', 'others'],
    schedule: '06:00 -> 22:00 - 1 video / 20 min - 48/jour/compte',
  });
});


// IA generation route for dashboard manual use
app.post('/api/generate', async (req, res) => {
  try {
    const { videoId, title, category, language, tone } = req.body;
    if (!videoId || !category) {
      return res.status(400).json({ error: 'videoId and category required' });
    }
    const { generateContent } = require('./ai-editor');
    const video = { id: videoId, title: title || '', lang: language || 'EN' };
    const content = await generateContent(video, category, tone);
    if (!content) {
      return res.status(500).json({ error: 'AI generation failed' });
    }
    res.json({
      success: true,
      titre: content.titre,
      description: content.description,
      hashtags: content.hashtags,
    });
  } catch (err) {
    logger.error('Generate route error: ' + err.message);
    res.status(500).json({ error: err.message });
  }
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
      logger.info('Dashboard: https://viralbot-backend-production.up.railway.app');
      logger.info('TikTok verification: https://viralbot-backend-production.up.railway.app/tiktok-site-verification');
      initScheduler();
      // Only scan if not already done today — avoids wasting YouTube quota on restarts
      setTimeout(async () => {
        try {
          const { isQuotaAvailable, markQuotaExhausted } = require('./scheduler');
          const lastScan = await dbHelpers.getStat('last_scan');
          if (isWithinCurrentQuotaWindow(lastScan)) {
            logger.info('Initial scan skipped — a scan already ran in the current quota window (last: ' + lastScan + ')');
            return;
          }
          if (!(await isQuotaAvailable())) {
            logger.info('Initial scan skipped — quota marked exhausted for the current window');
            return;
          }
          logger.info('Running initial scan...');
          const results = await scanAllCategories();
          const categoryKeys = Object.keys(results).filter(k => !k.startsWith('_'));
          const allEmpty = categoryKeys.every(k => {
            const r = results[k];
            return (!r.recent || r.recent.length === 0) && (!r.evergreen || r.evergreen.length === 0);
          });
          if (results._quotaExceeded || allEmpty) {
            await markQuotaExhausted();
          }
          if (!allEmpty) {
            const { buildDailyQueue } = require('./scheduler');
            await buildDailyQueue(results);
            await dbHelpers.run(
              "INSERT INTO system_stats (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()",
              ['last_scan', new Date().toISOString()]
            );
          }
          logger.info('Initial scan complete');
        } catch (err) {
          logger.error('Initial scan error: ' + err.message);
        }
      }, 5000);
    });
  } catch (err) {
    logger.error('Startup error: ' + (err.message || JSON.stringify(err) || String(err)));
    logger.error('Full error: ' + JSON.stringify(err, Object.getOwnPropertyNames(err)));
    process.exit(1);
  }
}

start();
module.exports = app;
