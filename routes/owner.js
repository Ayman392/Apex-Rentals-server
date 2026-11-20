import { Router } from "express";
import { getCollections } from "../db.js";
import { verifyToken } from "../middleware/auth.js";

const router = Router();

// GET /owner/analytics — Owner equipment, bookings & earnings metrics
router.get("/analytics", verifyToken, async (req, res) => {
  try {
    const email = String(req.decoded?.email || "").toLowerCase();
    const { equipment, rentals } = await getCollections();

    const ownerEquipment = await equipment
      .find({
        $or: [
          { ownerEmail: { $regex: `^${email}$`, $options: "i" } },
          { "owner.email": { $regex: `^${email}$`, $options: "i" } },
          { email: { $regex: `^${email}$`, $options: "i" } },
        ],
      })
      .toArray();

    const equipmentIds = new Set(ownerEquipment.map((e) => String(e._id)));

    const allRentals = await rentals.find({}).toArray();
    const ownerRentals = allRentals.filter((r) => {
      const rOwnerEmail = String(
        r.ownerEmail || r.owner?.email || "",
      ).toLowerCase();
      const rEquipId = String(r.equipmentId || r.itemId || "");
      return rOwnerEmail === email || equipmentIds.has(rEquipId);
    });

    const totalListedEquipment = ownerEquipment.length;
    const completedRentals = ownerRentals.filter((r) =>
      ["completed", "returned", "delivered"].includes(
        String(r.status || r.bookingStatus || "").toLowerCase(),
      ),
    ).length;

    const totalEarnings = ownerRentals.reduce(
      (sum, r) =>
        sum + Number(r.totalAmount ?? r.amount ?? r.bookingAmount ?? 0),
      0,
    );

    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const now = new Date();
    const buckets = Array.from({ length: 12 }, (_, idx) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (11 - idx), 1);
      return {
        year: d.getFullYear(),
        monthIdx: d.getMonth(),
        month: monthNames[d.getMonth()],
        primary: 0,
        secondary: 0,
        completed: 0,
        active: 0,
        pending: 0,
      };
    });

    for (const r of ownerRentals) {
      const dt = new Date(r.createdAt || r.bookingDate || r.startDate || now);
      const bucket =
        buckets.find(
          (b) => b.year === dt.getFullYear() && b.monthIdx === dt.getMonth(),
        ) || buckets[buckets.length - 1];
      const status = String(r.status || r.bookingStatus || "").toLowerCase();
      const amount = Number(r.totalAmount ?? r.amount ?? r.bookingAmount ?? 0);

      if (["completed", "returned", "delivered"].includes(status)) {
        bucket.completed += 1;
        bucket.primary += amount;
      } else if (status === "pending") {
        bucket.pending += 1;
      } else {
        bucket.active += 1;
        bucket.secondary += amount;
      }
    }

    const catMap = new Map();
    for (const r of ownerRentals) {
      const cat = String(
        r.category || r.equipmentCategory || "Listed Equipment",
      ).trim();
      const amount = Number(r.totalAmount ?? r.amount ?? r.bookingAmount ?? 0);
      catMap.set(cat, (catMap.get(cat) || 0) + amount);
    }

    const breakdown = Array.from(catMap.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);

    res.json({
      kpis: {
        totalListedEquipment,
        completedRentals,
        totalEarnings,
      },
      monthly: buckets.map(
        ({ month, primary, secondary, completed, active, pending }) => ({
          month,
          primary,
          secondary,
          completed,
          active,
          pending,
        }),
      ),
      breakdown,
    });
  } catch (err) {
    console.error("Failed to load owner analytics:", err);
    res
      .status(500)
      .json({ message: err.message || "Failed to load owner analytics" });
  }
});

export default router;
