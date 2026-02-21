"use strict";

const { PubSub } = require("@google-cloud/pubsub");
const { MongoClient } = require("mongodb");

const MONGO_URI =
  process.env.MONGO_URI || "mongodb://mongo:27017/assessmentdb";

const pubsub = new PubSub({
  apiEndpoint: process.env.PUBSUB_EMULATOR_HOST,
  projectId: "assessment-project",
});

const topicName = "mongo-writes";
const subscriptionName = "mongo-writes-sub";

let db;

async function init() {
  // Connect Mongo
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db("assessmentdb");
  console.log("[worker] connected to Mongo");

  // Ensure topic exists
  const [topics] = await pubsub.getTopics();
  const topicExists = topics.some(t => t.name.endsWith(topicName));

  if (!topicExists) {
    await pubsub.createTopic(topicName);
    console.log("[worker] topic created");
  }

  const topic = pubsub.topic(topicName);

  // Ensure subscription exists
  const [subs] = await topic.getSubscriptions();
  const subExists = subs.some(s => s.name.endsWith(subscriptionName));

  if (!subExists) {
    await topic.createSubscription(subscriptionName);
    console.log("[worker] subscription created");
  }

  const subscription = pubsub.subscription(subscriptionName);

  subscription.on("message", async (message) => {
    try {
      const data = JSON.parse(message.data.toString());
      await db.collection("records").insertOne(data);
      message.ack();
    } catch (err) {
      console.error("[worker] processing error:", err.message);
      message.nack();
    }
  });

  console.log("[worker] listening for messages...");
}

init().catch(err => {
  console.error("[worker] startup error:", err);
});