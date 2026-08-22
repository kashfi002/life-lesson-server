require("dotenv").config();
const express = require("express");
const cors = require("cors");

const lessonsRouter = require("./routes/lessons");
const favoritesRouter = require("./routes/favorites");
const adminRouter = require("./routes/admin");

const app = express();
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());

app.use("/api/lessons", lessonsRouter);
app.use("/api/favorites", favoritesRouter);
app.use("/api/admin", adminRouter);

app.get("/", (req, res) => {
  res.send("Digital Life Lessons API is running.");
});

const PORT = process.env.PORT || 5000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;