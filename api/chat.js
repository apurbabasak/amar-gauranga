const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pinecone } = require("@pinecone-database/pinecone");

// Multiple Gemini API keys — rotates automatically
// Add keys from different Google accounts below
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
  process.env.GEMINI_API_KEY_5,
  process.env.GEMINI_API_KEY_6,
  process.env.GEMINI_API_KEY_7,
  process.env.GEMINI_API_KEY_8,
].filter(Boolean); // removes empty/undefined keys

// Pick a key based on current minute — distributes load evenly
function getGeminiKey() {
  const idx = Math.floor(Date.now() / 60000) % GEMINI_KEYS.length;
  return GEMINI_KEYS[idx];
}

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
      : "Focus on teachings from: " + acharya + ".";

    // Try keys until one works
    let answer = null;
    let references = [];
    let lastError = null;

    for (let attempt = 0; attempt < GEMINI_KEYS.length; attempt++) {
      const keyIdx = (Math.floor(Date.now() / 60000) + attempt) % GEMINI_KEYS.length;
      const apiKey = GEMINI_KEYS[keyIdx];

      try {
        // Search Pinecone
        let context = "";
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
          const hits = result.result?.hits || [];

          hits.forEach((hit, i) => {
            const f = hit.fields || {};
            const text = f.purport || f.english || "";
            if (text && text.length > 30) {
              context += "\n[" + (i+1) + "] " + (f.source||f.book||"Scripture") + " | " + (f.acharya||"Srila Prabhupada") + " | " + (f.chapter||"") + "\n" + text.substring(0,500) + "\n";
              references.push({ source: f.source||f.book, chapter: f.chapter, acharya: f.acharya });
            }
          });
        } catch(pe) {
          console.error("Pinecone error:", pe.message);
        }

        // Build prompt
        const prompt = "You are Amar Gauranga — Lord Chaitanya Mahaprabhu compassionate voice through authentic Vaishnava teachings.\n\nRules:\n- Address as dear soul or beloved devotee\n- Acknowledge pain first with deep empathy\n- Give scriptural wisdom with exact references\n- End with encouragement\n- " + acharyaInstruction + "\n- Respond in " + responseLang + "\n- Keep response warm and personal, 200-300 words\n\n" + (context ? "AUTHENTIC TEACHINGS TO USE:\n" + context : "Use knowledge of Bhagavad Gita, Srimad Bhagavatam and Vaishnava philosophy.") + "\n\nDevotee question: " + question;

        // Call Gemini
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(prompt);
        answer = result.response.text();
        break; // success — stop trying other keys

      } catch (keyError) {
        lastError = keyError;
        const errMsg = keyError.message || "";
        if (errMsg.includes("429") || errMsg.includes("quota") || errMsg.includes("401")) {
          console.error("Key " + (keyIdx+1) + " failed:", errMsg.substring(0,80));
          continue; // try next key
        }
        throw keyError; // non-quota error — stop retrying
      }
    }

    if (!answer) {
      console.error("All keys failed:", lastError?.message);
      return res.status(503).json({
        error: "Service temporarily unavailable. Please try again in a moment.",
      });
    }

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
