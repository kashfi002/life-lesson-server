const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../Db");
const { verifyToken } = require("../middleware/verifyToken");
const router = express.Router();
router.get("/mine", verifyToken, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(401).json({ error: "You must be logged in to view favorites." });
    }

    const db = await getDb();
    const favoriteDocs = await db
      .collection("favorites")
      .find({ userId })
      .sort({ savedAt: -1 })
      .toArray();

    if (favoriteDocs.length === 0) {
      return res.json({ favorites: [] });
    }

    const lessonIds = favoriteDocs
      .map((f) => (ObjectId.isValid(f.lessonId) ? new ObjectId(f.lessonId) : null))
      .filter(Boolean);

    const lessons = await db
      .collection("lessons")
      .find({ _id: { $in: lessonIds } })
      .toArray();
    const lessonById = Object.fromEntries(lessons.map((l) => [l._id.toString(), l]));

    // Preserve favorites order (most recently saved first); drop any
    // whose lesson no longer exists.
    const favorites = favoriteDocs
      .map((f) => {
        const lesson = lessonById[f.lessonId];
        if (!lesson) return null;
        return { ...lesson, savedAt: f.savedAt };
      })
      .filter(Boolean);

    res.json({ favorites });
  } catch (err) {
    console.error("GET /api/favorites/mine failed:", err);
    res.status(500).json({ error: "Couldn't load your favorites." });
  }
});

module.exports = router;