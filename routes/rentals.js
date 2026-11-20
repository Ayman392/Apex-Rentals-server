import express from "express";
import { getCollections } from "../db.js";
import { verifyToken } from "../Middleware/auth.js";

const router = express.Router();

// GET /rentals/my — Logged-in customer's rental bookings
router.get("/my", verifyToken, async (req, res) => {
  try {
    const email = req.decoded.email;
    const { rentals } = await getCollections();

    const items = await rentals
      .find({
        $or: [
          { customerEmail: email },
          { renterEmail: email },
          { "customer.email": email },
          { email },
        ],
      })
      .sort({ createdAt: -1, bookingDate: -1 })
      .toArray();

    res.json({ rentals: items });
  } catch (err) {
    console.error("Failed to fetch customer rentals:", err);
    res.status(500).json({ message: "Failed to load your rentals" });
  }
});

export default router;
