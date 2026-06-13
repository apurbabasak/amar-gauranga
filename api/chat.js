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

async function callGemini(prompt) {
  var lastError = null;
  for (var attempt = 0; attempt < GEMINI_KEYS.length; attempt++) {
    var keyIdx = (Math.floor(Date.now() / 60000) + attempt) % GEMINI_KEYS.length;
    try {
      var genAI = new GoogleGenerativeAI(GEMINI_KEYS[keyIdx]);
      var model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      var result = await model.generateContent(prompt);
      return result.response.text();
    } catch (e) {
      lastError = e;
      var msg = e.message || "";
      if (msg.includes("429") || msg.includes("quota") || msg.includes("401")) {
        continue;
      }
      throw e;
    }
  }
  throw lastError || new Error("All keys exhausted");
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

    // ── STEP 1: Search Pinecone with topK:10 ───────────────
    var hits = [];
    try {
      var pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
      var index = pc.index("amar-gauranga", process.env.PINECONE_INDEX_HOST);

      var searchParams = {
        query: { inputs: { text: question }, topK: 10 },
        fields: ["source","acharya","book","chapter","english","purport"],
        namespace: "teachings",
      };

      if (acharya && acharya !== "all" && acharya !== "scriptures") {
        searchParams.query.filter = { acharya: { $eq: acharya } };
      }

      var result = await index.searchRecords(searchParams);
      hits = result.result?.hits || [];
    } catch (pe) {
      console.error("Pinecone error:", pe.message);
    }

    // ── STEP 2: Score how good the matches are ─────────────
    // Only use database if we have strong matches (score > 0.65)
    var strongHits = hits.filter(function(h) { return (h.score || 0) >= 0.65; });
    var weakHits   = hits.filter(function(h) { return (h.score || 0) >= 0.50 && (h.score || 0) < 0.65; });

    var fromDatabase = strongHits.length >= 2;  // Need at least 2 strong hits
    var useHits = fromDatabase ? strongHits : (weakHits.length >= 3 ? weakHits : []);
    var isFromDB = useHits.length > 0;

    var references = [];
    var answer = null;

    if (isFromDB) {
      // ── DATABASE PATH: Build context from Pinecone hits ──
      var context = "";
      for (var i = 0; i < useHits.length; i++) {
        var f = useHits[i].fields || {};
        var text = f.purport || f.english || "";
        if (!text || text.length < 20) continue;
        var src = f.source || f.book || "Scripture";
        var ch  = f.chapter || "";
        var ach = f.acharya || "Srila Prabhupada";
        context += "\n[TEACHING " + (i+1) + "]\n";
        context += "Source: " + src + "\n";
        context += "Reference: " + ch + "\n";
        context += "Acharya: " + ach + "\n";
        context += "Text: " + text.substring(0, 600) + "\n";
        references.push({ source: src, chapter: ch, acharya: ach });
      }

      var dbPrompt =
        "You are Amar Gauranga — a compassionate Vaishnava guide.\n\n" +
        "STRICT RULES:\n" +
        "1. Answer ONLY using the teachings provided below. Do NOT use outside knowledge.\n" +
        "2. Every key point MUST include a citation in this exact format: (Source, Reference)\n" +
        "3. Begin by acknowledging the devotee situation with warmth.\n" +
        "4. Weave the teachings naturally into your answer with citations.\n" +
        "5. Close with encouragement.\n" +
        "6. Respond in " + responseLang + ".\n" +
        "7. Keep response 180-280 words.\n\n" +
        "TEACHINGS:\n" + context + "\n\n" +
        "QUESTION: " + question;

      answer = await callGemini(dbPrompt);

    } else {
      // ── FALLBACK PATH: General Vaishnava knowledge ────────
      var fallbackPrompt =
        "You are Amar Gauranga — a compassionate Vaishnava spiritual guide.\n\n" +
        "IMPORTANT: Our specific scripture database did not find a strong match for this question.\n" +
        "You must answer from your broad knowledge of Gaudiya Vaishnava philosophy.\n\n" +
        "RULES:\n" +
        "1. Start with: 'While our specific teachings database did not contain a direct match, " +
           "the broader Vaishnava tradition offers this guidance:'\n" +
        "2. Cite from Bhagavad Gita, Srimad Bhagavatam, or Chaitanya Charitamrita with exact verse references.\n" +
        "3. Mention the Acharya (Srila Prabhupada, Srila Rupa Goswami, etc.) when quoting.\n" +
        "4. Be compassionate and address the devotee situation directly.\n" +
        "5. Respond in " + responseLang + ".\n" +
        "6. Keep response 150-250 words.\n\n" +
        "QUESTION: " + question;

      answer = await callGemini(fallbackPrompt);
    }

    return res.status(200).json({
      answer: answer,
      references: references.slice(0, 5),
      matches_found: useHits.length,
      from_database: isFromDB,
    });

  } catch (error) {
    console.error("Error:", error.message);
    return res.status(500).json({
      error: "Something went wrong. Please try again.",
    });
  }
};
