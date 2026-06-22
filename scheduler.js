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


// Shared set to prevent duplicate R2 deletion timers for the same file
// (multiple accounts publishing the same video_id would otherwise each
// schedule their own setTimeout, causing the file to be deleted early).
const pendingR2Deletions = new Set();

// Short-lived cache so that when multiple accounts in the same category share
// a video_id, only the FIRST account actually downloads from YouTube and
// uploads to R2 — every other account just reuses that R2 URL. 10 minutes is
// comfortably longer than the time between same-category accounts being
// processed in practice, and comfortably shorter than the 30-minute R2
// deletion delay, so a cached URL is never returned for an already-deleted file.
const recentR2Uploads = new Map();
const UPLOAD_CACHE_TTL_MS = 10 * 60 * 1000;
function getCachedR2Upload(videoId, category) {
  const cached = recentR2Uploads.get(videoId + ':' + category);
  if (cached && (Date.now() - cached.timestamp) < UPLOAD_CACHE_TTL_MS) {
    return cached.r2Url;
  }
  return null;
}
function setCachedR2Upload(videoId, category, r2Url) {
  recentR2Uploads.set(videoId + ':' + category, { r2Url, timestamp: Date.now() });
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

    // Adaptive pacing recovery: if this account hasn't hit spam_risk in 3+
    // days, bring its posting interval back down to the default rather than
    // leaving it permanently slowed down because of a one-time incident.
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const isQuiet = !account.last_spam_risk_at || (Date.now() - new Date(account.last_spam_risk_at).getTime()) > THREE_DAYS_MS;
    if (isQuiet && (account.post_interval_min || 20) > 20) {
      await dbHelpers.updateAccount(account.handle, { post_interval_min: 20 });
      logger.info(account.handle + ': posting interval reset to 20 min (no spam_risk in 3+ days)');
      account.post_interval_min = 20;
    }

    // Unified search result (no recent/evergreen split anymore) — dedup is
    // still applied defensively in case the same video_id somehow appears
    // twice within the unified list (shouldn't happen given scanCategory's
    // own dedup, but cheap insurance against ever double-queuing it).
    const scannedVideos = Array.isArray(catVideos.all) ? catVideos.all : [];
    const seenIds = new Set();
    const allVideos = scannedVideos
      .map(v => ({ ...v, mixType: 'all' }))
      .filter(v => {
        if (seenIds.has(v.id)) return false;
        seenIds.add(v.id);
        return true;
      });

    // Filter out already published AND already-queued-but-pending (the
    // latter prevents the same video being added a second time when
    // buildDailyQueue runs again later the same day — see isQueued comment).
    const publishedChecks = await Promise.all(
      allVideos.map(v => dbHelpers.isPublished(v.id, account.handle))
    );
    const queuedChecks = await Promise.all(
      allVideos.map(v => dbHelpers.isQueued(v.id, account.handle))
    );
    const newVideos = allVideos.filter((v, i) => !publishedChecks[i] && !queuedChecks[i]);

    // Take up to 48
    const selected = newVideos.slice(0, 48);
    logger.info(`Account ${account.handle} [${account.category}]: ${selected.length} videos queued`);

    // Schedule — 1 video every N minutes, where N adapts per account (see
    // adaptive pacing above) instead of a fixed 20 min for every account.
    // Start from NOW or 06:00, whichever is later
    const intervalMin = account.post_interval_min || 20;
    let scheduleTime = new Date();
    const startOfDay = new Date();
    startOfDay.setHours(6, 0, 0, 0);
    if (scheduleTime < startOfDay) scheduleTime = startOfDay;
    // Round up to next interval-aligned slot
    const minutes = scheduleTime.getMinutes();
    const nextSlot = Math.ceil(minutes / intervalMin) * intervalMin;
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
        description: (aiContent.hook ? aiContent.hook + '\n\n' : '') + aiContent.description + '\n\n' + aiContent.hashtags.map(t => '#' + t).join(' '),
        tags: JSON.stringify(aiContent.hashtags),
        r2Url: null, // Will be filled during publish
        scheduledAt: scheduledAt.toISOString(),
      });

      scheduleTime = new Date(scheduleTime.getTime() + intervalMin * 60 * 1000);
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

// Runs the full real publish pipeline for a single queue item: download the
// source video, upload it to R2, publish to TikTok, and update the DB
// accordingly. This is the single source of truth for "what publishing a
// video actually does" — both the cron loop below and the dashboard's manual
// "Publier maintenant" button call this exact function, so there is no
// separate/fake code path for the manual trigger.
// Tracks queue item IDs currently being processed, so the same row can never
// be picked up twice concurrently — e.g. a manual "Publier maintenant" click
// on an overdue item colliding with the automated 5-min cron also picking up
// that same now-due item at the same time. The existing isPublished() check
// only catches this AFTER one attempt has fully finished; this catches it
// the instant a second attempt tries to start.
const itemsBeingProcessed = new Set();

async function publishQueueItem(account, item) {
  if (itemsBeingProcessed.has(item.id)) {
    logger.warn('Queue item ' + item.id + ' is already being processed — skipping duplicate concurrent attempt');
    return { success: false, reason: 'already_in_progress' };
  }
  itemsBeingProcessed.add(item.id);
  try {
    return await publishQueueItemInner(account, item);
  } finally {
    itemsBeingProcessed.delete(item.id);
  }
}

async function publishQueueItemInner(account, item) {
  try {
    logger.info('Publishing to ' + account.handle + ': ' + item.title);
    account = await ensureValidToken(account);

    // Check daily limit (48 max)
    const todayCount = await dbHelpers.getTodayCount(account.handle);
    if (todayCount >= 48) {
      logger.warn(`${account.handle} reached daily limit (48)`);
      return { success: false, reason: 'daily_limit_reached' };
    }

    // Safety check: verify not already published even if queued twice (second
    // line of defence after buildDailyQueue deduplication, e.g. for manual
    // "Publier maintenant" calls or race conditions).
    const alreadyPublished = await dbHelpers.isPublished(item.video_id, account.handle);
    if (alreadyPublished) {
      logger.warn('Video ' + item.video_id + ' already published to ' + account.handle + ' — skipping duplicate queue item');
      await dbHelpers.markQueueDone(item.id, 'skipped');
      return { success: false, reason: 'already_published' };
    }

    // Step 1: Download YouTube video and upload to R2 (with 4min timeout)
    // — unless another account already uploaded this exact video+category
    // moments ago, in which case reuse that R2 URL instead of re-downloading.
    let r2Url = getCachedR2Upload(item.video_id, item.category);
    let youtubeLoginRequired = false;
    if (r2Url) {
      logger.info('Reusing cached R2 upload for ' + item.video_id + ' (already uploaded for another account)');
    } else {
      logger.info('Downloading video ' + item.video_id + ' for ' + account.handle);
      // Budget: video-downloader.js tries up to 3 Cobalt negotiation methods
      // (15s each) + 1 download (60s) per cycle = 105s worst case, and now
      // retries the whole cycle up to 2 more times (3 total attempts) on an
      // empty result = up to 315s. 360s leaves a margin above that worst case
      // instead of cutting the 3rd attempt off mid-retry.
      try {
        const downloadPromise = downloadAndUploadToR2(item.video_id, item.category);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Download timeout')), 360000));
        const result = await Promise.race([downloadPromise, timeoutPromise]);
        r2Url = result.url;
        youtubeLoginRequired = result.youtubeLoginRequired;
      } catch(downloadErr) {
        logger.error('Download error for ' + item.video_id + ': ' + downloadErr.message);
      }
      if (r2Url) {
        setCachedR2Upload(item.video_id, item.category, r2Url);
      }
    }
    if (!r2Url) {
      logger.error('Could not get R2 URL for ' + item.video_id + ' — skipping');

      // "error.api.youtube.login" means Cobalt has no authenticated YouTube
      // session for a request YouTube is currently challenging — observed in
      // production to be transient (the same video has succeeded on a later
      // attempt a couple hours after failing this way). Reschedule rather than
      // discard, but cap retries so a genuinely permanently-restricted video
      // doesn't reschedule forever.
      const MAX_TRANSIENT_RETRIES = 3;
      if (youtubeLoginRequired && (item.retry_count || 0) < MAX_TRANSIENT_RETRIES) {
        const RETRY_DELAY_MS = 90 * 60 * 1000;
        const retryAt = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
        await dbHelpers.run(
          'UPDATE video_queue SET scheduled_at = $1, retry_count = retry_count + 1 WHERE id = $2',
          [retryAt, item.id]
        );
        const retried = await dbHelpers.all(
          "UPDATE video_queue SET scheduled_at = $1, retry_count = retry_count + 1 WHERE video_id = $2 AND status = 'pending' AND id != $3 RETURNING id",
          [retryAt, item.video_id, item.id]
        );
        logger.warn('YouTube auth required for ' + item.video_id + ' (attempt ' + ((item.retry_count || 0) + 1) + '/' + MAX_TRANSIENT_RETRIES + ') — rescheduled this item + ' + retried.length + ' other pending item(s) to retry in 90 min');
        return { success: false, reason: 'youtube_login_required_retry_later' };
      }

      await dbHelpers.markQueueDone(item.id, 'failed');
      // Also fail all other pending items for this video_id across all accounts —
      // if Cobalt can't download it once (with retry), it won't download it for
      // any other account either (age-restricted, geo-blocked, etc.).
      const otherItems = await dbHelpers.all(
        "UPDATE video_queue SET status = 'failed' WHERE video_id = $1 AND status = 'pending' AND id != $2 RETURNING id",
        [item.video_id, item.id]
      );
      if (otherItems.length > 0) {
        logger.warn('Cobalt permanently failed for ' + item.video_id + ' — marked ' + otherItems.length + ' other pending item(s) as failed');
      }
      return { success: false, reason: 'download_failed' };
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
      // Clean up R2 after successful publish.
      // TikTok pulls asynchronously after PUBLISH_COMPLETE — 30 min gives it enough time.
      // pendingR2Deletions prevents duplicate timers when multiple accounts share same video_id.
      const r2Key = 'videos/' + item.category + '/' + item.video_id + '.mp4';
      if (!pendingR2Deletions.has(r2Key)) {
        pendingR2Deletions.add(r2Key);
        setTimeout(() => {
          deleteFromR2(r2Key);
          pendingR2Deletions.delete(r2Key);
        }, 30 * 60 * 1000);
      }
      logger.info('✅ Published: ' + item.title + ' → ' + account.handle);
      return { success: true, publishId: result.publishId };
    } else if (result.spam_risk) {
      // spam_risk_too_many_posts is a temporary daily rate limit, NOT a permanent strike.
      // Reschedule all remaining items for this account to 24h from now.
      logger.warn('spam_risk on ' + account.handle + ' — rescheduling remaining queue to tomorrow');
      await dbHelpers.run(
        "UPDATE video_queue SET scheduled_at = NOW() + INTERVAL '24 hours' WHERE account_id = $1 AND status = 'pending'",
        [account.handle]
      );
      // Adaptive pacing: this account is hitting TikTok's real rate limit faster
      // than our fixed 20-min cadence assumes. Widen its future interval (capped
      // at 3h) instead of repeating the same cadence and hitting the same wall
      // again tomorrow. recoverIntervalIfQuiet() brings it back down once the
      // account goes a few days without hitting spam_risk again.
      const MAX_INTERVAL_MIN = 180;
      const currentInterval = account.post_interval_min || 20;
      const newInterval = Math.min(Math.round(currentInterval * 1.5), MAX_INTERVAL_MIN);
      if (newInterval !== currentInterval) {
        await dbHelpers.updateAccount(account.handle, { post_interval_min: newInterval, last_spam_risk_at: new Date().toISOString() });
        logger.warn('Backoff: ' + account.handle + ' posting interval widened ' + currentInterval + ' → ' + newInterval + ' min');
      } else {
        await dbHelpers.updateAccount(account.handle, { last_spam_risk_at: new Date().toISOString() });
      }
      await dbHelpers.markQueueDone(item.id, 'failed');
      logger.error('❌ Failed (spam_risk — rescheduled to tomorrow): ' + item.title + ' → ' + account.handle);
      return { success: false, reason: 'spam_risk' };
    } else {
      await dbHelpers.markQueueDone(item.id, 'failed');
      logger.error('❌ Failed: ' + item.title + ' → ' + account.handle);
      return { success: false, reason: result.error || 'publish_failed' };
    }
  } catch (err) {
    logger.error(`publishQueueItem error for item ${item.id}: ${err.message}`);
    await dbHelpers.markQueueDone(item.id, 'error');
    return { success: false, reason: err.message };
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
    if (!dueItems.length) continue;

    // Burst prevention: if an item is more than 1 hour overdue (catch-up scenario
    // after a restart or long quota wait), reschedule it using this account's
    // current interval instead of processing all overdue items at once. This
    // prevents a burst of rapid back-to-back publications that triggers
    // TikTok's spam_risk_too_many_posts.
    const ONE_HOUR = 60 * 60 * 1000;
    const intervalMin = account.post_interval_min || 20;
    let rescheduled = 0;
    for (const item of dueItems) {
      const overdue = now - new Date(item.scheduled_at);
      if (overdue > ONE_HOUR) {
        const newTime = new Date(now.getTime() + (intervalMin + rescheduled * intervalMin) * 60 * 1000);
        await dbHelpers.run('UPDATE video_queue SET scheduled_at = $1 WHERE id = $2', [newTime.toISOString(), item.id]);
        rescheduled++;
      }
    }
    if (rescheduled > 0) {
      logger.info(account.handle + ': rescheduled ' + rescheduled + ' overdue item(s) to prevent burst');
      continue; // Don't publish this cycle — let the rescheduled items run on time
    }

    // Max 1 item per account per cycle (not 2) to respect TikTok's rate limits
    const item = dueItems[0];
    try {
      const result = await publishQueueItem(account, item);
      // Stop processing this account's queue for the rest of this cycle
      // if it hit spam_risk — remaining items already rescheduled to tomorrow.
      if (result && result.reason === 'spam_risk') continue;
    } catch (err) {
      logger.error(`Queue processing error: ${err.message}`);
      await dbHelpers.markQueueDone(item.id, 'error');
    }
  }
}

// Shared lock across ALL scan-triggering paths — both cron jobs below, the
// manual /api/scan route (Pipeline "Lancer un cycle" / Dashboard "Scanner
// YouTube" buttons), and the startup initial-scan in index.js. Previously this
// lock was local to initScheduler() so only the two crons shared it; the
// manual route had no lock at all. A click while a cron-triggered scan was
// running (or two quick clicks) launched two concurrent scans, doubling
// YouTube quota usage and AI generation calls — seen directly in production
// logs (two "Starting full YouTube scan" lines 9 seconds apart).
let isScanning = false;
async function runGuardedScan(scanFn) {
  if (isScanning) {
    logger.info('Scan skipped — another scan is already in progress');
    return { skipped: true };
  }
  isScanning = true;
  try {
    await scanFn();
    return { skipped: false };
  } finally {
    isScanning = false;
  }
}
function isScanInProgress() { return isScanning; }

// Initialize all cron jobs
function initScheduler() {

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
        // A full scan costs ~4,300 of the 10,000 daily quota units (43%!) — the
        // budget realistically affords only ~2 full scans per day. A 30-min
        // cooldown allowed up to 32 auto-scan attempts in the 06:00-22:00 window,
        // which reliably exhausted quota hours before the actual midnight-Pacific
        // reset (observed: quota exceeded earlier and earlier each day). 3 hours
        // caps this to ~5 attempts/day, which in practice still means the budget
        // runs out after 1-2 of them succeed, but never wastes the cooldown on
        // attempts that have no chance of finding any quota left.
        const lastScan = await dbHelpers.getStat('last_auto_scan');
        const cooldownAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
        if (!lastScan || new Date(lastScan) < cooldownAgo) {
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

  // Token refresh daily at 04:00 — also refreshes follower/view stats, but
  // ONLY once user.info.stats/video.list scopes are actually requested again
  // (pending TikTok app approval). Currently disabled to avoid a guaranteed
  // 401 + noisy error log for every account, every day, for no benefit.
  const STATS_SCOPES_APPROVED = false; // flip to true once scopes are re-added to getOAuthUrl and approved
  cron.schedule('0 4 * * *', async () => {
    logger.info('Refreshing TikTok tokens');
    if (!STATS_SCOPES_APPROVED) return;
    try {
      const { getAccountInfo, getTotalViews } = require('./tiktok-publisher');
      const accounts = await dbHelpers.getAllActiveAccounts();
      for (const account of accounts) {
        try {
          const info = await getAccountInfo(account.access_token);
          if (info && typeof info.follower_count === 'number') {
            await dbHelpers.updateAccount(account.handle, { followers: info.follower_count });
          }
          const totalViews = await getTotalViews(account.access_token);
          if (totalViews !== null) {
            await dbHelpers.updateAccount(account.handle, { total_views: totalViews });
          }
        } catch (err) {
          logger.warn('Could not refresh stats for ' + account.handle + ': ' + err.message);
        }
      }
      logger.info('Account stats (followers + views) refreshed for ' + accounts.length + ' account(s)');
    } catch (err) {
      logger.error('Account stats refresh error: ' + err.message);
    }
  });

  logger.info('✅ Scheduler initialized — all cron jobs active');
}

module.exports = { initScheduler, buildDailyQueue, scanAllCategories, isQuotaAvailable, markQuotaExhausted, publishQueueItem, runGuardedScan, isScanInProgress };
