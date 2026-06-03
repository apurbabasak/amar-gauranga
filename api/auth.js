const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

// Initialize Firebase Admin (server side)
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

const db = getFirestore();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

module.exports = async (req, res) => {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { action, name, pin, location, initiatedName, guruName, language } = req.body;

  try {
    // ── SIGNUP ─────────────────────────────────────────────
    if (action === "signup") {
      if (!name || !pin) {
        return res.status(400).json({ error: "Name and PIN are required" });
      }
      if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
        return res.status(400).json({ error: "PIN must be exactly 4 digits" });
      }

      // Check if name already exists (single field query — no index needed)
      const existing = await db.collection("users")
        .where("nameLower", "==", name.toLowerCase().trim())
        .get();

      if (!existing.empty) {
        return res.status(409).json({ error: "This name is already taken. Please choose another." });
      }

      // Create user
      const userRef = db.collection("users").doc();
      const userData = {
        id: userRef.id,
        name: name.trim(),
        nameLower: name.toLowerCase().trim(),
        pin: pin,
        location: location || "",
        initiatedName: initiatedName || "",
        guruName: guruName || "",
        language: language || "en",
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString(),
        journal: [],
        savedAnswers: [],
      };
      await userRef.set(userData);

      return res.status(200).json({
        success: true,
        user: {
          id: userRef.id,
          name: userData.name,
          initiatedName: userData.initiatedName,
          guruName: userData.guruName,
          location: userData.location,
          language: userData.language,
        },
        message: "Welcome, " + userData.name + "! Hare Krishna! 🙏",
      });
    }

    // ── LOGIN ──────────────────────────────────────────────
    if (action === "login") {
      if (!name || !pin) {
        return res.status(400).json({ error: "Name and PIN are required" });
      }

      // Query by name only (single field — no composite index needed)
      const snapshot = await db.collection("users")
        .where("nameLower", "==", name.toLowerCase().trim())
        .get();

      if (snapshot.empty) {
        return res.status(401).json({ error: "No account found with this name." });
      }

      // Check PIN in code (avoids needing composite index)
      const userDoc = snapshot.docs.find(doc => doc.data().pin === pin);
      if (!userDoc) {
        return res.status(401).json({ error: "Incorrect PIN. Please try again." });
      }

      const userData = userDoc.data();

      // Update last login
      await userDoc.ref.update({ lastLogin: new Date().toISOString() });

      return res.status(200).json({
        success: true,
        user: {
          id: userDoc.id,
          name: userData.name,
          initiatedName: userData.initiatedName || "",
          guruName: userData.guruName || "",
          location: userData.location || "",
          language: userData.language || "en",
          savedAnswers: userData.savedAnswers || [],
        },
        message: "Welcome back, " + userData.name + "! Hare Krishna! 🙏",
      });
    }

    // ── SAVE ANSWER ────────────────────────────────────────
    if (action === "saveAnswer") {
      const { userId, question, answer, references, acharya } = req.body;
      if (!userId || !question || !answer) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const entry = {
        id: Date.now().toString(),
        question: question,
        answer: answer,
        references: references || [],
        acharya: acharya || "all",
        savedAt: new Date().toISOString(),
      };

      // FieldValue imported at top — no require() inside call
      await db.collection("users").doc(userId).update({
        savedAnswers: FieldValue.arrayUnion(entry),
      });

      return res.status(200).json({ success: true, entry: entry });
    }

    // ── GET JOURNAL ────────────────────────────────────────
    if (action === "getJournal") {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ error: "User ID required" });
      }

      const userDoc = await db.collection("users").doc(userId).get();
      if (!userDoc.exists) {
        return res.status(404).json({ error: "User not found" });
      }

      const userData = userDoc.data();
      return res.status(200).json({
        success: true,
        savedAnswers: userData.savedAnswers || [],
      });
    }

    return res.status(400).json({ error: "Invalid action" });

  } catch (error) {
    console.error("Auth error:", error.message);
    return res.status(500).json({ error: "Server error. Please try again." });
  }
};
