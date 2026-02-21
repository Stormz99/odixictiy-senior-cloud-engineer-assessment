# DevOps Assessment: Scalable Microservices Architecture

## Executive Summary

This project implements a scalable, containerized microservices
architecture designed to handle high request throughput while
maintaining resilience, observability, and horizontal scalability.

The system was deployed locally using Kubernetes (k3d) and designed with
production-grade principles including:

-   Stateless API layer
-   Asynchronous event-driven write processing
-   Horizontal Pod Autoscaling (HPA)
-   Liveness & readiness probes
-   Indexed database queries
-   Stress-tested scaling validation

The architecture emphasizes decoupling, resilience, and scalability
patterns used in modern distributed systems.

------------------------------------------------------------------------

# Architecture Overview

## High-Level Architecture Diagram

                    +---------------------+
                    |     Client / k6     |
                    +----------+----------+
                               |
                               v
                    +---------------------+
                    |      Ingress        |
                    |     (Traefik)       |
                    +----------+----------+
                               |
                               v
                    +---------------------+
                    |    Node.js API      |
                    |  (Stateless Pods)   |
                    +----+-----------+----+
                         |           |
             Publish 5x  |           |  Indexed Reads (5x)
                         v           v
                  +------------+   +------------+
                  |  Pub/Sub   |   |   MongoDB  |
                  |  Emulator  |   |  (Indexed) |
                  +------+-----+   +------+-----+
                         |
                         v
                  +----------------+
                  |     Worker     |
                  |  (Async Write) |
                  +----------------+

### Core Components

**Node.js API Service**
- Handles HTTP requests
- Publishes 5 write events asynchronously
- Performs 5 indexed read operations
- Exposes `/healthz` and `/readyz` endpoints

**MongoDB**
- Stores processed records 
- Indexed on `{ type: 1 }` for optimized read performance

**Pub/Sub Emulator** - Provides event-driven decoupling 
- Enables asynchronous write processing

**Worker Service** - Subscribes to Pub/Sub 
- Inserts records into MongoDB

**Kubernetes (k3d)** - Orchestrates workloads 
- Provides horizontal scaling via HPA

------------------------------------------------------------------------

# Sequence Diagram (Request Lifecycle)

    Client
      |
      |  HTTP GET /api/data
      v
    API Pod
      |
      |-- Publish Event 1 --> PubSub
      |-- Publish Event 2 --> PubSub
      |-- Publish Event 3 --> PubSub
      |-- Publish Event 4 --> PubSub
      |-- Publish Event 5 --> PubSub
      |
      |-- Query Mongo (indexed read x5)
      |
      v
    Return JSON Response

    PubSub --> Worker --> MongoDB (actual write)

### Key Characteristics

-   Write path is asynchronous (eventual consistency).
-   Read path is optimized via index.
-   API does not block on database writes.
-   Worker tier scales independently.

------------------------------------------------------------------------

# Architectural Decisions

## 1. Stateless API Layer

The API does not persist state locally. This allows:

-   Horizontal scaling
-   Rescheduling across nodes
-   Zero-downtime rolling updates

Tradeoff: Requires external persistence and queue systems.

------------------------------------------------------------------------

## 2. Asynchronous Write Decoupling

Write operations are published to Pub/Sub rather than written directly
to MongoDB.

Benefits: 
- Reduces request latency 
- Prevents DB write bottlenecks
- Improves resilience under load

Tradeoff: 
- Eventual consistency (reads may not reflect writes immediately)

------------------------------------------------------------------------

## 3. Indexed MongoDB Reads

MongoDB collection indexed on:

    { type: 1 }

This ensures read operations remain performant during stress testing.

------------------------------------------------------------------------

## 4. Horizontal Pod Autoscaling (HPA)

Configured with:

-   CPU threshold: 60%
-   Memory threshold: 70%
-   Min replicas: 2
-   Max replicas: 20

Observed behavior under stress: 2 → 4 → 8 → 11 replicas

Demonstrates dynamic scaling based on CPU pressure.

------------------------------------------------------------------------

# Stress Testing Summary

Tool: k6\
Configuration: 300 VUs, 30 seconds

Observed:

-   \~174 requests/second
-   0 HTTP failures
-   p95 latency ≈ 3.9s
-   HPA scaled to 11 pods

System remained available and responsive under load.

------------------------------------------------------------------------

# Failure Mode Analysis

## 1. MongoDB Failure

Impact: 
- Readiness probe fails
 - API returns 503 - Pods remain alive but marked Not Ready

Mitigation:
- Readiness probe prevents traffic routing
 - ReplicaSet ensures restart capability
- Production: use Mongo replica set or managed service

------------------------------------------------------------------------

## 2. Pub/Sub Failure

Impact: 
- Publish attempts fail
- Writes dropped or retried

Mitigation: 
- Retry logic
 - Dead-letter queues (production design)
- Managed Pub/Sub or Kafka for durability

------------------------------------------------------------------------

## 3. Pod CPU Saturation

Impact: 
- Increased latency
- HPA triggers scale-up

Mitigation: 
- Lower CPU thresholds
- Increase resource limits
- Node autoscaling (production)

------------------------------------------------------------------------

## 4. Node Failure

Impact: 
- Pods rescheduled on healthy nodes

Mitigation: 
- Stateless API design
 - Kubernetes self-healing behavior

------------------------------------------------------------------------

# SLO / SLA Definition

## Service Level Objectives (SLO)

  Metric                      Target
  --------------------------- -------------------------
  Availability                99.9%
  p95 Latency                 \< 2s under normal load
  Error Rate                  \< 1%
  Autoscaling Reaction Time   \< 60s

------------------------------------------------------------------------

## SLA (Production Scenario)

If deployed in production with managed infrastructure:

-   99.9% uptime per month
-   Recovery time objective (RTO): \< 5 minutes
-   Recovery point objective (RPO): Near-zero with durable queue

------------------------------------------------------------------------

# Scalability Strategy (Production-Grade)

To approach extreme scale (hundreds of thousands or millions RPS):

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
<img width="499" height="350" alt="image" src="https://github.com/user-attachments/assets/c9d61e7d-fe63-45f1-9eba-325c6fe678cb" />

Run stress test:
    k6 run --vus 300 --duration 30s stress-test/stress-test.js
   

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

The system scales under load, maintains availability, and reflects
senior-level DevOps design considerations.
