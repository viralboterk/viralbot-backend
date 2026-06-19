const axios = require('axios');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const logger = require('./logger');

// R2 Client
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME || 'viral-videos';

// FIX (solution 8): R2_PUBLIC_URL is REQUIRED. R2_ENDPOINT is the private S3 API
// endpoint and is NEVER reachable by TikTok's servers — silently falling back to
// it produced URLs that looked valid but returned 403 when TikTok tried to pull
// them. Fail loudly at startup instead of producing a broken URL silently.
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '');
if (!R2_PUBLIC_URL) {
  logger.error('FATAL: R2_PUBLIC_URL is not set. R2_ENDPOINT is private and cannot ' +
    'be used as a fallback — TikTok cannot fetch videos from it. Set R2_PUBLIC_URL ' +
    'to your r2.dev Public Development URL or custom domain, and make sure that ' +
    'exact domain is verified in TikTok for Developers > Manage Apps > URL Properties.');
}

const COBALT_URL = (process.env.COBALT_URL || 'https://cobalt-api-production-6ad6.up.railway.app').trim().replace(/\/+$/, '');
let COBALT_HOST = null;
try { COBALT_HOST = new URL(COBALT_URL).host; } catch (e) { /* leave null, logged where used */ }

// Cobalt's actual response schema (confirmed against the official cobalt-kit SDK
// example) only ever exposes the result link on `res.data.url`, regardless of
// whether status is "tunnel" or "redirect" — there is no separate `res.data.tunnel`
// field. The previous code checked for `res.data.tunnel` first, which never
// existed, so it always fell through to `res.data.url` anyway — but it also never
// logged *which* mode Cobalt chose, which matters: a "tunnel" response is relayed
// through Cobalt's own egress (and therefore through API_EXTERNAL_PROXY, if one is
// configured on the Cobalt service), while a "redirect" response points straight
// at a googlevideo.com link that viralbot-backend would fetch directly from its
// own Railway IP, bypassing any proxy entirely. We can't force one mode or the
// other from here (no confirmed Cobalt parameter for that), so we just log it
// clearly for visibility, since it directly explains inconsistent download
// results between videos.
function extractCobaltResult(res, videoId, label) {
  if (!res.data || !res.data.url) return null;
  const url = res.data.url;
  try { new URL(url); } catch (e) {
    logger.error('Invalid URL from Cobalt (' + label + ') for ' + videoId + ': ' + url);
    return null;
  }
  let resultHost = null;
  try { resultHost = new URL(url).host; } catch (e) { /* already validated above */ }
  const status = res.data.status || 'unknown';
  const isTunneled = COBALT_HOST && resultHost === COBALT_HOST;
  logger.info('Cobalt ' + label + ' success for ' + videoId + ' [status=' + status +
    ', ' + (isTunneled ? 'tunneled-through-cobalt' : 'direct-external-host:' + resultHost) + ']');
  return url;
}

function getCobaltErrorCode(e) {
  return e.response && e.response.data && e.response.data.error && e.response.data.error.code;
}

// METHOD 1: Private Cobalt instance (self-hosted on Railway)
async function tryCobaltPrivate(videoId, diag) {
  try {
    const res = await axios.post(COBALT_URL + '/', {
      url: 'https://www.youtube.com/watch?v=' + videoId,
      videoQuality: '720',
      filenameStyle: 'basic',
      downloadMode: 'auto',
    }, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 15000,
      maxRedirects: 0,
    });

    const url = extractCobaltResult(res, videoId, 'private');
    if (url) return url;
    logger.error('Cobalt no URL for ' + videoId + ': ' + JSON.stringify(res.data).substring(0, 200));
    return null;
  } catch(e) {
    const status = e.response ? e.response.status : 'no-status';
    const data = e.response ? JSON.stringify(e.response.data).substring(0, 150) : e.message;
    logger.error('Private Cobalt error for ' + videoId + ' [' + status + ']: ' + data);
    if (diag && getCobaltErrorCode(e) === 'error.api.youtube.login') diag.youtubeLoginRequired = true;
    return null;
  }
}

// METHOD 2: Cobalt with different quality fallback
async function tryCobaltFallback(videoId, diag) {
  try {
    const res = await axios.post(COBALT_URL + '/', {
      url: 'https://www.youtube.com/watch?v=' + videoId,
      videoQuality: '480',
      filenameStyle: 'basic',
      downloadMode: 'auto',
    }, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 15000,
      maxRedirects: 0,
    });

    const url = extractCobaltResult(res, videoId, 'fallback-480p');
    if (url) return url;
    logger.error('Cobalt fallback no URL for ' + videoId + ': ' + JSON.stringify(res.data).substring(0, 150));
    return null;
  } catch(e) {
    const status = e.response ? e.response.status : 'no-status';
    const data = e.response ? JSON.stringify(e.response.data).substring(0, 150) : e.message;
    logger.error('Private Cobalt fallback error for ' + videoId + ' [' + status + ']: ' + data);
    if (diag && getCobaltErrorCode(e) === 'error.api.youtube.login') diag.youtubeLoginRequired = true;
    return null;
  }
}

// METHOD 3: Cobalt with youtu.be format
async function tryCobaltShort(videoId, diag) {
  try {
    const res = await axios.post(COBALT_URL + '/', {
      url: 'https://youtu.be/' + videoId,
      videoQuality: '720',
      filenameStyle: 'basic',
      downloadMode: 'auto',
    }, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 15000,
      maxRedirects: 0,
    });

    const url = extractCobaltResult(res, videoId, 'short-url');
    if (url) return url;
    logger.error('Cobalt short URL no URL for ' + videoId + ': ' + JSON.stringify(res.data).substring(0, 150));
    return null;
  } catch(e) {
    const status = e.response ? e.response.status : 'no-status';
    const data = e.response ? JSON.stringify(e.response.data).substring(0, 150) : e.message;
    logger.error('Private Cobalt short URL error for ' + videoId + ' [' + status + ']: ' + data);
    if (diag && getCobaltErrorCode(e) === 'error.api.youtube.login') diag.youtubeLoginRequired = true;
    return null;
  }
}

// Main: try all methods in order. Each call is a FRESH negotiation with Cobalt —
// never reuse a URL obtained from a previous call, since these links are
// short-lived / single-use (solution 10: freshness validation).
async function getYouTubeDirectUrl(videoId, diag) {
  let url = null;

  url = await tryCobaltPrivate(videoId, diag);
  if (url) return url;

  url = await tryCobaltFallback(videoId, diag);
  if (url) return url;

  url = await tryCobaltShort(videoId, diag);
  if (url) return url;

  logger.error('All download methods failed for ' + videoId);
  return null;
}

async function getYouTubeUrlFallback(videoId) {
  return tryCobaltFallback(videoId);
}

// Fetches a direct URL and downloads it IMMEDIATELY (no delay) to minimize the
// window in which a short-lived Cobalt link can expire (solution 7 + 10).
async function fetchVideoBuffer(videoId, diag) {
  const directUrl = await getYouTubeDirectUrl(videoId, diag);
  if (!directUrl) return { buffer: null, reason: 'no-url' };

  const response = await axios.get(directUrl, {
    responseType: 'arraybuffer',
    timeout: 60000,
    maxContentLength: 150 * 1024 * 1024,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.youtube.com/',
    },
  });

  const videoBuffer = Buffer.from(response.data);
  return { buffer: videoBuffer, reason: null };
}

async function downloadAndUploadToR2(videoId, category) {
  if (!R2_PUBLIC_URL) {
    logger.error('Aborting download for ' + videoId + ': R2_PUBLIC_URL is not configured.');
    return { url: null, youtubeLoginRequired: false };
  }

  const diag = { youtubeLoginRequired: false };

  try {
    const r2Key = 'videos/' + category + '/' + videoId + '.mp4';

    logger.info('Downloading video ' + videoId + '...');
    let videoBuffer = null;

    // FIX (solutions 3 + 10, extended): a 0-byte (or implausibly small) result
    // usually means the link Cobalt handed us was already stale, single-use-
    // consumed, or served by a different Cobalt sub-instance than the one that
    // negotiated it (if the instance is horizontally scaled without a shared
    // tunnel cache). Retrying with a fully fresh negotiation resolves this in
    // many documented cases, so we try up to 3 times before giving up, instead
    // of failing the video outright after just one retry.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const result = await fetchVideoBuffer(videoId, diag);
        videoBuffer = result.buffer;
      } catch (err) {
        logger.error('Download attempt ' + attempt + '/' + MAX_ATTEMPTS + ' failed for ' + videoId + ': ' + err.message);
      }
      if (videoBuffer && videoBuffer.length >= 10000) break;
      if (attempt < MAX_ATTEMPTS) {
        logger.warn('Downloaded file too small for ' + videoId + ': ' + (videoBuffer ? videoBuffer.length : 0) +
          ' bytes — retrying (attempt ' + (attempt + 1) + '/' + MAX_ATTEMPTS + ') with a fresh Cobalt negotiation');
      }
    }

    if (!videoBuffer || videoBuffer.length < 10000) {
      logger.error('Downloaded file too small for ' + videoId + ' after ' + MAX_ATTEMPTS + ' attempts: ' +
        (videoBuffer ? videoBuffer.length : 0) + ' bytes');
      return { url: null, youtubeLoginRequired: diag.youtubeLoginRequired };
    }

    logger.info('Downloaded ' + videoId + ': ' + (videoBuffer.length / 1024 / 1024).toFixed(1) + 'MB');

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: r2Key,
      Body: videoBuffer,
      ContentType: 'video/mp4',
    }));

    logger.info('Video ' + videoId + ' uploaded to R2: ' + r2Key);
    return { url: R2_PUBLIC_URL + '/' + r2Key, youtubeLoginRequired: false };

  } catch (err) {
    logger.error('downloadAndUploadToR2 error for ' + videoId + ': ' + err.message);
    return { url: null, youtubeLoginRequired: diag.youtubeLoginRequired };
  }
}

async function deleteFromR2(key) {
  try {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    logger.info('Deleted from R2: ' + key);
  } catch (err) {
    logger.error('R2 delete error: ' + err.message);
  }
}

// Real R2 health check: uploads a tiny test file via the S3 API, then
// verifies it's actually publicly reachable through R2_PUBLIC_URL — the
// exact chain TikTok depends on when it pulls a video via PULL_FROM_URL.
// Cleans up the test file regardless of outcome.
async function checkR2Health() {
  if (!R2_PUBLIC_URL) {
    return { ok: false, stage: 'config', error: 'R2_PUBLIC_URL is not set' };
  }
  const testKey = 'healthcheck/' + Date.now() + '.txt';
  try {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: testKey,
      Body: 'viralbot-r2-healthcheck',
      ContentType: 'text/plain',
    }));
  } catch (err) {
    return { ok: false, stage: 'upload', error: err.message };
  }

  let publicOk = false;
  let publicError = null;
  try {
    const url = R2_PUBLIC_URL + '/' + testKey;
    const res = await axios.get(url, { timeout: 8000, validateStatus: () => true });
    publicOk = res.status === 200;
    if (!publicOk) publicError = 'HTTP ' + res.status;
  } catch (err) {
    publicError = err.message;
  }

  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: testKey }));
  } catch (err) {
    logger.warn('R2 healthcheck cleanup failed: ' + err.message);
  }

  if (!publicOk) return { ok: false, stage: 'public_access', error: publicError };
  return { ok: true };
}

module.exports = { downloadAndUploadToR2, getYouTubeDirectUrl, getYouTubeUrlFallback, deleteFromR2, checkR2Health };
