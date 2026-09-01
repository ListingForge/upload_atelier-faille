// Zentrale fetch-Resilienz: Timeout pro Versuch + Exponential-Backoff auf
// 429/5xx, respektiert `Retry-After`. Eingefuehrt 2026-09-01 (Uploader-Review
// U2/U3: Printify/Shopify rate-limiten, ein haengendes fetch blockierte bisher
// die ganze Pipeline).

export interface RetryOpts {
  timeoutMs?: number;   // Timeout pro Einzelversuch
  retries?: number;     // zusaetzliche Versuche nach dem ersten
  retryOn?: number[];   // HTTP-Status, die einen Retry ausloesen
  label?: string;       // fuer Logausgaben
}

const DEFAULT_RETRY_ON = [408, 429, 500, 502, 503, 504];

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: RetryOpts = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const retries = opts.retries ?? 3;
  const retryOn = opts.retryOn ?? DEFAULT_RETRY_ON;
  let label = opts.label;
  if (!label) {
    try { label = new URL(url).host; } catch { label = "fetch"; }
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      if (attempt < retries && retryOn.includes(res.status)) {
        const wait = retryAfterMs(res) ?? backoffMs(attempt);
        console.warn(`[retry] ${label} HTTP ${res.status} — Versuch ${attempt + 1}/${retries + 1}, warte ${wait}ms`);
        await sleep(wait);
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) {
        const wait = backoffMs(attempt);
        const name = (e as Error)?.name || "Fehler";
        console.warn(`[retry] ${label} ${name} — Versuch ${attempt + 1}/${retries + 1}, warte ${wait}ms`);
        await sleep(wait);
        continue;
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`fetchWithRetry(${label}) nach ${retries + 1} Versuchen fehlgeschlagen`);
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (!Number.isNaN(secs)) return Math.min(secs * 1000, 30_000);
  const when = Date.parse(h);
  return Number.isNaN(when) ? null : Math.max(0, Math.min(when - Date.now(), 30_000));
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000) + Math.floor(Math.random() * 400);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
