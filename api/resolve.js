const MAX_BODY_BYTES = 32 * 1024;

function sendJson(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.json(payload);
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, {
        success: false,
        error: 'Método não permitido. Use POST.'
      });
    }

    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return sendJson(res, 413, {
        success: false,
        error: 'Requisição muito grande.'
      });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const url = String(body.url || '').trim();
    const titleId = String(body.titleId || '').trim();
    const gameName = String(body.gameName || '').trim();
    const attemptCaptcha = Boolean(body.attemptCaptcha);

    if (!url) {
      return sendJson(res, 400, {
        success: false,
        error: 'O campo "url" é obrigatório.'
      });
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return sendJson(res, 400, {
        success: false,
        error: 'URL inválida.'
      });
    }

    if (!/^https?:$/i.test(parsed.protocol)) {
      return sendJson(res, 400, {
        success: false,
        error: 'A URL precisa usar HTTP ou HTTPS.'
      });
    }

    if (!/(^|\.)dlpsgame\.com$/i.test(parsed.hostname)) {
      return sendJson(res, 400, {
        success: false,
        error: 'A URL precisa pertencer ao DLPSGame.'
      });
    }

    // Verifica se o serviço Fly.io está configurado
    const scraperUrl = process.env.SCRAPER_SERVICE_URL;
    const scraperApiKey = process.env.SCRAPER_API_KEY;

    if (!scraperUrl || !scraperApiKey) {
      return sendJson(res, 500, {
        success: false,
        error: 'Serviço de scraping não configurado. Defina SCRAPER_SERVICE_URL e SCRAPER_API_KEY nas variáveis de ambiente.'
      });
    }

    // Faz a requisição para o Fly.io
    const response = await fetch(`${scraperUrl}/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': scraperApiKey
      },
      body: JSON.stringify({
        url,
        titleId,
        gameName,
        attemptCaptcha
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Erro do serviço Fly.io:', response.status, errorText);
      return sendJson(res, 502, {
        success: false,
        error: `Serviço de scraping retornou erro ${response.status}: ${errorText}`
      });
    }

    const result = await response.json();
    return sendJson(res, 200, result);

  } catch (error) {
    console.error('Erro em /api/resolve:', error);
    return sendJson(res, 502, {
      success: false,
      error: error?.message || 'Falha ao processar a página.'
    });
  }
};
