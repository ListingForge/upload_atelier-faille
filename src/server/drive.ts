// Google-Drive-Zugriff per Service-Account (read-only).
//
// Kein OAuth-Consent-Flow, keine öffentlichen Links: der Service-Account-Key
// kommt entweder als Pfad (GOOGLE_SERVICE_ACCOUNT_FILE, bevorzugt) oder inline
// (GOOGLE_SERVICE_ACCOUNT_JSON); der Drive-Ordner ist mit der Service-Account-
// Mail als Reader geteilt. JWT wird mit `jose` (RS256) signiert und gegen ein
// Access-Token getauscht — keine googleapis-Lib nötig.
//
// WICHTIG: Die Inline-Variante NICHT über systemd EnvironmentFile laden — systemd
// mangelt die \n-Escapes im PEM-Key, der Key wird unbrauchbar (asn1 header too
// long). Darum in Prod die FILE-Variante nutzen (nur ein kurzer Pfad in der Env).

import { readFileSync } from "fs";
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
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  let raw: string | undefined;
  let src: string;
  if (file) {
    try {
      raw = readFileSync(file, "utf8");
    } catch (e: any) {
      throw new Error(`GOOGLE_SERVICE_ACCOUNT_FILE ${file} nicht lesbar: ${e.message}`);
    }
    src = `GOOGLE_SERVICE_ACCOUNT_FILE (${file})`;
  } else {
    raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    src = "GOOGLE_SERVICE_ACCOUNT_JSON";
  }
  if (!raw) throw new Error("Weder GOOGLE_SERVICE_ACCOUNT_FILE noch GOOGLE_SERVICE_ACCOUNT_JSON gesetzt");
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${src} ist kein gültiges JSON`);
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(`${src}: client_email/private_key fehlt`);
  }
  // Defensive: falls \n als Literal (2 Zeichen) durchkommt, zu echten Newlines
  // machen — sonst scheitert importPKCS8 mit asn1-Fehler.
  const private_key = String(parsed.private_key).replace(/\\n/g, "\n");
  cachedSa = { client_email: parsed.client_email, private_key };
  return cachedSa;
}

export function driveConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_FILE || process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
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

const FOLDER_MIME = "application/vnd.google-apps.folder";

// Direkte Kinder eines Ordners auflisten (Bilder + Unterordner), paginiert.
async function driveListChildren(token: string, folderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false and (mimeType contains 'image/' or mimeType='${FOLDER_MIME}')`,
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

// Bilddateien in einem Ordner auflisten, rekursiv durch Unterordner (max. Tiefe 8;
// die Kollektionen liegen teils direkt, teils in einem upscayl-Unterordner).
export async function driveListImages(folderId: string): Promise<DriveFile[]> {
  const token = await getAccessToken();
  const images: DriveFile[] = [];
  const seen = new Set<string>();
  async function walk(id: string, depth: number): Promise<void> {
    if (depth > 8 || seen.has(id)) return;
    seen.add(id);
    const children = await driveListChildren(token, id);
    const subfolders: string[] = [];
    for (const c of children) {
      if (c.mimeType === FOLDER_MIME) subfolders.push(c.id);
      else images.push(c);
    }
    for (const sub of subfolders) await walk(sub, depth + 1);
  }
  await walk(folderId, 0);
  return images;
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
