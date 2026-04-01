require('dotenv').config();
const express = require('express');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const path = require('path');
const { PassThrough } = require('stream');
const crypto = require('crypto');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_SIZE = process.env.MAX_UPLOAD_SIZE?.toLowerCase() || '10gb';

const mongoUri = "mongodb+srv://adamdh7:Tchengy1@mizik.ylycjwa.mongodb.net/?appName=mizik";

const contentSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  content: { type: Object, required: true }
});
const Content = mongoose.model('Content', contentSchema);

const sizeMultipliers = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

function parseMaxSize(str) {
  const match = str.match(/^(\d+(?:\.\d+)?)([kmgt]?b?)$/i);
  if (!match) return 10 * 1024 ** 3;
  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  return Math.floor(num * (sizeMultipliers[unit] || sizeMultipliers.gb));
}

const maxSizeBytes = parseMaxSize(MAX_UPLOAD_SIZE);

const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Content-Length');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function buildPublicUrl(key) {
  let baseUrl = process.env.PUBLIC_BASE_URL || '';
  if (baseUrl) {
    if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
    return `${baseUrl}/${encodeURI(key)}`;
  }
  if (process.env.R2_ENDPOINT && process.env.R2_BUCKET) {
    let ep = process.env.R2_ENDPOINT.replace(/\/$/, '');
    if (ep.includes(process.env.R2_BUCKET)) return `${ep}/${encodeURI(key)}`;
    return `${ep}/${process.env.R2_BUCKET}/${encodeURI(key)}`;
  }
  return `s3://${process.env.R2_BUCKET}/${key}`;
}

app.put('/upload', async (req, res) => {
  const filename = (req.query.filename || '').trim();
  if (!filename) return res.status(400).json({ error: 'Fichye san non' });
  const contentLengthHeader = req.headers['content-length'];
  if (!contentLengthHeader) return res.status(411).json({ error: 'Content-Length header obligatwa' });
  const contentLength = parseInt(contentLengthHeader, 10);
  if (isNaN(contentLength) || contentLength <= 0) return res.status(400).json({ error: 'Content-Length envalid' });
  if (contentLength > maxSizeBytes) return res.status(413).json({ error: 'Fichye twò gwo' });
  const parsed = path.parse(filename);
  let baseName = parsed.name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9.*-]/g, '*');
  if (!baseName || baseName === '.') baseName = 'fichye';
  const safeFilename = baseName + parsed.ext.toLowerCase();
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const randomBytes = crypto.randomBytes(8);
  const randomId = Array.from(randomBytes).map(b => chars[b % chars.length]).join('').slice(0, 12);
  const key = `TF-${randomId}/${safeFilename}`;
  const contentType = req.headers['content-type'] || 'application/octet-stream';
  let receivedBytes = 0;
  const meterStream = new PassThrough();
  meterStream.on('data', chunk => {
    receivedBytes += chunk.length;
    if (receivedBytes > maxSizeBytes) meterStream.destroy(new Error('Fichye twò gwo'));
  });
  req.pipe(meterStream);
  req.on('aborted', () => meterStream.destroy());
  try {
    const parallelUpload = new Upload({
      client: s3Client,
      params: { Bucket: process.env.R2_BUCKET, Key: key, Body: meterStream, ContentType: contentType },
      partSize: 10 * 1024 * 1024,
      queueSize: 4
    });
    await parallelUpload.done();
    const publicUrl = buildPublicUrl(key);
    return res.json({ key, url: publicUrl });
  } catch (err) {
    let message = 'Upload echwe';
    let status = 500;
    if (err.message === 'Fichye twò gwo' || (err.$metadata && err.$metadata.httpStatusCode === 413)) {
      message = 'Fichye twò gwo';
      status = 413;
    }
    return res.status(status).json({ error: message });
  }
});

app.get('/data', async (req, res) => {
  try {
    const docs = await Content.find();
    const items = [];
    for (const doc of docs) {
      const key = doc.key;
      const obj = doc.content;
      const title = obj.Name || obj.Titre || key.split('/')[1];
      const thumb = obj["Url Thumb"] || '';
      const category = obj.Catégorie || '';
      items.push({ key, title, category, thumb });
    }
    items.sort((a, b) => a.title.localeCompare(b.title));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/cherche', async (req, res) => {
  const q = (req.query.name || '').toLowerCase().trim();
  if (!q) return res.json([]);
  try {
    const docs = await Content.find();
    const items = [];
    for (const doc of docs) {
      const key = doc.key;
      const obj = doc.content;
      const title = (obj.Name || obj.Titre || key.split('/')[1] || '').toLowerCase();
      if (title.includes(q)) {
        const realTitle = obj.Name || obj.Titre || key.split('/')[1];
        items.push({ key, title: realTitle, category: obj.Catégorie || '', thumb: obj["Url Thumb"] || '' });
      }
    }
    res.json(items.slice(0, 50));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/sync/receive', async (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'Format invalide' });
  let count = 0;
  try {
    for (const item of items) {
      if (item.key && item.content) {
        await Content.findOneAndUpdate({ key: item.key }, { content: item.content }, { upsert: true });
        count++;
      }
    }
    res.json({ success: true, received: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/data', async (req, res) => {
  let { category, title, thumb = '', description = '', bio = '', urlVideo = '' } = req.body;
  if (!category || !title) return res.status(400).json({ error: 'Katégorie ak titre obligatwa' });
  category = category.trim();
  if (category !== 'Poste') return res.status(400).json({ error: 'Katégorie envalid' });
  const catLower = 'poste';
  let baseSlug = title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!baseSlug) baseSlug = 'untitled';
  let slug = baseSlug;
  let num = 1;
  try {
    while (await Content.exists({ key: `${catLower}/${slug}` })) {
      slug = `${baseSlug}-${++num}`;
    }
    const key = `${catLower}/${slug}`;
    const content = { "Url Thumb": thumb, Catégorie: category };
    content.Name = title;
    content.Description = description;
    content.Bio = bio;
    content["Url Video"] = urlVideo;
    await Content.create({ key, content });
    res.json({ success: true, key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/data', async (req, res) => {
  const { key, content } = req.body;
  if (!key || !content) return res.status(400).json({ error: 'Key ak kontni obligatwa' });
  try {
    const doc = await Content.findOneAndUpdate({ key }, { content });
    if (!doc) return res.status(404).json({ error: 'Kontni pa jwenn' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/data', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Key obligatwa' });
  try {
    const doc = await Content.findOneAndDelete({ key });
    if (!doc) return res.status(404).json({ error: 'Pa jwenn' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/data/:key(*)', async (req, res) => {
  const key = req.params.key;
  try {
    const doc = await Content.findOne({ key });
    if (!doc) return res.status(404).json({ error: 'Kontni pa jwenn' });
    res.json({ key, content: doc.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/ok', (req, res) => {
  res.json({ ok: true });
});

app.get('/get-all', async (req, res) => {
  try {
    const docs = await Content.find();
    res.json(docs.map(doc => doc.content));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/get-post', async (req, res) => {
  try {
    const docs = await Content.find();
    res.json(docs.map(doc => doc.content).filter(o => o.Catégorie === 'Poste'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/get/:batch(\\d+)', async (req, res) => {
  const batch = parseInt(req.params.batch);
  const limit = parseInt(req.query.limit) || 100;
  if (isNaN(batch) || batch < 1) return res.status(400).json({ error: 'Batch envalid' });
  const start = (batch - 1) * limit;
  try {
    const docs = await Content.find().skip(start).limit(limit);
    const total = await Content.countDocuments();
    const items = docs.map(doc => ({ key: doc.key, content: doc.content }));
    res.json({ batch, limit, count: items.length, hasMore: start + limit < total, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

mongoose.connect(mongoUri)
  .then(() => {
    app.listen(PORT, () => console.log(`Server running`));
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
