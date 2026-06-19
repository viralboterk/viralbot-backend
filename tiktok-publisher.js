const axios = require('axios');
const { dbHelpers } = require('./database');
const logger = require('./logger');

const TIKTOK_API = 'https://open.tiktokapis.com/v2';
const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
// Until the Content Posting API audit is approved, TikTok rejects
// PUBLIC_TO_EVERYONE outright (403) for this app. Default to SELF_ONLY so
// publishing actually succeeds (privately) in the meantime; once the audit
// is approved, set TIKTOK_PRIVACY_LEVEL=PUBLIC_TO_EVERYONE on Railway — no
// redeploy needed.
const PRIVACY_LEVEL = process.env.TIKTOK_PRIVACY_LEVEL || 'SELF_ONLY';

// Generate OAuth URL for account connection
function getOAuthUrl(accountHandle) {
  const appUrl = process.env.APP_URL || 'https://viralbot-backend-production.up.railway.app';
  const redirectUri = encodeURIComponent(appUrl + '/callback');
  const scope = encodeURIComponent('video.upload,video.publish,user.info.basic,user.info.stats,video.list');
  const state = encodeURIComponent(accountHandle);
  return 'https://www.tiktok.com/v2/auth/authorize/?client_key=' + CLIENT_KEY + '&scope=' + scope + '&response_type=code&redirect_uri=' + redirectUri + '&state=' + state;
}

// Exchange auth code for access token
async function exchangeCodeForToken(code, redirectUri) {
  try {
    const res = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', 
      'client_key=' + CLIENT_KEY + '&client_secret=' + CLIENT_SECRET + '&code=' + code + '&grant_type=authorization_code&redirect_uri=' + redirectUri,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return res.data;
  } catch (err) {
    logger.error('TikTok token exchange error: ' + err.message);
    return null;
  }
}

// Refresh access token
async function refreshToken(refresh_token) {
  try {
    const res = await axios.post('https://open.tiktokapis.com/v2/oauth/token/',
      'client_key=' + CLIENT_KEY + '&client_secret=' + CLIENT_SECRET + '&grant_type=refresh_token&refresh_token=' + refresh_token,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return res.data;
  } catch (err) {
    logger.error('TikTok refresh token error: ' + err.message);
    return null;
  }
}

// Publish video to TikTok
async function publishVideo(account, videoData) {
  try {
    logger.info('Publishing with privacy_level=' + PRIVACY_LEVEL + ' for ' + account.handle);
    const initRes = await axios.post(TIKTOK_API + '/post/publish/video/init/', {
      post_info: {
        title: videoData.titre.substring(0, 150),
        privacy_level: PRIVACY_LEVEL,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        video_cover_timestamp_ms: 1000,
      },
      source_info: {
        source: 'PULL_FROM_URL',
        video_url: videoData.r2Url,
      },
    }, {
      headers: {
        'Authorization': 'Bearer ' + account.access_token,
        'Content-Type': 'application/json',
      }
    });

    if (initRes.data.error && initRes.data.error.code !== 'ok') {
      throw new Error('TikTok init error: ' + initRes.data.error.message);
    }

    const publishId = initRes.data.data && initRes.data.data.publish_id;
    logger.info('TikTok upload initiated — publish_id: ' + publishId + ' for ' + account.handle);

    // Poll for completion
    let attempts = 0;
    while (attempts < 20) {
      await sleep(5000);
      const statusRes = await axios.post(TIKTOK_API + '/post/publish/status/fetch/', {
        publish_id: publishId,
      }, {
        headers: {
          'Authorization': 'Bearer ' + account.access_token,
          'Content-Type': 'application/json',
        }
      });

      const status = statusRes.data.data && statusRes.data.data.status;
      if (status === 'PUBLISH_COMPLETE') {
        logger.info('Video published on ' + account.handle + ': ' + videoData.titre);
        return { success: true, publishId };
      }
      if (status === 'FAILED') throw new Error('TikTok publish failed for ' + account.handle);
      attempts++;
    }
    throw new Error('TikTok publish timeout');

  } catch (err) {
    const tiktokError = err.response && err.response.data;
    const tiktokErrorCode = tiktokError && tiktokError.error && tiktokError.error.code;
    logger.error('TikTok publish error for ' + account.handle + ': ' + err.message + (tiktokError ? ' | TikTok response: ' + JSON.stringify(tiktokError) : ' | no response body'));
    if (err.response && err.response.status === 401) {
      dbHelpers.updateAccount(account.handle, { status: 'token_expired' });
    }
    if (err.response && err.response.status === 403) {
      if (tiktokErrorCode === 'spam_risk_too_many_posts') {
        // Temporary daily rate limit — NOT a permanent strike.
        // Caller will reschedule this account's remaining items for tomorrow.
        return { success: false, spam_risk: true, error: tiktokErrorCode };
      }
      // Any other 403 (unaudited, suspended, etc.) is a real strike.
      dbHelpers.updateAccount(account.handle, { status: 'strike' });
    }
    return { success: false, error: err.message };
  }
}

// Get account info
async function getAccountInfo(accessToken) {
  try {
    const res = await axios.get(TIKTOK_API + '/user/info/', {
      params: { fields: 'open_id,union_id,display_name,avatar_url,follower_count' },
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    return res.data.data && res.data.data.user;
  } catch (err) {
    logger.error('TikTok get account info error: ' + err.message);
    return null;
  }
}

// Sum view_count across ALL of the account's videos via /v2/video/list/,
// paginating with the cursor TikTok returns until has_more is false.
// Capped at 20 pages (≤ 400 videos at max_count=20) as a safety net against
// an unexpected infinite-pagination response — well above what any of these
// accounts will realistically have.
async function getTotalViews(accessToken) {
  let totalViews = 0;
  let cursor = 0;
  let hasMore = true;
  let pages = 0;
  try {
    while (hasMore && pages < 20) {
      const res = await axios.post(
        TIKTOK_API + '/video/list/?fields=id,view_count',
        { max_count: 20, cursor },
        { headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' } }
      );
      const data = res.data && res.data.data;
      if (!data || !Array.isArray(data.videos)) break;
      for (const v of data.videos) {
        totalViews += v.view_count || 0;
      }
      hasMore = !!data.has_more;
      cursor = data.cursor;
      pages++;
    }
    return totalViews;
  } catch (err) {
    logger.error('TikTok get video list error: ' + err.message);
    return null; // null = couldn't fetch, caller should leave the stored value untouched
  }
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

module.exports = { getOAuthUrl, exchangeCodeForToken, refreshToken, publishVideo, getAccountInfo, getTotalViews };
