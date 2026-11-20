import { MongoClient, ServerApiVersion } from "mongodb";

let dbPromise;

// Connects once and reuses the connection (important on serverless hosts)
export function getDb() {
  if (!dbPromise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not set in the environment");

    const client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });

    dbPromise = client
      .connect()
      .then((c) => c.db(process.env.DB_NAME || "apex-rentals"))
      .catch((err) => {
        dbPromise = undefined; // allow a retry on the next request
        throw err;
      });
  }
  return dbPromise;
}

export async function getCollections() {
  const db = await getDb();
  return {
    users: db.collection("users"),
    equipment: db.collection("equipment"),
    rentals: db.collection("rentals"),
    payments: db.collection("payments"),
    favorites: db.collection("favorites"),
  };
}
