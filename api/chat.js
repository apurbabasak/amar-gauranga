const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pinecone } = require("@pinecone-database/pinecone");

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

    const langMap = { en:"English", hi:"Hindi", bn:"Bengali", ru:"Russian", es:"Spanish" };
    const responseLang = langMap[language] || "English";
    const acharyaInstruction = (!acharya || acharya === "all")
      ? "Draw wisdom from all Acharyas and scriptures."
      : `Focus on teachings from: ${acharya}.`;

    // Pinecone search using integrated inference (searchRecords for integrated models)
    let context = "";
    let references = [];
    try {
      const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
      const index = pc.index("amar-gauranga", process.env.PINECONE_INDEX_HOST);

      // Use searchRecords for integrated embedding models
      const searchResult = await index.searchRecords({
        query: {
          inputs: { text: question },
          topK: 6,
        },
        fields: ["source","acharya","book","chapter","english","purport"],
        namespace: "teachings",
      });

      const hits = searchResult.result?.hits || [];
      hits.forEach((hit, i) => {
        const f = hit.fields || {};
        const text = f.purport || f.english || "";
        if (text && text.length > 30) {
          context += `\n[${i+1}] ${f.source||"Scripture"} | ${f.acharya||"Srila Prabhupada"} | ${f.chapter||""}\n${text.substring(0,500)}\n`;
          references.push({ source: f.source||f.book, chapter: f.chapter, acharya: f.acharya });
        }
      });
    } catch(e) {
      console.error("Pinecone error:", e.message);
    }

    // Build prompt
    const prompt = `You are Amar Gauranga — Lord Chaitanya's compassionate voice through authentic Vaishnava teachings.

Rules:
- Address as "dear soul" or "beloved devotee"
- Acknowledge their pain first with deep empathy
- Give scriptural wisdom with exact references
- End with encouragement and chanting the holy name
- ${acharyaInstruction}
- Respond in ${responseLang}
- Keep response warm and personal, 200-300 words

${context ? `AUTHENTIC TEACHINGS TO USE:\n${context}` : "Use your knowledge of Bhagavad Gita, Srimad Bhagavatam and Vaishnava philosophy."}

Devotee's question: ${question}

Respond as Lord Gauranga speaking with infinite compassion:`;

    // Call Gemini 2.5 Flash — confirmed working model
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
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
