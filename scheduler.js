const cron = require('node-cron');
const { dbHelpers, initDb } = require('./database');
const { scanAllCategories } = require('./youtube-scanner');
const { downloadAndUploadToR2, deleteFromR2 } = require('./video-downloader');
const { generateContent } = require('./ai-editor');
const { publishVideo } = require('./tiktok-publisher');
const logger = require('./logger');
const { lastQuotaReset, nextQuotaReset, isWithinCurrentQuotaWindow } = require('./quota-window');

// Random delay between 0 and 120 seconds
function randomDelay() {
  return new Promise(r => setTimeout(r, Math.random() * 120000));
}


// Refresh TikTok token if needed before publishing

// Track quota exhaustion — persisted in DB to survive restarts.
// FIX (solution 6): the YouTube quota actually resets at midnight Pacific Time
// (07:00 or 08:00 UTC depending on DST), not at the next UTC midnight. The old
// code used `setUTCHours(24,0,0,0)`, which could overshoot the real reset by up
// to ~19 hours — meaning the bot would needlessly sit idle long after the quota
// had already refilled.
async function markQuotaExhausted() {
  const resetAt = nextQuotaReset();
  await dbHelpers.run(
    "INSERT INTO system_stats (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()",
    ['quota_exhausted_until', resetAt.toISOString()]
  );
  logger.warn('YouTube quota exhausted — scans paused until ' + resetAt.toISOString());
}

async function isQuotaAvailable() {
  try {
    const val = await dbHelpers.getStat('quota_exhausted_until');
    if (!val) return true;
    const resetTime = new Date(val);
    if (new Date() > resetTime) {
      // Quota reset — clear the flag
      await dbHelpers.run("DELETE FROM system_stats WHERE key = 'quota_exhausted_until'");
      logger.info('YouTube quota reset — scans resuming');
      return true;
    }
    return false;
  } catch(e) {
    return true; // If DB error, allow scan
  }
}

async function ensureValidToken(account) {
  if (!account.refresh_token) return account;
  try {
    const { refreshToken } = require('./tiktok-publisher');
    const newTokenData = await refreshToken(account.refresh_token);
    if (newTokenData && newTokenData.access_token) {
      await dbHelpers.run(
        "UPDATE accounts SET access_token = $1, refresh_token = $2, status = 'active' WHERE handle = $3",
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
  const accounts = await dbHelpers.getAllActiveAccounts();

  for (let account of accounts) {
    if (!account.category) {
      logger.warn(`Account ${account.handle} has no category assigned — skipping`);
      continue;
    }

    const catVideos = scanResults[account.category];
    if (!catVideos) continue;

    const recentVideos = Array.isArray(catVideos.recent) ? catVideos.recent : [];
    const evergreenVideos = Array.isArray(catVideos.evergreen) ? catVideos.evergreen : [];
    const allVideos = [
      ...recentVideos.map(v => ({ ...v, mixType: 'recent' })),
      ...evergreenVideos.map(v => ({ ...v, mixType: 'evergreen' })),
    ];

    // Filter out already published
    // Check published status async before filtering
    const publishedChecks = await Promise.all(
      allVideos.map(v => dbHelpers.isPublished(v.id, account.handle))
    );
    const newVideos = allVideos.filter((v, i) => !publishedChecks[i]);

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

      // Generate AI content with fallback
      let aiContent;
      try {
        aiContent = await generateContent(video, account.category);
      } catch(aiErr) {
        logger.warn('AI generation failed for ' + video.id + ' — using original title');
        aiContent = {
          titre: video.title || 'Video viral',
          description: video.title || 'Video viral',
          hashtags: ['viral', 'shorts', account.category]
        };
      }
      if (!aiContent || !aiContent.titre) {
        aiContent = {
          titre: video.title || 'Video viral',
          description: video.title || 'Video viral',
          hashtags: ['viral', 'shorts', account.category]
        };
      }
      const randomSeconds = Math.floor(Math.random() * 120); // 0-120s random offset
      const scheduledAt = new Date(scheduleTime.getTime() + randomSeconds * 1000);

      await dbHelpers.addToQueue({
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

// Process queue — publish due videos.
// Guarded against overlapping runs: with up to 2 items per account per cycle at
// a 240s worst-case timeout each, a single run could in theory exceed the 5-minute
// cron interval. Without this guard, node-cron would happily start a second
// concurrent run on top of one still in progress.
let isProcessingQueue = false;
async function processQueue() {
  if (isProcessingQueue) {
    logger.info('processQueue skipped — previous run still in progress');
    return;
  }
  isProcessingQueue = true;
  try {
    await processQueueInner();
  } finally {
    isProcessingQueue = false;
  }
}

async function processQueueInner() {
  const now = new Date();
  const hour = now.getHours();

  // Only publish between 06:00 and 22:00
  if (hour < 6 || hour >= 22) return;

  const accounts = await dbHelpers.getAllActiveAccounts();

  for (let account of accounts) {
    const queue = await dbHelpers.getPendingQueue(account.handle);
    const dueItems = queue.filter(item => new Date(item.scheduled_at) <= now);

    for (const item of dueItems.slice(0, 2)) { // Max 2 per cycle per account
      try {
        logger.info('Publishing to ' + account.handle + ': ' + item.title);
        account = await ensureValidToken(account);

        // Check daily limit (48 max)
        const todayCount = await dbHelpers.getTodayCount(account.handle);
        if (todayCount >= 48) {
          logger.warn(`${account.handle} reached daily limit (48)`);
          break;
        }

        // Step 1: Download YouTube video and upload to R2 (with 3min timeout)
        logger.info('Downloading video ' + item.video_id + ' for ' + account.handle);
        let r2Url = null;
        // Budget: video-downloader.js tries up to 3 Cobalt negotiation methods
        // (15s each) + 1 download (60s) per cycle = 105s worst case, and retries
        // the whole cycle once on an empty result = up to 210s. 240s leaves a
        // 30s margin above that worst case instead of cutting it off mid-retry.
        try {
          const downloadPromise = downloadAndUploadToR2(item.video_id, item.category);
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Download timeout')), 240000));
          r2Url = await Promise.race([downloadPromise, timeoutPromise]);
        } catch(downloadErr) {
          logger.error('Download error for ' + item.video_id + ': ' + downloadErr.message);
        }
        if (!r2Url) {
          logger.error('Could not get R2 URL for ' + item.video_id + ' — skipping');
          await dbHelpers.markQueueDone(item.id, 'failed');
          continue;
        }

        // Update queue item with R2 URL
        await dbHelpers.run('UPDATE video_queue SET r2_url = $1 WHERE id = $2', [r2Url, item.id]);

        // Step 2: Publish to TikTok with real R2 URL
        const result = await publishVideo(account, {
          titre: item.title,
          description: item.description,
          r2Url: r2Url,
        });

        if (result.success) {
          await dbHelpers.markPublished(item.video_id, account.handle, item.category, item.title);
          await dbHelpers.markQueueDone(item.id, 'published');
          // Clean up R2 after successful publish
          const r2Key = 'videos/' + item.category + '/' + item.video_id + '.mp4';
          setTimeout(() => deleteFromR2(r2Key), 60000); // Delete after 1 min
          logger.info('✅ Published: ' + item.title + ' → ' + account.handle);
        } else {
          await dbHelpers.markQueueDone(item.id, 'failed');
          logger.error('❌ Failed: ' + item.title + ' → ' + account.handle);
        }

      } catch (err) {
        logger.error(`Queue processing error: ${err.message}`);
        await dbHelpers.markQueueDone(item.id, 'error');
      }
    }
  }
}

// Initialize all cron jobs
function initScheduler() {
  // Shared lock: the daily-scan cron below (08:15 UTC) falls inside the range of
  // the every-5-minutes queue cron (6-21), so both could try to trigger a scan in
  // the same tick right after the quota window opens. This lock makes sure only
  // one scan runs at a time regardless of which cron triggered it.
  let isScanning = false;
  async function runGuardedScan(scanFn) {
    if (isScanning) {
      logger.info('Scan skipped — another scan is already in progress');
      return;
    }
    isScanning = true;
    try {
      await scanFn();
    } finally {
      isScanning = false;
    }
  }

  // FIX (solution 6): the daily scan used to fire at 05:00 UTC, which is BEFORE
  // the real YouTube quota reset (07:00 UTC in summer / 08:00 UTC in winter — see
  // quota-window.js). That meant it ran on whatever quota was left over from the
  // *previous* window instead of a fresh 10,000-unit budget, and it never checked
  // whether a scan (e.g. the one on container startup) had already consumed most
  // of that same window. Moved to 08:15 UTC — safely after the reset year-round —
  // and added an explicit "already scanned this window?" guard as a second line
  // of defense, the same pattern already used by the queue-empty cron below.
  cron.schedule('15 8 * * *', async () => {
    await runGuardedScan(async () => {
      logger.info('=== DAILY SCAN STARTED ===');
      try {
        const lastScan = await dbHelpers.getStat('last_scan');
        if (isWithinCurrentQuotaWindow(lastScan)) {
          logger.info('Daily scan skipped — a scan already ran in the current quota window (last: ' +
            lastScan + ', window started: ' + lastQuotaReset().toISOString() + ')');
          return;
        }
        if (!(await isQuotaAvailable())) {
          logger.info('Daily scan skipped — quota marked exhausted for the current window');
          return;
        }

        const results = await scanAllCategories();
            // Check if quota was exhausted during scan. Two signals: the explicit
            // quotaExceeded flag (reliable — set when a 429 was actually hit), and
            // the allEmpty heuristic (kept as a fallback, e.g. for a bad API key).
            // categoryKeys excludes the _quotaExceeded metadata key so it isn't
            // mistaken for a 6th category.
            const categoryKeys = Object.keys(results).filter(k => !k.startsWith('_'));
            const allEmpty = categoryKeys.every(k => {
              const r = results[k];
              return (!r.recent || r.recent.length === 0) && (!r.evergreen || r.evergreen.length === 0);
            });
            if (results._quotaExceeded || allEmpty) {
              await markQuotaExhausted();
            }
            if (!allEmpty) {
              // Save last scan time and queue whatever was gathered — even if
              // quota ran out partway through, don't discard categories that
              // succeeded before that point.
              await dbHelpers.run(
                "INSERT INTO system_stats (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()",
                ['last_scan', new Date().toISOString()]
              );
              await dbHelpers.run(
                "INSERT INTO system_stats (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()",
                ['last_auto_scan', new Date().toISOString()]
              );
              await buildDailyQueue(results);
            }
        logger.info('=== DAILY SCAN COMPLETE ===');
      } catch (err) {
        logger.error(`Daily scan error: ${err.message}`);
      }
    });
  });

  // Process queue every 5 minutes (06:00–22:00)
  cron.schedule('*/5 6-21 * * *', async () => {
    // If queue is empty, trigger a scan (only if quota available)
    if (await isQuotaAvailable()) {
      const pendingRows = await dbHelpers.all("SELECT COUNT(*) as cnt FROM video_queue WHERE status = 'pending'");
      const pendingCount = pendingRows[0];
      if (pendingCount && parseInt(pendingCount.cnt) === 0) {
        // Check if we scanned in the last 30 minutes to avoid infinite loop
        const lastScan = await dbHelpers.getStat('last_auto_scan');
        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
        if (!lastScan || new Date(lastScan) < thirtyMinAgo) {
          await runGuardedScan(async () => {
            logger.info('Queue empty — triggering automatic scan');
            try {
              await dbHelpers.run(
                "INSERT INTO system_stats (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()",
                ['last_auto_scan', new Date().toISOString()]
              );
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
                await buildDailyQueue(results);
              }
            } catch(e) {
              logger.error('Auto-scan error: ' + e.message);
            }
          });
        } else {
          logger.info('Queue empty but scan ran recently — waiting before next auto-scan');
        }
      }
    } else {
      logger.info('Queue empty but YouTube quota exhausted — waiting for reset at ' + nextQuotaReset().toISOString());
    }
    await processQueue();
  });

  // Strike monitoring every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    const accounts = await dbHelpers.getAllActiveAccounts();
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

module.exports = { initScheduler, buildDailyQueue, scanAllCategories, isQuotaAvailable, markQuotaExhausted };
