# Deployment auf Hetzner

Ziel: Die App läuft unter `https://upload.atelier-faille.de` auf einem Hetzner-Server, gestartet als systemd-Service, hinter nginx mit Let's-Encrypt-Zertifikat. Deploys per `git pull` (oder GitHub Actions, falls gewünscht).

Voraussetzungen auf dem Server:
- Ubuntu/Debian
- Root- oder sudo-Zugang
- Node.js ≥ 20 (`node -v`)
- `git`, `nginx`, `certbot`

---

## 1. DNS

A-Record `upload.atelier-faille.de` → IP des Hetzner-Servers. Mit `dig upload.atelier-faille.de +short` prüfen, dass es zeigt was es soll, bevor Du weitermachst (sonst scheitert certbot).

## 2. Code auf Server bringen

```bash
sudo mkdir -p /var/www/atelier-faille-upload
sudo chown $USER:$USER /var/www/atelier-faille-upload
cd /var/www/atelier-faille-upload
git clone <DEIN_GITHUB_REPO_URL> .
npm install
npm run build
```

`npm run build` erzeugt `dist/` (Frontend) und `dist/server.cjs` (Backend-Bundle).

## 3. `.env.local` auf dem Server

Datei `/var/www/atelier-faille-upload/.env.local` anlegen:

```env
APP_URL=https://upload.atelier-faille.de
PORT=3000
NODE_ENV=production

BASIC_AUTH_USER=admin
BASIC_AUTH_PASS=<langes-zufaelliges-passwort>

SHOPIFY_API_KEY=<dein-shopify-api-key>
SHOPIFY_API_SECRET=<dein-shopify-api-secret>
SHOPIFY_SCOPES=read_products,write_products,read_product_listings,read_files,write_files,read_inventory,write_inventory,read_publications,write_publications
SHOPIFY_STORE=nvh6nq-0w.myshopify.com
SHOPIFY_ADMIN_TOKEN=

PRINTIFY_API_TOKEN=<dein-printify-token>
PRINTIFY_SHOP_ID=27447119
```

`chmod 600 .env.local`.

## 4. systemd-Service

`/etc/systemd/system/atelier-faille-upload.service`:

```ini
[Unit]
Description=Atelier Faille Upload Programm
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/atelier-faille-upload
EnvironmentFile=/var/www/atelier-faille-upload/.env.local
ExecStart=/usr/bin/node dist/server.cjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Aktivieren:

```bash
sudo chown -R www-data:www-data /var/www/atelier-faille-upload
sudo systemctl daemon-reload
sudo systemctl enable --now atelier-faille-upload
sudo systemctl status atelier-faille-upload
journalctl -u atelier-faille-upload -f
```

## 5. nginx Reverse Proxy

`/etc/nginx/sites-available/upload.atelier-faille.de`:

```nginx
server {
    listen 80;
    server_name upload.atelier-faille.de;

    client_max_body_size 200M;   # für PSD- und Bild-Uploads

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/upload.atelier-faille.de /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 6. HTTPS via certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d upload.atelier-faille.de
```

certbot patcht die nginx-Config und richtet auto-renewal ein.

## 7. Shopify-App neu konfigurieren

Im Shopify Dev Dashboard die App `Atelier Faille Upload` öffnen und sicherstellen:

- **App-URL:** `https://upload.atelier-faille.de/api/shopify/install`
- **Weiterleitungs-URLs (Redirect URLs):** `https://upload.atelier-faille.de/api/shopify/callback`
- Scopes wie in `.env`
- Speichern → **Install on store** klicken
- Du wirst gefragt nach Basic-Auth (für den Install-Endpoint ist das aber whitelisted, sollte direkt zu Shopify redirecten)
- Shopify-Berechtigungsdialog bestätigen
- Du landest auf der Success-Seite → Token ist in `data/tokens.json` gespeichert

Danach `curl -u admin:PASS https://upload.atelier-faille.de/api/shopify/status` zeigt `hasToken: true`.

## 8. Updates deployen

```bash
cd /var/www/atelier-faille-upload
git pull
npm install
npm run build
sudo systemctl restart atelier-faille-upload
```

## 9. Remote-MCP für claude.ai (Web-Connector)

Die App stellt einen Remote-MCP-Endpoint bereit, mit dem Claude im Browser
(claude.ai) Designs fernsteuern und hochladen kann. Auth läuft über einen
eingebauten OAuth-2.1-Server (getrennt von Basic Auth — claude.ai kann kein
Basic Auth senden).

**a) Env ergänzen** in `/var/www/atelier-faille-upload/.env.local`:

```env
MCP_OAUTH_SECRET=<openssl rand -hex 32>
MCP_LOGIN_PASSWORD=<passwort-das-du-beim-connector-login-eingibst>
```

`APP_URL` muss korrekt gesetzt sein (`https://upload.atelier-faille.de`) — daraus
wird Issuer + Resource (`APP_URL/mcp`) abgeleitet. Danach
`sudo systemctl restart atelier-faille-upload`.

**b) nginx**: Die vorhandene `location /` proxyt bereits alle MCP-Pfade
(`/mcp`, `/authorize`, `/token`, `/register`, `/.well-known/*`). Für den
MCP-Stream Buffering abschalten — Block VOR `location /` einfügen:

```nginx
    location /mcp {
        proxy_pass http://127.0.0.1:3001;   # tatsächlicher App-Port (Prod: 3001)
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 900s;   # upload_design pollt bis zu 10 min auf Shopify
    }
```

`sudo nginx -t && sudo systemctl reload nginx`.

**c) In claude.ai verbinden**: Einstellungen → Connectors → *Custom Connector
hinzufügen* → URL `https://upload.atelier-faille.de/mcp` → Claude startet den
OAuth-Flow → Login-Seite erscheint → `MCP_LOGIN_PASSWORD` eingeben → fertig.
Danach stehen die Tools `list_mockups`, `render_preview`, `upload_design` im
Chat zur Verfügung. `upload_design` ohne `dryRun` erstellt **echte** Produkte im
Live-Shop.

**Smoke-Test** (ohne Browser):

```bash
curl https://upload.atelier-faille.de/.well-known/oauth-protected-resource
# -> JSON mit resource=https://upload.atelier-faille.de/mcp
curl -i -X POST https://upload.atelier-faille.de/mcp
# -> 401 + Header  WWW-Authenticate: Bearer resource_metadata="..."
```

> Der separate stdio-Server unter `mcp/` bleibt für **Claude Desktop / Claude
> Code** (lokal). Der Remote-Endpoint hier ist ausschließlich für claude.ai-Web.

## 10. Optional: GitHub Actions Auto-Deploy

In `.github/workflows/deploy.yml` (später, wenn Du es magst):

```yaml
on: { push: { branches: [main] } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_KEY }}
          script: |
            cd /var/www/atelier-faille-upload
            git pull
            npm install
            npm run build
            sudo systemctl restart atelier-faille-upload
```
