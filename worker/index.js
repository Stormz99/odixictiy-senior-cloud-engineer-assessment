"use strict";

const { PubSub } = require("@google-cloud/pubsub");
const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI || "mongodb://mongo:27017/assessmentdb";
const PUBSUB_HOST = process.env.PUBSUB_EMULATOR_HOST;

const pubsub = new PubSub({
  apiEndpoint: PUBSUB_HOST,
  projectId: "assessment-project",
});

const subscription = pubsub.subscription("mongo-writes-sub");

const mongoClient = new MongoClient(MONGO_URI);
let db;

async function start() {
  await mongoClient.connect();
  db = mongoClient.db("assessmentdb");
  const col = db.collection("records");

  console.log("[worker] connected to Mongo");
  console.log("[worker] listening for messages...");

  subscription.on("message", async (message) => {
    try {
      const payload = JSON.parse(message.data.toString());

      await col.insertOne(payload);

      message.ack();
    } catch (err) {
      console.error("[worker] error processing message:", err.message);
      message.nack();
    }
  });

  subscription.on("error", (err) => {
    console.error("[worker] subscription error:", err.message);
  });
}

start().catch((err) => {
  console.error("[worker] failed to start:", err.message);
  process.exit(1);
});
