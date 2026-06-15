const axios = require('axios');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
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
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || process.env.R2_ENDPOINT + '/' + BUCKET;
const COBALT_URL = process.env.COBALT_URL || 'https://cobalt-api-production-6ad6.up.railway.app';

// METHOD 1: Private Cobalt instance (self-hosted on Railway)
async function tryCobaltPrivate(videoId) {
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
      timeout: 30000,
    });

    if (res.data && res.data.url) {
      logger.info('Private Cobalt success for ' + videoId);
      return res.data.url;
    }
    if (res.data && res.data.tunnel) {
      logger.info('Private Cobalt tunnel success for ' + videoId);
      return res.data.tunnel;
    }
    return null;
  } catch(e) {
    logger.error('Private Cobalt error for ' + videoId + ': ' + e.message);
    return null;
  }
}

// METHOD 2: Cobalt with different quality fallback
async function tryCobaltFallback(videoId) {
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
      timeout: 30000,
    });

    if (res.data && res.data.url) {
      logger.info('Private Cobalt fallback success for ' + videoId);
      return res.data.url;
    }
    if (res.data && res.data.tunnel) {
      return res.data.tunnel;
    }
    return null;
  } catch(e) {
    logger.error('Private Cobalt fallback error for ' + videoId + ': ' + e.message);
    return null;
  }
}

// METHOD 3: Cobalt with youtu.be format
async function tryCobaltShort(videoId) {
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
      timeout: 30000,
    });

    if (res.data && res.data.url) {
      logger.info('Private Cobalt short URL success for ' + videoId);
      return res.data.url;
    }
    if (res.data && res.data.tunnel) {
      return res.data.tunnel;
    }
    return null;
  } catch(e) {
    logger.error('Private Cobalt short URL error for ' + videoId + ': ' + e.message);
    return null;
  }
}

// Main: try all methods in order
async function getYouTubeDirectUrl(videoId) {
  let url = null;

  url = await tryCobaltPrivate(videoId);
  if (url) return url;

  url = await tryCobaltFallback(videoId);
  if (url) return url;

  url = await tryCobaltShort(videoId);
  if (url) return url;

  logger.error('All download methods failed for ' + videoId);
  return null;
}

async function getYouTubeUrlFallback(videoId) {
  return tryCobaltFallback(videoId);
}

async function downloadAndUploadToR2(videoId, category) {
  try {
    const r2Key = 'videos/' + category + '/' + videoId + '.mp4';

    let directUrl = await getYouTubeDirectUrl(videoId);
    if (!directUrl) {
      logger.error('Could not get direct URL for ' + videoId + ' — all methods failed');
      return null;
    }

    logger.info('Downloading video ' + videoId + '...');

    const response = await axios.get(directUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      maxContentLength: 150 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.youtube.com/',
      },
    });

    const videoBuffer = Buffer.from(response.data);
    if (videoBuffer.length < 10000) {
      logger.error('Downloaded file too small for ' + videoId + ': ' + videoBuffer.length + ' bytes');
      return null;
    }
    logger.info('Downloaded ' + videoId + ': ' + (videoBuffer.length / 1024 / 1024).toFixed(1) + 'MB');

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: r2Key,
      Body: videoBuffer,
      ContentType: 'video/mp4',
    }));

    logger.info('Video ' + videoId + ' uploaded to R2: ' + r2Key);
    return R2_PUBLIC_URL + '/' + r2Key;

  } catch (err) {
    logger.error('downloadAndUploadToR2 error for ' + videoId + ': ' + err.message);
    return null;
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

module.exports = { downloadAndUploadToR2, getYouTubeDirectUrl, getYouTubeUrlFallback, deleteFromR2 };
