import express from "express";
import { ObjectId } from "mongodb";
import { getCollections } from "../db.js";
import { verifyToken, verifyRenter, verifyOwner } from "../middleware/auth.js";

const router = express.Router();

// GET /rentals/my — Logged-in customer's rental bookings
router.get("/my", verifyToken, verifyRenter, async (req, res) => {
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

// GET /rentals/owner — Incoming rentals for the signed-in owner's equipment
router.get("/owner", verifyToken, verifyOwner, async (req, res) => {
  try {
    const email = req.decoded.email;
    const { rentals, equipment } = await getCollections();

    const ownedItems = await equipment
      .find({
        $or: [
          { ownerEmail: email },
          { createdByEmail: email },
          { "owner.email": email },
        ],
      })
      .project({ _id: 1 })
      .toArray();

    const ownedIds = ownedItems.map((item) => item._id.toString());

    const items = await rentals
      .find({
        $or: [
          { ownerEmail: email },
          { "owner.email": email },
          { equipmentId: { $in: ownedIds } },
        ],
      })
      .sort({ createdAt: -1, bookingDate: -1 })
      .toArray();

    res.json({ rentals: items });
  } catch (err) {
    console.error("Failed to fetch owner rentals:", err);
    res.status(500).json({ message: "Failed to load booking requests" });
  }
});

// PATCH /rentals/:id/status — Update booking status (owner of the rental's equipment only)
router.patch("/:id/status", verifyToken, verifyOwner, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: "Invalid rental id" });
  }

  const nextStatus = String(
    req.body?.bookingStatus || req.body?.status || "",
  ).trim();
  const allowedStatuses = [
    "Pending",
    "Confirmed",
    "Active",
    "Completed",
    "Cancelled",
  ];
  if (!allowedStatuses.includes(nextStatus)) {
    return res.status(400).json({ message: "Invalid booking status" });
  }

  try {
    const { rentals, equipment } = await getCollections();
    const _id = new ObjectId(req.params.id);
    const existing = await rentals.findOne({ _id });

    if (!existing) {
      return res.status(404).json({ message: "Rental not found" });
    }

    let isOwnerOfRental = existing.ownerEmail === req.decoded.email;
    if (!isOwnerOfRental && existing.equipmentId) {
      const eqFilter = ObjectId.isValid(existing.equipmentId)
        ? { _id: new ObjectId(String(existing.equipmentId)) }
        : { _id: existing.equipmentId };
      const linkedEq = await equipment.findOne(eqFilter);
      if (linkedEq) {
        isOwnerOfRental =
          linkedEq.ownerEmail === req.decoded.email ||
          linkedEq.createdByEmail === req.decoded.email ||
          linkedEq.owner?.email === req.decoded.email;
      }
    }

    if (!isOwnerOfRental) {
      return res
        .status(403)
        .json({ message: "Forbidden: you do not own this rental's equipment" });
    }

    await rentals.updateOne(
      { _id },
      {
        $set: {
          bookingStatus: nextStatus,
          status: nextStatus,
          updatedAt: new Date(),
        },
      },
    );

    const updated = await rentals.findOne({ _id });
    res.json({ rental: updated });
  } catch (err) {
    console.error("Failed to update rental status:", err);
    res.status(500).json({ message: "Failed to update rental status" });
  }
});

export default router;
