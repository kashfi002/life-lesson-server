const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../Db");

const router = express.Router();

/**
 * Every /api/admin/* route requires ?adminId=... (GET) or { adminId }
 * (POST/PATCH/DELETE body). We look the user up by _id and check
 * role === "admin" server-side — we do NOT trust a `role` field sent
 * from the client, since that would be trivial to spoof from DevTools.
 *
 * IMPORTANT: better-auth's mongodb adapter stores the primary key as
 * _id (a native ObjectId) on the raw document. The "id" string you get
 * from useSession() only exists after better-auth's own transform
 * layer — querying the raw collection directly means querying by _id,
 * not by a field called "id" (which doesn't exist on the document).
 *
 * TEMPORARY: same caveat as lessons.js — once Challenge 2 (real token
 * verification) is in place, replace this with reading the verified
 * user off the request instead of a client-supplied adminId.
 */
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

router.use(requireAdmin);

/**
 * Buckets documents in `collectionName` by day for the last 7 days,
 * zero-filling days with no activity. Powers the growth charts on the
 * admin dashboard home. Shape matches the { day, count } your
 * DashboardHomePage weekly chart already expects.
 */
async function countsByDayLast7(db, collectionName, dateField) {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 6);

  const rows = await db
    .collection(collectionName)
    .aggregate([
      { $match: { [dateField]: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: `$${dateField}` } },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();

  const byDate = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({
      day: d.toLocaleDateString("en-US", { weekday: "short" }),
      count: byDate[key] || 0,
    });
  }
  return days;
}

/**
 * GET /api/admin/stats?adminId=...
 * -----------------------------------------------------------------------
 * Powers /dashboard/admin — totals, most active contributors, today's
 * new lessons, and lesson/user growth over the last 7 days.
 */
router.get("/stats", async (req, res) => {
  try {
    const db = req.db;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [
      totalUsers,
      totalPublicLessons,
      reportedLessonIds,
      todaysNewLessons,
      mostActiveContributors,
      lessonGrowth,
      userGrowth,
    ] = await Promise.all([
      db.collection("user").countDocuments({}),
      db.collection("lessons").countDocuments({ visibility: "Public" }),
      db.collection("lessonsReports").distinct("lessonId"),
      db.collection("lessons").countDocuments({ createdAt: { $gte: startOfToday } }),
      db
        .collection("lessons")
        .aggregate([
          {
            $group: {
              _id: "$creatorId",
              creatorName: { $first: "$creatorName" },
              creatorImage: { $first: "$creatorImage" },
              lessonCount: { $sum: 1 },
            },
          },
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
  } catch (err) {
    console.error("GET /api/admin/stats failed:", err);
    res.status(500).json({ error: "Couldn't load admin stats." });
  }
});

/**
 * GET /api/admin/users?adminId=...
 * -----------------------------------------------------------------------
 * Powers /dashboard/admin/manage-users. Every user, plus how many
 * lessons each has created. `id` in the response is derived from _id
 * (see the note on requireAdmin above) so it matches the string form
 * of the id the frontend already uses everywhere else (session.user.id,
 * lesson.creatorId, etc).
 */
router.get("/users", async (req, res) => {
  try {
    const db = req.db;
    const [users, lessonCounts] = await Promise.all([
      db.collection("user").find({}).sort({ createdAt: -1 }).toArray(),
      db
        .collection("lessons")
        .aggregate([{ $group: { _id: "$creatorId", count: { $sum: 1 } } }])
        .toArray(),
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
  } catch (err) {
    console.error("GET /api/admin/users failed:", err);
    res.status(500).json({ error: "Couldn't load users." });
  }
});

/**
 * PATCH /api/admin/users/:id/role
 * -----------------------------------------------------------------------
 * Promote/demote a user. :id is the string form of the user's Mongo
 * _id (same string the frontend already gets as session.user.id).
 */
router.patch("/users/:id/role", async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    if (!["user", "admin"].includes(role)) {
      return res.status(400).json({ error: "Role must be user or admin." });
    }
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid user id." });
    }

    const db = req.db;
    const result = await db
      .collection("user")
      .updateOne({ _id: new ObjectId(id) }, { $set: { role } });
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    res.json({ success: true, role });
  } catch (err) {
    console.error("PATCH /api/admin/users/:id/role failed:", err);
    res.status(500).json({ error: "Couldn't update role." });
  }
});

/**
 * DELETE /api/admin/users/:id
 * -----------------------------------------------------------------------
 * Optional per the PDF. Deletes the user document only — their existing
 * lessons/favorites/comments are left as-is (no cascade), since the
 * spec doesn't call for cascading here the way lesson delete does.
 */
router.delete("/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid user id." });
    }
    const db = req.db;
    const result = await db.collection("user").deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "User not found." });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/admin/users/:id failed:", err);
    res.status(500).json({ error: "Couldn't delete user." });
  }
});

/**
 * GET /api/admin/lessons?adminId=...&category=&visibility=&flagged=true
 * -----------------------------------------------------------------------
 * Powers /dashboard/admin/manage-lessons. Every lesson from every user,
 * with a computed reportCount, plus the three stat counts the page
 * needs (public / private / flagged).
 */
router.get("/lessons", async (req, res) => {
  try {
    const db = req.db;
    const { category = "", visibility = "", flagged = "" } = req.query;

    const query = {};
    if (category && category !== "All") query.category = category;
    if (visibility && visibility !== "All") query.visibility = visibility;

    const [lessons, reportCounts, publicCount, privateCount, flaggedLessonIds] =
      await Promise.all([
        db.collection("lessons").find(query).sort({ createdAt: -1 }).toArray(),
        db
          .collection("lessonsReports")
          .aggregate([{ $group: { _id: "$lessonId", count: { $sum: 1 } } }])
          .toArray(),
        db.collection("lessons").countDocuments({ visibility: "Public" }),
        db.collection("lessons").countDocuments({ visibility: "Private" }),
        db.collection("lessonsReports").distinct("lessonId"),
      ]);

    const reportCountById = Object.fromEntries(reportCounts.map((r) => [r._id, r.count]));
    const flaggedSet = new Set(flaggedLessonIds);

    let withReportCounts = lessons.map((l) => ({
      ...l,
      reportCount: reportCountById[l._id.toString()] || 0,
    }));

    if (flagged === "true") {
      withReportCounts = withReportCounts.filter((l) => flaggedSet.has(l._id.toString()));
    }

    res.json({
      lessons: withReportCounts,
      stats: {
        publicCount,
        privateCount,
        flaggedCount: flaggedLessonIds.length,
      },
    });
  } catch (err) {
    console.error("GET /api/admin/lessons failed:", err);
    res.status(500).json({ error: "Couldn't load lessons." });
  }
});

/**
 * PATCH /api/admin/lessons/:id/featured
 * PATCH /api/admin/lessons/:id/reviewed
 * -----------------------------------------------------------------------
 * Toggle isFeatured (shows on the homepage Featured section) and
 * isReviewed independently.
 */
router.patch("/lessons/:id/featured", async (req, res) => {
  try {
    const { id } = req.params;
    const { isFeatured } = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid lesson id." });

    const db = req.db;
    const result = await db
      .collection("lessons")
      .updateOne({ _id: new ObjectId(id) }, { $set: { isFeatured: Boolean(isFeatured) } });
    if (result.matchedCount === 0) return res.status(404).json({ error: "Lesson not found." });

    res.json({ success: true, isFeatured: Boolean(isFeatured) });
  } catch (err) {
    console.error("PATCH /api/admin/lessons/:id/featured failed:", err);
    res.status(500).json({ error: "Couldn't update featured status." });
  }
});

router.patch("/lessons/:id/reviewed", async (req, res) => {
  try {
    const { id } = req.params;
    const { isReviewed } = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid lesson id." });

    const db = req.db;
    const result = await db
      .collection("lessons")
      .updateOne({ _id: new ObjectId(id) }, { $set: { isReviewed: Boolean(isReviewed) } });
    if (result.matchedCount === 0) return res.status(404).json({ error: "Lesson not found." });

    res.json({ success: true, isReviewed: Boolean(isReviewed) });
  } catch (err) {
    console.error("PATCH /api/admin/lessons/:id/reviewed failed:", err);
    res.status(500).json({ error: "Couldn't update reviewed status." });
  }
});

/**
 * DELETE /api/admin/lessons/:id
 * -----------------------------------------------------------------------
 * Admin delete — bypasses the ownership check that lessons.js's
 * DELETE /:id enforces for regular users. Same cascade cleanup
 * (favorites, comments, reports) as that route.
 */
router.delete("/lessons/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid lesson id." });

    const db = req.db;
    const result = await db.collection("lessons").deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Lesson not found." });

    await db.collection("favorites").deleteMany({ lessonId: id });
    await db.collection("comments").deleteMany({ lessonId: id });
    await db.collection("lessonsReports").deleteMany({ lessonId: id });

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/admin/lessons/:id failed:", err);
    res.status(500).json({ error: "Couldn't delete lesson." });
  }
});

/**
 * GET /api/admin/reports?adminId=...
 * -----------------------------------------------------------------------
 * Powers /dashboard/admin/reported-lessons. Groups lessonsReports by
 * lessonId, joins the lesson title, and includes the full list of
 * individual reports (reason + reporter info) for the "view all
 * reasons" modal.
 */
router.get("/reports", async (req, res) => {
  try {
    const db = req.db;
    const reports = await db.collection("lessonsReports").find({}).sort({ timestamp: -1 }).toArray();
    if (reports.length === 0) return res.json({ reportedLessons: [] });

    const lessonIds = [...new Set(reports.map((r) => r.lessonId))].filter(ObjectId.isValid);
    const lessons = await db
      .collection("lessons")
      .find({ _id: { $in: lessonIds.map((id) => new ObjectId(id)) } })
      .toArray();
    const lessonById = Object.fromEntries(lessons.map((l) => [l._id.toString(), l]));

    const grouped = {};
    for (const r of reports) {
      if (!grouped[r.lessonId]) {
        grouped[r.lessonId] = {
          lessonId: r.lessonId,
          lessonTitle: lessonById[r.lessonId]?.title || "(lesson no longer exists)",
          reportCount: 0,
          reports: [],
        };
      }
      grouped[r.lessonId].reportCount += 1;
      grouped[r.lessonId].reports.push({
        reason: r.reason,
        reporterUserId: r.reporterUserId,
        reportedUserEmail: r.reportedUserEmail,
        timestamp: r.timestamp,
      });
    }

    res.json({ reportedLessons: Object.values(grouped) });
  } catch (err) {
    console.error("GET /api/admin/reports failed:", err);
    res.status(500).json({ error: "Couldn't load reported lessons." });
  }
});

/**
 * DELETE /api/admin/reports/:lessonId
 * -----------------------------------------------------------------------
 * "Delete Lesson" action from the reports table — permanently removes
 * the reported lesson (same cascade as the manage-lessons delete).
 */
router.delete("/reports/:lessonId", async (req, res) => {
  try {
    const { lessonId } = req.params;
    if (!ObjectId.isValid(lessonId)) return res.status(400).json({ error: "Invalid lesson id." });

    const db = req.db;
    await db.collection("lessons").deleteOne({ _id: new ObjectId(lessonId) });
    await db.collection("favorites").deleteMany({ lessonId });
    await db.collection("comments").deleteMany({ lessonId });
    await db.collection("lessonsReports").deleteMany({ lessonId });

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/admin/reports/:lessonId failed:", err);
    res.status(500).json({ error: "Couldn't delete lesson." });
  }
});

/**
 * POST /api/admin/reports/:lessonId/ignore
 * -----------------------------------------------------------------------
 * "Ignore" action — keeps the lesson live, clears all its reports.
 */
router.post("/reports/:lessonId/ignore", async (req, res) => {
  try {
    const { lessonId } = req.params;
    const db = req.db;
    await db.collection("lessonsReports").deleteMany({ lessonId });
    res.json({ success: true });
  } catch (err) {
    console.error("POST /api/admin/reports/:lessonId/ignore failed:", err);
    res.status(500).json({ error: "Couldn't clear reports." });
  }
});

module.exports = router;