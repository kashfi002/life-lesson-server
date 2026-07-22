require("dotenv").config();
const express = require("express");
const cors = require("cors");

const lessonsRouter = require("./routes/lessons");

const app = express();

// Allows your Next.js frontend (running on a different port/domain) to
// call this API. Set CLIENT_URL in .env to your actual frontend URL —
// for local dev that's usually http://localhost:3000.
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());

app.use("/api/lessons", lessonsRouter);

app.get("/", (req, res) => {
  res.send("Digital Life Lessons API is running.");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});