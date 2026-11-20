import { Router } from "express";
import { ObjectId } from "mongodb";
import { getCollections } from "../db.js";

const router = Router();

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
