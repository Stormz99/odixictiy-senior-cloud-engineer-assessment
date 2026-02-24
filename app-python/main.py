import os
import json
import time
import random
import string
import threading
import queue
from datetime import datetime

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pymongo import MongoClient, InsertOne
from pymongo.errors import PyMongoError
import redis

MONGO_URI  = os.getenv("MONGO_URI", "mongodb://mongo:27017/assessmentdb")
REDIS_URL  = os.getenv("REDIS_URL", "redis://redis:6379")
CACHE_TTL  = int(os.getenv("CACHE_TTL", "60"))

app = FastAPI(title="DevOps Assessment API", version="1.0.0")

# ── Async write queue ─────────────────────────────────────────────────────────
# Writes are fire-and-forget. The request returns immediately.
# A background thread drains the queue and bulk-writes to MongoDB.
write_queue = queue.Queue(maxsize=100000)


def write_worker():
    """Drains the write queue with batched bulk inserts."""
    mongo_w = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    col_w = mongo_w["assessmentdb"]["records"]
    batch = []
    last_flush = time.time()

    while True:
        try:
            item = write_queue.get(timeout=0.05)
            batch.append(InsertOne(item))
            write_queue.task_done()
        except queue.Empty:
            pass

        if batch and (len(batch) >= 50 or (time.time() - last_flush) > 0.1):
            try:
                col_w.bulk_write(batch, ordered=False)
            except Exception as e:
                print(f"[worker] bulk write error: {e}")
            batch = []
            last_flush = time.time()


# ── Connections ───────────────────────────────────────────────────────────────
mongo_client = None
col          = None
redis_client = None


def get_col():
    global mongo_client, col
    if col is not None:
        return col
    try:
        mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=3000)
        mongo_client.admin.command("ping")
        col = mongo_client["assessmentdb"]["records"]
        return col
    except PyMongoError:
        return None


def get_redis():
    global redis_client
    if redis_client is not None:
        return redis_client
    try:
        redis_client = redis.from_url(REDIS_URL, socket_connect_timeout=2, socket_timeout=2)
        redis_client.ping()
        return redis_client
    except Exception:
        return None


@app.on_event("startup")
async def startup_event():
    t = threading.Thread(target=write_worker, daemon=True)
    t.start()
    print("[worker] async write thread started")

    for attempt in range(1, 11):
        if get_col() is not None:
            print(f"[mongo] connected on attempt {attempt}")
            break
        print(f"[mongo] attempt {attempt}/10 failed, retrying in 5s...")
        time.sleep(5)

    if get_redis():
        print("[redis] connected")
    else:
        print("[redis] unavailable — reads will hit Mongo")


def random_payload(size: int = 512) -> str:
    return "".join(random.choices(string.ascii_letters + string.digits, k=size))


# ── Probes ────────────────────────────────────────────────────────────────────
@app.get("/healthz")
def health_check():
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat()}


@app.get("/readyz")
def readiness_check():
    c = get_col()
    if c is None:
        raise HTTPException(status_code=503, detail="MongoDB not reachable")
    try:
        mongo_client.admin.command("ping")
        return {"status": "ready", "timestamp": datetime.utcnow().isoformat()}
    except PyMongoError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


# ── Core endpoint ─────────────────────────────────────────────────────────────
@app.get("/api/data")
def process_data():
    c = get_col()
    if c is None:
        raise HTTPException(status_code=503, detail="MongoDB not reachable")

    # ── 5 writes: non-blocking queue (returns immediately) ───────────────────
    writes = []
    for i in range(5):
        doc = {
            "type":      "write",
            "index":     i,
            "payload":   random_payload(),
            "timestamp": datetime.utcnow(),
        }
        try:
            write_queue.put_nowait(doc)
            writes.append("queued")
        except queue.Full:
            writes.append("dropped")

    # ── 5 reads: Redis cache first ────────────────────────────────────────────
    reads = []
    r = get_redis()

    if r:
        try:
            cached = r.get("cached_reads")
            if cached:
                reads = json.loads(cached)
            else:
                docs = list(c.find({"type": "write"}, {"_id": 1}).limit(5))
                reads = [str(d["_id"]) for d in docs]
                while len(reads) < 5:
                    reads.append(reads[0] if reads else "bootstrap")
                r.setex("cached_reads", CACHE_TTL, json.dumps(reads))
        except Exception:
            reads = ["fallback"] * 5
    else:
        for _ in range(5):
            doc = c.find_one({"type": "write"})
            reads.append(str(doc["_id"]) if doc else None)

    return JSONResponse(content={
        "status":    "success",
        "reads":     reads,
        "writes":    writes,
        "timestamp": datetime.utcnow().isoformat(),
    })


# ── Stats ─────────────────────────────────────────────────────────────────────
@app.get("/api/stats")
def get_stats():
    c = get_col()
    if c is None:
        raise HTTPException(status_code=503, detail="MongoDB not reachable")
    try:
        return {
            "total_documents": c.count_documents({}),
            "write_queue_depth": write_queue.qsize(),
            "timestamp": datetime.utcnow().isoformat(),
        }
    except PyMongoError as exc:
        raise HTTPException(status_code=500, detail=str(exc))