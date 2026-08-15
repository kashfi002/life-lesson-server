const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../Db");

const router = express.Router();

/**
 * GET /api/favorites/mine?userId=...
 * -----------------------------------------------------------------------
 * Powers /dashboard/my-favorites. The `favorites` collection only
 * stores { userId, lessonId, savedAt } — this joins that against the
 * `lessons` collection so the frontend gets full lesson data (title,
 * category, creator, etc) in one call instead of fetching each lesson
 * individually.
 *
 * If a favorited lesson was since deleted by its owner, it's silently
 * skipped rather than erroring — the favorites doc becomes an orphan,
 * which is harmless and just means it won't show up here anymore.
 */
router.get("/mine", async (req, res) => {
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