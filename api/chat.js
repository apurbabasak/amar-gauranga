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

    // Pinecone search
    let context = "";
    let references = [];
    try {
      const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
      const index = pc.index("amar-gauranga", process.env.PINECONE_INDEX_HOST);
      const filter = {};
      if (acharya && acharya !== "all") {
        filter.acharya = { $eq: acharya === "scriptures" ? "Srila Prabhupada" : acharya };
      }
      const searchParams = {
        query: { inputs: { text: question }, topK: 6 },
        fields: ["source","acharya","book","chapter","english","purport"],
        namespace: "teachings",
      };
      if (Object.keys(filter).length > 0) searchParams.query.filter = filter;
      const result = await index.searchRecords(searchParams);
      (result.result?.hits || []).forEach((hit, i) => {
        const f = hit.fields || {};
        const text = f.purport || f.english || "";
        if (text.length > 30) {
          context += `\n[${i+1}] Source: ${f.source||f.book||"Scripture"} | Acharya: ${f.acharya||"Srila Prabhupada"} | Ref: ${f.chapter||""}\nText: ${text.substring(0,600)}\n`;
          references.push({ source: f.source||f.book, chapter: f.chapter, acharya: f.acharya });
        }
      });
    } catch(e) {
      console.error("Pinecone:", e.message);
    }

    // Gemini
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

    const prompt = `You are Amar Gauranga — Lord Chaitanya's compassionate voice through Vaishnava teachings.

Rules:
- Address as "dear soul" or "beloved devotee"  
- Acknowledge their pain first with empathy
- Give scriptural wisdom with exact references
- End with encouragement
- ${acharyaInstruction}
- Respond in ${responseLang}
- 200-300 words max

${context ? `TEACHINGS TO USE:\n${context}` : "Use Bhagavad Gita and Vaishnava philosophy."}

Question: ${question}`;

    const result = await model.generateContent(prompt);
    const answer = result.response.text();

    return res.status(200).json({ answer, references: references.slice(0,3) });

  } catch (error) {
    console.error("Error:", error.message);
    return res.status(500).json({ error: "Something went wrong.", details: error.message });
  }
};
