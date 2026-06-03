const { Pinecone } = require("@pinecone-database/pinecone");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_HOST = process.env.PINECONE_INDEX_HOST;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// CORS headers
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

module.exports = async (req, res) => {
  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(200).json({});
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { question, acharya, language } = req.body;

    if (!question || question.trim().length < 3) {
      return res.status(400).json({ error: "Please share your question." });
    }

    // 1. Initialize Gemini
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

    // 2. Create embedding for search using Gemini
    const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
    const embeddingResult = await embeddingModel.embedContent(question);
    const queryVector = embeddingResult.embedding.values;

    // 3. Search Pinecone
    const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
    const index = pc.index("amar-gauranga", PINECONE_INDEX_HOST);

    // Build filter based on selected acharya
    const filter = {};
    if (acharya && acharya !== "all" && acharya !== "scriptures") {
      filter.acharya = { $eq: acharya };
    } else if (acharya === "scriptures") {
      filter.source = {
        $in: [
          "Bhagavad Gita", "Srimad Bhagavatam", "Chaitanya Charitamrita",
          "Nectar of Devotion", "Nectar of Instruction", "Krishna Book",
          "Isopanishad", "Prabhupada Letters"
        ]
      };
    }

    const searchParams = {
      vector: queryVector,
      topK: 8,
      includeMetadata: true,
      namespace: "teachings",
    };
    if (Object.keys(filter).length > 0) {
      searchParams.filter = filter;
    }

    const searchResults = await index.query(searchParams);
    const matches = searchResults.matches || [];

    // 4. Build context from search results
    let context = "";
    let references = [];

    matches.forEach((match, i) => {
      const meta = match.metadata || {};
      const text = meta.purport || meta.english || meta.text || "";
      const source = meta.source || meta.book || "Scripture";
      const chapter = meta.chapter || "";
      const acharyaName = meta.acharya || "Srila Prabhupada";

      if (text && text.length > 50) {
        context += `\n[TEACHING ${i + 1}]\nSource: ${source}\nAcharya: ${acharyaName}\nReference: ${chapter}\nText: ${text.substring(0, 800)}\n`;
        references.push({ source, chapter, acharya: acharyaName, score: match.score });
      }
    });

    if (!context) {
      context = "The scriptures teach us that surrendering to the Lord with devotion brings peace and liberation from all suffering.";
    }

    // 5. Language instruction
    const langMap = {
      en: "English",
      hi: "Hindi",
      bn: "Bengali",
      ru: "Russian",
      es: "Spanish",
    };
    const responseLang = langMap[language] || "English";

    // 6. Build prompt
    const acharyaContext = acharya && acharya !== "all"
      ? `The user has specifically chosen to receive guidance from: ${acharya}. Focus primarily on teachings attributed to this Acharya.`
      : "Draw from all the Acharyas and scriptures available.";

    const systemPrompt = `You are Amar Gauranga — a deeply compassionate spiritual guide who speaks with the voice of Lord Gauranga (Chaitanya Mahaprabhu) through the authentic teachings of the Vaishnava Acharyas.

Your role:
- Respond with deep compassion, warmth and personal care as if Lord Gauranga Himself is speaking
- ONLY use the teachings provided in the CONTEXT below — never invent quotes or references
- Always cite the exact source (book name, chapter/verse, or letter date) for every teaching you use
- Format references clearly at the end as: "📖 [Source] — [Reference]"
- Address the person as "dear soul" or "beloved devotee"
- First acknowledge their pain with empathy, then give scriptural guidance
- Keep response focused and heartfelt — not too long
- ${acharyaContext}
- Respond in ${responseLang}

CONTEXT FROM AUTHENTIC TEACHINGS:
${context}

Remember: You are a bridge between the suffering soul and the eternal wisdom of the Acharyas. Every word should carry compassion and hope.`;

    // 7. Get Gemini response
    const chatModel = genAI.getGenerativeModel({
      model: "gemini-1.5-pro",
      systemInstruction: systemPrompt,
    });

    const result = await chatModel.generateContent(question);
    const answer = result.response.text();

    // 8. Return response
    return res.status(200).json({
      answer,
      references: references.slice(0, 3),
      acharya: acharya || "all",
    }, { headers });

  } catch (error) {
    console.error("Chat error:", error);
    return res.status(500).json({
      error: "Something went wrong. Please try again.",
      details: error.message,
    });
  }
};
