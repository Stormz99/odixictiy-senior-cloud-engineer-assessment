"use strict";

const express = require("express");
const { MongoClient } = require("mongodb");
const crypto = require("crypto");
const { PubSub } = require("@google-cloud/pubsub");
const { createClient } = require("redis");

/* ===========================
   Config
=========================== */

const APP_PORT = parseInt(process.env.APP_PORT || "3000", 10);
const MONGO_URI = process.env.MONGO_URI || "mongodb://mongo:27017/assessmentdb";
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";

/* ===========================
   Mongo
=========================== */

let db;

const mongoClient = new MongoClient(MONGO_URI, {
  maxPoolSize: 100,
  minPoolSize: 20,
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
});

async function connectMongo() {
  while (!db) {
    try {
      await mongoClient.connect();
      db = mongoClient.db("assessmentdb");
      await db.collection("records").createIndex({ type: 1 });
      console.log("[mongo] connected");
    } catch (err) {
      console.error("[mongo] retrying in 5s...");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/* ===========================
   Redis (SAFE MODE)
=========================== */

let redisClient = null;

async function connectRedis() {
  try {
    const client = createClient({ url: REDIS_URL });

    client.on("error", (err) =>
      console.error("[redis] error:", err.message)
    );

    await client.connect();
    redisClient = client;
    console.log("[redis] connected");
  } catch (err) {
    console.error("[redis] unavailable — continuing without cache");
  }
}

connectRedis();

/* ===========================
   PubSub (SAFE MODE)
=========================== */

let topic = null;

try {
  const pubsub = new PubSub({
    apiEndpoint: process.env.PUBSUB_EMULATOR_HOST,
    projectId: "assessment-project",
  });

  topic = pubsub.topic("mongo-writes");
} catch (err) {
  console.error("[pubsub] unavailable");
}

/* ===========================
   Helpers
=========================== */

function randomPayload(size = 128) {
  return crypto
    .randomBytes(Math.ceil(size / 2))
    .toString("hex")
    .slice(0, size);
}

/* ===========================
   Express
=========================== */

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/readyz", (_req, res) => {
  if (!db) {
    return res.status(503).json({ status: "not ready" });
  }
  res.json({ status: "ready" });
});

/* ===========================
   Core Endpoint
=========================== */

app.get("/api/data", async (_req, res) => {
  if (!db) {
    return res.status(503).json({ status: "DB not ready" });
  }

  try {
    const col = db.collection("records");
    const now = new Date();

    // 5 async writes via PubSub
    for (let i = 0; i < 2; i++) {
      if (topic) {
        topic.publishMessage({
          data: Buffer.from(
            JSON.stringify({
              type: "write",
              index: i,
              payload: randomPayload(128),
              timestamp: now,
            })
          ),
        }).catch(() => {});
      }
    }

    let reads;

    // Redis cache if available
    if (redisClient) {
      const cached = await redisClient.get("cached_reads");

      if (cached) {
        reads = JSON.parse(cached);
      } else {
        const docs = await col
          .find({ type: "write" }, { projection: { _id: 1 } })
          .limit(5)
          .toArray();

        reads = docs.map((d) => d?._id?.toString() || null);

        await redisClient.set(
          "cached_reads",
          JSON.stringify(reads),
          { EX: 60 }
        );
      }
    } else {
      // fallback if Redis unavailable
      const docs = await col
        .find({ type: "write" }, { projection: { _id: 1 } })
        .sort({ timestamp: -1 })
        .limit(5)
        .toArray();

      reads = docs.map((d) => d?._id?.toString() || null);
    }

    res.json({
      status: "success",
      reads,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

/* ===========================
   Stats
=========================== */

app.get("/api/stats", async (_req, res) => {
  if (!db) return res.status(503).json({ status: "DB not ready" });

  const count = await db.collection("records").countDocuments({});
  res.json({ total_documents: count });
});

/* ===========================
   Start
=========================== */

app.listen(APP_PORT, "0.0.0.0", () => {
  console.log(`[app] listening on ${APP_PORT}`);
});

connectMongo();