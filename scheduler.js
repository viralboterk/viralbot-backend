const cron = require('node-cron');
const { dbHelpers, initDb } = require('./database');
const { scanAllCategories } = require('./youtube-scanner');
const { downloadAndUploadToR2, deleteFromR2 } = require('./video-downloader');
const { generateContent } = require('./ai-editor');
const { uploadVideoToR2, deleteFromR2 } = require('./r2-storage');
const { publishVideo } = require('./tiktok-publisher');
const logger = require('./logger');

// Random delay between 0 and 120 seconds
function randomDelay() {
  return new Promise(r => setTimeout(r, Math.random() * 120000));
}


// Refresh TikTok token if needed before publishing
async function ensureValidToken(account) {
  if (!account.refresh_token) return account;
  try {
    const { refreshToken } = require('./tiktok-publisher');
    const newTokenData = await refreshToken(account.refresh_token);
    if (newTokenData && newTokenData.access_token) {
      dbHelpers.run(
        "UPDATE accounts SET access_token = ?, refresh_token = ?, status = 'active' WHERE handle = ?",
        [newTokenData.access_token, newTokenData.refresh_token || account.refresh_token, account.handle]
      );
      account.access_token = newTokenData.access_token;
      logger.info('Token refreshed for ' + account.handle);
    }
  } catch(e) {
    logger.error('Token refresh error for ' + account.handle + ': ' + e.message);
  }
  return account;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Build daily queue for all accounts
async function buildDailyQueue(scanResults) {
  logger.info('Building daily queue for all accounts');
  const accounts = dbHelpers.getAllActiveAccounts();

  for (const account of accounts) {
    if (!account.category) {
      logger.warn(`Account ${account.handle} has no category assigned — skipping`);
      continue;
    }

    const catVideos = scanResults[account.category];
    if (!catVideos) continue;

    const allVideos = [
      ...catVideos.recent.map(v => ({ ...v, mixType: 'recent' })),
      ...catVideos.evergreen.map(v => ({ ...v, mixType: 'evergreen' })),
    ];

    // Filter out already published
    const newVideos = allVideos.filter(v => !dbHelpers.isPublished(v.id, account.handle));

    // Take up to 48
    const selected = newVideos.slice(0, 48);
    logger.info(`Account ${account.handle} [${account.category}]: ${selected.length} videos queued`);

    // Schedule — 1 video every 20 minutes
    // Start from NOW or 06:00, whichever is later
    let scheduleTime = new Date();
    const startOfDay = new Date();
    startOfDay.setHours(6, 0, 0, 0);
    if (scheduleTime < startOfDay) scheduleTime = startOfDay;
    // Round up to next 20-min slot
    const minutes = scheduleTime.getMinutes();
    const nextSlot = Math.ceil(minutes / 20) * 20;
    scheduleTime.setMinutes(nextSlot, 0, 0);

    for (let i = 0; i < selected.length; i++) {
      const video = selected[i];

      // Generate AI content
      const aiContent = await generateContent(video, account.category);
      const randomSeconds = Math.floor(Math.random() * 120); // 0-120s random offset
      const scheduledAt = new Date(scheduleTime.getTime() + randomSeconds * 1000);

      dbHelpers.addToQueue({
        videoId: video.id,
        accountId: account.handle,
        category: account.category,
        mixType: video.mixType,
        title: aiContent.titre,
        description: aiContent.description + '\n\n' + aiContent.hashtags.map(t => '#' + t).join(' '),
        tags: JSON.stringify(aiContent.hashtags),
        r2Url: null, // Will be filled during publish
        scheduledAt: scheduledAt.toISOString(),
      });

      scheduleTime = new Date(scheduleTime.getTime() + 20 * 60 * 1000); // +20 min
      if (scheduleTime.getHours() >= 22) break; // Stop at 22:00
    }
  }
  logger.info('Daily queue built successfully');
}

// Process queue — publish due videos
async function processQueue() {
  const now = new Date();
  const hour = now.getHours();

  // Only publish between 06:00 and 22:00
  if (hour < 6 || hour >= 22) return;

  const accounts = dbHelpers.getAllActiveAccounts();

  for (const account of accounts) {
    const queue = dbHelpers.getPendingQueue(account.handle);
    const dueItems = queue.filter(item => new Date(item.scheduled_at) <= now);

    for (const item of dueItems.slice(0, 2)) { // Max 2 per cycle per account
      try {
        logger.info('Publishing to ' + account.handle + ': ' + item.title);
        account = await ensureValidToken(account);

        // Check daily limit (48 max)
        const todayCount = dbHelpers.getTodayCount(account.handle);
        if (todayCount >= 48) {
          logger.warn(`${account.handle} reached daily limit (48)`);
          break;
        }

        // Step 1: Download YouTube video and upload to R2
        logger.info('Downloading video ' + item.video_id + ' for ' + account.handle);
        const r2Url = await downloadAndUploadToR2(item.video_id, item.category);
        
        if (!r2Url) {
          logger.error('Could not get R2 URL for ' + item.video_id + ' — skipping');
          dbHelpers.markQueueDone(item.id, 'failed');
          continue;
        }

        // Update queue item with R2 URL
        dbHelpers.run('UPDATE video_queue SET r2_url = ? WHERE id = ?', [r2Url, item.id]);

        // Step 2: Publish to TikTok with real R2 URL
        const result = await publishVideo(account, {
          titre: item.title,
          description: item.description,
          r2Url: r2Url,
        });

        if (result.success) {
          dbHelpers.markPublished(item.video_id, account.handle, item.category, item.title);
          dbHelpers.markQueueDone(item.id, 'published');
          // Clean up R2 after successful publish
          const r2Key = 'videos/' + item.category + '/' + item.video_id + '.mp4';
          setTimeout(() => deleteFromR2(r2Key), 60000); // Delete after 1 min
          logger.info('✅ Published: ' + item.title + ' → ' + account.handle);
        } else {
          dbHelpers.markQueueDone(item.id, 'failed');
          logger.error('❌ Failed: ' + item.title + ' → ' + account.handle);
        }

      } catch (err) {
        logger.error(`Queue processing error: ${err.message}`);
        dbHelpers.markQueueDone(item.id, 'error');
      }
    }
  }
}

// Initialize all cron jobs
function initScheduler() {
  // Daily scan at 05:00 UTC (07:00 Paris été / 06:00 Paris hiver)
  cron.schedule('0 5 * * *', async () => {
    logger.info('=== DAILY SCAN STARTED ===');
    try {
      const results = await scanAllCategories();
      await buildDailyQueue(results);
      logger.info('=== DAILY SCAN COMPLETE ===');
    } catch (err) {
      logger.error(`Daily scan error: ${err.message}`);
    }
  });

  // Process queue every 5 minutes (06:00–22:00)
  cron.schedule('*/5 6-21 * * *', async () => {
    // If queue is empty, trigger a scan
    const pendingCount = dbHelpers.all("SELECT COUNT(*) as cnt FROM video_queue WHERE status = 'pending'")[0];
    if (pendingCount && pendingCount.cnt === 0) {
      logger.info('Queue empty — triggering automatic scan');
      try {
        const results = await scanAllCategories();
        await buildDailyQueue(results);
      } catch(e) {
        logger.error('Auto-scan error: ' + e.message);
      }
    }
    await processQueue();
  });

  // Strike monitoring every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    const accounts = dbHelpers.getAllActiveAccounts();
    for (const acc of accounts) {
      if (acc.status === 'strike') {
        logger.warn(`⚠️ STRIKE DETECTED on ${acc.handle} — suspended`);
      }
    }
  });

  // Token refresh daily at 04:00
  cron.schedule('0 4 * * *', async () => {
    logger.info('Refreshing TikTok tokens');
    // Token refresh logic handled in tiktok-publisher
  });

  logger.info('✅ Scheduler initialized — all cron jobs active');
}

module.exports = { initScheduler, buildDailyQueue, scanAllCategories };
