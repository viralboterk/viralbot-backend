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

// Get YouTube video direct download URL using cobalt.tools
async function getYouTubeDirectUrl(videoId) {
  try {
    const res = await axios.post('https://api.cobalt.tools/api/json', {
      url: 'https://www.youtube.com/watch?v=' + videoId,
      vQuality: '720',
      filenamePattern: 'basic',
      isAudioOnly: false,
    }, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    if (res.data && res.data.url) {
      logger.info('Got direct URL for ' + videoId + ' via cobalt.tools');
      return res.data.url;
    }
    return null;
  } catch (err) {
    logger.error('cobalt.tools error for ' + videoId + ': ' + err.message);
    return null;
  }
}

// Download video and upload to R2, return public URL
async function downloadAndUploadToR2(videoId, category) {
  try {
    const r2Key = 'videos/' + category + '/' + videoId + '.mp4';

    // Get direct YouTube URL
    const directUrl = await getYouTubeDirectUrl(videoId);
    if (!directUrl) {
      logger.error('Could not get direct URL for ' + videoId);
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
      },
    });

    const videoBuffer = Buffer.from(response.data);
    logger.info('Downloaded ' + videoId + ': ' + (videoBuffer.length / 1024 / 1024).toFixed(1) + 'MB');

    // Upload to R2
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: r2Key,
      Body: videoBuffer,
      ContentType: 'video/mp4',
    }));

    logger.info('Video ' + videoId + ' uploaded to R2: ' + r2Key);

    // Return public URL
    const publicUrl = R2_PUBLIC_URL + '/' + r2Key;
    return publicUrl;

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

module.exports = { downloadAndUploadToR2, getYouTubeDirectUrl, deleteFromR2 };
