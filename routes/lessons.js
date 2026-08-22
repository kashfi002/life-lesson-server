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
const isValidId = (id, res) => {
  if (ObjectId.isValid(id)) return true;
  res.status(400).json({ error: "Invalid lesson id." });
  return false;
};

const findLesson = async (db, id) => db.collection("lessons").findOne({ _id: new ObjectId(id) });

const SORTS = { newest: { createdAt: -1 }, mostSaved: { favoritesCount: -1, createdAt: -1 } };

// Public — anyone can browse published lessons, no token needed.
router.get(
  "/",
  wrap(async (req, res) => {
    const db = await getDb();
    const { search = "", category = "", tone = "", sort = "newest", page = "1", limit = "6", featured = "" } = req.query;

    const query = { visibility: "Public" };
    if (category !== "All" && category) query.category = category;
    if (tone !== "All" && tone) query.emotionalTone = tone;
    if (featured === "true") query.isFeatured = true;
    if (search.trim()) {
      const regex = { $regex: search.trim(), $options: "i" };
      query.$or = [{ title: regex }, { description: regex }];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.max(parseInt(limit, 10) || 6, 1);

    const [total, lessons] = await Promise.all([
      db.collection("lessons").countDocuments(query),
      db.collection("lessons").find(query).sort(SORTS[sort] || SORTS.newest).skip((pageNum - 1) * limitNum).limit(limitNum).toArray(),
    ]);

    res.json({ lessons, total, page: pageNum, totalPages: Math.max(Math.ceil(total / limitNum), 1) });
  })
);

router.post(
  "/",
  verifyToken,
  wrap(async (req, res) => {
    const { title, description, category, emotionalTone, image, visibility, accessLevel, creatorId, creatorName, creatorEmail, creatorImage } = req.body;

    if (!title?.trim() || !description?.trim() || !category || !emotionalTone)
      return res.status(400).json({ error: "Missing required fields." });
    if (!creatorId || !creatorEmail)
      return res.status(401).json({ error: "You must be logged in to publish a lesson." });

    const lesson = {
      title: title.trim(),
      description: description.trim(),
      category,
      emotionalTone,
      image: image || null,
      visibility: visibility === "Private" ? "Private" : "Public",
      accessLevel: accessLevel === "Premium" ? "Premium" : "Free",
      creatorId,
      creatorName: creatorName || "Anonymous",
      creatorEmail,
      creatorImage: creatorImage || null,
      likes: [],
      likesCount: 0,
      favoritesCount: 0,
      isFeatured: false,
      isReviewed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const db = await getDb();
    const { insertedId } = await db.collection("lessons").insertOne(lesson);
    res.status(201).json({ success: true, insertedId, lesson: { ...lesson, _id: insertedId } });
  })
);

// NOTE: must stay above "/:id" or Express will treat "mine" as a lesson id.
router.get(
  "/mine",
  verifyToken,
  wrap(async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(401).json({ error: "You must be logged in to view your lessons." });

    const db = await getDb();
    const lessons = await db.collection("lessons").find({ creatorId: userId }).sort({ createdAt: -1 }).toArray();
    res.json({ lessons });
  })
);

// ---------- single lesson ----------

router.get(
  "/:id",
  verifyToken,
  wrap(async (req, res) => {
    const { id } = req.params;
    const { userId } = req.query;
    if (!isValidId(id, res)) return;

    const db = await getDb();
    const lesson = await findLesson(db, id);
    if (!lesson) return res.status(404).json({ error: "Lesson not found." });

    const [authorLessonCount, viewerHasSaved] = await Promise.all([
      db.collection("lessons").countDocuments({ creatorId: lesson.creatorId }),
      userId ? db.collection("favorites").findOne({ userId, lessonId: id }).then(Boolean) : false,
    ]);

    const seed = [...id].reduce((sum, c) => sum + c.charCodeAt(0), 0);
    const views = 500 + ((seed * 37) % 9500);
    const viewerHasLiked = userId ? (lesson.likes || []).includes(userId) : false;

    res.json({ lesson, authorLessonCount, views, viewerHasLiked, viewerHasSaved });
  })
);

router.patch(
  "/:id/visibility",
  verifyToken,
  wrap(async (req, res) => {
    const { id } = req.params;
    const { userId, visibility } = req.body;
    if (!isValidId(id, res)) return;
    if (!["Public", "Private"].includes(visibility))
      return res.status(400).json({ error: "Visibility must be Public or Private." });

    const db = await getDb();
    const lesson = await findLesson(db, id);
    if (!lesson) return res.status(404).json({ error: "Lesson not found." });
    if (lesson.creatorId !== userId) return res.status(403).json({ error: "You can only edit your own lessons." });

    await db.collection("lessons").updateOne({ _id: lesson._id }, { $set: { visibility, updatedAt: new Date() } });
    res.json({ success: true, visibility });
  })
);

router.patch(
  "/:id/access-level",
  verifyToken,
  wrap(async (req, res) => {
    const { id } = req.params;
    const { userId, isPremium, accessLevel } = req.body;
    if (!isValidId(id, res)) return;
    if (!["Free", "Premium"].includes(accessLevel))
      return res.status(400).json({ error: "Access level must be Free or Premium." });
    if (accessLevel === "Premium" && !isPremium)
      return res.status(403).json({ error: "Upgrade to Premium to create paid lessons." });

    const db = await getDb();
    const lesson = await findLesson(db, id);
    if (!lesson) return res.status(404).json({ error: "Lesson not found." });
    if (lesson.creatorId !== userId) return res.status(403).json({ error: "You can only edit your own lessons." });

    await db.collection("lessons").updateOne({ _id: lesson._id }, { $set: { accessLevel, updatedAt: new Date() } });
    res.json({ success: true, accessLevel });
  })
);

router.delete(
  "/:id",
  verifyToken,
  wrap(async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;
    if (!isValidId(id, res)) return;

    const db = await getDb();
    const lesson = await findLesson(db, id);
    if (!lesson) return res.status(404).json({ error: "Lesson not found." });
    if (lesson.creatorId !== userId) return res.status(403).json({ error: "You can only delete your own lessons." });

    await Promise.all([
      db.collection("lessons").deleteOne({ _id: lesson._id }),
      db.collection("favorites").deleteMany({ lessonId: id }),
      db.collection("comments").deleteMany({ lessonId: id }),
    ]);
    res.json({ success: true });
  })
);

// ---------- engagement ----------

router.post(
  "/:id/like",
  verifyToken,
  wrap(async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;
    if (!isValidId(id, res)) return;
    if (!userId) return res.status(401).json({ error: "You must be logged in to like a lesson." });

    const db = await getDb();
    const lesson = await findLesson(db, id);
    if (!lesson) return res.status(404).json({ error: "Lesson not found." });

    const alreadyLiked = (lesson.likes || []).includes(userId);
    const update = alreadyLiked
      ? { $pull: { likes: userId }, $inc: { likesCount: -1 } }
      : { $addToSet: { likes: userId }, $inc: { likesCount: 1 } };

    await db.collection("lessons").updateOne({ _id: lesson._id }, update);
    res.json({ liked: !alreadyLiked, likesCount: Math.max((lesson.likesCount || 0) + (alreadyLiked ? -1 : 1), 0) });
  })
);

router.post(
  "/:id/favorite",
  verifyToken,
  wrap(async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;
    if (!isValidId(id, res)) return;
    if (!userId) return res.status(401).json({ error: "You must be logged in to save a lesson." });

    const db = await getDb();
    const existing = await db.collection("favorites").findOne({ userId, lessonId: id });

    if (existing) {
      await Promise.all([
        db.collection("favorites").deleteOne({ _id: existing._id }),
        db.collection("lessons").updateOne({ _id: new ObjectId(id) }, { $inc: { favoritesCount: -1 } }),
      ]);
      return res.json({ saved: false });
    }

    await Promise.all([
      db.collection("favorites").insertOne({ userId, lessonId: id, savedAt: new Date() }),
      db.collection("lessons").updateOne({ _id: new ObjectId(id) }, { $inc: { favoritesCount: 1 } }),
    ]);
    res.json({ saved: true });
  })
);

router.post(
  "/:id/report",
  verifyToken,
  wrap(async (req, res) => {
    const { id } = req.params;
    const { reporterUserId, reportedUserEmail, reason } = req.body;
    if (!isValidId(id, res)) return;
    if (!reporterUserId) return res.status(401).json({ error: "You must be logged in to report a lesson." });
    if (!reason) return res.status(400).json({ error: "Please choose a reason." });

    const db = await getDb();
    await db.collection("lessonsReports").insertOne({
      lessonId: id,
      reporterUserId,
      reportedUserEmail: reportedUserEmail || null,
      reason,
      timestamp: new Date(),
    });
    res.status(201).json({ success: true });
  })
);

// ---------- comments ----------

router.get(
  "/:id/comments",
  verifyToken,
  wrap(async (req, res) => {
    const db = await getDb();
    const comments = await db.collection("comments").find({ lessonId: req.params.id }).sort({ createdAt: -1 }).toArray();
    res.json({ comments });
  })
);

router.post(
  "/:id/comments",
  verifyToken,
  wrap(async (req, res) => {
    const { id } = req.params;
    const { userId, userName, userImage, text } = req.body;
    if (!userId) return res.status(401).json({ error: "You must be logged in to comment." });
    if (!text?.trim()) return res.status(400).json({ error: "Comment can't be empty." });

    const comment = { lessonId: id, userId, userName: userName || "Anonymous", userImage: userImage || null, text: text.trim(), createdAt: new Date() };
    const db = await getDb();
    const { insertedId } = await db.collection("comments").insertOne(comment);
    res.status(201).json({ comment: { ...comment, _id: insertedId } });
  })
);

module.exports = router;