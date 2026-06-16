// Vercel serverless function — /api/speech-token
// The Azure key lives only in Vercel environment variables, never in the browser.

// Simple in-memory token cache (survives warm invocations of the same instance)
let tokenCache = { token: null, expiresAt: 0 };

export default async function handler(req, res) {
  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key    = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;

  if (!key || !region) {
    return res.status(500).json({ error: 'Speech service not configured.' });
  }

  // Serve cached token if still fresh (1-min safety buffer before 10-min expiry)
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60_000) {
    return res.status(200).json({ token: tokenCache.token, region });
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
    return res.status(200).json({ token, region });
  } catch (err) {
    console.error('[speech-token]', err.message);
    return res.status(502).json({ error: 'Failed to obtain speech token.' });
  }
}
