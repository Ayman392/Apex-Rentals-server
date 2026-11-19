import jwt from "jsonwebtoken";
import { getCollections } from "../db.js";

// 1. verifyToken: checks the JWT and attaches the email to the request
export function verifyToken(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Unauthorized: token missing" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?.email) {
      return res.status(401).json({ message: "Unauthorized: invalid token" });
    }
    req.decoded = decoded;
    next();
  } catch {
    return res
      .status(401)
      .json({ message: "Unauthorized: invalid or expired token" });
  }
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
    if (user.role !== role) {
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
