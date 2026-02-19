"use strict";

const express = require("express");
const { MongoClient } = require("mongodb");
const crypto = require("crypto");
const { PubSub } = require("@google-cloud/pubsub");

const MONGO_URI = process.env.MONGO_URI || "mongodb://mongo:27017/assessmentdb";
const APP_PORT = parseInt(process.env.APP_PORT || "3000", 10);

let db;
const mongoClient = new MongoClient(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 10000,
});
const pubsub = new PubSub({
  apiEndpoint: process.env.PUBSUB_EMULATOR_HOST,
  projectId: "assessment-project",
});

const topic = pubsub.topic("mongo-writes");

async function connectMongo(retries = 10, delayMs = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoClient.connect();
      db = mongoClient.db("assessmentdb");
      console.log(`[mongo] connected on attempt ${attempt}`);
      return;
    } catch (err) {
      console.error(
        `[mongo] attempt ${attempt}/${retries} failed: ${err.message}`,
      );
      if (attempt === retries)
        throw new Error(`MongoDB unreachable after ${retries} attempts`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

function randomPayload(size = 512) {
  return crypto
    .randomBytes(Math.ceil(size / 2))
    .toString("hex")
    .slice(0, size);
}

const app = express();
app.use(express.json());

// Liveness probe
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Readiness probe
app.get("/readyz", async (_req, res) => {
  if (!db)
    return res
      .status(503)
      .json({ status: "not ready", error: "DB not connected" });
  try {
    await mongoClient.db("admin").command({ ping: 1 });
    res.json({ status: "ready", timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: "not ready", error: err.message });
  }
});

// Core endpoint — must perform exactly 5 reads and 5 writes per request
app.get("/api/data", async (_req, res) => {
  if (!db)
    return res
      .status(503)
      .json({ status: "error", message: "DB not connected" });

  const col = db.collection("records");

  try {
    // 5 writes (publish to queue instead of direct Mongo writes)
const now = new Date();

const writes = await Promise.all(
  Array.from({ length: 5 }, (_, i) => {
    const payload = {
      type: "write",
      index: i,
      payload: randomPayload(),
      timestamp: now,
    };

    return topic.publishMessage({
      data: Buffer.from(JSON.stringify(payload)),
    });
  })
);

    // 5 reads
    const reads = [];
    for (let i = 0; i < 5; i++) {
      const doc = await col.findOne({ type: "write" });
      reads.push(doc ? doc._id.toString() : null);
    }

    res.json({
      status: "success",
      writes,
      reads,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Collection stats
app.get("/api/stats", async (_req, res) => {
  if (!db)
    return res
      .status(503)
      .json({ status: "error", message: "DB not connected" });
  try {
    const count = await db.collection("records").countDocuments({});
    res.json({ total_documents: count, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Start server immediately, connect to mongo in background
app.listen(APP_PORT, "0.0.0.0", () => {
  console.log(`[app] listening on port ${APP_PORT}`);
});

connectMongo().catch((err) => {
  console.error("[mongo] connection failed:", err.message);
});
