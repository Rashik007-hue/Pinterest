// language: JavaScript (Node.js), file: api/search.js
// target: Vercel Serverless Function (Node.js 18+)
// purpose: Pinterest inline image search via internal BaseSearchResource API.
//          Returns normalized JSON with owner tag.

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const PINTEREST_BASE = "https://www.pinterest.com";
const SEARCH_RESOURCE = "BaseSearchResource";
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 12000;

// ---------------------------------------------------------------------------
// OWNER — appears in every JSON response
// ---------------------------------------------------------------------------

const OWNER = "@RASHIK_69";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json, text/javascript, */*, q=0.01",
  "Accept-Language": "en-US,en;q=0.9",
  "X-Requested-With": "XMLHttpRequest",
  "X-Pinterest-AppState": "active",
  "X-Pinterest-PWS-Handler": "www/search/[scope].js",
  "X-Pinterest-Source-Url": "/search/pins/",
  "X-APP-VERSION": "7a5c9b1",
  Referer: "https://www.pinterest.com/search/pins/",
  Origin: "https://www.pinterest.com",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function buildResourceUrl(query, pageSize, bookmark, scope = "pins") {
  const sourceUrl = `/search/${scope}/?q=${encodeURIComponent(query)}`;

  const dataPayload = {
    options: {
      query: query,
      scope: scope,
      rs: "typed",
      filters: null,
      bookmarks: bookmark ? [bookmark] : [],
      page_size: pageSize,
    },
    context: {},
  };

  const params = new URLSearchParams({
    source_url: sourceUrl,
    data: JSON.stringify(dataPayload),
    _: Date.now().toString(),
  });

  return `${PINTEREST_BASE}/resource/${SEARCH_RESOURCE}/get/?${params.toString()}`;
}

function pickBestImage(pin) {
  const images = pin.images || {};
  const order = ["orig", "736x", "564x", "474x", "236x", "170x"];
  for (const key of order) {
    if (images[key]?.url) return images[key].url;
  }
  return pin.image || pin.image_url || null;
}

function pickThumbnail(pin) {
  const images = pin.images || {};
  const order = ["236x", "170x", "474x"];
  for (const key of order) {
    if (images[key]?.url) return images[key].url;
  }
  return pickBestImage(pin);
}

function normalizePin(pin) {
  const image = pickBestImage(pin);
  if (!image) return null;

  return {
    id: pin.id || null,
    image: image,
    thumbnail: pickThumbnail(pin),
    title: (pin.title || pin.grid_title || pin.description || "").trim(),
    description: (pin.description || "").trim(),
    link: pin.id ? `https://www.pinterest.com/pin/${pin.id}/` : null,
    destination: pin.link || null,
    width: pin.images?.orig?.width || null,
    height: pin.images?.orig?.height || null,
    pinner: pin.pinner?.username || null,
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// HANDLER
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      owner: OWNER,
      error: "Method not allowed. Use GET.",
    });
  }

  const query = (req.query.q || req.query.query || "").trim();
  if (!query) {
    return res.status(400).json({
      owner: OWNER,
      error: "Missing query parameter.",
      usage: "/api/search?q=flowers&limit=25",
    });
  }

  let limit = parseInt(req.query.limit || req.query.page_size, 10);
  if (isNaN(limit) || limit <= 0) limit = DEFAULT_PAGE_SIZE;
  if (limit > MAX_PAGE_SIZE) limit = MAX_PAGE_SIZE;

  const bookmark = (req.query.bookmark || "").trim() || null;
  const scope = (req.query.scope || "pins").trim();

  const url = buildResourceUrl(query, limit, bookmark, scope);

  let pinterestRes;
  try {
    pinterestRes = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: BROWSER_HEADERS,
        redirect: "follow",
      },
      REQUEST_TIMEOUT_MS
    );
  } catch (err) {
    const reason = err.name === "AbortError" ? "timeout" : err.message;
    return res.status(502).json({
      owner: OWNER,
      error: "Upstream request failed.",
      reason,
      hint: "Pinterest may be rate-limiting this server's IP. Retry later.",
    });
  }

  if (!pinterestRes.ok) {
    return res.status(pinterestRes.status).json({
      owner: OWNER,
      error: "Pinterest returned non-200.",
      status: pinterestRes.status,
      hint:
        pinterestRes.status === 403
          ? "Pinterest blocked the request. Headers may be stale — update X-APP-VERSION."
          : "Retry or change query.",
    });
  }

  let raw;
  try {
    raw = await pinterestRes.json();
  } catch (err) {
    return res.status(502).json({
      owner: OWNER,
      error: "Pinterest returned invalid JSON.",
      reason: err.message,
    });
  }

  const data = raw?.resource_response?.data;
  if (!data || !Array.isArray(data.results)) {
    return res.status(200).json({
      owner: OWNER,
      success: true,
      query,
      count: 0,
      next_bookmark: null,
      images: [],
      note: "No results found or Pinterest changed response shape.",
    });
  }

  const images = data.results
    .map(normalizePin)
    .filter(Boolean)
    .slice(0, limit);

  const nextBookmark =
    raw?.resource_response?.bookmark ||
    data.bookmark ||
    (data.bookmarks && data.bookmarks[0]) ||
    null;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");

  return res.status(200).json({
    owner: OWNER,
    success: true,
    query,
    count: images.length,
    next_bookmark: nextBookmark,
    images,
  });
}
