// Google-Drive-Zugriff per Service-Account (read-only).
//
// Kein OAuth-Consent-Flow, keine öffentlichen Links: der Service-Account-Key
// steckt in der Env GOOGLE_SERVICE_ACCOUNT_JSON, und der Drive-Ordner ist mit
// der Service-Account-Mail als Reader geteilt. JWT wird mit `jose` (RS256)
// signiert und gegen ein Access-Token getauscht — keine googleapis-Lib nötig.

import { importPKCS8, SignJWT } from "jose";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

let cachedSa: ServiceAccount | null = null;
let tokenCache: { token: string; exp: number } | null = null;

function loadServiceAccount(): ServiceAccount {
  if (cachedSa) return cachedSa;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON nicht gesetzt");
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON ist kein gültiges JSON");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Service-Account-JSON fehlt client_email/private_key");
  }
  cachedSa = { client_email: parsed.client_email, private_key: parsed.private_key };
  return cachedSa;
}

export function driveConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.exp - 60 > now) return tokenCache.token;

  const sa = loadServiceAccount();
  const key = await importPKCS8(sa.private_key, "RS256");
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!r.ok) throw new Error(`Google-Token-Fehler ${r.status}: ${await r.text()}`);
  const j: any = await r.json();
  tokenCache = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return j.access_token;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

// Bilddateien in einem Ordner auflisten (inkl. Shared Drives, paginiert).
export async function driveListImages(folderId: string): Promise<DriveFile[]> {
  const token = await getAccessToken();
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false and mimeType contains 'image/'`,
      fields: "nextPageToken,files(id,name,mimeType)",
      pageSize: "1000",
      orderBy: "name_natural",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Drive-List-Fehler ${r.status}: ${await r.text()}`);
    const j: any = await r.json();
    for (const f of j.files || []) files.push(f);
    pageToken = j.nextPageToken;
  } while (pageToken);
  return files;
}

// Datei-Inhalt als Buffer holen (alt=media).
export async function driveDownload(fileId: string): Promise<Buffer> {
  const token = await getAccessToken();
  const params = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) throw new Error(`Drive-Download-Fehler ${r.status}: ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}
