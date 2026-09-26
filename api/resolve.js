const FLY_SCRAPER_URL = 'https://ps4-scraper.fly.dev/scrape';
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;

const MAX_BODY_BYTES = 32 * 1024;

function sendJson(res, status, payload) {
  res.status(status).setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

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

    const contentLength = Number(
      req.headers['content-length'] || 0
    );

    if (contentLength > MAX_BODY_BYTES) {
      return sendJson(res, 413, {
        success: false,
        error: 'Requisição muito grande.'
      });
    }

    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : (req.body || {});

    const url = String(body.url || '').trim();
    const titleId = String(body.titleId || '').trim();
    const gameName = String(body.gameName || '').trim();

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

    if (!SCRAPER_API_KEY) {
      console.error('[RESOLVE] SCRAPER_API_KEY não configurada.');

      return sendJson(res, 500, {
        success: false,
        error: 'SCRAPER_API_KEY não configurada na Vercel.'
      });
    }

    console.log('[RESOLVE] Enviando para Fly:', url);

    const flyResponse = await fetch(FLY_SCRAPER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': SCRAPER_API_KEY
      },
      body: JSON.stringify({
        url,
        titleId,
        gameName
      })
    });

    const responseText = await flyResponse.text();

    let flyData;

    try {
      flyData = JSON.parse(responseText);
    } catch {
      flyData = {
        success: false,
        error: 'A Fly retornou uma resposta que não é JSON.',
        raw: responseText
      };
    }

    if (!flyResponse.ok) {
      console.error(
        '[RESOLVE] Fly respondeu:',
        flyResponse.status,
        flyData
      );

      return sendJson(res, 502, {
        success: false,
        error: 'O servidor scraper da Fly retornou um erro.',
        flyStatus: flyResponse.status,
        fly: flyData
      });
    }

    return sendJson(res, 200, flyData);

  } catch (error) {
    console.error('[RESOLVE] Erro:', error);

    return sendJson(res, 502, {
      success: false,
      error: error?.message || 'Falha ao comunicar com o scraper da Fly.'
    });
  }
};
