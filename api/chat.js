// Vercel Serverless Function — Claude-powered chat for H2H Electric LLC
// POST /api/chat  { messages: [{role,content}], lang?: 'en'|'es' }
// Response: { reply: string }

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL             = 'claude-sonnet-4-20250514';
const MAX_TOKENS        = 600;

const SYSTEM_PROMPT = `You are the friendly, helpful AI assistant for H2H Electric LLC (also known as H2H Electrical), a licensed family-owned electrical contractor in Texas.

# Business profile
- Legal name: H2H Electric LLC
- Owner / founder: Kevin Connell
- Founded: June 2025
- Slogan: "Safe, quality electrical work at an affordable price"
- Phone: (409) 739-2944
- Email: h2helectric25@gmail.com
- Website: https://www.h2helectrical.com
- Licensed and insured electrical contractor

# Hours
- Monday – Friday: 8:00 AM – 5:00 PM
- Saturday: By appointment
- Sunday: Closed
- 24/7 Emergency electrical service available

# Service area
Alvin, Friendswood, League City, Webster, and Houston, TX (and surrounding areas)

# Services offered
- Residential electrical (installations, repairs, upgrades, rewiring)
- Commercial electrical (panel installations, maintenance, industrial systems)
- Generator installation (backup power for homes and businesses)
- House service hookup (new construction, additions, renovations)
- Light installations
- Service upgrades
- Electrical repairs and troubleshooting
- Repairs and remodels
- 24/7 emergency electrical service
- Free estimates on all jobs

# Your job
1. Answer questions about H2H's services, pricing approach (free estimates, transparent honest pricing — but you cannot give specific quotes), hours, and service areas.
2. Help collect leads. When the customer is interested, gently gather: name, phone number, email, address or city, and a short description of the job. Do NOT demand all of this at once — ask one or two things at a time, conversationally.
3. Once you have their contact info, tell them Kevin will follow up shortly, and remind them they can also call (409) 739-2944 for fastest response — especially for emergencies.
4. For true emergencies (sparks, burning smell, no power, exposed wiring), tell them to call (409) 739-2944 immediately and, if there's danger, to turn off the breaker and stay clear.
5. Never invent prices, timelines, or warranties. If asked, say Kevin will confirm specifics in the free estimate.
6. If asked about something outside electrical work, politely redirect to how H2H can help.

# Language
Respond in the same language the customer writes in. If they write in Spanish, reply in natural, friendly Spanish. If English, reply in English. Match their language even if it changes mid-conversation.

# Tone
Warm, concise, and professional. Like talking to a helpful neighbor who happens to be an electrician. Keep replies short (2–4 sentences usually). Use plain text — no markdown formatting, no asterisks, no headers.`;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set');
    return res.status(500).json({ error: 'Server is not configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { messages, lang } = body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const cleaned = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (cleaned.length === 0 || cleaned[0].role !== 'user') {
    return res.status(400).json({ error: 'conversation must start with a user message' });
  }

  const langHint = lang === 'es'
    ? '\n\nThe user has selected Spanish on the website. Default to Spanish unless they clearly write in English.'
    : '';

  try {
    const apiResp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT + langHint,
        messages: cleaned
      })
    });

    if (!apiResp.ok) {
      const errText = await apiResp.text();
      console.error('Anthropic API error', apiResp.status, errText);
      return res.status(502).json({ error: 'Upstream error from AI provider' });
    }

    const data  = await apiResp.json();
    const reply = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    return res.status(200).json({
      reply: reply || (lang === 'es'
        ? 'Lo siento, no pude generar una respuesta. Por favor llame al (409) 739-2944.'
        : "Sorry, I couldn't generate a response. Please call (409) 739-2944.")
    });
  } catch (err) {
    console.error('Chat handler error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
