const dns = require('node:dns').promises;
const net = require('node:net');
const path = require('path');
const fs = require('fs');

const DLSP_HOST_RE = /(^|\.)dlpsgame\.com$/i;
const MAX_CANDIDATES = 60;
const MAX_HOPS = 2;
const NAV_TIMEOUT = 25000;
const CAPTCHA_TIMEOUT = 120000; // 2 minutos para resolução manual/serviço

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

// Seletores comuns de CAPTCHA
const CAPTCHA_SELECTORS = [
  '.g-recaptcha',
  '[data-sitekey]',
  '.h-captcha',
  '#captcha',
  '.captcha',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  '.challenge-form',
  '#challenge-form',
  '[class*="captcha"]',
  '[id*="captcha"]'
];

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function findGamePageFromTag(page, gameName, tagUrl) {
  const normalizedName = cleanText(gameName).toLowerCase();

  let tagSlug = '';
  try {
    const pathname = new URL(tagUrl).pathname;
    tagSlug = pathname
      .replace(/^\/tag\//i, '')
      .replace(/\/$/, '')
      .replace(/-/g, ' ')
      .trim()
      .toLowerCase();
  } catch {}

  return await page.evaluate(({ target, slug }) => {
    const normalize = value =>
      String(value || '')
        .replace(/\\s+/g, ' ')
        .trim()
        .toLowerCase();

    const slugify = value =>
      normalize(value)
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

    const links = [...document.querySelectorAll('a[href]')];

    const exact = target
      ? links.find(a => normalize(a.textContent) === target)
      : null;

    if (exact?.href) return exact.href;

    const slugMatch = slug
      ? links.find(a => {
          const textSlug = slugify(a.textContent);
          return textSlug === slugify(slug);
        })
      : null;

    return slugMatch?.href || null;
  }, { target: normalizedName, slug: tagSlug });
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
    const nodes = Array.from(document.querySelectorAll('a[href]'));
    const result = [];

    for (const node of nodes) {
      const raw = node.getAttribute('href') || '';
      const text = cleanText(node.innerText || node.textContent || '');
      const parent = node.closest('li, tr, td, p, article, .download, .links, .entry-content, .post-content');
      const context = cleanText(parent ? (parent.innerText || parent.textContent || '') : '');

      if (raw) result.push({ raw, text, context });
    }

    return result;
  });

  const candidates = [];
  const seen = new Set();

  for (const item of items) {
    const href = normalizeUrl(item.raw, pageUrl);
    if (!href || seen.has(href)) continue;

    const host = hostOf(href);
    if (!host || DLSP_HOST_RE.test(host)) continue;

    const candidate = {
      href,
      text: cleanText(item.text),
      context: cleanText(item.context)
    };

    const score = scoreCandidate(candidate, pageUrl);
    const recognizedHost = DOWNLOAD_HOST_HINTS.some(hint => host.includes(hint));
    const strongDownloadSignal =
      DOWNLOAD_TEXT_RE.test(candidate.text) ||
      DOWNLOAD_TEXT_RE.test(candidate.context) ||
      /\.(pkg|zip|rar|7z)(?:$|[?#])/i.test(href);

    if (!recognizedHost && !strongDownloadSignal) continue;
    if (score < 2) continue;

    seen.add(href);
    candidates.push({
      ...candidate,
      score,
      host
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, MAX_CANDIDATES);
}

// Detecta se há CAPTCHA na página
async function detectCaptcha(page) {
  return await page.evaluate((selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return { detected: true, selector, type: el.className || el.id || 'unknown' };
    }
    
    // Verifica texto também
    const bodyText = document.body?.innerText?.toLowerCase() || '';
    const captchaKeywords = ['captcha', 'verify you are human', 'i\'m not a robot', 'security check'];
    for (const keyword of captchaKeywords) {
      if (bodyText.includes(keyword)) return { detected: true, selector: null, type: 'text-detected' };
    }
    
    return { detected: false };
  }, CAPTCHA_SELECTORS);
}

// Placeholder para serviço de resolução de CAPTCHA
// Integrar com 2captcha, Anti-Captcha, etc.
async function solveCaptchaWithService(page, apiKey) {
  // TODO: Implementar integração com serviço de CAPTCHA
  // Exemplo de fluxo:
  // 1. Extrair sitekey do data-sitekey
  // 2. Enviar para API do serviço
  // 3. Aguardar token resolvido
  // 4. Injetar token na página
  
  throw new Error('Serviço de CAPTCHA não configurado. Configure CAPTCHA_API_KEY no .env');
}

async function resolvePublicLink(page, originalUrl, depth = 0, options = {}) {
  const { attemptCaptchaSolve = false, captchaApiKey = null } = options;
  
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
    
    // Aguarda mais tempo para scripts de CAPTCHA carregarem
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Verifica CAPTCHA
    const captchaInfo = await detectCaptcha(page);
    
    if (captchaInfo.detected) {
      console.log(`CAPTCHA detectado em ${originalUrl}: ${captchaInfo.type}`);
      
      if (attemptCaptchaSolve && captchaApiKey) {
        try {
          await solveCaptchaWithService(page, captchaApiKey);
          // Re-verifica após tentativa de resolução
          await new Promise(resolve => setTimeout(resolve, 3000));
          finalUrl = page.url() || originalUrl;
        } catch (captchaError) {
          return {
            success: false,
            url: null,
            host: null,
            error: `CAPTCHA não resolvido: ${captchaError.message}`,
            captchaDetected: true
          };
        }
      } else {
        return {
          success: false,
          url: null,
          host: null,
          error: 'CAPTCHA detectado. Use attemptCaptchaSolve=true e forneça captchaApiKey.',
          captchaDetected: true
        };
      }
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

  return resolvePublicLink(page, next.href, depth + 1, options);
}

async function launchBrowser() {
  const isVercel = Boolean(process.env.VERCEL);
  
  // Caminho para perfil persistente (fora do Vercel)
  const userDataDir = isVercel ? undefined : path.join(process.cwd(), '.browser-profile');
  
  // Cria diretório do perfil se não existir
  if (!isVercel && userDataDir && !fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  // Tenta carregar puppeteer-extra com stealth
  let puppeteer;
  try {
    const puppeteerExtra = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    puppeteer = puppeteerExtra;
    console.log('Stealth mode ativado');
  } catch (e) {
    console.warn('puppeteer-extra não instalado, usando puppeteer-core padrão');
    const puppeteerModule = await import('puppeteer-core');
    puppeteer = puppeteerModule.default || puppeteerModule;
  }

  // Viewport realista
  const viewport = {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    isLandscape: true
  };

  if (!isVercel && process.env.CHROMIUM_EXECUTABLE_PATH) {
    return puppeteer.launch({
      headless: false, // Headless real para evitar detecção
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
      userDataDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--start-maximized',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ],
      ignoreDefaultArgs: ['--enable-automation'], // Remove flag de automação
      defaultViewport: viewport
    });
  }

  if (!isVercel) {
    return puppeteer.launch({
      headless: false,
      userDataDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
        '--window-size=1920,1080',
        '--start-maximized'
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: viewport
    });
  }

  // Vercel - usa @sparticuz/chromium
  const chromiumModule = await import('@sparticuz/chromium');
  const chromium = chromiumModule.default || chromiumModule;

  return puppeteer.launch({
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080'
    ],
    defaultViewport: viewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    ignoreDefaultArgs: ['--enable-automation']
  });
}

async function scrapeDLSP({ url, titleId = '', gameName = '', attemptCaptcha = false }) {
  const parsed = new URL(url);

  if (!DLSP_HOST_RE.test(parsed.hostname)) {
    throw new Error('A URL precisa ser do domínio DLPSGame.');
  }

  await assertSafePublicUrl(url);

  const browser = await launchBrowser();
  const page = await browser.newPage();

  // Configurações anti-detecção adicionais
  await page.evaluateOnNewDocument(() => {
    // Remove webdriver flag
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
    
    // Spoof plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5]
    });
    
    // Spoof languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['pt-BR', 'pt', 'en-US', 'en']
    });
  });

  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  page.setDefaultTimeout(12000);

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0'
  });

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT
    });

    await new Promise(resolve => setTimeout(resolve, 1200));

    const isTagPage = new URL(url).pathname.startsWith('/tag/');

    if (isTagPage) {
      const gamePageUrl = await findGamePageFromTag(page, gameName, url);

      if (!gamePageUrl) {
        throw new Error(
          `Não encontrei a página individual de "${gameName || titleId}" na página de tag.`
        );
      }

      await page.goto(gamePageUrl, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT
      });

      await new Promise(resolve => setTimeout(resolve, 1200));
    }

    const pageTitle = cleanText(await page.title().catch(() => ''));
    const finalPageUrl = page.url() || url;
    const pageText = cleanText(await page.evaluate(() => document.body?.innerText || '').catch(() => ''));

    // Verificação de proteção/CF com detecção de CAPTCHA aprimorada
    const challengeDetected = /(^|\b)(captcha|verify you are human|checking your browser|just a moment|access denied|attention required|cloudflare|security check)(\b|$)/i.test(
      `${pageTitle} ${pageText.slice(0, 5000)}`
    );

    const captchaInfo = await detectCaptcha(page);

    if (challengeDetected || captchaInfo.detected) {
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

    // Cache para evitar resolver o mesmo URL várias vezes
    const resolutionCache = new Map();
    
    // Opções para resolução de links (inclui CAPTCHA se habilitado)
    const resolveOptions = {
      attemptCaptchaSolve: attemptCaptcha,
      captchaApiKey: process.env.CAPTCHA_API_KEY || null
    };

    for (const item of links) {
      const originalHref = item.href;
      
      let resolution;
      if (resolutionCache.has(originalHref)) {
        resolution = resolutionCache.get(originalHref);
      } else {
        try {
          resolution = await resolvePublicLink(page, originalHref, 0, resolveOptions);
          resolutionCache.set(originalHref, resolution);
        } catch (error) {
          resolution = {
            success: false,
            url: null,
            host: null,
            error: error.message || 'Erro ao resolver link.',
            captchaDetected: false
          };
          resolutionCache.set(originalHref, resolution);
        }
      }

      const type = classifyCandidate(item);
      
      const linkEntry = {
        url: resolution.success && resolution.url ? resolution.url : originalHref,
        host: resolution.success && resolution.host ? resolution.host : item.host,
        text: item.text,
        type,
        resolved: resolution.success,
        error: resolution.error || null,
        captchaDetected: resolution.captchaDetected || false
      };

      result.links[type].push(linkEntry);

      if (resolution.success) {
        result.stats.resolved++;
      } else {
        result.stats.failed++;
      }
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
  scrapeDLSP,
  detectCaptcha
};
