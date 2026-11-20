import { Router } from "express";
import { ObjectId } from "mongodb";
import { getCollections } from "../db.js";
import { verifyToken, verifyAdmin } from "../middleware/auth.js";

const router = Router();

async function getUsersCollection(db) {
  if (!db) return null;
  const cols = await db.listCollections({ name: "users" }).toArray();
  if (cols.length > 0) {
    const count = await db.collection("users").countDocuments();
    if (count > 0) return db.collection("users");
  }
  return db.collection("user");
}

async function resolveUsersCol() {
  const collections = await getCollections();
  if (collections.users) return collections.users;
  return getUsersCollection(collections.db);
}

// GET /admin/users — All registered users
router.get("/users", verifyToken, verifyAdmin, async (_req, res) => {
  try {
    const usersCol = await resolveUsersCol();
    if (!usersCol) {
      return res.status(500).json({ message: "Users collection unavailable" });
    }

    const users = await usersCol.find({}).sort({ createdAt: -1 }).toArray();

    const normalized = users.map((u) => ({
      _id: u._id,
      name: u.name || u.fullName || "Unnamed User",
      email: u.email || "",
      role: String(u.role || "customer").toLowerCase(),
      image: u.image || u.photoURL || u.photo || "",
      createdAt: u.createdAt || u.updatedAt || null,
    }));

    res.json({ users: normalized });
  } catch (err) {
    console.error("Failed to load users:", err);
    res.status(500).json({ message: err.message || "Failed to load users" });
  }
});

// PATCH /admin/users/:id/role — Update user role (customer | owner | admin)
router.patch("/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
  const { id } = req.params;
  const nextRole = String(req.body?.role || "")
    .toLowerCase()
    .trim();
  const validRoles = ["customer", "owner", "admin"];

  if (!validRoles.includes(nextRole)) {
    return res.status(400).json({ message: "Invalid role specified" });
  }

  try {
    const usersCol = await resolveUsersCol();
    if (!usersCol) {
      return res.status(500).json({ message: "Users collection unavailable" });
    }

    const filter = ObjectId.isValid(id)
      ? { $or: [{ _id: new ObjectId(id) }, { _id: id }, { id }] }
      : { $or: [{ _id: id }, { id }] };

    const result = await usersCol.updateOne(filter, {
      $set: { role: nextRole, updatedAt: new Date() },
    });

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const updated = await usersCol.findOne(filter);
    res.json({
      user: {
        _id: updated._id,
        name: updated.name || "Unnamed User",
        email: updated.email || "",
        role: String(updated.role || nextRole).toLowerCase(),
        createdAt: updated.createdAt || null,
      },
    });
  } catch (err) {
    console.error("Failed to update user role:", err);
    res
      .status(500)
      .json({ message: err.message || "Failed to update user role" });
  }
});

// DELETE /admin/users/:id — Delete user account
router.delete("/users/:id", verifyToken, verifyAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const usersCol = await resolveUsersCol();
    if (!usersCol) {
      return res.status(500).json({ message: "Users collection unavailable" });
    }

    const filter = ObjectId.isValid(id)
      ? { $or: [{ _id: new ObjectId(id) }, { _id: id }, { id }] }
      : { $or: [{ _id: id }, { id }] };

    const target = await usersCol.findOne(filter);
    if (!target) {
      return res.status(404).json({ message: "User not found" });
    }

    if (target.email && target.email === req.decoded.email) {
      return res
        .status(400)
        .json({ message: "You cannot delete your own admin account" });
    }

    await usersCol.deleteOne(filter);
    res.json({ message: "User deleted", id });
  } catch (err) {
    console.error("Failed to delete user:", err);
    res.status(500).json({ message: err.message || "Failed to delete user" });
  }
});

// GET /admin/equipment — All equipment items regardless of status
router.get("/equipment", verifyToken, verifyAdmin, async (_req, res) => {
  try {
    const { equipment } = await getCollections();
    const items = await equipment.find({}).sort({ createdAt: -1 }).toArray();
    res.json({ equipment: items });
  } catch (err) {
    console.error("Failed to load all equipment:", err);
    res
      .status(500)
      .json({ message: err.message || "Failed to load equipment" });
  }
});

// PATCH /admin/equipment/:id/status — Approve / Reject / Pending equipment
router.patch(
  "/equipment/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid equipment id" });
    }

    const nextStatus = String(req.body?.status || "")
      .toLowerCase()
      .trim();
    const allowed = ["pending", "approved", "rejected"];
    if (!allowed.includes(nextStatus)) {
      return res.status(400).json({ message: "Invalid status value" });
    }

    try {
      const { equipment } = await getCollections();
      const _id = new ObjectId(req.params.id);
      const result = await equipment.updateOne(
        { _id },
        { $set: { status: nextStatus, updatedAt: new Date() } },
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ message: "Equipment not found" });
      }

      const updated = await equipment.findOne({ _id });
      res.json({ equipment: updated });
    } catch (err) {
      console.error("Failed to update equipment status:", err);
      res
        .status(500)
        .json({ message: err.message || "Failed to update equipment status" });
    }
  },
);

// PATCH /admin/equipment/:id — Admin edit any equipment item
router.patch("/equipment/:id", verifyToken, verifyAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: "Invalid equipment id" });
  }

  try {
    const { equipment } = await getCollections();
    const _id = new ObjectId(req.params.id);
    const existing = await equipment.findOne({ _id });
    if (!existing) {
      return res.status(404).json({ message: "Equipment not found" });
    }

    const allowed = [
      "name",
      "category",
      "location",
      "rentalType",
      "price",
      "availableQuantity",
      "status",
      "image",
      "description",
    ];
    const updates = { updatedAt: new Date() };

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        if (key === "price" || key === "availableQuantity") {
          updates[key] = Number(req.body[key]);
        } else if (typeof req.body[key] === "string") {
          updates[key] = req.body[key].trim();
        } else {
          updates[key] = req.body[key];
        }
      }
    }

    await equipment.updateOne({ _id }, { $set: updates });
    const updated = await equipment.findOne({ _id });
    res.json({ equipment: updated });
  } catch (err) {
    console.error("Failed to update equipment:", err);
    res
      .status(500)
      .json({ message: err.message || "Failed to update equipment" });
  }
});

// DELETE /admin/equipment/:id — Admin delete any equipment item
router.delete("/equipment/:id", verifyToken, verifyAdmin, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: "Invalid equipment id" });
  }

  try {
    const { equipment } = await getCollections();
    const _id = new ObjectId(req.params.id);
    const result = await equipment.deleteOne({ _id });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Equipment not found" });
    }

    res.json({ message: "Equipment deleted", id: req.params.id });
  } catch (err) {
    console.error("Failed to delete equipment:", err);
    res
      .status(500)
      .json({ message: err.message || "Failed to delete equipment" });
  }
});

// GET /admin/rentals — All rental booking records across the platform
router.get("/rentals", verifyToken, verifyAdmin, async (_req, res) => {
  try {
    const { rentals } = await getCollections();
    const items = await rentals
      .find({})
      .sort({ createdAt: -1, bookingDate: -1 })
      .toArray();
    res.json({ rentals: items });
  } catch (err) {
    console.error("Failed to load all rentals:", err);
    res.status(500).json({ message: err.message || "Failed to load rentals" });
  }
});

export default router;
