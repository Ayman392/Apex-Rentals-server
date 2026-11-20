import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { getCollections, getDb } from "./db.js";
import { verifyToken } from "./Middleware/auth.js";
import equipmentRouter from "./routes/equipment.js";
import favoritesRouter from "./routes/favorites.js";
import paymentsRouter from "./routes/payments.js";

const app = express();
const PORT = process.env.PORT || 5000;

// Allowed frontend origins (comma-separated in CLIENT_URL)
const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // allow tools without an Origin header (curl, Postman, server-to-server)
      if (!origin || allowedOrigins.includes(origin))
        return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.use(express.json());
app.use(cookieParser());

app.get("/", (_req, res) => {
  res.json({ name: "Apex Rentals API", status: "running" });
});

app.get("/auth/me", verifyToken, async (req, res) => {
  const { users } = await getCollections();
  const user = await users.findOne(
    { email: req.decoded.email },
    {
      projection: {
        name: 1,
        email: 1,
        image: 1,
        role: 1,
        phone: 1,
        address: 1,
        createdAt: 1,
      },
    },
  );

  if (!user) return res.status(404).json({ message: "User not found" });
  res.json({ user });
});

app.patch("/auth/profile", verifyToken, async (req, res) => {
  try {
    const { name, image, phone, address } = req.body;
    const updateDoc = {
      updatedAt: new Date(),
    };

    if (typeof name === "string" && name.trim()) updateDoc.name = name.trim();
    if (typeof image === "string") updateDoc.image = image.trim();
    if (typeof phone === "string") updateDoc.phone = phone.trim();
    if (typeof address === "string") updateDoc.address = address.trim();

    const { users } = await getCollections();
    const result = await users.findOneAndUpdate(
      { email: req.decoded.email },
      { $set: updateDoc },
      {
        returnDocument: "after",
        projection: {
          name: 1,
          email: 1,
          image: 1,
          role: 1,
          phone: 1,
          address: 1,
          createdAt: 1,
        },
      },
    );

    if (!result) return res.status(404).json({ message: "User not found" });
    res.json({ user: result });
  } catch (err) {
    console.error("Profile update failed:", err);
    res.status(500).json({ message: "Failed to update profile" });
  }
});

// Health check: also confirms the database is reachable
app.get("/health", async (_req, res) => {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    res.json({ status: "ok", database: "connected" });
  } catch (err) {
    console.error("Health check failed:", err.message);
    res.status(503).json({ status: "error", database: "unreachable" });
  }
});

// Feature routes (mounted BEFORE the 404 handler)
app.use("/equipment", equipmentRouter);
app.use("/favorites", favoritesRouter);
app.use("/payments", paymentsRouter);

// Unknown routes (must stay after all routes)
app.use((req, res) => {
  res
    .status(404)
    .json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// Central error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res
    .status(err.status || 500)
    .json({ message: err.message || "Internal server error" });
});

// Run a local server; on Vercel the exported app is used instead
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    getDb()
      .then(() => console.log("MongoDB connected"))
      .catch((err) => console.error("MongoDB connection failed:", err.message));
  });
}

export default app;
