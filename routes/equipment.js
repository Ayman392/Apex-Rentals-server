import { Router } from "express";
import { ObjectId } from "mongodb";
import { getCollections } from "../db.js";
import { verifyToken, verifyOwner } from "../middleware/auth.js";

const router = Router();

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function toSlug(text = "") {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// GET /equipment/featured: 6 approved items (Home page)
router.get("/featured", async (_req, res) => {
  const { equipment } = await getCollections();
  const items = await equipment
    .find({ status: "approved" })
    .sort({ createdAt: -1 })
    .limit(6)
    .toArray();
  res.json(items);
});

// GET /equipment: All Equipment page, with backend search, filter, sort, pagination
// ?search=&category=&location=&rentalType=&minPrice=&maxPrice=&availability=&sort=&page=&limit=
router.get("/", async (req, res) => {
  const { equipment } = await getCollections();
  const {
    search = "",
    category,
    location,
    rentalType,
    minPrice,
    maxPrice,
    availability,
    sort = "newest",
    page = "1",
    limit = "9",
  } = req.query;

  const filter = { status: "approved" };

  const term = String(search).trim();
  if (term) {
    const rx = new RegExp(escapeRegex(term), "i");
    filter.$or = [{ name: rx }, { location: rx }, { category: rx }];
  }
  if (category && category !== "all") filter.category = String(category);
  if (location && location !== "all" && String(location).trim()) {
    filter.location = new RegExp(escapeRegex(String(location).trim()), "i");
  }
  if (rentalType && rentalType !== "all") {
    filter.rentalType = String(rentalType);
  }

  const price = {};
  if (
    minPrice !== undefined &&
    minPrice !== "" &&
    !Number.isNaN(Number(minPrice))
  ) {
    price.$gte = Number(minPrice);
  }
  if (
    maxPrice !== undefined &&
    maxPrice !== "" &&
    !Number.isNaN(Number(maxPrice))
  ) {
    price.$lte = Number(maxPrice);
  }
  if (Object.keys(price).length) filter.price = price;

  if (availability === "available") filter.availableQuantity = { $gt: 0 };
  if (availability === "unavailable") filter.availableQuantity = { $lte: 0 };

  const sorts = {
    "price-asc": { price: 1 },
    "price-desc": { price: -1 },
    newest: { createdAt: -1 },
  };
  const sortBy = sorts[sort] || sorts.newest;

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 9, 1), 50);

  const [items, total] = await Promise.all([
    equipment
      .find(filter)
      .sort(sortBy)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .toArray(),
    equipment.countDocuments(filter),
  ]);

  res.json({
    items,
    total,
    page: pageNum,
    pages: Math.max(Math.ceil(total / limitNum), 1),
  });
});

// GET /equipment/my — Listings belonging to the signed-in owner
router.get("/my", verifyToken, verifyOwner, async (req, res) => {
  try {
    const email = req.decoded.email;
    const { equipment } = await getCollections();

    const items = await equipment
      .find({
        $or: [
          { ownerEmail: email },
          { createdByEmail: email },
          { "owner.email": email },
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ equipment: items });
  } catch (err) {
    console.error("Failed to fetch owner equipment:", err);
    res.status(500).json({ message: "Failed to load your equipment" });
  }
});

// GET /equipment/slug/:slug: details of one approved item by slug (must be before /:id)
router.get("/slug/:slug", async (req, res) => {
  try {
    const requestedSlug = toSlug(decodeURIComponent(req.params.slug || ""));
    if (!requestedSlug) {
      return res.status(400).json({ message: "Invalid equipment slug" });
    }

    const { equipment } = await getCollections();

    // 1. Direct lookup if slug field is stored
    let item = await equipment.findOne({
      slug: requestedSlug,
      status: "approved",
    });

    // 2. Fallback: match slugified name across approved documents
    if (!item) {
      const approvedItems = await equipment
        .find({ status: "approved" })
        .toArray();
      item =
        approvedItems.find((doc) => toSlug(doc.name || "") === requestedSlug) ||
        null;
    }

    if (!item) {
      return res.status(404).json({ message: "Equipment not found" });
    }

    return res.json(item);
  } catch (err) {
    console.error("Failed to fetch equipment by slug:", err);
    return res.status(500).json({ message: "Failed to load equipment" });
  }
});

// POST /equipment — Create new equipment listing
router.post("/", verifyToken, verifyOwner, async (req, res) => {
  try {
    const {
      name,
      category,
      location,
      rentalType = "Daily",
      price,
      totalQuantity = 1,
      availableQuantity,
      image = "",
      description = "",
    } = req.body;

    if (!name?.trim() || !category?.trim() || price === undefined) {
      return res
        .status(400)
        .json({ message: "Name, category, and price are required" });
    }

    const cleanName = String(name).trim();
    const numericPrice = Number(price);
    const totalQty = Math.max(Number(totalQuantity) || 1, 1);
    const availQty =
      availableQuantity !== undefined
        ? Math.max(Number(availableQuantity) || 0, 0)
        : totalQty;

    const { equipment } = await getCollections();
    const doc = {
      name: cleanName,
      slug: toSlug(cleanName),
      category: String(category).trim(),
      location: String(location || "").trim(),
      rentalType: String(rentalType || "Daily"),
      price: numericPrice,
      totalQuantity: totalQty,
      availableQuantity: availQty,
      image: String(image || "").trim(),
      description: String(description || "").trim(),
      status: "approved",
      ownerEmail: req.decoded.email,
      ownerName: req.user?.name || req.decoded.name || "",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await equipment.insertOne(doc);
    res.status(201).json({
      equipment: { ...doc, _id: result.insertedId },
    });
  } catch (err) {
    console.error("Failed to create equipment:", err);
    res.status(500).json({ message: "Failed to create equipment" });
  }
});

// PATCH /equipment/:id — Update an owner's listing
router.patch("/:id", verifyToken, verifyOwner, async (req, res) => {
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

    const ownerMatch =
      existing.ownerEmail === req.decoded.email ||
      existing.createdByEmail === req.decoded.email ||
      existing.owner?.email === req.decoded.email ||
      String(req.user?.role || "").toLowerCase() === "admin";

    if (!ownerMatch) {
      return res
        .status(403)
        .json({ message: "Forbidden: you do not own this listing" });
    }

    const allowed = [
      "name",
      "category",
      "location",
      "rentalType",
      "price",
      "totalQuantity",
      "availableQuantity",
      "image",
      "description",
    ];
    const updates = { updatedAt: new Date() };

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        if (
          key === "price" ||
          key === "totalQuantity" ||
          key === "availableQuantity"
        ) {
          updates[key] = Number(req.body[key]);
        } else if (typeof req.body[key] === "string") {
          updates[key] = req.body[key].trim();
        } else {
          updates[key] = req.body[key];
        }
      }
    }

    if (typeof updates.name === "string" && updates.name) {
      updates.slug = toSlug(updates.name);
    }

    await equipment.updateOne({ _id }, { $set: updates });
    const updated = await equipment.findOne({ _id });
    res.json({ equipment: updated });
  } catch (err) {
    console.error("Failed to update equipment:", err);
    res.status(500).json({ message: "Failed to update equipment" });
  }
});

// DELETE /equipment/:id — Delete an owner's listing
router.delete("/:id", verifyToken, verifyOwner, async (req, res) => {
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

    const ownerMatch =
      existing.ownerEmail === req.decoded.email ||
      existing.createdByEmail === req.decoded.email ||
      existing.owner?.email === req.decoded.email ||
      String(req.user?.role || "").toLowerCase() === "admin";

    if (!ownerMatch) {
      return res
        .status(403)
        .json({ message: "Forbidden: you do not own this listing" });
    }

    await equipment.deleteOne({ _id });
    res.json({ message: "Equipment deleted", id: req.params.id });
  } catch (err) {
    console.error("Failed to delete equipment:", err);
    res.status(500).json({ message: "Failed to delete equipment" });
  }
});

// GET /equipment/:id: details of one approved item
router.get("/:id", async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: "Invalid equipment id" });
  }
  const { equipment } = await getCollections();
  const item = await equipment.findOne({
    _id: new ObjectId(req.params.id),
    status: "approved",
  });
  if (!item) return res.status(404).json({ message: "Equipment not found" });
  res.json(item);
});

export default router;
