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

    const body = typeof req.body === 'string'
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

    // Carrega o scraper dentro do handler para que falhas de runtime/dependência
    // apareçam como JSON em vez de um 500 opaco do Vercel.
    let scrapeDLSP;
    try {
      ({ scrapeDLSP } = require('./_scraper'));
    } catch (error) {
      console.error('Falha ao carregar /api/_scraper.js:', error);
      return sendJson(res, 500, {
        success: false,
        error: `Falha ao carregar o scraper: ${error?.message || String(error)}`
      });
    }

    const result = await scrapeDLSP({
      url,
      titleId,
      gameName
    });

    return sendJson(res, 200, result);
  } catch (error) {
    console.error('Erro em /api/resolve:', error);

    return sendJson(res, 502, {
      success: false,
      error: error?.message || 'Falha ao processar a página.'
    });
  }
};
