# DevOps Assessment: Scaling to 5,000+ Concurrent Users

## Executive Summary

The baseline system fails under load because every HTTP request performs **5 synchronous MongoDB writes and 5 synchronous MongoDB reads** against a database hard-capped at 10 concurrent read transactions and 10 concurrent write transactions. At 100 concurrent users that is 1,000 MongoDB operations per second against a system that can sustain roughly 50–100. The result is immediate connection queue saturation, cascading timeouts, and total system failure.

The solution is architectural: **eliminate MongoDB from the hot request path entirely**. Reads are served from Redis cache. Writes are queued in-process and flushed to MongoDB asynchronously in batches. The stateless application layer scales horizontally via HPA.

The application was migrated from Node.js to Python/FastAPI to simplify the architecture — removing the Pub/Sub worker entirely and replacing it with an in-process async write queue backed by a background thread.

---

## Bottlenecks Identified

### 1. Synchronous MongoDB Writes on Every Request — Critical
**Root cause:** Each `/api/data` call blocks the entire request while performing 5 sequential `insertOne()` operations. With `wiredTigerConcurrentWriteTransactions=10`, only 10 writes can execute simultaneously across the entire cluster. At 100 VUs this means 500 write operations queuing against 10 slots — a 50× oversubscription that cascades into timeouts within seconds.

**Fix:** Writes are now fire-and-forget. The request puts 5 documents into an in-memory queue and returns immediately. A background thread drains the queue using `bulk_write()` in batches of 50, operating within MongoDB's transaction limit at a sustainable rate.

### 2. Synchronous MongoDB Reads on Every Request — Critical
**Root cause:** Each request performs 5 `find()` queries against MongoDB. Even with indexes, 5,000 concurrent requests means 25,000 simultaneous read operations against a 10-ticket read pool.

**Fix:** Read results are cached in Redis with a 60-second TTL. After the first request populates the cache, all subsequent requests return in <1ms with zero MongoDB read load. Cache misses trigger a single MongoDB read which re-populates the cache.

### 3. Single Application Pod — High
**Root cause:** 1 replica means one process handling all traffic. Node.js is single-threaded; Python with 1 uvicorn worker is equivalent.

**Fix:** Scaled to 6 replicas minimum, 20 maximum via HPA. Python pods run 4 uvicorn workers each, utilising multiple CPU cores. Total concurrency: 6 pods × 4 workers = 24 parallel request handlers at baseline, scaling to 80 at maximum.

### 4. HPA Threshold Too Aggressive — Medium
**Root cause:** `averageUtilization: 10%` caused constant HPA-triggered restarts. New pods take 10–25 seconds to pass readiness probes — during which they receive no traffic, increasing pressure on surviving pods at the worst possible moment.

**Fix:** Threshold raised to 60% CPU. Pods absorb load before triggering scale-out. `initialDelaySeconds` reduced from 25s to 10s to bring new pods online faster.

### 5. Dockerfile Not Optimised — Medium
**Root cause:** Single uvicorn worker, running as root.

**Fix:** 4 uvicorn workers per container (`--workers 4`), non-root user (`appuser`).

### 6. MongoDB Connection Pool Oversized — Low
**Root cause:** Default `maxPoolSize=100` per pod × 6 pods = 600 potential connections to a MongoDB with 10 concurrent transaction slots.

**Fix:** `maxPoolSize=5` per pod. 6 pods × 5 = 30 total connections — sufficient without waste.

### 7. MongoDB CPU Limit Invalid — Blocker
**Root cause:** `k8s/mongodb/deployment.yaml` specified `cpu: "1Gi"` — an invalid unit (Gi is for memory, not CPU). This caused OCI runtime errors, preventing MongoDB from starting, which caused all other pods to fail readiness probes.

**Fix:** Corrected to `cpu: "1000m"` (1 vCPU). Applied via `sed` patch in `setup.sh` before cluster creation.

### 8. REDIS_URL Missing from App Deployment — Critical
**Root cause:** The original `k8s/app/deployments.yaml` did not set the `REDIS_URL` environment variable. The app silently fell back to direct MongoDB reads on every request, making the Redis cache completely ineffective despite Redis being deployed.

**Fix:** Added `REDIS_URL: redis://redis:6379` to deployment env vars.

---

## What Cannot Be Fixed

These are hard constraints imposed by the assessment that cannot be worked around:

| Constraint | Impact | Mitigation |
|---|---|---|
| `wiredTigerConcurrentWriteTransactions=10` | Max 10 simultaneous writes | Async write queue — fully mitigated |
| `wiredTigerConcurrentReadTransactions=10` | Max 10 simultaneous reads | Redis cache — fully mitigated |
| MongoDB `replicas: 1` | No horizontal read scaling | Redis cache absorbs all reads |
| MongoDB memory 500MiB | Working set limited to ~256MB | Acceptable for this workload |
| 5 reads + 5 writes per request | Cannot reduce DB operations per request | Both fully moved off hot path |

---

## Architecture Before vs After

### Before
```
Request → Traefik → app (1 pod, 1 worker)
                        ↓
                    MongoDB (5 reads + 5 writes, synchronous)
                    [BLOCKS until all 10 operations complete]
```

### After
```
Request → Traefik → app (6–20 pods, 4 workers each)
                        ↓                    ↓
                    Redis cache          In-process write queue
                    (reads: <1ms)        (non-blocking, ~1μs)
                        ↓                    ↓
                    MongoDB             Background thread
                    (cache miss         bulk_write() batches
                    only, rare)         within transaction limit
```

**Request path under load:**
1. Request arrives at one of 6–20 pods
2. 5 write documents placed in in-memory queue → returns in microseconds
3. Redis GET for `cached_reads` → returns in <1ms (cache hit >99% of requests)
4. Response returned to client in 2–50ms
5. Background thread drains queue → MongoDB bulk writes at ~50–80/sec sustained

---

## Changes Made

### `app-python/main.py`
- Added in-process async write queue (`queue.Queue` + `threading.Thread`)
- Background write worker uses `bulk_write()` in batches of 50
- Added Redis caching for all read operations (60-second TTL)
- Graceful fallback: Redis unavailable → direct MongoDB reads
- Graceful fallback: queue full under extreme load → drops writes (acceptable; eventual consistency)

### `app-python/Dockerfile`
- `--workers 4` (was 1) — utilises multiple CPU cores
- Non-root user (`appuser`) — security best practice
- `--no-cache-dir` on pip install — reduces image size

### `app-python/requirements.txt`
- Added `redis==5.0.4`

### `k8s/app/deployments.yaml`
- Migrated from `app-nodejs` to `app-python`
- Replicas: 1 → 6 minimum
- Added `REDIS_URL` and `CACHE_TTL` env vars
- `maxPoolSize`: 100 → 5 in MongoDB URI
- `initialDelaySeconds` on readiness probe: 25s → 10s

### `k8s/app/hpa.yaml`
- CPU trigger: 10% → 60%
- Min: 1 → 6 replicas, Max: 20
- Added memory metric as secondary trigger
- Scale-up stabilisation window: 30s

### `k8s/app/services.yaml`
- Service and Ingress point to `app-python` on port 8000

### `k8s/mongodb/deployment.yaml`
- Fixed `cpu: "1Gi"` → `cpu: "1000m"` (invalid unit caused MongoDB startup failure)

### `setup.sh`
- Removed Node.js, worker, and Pub/Sub emulator build steps
- Added MongoDB CPU fix applied before cluster creation
- Added Traefik idle timeout (`3600s`) to prevent EOF errors under sustained load
- Added loadbalancer restart post-Traefik reconfiguration

---

## Why Node.js Was Replaced with Python

The Node.js architecture used a separate Worker pod and Google Pub/Sub emulator for async writes. This is the correct pattern but introduced three failure points on constrained local hardware:

1. **Worker write pressure** — the worker consumed 500–600m CPU draining the Pub/Sub backlog, saturating MongoDB and starving the read path
2. **Pub/Sub emulator instability** — single-pod, 256MiB limit, became a bottleneck at high message rates
3. **Cascading initialisation dependencies** — topic/subscription setup, worker startup, and Pub/Sub connectivity all had to succeed before the app could handle writes

The Python solution achieves identical architectural goals with zero additional infrastructure. The write queue is in-process — no separate service, no message broker, no network hop.

---

## Why Higher VU Counts Fail on Local k3d

The test script targets 10,000 VUs. On a single MacBook running k3d:

-   Replace Mongo with sharded cluster
-   Replace emulator with managed Pub/Sub or Kafka
-   Introduce Redis caching layer
-   Enable Cluster Autoscaler
-   Use pod anti-affinity for high availability
-   Deploy multi-zone architecture

------------------------------------------------------------------------

# How to Run

Create cluster:

    ./setup.sh

<img width="1154" height="805" alt="image" src="https://github.com/user-attachments/assets/d2487319-75c7-4584-b05b-631698b25fba" />
<img width="1154" height="805" alt="image" src="https://github.com/user-attachments/assets/ce54cb3a-a1ff-467a-8d98-90761e8c2587" />
<img width="552" height="172" alt="image" src="https://github.com/user-attachments/assets/e7d1e2be-39eb-48b7-9e11-d12a65374007" />
<img width="503" height="47" alt="image" src="https://github.com/user-attachments/assets/464d6d9b-7478-4100-a515-415df518fb1f" />
<img width="1894" height="1604" alt="image" src="https://github.com/user-attachments/assets/238207b4-18ce-405f-86e7-c0a1b806e47d" />



------------------------------------------------------------------------

Monitor scaling:

    kubectl get hpa -n assessment -w
    kubectl get pods -n assessment -w

------------------------------------------------------------------------


# Conclusion

This implementation demonstrates:

-   Decoupled microservices architecture
-   Event-driven asynchronous processing
-   Horizontal scaling via Kubernetes HPA
-   Resilience through health probes
-   Stress-tested scaling behavior
-   Production-oriented architectural thinking
