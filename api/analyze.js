export const runtime = 'nodejs';

export async function POST(req) {
  try {
    const body = await req.json();
    const { player, propType, line, framework } = body;

    if (!player || !propType || !line) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const googleKey = process.env.GOOGLE_API_KEY || process.env.VITE_GOOGLE_API_KEY;

    if (!googleKey) {
      return Response.json({ error: 'Google API key not configured' }, { status: 500 });
    }

    const prompt = `Analyze this NBA prop bet and respond with ONLY valid JSON. No explanation. No markdown. Just output the JSON object.

Player: ${player}
Prop: ${propType} at line ${line}

Framework rules:
${framework}

Output a JSON object like this:
{"verdict":"OVER|UNDER|SKIP","tier":"S|A|B|SKIP","confidence":75,"justification":"text","flags":[],"data_used":{"season_avg":25.5,"l5_avg":27.0,"home_away":"home","win_prob":65,"opponent":"Team","game_context":"regular season"}}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${googleKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048,
          },
        }),
      }
    );

    const data = await response.json();
    if (data.error) return Response.json({ error: data.error.message }, { status: 500 });

    const rawResponse = JSON.stringify(data, null, 2);
    
    let textContent = '';
    try {
      textContent = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (e) {
      return Response.json({ error: 'Failed to extract text', debug: rawResponse }, { status: 500 });
    }

    if (!textContent) {
      return Response.json({ error: 'Empty response from Gemini', debug: rawResponse }, { status: 500 });
    }

    textContent = textContent.trim();
    
    let jsonStr = null;
    
    if (textContent.startsWith('{') && textContent.endsWith('}')) {
      jsonStr = textContent;
    } else {
      const match = textContent.match(/\{[\s\S]*\}/);
      if (match) jsonStr = match[0];
    }

    if (!jsonStr) {
      return Response.json({ 
        error: 'No JSON found', 
        raw: textContent.substring(0, 500),
        length: textContent.length
      }, { status: 500 });
    }

    try {
      const result = JSON.parse(jsonStr);
      return Response.json(result);
    } catch (e) {
      return Response.json({ 
        error: 'JSON parse failed', 
        raw: jsonStr,
        parseError: e.message
      }, { status: 500 });
    }
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}