// Vercel serverless function — POST /api/spatius-token
// Mints a short-lived Spatius session token using the secret API key.
// The API key never leaves this serverless function.

const SPATIUS_REGION_HOSTS = {
  'us-west':      'console.us-west.spatius.ai',
  'ap-northeast': 'console.ap-northeast.spatius.ai',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey  = process.env.SPATIUS_API_KEY  || '';
  const region  = process.env.SPATIUS_REGION   || 'us-west';

  if (!apiKey) {
    return res.status(500).json({ error: 'SPATIUS_API_KEY is not configured on the server.' });
  }

  const host     = SPATIUS_REGION_HOSTS[region] || SPATIUS_REGION_HOSTS['us-west'];
  const expireAt = Math.floor(Date.now() / 1000) + 55 * 60; // 55 minutes

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

    return res.status(200).json({ sessionToken, expireAt });
  } catch (err) {
    console.error('[spatius-token]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
