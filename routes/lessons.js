const express = require("express");
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

module.exports = router;