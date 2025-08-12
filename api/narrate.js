// api/narrate.js
// One-file serverless function for Vercel (Node.js)
// - POST /api/narrate { title, campaign, text } -> { url }
// Env vars to set on Vercel:
// ELEVEN_API_KEY, ELEVEN_VOICE_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BUCKET (optional, default 'audio')

function safeName(s) {
  return String(s || "")
    .trim()
    .replace(/[^\w\-]+/g, "_")     // keep letters, numbers, underscore
    .replace(/_+/g, "_")
    .slice(0, 120);
}

const crypto = require('node:crypto');

// Normaliza un poco el texto para evitar hashes distintos por espacios o saltos de línea
function normalizeText(s) {
  return String(s || '')
    .trim()
    .replace(/\r\n/g, '\n')       // CRLF -> LF
    .replace(/[ \t]+/g, ' ')      // colapsa espacios/tabs
    .replace(/\n{3,}/g, '\n\n');  // como mucho dos saltos seguidos
}

// Hash SHA-256 y nos quedamos con 8 caracteres (suficiente para diferenciar)
function digest8(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
}

// (opcional; si ya la tienes, deja tu versión)
// Quita acentos y deja un nombre limpio para el archivo
function safeName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
}

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, hint: "POST {title,campaign,text} to get an MP3 URL." });
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
    const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const BUCKET = process.env.BUCKET || "audio";

    if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing environment variables" });
    }

    const body = req.body || {};
    const { title, campaign, text } = body;

    if (!title || !campaign || !text) {
      return res.status(400).json({ error: "title, campaign, and text are required" });
    }
        // === Nombre de archivo determinista (anti-duplicados) ===
    const narrationText = String(text).trim();
    if (!narrationText) {
      return res.status(400).json({ error: "text must be non-empty" });
    }

    // Normaliza el texto para evitar hashes distintos por espacios/saltos
    const normalized = normalizeText(narrationText);

    // Usa la voz en el hash para que otra voz genere otro archivo
    const VOICE = /* si implementaste voz por body: (voiceId || ELEVEN_VOICE_ID) */ ELEVEN_VOICE_ID;
    const hash = digest8(`${VOICE}::${normalized}`);

    // Path estable sin Date.now()
    const folder = 'cards';
    const filename = `${safeName(campaign)}__${safeName(title)}--${hash}.mp3`;
    const objectPath = `${folder}/${filename}`;

    // URL pública que vamos a devolver
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;

    // (Opcional) si el archivo ya existe, devolvemos cache y salimos
    try {
      const head = await fetch(publicUrl, { method: 'HEAD' });
      if (head.ok) {
        return res.status(200).json({ url: publicUrl, cached: true });
      }
    } catch (_) {
      // fallback suave: intenta leer 1 byte
      try {
        const tiny = await fetch(publicUrl, { headers: { Range: 'bytes=0-1' } });
        if (tiny.ok) {
          return res.status(200).json({ url: publicUrl, cached: true });
        }
      } catch (_) {}
    }
    // === Fin bloque determinista ===


    const narrationText = String(text).trim();
    if (!narrationText) {
      return res.status(400).json({ error: "text must be a non-empty string" });
    }

    // 1) Call ElevenLabs TTS -> MP3 bytes
        const tts = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}`, {
      method: "POST",
      headers: {
        "accept": "audio/mpeg",
        "content-type": "application/json",
        "xi-api-key": ELEVEN_API_KEY
      },
      body: JSON.stringify({
        text: normalized,
        model_id: "eleven_multilingual_v2",
        output_format: "mp3_44100_128",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });


    // 2) Upload to Supabase Storage (public bucket)
       const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/mpeg",
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "x-upsert": "true" // si decides regenerar, sobreescribe
      },
      body: mp3Buffer
    });

    if (!up.ok) {
      const detail = await up.text().catch(() => "");
      return res.status(up.status).json({ error: "Supabase upload failed", detail });
    }

    return res.status(200).json({ url: publicUrl });


    // 3) Public URL
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(BUCKET)}/${encodeURIComponent(objectPath)}`;

    // CORS (optional: lets you call from browser tools)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    return res.status(200).json({ url: publicUrl });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "server error" });
  }
};
