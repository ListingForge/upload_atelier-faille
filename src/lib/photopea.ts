// Photopea iframe bridge — replaces a layer named "Smart Object" in a PSD with the
// given image and exports the result. Battle-tested approach ported from listingforge.
//
// Key facts about Photopea's postMessage API:
// - The iframe responds with "done" after each top-level operation.
// - Complex scripts (flatten, save, close, saveToOE) emit MULTIPLE "done" messages.
//   When awaiting a binary export, we must wait for "done" AFTER an ArrayBuffer has arrived.
// - Binary exports arrive as ArrayBuffer messages right before their final "done".
// - Errors are surfaced via `app.echoToOE("error: ...")` from inside our script.

const PHOTOPEA_ORIGIN = "https://www.photopea.com";

export interface RenderInput {
  psd: Blob;
  image: Blob;
  smartObjectLayerName?: string; // default: "Smart Object"
  outputFormat?: "jpg" | "png";  // default: jpg (much smaller)
}

export interface RenderOutput {
  blob: Blob;
  width: number;
  height: number;
}

function sendCommand(
  iframeWin: Window,
  command: string | ArrayBuffer,
  timeoutMs = 120_000,
  expectArrayBuffer = false
): Promise<{ buffers: ArrayBuffer[] }> {
  return new Promise((resolve, reject) => {
    const buffers: ArrayBuffer[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Photopea timeout (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    const handler = (e: MessageEvent) => {
      try {
        if (e.source !== iframeWin) return;
      } catch {
        return;
      }
      if (e.data instanceof ArrayBuffer) {
        buffers.push(e.data);
        return;
      }
      if (typeof e.data === "string" && e.data === "done") {
        if (expectArrayBuffer && buffers.length === 0) return; // wait for binary
        cleanup();
        resolve({ buffers });
        return;
      }
      if (typeof e.data === "string" && e.data.startsWith("error:")) {
        cleanup();
        reject(new Error(`Photopea script error: ${e.data}`));
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", handler);
    };

    window.addEventListener("message", handler);
    iframeWin.postMessage(command, "*");
  });
}

function buildRenderScript(layerName: string, format: "jpg" | "png"): string {
  return `
    try {
      app.displayDialogs = DialogModes.NO;
      var docs = app.documents;
      if (docs.length < 2) {
        app.echoToOE("error: need 2 docs, have " + docs.length);
      } else {
        var designDoc = docs[docs.length - 1];
        var mockupDoc = docs[0];

        app.activeDocument = designDoc;
        designDoc.flatten();
        designDoc.selection.selectAll();
        designDoc.activeLayer.copy();
        designDoc.close(SaveOptions.DONOTSAVECHANGES);

        app.activeDocument = mockupDoc;
        function findLayer(layers, name) {
          for (var i = 0; i < layers.length; i++) {
            if (layers[i].name === name) return layers[i];
            if (layers[i].layers) {
              var f = findLayer(layers[i].layers, name);
              if (f) return f;
            }
          }
          return null;
        }
        var target = findLayer(mockupDoc.layers, "${layerName}");
        if (!target) {
          function findFirstSO(layers) {
            for (var i = 0; i < layers.length; i++) {
              var k = layers[i].kind;
              if (k === 1 || k === 5 || (k && k.toString().indexOf("SmartObject") >= 0)) return layers[i];
              if (layers[i].layers) {
                var f = findFirstSO(layers[i].layers);
                if (f) return f;
              }
            }
            return null;
          }
          target = findFirstSO(mockupDoc.layers);
        }

        if (!target) {
          app.echoToOE("error: smart object layer not found (looking for '${layerName}')");
        } else {
          mockupDoc.activeLayer = target;
          var desc = new ActionDescriptor();
          executeAction(stringIDToTypeID("placedLayerEditContents"), desc, DialogModes.NO);

          var soDoc = app.activeDocument;
          var soW = soDoc.width;
          var soH = soDoc.height;

          soDoc.paste();
          var pasted = soDoc.activeLayer;
          var b = pasted.bounds;
          var lW = b[2] - b[0];
          var lH = b[3] - b[1];
          if (lW > 0 && lH > 0) {
            var sx = (soW / lW) * 100;
            var sy = (soH / lH) * 100;
            var s = Math.max(sx, sy);
            pasted.resize(s, s);
            var nb = pasted.bounds;
            var dx = ((soW - (nb[2] - nb[0])) / 2) - nb[0];
            var dy = ((soH - (nb[3] - nb[1])) / 2) - nb[1];
            pasted.translate(dx, dy);
          }
          soDoc.flatten();
          soDoc.save();
          soDoc.close();
        }

        app.activeDocument = app.documents[0];
        app.activeDocument.flatten();
        app.activeDocument.saveToOE("${format}");
        app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);
      }
    } catch(err) {
      app.echoToOE("error: " + err.message);
    }
  `;
}

class PhotopeaRenderer {
  private iframe: HTMLIFrameElement | null = null;
  private ready = false;
  private queueResolvers: Array<() => void> = [];
  private inflight = false;
  private keepalive: { stop: () => void } | null = null;

  private async ensureIframe(): Promise<HTMLIFrameElement> {
    if (this.iframe && this.ready) return this.iframe;
    if (this.iframe) {
      await new Promise<void>(res => this.queueResolvers.push(res));
      return this.iframe;
    }

    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.left = "-10000px";
    iframe.style.top = "0";
    iframe.style.width = "1200px";
    iframe.style.height = "800px";
    iframe.style.border = "0";
    iframe.setAttribute("aria-hidden", "true");
    iframe.src = `${PHOTOPEA_ORIGIN}#${encodeURIComponent(
      JSON.stringify({ environment: { vmode: 3 }, files: [] })
    )}`;
    document.body.appendChild(iframe);
    this.iframe = iframe;

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Photopea load timeout")), 30_000);
      const onMessage = (e: MessageEvent) => {
        try {
          if (e.source !== iframe.contentWindow) return;
        } catch {
          return;
        }
        if (e.data === "done") {
          clearTimeout(t);
          window.removeEventListener("message", onMessage);
          this.ready = true;
          for (const r of this.queueResolvers) r();
          this.queueResolvers = [];
          resolve();
        }
      };
      window.addEventListener("message", onMessage);
    });

    this.keepalive = startBackgroundKeepalive();
    return iframe;
  }

  async render({ psd, image, smartObjectLayerName = "Smart Object", outputFormat = "jpg" }: RenderInput): Promise<RenderOutput> {
    if (this.inflight) await new Promise<void>(res => this.queueResolvers.push(res));
    this.inflight = true;
    try {
      const iframe = await this.ensureIframe();
      const win = iframe.contentWindow!;
      const psdBuf = await psd.arrayBuffer();
      const imgBuf = await image.arrayBuffer();

      await sendCommand(win, psdBuf, 60_000);
      await sendCommand(win, imgBuf, 30_000);

      const script = buildRenderScript(smartObjectLayerName, outputFormat);
      const result = await sendCommand(win, script, 120_000, true);

      // safety cleanup; the render script closes docs but if it crashed we close leftovers
      await sendCommand(win, "while(app.documents.length > 0) { app.activeDocument.close(SaveOptions.DONOTSAVECHANGES); }", 5_000).catch(() => {});

      if (result.buffers.length === 0) throw new Error("Photopea returned no image");
      const lastBuf = result.buffers[result.buffers.length - 1];
      const mime = outputFormat === "png" ? "image/png" : "image/jpeg";
      const blob = new Blob([lastBuf], { type: mime });
      const dims = await readImageDimensions(blob);
      return { blob, width: dims.w, height: dims.h };
    } finally {
      this.inflight = false;
      const next = this.queueResolvers.shift();
      if (next) next();
    }
  }

  destroy() {
    this.keepalive?.stop();
    this.keepalive = null;
    if (this.iframe?.parentElement) this.iframe.parentElement.removeChild(this.iframe);
    this.iframe = null;
    this.ready = false;
  }
}

function readImageDimensions(blob: Blob): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = e => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

// Background keepalive: silent audio loop + wake lock to avoid browser throttling
// when the user switches tabs during a long batch render.
function startBackgroundKeepalive(): { stop: () => void } {
  let audioCtx: AudioContext | null = null;
  let oscillator: OscillatorNode | null = null;
  let wakeLock: any = null;
  let stopped = false;

  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (Ctx) {
      audioCtx = new Ctx();
      oscillator = audioCtx!.createOscillator();
      const gain = audioCtx!.createGain();
      gain.gain.value = 0.0001;
      oscillator.frequency.value = 1;
      oscillator.connect(gain);
      gain.connect(audioCtx!.destination);
      oscillator.start();
      if (audioCtx!.state === "suspended") audioCtx!.resume().catch(() => {});
    }
  } catch {}

  const requestWakeLock = async () => {
    try {
      const nav: any = navigator;
      if (nav.wakeLock?.request) {
        wakeLock = await nav.wakeLock.request("screen");
        wakeLock.addEventListener?.("release", () => {
          if (!stopped) {
            const reacquire = () => {
              if (!stopped && document.visibilityState === "visible") {
                requestWakeLock();
                document.removeEventListener("visibilitychange", reacquire);
              }
            };
            document.addEventListener("visibilitychange", reacquire);
          }
        });
      }
    } catch {}
  };
  requestWakeLock();

  return {
    stop: () => {
      stopped = true;
      try { oscillator?.stop(); } catch {}
      try { audioCtx?.close(); } catch {}
      try { wakeLock?.release?.(); } catch {}
    },
  };
}

let singleton: PhotopeaRenderer | null = null;
export function getRenderer(): PhotopeaRenderer {
  if (!singleton) singleton = new PhotopeaRenderer();
  return singleton;
}
