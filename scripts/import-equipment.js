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

// Neutral placeholder: does not pretend to be a real equipment photo.
const FALLBACK_IMAGE =
  "https://placehold.co/1200x800?text=Equipment+Image+Unavailable";

// More descriptive queries produce better search results.
const ITEM_QUERIES = {
  "STIHL FS 230 Brush Cutter":
    "petrol handheld grass brush cutter landscaping tool",

  "APC Smart-UPS 1500VA":
    "APC Smart UPS uninterruptible power supply battery backup",

  "Chauvet DJ SlimPAR LED": "professional LED PAR stage lighting fixture",

  // Add more product-specific queries here.
};

// Force new Unsplash searches for products with incorrect cached images.
const FORCE_REFRESH_NAMES = new Set([
  "STIHL FS 230 Brush Cutter",
  "APC Smart-UPS 1500VA",
]);

const CACHE_URL = new URL("../data/photo-cache.json", import.meta.url);

const EQUIPMENT_URL = new URL("../data/equipment.json", import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const usedPhotoIds = new Set();

let cache = {};
let requestCount = 0;

// ------------------------------------------
// CACHE
// ------------------------------------------

async function loadCache() {
  try {
    cache = JSON.parse(await readFile(CACHE_URL, "utf8"));

    if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
      cache = {};
    }
  } catch {
    cache = {};
  }

  for (const photo of Object.values(cache)) {
    if (photo?.photoId) {
      usedPhotoIds.add(photo.photoId);
    }
  }
}

const saveCache = () => writeFile(CACHE_URL, JSON.stringify(cache, null, 2));

// ------------------------------------------
// VALIDATION
// ------------------------------------------

function validate(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("data/equipment.json must be a non-empty JSON array");
  }

  items.forEach((it, i) => {
    const where = `Item ${i + 1} (${it.name || "no name"})`;

    if (!it.name || !it.description) {
      throw new Error(`${where}: name/description missing`);
    }

    if (!CATEGORIES.includes(it.category)) {
      throw new Error(`${where}: bad category "${it.category}"`);
    }

    if (!RENTAL_TYPES.includes(it.rentalType)) {
      throw new Error(`${where}: bad rentalType "${it.rentalType}"`);
    }

    if (!STATUSES.includes(it.status)) {
      throw new Error(`${where}: bad status "${it.status}"`);
    }

    if (typeof it.price !== "number") {
      throw new Error(`${where}: price must be a number`);
    }

    if (typeof it.availableQuantity !== "number") {
      throw new Error(`${where}: availableQuantity must be a number`);
    }

    if (Number.isNaN(Date.parse(it.createdAt))) {
      throw new Error(`${where}: createdAt is not a valid date`);
    }
  });
}

// ------------------------------------------
// UNSPLASH API
// ------------------------------------------

function rateLimitError() {
  const err = new Error(
    `Unsplash rate limit reached after ${requestCount} requests`,
  );

  err.rateLimited = true;

  return err;
}

async function unsplash(path, params) {
  requestCount += 1;

  const url = new URL(`https://api.unsplash.com${path}`);

  url.search = new URLSearchParams(params).toString();

  const res = await fetch(url, {
    headers: {
      Authorization: `Client-ID ${KEY}`,
    },
  });

  if (res.status === 403 || res.status === 429) {
    throw rateLimitError();
  }

  if (res.status === 401) {
    throw new Error(
      "Unsplash rejected the Access Key. Check UNSPLASH_ACCESS_KEY in .env",
    );
  }

  if (!res.ok) {
    throw new Error(`Unsplash error ${res.status}`);
  }

  return res.json();
}

// ------------------------------------------
// SEARCH PHOTOS
// ------------------------------------------

async function search(query, perPage = 30) {
  const data = await unsplash("/search/photos", {
    query,
    per_page: String(perPage),
    orientation: "landscape",
    content_filter: "high",
  });

  await sleep(200);

  return data.results || [];
}

// ------------------------------------------
// PHOTO PROCESSING
// ------------------------------------------

async function toImageFields(photo) {
  // Unsplash requires a download event when using a photo.
  requestCount += 1;

  fetch(photo.links.download_location, {
    headers: {
      Authorization: `Client-ID ${KEY}`,
    },
  }).catch((err) => {
    console.warn("Unsplash download tracking failed:", err.message);
  });

  const imageUrl = new URL(photo.urls.raw);

  imageUrl.searchParams.set("w", "1200");
  imageUrl.searchParams.set("h", "800");
  imageUrl.searchParams.set("fit", "crop");
  imageUrl.searchParams.set("q", "80");
  imageUrl.searchParams.set("auto", "format");

  const profileUrl = new URL(photo.user.links.html);
  profileUrl.searchParams.set("utm_source", "apex_rentals");
  profileUrl.searchParams.set("utm_medium", "referral");

  return {
    photoId: photo.id,
    image: imageUrl.toString(),

    imageCredit: {
      name: photo.user.name,
      url: profileUrl.toString(),
    },
  };
}

async function takeUnused(results) {
  const photo = results.find((p) => p.id && !usedPhotoIds.has(p.id));

  if (!photo) {
    return null;
  }

  usedPhotoIds.add(photo.id);

  return toImageFields(photo);
}

// ------------------------------------------
// FIND CORRECT EQUIPMENT IMAGE
// ------------------------------------------

async function findImage(item) {
  const query = ITEM_QUERIES[item.name] || item.name;

  console.log(`  [searching] ${query}`);

  const results = await search(query, 30);

  const specific = await takeUnused(results);

  if (specific) {
    return {
      ...specific,
      source: "item",
    };
  }

  console.warn(`  [no matching search results] ${item.name}`);

  return null;
}

// ------------------------------------------
// MAIN IMPORT
// ------------------------------------------

async function run() {
  if (!KEY) {
    throw new Error("UNSPLASH_ACCESS_KEY is missing in .env");
  }

  const raw = await readFile(EQUIPMENT_URL, "utf8");

  const items = JSON.parse(raw);

  validate(items);

  await loadCache();

  console.log(
    `Validated ${items.length} items (${Object.keys(cache).length} cached photos)`,
  );

  // Remove only the cache entries explicitly marked for refresh.
  let cacheChanged = false;

  for (const name of FORCE_REFRESH_NAMES) {
    if (cache[name]) {
      console.log(`[refresh] Removing old cached image: ${name}`);

      delete cache[name];

      cacheChanged = true;
    }
  }

  if (cacheChanged) {
    await saveCache();
  }

  const docs = [];

  for (const item of items) {
    let photo = cache[item.name];
    let source = "cached";

    // Search Unsplash if the cache entry is missing.
    if (!photo?.image) {
      try {
        const found = await findImage(item);

        if (found) {
          source = found.source;

          photo = {
            photoId: found.photoId,
            image: found.image,
            imageCredit: found.imageCredit,
            source,
          };

          cache[item.name] = photo;

          // Save progress immediately.
          await saveCache();
        }
      } catch (err) {
        if (err.rateLimited) {
          const done = items.filter((it) => cache[it.name]?.image).length;

          console.error(
            `\nRate limit reached. ${done} of ${items.length} photos are saved in data/photo-cache.json.`,
          );

          console.error("Import stopped. Run the same command again later.");

          process.exit(1);
        }

        throw err;
      }
    }

    // Build MongoDB document.
    const { image: _ignored, ...rest } = item;

    const doc = {
      ...rest,
      createdAt: new Date(item.createdAt),
      seeded: true,
    };

    // Use cached or newly downloaded image.
    if (photo?.image) {
      doc.image = photo.image;
      doc.imageCredit = photo.imageCredit || null;

      console.log(`  [${source}] ${item.name}`);
    } else {
      // Never assign an unrelated equipment photograph.
      doc.image = FALLBACK_IMAGE;
      doc.imageCredit = null;

      console.warn(`  [fallback image] ${item.name}`);
    }

    docs.push(doc);
  }

  // ----------------------------------------
  // MONGODB IMPORT
  // ----------------------------------------

  const { equipment } = await getCollections();

  const removed = await equipment.deleteMany({
    seeded: true,
  });

  const result = await equipment.insertMany(docs);

  console.log("\n========== IMPORT COMPLETE ==========");

  console.log(`Unsplash requests used this run: ${requestCount}`);

  console.log(`Removed ${removed.deletedCount} old seeded items`);

  console.log(`Inserted ${result.insertedCount} equipment items`);

  console.log(
    `Photos cached: ${docs.filter((d) => d.image !== FALLBACK_IMAGE).length}`,
  );

  console.log(
    `Fallback images: ${docs.filter((d) => d.image === FALLBACK_IMAGE).length}`,
  );

  console.log("=====================================");

  process.exit(0);
}

// ------------------------------------------
// ERROR HANDLING
// ------------------------------------------

run().catch((err) => {
  console.error("Import failed:", err.message);

  process.exit(1);
});
