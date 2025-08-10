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

    const narrationText = String(text).trim();
    if (!narrationText) {
      return res.status(400).json({ error: "text must be a non-empty string" });
    }

    // 1) Call ElevenLabs TTS -> MP3 bytes
    const ttsResp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`, {
      method: "POST",
      headers: {
        "accept": "audio/mpeg",
        "content-type": "application/json",
        "xi-api-key": ELEVEN_API_KEY
      },
      body: JSON.stringify({
        text: narrationText,
        model_id: "eleven_multilingual_v2",
        output_format: "mp3_44100_128",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });

    if (!ttsResp.ok) {
      const errText = await ttsResp.text().catch(() => "");
      return res.status(ttsResp.status).json({ error: "ElevenLabs TTS failed", detail: errText });
    }

    const mp3ArrayBuffer = await ttsResp.arrayBuffer();
    const mp3Buffer = Buffer.from(mp3ArrayBuffer);

    // 2) Upload to Supabase Storage (public bucket)
    const folder = "cards";
    const filename = `${safeName(campaign)}__${safeName(title)}-${Date.now()}.mp3`;
    const objectPath = `${folder}/${filename}`;

    const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(BUCKET)}/${encodeURIComponent(objectPath)}`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/mpeg",
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "x-upsert": "true"
      },
      body: mp3Buffer
    });

    if (!uploadResp.ok) {
      const t = await uploadResp.text().catch(() => "");
      return res.status(uploadResp.status).json({ error: "Supabase upload failed", detail: t });
    }

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
