import { createPublicKey } from "node:crypto";
import jwt from "jsonwebtoken";
import { getCollections } from "../db.js";

let jwksCache;
const JWKS_CACHE_MS = 5 * 60 * 1000;

async function getSigningKey(kid) {
  const now = Date.now();
  if (!jwksCache || jwksCache.expiresAt <= now) {
    const clientUrl = (process.env.CLIENT_URL || "http://localhost:3000")
      .split(",")[0]
      .trim()
      .replace(/\/$/, "");
    const jwksUrl =
      process.env.AUTH_JWKS_URL || `${clientUrl}/api/auth/jwks`;
    const response = await fetch(jwksUrl);
    if (!response.ok) throw new Error(`JWKS endpoint returned ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body.keys)) throw new Error("Invalid JWKS response");
    jwksCache = { keys: body.keys, expiresAt: now + JWKS_CACHE_MS };
  }

  const jwk = jwksCache.keys.find((key) => key.kid === kid && key.kty === "RSA");
  if (!jwk) throw new Error("Signing key was not found");
  return createPublicKey({ key: jwk, format: "jwk" });
}

// Verify the Better Auth RS256 token and attach its identity to the request.
export async function verifyToken(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Unauthorized: token missing" });
  }

  const tokenHeader = jwt.decode(token, { complete: true })?.header;
  if (tokenHeader?.alg !== "RS256" || !tokenHeader.kid) {
    return res.status(401).json({ message: "Unauthorized: invalid token" });
  }

  let key;
  try {
    key = await getSigningKey(tokenHeader.kid);
  } catch {
    return res.status(503).json({ message: "Authentication keys are unavailable" });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, key, {
      algorithms: ["RS256"],
      issuer:
        process.env.AUTH_ISSUER ||
        `${(process.env.CLIENT_URL || "http://localhost:3000")
          .split(",")[0]
          .trim()
          .replace(/\/$/, "")}/api/auth`,
      audience: process.env.AUTH_AUDIENCE || "apex-rentals-api",
    });
  } catch {
    return res
      .status(401)
      .json({ message: "Unauthorized: invalid or expired token" });
  }

  if (!decoded?.email || !decoded?.sub) {
    return res.status(401).json({ message: "Unauthorized: invalid token" });
  }
  req.decoded = decoded;
  next();
}

// Builds a role gate. The role is read from the database on every request,
// so role changes made by an admin apply immediately.
function requireRole(role) {
  return async (req, res, next) => {
    const { users } = await getCollections();
    const user = await users.findOne({ email: req.decoded.email });

    if (!user) {
      return res.status(403).json({ message: "Forbidden: user not found" });
    }
    const userRole = String(user.role || "Customer").toLowerCase();
    if (userRole !== role) {
      return res
        .status(403)
        .json({ message: `Forbidden: ${role} access only` });
    }

    req.user = user;
    next();
  };
}

// 2. Role middlewares (always used after verifyToken)
export const verifyRenter = requireRole("customer");
export const verifyOwner = requireRole("owner");
export const verifyAdmin = requireRole("admin");
