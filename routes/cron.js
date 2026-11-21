import { Router } from "express";
import { completeExpiredRentals } from "../services/rentalCompletion.js";

const router = Router();

// GET /cron/complete-rentals: called by Vercel Cron (sends the secret as a Bearer token)
router.get("/complete-rentals", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const result = await completeExpiredRentals();
    res.json(result);
  } catch (err) {
    console.error("Cron job failed:", err);
    res.status(500).json({ message: "Cron job failed" });
  }
});

export default router;
