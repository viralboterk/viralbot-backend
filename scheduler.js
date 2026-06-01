const cron = require('node-cron');
const { dbHelpers, initDb } = require('./database');
const { scanAllCategories } = require('./youtube-scanner');
const { generateContent } = require('./ai-editor');
const { uploadVideoToR2, deleteFromR2 } = require('./r2-storage');
const { publishVideo } = require('./tiktok-publisher');
const logger = require('./logger');

// Random delay between 0 and 120 seconds
function randomDelay() {
  return new Promise(r => setTimeout(r, Math.random() * 120000));
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

    // Schedule — 1 video every 20 minutes from 06:00 to 22:00
    let scheduleTime = new Date();
    scheduleTime.setHours(6, 0, 0, 0);

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
        logger.info(`Publishing to ${account.handle}: ${item.title}`);

        // Check daily limit (48 max)
        const todayCount = dbHelpers.getTodayCount(account.handle);
        if (todayCount >= 48) {
          logger.warn(`${account.handle} reached daily limit (48)`);
          break;
        }

        // Get YouTube video download URL (via youtube-dl or similar)
        // In production this would use a video downloader
        // For now we use the YouTube thumbnail URL as placeholder
        const videoUrl = `https://www.youtube.com/watch?v=${item.video_id}`;

        // Upload to R2 (in production, download then upload)
        // const r2Url = await uploadVideoToR2(videoUrl, item.video_id, item.category);

        // Publish to TikTok
        const result = await publishVideo(account, {
          titre: item.title,
          description: item.description,
          r2Url: item.r2_url || videoUrl,
        });

        if (result.success) {
          dbHelpers.markPublished(item.video_id, account.handle, item.category, item.title);
          dbHelpers.markQueueDone(item.id, 'published');
          // if (item.r2_url) await deleteFromR2(item.r2_url);
          logger.info(`✅ Published: ${item.title} → ${account.handle}`);
        } else {
          dbHelpers.markQueueDone(item.id, 'failed');
          logger.error(`❌ Failed: ${item.title} → ${account.handle}`);
        }

        // Random delay between publications (3-8 minutes)
        await sleep(Math.random() * 300000 + 180000);

      } catch (err) {
        logger.error(`Queue processing error: ${err.message}`);
        dbHelpers.markQueueDone(item.id, 'error');
      }
    }
  }
}

// Initialize all cron jobs
function initScheduler() {
  // Daily scan at 05:00 — build queue for the day
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
