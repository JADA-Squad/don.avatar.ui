// Vercel serverless function — GET /api/spatius-config
// Returns the non-secret config the browser needs to boot AvatarKit.
// Secret keys (SPATIUS_API_KEY) are never included in this response.

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const appId      = process.env.SPATIUS_APP_ID      || '';
  const apiKey     = process.env.SPATIUS_API_KEY      || '';
  const avatarId   = process.env.SPATIUS_AVATAR_ID    || '';
  const environment = process.env.SPATIUS_ENVIRONMENT || 'intl';
  const region     = process.env.SPATIUS_REGION       || 'us-west';
  const sampleRate = Number(process.env.SPATIUS_SAMPLE_RATE || 24000);

  return res.status(200).json({
    configured:  Boolean(appId && apiKey && avatarId),
    appId,
    avatarId,
    environment,
    sampleRate,
    // Point AvatarKit at the spatius.ai cluster (the SDK's bundled config
    // still references the old spatialwalk.cloud cluster which rejects intl keys).
    apiEndpoint: `api.${region}.spatius.ai`,
  });
}
