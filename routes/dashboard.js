const express = require("express");
const { getDb } = require("../Db");
const router = express.Router();
const { verifyToken } = require("../middleware/verifyToken");

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(`${req.method} ${req.originalUrl} failed:`, err);
    res.status(500).json({ error: "Something went wrong." });
  }
};

// Same day-bucketing approach as admin.js's countsByDayLast7, but scoped
// to one creator's lessons instead of the whole collection.
async function weeklyLessonCounts(db, creatorId) {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 6);

  const rows = await db
    .collection("lessons")
    .aggregate([
      { $match: { creatorId, createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
    ])
    .toArray();

  const byDate = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ day: d.toLocaleDateString("en-US", { weekday: "short" }), count: byDate[key] || 0 });
  }
  return days;
}

router.get(
  "/summary",
  verifyToken,
  wrap(async (req, res) => {
    const creatorId = req.userId;
    if (!creatorId) return res.status(401).json({ error: "You must be logged in to view your dashboard." });

    const db = await getDb();

    const [totalLessons, recentLessonsRaw, weeklyActivity, favoritesAgg] = await Promise.all([
      db.collection("lessons").countDocuments({ creatorId }),
      db
        .collection("lessons")
        .find({ creatorId })
        .sort({ createdAt: -1 })
        .limit(5)
        .project({ title: 1, category: 1, createdAt: 1, accessLevel: 1 })
        .toArray(),
      weeklyLessonCounts(db, creatorId),
      // Sum of favoritesCount across every lesson this user wrote — i.e.
      // how many times other people have saved their lessons.
      db
        .collection("lessons")
        .aggregate([
          { $match: { creatorId } },
          { $group: { _id: null, total: { $sum: "$favoritesCount" } } },
        ])
        .toArray(),
    ]);

    const recentLessons = recentLessonsRaw.map((l) => ({
      id: l._id.toString(),
      title: l.title,
      category: l.category,
      createdAt: l.createdAt,
      accessLevel: l.accessLevel || "Free",
    }));

    const totalFavorites = favoritesAgg[0]?.total || 0;

    res.json({ totalLessons, totalFavorites, recentLessons, weeklyActivity });
  })
);

module.exports = router;