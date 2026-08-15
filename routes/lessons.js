const express = require("express");
const { ObjectId } = require("mongodb");
const { getDb } = require("../Db");
const { createRemoteJWKSet, jwtVerify } = require("jose");
const router = express.Router();

const JWKS = createRemoteJWKSet(
  new URL(`https://${process.env.CLIENT_URL}/api/auth/jwks`)
);

async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://${process.env.CLIENT_URL}`,
      audience: `https://${process.env.CLIENT_URL}`,
    });

    req.userId = payload.id;
    req.userEmail = payload.email;
    req.userRole = payload.role;
    req.userIsPremium = Boolean(payload.isPremium);
    next();
  } catch (err) {
    console.error("verifyToken failed:", err.message);
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

// For public routes that behave slightly differently when a viewer IS
// logged in (Lesson Details' viewerHasLiked/viewerHasSaved), but must
// never reject an anonymous request outright.
async function optionalVerifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return next();
  const token = authHeader.split(" ")[1];
  if (!token) return next();

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://${process.env.CLIENT_URL}`,
      audience: `https://${process.env.CLIENT_URL}`,
    });
    req.userId = payload.id;
    req.userEmail = payload.email;
    req.userRole = payload.role;
    req.userIsPremium = Boolean(payload.isPremium);
  } catch (err) {
    console.error("optionalVerifyToken: ignoring invalid token —", err.message);
  }
  next();
}

module.exports = { verifyToken, optionalVerifyToken };

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
    const { featured = "" } = req.query;

    const query = { visibility: "Public" };
    if (category && category !== "All") query.category = category;
    if (tone && tone !== "All") query.emotionalTone = tone;
    if (featured === "true") query.isFeatured = true;
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

router.post("/", verifyToken, async (req, res) => {
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

router.get("/mine", verifyToken, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(401).json({ error: "You must be logged in to view your lessons." });
    }

    const db = await getDb();
    const lessons = await db
      .collection("lessons")
      .find({ creatorId: userId })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ lessons });
  } catch (err) {
    console.error("GET /api/lessons/mine failed:", err);
    res.status(500).json({ error: "Couldn't load your lessons." });
  }
});
router.patch("/:id/visibility", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, visibility } = req.body;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid lesson id." });
    }
    if (!["Public", "Private"].includes(visibility)) {
      return res.status(400).json({ error: "Visibility must be Public or Private." });
    }

    const db = await getDb();
    const lesson = await db.collection("lessons").findOne({ _id: new ObjectId(id) });
    if (!lesson) return res.status(404).json({ error: "Lesson not found." });
    if (lesson.creatorId !== userId) {
      return res.status(403).json({ error: "You can only edit your own lessons." });
    }

    await db
      .collection("lessons")
      .updateOne({ _id: lesson._id }, { $set: { visibility, updatedAt: new Date() } });

    res.json({ success: true, visibility });
  } catch (err) {
    console.error("PATCH /api/lessons/:id/visibility failed:", err);
    res.status(500).json({ error: "Couldn't update visibility." });
  }
});
router.patch("/:id/access-level", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, isPremium, accessLevel } = req.body;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid lesson id." });
    }
    if (!["Free", "Premium"].includes(accessLevel)) {
      return res.status(400).json({ error: "Access level must be Free or Premium." });
    }
    if (accessLevel === "Premium" && !isPremium) {
      return res.status(403).json({ error: "Upgrade to Premium to create paid lessons." });
    }

    const db = await getDb();
    const lesson = await db.collection("lessons").findOne({ _id: new ObjectId(id) });
    if (!lesson) return res.status(404).json({ error: "Lesson not found." });
    if (lesson.creatorId !== userId) {
      return res.status(403).json({ error: "You can only edit your own lessons." });
    }

    await db
      .collection("lessons")
      .updateOne({ _id: lesson._id }, { $set: { accessLevel, updatedAt: new Date() } });

    res.json({ success: true, accessLevel });
  } catch (err) {
    console.error("PATCH /api/lessons/:id/access-level failed:", err);
    res.status(500).json({ error: "Couldn't update access level." });
  }
})
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid lesson id." });
    }

    const db = await getDb();
    const lesson = await db.collection("lessons").findOne({ _id: new ObjectId(id) });
    if (!lesson) return res.status(404).json({ error: "Lesson not found." });
    if (lesson.creatorId !== userId) {
      return res.status(403).json({ error: "You can only delete your own lessons." });
    }

    await db.collection("lessons").deleteOne({ _id: lesson._id });
    await db.collection("favorites").deleteMany({ lessonId: id });
    await db.collection("comments").deleteMany({ lessonId: id });

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/lessons/:id failed:", err);
    res.status(500).json({ error: "Couldn't delete the lesson." });
  }
});

router.get("/:id", verifyToken, async (req, res) => {
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

router.post("/:id/like", verifyToken, async (req, res) => {
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
router.post("/:id/favorite", verifyToken, async (req, res) => {
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

router.post("/:id/report", verifyToken, async (req, res) => {
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
router.get("/:id/comments", verifyToken, async (req, res) => {
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

router.post("/:id/comments", verifyToken, async (req, res) => {
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