import { Router } from "express";
import { getCollections } from "../db.js";
import { verifyToken, verifyOwner } from "../middleware/auth.js";

const router = Router();

// GET /owner/analytics — Owner listed equipment, completed rentals, total & monthly earnings
router.get("/analytics", verifyToken, verifyOwner, async (req, res) => {
  try {
    const ownerEmail = String(req.user?.email || req.decoded?.email || "")
      .toLowerCase()
      .trim();

    const { equipment, rentals } = await getCollections();

    const [ownerEquipment, allRentals] = await Promise.all([
      equipment ? equipment.find({}).toArray() : [],
      rentals ? rentals.find({}).toArray() : [],
    ]);

    const matchesOwnerEmail = (doc) => {
      const candidates = [
        doc?.ownerEmail,
        doc?.owner_email,
        doc?.providerEmail,
        doc?.userEmail,
        doc?.email,
        doc?.owner?.email,
        doc?.createdBy?.email,
      ];
      return candidates.some(
        (val) =>
          typeof val === "string" && val.toLowerCase().trim() === ownerEmail,
      );
    };

    const myEquipment = ownerEquipment.filter(matchesOwnerEmail);
    const myEquipmentIds = new Set(
      myEquipment
        .map((item) => String(item._id || item.id || ""))
        .filter(Boolean),
    );
    const myEquipmentNames = new Set(
      myEquipment
        .map((item) =>
          String(item.name || item.title || item.equipmentName || "")
            .toLowerCase()
            .trim(),
        )
        .filter(Boolean),
    );

    const equipById = new Map();
    const equipByName = new Map();
    for (const eq of myEquipment) {
      if (eq._id) equipById.set(String(eq._id), eq);
      const label = eq.name || eq.title || eq.equipmentName;
      if (label) {
        equipByName.set(String(label).toLowerCase().trim(), eq);
      }
    }

    const myRentals = allRentals.filter((r) => {
      if (matchesOwnerEmail(r)) return true;
      const rEquipId = String(r.equipmentId || r.itemId || r.productId || "");
      if (rEquipId && myEquipmentIds.has(rEquipId)) return true;
      const rEquipName = String(
        r.equipmentName || r.equipmentTitle || r.itemName || r.name || "",
      )
        .toLowerCase()
        .trim();
      return Boolean(rEquipName && myEquipmentNames.has(rEquipName));
    });

    const getRentalAmount = (r) => {
      const candidates = [
        r.totalAmount,
        r.amount,
        r.bookingAmount,
        r.rentalAmount,
        r.totalPrice,
        r.price,
      ];
      for (const val of candidates) {
        const num = Number(val);
        if (Number.isFinite(num) && num > 0) return num;
      }
      return 0;
    };

    const getRentalCategory = (r) => {
      const eqId = String(r.equipmentId || r.itemId || r.productId || "");
      const eqName = String(
        r.equipmentName || r.equipmentTitle || r.itemName || r.name || "",
      )
        .toLowerCase()
        .trim();
      const matchedEq =
        (eqId && equipById.get(eqId)) || (eqName && equipByName.get(eqName));

      const cat =
        r.category ||
        r.equipmentCategory ||
        r.categoryName ||
        r.equipment?.category ||
        matchedEq?.category ||
        matchedEq?.categoryName ||
        "General Equipment";

      return String(cat).trim() || "General Equipment";
    };

    const totalListedEquipment = myEquipment.length;

    const completedRentals = myRentals.filter((r) =>
      ["completed", "returned", "delivered"].includes(
        String(r.status || r.bookingStatus || "").toLowerCase(),
      ),
    ).length;

    const paidOrActiveRentals = myRentals.filter((r) => {
      const paymentStatus = String(r.paymentStatus || "").toLowerCase();
      const status = String(r.status || r.bookingStatus || "").toLowerCase();
      return (
        ["paid", "succeeded", "completed"].includes(paymentStatus) ||
        ["completed", "returned", "delivered", "confirmed", "active"].includes(
          status,
        )
      );
    });

    const totalEarnings = (
      paidOrActiveRentals.length > 0 ? paidOrActiveRentals : myRentals
    ).reduce((sum, r) => sum + getRentalAmount(r), 0);

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
        categoryTotals: new Map(),
      };
    });

    const findBucket = (dateVal) => {
      if (!dateVal) return buckets[buckets.length - 1];
      const dt = new Date(dateVal);
      if (Number.isNaN(dt.getTime())) return buckets[buckets.length - 1];
      return (
        buckets.find(
          (b) => b.year === dt.getFullYear() && b.monthIdx === dt.getMonth(),
        ) || buckets[buckets.length - 1]
      );
    };

    const overallCategoryMap = new Map();

    for (const r of myRentals) {
      const bucket = findBucket(
        r.createdAt || r.bookingDate || r.startDate || r.updatedAt,
      );
      const status = String(r.status || r.bookingStatus || "").toLowerCase();
      const paymentStatus = String(r.paymentStatus || "").toLowerCase();
      const amount = getRentalAmount(r);
      const category = getRentalCategory(r);

      if (["completed", "returned", "delivered"].includes(status)) {
        bucket.completed += 1;
        bucket.primary += amount;
      } else if (status === "pending") {
        bucket.pending += 1;
        bucket.secondary += amount;
      } else {
        bucket.active += 1;
        if (paymentStatus === "paid" || status === "confirmed") {
          bucket.primary += amount;
        } else {
          bucket.secondary += amount;
        }
      }

      bucket.categoryTotals.set(
        category,
        (bucket.categoryTotals.get(category) || 0) + amount,
      );
      overallCategoryMap.set(
        category,
        (overallCategoryMap.get(category) || 0) + amount,
      );
    }

    const latestBucket = buckets[buckets.length - 1];
    const latestCatSlices = Array.from(latestBucket.categoryTotals.entries())
      .map(([label, value]) => ({ label, value }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);

    const overallCatSlices = Array.from(overallCategoryMap.entries())
      .map(([label, value]) => ({ label, value }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);

    const breakdown =
      latestCatSlices.length > 0
        ? latestCatSlices.slice(0, 5)
        : overallCatSlices;

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
