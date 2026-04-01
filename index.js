const { MongoClient } = require('mongodb');

const uri = "mongodb+srv://adamdh7:Tchengy1@mizik.ylycjwa.mongodb.net/?appName=mizik";

async function run() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    console.log("✅ Successfully connected to MongoDB Atlas!");
    
    // Optional: list databases
    const dbs = await client.db().admin().listDatabases();
    console.log("Databases:", dbs.databases.map(db => db.name));
    
  } catch (err) {
    console.error("❌ Connection error:", err);
  } finally {
    await client.close();
  }
}

run();
