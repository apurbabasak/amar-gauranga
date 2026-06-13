const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pinecone } = require("@pinecone-database/pinecone");

const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
  process.env.GEMINI_API_KEY_5,
  process.env.GEMINI_API_KEY_6,
  process.env.GEMINI_API_KEY_7,
  process.env.GEMINI_API_KEY_8,
].filter(Boolean);

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

    // ── STEP 1: Search Pinecone for relevant teachings ──────
    let hits = [];
    let searchError = null;
    try {
      const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
      const index = pc.index("amar-gauranga", process.env.PINECONE_INDEX_HOST);

      const searchParams = {
        query: { inputs: { text: question }, topK: 8 },
        fields: ["source","acharya","book","chapter","english","purport","sanskrit"],
        namespace: "teachings",
      };

      // Filter by acharya if selected
      if (acharya && acharya !== "all" && acharya !== "scriptures") {
        searchParams.query.filter = { acharya: { $eq: acharya } };
      }

      const result = await index.searchRecords(searchParams);
      hits = result.result?.hits || [];
    } catch (pe) {
      searchError = pe.message;
      console.error("Pinecone error:", pe.message);
    }

    // ── STEP 2: If no matches found, say so honestly ────────
    if (hits.length === 0) {
      return res.status(200).json({
        answer: "Dear soul, I searched through all the teachings in our sacred database but could not find a direct reference for your specific question. Please try rephrasing your question, or ask about a different aspect of your situation.",
        references: [],
        matches_found: 0,
        strict_mode: true,
      });
    }

    // ── STEP 3: Build context from Pinecone hits ────────────
    var context = "";
    var references = [];

    for (var i = 0; i < hits.length; i++) {
      var hit = hits[i];
      var f = hit.fields || {};
      var text = f.purport || f.english || "";
      if (!text || text.length < 20) continue;

      var source = f.source || f.book || "Scripture";
      var chapter = f.chapter || "";
      var acharyaName = f.acharya || "Srila Prabhupada";

      context += "\n[TEACHING " + (i+1) + "]\n";
      context += "Source: " + source + "\n";
      context += "Reference: " + chapter + "\n";
      context += "Acharya: " + acharyaName + "\n";
      context += "Text: " + text.substring(0, 600) + "\n";

      references.push({
        source: source,
        chapter: chapter,
        acharya: acharyaName,
        score: hit.score || 0,
      });
    }

    // ── STEP 4: Build strict prompt ─────────────────────────
    const prompt = "You are Amar Gauranga — a compassionate Vaishnava guide.\n\n" +
      "STRICT RULES:\n" +
      "1. Answer ONLY using the teachings provided below. Do NOT add knowledge from outside these teachings.\n" +
      "2. Every key point you make MUST cite the source in this format: (Source Name, Reference)\n" +
      "3. If the provided teachings do not contain enough information to answer, say so honestly.\n" +
      "4. Begin with warm compassion addressing the devotee's situation.\n" +
      "5. Quote or paraphrase directly from the teachings below, always with citation.\n" +
      "6. End with an encouraging closing line.\n" +
      "7. Respond in " + responseLang + ".\n" +
      "8. Keep response between 150-280 words.\n\n" +
      "TEACHINGS FROM DATABASE:\n" + context + "\n\n" +
      "DEVOTEE QUESTION: " + question + "\n\n" +
      "Remember: Cite every point with its source reference in parentheses.";

    // ── STEP 5: Try Gemini keys with rotation ───────────────
    var answer = null;
    var lastError = null;

    for (var attempt = 0; attempt < GEMINI_KEYS.length; attempt++) {
      var keyIdx = (Math.floor(Date.now() / 60000) + attempt) % GEMINI_KEYS.length;
      var apiKey = GEMINI_KEYS[keyIdx];
      try {
        var genAI = new GoogleGenerativeAI(apiKey);
        var model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        var result = await model.generateContent(prompt);
        answer = result.response.text();
        break;
      } catch (keyError) {
        lastError = keyError;
        var errMsg = keyError.message || "";
        if (errMsg.includes("429") || errMsg.includes("quota") || errMsg.includes("401")) {
          console.error("Key " + (keyIdx+1) + " failed:", errMsg.substring(0,60));
          continue;
        }
        throw keyError;
      }
    }

    if (!answer) {
      return res.status(503).json({
        error: "All API keys are temporarily exhausted. Please try again after 12:30 PM IST.",
      });
    }

    // ── STEP 6: Return answer with full references ──────────
    return res.status(200).json({
      answer: answer,
      references: references.slice(0, 5),
      matches_found: hits.length,
      strict_mode: true,
    });

  } catch (error) {
    console.error("Error:", error.message);
    return res.status(500).json({
      error: "Something went wrong. Please try again.",
      details: error.message,
    });
  }
};
