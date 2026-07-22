const { MongoClient } = require("mongodb");

/**
 * IMPORTANT: pick an explicit database name here, and make sure your
 * frontend's src/lib/mongodb.js uses the SAME name in its client.db("...")
 * call. Your connection string doesn't include a path, so calling
 * client.db() with no argument silently falls back to a database
 * literally named "test" — easy to miss, and easy to end up with
 * frontend and backend writing to two different databases by accident.
 */
const DB_NAME = "digital-life-lessons";

let client;
let dbPromise;

function getDb() {
  if (!dbPromise) {
    client = new MongoClient(process.env.MONGODB_URI);
    dbPromise = client.connect().then(() => client.db(DB_NAME));
  }
  return dbPromise;
}

module.exports = { getDb };