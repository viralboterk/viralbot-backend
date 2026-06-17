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
    logger.error('TikTok publish error for ' + account.handle + ': ' + err.message);
    if (err.response && err.response.status === 401) {
      dbHelpers.updateAccount(account.handle, { status: 'token_expired' });
    }
    if (err.response && err.response.status === 403) {
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

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

module.exports = { getOAuthUrl, exchangeCodeForToken, refreshToken, publishVideo, getAccountInfo };
