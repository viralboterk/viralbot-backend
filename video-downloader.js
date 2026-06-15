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

// METHOD 1: cobalt.tools — correct Accept header required
async function tryCobalTools(videoId) {
  try {
    const res = await axios.post('https://api.cobalt.tools/', {
      url: 'https://www.youtube.com/watch?v=' + videoId,
      videoQuality: '720',
      filenameStyle: 'basic',
      downloadMode: 'auto',
    }, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; ViralBot/1.0)',
      },
      timeout: 15000,
    });
    if (res.data && res.data.url) {
      logger.info('cobalt.tools success for ' + videoId);
      return res.data.url;
    }
    if (res.data && res.data.tunnel) {
      logger.info('cobalt.tools tunnel success for ' + videoId);
      return res.data.tunnel;
    }
    return null;
  } catch(e) {
    logger.error('cobalt.tools error for ' + videoId + ': ' + e.message);
    return null;
  }
}

// METHOD 2: yt-dlp via public instance
async function tryYtDlpPublic(videoId) {
  try {
    // Using invidious API to get direct stream URL
    const instances = [
      'https://invidious.nerdvpn.de',
      'https://invidious.privacydev.net',
      'https://yt.artemislena.eu',
    ];
    for (const instance of instances) {
      try {
        const res = await axios.get(instance + '/api/v1/videos/' + videoId, {
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (res.data && res.data.adaptiveFormats) {
          // Get best mp4 format
          const formats = res.data.adaptiveFormats
            .filter(f => f.type && f.type.includes('video/mp4') && f.qualityLabel)
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          if (formats.length > 0 && formats[0].url) {
            logger.info('Invidious success for ' + videoId + ' via ' + instance);
            return formats[0].url;
          }
        }
        // Try formatStreams for combined video+audio
        if (res.data && res.data.formatStreams) {
          const mp4 = res.data.formatStreams
            .filter(f => f.type && f.type.includes('video/mp4'))
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          if (mp4.length > 0 && mp4[0].url) {
            logger.info('Invidious formatStreams success for ' + videoId);
            return mp4[0].url;
          }
        }
      } catch(instanceErr) {
        logger.error('Invidious instance ' + instance + ' failed: ' + instanceErr.message);
      }
    }
    return null;
  } catch(e) {
    logger.error('yt-dlp public error for ' + videoId + ': ' + e.message);
    return null;
  }
}

// METHOD 3: RapidAPI YouTube downloader (if key provided)
async function tryRapidApi(videoId) {
  if (!process.env.RAPIDAPI_KEY) return null;
  try {
    const res = await axios.get('https://youtube-mp36.p.rapidapi.com/dl', {
      params: { id: videoId },
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'youtube-mp36.p.rapidapi.com',
      },
      timeout: 15000,
    });
    if (res.data && res.data.link) {
      logger.info('RapidAPI success for ' + videoId);
      return res.data.link;
    }
    return null;
  } catch(e) {
    logger.error('RapidAPI error for ' + videoId + ': ' + e.message);
    return null;
  }
}

// Main download function — tries all methods in order
async function getYouTubeDirectUrl(videoId) {
  let url = null;

  // Try cobalt.tools first
  url = await tryCobalTools(videoId);
  if (url) return url;

  // Try Invidious instances
  url = await tryYtDlpPublic(videoId);
  if (url) return url;

  // Try RapidAPI if key available
  url = await tryRapidApi(videoId);
  if (url) return url;

  logger.error('All download methods failed for ' + videoId);
  return null;
}

// Keep for compatibility
async function getYouTubeUrlFallback(videoId) {
  return tryYtDlpPublic(videoId);
}

async function downloadAndUploadToR2(videoId, category) {
  try {
    const r2Key = 'videos/' + category + '/' + videoId + '.mp4';

    // Get direct YouTube URL
    let directUrl = await getYouTubeDirectUrl(videoId);
    if (!directUrl) {
      logger.error('Could not get direct URL for ' + videoId + ' — all methods failed');
      return null;
    }

    logger.info('Downloading video ' + videoId + '...');

    // Download video
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
      logger.error('Downloaded file too small for ' + videoId + ': ' + videoBuffer.length + ' bytes — likely invalid');
      return null;
    }
    logger.info('Downloaded ' + videoId + ': ' + (videoBuffer.length / 1024 / 1024).toFixed(1) + 'MB');

    // Upload to R2
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

// Delete from R2 after successful publish
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
