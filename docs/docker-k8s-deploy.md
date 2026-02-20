# Docker Build & Kubernetes Deployment Guide

## Overview

The production image bundles both the Go UI server and the compiled Vite frontend into a single Alpine container. All runtime configuration is injected via environment variables — no config files need to be baked into the image.

```
[Your Mac]                         [Linux K8s Node]
pnpm build:server  ──┐
                     ├──▶  docker build  ──▶  registry  ──▶  kubectl apply
server/Dockerfile  ──┘
```

---

## Prerequisites

| Tool                           | Version | Check                                |
| ------------------------------ | ------- | ------------------------------------ |
| Node.js                        | ≥ 22.14 | `node -v`                            |
| pnpm                           | ≥ 10.10 | `pnpm -v`                            |
| Docker                         | any     | `docker -v`                          |
| kubectl                        | any     | `kubectl version`                    |
| Access to a container registry | —       | e.g. Docker Hub, ECR, local registry |

---

## Step 1 — Build the Frontend Assets

The Go binary embeds the compiled Vite output at build time. Run this from the **project root** (`ui/`):

```bash
pnpm install          # skip if already done
pnpm build:server     # outputs to server/ui/assets/local/
```

Verify the output exists:

```bash
ls server/ui/assets/local/
# Expected: index.html  _app/  i18n/  favicon.png  ...
```

---

## Step 2 — Build the Docker Image

The `Dockerfile` is in `server/` and the build context is the `server/` directory.

```bash
# From the project root (ui/)
docker build \
  -t temporal-ui:latest \
  -f server/Dockerfile \
  server/
```

### Tag for your registry

```bash
# Replace <registry> with your registry host, e.g.:
#   docker.io/myorg
#   10.167.248.10:5000   (local registry in your cluster)

export REGISTRY=<registry>
export IMAGE_TAG=1.0.0

docker build \
  -t ${REGISTRY}/temporal-ui:${IMAGE_TAG} \
  -f server/Dockerfile \
  server/
```

### Build for Linux/amd64 from Apple Silicon (M-series Mac)

If your K8s nodes are `linux/amd64` and you are building on an M1/M2/M3 Mac:

```bash
docker buildx build \
  --platform linux/amd64 \
  -t ${REGISTRY}/temporal-ui:${IMAGE_TAG} \
  -f server/Dockerfile \
  server/ \
  --push      # pushes directly to registry; remove to only build locally
```

---

## Step 3 — Push to Registry

```bash
docker login ${REGISTRY}   # skip if already authenticated

docker push ${REGISTRY}/temporal-ui:${IMAGE_TAG}
```

---

## Step 4 — Create Kubernetes Manifests

### 4.1 Secret (Keycloak client secret)

Store the client secret as a K8s Secret so it is not visible in plain YAML:

```bash
kubectl create secret generic temporal-ui-auth \
  --from-literal=client-secret=fde15a41-9d3e-45c0-9043-250f2fd30bc1 \
  --namespace=<your-namespace>
```

### 4.2 Deployment

Create `k8s/temporal-ui-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: temporal-ui
  namespace: <your-namespace>
  labels:
    app: temporal-ui
spec:
  replicas: 1
  selector:
    matchLabels:
      app: temporal-ui
  template:
    metadata:
      labels:
        app: temporal-ui
    spec:
      containers:
        - name: temporal-ui
          image: <registry>/temporal-ui:1.0.0
          imagePullPolicy: Always
          ports:
            - containerPort: 8080
          env:
            # Temporal gRPC address
            - name: TEMPORAL_ADDRESS
              value: '10.167.248.24:30533'

            # UI settings
            - name: TEMPORAL_UI_PORT
              value: '8080'
            - name: TEMPORAL_UI_ENABLED
              value: 'true'
            - name: TEMPORAL_DEFAULT_NAMESPACE
              value: 'default'

            # Auth — Keycloak
            - name: TEMPORAL_AUTH_ENABLED
              value: 'true'
            - name: TEMPORAL_AUTH_LABEL
              value: 'Keycloak'
            - name: TEMPORAL_AUTH_TYPE
              value: 'oidc'
            - name: TEMPORAL_AUTH_PROVIDER_URL
              value: 'http://10.167.240.227:8091/auth/realms/temporal-ui'
            - name: TEMPORAL_AUTH_CLIENT_ID
              value: 'temporal-ui'
            - name: TEMPORAL_AUTH_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: temporal-ui-auth
                  key: client-secret
            # Set this to the public URL where this UI will be accessible
            - name: TEMPORAL_AUTH_CALLBACK_URL
              value: 'http://<k8s-node-ip>:<nodeport>/auth/sso/callback'
            - name: TEMPORAL_AUTH_SCOPES
              value: 'openid,profile,email,offline_access'

            # CORS
            - name: TEMPORAL_CORS_UNSAFE_ALLOW_ALL_ORIGINS
              value: 'true'
            - name: TEMPORAL_CSRF_COOKIE_INSECURE
              value: 'true' # set to "false" if serving over HTTPS

          readinessProbe:
            httpGet:
              path: /api/v1/settings
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /api/v1/settings
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 30
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
```

### 4.3 Service (NodePort)

Create `k8s/temporal-ui-service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: temporal-ui
  namespace: <your-namespace>
spec:
  type: NodePort
  selector:
    app: temporal-ui
  ports:
    - name: http
      port: 8080
      targetPort: 8080
      nodePort: 30080 # change to any free port in 30000–32767
```

After applying, the UI is accessible at `http://<k8s-node-ip>:30080`.

Update `TEMPORAL_AUTH_CALLBACK_URL` accordingly:

```
http://<k8s-node-ip>:30080/auth/sso/callback
```

> **Keycloak redirect URI** — make sure this callback URL is added to your Keycloak client's
> **Valid Redirect URIs** list under:
> `Clients → temporal-ui → Settings → Valid Redirect URIs`

---

## Step 5 — Deploy

```bash
kubectl apply -f k8s/temporal-ui-deployment.yaml
kubectl apply -f k8s/temporal-ui-service.yaml
```

Watch rollout:

```bash
kubectl rollout status deployment/temporal-ui -n <your-namespace>
```

Check logs:

```bash
kubectl logs -f deployment/temporal-ui -n <your-namespace>
```

---

## Step 6 — Verify

```bash
# Replace with your actual node IP and nodePort
curl http://<k8s-node-ip>:30080/api/v1/settings
```

Expected response includes `"Auth":{"Enabled":true,...}`.

Open `http://<k8s-node-ip>:30080` in a browser — you should be redirected to Keycloak.

---

## Environment Variable Reference

All configuration for the Docker image is via env vars (processed by the `docker.yaml` template at startup):

| Env Var                                  | Description                              | Example                                  |
| ---------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| `TEMPORAL_ADDRESS`                       | Temporal gRPC endpoint                   | `10.167.248.24:30533`                    |
| `TEMPORAL_UI_PORT`                       | Port the server listens on               | `8080`                                   |
| `TEMPORAL_UI_ENABLED`                    | Serve embedded UI                        | `true`                                   |
| `TEMPORAL_DEFAULT_NAMESPACE`             | Default namespace in picker              | `default`                                |
| `TEMPORAL_AUTH_ENABLED`                  | Enable OIDC auth                         | `true`                                   |
| `TEMPORAL_AUTH_PROVIDER_URL`             | Keycloak realm URL                       | `http://host:port/auth/realms/<realm>`   |
| `TEMPORAL_AUTH_CLIENT_ID`                | Keycloak client ID                       | `temporal-ui`                            |
| `TEMPORAL_AUTH_CLIENT_SECRET`            | Keycloak client secret                   | from K8s Secret                          |
| `TEMPORAL_AUTH_CALLBACK_URL`             | OAuth callback URL (must match Keycloak) | `http://<host>:<port>/auth/sso/callback` |
| `TEMPORAL_AUTH_SCOPES`                   | Comma-separated OIDC scopes              | `openid,profile,email,offline_access`    |
| `TEMPORAL_CORS_UNSAFE_ALLOW_ALL_ORIGINS` | Mirror any Origin in CORS headers        | `true`                                   |
| `TEMPORAL_CSRF_COOKIE_INSECURE`          | Allow cookies over HTTP                  | `true`                                   |
| `TEMPORAL_DISABLE_WRITE_ACTIONS`         | Globally disable all write buttons       | `false`                                  |

---

## Quick Reference — Full Build & Deploy Sequence

```bash
# 1. Build frontend
pnpm build:server

# 2. Build & push image
docker buildx build \
  --platform linux/amd64 \
  -t <registry>/temporal-ui:1.0.0 \
  -f server/Dockerfile \
  server/ \
  --push

# 3. Create secret (first time only)
kubectl create secret generic temporal-ui-auth \
  --from-literal=client-secret=fde15a41-9d3e-45c0-9043-250f2fd30bc1 \
  -n <namespace>

# 4. Deploy
kubectl apply -f k8s/temporal-ui-deployment.yaml
kubectl apply -f k8s/temporal-ui-service.yaml

# 5. Watch
kubectl rollout status deployment/temporal-ui -n <namespace>
```

---

## Troubleshooting

| Symptom                                                       | Cause                             | Fix                                                                                           |
| ------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| `pattern all:assets: no matching files found` at docker build | `pnpm build:server` not run first | Run `pnpm build:server` before `docker build`                                                 |
| `{"message":"Not Found"}` at root                             | Old `enableUi: false` config      | Env var `TEMPORAL_UI_ENABLED=true` must be set                                                |
| CORS error in browser                                         | Origin not allowed                | Set `TEMPORAL_CORS_UNSAFE_ALLOW_ALL_ORIGINS=true`                                             |
| `returnUrl host not in allowed origins`                       | Callback host not in CORS list    | `TEMPORAL_CORS_ORIGINS=http://<host>:<port>`                                                  |
| Keycloak redirect fails                                       | Callback URL mismatch             | Add exact callback URL to Keycloak **Valid Redirect URIs**                                    |
| Pod stuck in `CrashLoopBackOff`                               | Auth env vars missing             | Ensure `TEMPORAL_AUTH_PROVIDER_URL`, `CLIENT_ID`, `CLIENT_SECRET`, `CALLBACK_URL` are all set |
