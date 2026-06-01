const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const axios = require('axios');
const logger = require('./logger');

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME || 'viral-videos';

// Download video from URL and upload to R2
async function uploadVideoToR2(videoUrl, videoId, category) {
  try {
    logger.info(`Downloading video ${videoId} for R2 upload`);
    const response = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 100 * 1024 * 1024, // 100MB max
    });

    const key = `${category}/${videoId}_${Date.now()}.mp4`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: Buffer.from(response.data),
      ContentType: 'video/mp4',
    }));

    const r2Url = `${process.env.R2_ENDPOINT}/${BUCKET}/${key}`;
    logger.info(`Video ${videoId} uploaded to R2: ${key}`);
    return r2Url;
  } catch (err) {
    logger.error(`R2 upload error for ${videoId}: ${err.message}`);
    return null;
  }
}

// Upload thumbnail to R2
async function uploadThumbnailToR2(thumbnailUrl, videoId) {
  try {
    const response = await axios.get(thumbnailUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
    });
    const key = `thumbnails/${videoId}.jpg`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: Buffer.from(response.data),
      ContentType: 'image/jpeg',
    }));
    return `${process.env.R2_ENDPOINT}/${BUCKET}/${key}`;
  } catch (err) {
    logger.error(`R2 thumbnail upload error: ${err.message}`);
    return null;
  }
}

// Delete from R2 after successful TikTok publish
async function deleteFromR2(r2Url) {
  try {
    const key = r2Url.split(`${BUCKET}/`)[1];
    if (!key) return;
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    logger.info(`Deleted from R2: ${key}`);
  } catch (err) {
    logger.error(`R2 delete error: ${err.message}`);
  }
}

module.exports = { uploadVideoToR2, uploadThumbnailToR2, deleteFromR2 };
