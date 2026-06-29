import express, { type Router } from "express";

const MODEL = "gemini-2.5-flash";

const SYSTEM_PROMPT = [
  'Du benennst Kunst-Prints für die Marke "Atelier Faille".',
  "Schreibe ausschließlich auf Deutsch.",
  "Ziel: Titel und Beschreibung sollen sich für Kundinnen und Kunden anfühlen wie etwas, das sie kaufen möchten — emotional, klar, ohne SEO-Geschwafel, ohne Keyword-Stuffing.",
  'Zielgruppe: Menschen, die ihr Zuhause stilvoll, sinnlich und persönlich gestalten. Keine Plattitüden wie "modern und stylisch", keine Marketing-Floskeln.',
  'Titel: max. 60 Zeichen. Eigenständig, konkret, gern poetisch. Keine generischen Begriffe wie "Wandbild", "Canvas Print", "Kunstdruck".',
  "Beschreibung: 1–2 Sätze, max. 280 Zeichen. Beschreibt Stimmung, Atmosphäre und Wirkung im Raum — nicht Eigenschaften des Drucks.",
  "Antworte ausschließlich als JSON: {\"title\": \"...\", \"description\": \"...\"}",
].join("\n");

export function createGeminiRouter(): Router {
  const router = express.Router();

  router.post("/title", async (req, res) => {
    try {
      const key = process.env.GEMINI_API_KEY;
      if (!key) return res.status(500).json({ error: "GEMINI_API_KEY missing" });
      const { imageBase64, mimeType, hint } = req.body || {};
      if (!imageBase64 || !mimeType) {
        return res.status(400).json({ error: "imageBase64 and mimeType required" });
      }

      const userText = hint ? `${SYSTEM_PROMPT}\n\nHinweis vom Nutzer: ${hint}` : SYSTEM_PROMPT;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: userText },
                { inline_data: { mime_type: mimeType, data: imageBase64 } },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.9,
          },
        }),
      });
      if (!r.ok) {
        return res.status(500).json({ error: `Gemini ${r.status}: ${await r.text()}` });
      }
      const data: any = await r.json();
      const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      let parsed: { title?: string; description?: string } = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        // ignore
      }
      if (!parsed.title) {
        return res.status(500).json({ error: "no title in Gemini response", raw: text });
      }
      res.json({ title: parsed.title, description: parsed.description || "" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
