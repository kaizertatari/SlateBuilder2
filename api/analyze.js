export const runtime = 'nodejs';

export async function POST(req) {
  try {
    const body = await req.json();
    const { player, propType, line, framework } = body;

    if (!player || !propType || !line) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const googleKey = process.env.GOOGLE_API_KEY || process.env.VITE_GOOGLE_API_KEY;
    const searchKey = process.env.WEBSEARCH_API_KEY || process.env.VITE_WEBSEARCH_API_KEY;

    if (!googleKey) {
      return Response.json({ error: 'Google API key not configured' }, { status: 500 });
    }

    const searchQuery = `${player} NBA ${propType} ${line} 2025 season stats last 5 games injury report`;
    let searchContext = 'No external search performed.';
    
    if (searchKey) {
      try {
        const searchRes = await fetch('https://api.websearchapi.ai/v1/search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': searchKey,
          },
          body: JSON.stringify({
            query: searchQuery,
            search_type: 'general',
            max_results: 5,
            include_answer: true,
          }),
        });

        const searchData = await searchRes.json();
        searchContext = searchData.answer 
          ? `Web search results:\n${searchData.answer}\n\nSources: ${searchData.results?.map(r => r.url).join(', ')}`
          : 'Web search performed but no results returned.';
      } catch (e) {
        searchContext = 'Search failed, using LLM knowledge only.';
      }
    }

    const prompt = `You are operating as the NBA PrizePicks Model v3.3. Your job is to analyze a player prop bet using the framework below, then return a structured verdict.

${searchContext}

Player prop bet to analyze:
- Player: ${player}
- Prop: ${propType}
- Line: ${line}

=== MODEL FRAMEWORK ===

${framework}

=== END FRAMEWORK ===

TASK: Using the framework rules above and the search data provided, analyze this prop bet. Apply ALL rules silently and output ONLY this JSON:

{
  "verdict": "OVER" | "UNDER" | "SKIP",
  "tier": "S" | "A" | "B" | "SKIP",
  "confidence": number,
  "justification": "2-3 sentences max. Include: baseline used (season avg vs L5), key signal, any active suppressors or hard caps applied.",
  "flags": ["⚠️ flag1", "⚠️ flag2"],
  "data_used": {
    "season_avg": number,
    "l5_avg": number,
    "home_away": "home" | "away",
    "win_prob": number,
    "opponent": "string",
    "game_context": "string"
  }
}

Do NOT output anything outside the JSON. No markdown. No explanation. Raw JSON only.`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${googleKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048,
          },
        }),
      }
    );

    const data = await response.json();
    if (data.error) return Response.json({ error: data.error.message }, { status: 500 });

    const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return Response.json({ error: 'No JSON found', raw: textContent }, { status: 500 });

    return Response.json(JSON.parse(jsonMatch[0]));
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}