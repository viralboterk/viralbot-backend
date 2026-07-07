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
  const scope = encodeURIComponent('video.upload,video.publish,user.info.basic');
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
// TikTok's docs say this must be called before every post to get the
// creator's available privacy levels — our code has never called it,
// always hardcoding SELF_ONLY directly. Calling it now for compliance, and
// because it may have a side effect on TikTok's end (establishing/confirming
// the creator-app relationship) that a direct video/init/ call skips.
async function queryCreatorInfo(accessToken) {
  try {
    const res = await axios.post(TIKTOK_API + '/post/publish/creator_info/query/', {}, {
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }
    });
    return res.data && res.data.data;
  } catch (err) {
    logger.warn('TikTok creator_info query error: ' + err.message);
    return null;
  }
}

async function publishVideo(account, videoData, publishOptions = {}) {
  try {
    const creatorInfo = await queryCreatorInfo(account.access_token);
    if (creatorInfo) {
      logger.info(account.handle + ' creator_info: privacy_level_options=' +
        JSON.stringify(creatorInfo.privacy_level_options) + ', max_video_post_duration_sec=' +
        creatorInfo.max_video_post_duration_sec);
    }
    // Use options from manual publish form if provided, fall back to env defaults
    const privacyLevel = publishOptions.privacy_level || PRIVACY_LEVEL;
    logger.info('Publishing with privacy_level=' + privacyLevel + ' for ' + account.handle);

    const postInfo = {
      title: (publishOptions.title || videoData.titre || '').substring(0, 2200),
      privacy_level: privacyLevel,
      disable_comment: publishOptions.disable_comment !== undefined ? !!publishOptions.disable_comment : false,
      disable_duet:    publishOptions.disable_duet    !== undefined ? !!publishOptions.disable_duet    : false,
      disable_stitch:  publishOptions.disable_stitch  !== undefined ? !!publishOptions.disable_stitch  : false,
      // video_cover_timestamp_ms intentionally omitted — letting TikTok auto-select
      // the best frame avoids grey/black thumbnails from fade-in intros that many
      // YouTube Shorts have in their first second.
    };
    // Commercial content disclosure fields (only sent if the user turned on the toggle)
    if (publishOptions.brand_content_toggle) postInfo.brand_content_toggle = true;
    if (publishOptions.brand_organic_toggle) postInfo.brand_organic_toggle = true;

    const initRes = await axios.post(TIKTOK_API + '/post/publish/video/init/', {
      post_info: postInfo,
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
      if (tiktokErrorCode === 'reached_active_user_cap') {
        // Unaudited apps can only have a limited number of DISTINCT creator
        // accounts "active" at once across the whole app (separate from the
        // per-account spam_risk rate limit). This is a temporary, rolling-
        // window condition — not this account's fault, and not a strike.
        // Caller will reschedule rather than discarding the video.
        return { success: false, active_user_cap: true, error: tiktokErrorCode };
      }
      // Any other 403 (unaudited, suspended, etc.) is a real strike.
      dbHelpers.updateAccount(account.handle, { status: 'strike' });
    }
    return { success: false, error: err.message };
  }
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

module.exports = { getOAuthUrl, exchangeCodeForToken, refreshToken, publishVideo, queryCreatorInfo };
