// /api/narrate.js
// POST /api/narrate { title, campaign, text, voiceId? } -> { ok, id, url, filename, bytes? }
//
// Cambios claves:
// - Timeout con AbortController (evita reintentos del conector) y 202 "processing" si expira.
// - Idempotencia real por hash -> ruta física cards/{hash}.mp3 (no depende de title/campaign).
// - Cache hit tanto con bucket público como privado (Range GET con auth).
// - CORS robusto (eco de Access-Control-Request-Headers).
//
// NOTA (en el builder de la Acción):
// - Pon x-openai-isConsequential=false durante pruebas (o "ask once per conversation").
// - Declara 200 (OK) y 202 (Processing) en el schema.

const crypto = require('node:crypto');

const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS || 25000);
const SIGNED_URL_TTL_SECONDS = Number(process.env.SIGNED_URL_TTL_SECONDS || 7 * 24 * 60 * 60); // 7 días

function normalizeText(s) {
  return String(s || '')
    .trim()
    .replace(/\r\n/g, '\n')      // CRLF -> LF
    .replace(/[ \t]+/g, ' ')     // colapsa espacios/tabs
    .replace(/\n{3,}/g, '\n\n'); // como mucho 2 saltos seguidos
}

function digestN(s, n = 12) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, n);
}

function safeName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .trim()
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
}

// HEAD/GET range contra Supabase para comprobar existencia
async function objectExists({ supabaseUrl, bucket, objectPath, isPublicBucket, serviceRoleKey }) {
  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${objectPath}`;
  try {
    if (isPublicBucket) {
      // Para públicos, intenta HEAD o Range mínimo anónimo
      const head = await fetch(publicUrl, { method: 'HEAD' });
      if (head.ok) return true;
      const tiny = await fetch(publicUrl, { headers: { Range: 'bytes=0-1' } });
      if (tiny.ok || tiny.status === 206) return true;
    } else {
      // Para privados, verifica con autorización y Range mínimo
      const privateUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${objectPath}`;
      const tiny = await fetch(privateUrl, {
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          Range: 'bytes=0-1'
        }
      });
      if (tiny.ok || tiny.status === 206) return true;
    }
  } catch (_) {}
  return false;
}

async function getAccessUrl({ supabaseUrl, bucket, objectPath, isPublicBucket, serviceRoleKey }) {
  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${objectPath}`;
  if (isPublicBucket) return publicUrl;

  // Genera signed URL si el bucket es privado
  const signUrl = `${supabaseUrl}/storage/v1/object/sign/${bucket}/${objectPath}`;
  const resp = await fetch(signUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceRoleKey}`
    },
    body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS })
  });
  if (!resp.ok) {
    // Fallback: devuelve la pública (puede no abrir, pero no rompemos contrato)
    return publicUrl;
  }
  const data = await resp.json().catch(() => ({}));
  // Supabase puede devolver 'signedURL' o 'signedUrl' según vía
  const signed = data.signedURL || data.signedUrl || data['signedURL'] || data['signedUrl'];
  if (typeof signed === 'string' && signed.length) {
    // La API devuelve path relativo; compón URL absoluta
    return `${supabaseUrl}${signed.startsWith('/') ? '' : '/'}${signed}`;
  }
  return publicUrl;
}

module.exports = async (req, res) => {
  try {
    // CORS
    const acrh = req.headers['access-control-request-headers'];
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', acrh || 'Content-Type');
    res.setHeader('Vary', 'Access-Control-Request-Headers');

    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method === 'GET') {
      return res.status(200).json({
        ok: true,
        hint: 'POST {title,campaign,text} -> {url}'
      });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, GET, OPTIONS');
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
    const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const BUCKET = process.env.BUCKET || 'audio';
    const IS_PUBLIC_BUCKET = String(process.env.SUPABASE_BUCKET_IS_PUBLIC || 'true').toLowerCase() === 'true';

    if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing environment variables' });
    }

    const body = req.body || {};
    const { title, campaign, text, voiceId } = body;

    if (!title || !campaign || !text) {
      return res.status(400).json({ ok: false, error: 'title, campaign, and text are required' });
    }

    const narrationText = String(text).trim();
    if (!narrationText) return res.status(400).json({ ok: false, error: 'text must be non-empty' });

    const normalized = normalizeText(narrationText);
    const VOICE = voiceId || ELEVEN_VOICE_ID;

    // Idempotencia real (voz + contenido). Títulos/campaña solo afectan filename sugerido.
    const id = digestN(`${VOICE}::${normalized}`, 12);

    // Ruta física estable por hash (reutiliza audio aunque cambie el título/campaña)
    const folder = 'cards';
    const objectPath = `${folder}/${id}.mp3`;

    // Nombre sugerido (bonito) para cuando el cliente descargue
    const niceFilename = `${safeName(campaign)}__${safeName(title)}--${id}.mp3`;

    // 0) Cache: ¿ya existe el objeto?
    const exists = await objectExists({
      supabaseUrl: SUPABASE_URL,
      bucket: BUCKET,
      objectPath,
      isPublicBucket: IS_PUBLIC_BUCKET,
      serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY
    });

    if (exists) {
      const url = await getAccessUrl({
        supabaseUrl: SUPABASE_URL,
        bucket: BUCKET,
        objectPath,
        isPublicBucket: IS_PUBLIC_BUCKET,
        serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY
      });
      return res.status(200).json({ ok: true, id, url, filename: niceFilename });
    }

    // 1) ElevenLabs TTS con timeout
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('TTS timeout')), TTS_TIMEOUT_MS);

    let ttsResp;
    try {
      ttsResp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}`, {
        method: 'POST',
        headers: {
          accept: 'audio/mpeg',
          'content-type': 'application/json',
          'xi-api-key': ELEVEN_API_KEY
        },
        body: JSON.stringify({
          text: normalized,
          model_id: 'eleven_multilingual_v2',
          output_format: 'mp3_44100_128',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        }),
        signal: ac.signal
      });
    } catch (err) {
      clearTimeout(timer);
      // Timeout/abort -> no cobramos de más: responder 202 para que el llamador reintente luego
      return res.status(202).json({ ok: false, status: 'processing', id, hint: 'retry with same payload' });
    }
    clearTimeout(timer);

    if (!ttsResp.ok) {
      const detail = await ttsResp.text().catch(() => '');
      return res.status(ttsResp.status).json({ ok: false, error: 'ElevenLabs TTS failed', detail });
    }

    const mp3Buffer = Buffer.from(await ttsResp.arrayBuffer());

    // 2) Subir a Supabase (upsert) en ruta por hash
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`;
    const up = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/mpeg',
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'x-upsert': 'true'
      },
      body: mp3Buffer
    });

    if (!up.ok) {
      const detail = await up.text().catch(() => '');
      return res.status(up.status).json({ ok: false, error: 'Supabase upload failed', detail });
    }

    const url = await getAccessUrl({
      supabaseUrl: SUPABASE_URL,
      bucket: BUCKET,
      objectPath,
      isPublicBucket: IS_PUBLIC_BUCKET,
      serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY
    });

    return res.status(200).json({ ok: true, id, url, filename: niceFilename, bytes: mp3Buffer.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'server error' });
  }
};
