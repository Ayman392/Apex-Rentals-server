import { Router } from "express";
import { ObjectId } from "mongodb";
import { getCollections } from "../db.js";

const router = Router();

// POST /favorites: add equipment to user's favorites
router.post("/", async (req, res) => {
  try {
    const { equipmentId, userEmail } = req.body;
    if (!equipmentId || !userEmail || !ObjectId.isValid(equipmentId)) {
      return res
        .status(400)
        .json({ message: "Invalid equipmentId or userEmail" });
    }

    const { favorites } = await getCollections();
    const eqObjectId = new ObjectId(equipmentId);

    const existing = await favorites.findOne({
      equipmentId: eqObjectId,
      userEmail,
    });
    if (existing) {
      return res
        .status(200)
        .json({ message: "Already in favorites", favorite: existing });
    }

    const doc = {
      equipmentId: eqObjectId,
      userEmail,
      createdAt: new Date(),
    };
    const result = await favorites.insertOne(doc);
    res.status(201).json({ _id: result.insertedId, ...doc });
  } catch (err) {
    res.status(500).json({ message: err.message || "Failed to add favorite" });
  }
});

// GET /favorites?email=user@example.com: list user's favorites with equipment info
router.get("/", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim();
    if (!email) {
      return res
        .status(400)
        .json({ message: "Email query parameter is required" });
    }

    const { favorites } = await getCollections();
    const items = await favorites
      .aggregate([
        { $match: { userEmail: email } },
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: "equipment",
            localField: "equipmentId",
            foreignField: "_id",
            as: "equipment",
          },
        },
        { $unwind: "$equipment" },
      ])
      .toArray();

    res.json(items);
  } catch (err) {
    res
      .status(500)
      .json({ message: err.message || "Failed to load favorites" });
  }
});

// DELETE /favorites/:id: remove a favorite by its document _id
router.delete("/:id", async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid favorite id" });
    }
    const { favorites } = await getCollections();
    const result = await favorites.deleteOne({
      _id: new ObjectId(req.params.id),
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Favorite not found" });
    }
    res.json({ deleted: true });
  } catch (err) {
    res
      .status(500)
      .json({ message: err.message || "Failed to remove favorite" });
  }
});

export default router;
