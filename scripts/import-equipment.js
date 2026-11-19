import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { getCollections } from "../db.js";

const KEY = process.env.UNSPLASH_ACCESS_KEY;
const UTM = "utm_source=apex_rentals&utm_medium=referral";

const CATEGORIES = [
  "Construction Equipment",
  "Photography Equipment",
  "Vehicles & Transportation",
  "Agriculture Equipment",
  "Electronics",
  "Event Equipment",
];
const RENTAL_TYPES = ["Daily", "Weekly", "Monthly"];
const STATUSES = ["approved", "pending", "rejected"];

const CATEGORY_QUERY = {
  "Construction Equipment": "construction excavator machinery",
  "Photography Equipment": "professional camera equipment",
  "Vehicles & Transportation": "van truck vehicle",
  "Agriculture Equipment": "tractor farm machinery",
  Electronics: "projector laptop electronics",
  "Event Equipment": "stage lighting sound event",
};

const CACHE_URL = new URL("../data/photo-cache.json", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usedPhotoIds = new Set();
const categoryPools = new Map();
let cache = {}; // item name -> { photoId, image, imageCredit, source }
let requestCount = 0;

async function loadCache() {
  try {
    cache = JSON.parse(await readFile(CACHE_URL, "utf8"));
  } catch {
    cache = {};
  }
  for (const v of Object.values(cache)) usedPhotoIds.add(v.photoId);
}
const saveCache = () => writeFile(CACHE_URL, JSON.stringify(cache, null, 2));

function validate(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("data/equipment.json must be a non-empty JSON array");
  }
  items.forEach((it, i) => {
    const where = `Item ${i + 1} (${it.name || "no name"})`;
    if (!it.name || !it.description)
      throw new Error(`${where}: name/description missing`);
    if (!CATEGORIES.includes(it.category))
      throw new Error(`${where}: bad category "${it.category}"`);
    if (!RENTAL_TYPES.includes(it.rentalType))
      throw new Error(`${where}: bad rentalType "${it.rentalType}"`);
    if (!STATUSES.includes(it.status))
      throw new Error(`${where}: bad status "${it.status}"`);
    if (typeof it.price !== "number")
      throw new Error(`${where}: price must be a number`);
    if (typeof it.availableQuantity !== "number")
      throw new Error(`${where}: availableQuantity must be a number`);
    if (Number.isNaN(Date.parse(it.createdAt)))
      throw new Error(`${where}: createdAt is not a valid date`);
  });
}

function rateLimitError() {
  const err = new Error(
    `Unsplash rate limit reached after ${requestCount} requests`,
  );
  err.rateLimited = true;
  return err;
}

async function unsplash(path, params) {
  requestCount += 1;
  const res = await fetch(
    `https://api.unsplash.com${path}?${new URLSearchParams(params)}`,
    {
      headers: { Authorization: `Client-ID ${KEY}` },
    },
  );
  if (res.status === 403 || res.status === 429) throw rateLimitError();
  if (res.status === 401)
    throw new Error(
      "Unsplash rejected the Access Key. Check UNSPLASH_ACCESS_KEY in .env",
    );
  if (!res.ok) throw new Error(`Unsplash error ${res.status}`);
  return res.json();
}

async function search(query, perPage) {
  const data = await unsplash("/search/photos", {
    query,
    per_page: String(perPage),
    orientation: "landscape",
    content_filter: "high",
  });
  await sleep(200);
  return data.results;
}

async function toImageFields(photo) {
  // Unsplash guideline: trigger the download event when a photo is used.
  // This counts toward the hourly limit, so it is only done once per photo.
  requestCount += 1;
  fetch(photo.links.download_location, {
    headers: { Authorization: `Client-ID ${KEY}` },
  }).catch(() => {});

  return {
    photoId: photo.id,
    image: `${photo.urls.raw}&w=1200&h=800&fit=crop&q=80&auto=format`,
    imageCredit: {
      name: photo.user.name,
      url: `${photo.user.links.html}?${UTM}`,
    },
  };
}

async function takeUnused(results) {
  const photo = results.find((p) => !usedPhotoIds.has(p.id));
  if (!photo) return null;
  usedPhotoIds.add(photo.id);
  return toImageFields(photo);
}

async function findImage(item) {
  const specific = await takeUnused(await search(item.name, 10));
  if (specific) return { ...specific, source: "item" };

  if (!categoryPools.has(item.category)) {
    categoryPools.set(
      item.category,
      await search(CATEGORY_QUERY[item.category], 30),
    );
  }
  const fromCategory = await takeUnused(categoryPools.get(item.category));
  if (fromCategory) return { ...fromCategory, source: "category" };

  return null;
}

async function run() {
  if (!KEY) throw new Error("UNSPLASH_ACCESS_KEY is missing in .env");

  const raw = await readFile(
    new URL("../data/equipment.json", import.meta.url),
    "utf8",
  );
  const items = JSON.parse(raw);
  validate(items);
  await loadCache();
  console.log(
    `Validated ${items.length} items (${Object.keys(cache).length} photos already saved)`,
  );

  const docs = [];
  for (const item of items) {
    let photo = cache[item.name];
    let source = "cached";

    if (!photo) {
      try {
        const found = await findImage(item);
        if (found) {
          ({ source } = found);
          photo = {
            photoId: found.photoId,
            image: found.image,
            imageCredit: found.imageCredit,
            source,
          };
          cache[item.name] = photo;
          await saveCache(); // progress survives a rate-limit stop
        }
      } catch (err) {
        if (err.rateLimited) {
          const done = Object.keys(cache).length;
          console.error(
            `\nRate limit reached. ${done} of ${items.length} photos are saved in data/photo-cache.json.`,
          );
          console.error(
            "Nothing was imported yet. Run the same command again in about an hour.",
          );
          process.exit(1);
        }
        throw err;
      }
    }

    const { image: _ignored, ...rest } = item;
    const doc = { ...rest, createdAt: new Date(item.createdAt), seeded: true };
    if (photo) {
      doc.image = photo.image;
      doc.imageCredit = photo.imageCredit;
      console.log(`  [${source}] ${item.name}`);
    } else {
      doc.image = "";
      console.warn(`  [no photo] ${item.name}`);
    }
    docs.push(doc);
  }

  const { equipment } = await getCollections();
  const removed = await equipment.deleteMany({ seeded: true });
  const result = await equipment.insertMany(docs);

  console.log(`Unsplash requests used this run: ${requestCount}`);
  console.log(`Removed ${removed.deletedCount} old seeded items`);
  console.log(`Inserted ${result.insertedCount} equipment items`);
  process.exit(0);
}

run().catch((err) => {
  console.error("Import failed:", err.message);
  process.exit(1);
});
