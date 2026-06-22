import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Token cache ───────────────────────────────────────────────────────────────
// Azure STS tokens are valid for 10 minutes. We cache and refresh every 9 min
// so the client never gets a token that's about to expire.
let tokenCache = { token: null, expiresAt: 0 };

// ── GET /api/speech-token ─────────────────────────────────────────────────────
// Returns a short-lived Azure STS token + region to the frontend.
// The actual subscription key never leaves this server.
app.get('/api/speech-token', async (req, res) => {
  const key    = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;

  if (!key || !region) {
    return res.status(500).json({ error: 'Speech service not configured on server.' });
  }

  // Serve cached token if still fresh (1 min safety buffer)
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60_000) {
    return res.json({ token: tokenCache.token, region });
  }

  try {
    const stsRes = await fetch(
      `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key } }
    );

    if (!stsRes.ok) {
      throw new Error(`Azure STS responded with ${stsRes.status}`);
    }

    const token = await stsRes.text();
    tokenCache = { token, expiresAt: Date.now() + 9 * 60 * 1000 };
    res.json({ token, region });
  } catch (err) {
    console.error('[speech-token]', err.message);
    res.status(502).json({ error: 'Failed to obtain speech token.' });
  }
});

// ── Spatius (SpatialWalk) real-time 3D avatar ──────────────────────────────────
// Region → console host that mints session tokens. Verified against the live
// dashboard: the host is spatius.ai (the docs' older spatialwalk.cloud host
// rejects intl keys as "invalid api key").
const SPATIUS_REGION_HOSTS = {
  'us-west':      'console.us-west.spatius.ai',
  'ap-northeast': 'console.ap-northeast.spatius.ai',
};

function getSpatiusConfig() {
  return {
    appId:       process.env.SPATIUS_APP_ID || '',
    apiKey:      process.env.SPATIUS_API_KEY || '',
    avatarId:    process.env.SPATIUS_AVATAR_ID || '',
    environment: process.env.SPATIUS_ENVIRONMENT || 'intl',
    region:      process.env.SPATIUS_REGION || 'us-west',
    sampleRate:  Number(process.env.SPATIUS_SAMPLE_RATE || 24000),
  };
}

// ── GET /api/spatius-config ─────────────────────────────────────────────────────
// Public (non-secret) config the browser needs to boot AvatarKit.
app.get('/api/spatius-config', (_req, res) => {
  const c = getSpatiusConfig();
  res.json({
    configured:  Boolean(c.appId && c.apiKey && c.avatarId),
    appId:       c.appId,
    avatarId:    c.avatarId,
    environment: c.environment,
    sampleRate:  c.sampleRate,
    // This account is on the spatius.ai cluster (e.g. api.us-west.spatius.ai),
    // but the SDK's dynamic config still points at the old spatialwalk.cloud
    // cluster. The browser uses this to redirect AvatarKit to the right host.
    apiEndpoint: `api.${c.region}.spatius.ai`,
  });
});

// ── POST /api/spatius-token ──────────────────────────────────────────────────────
// Mints a short-lived session token using the secret API key. The key never
// leaves this server.
app.post('/api/spatius-token', async (_req, res) => {
  const { apiKey, region } = getSpatiusConfig();
  if (!apiKey) {
    return res.status(500).json({ error: 'SPATIUS_API_KEY is not set on the server.' });
  }

  const host = SPATIUS_REGION_HOSTS[region] || SPATIUS_REGION_HOSTS['us-west'];
  const expireAt = Math.floor(Date.now() / 1000) + 55 * 60; // 55 min

  try {
    const upstream = await fetch(`https://${host}/v1/console/session-tokens`, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expireAt, modelVersion: '' }),
    });

    const rawText = await upstream.text();
    if (!upstream.ok) {
      throw new Error(`Spatius token request failed (${upstream.status}): ${rawText}`);
    }

    const data = JSON.parse(rawText);
    const sessionToken = data.sessionToken || data.token || (data.data && data.data.sessionToken);
    if (!sessionToken) {
      throw new Error('Spatius token response did not contain a sessionToken.');
    }

    res.json({ sessionToken, expireAt });
  } catch (err) {
    console.error('[spatius-token]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Serve Vite production build ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'dist')));

// SPA fallback — all unmatched routes serve index.html.
// Express 5 (path-to-regexp v8) rejects a bare '*'; use a named splat.
app.get('/*splat', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
