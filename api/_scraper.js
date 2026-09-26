const dns = require('node:dns').promises;
const net = require('node:net');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const DLSP_HOST_RE = /(^|\.)dlpsgame\.com$/i;
const MAX_CANDIDATES = 60;
const MAX_HOPS = 2;
const NAV_TIMEOUT = 25000;

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.google'
]);

const DOWNLOAD_HOST_HINTS = [
  'mediafire',
  '1fichier',
  'mega.nz',
  'mega.co.nz',
  'gofile',
  'pixeldrain',
  'qiwi',
  'katfile',
  'mixdrop',
  'dropbox',
  'drive.google',
  'googleusercontent',
  'mediafireusercontent'
];

const DOWNLOAD_TEXT_RE = /\b(download|mirror|part\s*\d*|pkg|update|dlc|base|game|disc|fix|patch|link|host|mediafire|1fichier|mega|drive)\b/i;
const DLC_RE = /\b(dlc|downloadable content|season pass|expansion|add[- ]?on|bonus pack|costume pack|character pack)\b/i;
const UPDATE_RE = /\b(update|patch|version|ver\.?\s*\d|v\d+\.\d+)\b/i;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
async function findGamePageFromTag(page, gameName) {
  const normalizedName = cleanText(gameName).toLowerCase();

  return await page.evaluate((target) => {
    const normalize = value =>
      String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

    const links = [...document.querySelectorAll('a[href]')];

    const exact = links.find(a =>
      normalize(a.textContent) === target
    );

    return exact?.href || null;
  }, normalizedName);
}

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isPrivateIp(ip) {
  if (!net.isIP(ip)) return false;

  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0
    );
  }

  const normalized = ip.toLowerCase();
  return (
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  );
}

async function assertSafePublicUrl(value) {
  if (!isHttpUrl(value)) {
    throw new Error('URL não HTTP(S).');
  }

  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();

  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.local')) {
    throw new Error('Host local bloqueado.');
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error('IP privado bloqueado.');
    }
    return;
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });

  if (!addresses.length) {
    throw new Error('Host sem resolução DNS.');
  }

  if (addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error('Host resolve para IP privado.');
  }
}

function normalizeUrl(raw, baseUrl) {
  try {
    const url = new URL(raw, baseUrl);
    if (!/^https?:$/i.test(url.protocol)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function scoreCandidate(item, pageUrl) {
  const href = item.href || '';
  const text = cleanText(item.text);
  const context = cleanText(item.context);
  const host = hostOf(href);

  if (!href || !isHttpUrl(href)) return -1000;
  if (DLSP_HOST_RE.test(host)) return -500;

  let score = 0;

  if (DOWNLOAD_HOST_HINTS.some(hint => host.includes(hint))) score += 8;
  if (DOWNLOAD_TEXT_RE.test(text)) score += 4;
  if (DOWNLOAD_TEXT_RE.test(context)) score += 3;
  if (/\.(pkg|zip|rar|7z)(?:$|[?#])/i.test(href)) score += 8;
  if (/download|mirror|file|link/i.test(href)) score += 2;

  if (/facebook|twitter|x\.com|instagram|youtube|telegram|discord|tiktok/i.test(host)) score -= 20;
  if (/wp-admin|login|register|privacy|terms|contact|about/i.test(href)) score -= 15;
  if (/\.jpg|\.jpeg|\.png|\.gif|\.webp|\.svg|\.css|\.js(?:$|\?)/i.test(href)) score -= 20;

  try {
    if (new URL(href).origin === new URL(pageUrl).origin) score -= 2;
  } catch {}

  return score;
}

function classifyCandidate(item) {
  const haystack = cleanText(`${item.text} ${item.context} ${item.href}`);

  if (DLC_RE.test(haystack)) return 'dlcs';
  if (UPDATE_RE.test(haystack)) return 'updates';
  return 'base';
}

async function extractLinks(page, pageUrl) {
  const items = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('a[href], [data-href], [data-url]'));
    const result = [];

    for (const node of nodes) {
      let raw = node.getAttribute('href') || node.getAttribute('data-href') || node.getAttribute('data-url') || '';
      const onclick = node.getAttribute('onclick') || '';

      if (!raw && onclick) {
        const match = onclick.match(/https?:\/\/[^'"\s)]+/i);
        if (match) raw = match[0];
      }

      const text = (node.innerText || node.textContent || '').trim();
      const parent = node.closest('li, tr, td, p, article, .download, .links, .entry-content, .post-content');
      const context = parent ? (parent.innerText || parent.textContent || '').trim() : '';

      if (raw) {
        result.push({ raw, text, context });
      }
    }

    return result;
  });

  const candidates = [];
  const seen = new Set();

  for (const item of items) {
    const href = normalizeUrl(item.raw, pageUrl);
    if (!href || seen.has(href)) continue;

    const candidate = {
      href,
      text: cleanText(item.text) || 'Link encontrado',
      context: cleanText(item.context)
    };

    const score = scoreCandidate(candidate, pageUrl);
    if (score < 2) continue;

    seen.add(href);
    candidates.push({ ...candidate, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, MAX_CANDIDATES);
}

async function resolvePublicLink(page, originalUrl, depth = 0) {
  await assertSafePublicUrl(originalUrl);

  const beforeHost = hostOf(originalUrl);
  let finalUrl = originalUrl;
  let title = '';
  let status = null;

  try {
    const response = await page.goto(originalUrl, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT
    });

    status = response?.status?.() ?? null;
    await new Promise(resolve => setTimeout(resolve, 900));

const response = await page.goto(url, {
  waitUntil: 'domcontentloaded',
  timeout: NAV_TIMEOUT
});

await new Promise(resolve => setTimeout(resolve, 1200));

const isTagPage = new URL(url).pathname.startsWith('/tag/');

if (isTagPage) {
  const gameName = titleId;

  const gamePageUrl = await findGamePageFromTag(page, gameName);

  if (!gamePageUrl) {
    throw new Error(
      `Não encontrei a página individual de "${gameName}" na página de tag.`
    );
  }

  await page.goto(gamePageUrl, {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT
  });

  await new Promise(resolve => setTimeout(resolve, 1200));
}

    finalUrl = page.url() || originalUrl;
    title = cleanText(await page.title().catch(() => ''));
  } catch (error) {
    return {
      success: false,
      url: null,
      host: null,
      error: error.message || 'Falha de navegação.'
    };
  }

  if (!isHttpUrl(finalUrl)) {
    return {
      success: false,
      url: null,
      host: null,
      error: 'A navegação terminou em uma URL não HTTP(S).'
    };
  }

  try {
    await assertSafePublicUrl(finalUrl);
  } catch (error) {
    return {
      success: false,
      url: null,
      host: null,
      error: error.message
    };
  }

  const finalHost = hostOf(finalUrl);
  const changedHost = finalHost !== beforeHost;
  const looksLikeDownloadHost = DOWNLOAD_HOST_HINTS.some(hint => finalHost.includes(hint));
  const looksLikeFile = /\.(pkg|zip|rar|7z)(?:$|[?#])/i.test(finalUrl);

  if (changedHost || looksLikeDownloadHost || looksLikeFile) {
    return {
      success: true,
      url: finalUrl,
      host: finalHost,
      status,
      title
    };
  }

  if (depth >= MAX_HOPS) {
    return {
      success: false,
      url: null,
      host: finalHost,
      status,
      title,
      error: 'Não foi possível resolver além do limite de redirecionamentos públicos.'
    };
  }

  const nested = await extractLinks(page, finalUrl);
  const next = nested.find(item => hostOf(item.href) !== finalHost);

  if (!next) {
    return {
      success: true,
      url: finalUrl,
      host: finalHost,
      status,
      title
    };
  }

  return resolvePublicLink(page, next.href, depth + 1);
}

async function launchBrowser() {
  const isVercel = Boolean(process.env.VERCEL);

  if (!isVercel && process.env.CHROMIUM_EXECUTABLE_PATH) {
    return puppeteer.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }

  if (!isVercel) {
    return puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }

  return puppeteer.launch({
    args: await puppeteer.defaultArgs({
      args: chromium.args,
      headless: 'shell'
    }),
    defaultViewport: {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      isLandscape: true
    },
    executablePath: await chromium.executablePath(),
    headless: 'shell'
  });
}

async function scrapeDLSP({ url, titleId = '' }) {
  const parsed = new URL(url);

  if (!DLSP_HOST_RE.test(parsed.hostname)) {
    throw new Error('A URL precisa ser do domínio DLPSGame.');
  }

  await assertSafePublicUrl(url);

  const browser = await launchBrowser();
  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  page.setDefaultTimeout(12000);

  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153 Safari/537.36'
  );

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8'
  });

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT
    });

    await new Promise(resolve => setTimeout(resolve, 1200));

    const pageTitle = cleanText(await page.title().catch(() => ''));
    const finalPageUrl = page.url() || url;
    const pageText = cleanText(await page.evaluate(() => document.body?.innerText || '').catch(() => ''));

    const challengeDetected = /(^|\b)(captcha|verify you are human|checking your browser|just a moment|access denied|attention required)(\b|$)/i.test(
      `${pageTitle} ${pageText.slice(0, 5000)}`
    );

    if (challengeDetected) {
      throw new Error('A página apresentou uma proteção/captcha e não foi processada.');
    }

    const links = await extractLinks(page, finalPageUrl);

    const result = {
      success: true,
      titleId: titleId || null,
      game: {
        title: pageTitle || titleId || 'Jogo',
        sourceUrl: finalPageUrl
      },
      links: {
        base: [],
        updates: [],
        dlcs: []
      },
      stats: {
        found: links.length,
        resolved: 0,
        failed: 0
      }
    };

    // Resolve sequentially so one problematic host cannot stop the rest.
    for (const item of links) {
      const type = classifyCandidate(item);
      const resolved = await resolvePublicLink(page, item.href);

      if (resolved.success) {
        result.stats.resolved += 1;
      } else {
        result.stats.failed += 1;
      }

      result.links[type].push({
        originalUrl: item.href,
        text: item.text,
        type,
        resolved
      });
    }

    return result;
  } finally {
    try {
      await browser.close();
    } catch (error) {
      console.warn('Falha ao fechar Chromium:', error.message);
    }
  }
}

module.exports = {
  scrapeDLSP
};
