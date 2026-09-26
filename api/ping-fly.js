const FLY_URL = 'https://ps4-scraper.fly.dev/health';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');

    return res.status(405).json({
      success: false,
      error: 'Método não permitido. Use GET.'
    });
  }

  const startedAt = Date.now();

  try {
    const response = await fetch(FLY_URL);

    const responseText = await response.text();

    let flyData;

    try {
      flyData = JSON.parse(responseText);
    } catch {
      flyData = {
        raw: responseText
      };
    }

    return res.status(response.ok ? 200 : 502).json({
      success: response.ok,
      service: 'ps4-library',
      target: 'ps4-scraper.fly.dev',
      endpoint: '/health',
      flyStatus: response.status,
      responseTimeMs: Date.now() - startedAt,
      fly: flyData
    });

  } catch (error) {
    console.error('[PING-FLY] Erro:', error);

    return res.status(502).json({
      success: false,
      service: 'ps4-library',
      target: 'ps4-scraper.fly.dev',
      endpoint: '/health',
      responseTimeMs: Date.now() - startedAt,
      error: error.message
    });
  }
};
