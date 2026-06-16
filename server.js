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

// ── Serve Vite production build ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'dist')));

// SPA fallback — all unmatched routes serve index.html
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
