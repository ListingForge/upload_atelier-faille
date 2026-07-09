# Graph Report - Atelier Faille Upload Programm  (2026-07-09)

## Corpus Check
- 30 files · ~30,365 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 288 nodes · 358 edges · 19 communities (17 shown, 2 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 3 edges (avg confidence: 0.7)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b0f1ee21`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_security-auditor|security-auditor.md]]
- [[_COMMUNITY_Deployment auf Hetzner|Deployment auf Hetzner]]
- [[_COMMUNITY_EditorPage.tsx|EditorPage.tsx]]
- [[_COMMUNITY_Run and deploy your AI Studio app|Run and deploy your AI Studio app]]

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 15 edges
2. `Deployment auf Hetzner` - 10 edges
3. `UploadPage()` - 9 edges
4. `createMockupsRouter()` - 9 edges
5. `Prüfliste (vollständig durchgehen)` - 9 edges
6. `scripts` - 8 edges
7. `Persistent Agent Memory` - 8 edges
8. `Persistent Agent Memory` - 8 edges
9. `Persistent Agent Memory` - 8 edges
10. `Orientation` - 7 edges

## Surprising Connections (you probably didn't know these)
- `MockupRenderPage()` --references--> `jszip`  [EXTRACTED]
  src/components/MockupRenderPage.tsx → package.json
- `EditorPage()` --calls--> `load()`  [INFERRED]
  src/components/EditorPage.tsx → src/server/tokenStore.ts
- `MockupListsPage()` --calls--> `load()`  [INFERRED]
  src/components/MockupListsPage.tsx → src/server/tokenStore.ts
- `Design` --references--> `Orientation`  [EXTRACTED]
  src/components/MockupRenderPage.tsx → src/types.ts
- `Job` --references--> `Orientation`  [EXTRACTED]
  src/components/MockupRenderPage.tsx → src/types.ts

## Import Cycles
- None detected.

## Communities (19 total, 2 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.11
Nodes (23): jszip, TileProps, Design, detectOrientation(), fetchBlob(), Job, MockupRenderPage(), ScopeFilter (+15 more)

### Community 1 - "Community 1"
Cohesion: 0.08
Nodes (14): NAV, Tab, BulkEditModal(), BulkEditorPage(), downscaleImageFile(), fileToDataUrl(), ImageChange, ModalProps (+6 more)

### Community 2 - "Community 2"
Cohesion: 0.13
Nodes (21): app, MockupListsPage(), createGeminiRouter(), SYSTEM_PROMPT, activeShop(), createShopifyRouter(), gql(), inchLabelToCm() (+13 more)

### Community 3 - "Community 3"
Cohesion: 0.24
Nodes (11): createPrintifyRouter(), CreateProductInput, FrameColor, loadCatalog(), loadPricing(), Orientation, pf(), ProductType (+3 more)

### Community 4 - "Community 4"
Cohesion: 0.17
Nodes (16): createMockupsRouter(), DATA_DIR, deleteThumb(), ensureDirs(), ensureThumb(), Index, INDEX_FILE, isOrientation() (+8 more)

### Community 5 - "Community 5"
Cohesion: 0.12
Nodes (16): compilerOptions, allowImportingTsExtensions, allowJs, experimentalDecorators, isolatedModules, jsx, lib, module (+8 more)

### Community 6 - "Community 6"
Cohesion: 0.07
Nodes (28): dependencies, ag-psd, @dnd-kit/core, @dnd-kit/sortable, @dnd-kit/utilities, dotenv, express, lucide-react (+20 more)

### Community 7 - "Community 7"
Cohesion: 0.08
Nodes (25): 1. Externe Assets & Schriften, 2. Tracking, Analytics, Maps, 3. Drittlandtransfer (insb. USA), 4. Cookies & lokaler Speicher, 5. Datenminimierung, 6. Personenbezogene Daten in URLs/Logs, 7. IP-Adressen, 8. Verarbeitungszwecke und Speicherdauer (+17 more)

### Community 8 - "Community 8"
Cohesion: 0.26
Nodes (8): buildRenderScript(), isMostlyBlack(), PhotopeaRenderer, readImageDimensions(), RenderInput, RenderOutput, sendCommand(), startBackgroundKeepalive()

### Community 9 - "Community 9"
Cohesion: 0.17
Nodes (12): devDependencies, autoprefixer, esbuild, tailwindcss, tsx, @types/express, @types/multer, @types/node (+4 more)

### Community 10 - "Community 10"
Cohesion: 0.60
Nodes (5): basicAuth(), isPublic(), loadCredentials(), PUBLIC_PATHS, timingSafeEqual()

### Community 11 - "Community 11"
Cohesion: 0.33
Nodes (6): HERE, INDEX, MOCKUPS, ROOT, schedule(), sync()

### Community 12 - "Community 12"
Cohesion: 0.10
Nodes (20): Agent Memory, API & Interface Design, Before recommending from memory, Correctness & Logic, How to save memories, Invocation Protocol, Maintainability & Readability, Memory and other forms of persistence (+12 more)

### Community 15 - "security-auditor.md"
Cohesion: 0.12
Nodes (16): Agent Memory, Ausgabeformat, Before recommending from memory, Deine Mission, How to save memories, Klassifizierungsleitlinien, Memory and other forms of persistence, MEMORY.md (+8 more)

### Community 16 - "Deployment auf Hetzner"
Cohesion: 0.18
Nodes (10): 1. DNS, 2. Code auf Server bringen, 3. `.env.local` auf dem Server, 4. systemd-Service, 5. nginx Reverse Proxy, 6. HTTPS via certbot, 7. Shopify-App neu konfigurieren, 8. Updates deployen (+2 more)

### Community 17 - "EditorPage.tsx"
Cohesion: 0.33
Nodes (4): EditorPage(), ProductNode, ProductsPage, Variant

## Knowledge Gaps
- **158 isolated node(s):** `name`, `private`, `version`, `type`, `dev` (+153 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `load()` connect `Community 2` to `EditorPage.tsx`?**
  _High betweenness centrality (0.195) - this node is a cross-community bridge._
- **Why does `MockupListsPage()` connect `Community 2` to `Community 0`?**
  _High betweenness centrality (0.188) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Community 6` to `Community 0`?**
  _High betweenness centrality (0.150) - this node is a cross-community bridge._
- **What connects `name`, `private`, `version` to the rest of the system?**
  _158 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.11088709677419355 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.07635467980295567 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.13105413105413105 - nodes in this community are weakly interconnected._