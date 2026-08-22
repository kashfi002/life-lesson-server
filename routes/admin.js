const express = require("express");
const { ObjectId } = require("mongodb");
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

const isValidId = (id, res, label = "lesson") => {
  if (ObjectId.isValid(id)) return true;
  res.status(400).json({ error: `Invalid ${label} id.` });
  return false;
};

async function requireAdmin(req, res, next) {
  try {
    const adminId = req.query.adminId || req.body?.adminId;
    if (!adminId || !ObjectId.isValid(adminId)) {
      return res.status(401).json({ error: "Missing or invalid adminId." });
    }
    const db = await getDb();
    const admin = await db.collection("user").findOne({ _id: new ObjectId(adminId) });
    if (!admin || admin.role !== "admin") {
      return res.status(403).json({ error: "Admin access required." });
    }
    req.db = db; // reuse this connection in the route handler below
    next();
  } catch (err) {
    console.error("requireAdmin check failed:", err);
    res.status(500).json({ error: "Couldn't verify admin access." });
  }
}

// Both run for every route below: verifyToken confirms the request carries
// a real, logged-in user; requireAdmin then confirms adminId (still passed
// separately via query/body) actually belongs to a user with role "admin".
router.use(verifyToken);
router.use(requireAdmin);

async function countsByDayLast7(db, collectionName, dateField) {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 6);

  const rows = await db
    .collection(collectionName)
    .aggregate([
      { $match: { [dateField]: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: `$${dateField}` } }, count: { $sum: 1 } } },
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

// Shared by lesson deletion (admin.delete /lessons/:id) and report
// deletion (admin.delete /reports/:lessonId) — both wipe a lesson plus
// everything that references it.
async function purgeLesson(db, id, { deleteLessonDoc = true } = {}) {
  await Promise.all([
    deleteLessonDoc ? db.collection("lessons").deleteOne({ _id: new ObjectId(id) }) : Promise.resolve({ deletedCount: 1 }),
    db.collection("favorites").deleteMany({ lessonId: id }),
    db.collection("comments").deleteMany({ lessonId: id }),
    db.collection("lessonsReports").deleteMany({ lessonId: id }),
  ]);
}

// ---------- stats ----------

router.get(
  "/stats",
  wrap(async (req, res) => {
    const db = req.db;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [totalUsers, totalPublicLessons, reportedLessonIds, todaysNewLessons, mostActiveContributors, lessonGrowth, userGrowth] =
      await Promise.all([
        db.collection("user").countDocuments({}),
        db.collection("lessons").countDocuments({ visibility: "Public" }),
        db.collection("lessonsReports").distinct("lessonId"),
        db.collection("lessons").countDocuments({ createdAt: { $gte: startOfToday } }),
        db
          .collection("lessons")
          .aggregate([
            { $group: { _id: "$creatorId", creatorName: { $first: "$creatorName" }, creatorImage: { $first: "$creatorImage" }, lessonCount: { $sum: 1 } } },
            { $sort: { lessonCount: -1 } },
            { $limit: 5 },
          ])
          .toArray(),
        countsByDayLast7(db, "lessons", "createdAt"),
        countsByDayLast7(db, "user", "createdAt"),
      ]);

    res.json({
      totalUsers,
      totalPublicLessons,
      totalReportedLessons: reportedLessonIds.length,
      todaysNewLessons,
      mostActiveContributors,
      lessonGrowth,
      userGrowth,
    });
  })
);

// ---------- users ----------

router.get(
  "/users",
  wrap(async (req, res) => {
    const db = req.db;
    const [users, lessonCounts] = await Promise.all([
      db.collection("user").find({}).sort({ createdAt: -1 }).toArray(),
      db.collection("lessons").aggregate([{ $group: { _id: "$creatorId", count: { $sum: 1 } } }]).toArray(),
    ]);

    const countByCreator = Object.fromEntries(lessonCounts.map((c) => [c._id, c.count]));

    res.json({
      users: users.map((u) => ({
        id: u._id.toString(),
        name: u.name,
        email: u.email,
        image: u.image || null,
        role: u.role || "user",
        isPremium: Boolean(u.isPremium),
        totalLessons: countByCreator[u._id.toString()] || 0,
        createdAt: u.createdAt,
      })),
    });
  })
);

router.patch(
  "/users/:id/role",
  wrap(async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    if (!["user", "admin"].includes(role)) return res.status(400).json({ error: "Role must be user or admin." });
    if (!isValidId(id, res, "user")) return;

    const result = await req.db.collection("user").updateOne({ _id: new ObjectId(id) }, { $set: { role } });
    if (result.matchedCount === 0) return res.status(404).json({ error: "User not found." });
    res.json({ success: true, role });
  })
);

router.delete(
  "/users/:id",
  wrap(async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id, res, "user")) return;

    const result = await req.db.collection("user").deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: "User not found." });
    res.json({ success: true });
  })
);

// ---------- lessons ----------

router.get(
  "/lessons",
  wrap(async (req, res) => {
    const db = req.db;
    const { category = "", visibility = "", flagged = "" } = req.query;

    const query = {};
    if (category && category !== "All") query.category = category;
    if (visibility && visibility !== "All") query.visibility = visibility;

    const [lessons, reportCounts, publicCount, privateCount, flaggedLessonIds] = await Promise.all([
      db.collection("lessons").find(query).sort({ createdAt: -1 }).toArray(),
      db.collection("lessonsReports").aggregate([{ $group: { _id: "$lessonId", count: { $sum: 1 } } }]).toArray(),
      db.collection("lessons").countDocuments({ visibility: "Public" }),
      db.collection("lessons").countDocuments({ visibility: "Private" }),
      db.collection("lessonsReports").distinct("lessonId"),
    ]);

    const reportCountById = Object.fromEntries(reportCounts.map((r) => [r._id, r.count]));
    const flaggedSet = new Set(flaggedLessonIds);

    let withReportCounts = lessons.map((l) => ({ ...l, reportCount: reportCountById[l._id.toString()] || 0 }));
    if (flagged === "true") withReportCounts = withReportCounts.filter((l) => flaggedSet.has(l._id.toString()));

    res.json({ lessons: withReportCounts, stats: { publicCount, privateCount, flaggedCount: flaggedLessonIds.length } });
  })
);

router.patch(
  "/lessons/:id/featured",
  wrap(async (req, res) => {
    const { id } = req.params;
    const { isFeatured } = req.body;
    if (!isValidId(id, res)) return;

    const result = await req.db.collection("lessons").updateOne({ _id: new ObjectId(id) }, { $set: { isFeatured: Boolean(isFeatured) } });
    if (result.matchedCount === 0) return res.status(404).json({ error: "Lesson not found." });
    res.json({ success: true, isFeatured: Boolean(isFeatured) });
  })
);

router.patch(
  "/lessons/:id/reviewed",
  wrap(async (req, res) => {
    const { id } = req.params;
    const { isReviewed } = req.body;
    if (!isValidId(id, res)) return;

    const result = await req.db.collection("lessons").updateOne({ _id: new ObjectId(id) }, { $set: { isReviewed: Boolean(isReviewed) } });
    if (result.matchedCount === 0) return res.status(404).json({ error: "Lesson not found." });
    res.json({ success: true, isReviewed: Boolean(isReviewed) });
  })
);

router.delete(
  "/lessons/:id",
  wrap(async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id, res)) return;

    const db = req.db;
    const result = await db.collection("lessons").deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Lesson not found." });

    await purgeLesson(db, id, { deleteLessonDoc: false }); // already deleted above
    res.json({ success: true });
  })
);

// ---------- reports ----------

router.get(
  "/reports",
  wrap(async (req, res) => {
    const db = req.db;
    const reports = await db.collection("lessonsReports").find({}).sort({ timestamp: -1 }).toArray();
    if (reports.length === 0) return res.json({ reportedLessons: [] });

    const lessonIds = [...new Set(reports.map((r) => r.lessonId))].filter(ObjectId.isValid);
    const lessons = await db.collection("lessons").find({ _id: { $in: lessonIds.map((id) => new ObjectId(id)) } }).toArray();
    const lessonById = Object.fromEntries(lessons.map((l) => [l._id.toString(), l]));

    const grouped = {};
    for (const r of reports) {
      if (!grouped[r.lessonId]) {
        grouped[r.lessonId] = { lessonId: r.lessonId, lessonTitle: lessonById[r.lessonId]?.title || "(lesson no longer exists)", reportCount: 0, reports: [] };
      }
      grouped[r.lessonId].reportCount += 1;
      grouped[r.lessonId].reports.push({ reason: r.reason, reporterUserId: r.reporterUserId, reportedUserEmail: r.reportedUserEmail, timestamp: r.timestamp });
    }

    res.json({ reportedLessons: Object.values(grouped) });
  })
);

router.delete(
  "/reports/:lessonId",
  wrap(async (req, res) => {
    const { lessonId } = req.params;
    if (!isValidId(lessonId, res)) return;

    await purgeLesson(req.db, lessonId); // deletes the lesson doc too, unlike DELETE /lessons/:id above
    res.json({ success: true });
  })
);

router.post(
  "/reports/:lessonId/ignore",
  wrap(async (req, res) => {
    await req.db.collection("lessonsReports").deleteMany({ lessonId: req.params.lessonId });
    res.json({ success: true });
  })
);

module.exports = router;