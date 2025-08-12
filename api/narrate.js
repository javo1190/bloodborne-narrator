// api/narrate.js
// POST /api/narrate { title, campaign, text, voiceId? } -> { url }

const crypto = require('node:crypto');

function normalizeText(s) {
  return String(s || '')
    .trim()
    .replace(/\r\n/g, '\n')      // CRLF -> LF
    .replace(/[ \t]+/g, ' ')     // colapsa espacios/tabs
    .replace(/\n{3,}/g, '\n\n'); // como mucho 2 saltos seguidos
}

function digest8(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
}

function safeName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .trim()
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
}

module.exports = async (req, res) => {
  try {
    // CORS básico (útil para probar desde navegador/Actions)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();

    if (req.method === "GET") {
      return res.status(200).json({ ok: true, hint: "POST {title,campaign,text} to get an MP3 URL." });
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, GET, OPTIONS");
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
    const { title, campaign, text, voiceId } = body;

    if (!title || !campaign || !text) {
      return res.status(400).json({ error: "title, campaign, and text are required" });
    }

    // === Nombre de archivo determinista (anti-duplicados) ===
    const narrationText = String(text).trim();
    if (!narrationText) return res.status(400).json({ error: "text must be non-empty" });

    const normalized = normalizeText(narrationText);
    const VOICE = voiceId || ELEVEN_VOICE_ID;

    // hash incluye la voz para diferenciar audios con voces distintas
    const hash = digest8(`${VOICE}::${normalized}`);

    const folder = 'cards';
    const filename = `${safeName(campaign)}__${safeName(title)}--${hash}.mp3`;
    const objectPath = `${folder}/${filename}`;

    // URL pública estable (no codifiques la "/")
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;

    // Si ya existe el archivo público, devuelve directamente la URL (sin "cached")
    try {
      const head = await fetch(publicUrl, { method: 'HEAD' });
      if (head.ok) {
        console.log("narrate OK (cache)", { path: objectPath });
        return res.status(200).json({ url: publicUrl });
      }
    } catch (_) {
      try {
        const tiny = await fetch(publicUrl, { headers: { Range: 'bytes=0-1' } });
        if (tiny.ok) {
          console.log("narrate OK (range cache)", { path: objectPath });
          return res.status(200).json({ url: publicUrl });
        }
      } catch (_) {}
    }
    // === Fin bloque determinista ===

    // 1) ElevenLabs TTS
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

    if (!tts.ok) {
      const detail = await tts.text().catch(() => "");
      return res.status(tts.status).json({ error: "ElevenLabs TTS failed", detail });
    }

    const mp3Buffer = Buffer.from(await tts.arrayBuffer());

    // 2) Subir a Supabase (no codifiques el path completo)
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`;
    const up = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": "audio/mpeg",
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "x-upsert": "true" // sobreescribe si existía
      },
      body: mp3Buffer
    });

    if (!up.ok) {
      const detail = await up.text().catch(() => "");
      return res.status(up.status).json({ error: "Supabase upload failed", detail });
    }

    console.log("narrate GENERATED", { path: objectPath, size: mp3Buffer.length });
    return res.status(200).json({ url: publicUrl });

  } catch (e) {
    return res.status(500).json({ error: e?.message || "server error" });
  }
};
