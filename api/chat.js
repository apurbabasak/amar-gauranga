const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_HOST = process.env.PINECONE_INDEX_HOST;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { question, acharya, language } = req.body;

    if (!question || question.trim().length < 2) {
      return res.status(400).json({ error: "Please share your question." });
    }

    // Language map
    const langMap = { en:"English", hi:"Hindi", bn:"Bengali", ru:"Russian", es:"Spanish" };
    const responseLang = langMap[language] || "English";

    // Acharya instruction
    const acharyaInstruction = (!acharya || acharya === "all")
      ? "Draw wisdom from all Acharyas and scriptures of the Gaudiya Vaishnava tradition."
      : `Focus on teachings from: ${acharya}.`;

    // Try Pinecone search
    let context = "";
    let references = [];

    try {
      const { Pinecone } = require("@pinecone-database/pinecone");
      const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
      const index = pc.index("amar-gauranga", PINECONE_INDEX_HOST);

      const filter = {};
      if (acharya && acharya !== "all") {
        if (acharya === "scriptures") {
          filter.acharya = { $eq: "Srila Prabhupada" };
        } else {
          filter.acharya = { $eq: acharya };
        }
      }

      const searchParams = {
        query: {
          inputs: { text: question },
          topK: 6,
        },
        fields: ["source","acharya","book","chapter","english","purport"],
        namespace: "teachings",
      };
      if (Object.keys(filter).length > 0) {
        searchParams.query.filter = filter;
      }

      const result = await index.searchRecords(searchParams);
      const hits = result.result?.hits || [];

      hits.forEach((hit, i) => {
        const f = hit.fields || {};
        const text = f.purport || f.english || "";
        const source = f.source || f.book || "Scripture";
        const chapter = f.chapter || "";
        const acharyaName = f.acharya || "Srila Prabhupada";
        if (text && text.length > 30) {
          context += `\n[TEACHING ${i+1}]\nSource: ${source}\nAcharya: ${acharyaName}\nReference: ${chapter}\nText: ${text.substring(0,600)}\n`;
          references.push({ source, chapter, acharya: acharyaName });
        }
      });
    } catch (pineconeErr) {
      console.error("Pinecone error:", pineconeErr.message);
      // Continue without context
    }

    // Build system prompt
    const systemPrompt = `You are Amar Gauranga — the compassionate voice of Lord Chaitanya Mahaprabhu speaking through authentic Vaishnava teachings.

Your sacred role:
- Speak with infinite compassion and warmth, as if Lord Gauranga Himself is personally addressing this soul
- Address the person as "dear soul" or "beloved devotee"
- First acknowledge their pain with deep empathy (2-3 sentences)
- Then offer scriptural wisdom and practical guidance
- If teachings are provided in CONTEXT, use them and cite the exact reference
- If no context provided, use your knowledge of Bhagavad Gita, Srimad Bhagavatam and Vaishnava philosophy
- Always end with an encouraging message
- ${acharyaInstruction}
- Respond in ${responseLang}
- Keep response warm, personal and around 200-300 words

${context ? `AUTHENTIC TEACHINGS:\n${context}` : ""}`;

    // Call Gemini
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",  // Using Flash — faster and free
      systemInstruction: systemPrompt,
    });

    const result = await model.generateContent(question);
    const answer = result.response.text();

    return res.status(200).json({
      answer,
      references: references.slice(0, 3),
      matches_found: references.length,
    });

  } catch (error) {
    console.error("Error:", error.message);
    return res.status(500).json({
      error: "Something went wrong. Please try again.",
      details: error.message,
    });
  }
};
