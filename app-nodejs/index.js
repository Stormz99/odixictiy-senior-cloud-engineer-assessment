"use strict";

const express = require("express");
const { MongoClient } = require("mongodb");
const crypto = require("crypto");

const MONGO_URI =
  process.env.MONGO_URI || "mongodb://mongo:27017/assessmentdb";
const APP_PORT = parseInt(process.env.APP_PORT || "3000", 10);

let db;

const mongoClient = new MongoClient(MONGO_URI, {
  maxPoolSize: 200,
  minPoolSize: 20,
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 10000,
});

async function connectMongo(retries = 10, delayMs = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoClient.connect();
      db = mongoClient.db("assessmentdb");

      await db.collection("records").createIndex({ type: 1 });

      console.log(`[mongo] connected on attempt ${attempt}`);
      return;
    } catch (err) {
      console.error(
        `[mongo] attempt ${attempt}/${retries} failed: ${err.message}`
      );

      if (attempt === retries) {
        throw new Error(`MongoDB unreachable after ${retries} attempts`);
      }

      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

function randomPayload(size = 128) {
  return crypto
    .randomBytes(Math.ceil(size / 2))
    .toString("hex")
    .slice(0, size);
}

const app = express();
app.use(express.json());

/* ===========================
   Liveness Probe
=========================== */
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/* ===========================
   Readiness Probe
=========================== */
app.get("/readyz", async (_req, res) => {
  if (!db) {
    return res
      .status(503)
      .json({ status: "not ready", error: "DB not connected" });
  }

  try {
    await mongoClient.db("admin").command({ ping: 1 });
    res.json({ status: "ready", timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: "not ready", error: err.message });
  }
});

/* ===========================
   Core Endpoint
   MUST perform 5 reads + 5 writes
=========================== */
app.get("/api/data", async (_req, res) => {
  if (!db) {
    return res
      .status(503)
      .json({ status: "error", message: "DB not connected" });
  }

  const col = db.collection("records");

  try {
    const now = new Date();

    // 5 NON-BLOCKING writes
    for (let i = 0; i < 5; i++) {
      col.insertOne({
        type: "write",
        index: i,
        payload: randomPayload(128),
        timestamp: now,
      }).catch(() => {});
    }

    // 5 reads (projection reduces document size)
    const readDocs = await col
      .find({ type: "write" }, { projection: { _id: 1 } })
      .limit(5)
      .toArray();

    const reads = readDocs.map((doc) =>
      doc ? doc._id.toString() : null
    );

    res.json({
      status: "success",
      reads,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

/* ===========================
   Stats Endpoint
=========================== */
app.get("/api/stats", async (_req, res) => {
  if (!db) {
    return res
      .status(503)
      .json({ status: "error", message: "DB not connected" });
  }

  try {
    const count = await db.collection("records").countDocuments({});
    res.json({
      total_documents: count,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

/* ===========================
   Start Server
=========================== */
app.listen(APP_PORT, "0.0.0.0", () => {
  console.log(`[app] listening on port ${APP_PORT}`);
});

connectMongo().catch((err) => {
  console.error("[mongo] connection failed:", err.message);
});