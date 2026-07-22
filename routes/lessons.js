const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../db");

const router = express.Router();

/**
 * GET /api/lessons
 * -----------------------------------------------------------------------
 * Public — no login required, matches the PDF's "anyone (logged-in or
 * not) can browse public lessons." Supports:
 *
 *   ?search=keyword       matches title OR description (case-insensitive)
 *   ?category=Career      one of the 5 fixed categories, or omitted/"All"
 *   ?tone=Motivational    one of the 4 fixed tones, or omitted/"All"
 *   ?sort=newest|mostSaved
 *   ?page=1&limit=6       pagination
 *
 * Returns { lessons, total, page, totalPages } so the frontend can
 * render page-number controls without a second request.
 */
router.get("/", async (req, res) => {
  try {
    const db = await getDb();
    const {
      search = "",
      category = "",
      tone = "",
      sort = "newest",
      page = "1",
      limit = "6",
    } = req.query;

    const query = { visibility: "Public" };
    if (category && category !== "All") query.category = category;
    if (tone && tone !== "All") query.emotionalTone = tone;
    if (search.trim()) {
      const regex = { $regex: search.trim(), $options: "i" };
      query.$or = [{ title: regex }, { description: regex }];
    }

    const sortMap = {
      newest: { createdAt: -1 },
      mostSaved: { favoritesCount: -1, createdAt: -1 },
    };
    const sortStage = sortMap[sort] || sortMap.newest;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.max(parseInt(limit, 10) || 6, 1);
    const skip = (pageNum - 1) * limitNum;

    const [total, lessons] = await Promise.all([
      db.collection("lessons").countDocuments(query),
      db
        .collection("lessons")
        .find(query)
        .sort(sortStage)
        .skip(skip)
        .limit(limitNum)
        .toArray(),
    ]);

    res.json({
      lessons,
      total,
      page: pageNum,
      totalPages: Math.max(Math.ceil(total / limitNum), 1),
    });
  } catch (err) {
    console.error("GET /api/lessons failed:", err);
    res.status(500).json({ error: "Couldn't load lessons." });
  }
});

/**
 * POST /api/lessons
 * -----------------------------------------------------------------------
 * Saves everything from the Add Lesson form, plus who posted it.
 *
 * Expected body (from the frontend's AddLessonPage):
 *   {
 *     title, description, category, emotionalTone, image,
 *     visibility, accessLevel,
 *     creatorId, creatorName, creatorEmail, creatorImage
 *   }
 *
 * TEMPORARY: creatorId/creatorName/creatorEmail are trusted from the
 * request body for now. Once you build real token verification
 * (Challenge 2), replace this with reading the verified user off the
 * request instead of trusting these fields directly — right now
 * someone could spoof a different name via DevTools.
 */
router.post("/", async (req, res) => {
  try {
    const {
      title,
      description,
      category,
      emotionalTone,
      image,
      visibility,
      accessLevel,
      creatorId,
      creatorName,
      creatorEmail,
      creatorImage,
    } = req.body;

    if (!title?.trim() || !description?.trim() || !category || !emotionalTone) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    if (!creatorId || !creatorEmail) {
      return res.status(401).json({ error: "You must be logged in to publish a lesson." });
    }

    const db = await getDb();

    const lesson = {
      title: title.trim(),
      description: description.trim(),
      category,
      emotionalTone,
      image: image || null,
      visibility: visibility === "Private" ? "Private" : "Public",
      accessLevel: accessLevel === "Premium" ? "Premium" : "Free",

      // who posted it
      creatorId,
      creatorName: creatorName || "Anonymous",
      creatorEmail,
      creatorImage: creatorImage || null,

      // engagement fields the rest of the app will need later
      likes: [],
      likesCount: 0,
      favoritesCount: 0,
      isFeatured: false,
      isReviewed: false,

      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("lessons").insertOne(lesson);

    res.status(201).json({
      success: true,
      insertedId: result.insertedId,
      lesson: { ...lesson, _id: result.insertedId },
    });
  } catch (err) {
    console.error("POST /api/lessons failed:", err);
    res.status(500).json({ error: "Something went wrong while saving the lesson." });
  }
});

/**
 * GET /api/lessons/:id
 * -----------------------------------------------------------------------
 * Powers the Lesson Details page. Optionally pass ?userId=... so the
 * response tells the frontend whether *this* viewer already liked/saved
 * it — saves a second round trip on page load.
 *
 * `views` is a deterministic pseudo-random number seeded from the
 * lesson's own id, per the PDF's "static random value" — deterministic
 * so it doesn't jump around on every reload, since nothing is actually
 * tracking real views yet.
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid lesson id." });
    }

    const db = await getDb();
    const lesson = await db.collection("lessons").findOne({ _id: new ObjectId(id) });
    if (!lesson) {
      return res.status(404).json({ error: "Lesson not found." });
    }

    const authorLessonCount = await db
      .collection("lessons")
      .countDocuments({ creatorId: lesson.creatorId });

    const seed = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const views = 500 + ((seed * 37) % 9500);

    const viewerHasLiked = userId ? (lesson.likes || []).includes(userId) : false;
    let viewerHasSaved = false;
    if (userId) {
      const fav = await db.collection("favorites").findOne({ userId, lessonId: id });
      viewerHasSaved = Boolean(fav);
    }

    res.json({ lesson, authorLessonCount, views, viewerHasLiked, viewerHasSaved });
  } catch (err) {
    console.error("GET /api/lessons/:id failed:", err);
    res.status(500).json({ error: "Couldn't load this lesson." });
  }
});

/**
 * POST /api/lessons/:id/like
 * -----------------------------------------------------------------------
 * Toggles the given userId in/out of the lesson's likes[] array and
 * keeps likesCount in sync. TEMPORARY: userId is trusted from the
 * request body, same caveat as the rest of this file — real
 * verification comes with Challenge 2.
 */
router.post("/:id/like", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid lesson id." });
    }
    if (!userId) {
      return res.status(401).json({ error: "You must be logged in to like a lesson." });
    }

    const db = await getDb();
    const lesson = await db.collection("lessons").findOne({ _id: new ObjectId(id) });
    if (!lesson) {
      return res.status(404).json({ error: "Lesson not found." });
    }

    const alreadyLiked = (lesson.likes || []).includes(userId);
    const update = alreadyLiked
      ? { $pull: { likes: userId }, $inc: { likesCount: -1 } }
      : { $addToSet: { likes: userId }, $inc: { likesCount: 1 } };

    await db.collection("lessons").updateOne({ _id: lesson._id }, update);

    res.json({
      liked: !alreadyLiked,
      likesCount: Math.max((lesson.likesCount || 0) + (alreadyLiked ? -1 : 1), 0),
    });
  } catch (err) {
    console.error("POST /api/lessons/:id/like failed:", err);
    res.status(500).json({ error: "Couldn't update like." });
  }
});

/**
 * POST /api/lessons/:id/favorite
 * -----------------------------------------------------------------------
 * Toggles a { userId, lessonId } document in the separate `favorites`
 * collection (matches the PDF's suggested schema) and keeps the
 * lesson's favoritesCount in sync alongside it.
 */
router.post("/:id/favorite", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid lesson id." });
    }
    if (!userId) {
      return res.status(401).json({ error: "You must be logged in to save a lesson." });
    }

    const db = await getDb();
    const existing = await db.collection("favorites").findOne({ userId, lessonId: id });

    if (existing) {
      await db.collection("favorites").deleteOne({ _id: existing._id });
      await db
        .collection("lessons")
        .updateOne({ _id: new ObjectId(id) }, { $inc: { favoritesCount: -1 } });
      return res.json({ saved: false });
    }

    await db.collection("favorites").insertOne({ userId, lessonId: id, savedAt: new Date() });
    await db
      .collection("lessons")
      .updateOne({ _id: new ObjectId(id) }, { $inc: { favoritesCount: 1 } });
    res.json({ saved: true });
  } catch (err) {
    console.error("POST /api/lessons/:id/favorite failed:", err);
    res.status(500).json({ error: "Couldn't update favorites." });
  }
});

/**
 * POST /api/lessons/:id/report
 * -----------------------------------------------------------------------
 * Creates one document in `lessonsReports`, matching the PDF's schema:
 * lessonId, reporterUserId, reportedUserEmail, reason, timestamp.
 */
router.post("/:id/report", async (req, res) => {
  try {
    const { id } = req.params;
    const { reporterUserId, reportedUserEmail, reason } = req.body;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid lesson id." });
    }
    if (!reporterUserId) {
      return res.status(401).json({ error: "You must be logged in to report a lesson." });
    }
    if (!reason) {
      return res.status(400).json({ error: "Please choose a reason." });
    }

    const db = await getDb();
    await db.collection("lessonsReports").insertOne({
      lessonId: id,
      reporterUserId,
      reportedUserEmail: reportedUserEmail || null,
      reason,
      timestamp: new Date(),
    });

    res.status(201).json({ success: true });
  } catch (err) {
    console.error("POST /api/lessons/:id/report failed:", err);
    res.status(500).json({ error: "Couldn't submit the report." });
  }
});

/**
 * GET /api/lessons/:id/comments
 * POST /api/lessons/:id/comments
 * -----------------------------------------------------------------------
 * Simple flat comment list per lesson, newest first.
 */
router.get("/:id/comments", async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const comments = await db
      .collection("comments")
      .find({ lessonId: id })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ comments });
  } catch (err) {
    console.error("GET /api/lessons/:id/comments failed:", err);
    res.status(500).json({ error: "Couldn't load comments." });
  }
});

router.post("/:id/comments", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, userName, userImage, text } = req.body;
    if (!userId) {
      return res.status(401).json({ error: "You must be logged in to comment." });
    }
    if (!text?.trim()) {
      return res.status(400).json({ error: "Comment can't be empty." });
    }

    const db = await getDb();
    const comment = {
      lessonId: id,
      userId,
      userName: userName || "Anonymous",
      userImage: userImage || null,
      text: text.trim(),
      createdAt: new Date(),
    };
    const result = await db.collection("comments").insertOne(comment);

    res.status(201).json({ comment: { ...comment, _id: result.insertedId } });
  } catch (err) {
    console.error("POST /api/lessons/:id/comments failed:", err);
    res.status(500).json({ error: "Couldn't post the comment." });
  }
});

module.exports = router;