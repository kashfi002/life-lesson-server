const { createRemoteJWKSet, jwtVerify } = require("jose");

const CLIENT_URL = process.env.CLIENT_URL?.replace(/\/$/, "");
const JWKS = createRemoteJWKSet(new URL(`${CLIENT_URL}/api/auth/jwks`));
async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
    const token = authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const { payload } = await jwtVerify(token, JWKS, { issuer: CLIENT_URL, audience: CLIENT_URL });
    req.userId = payload.id;
    req.userEmail = payload.email;
    req.userRole = payload.role;
    req.userIsPremium = Boolean(payload.isPremium);
    next();
  } catch (err) {
    console.error("verifyToken failed:", err.message);
    res.status(401).json({ error: "Invalid or expired token." });
  }
}

async function optionalVerifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return next();
  const token = authHeader.split(" ")[1];
  if (!token) return next();

  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: CLIENT_URL, audience: CLIENT_URL });
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