#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
#  DevOps Assessment — Cluster Bootstrap (Python App)
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

CLUSTER_NAME="assessment"
REGISTRY_NAME="registry.localhost"
REGISTRY_PORT="5000"
NAMESPACE="assessment"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

command -v k3d     >/dev/null 2>&1 || die "k3d not found."
command -v kubectl >/dev/null 2>&1 || die "kubectl not found."
command -v docker  >/dev/null 2>&1 || die "docker not found."
info "All prerequisites found."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Fix MongoDB CPU limit bug permanently
sed -i '' 's/cpu: "1Gi"/cpu: "1000m"/' "${SCRIPT_DIR}/k8s/mongodb/deployment.yaml" 2>/dev/null || true

# ── Create cluster ────────────────────────────────────────────────────────────
if k3d cluster list 2>/dev/null | grep -q "^${CLUSTER_NAME}"; then
  warn "Cluster '${CLUSTER_NAME}' already exists — skipping creation."
else
  info "Creating k3d cluster '${CLUSTER_NAME}'..."
  k3d cluster create "${CLUSTER_NAME}" \
    --port "80:80@loadbalancer" \
    --port "443:443@loadbalancer" \
    --agents 2 \
    --registry-create "${REGISTRY_NAME}:${REGISTRY_PORT}"
  success "Cluster created."
fi

kubectl config use-context "k3d-${CLUSTER_NAME}"

# ── Start infrastructure immediately ─────────────────────────────────────────
info "Applying namespace + infrastructure..."
kubectl apply -f "${SCRIPT_DIR}/k8s/base/namespace.yaml"
kubectl apply -f "${SCRIPT_DIR}/k8s/mongodb/"
kubectl apply -f "${SCRIPT_DIR}/k8s/redis/"
info "MongoDB and Redis starting in background while image builds..."

# ── Build Python image ────────────────────────────────────────────────────────
info "Building Python app image..."
docker build -t "assessment/app-python:latest" "${SCRIPT_DIR}/app-python/" \
  || die "Python image build FAILED"
k3d image import "assessment/app-python:latest" --cluster "${CLUSTER_NAME}"
success "Python image imported."

# ── Wait for infrastructure ───────────────────────────────────────────────────
info "Waiting for MongoDB..."
kubectl rollout status deployment/mongo -n "${NAMESPACE}" --timeout=300s

info "Waiting for Redis..."
kubectl rollout status deployment/redis -n "${NAMESPACE}" --timeout=120s

# ── Deploy app ────────────────────────────────────────────────────────────────
kubectl apply -f "${SCRIPT_DIR}/k8s/app/"

info "Waiting for Python app..."
if ! kubectl rollout status deployment/app-python -n "${NAMESPACE}" --timeout=180s; then
  warn "app-python failed. Logs:"
  kubectl logs -n "${NAMESPACE}" deployment/app-python 2>/dev/null || echo "(no logs)"
  kubectl describe pods -n "${NAMESPACE}" -l app=app-python | tail -20
  die "Fix the error above then re-run ./setup.sh"
fi

success "All deployments ready!"

# ── Fix Traefik idle timeout ──────────────────────────────────────────────────
info "Configuring Traefik..."
kubectl patch deployment traefik -n kube-system --type=json -p='[
  {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--entryPoints.web.transport.respondingTimeouts.idleTimeout=3600s"}
]' 2>/dev/null || true
kubectl rollout status deployment/traefik -n kube-system --timeout=60s 2>/dev/null || true

# ── Restart loadbalancer ──────────────────────────────────────────────────────
docker restart k3d-assessment-serverlb
sleep 15

# ── Smoke test ────────────────────────────────────────────────────────────────
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://assessment.local/healthz 2>/dev/null || echo "000")
if [ "${HEALTH}" = "200" ]; then
  success "Smoke test passed (/healthz → 200)"
else
  warn "/healthz returned ${HEALTH} — try: docker restart k3d-assessment-serverlb && sleep 10 && curl http://assessment.local/healthz"
fi

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Assessment Environment Ready! (Python / FastAPI)${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Run tests:"
echo "    # Seed Redis (keep this running in Terminal 1):"
echo "    while true; do kubectl exec -n assessment deployment/redis -- redis-cli SET cached_reads '[\"a\",\"b\",\"c\",\"d\",\"e\"]' 2>/dev/null; sleep 30; done"
echo ""
echo "    # Terminal 2 — warmup then test:"
echo "    BASE_URL=http://assessment.local k6 run --vus 100 --duration 30s stress-test/stress-test.js"
echo "    BASE_URL=http://assessment.local k6 run --vus 100 --duration 30s stress-test/stress-test.js"
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"