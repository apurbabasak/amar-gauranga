const { Pinecone } = require("@pinecone-database/pinecone");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_HOST = process.env.PINECONE_INDEX_HOST;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

module.exports = async (req, res) => {
  // Set CORS headers on every response
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { question, acharya, language } = req.body;

    if (!question || question.trim().length < 3) {
      return res.status(400).json({ error: "Please share your question." });
    }

    // 1. Search Pinecone using integrated inference
    // Since index uses multilingual-e5-large with integrated embedding,
    // we use searchRecords with text query directly
    const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
    const index = pc.index("amar-gauranga", PINECONE_INDEX_HOST);

    // Build filter
    const filter = {};
    if (acharya && acharya !== "all") {
      if (acharya === "scriptures") {
        filter.acharya = { $eq: "Srila Prabhupada" };
      } else {
        filter.acharya = { $eq: acharya };
      }
    }

    // Use searchRecords for integrated embedding (text query directly)
    let matches = [];
    try {
      const searchParams = {
        query: {
          inputs: { text: question },
          topK: 8,
        },
        fields: ["source", "acharya", "book", "chapter", "english", "purport", "sanskrit"],
        namespace: "teachings",
      };
      if (Object.keys(filter).length > 0) {
        searchParams.query.filter = filter;
      }

      const searchResult = await index.searchRecords(searchParams);
      matches = searchResult.result?.hits || [];
    } catch (searchErr) {
      console.error("Search error:", searchErr.message);
      // Continue with empty matches — Gemini will use general knowledge
    }

    // 2. Build context from results
    let context = "";
    let references = [];

    matches.forEach((match, i) => {
      const fields = match.fields || {};
      const purport = fields.purport || "";
      const english = fields.english || "";
      const source = fields.source || fields.book || "Scripture";
      const chapter = fields.chapter || "";
      const acharyaName = fields.acharya || "Srila Prabhupada";

      const text = purport || english;
      if (text && text.length > 30) {
        context += `\n[TEACHING ${i + 1}]\nSource: ${source}\nAcharya: ${acharyaName}\nReference: ${chapter}\nText: ${text.substring(0, 800)}\n`;
        references.push({ source, chapter, acharya: acharyaName });
      }
    });

    // 3. Language map
    const langMap = {
      en: "English", hi: "Hindi", bn: "Bengali", ru: "Russian", es: "Spanish",
    };
    const responseLang = langMap[language] || "English";

    // 4. Acharya context
    const acharyaInstruction = (!acharya || acharya === "all")
      ? "Draw wisdom from all Acharyas and scriptures."
      : `Focus on teachings from: ${acharya}.`;

    // 5. Build system prompt
    const systemPrompt = `You are Amar Gauranga — the voice of Lord Chaitanya Mahaprabhu speaking through authentic Vaishnava teachings.

Your sacred duty:
- Respond with infinite compassion and warmth, as if Lord Gauranga Himself is speaking
- Use ONLY the teachings provided in CONTEXT below — never invent quotes
- Cite exact references: book name, chapter/verse number, or letter date
- Address the person as "dear soul" or "beloved devotee"  
- First acknowledge their pain with deep empathy, then offer scriptural wisdom
- End with an encouraging message and a relevant mantra or verse
- ${acharyaInstruction}
- Respond in ${responseLang}

${context ? `AUTHENTIC TEACHINGS TO USE:\n${context}` : "Use your knowledge of Vaishnava philosophy to offer compassionate guidance."}

Remember: You are the bridge between a suffering soul and eternal wisdom. Every word must carry love.`;

    // 6. Gemini response
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-pro",
      systemInstruction: systemPrompt,
    });

    const result = await model.generateContent(question);
    const answer = result.response.text();

    return res.status(200).json({
      answer,
      references: references.slice(0, 3),
      acharya: acharya || "all",
      matches_found: matches.length,
    });

  } catch (error) {
    console.error("Chat API error:", error);
    return res.status(500).json({
      error: "Something went wrong. Please try again.",
      details: error.message,
    });
  }
};
