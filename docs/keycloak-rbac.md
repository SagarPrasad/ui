# Keycloak RBAC for Temporal UI — Design & Implementation Guide

## Overview

This document describes how to configure Keycloak to enforce **namespace-scoped, action-level permissions** for Temporal UI users, and the corresponding UI code changes required.

**Goals:**

- A user sees only the namespaces they have access to in the namespace picker
- Write action buttons (Terminate, Reset, Signal, Cancel, Update, Schedule) are disabled based on per-namespace permission grants
- Permissions are carried in the Keycloak-issued JWT access token; no additional API call is needed at runtime

---

## 1. Permission Model

### 1.1 Permission Taxonomy

Permissions are scoped per namespace and follow a dot-notation hierarchy:

| Permission                   | What it controls                                                  |
| ---------------------------- | ----------------------------------------------------------------- |
| `workflow.read`              | View workflows, event history, task queues, stack traces, queries |
| `workflow.write`             | Start new workflow executions                                     |
| `workflow.actions.terminate` | Terminate running workflows                                       |
| `workflow.actions.reset`     | Reset workflows to a prior event                                  |
| `workflow.actions.signal`    | Send signals to workflows                                         |
| `workflow.actions.cancel`    | Request cancellation of workflows                                 |
| `workflow.actions.update`    | Send synchronous updates to workflows                             |
| `workflow.actions.schedule`  | Create / modify / delete schedules                                |
| `workflow.actions.batch`     | Run batch terminate / cancel / reset / signal operations          |
| `workflow.activities`        | Issue activity commands (complete, fail, reset timer)             |

### 1.2 Keycloak Role Naming Convention

Roles are created as **client roles** on the Temporal UI client using the pattern:

```
temporal.<namespace>.<permission>
```

**Examples for namespace `default`:**

```
temporal.default.workflow.read
temporal.default.workflow.write
temporal.default.workflow.actions.terminate
temporal.default.workflow.actions.reset
temporal.default.workflow.actions.signal
temporal.default.workflow.actions.cancel
temporal.default.workflow.actions.update
temporal.default.workflow.actions.schedule
temporal.default.workflow.actions.batch
temporal.default.workflow.activities
```

Repeat the same set for every namespace (e.g. `temporal.payments.workflow.read`, etc.).

### 1.3 Example User Profiles

| User              | Namespaces visible    | Actions allowed           |
| ----------------- | --------------------- | ------------------------- |
| Read-only analyst | `default`, `payments` | View only                 |
| Dev engineer      | `default`             | All actions               |
| Ops on-call       | `default`, `payments` | Terminate, Signal, Cancel |
| Schedule admin    | `payments`            | Schedule only             |

---

## 2. Keycloak Configuration (Step-by-Step)

### 2.1 Create the Client

1. Open **Keycloak Admin Console → Clients → Create client**
2. **Client type**: OpenID Connect
3. **Client ID**: `temporal-ui`
4. **Client authentication**: ON (confidential client; the backend proxy holds the secret)
5. **Authentication flow**: Standard flow + Refresh tokens
6. **Valid redirect URIs**: `https://<your-temporal-ui-host>/*`
7. **Web origins**: `https://<your-temporal-ui-host>`
8. Save.

### 2.2 Create Client Roles

For each namespace, create all 10 roles listed in §1.2.

**Via Admin Console:**

1. Navigate to **Clients → temporal-ui → Roles → Create role**
2. Enter role name, e.g. `temporal.default.workflow.read`
3. Optionally add a description: "Read access to workflows in namespace: default"
4. Save. Repeat for all permissions and namespaces.

**Via Keycloak REST API (bulk creation script):**

```bash
KEYCLOAK_URL="https://keycloak.example.com"
REALM="temporal"
CLIENT_ID="<temporal-ui-client-uuid>"   # Get from Admin API
TOKEN="<admin-access-token>"

NAMESPACES=("default" "payments" "billing")
PERMISSIONS=(
  "workflow.read"
  "workflow.write"
  "workflow.actions.terminate"
  "workflow.actions.reset"
  "workflow.actions.signal"
  "workflow.actions.cancel"
  "workflow.actions.update"
  "workflow.actions.schedule"
  "workflow.actions.batch"
  "workflow.activities"
)

for ns in "${NAMESPACES[@]}"; do
  for perm in "${PERMISSIONS[@]}"; do
    ROLE_NAME="temporal.${ns}.${perm}"
    curl -s -X POST \
      "${KEYCLOAK_URL}/admin/realms/${REALM}/clients/${CLIENT_ID}/roles" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"name\": \"${ROLE_NAME}\", \"description\": \"${perm} on namespace ${ns}\"}"
    echo "Created: ${ROLE_NAME}"
  done
done
```

### 2.3 Create Composite Roles (Optional Convenience)

Define composite roles to bundle common permission sets:

| Composite Role            | Includes                                   |
| ------------------------- | ------------------------------------------ |
| `temporal.<ns>.viewer`    | `workflow.read`                            |
| `temporal.<ns>.operator`  | `workflow.read` + all `workflow.actions.*` |
| `temporal.<ns>.developer` | All 10 permissions                         |

Creating a composite role:

1. **Clients → temporal-ui → Roles → Create role** → name `temporal.default.operator`
2. After saving, click **Action → Add associated roles**
3. Filter by `temporal.default.` and select the desired individual roles.

### 2.4 Create a User and Assign Roles

1. **Users → Add user**
2. Fill **Username**, **Email**, **First/Last name**
3. **Credentials tab** → Set password
4. **Role mapping tab → Assign role**
5. Filter by `temporal-ui` client roles
6. Select the specific `temporal.<namespace>.<permission>` roles (or composite roles) for this user
7. Click **Assign**

### 2.5 Configure the Token Mapper

The client roles must appear inside the JWT so the UI can read them.

Keycloak includes client roles in the `resource_access` claim by default. Verify:

1. **Clients → temporal-ui → Client scopes → temporal-ui-dedicated**
2. Look for a mapper named **"client roles"** (type: `User Client Role`)
3. If missing, click **Add mapper → By configuration → User Client Role**
   - **Name**: `temporal-client-roles`
   - **Client ID**: `temporal-ui`
   - **Token Claim Name**: `resource_access.temporal-ui.roles`
   - **Claim JSON type**: `String`
   - **Add to access token**: ON
   - **Add to ID token**: OFF (not needed)
   - **Multivalued**: ON

The resulting JWT access token payload will contain:

```json
{
  "resource_access": {
    "temporal-ui": {
      "roles": [
        "temporal.default.workflow.read",
        "temporal.default.workflow.actions.signal",
        "temporal.payments.workflow.read"
      ]
    }
  }
}
```

---

## 3. UI Code Changes

### 3.1 Architecture Overview

```
JWT access token
      │
      ▼
parsePermissionsFromToken()          ← new utility
      │
      ▼
UserPermissions { namespaces, perms }
      │
      ▼
buildCoreUser(permissions)           ← updated store factory
      │
      ▼
CoreUser (via Svelte context)
      │
      ├─▶ namespaceList filter        ← namespaces-service.ts
      └─▶ workflow-*-enabled.ts       ← per-action checks
```

### 3.2 New Types — `src/lib/types/global.ts`

Add after the existing `User` type:

```typescript
export type NamespacePermissions = {
  read: boolean;
  write: boolean;
  actions: {
    terminate: boolean;
    reset: boolean;
    signal: boolean;
    cancel: boolean;
    update: boolean;
    schedule: boolean;
    batch: boolean;
  };
  activities: boolean;
};

export type UserPermissions = {
  namespaces: Record<string, NamespacePermissions>;
  allowedNamespaces: string[];
};
```

### 3.3 New Utility — `src/lib/utilities/parse-permissions.ts`

Decodes the JWT access token (without signature verification — the backend verifies it) and builds a `UserPermissions` object.

```typescript
import type { UserPermissions, NamespacePermissions } from '$lib/types/global';

const emptyNamespacePermissions = (): NamespacePermissions => ({
  read: false,
  write: false,
  actions: {
    terminate: false,
    reset: false,
    signal: false,
    cancel: false,
    update: false,
    schedule: false,
    batch: false,
  },
  activities: false,
});

const decodeJwtPayload = (token: string): Record<string, unknown> => {
  try {
    const [, payloadB64] = token.split('.');
    const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
};

export const parsePermissionsFromToken = (
  accessToken?: string,
): UserPermissions => {
  if (!accessToken) {
    return { namespaces: {}, allowedNamespaces: [] };
  }

  const payload = decodeJwtPayload(accessToken);
  const roles: string[] =
    (payload?.resource_access as Record<string, { roles: string[] }>)?.[
      'temporal-ui'
    ]?.roles ?? [];

  const namespaces: Record<string, NamespacePermissions> = {};

  for (const role of roles) {
    // Expected format: temporal.<namespace>.<permission>
    if (!role.startsWith('temporal.')) continue;
    const withoutPrefix = role.slice('temporal.'.length);
    const dotIndex = withoutPrefix.indexOf('.');
    if (dotIndex === -1) continue;

    const ns = withoutPrefix.slice(0, dotIndex);
    const perm = withoutPrefix.slice(dotIndex + 1);

    if (!namespaces[ns]) namespaces[ns] = emptyNamespacePermissions();

    switch (perm) {
      case 'workflow.read':
        namespaces[ns].read = true;
        break;
      case 'workflow.write':
        namespaces[ns].write = true;
        break;
      case 'workflow.actions.terminate':
        namespaces[ns].actions.terminate = true;
        break;
      case 'workflow.actions.reset':
        namespaces[ns].actions.reset = true;
        break;
      case 'workflow.actions.signal':
        namespaces[ns].actions.signal = true;
        break;
      case 'workflow.actions.cancel':
        namespaces[ns].actions.cancel = true;
        break;
      case 'workflow.actions.update':
        namespaces[ns].actions.update = true;
        break;
      case 'workflow.actions.schedule':
        namespaces[ns].actions.schedule = true;
        break;
      case 'workflow.actions.batch':
        namespaces[ns].actions.batch = true;
        break;
      case 'workflow.activities':
        namespaces[ns].activities = true;
        break;
    }
  }

  const allowedNamespaces = Object.keys(namespaces).filter(
    (ns) => namespaces[ns].read,
  );

  return { namespaces, allowedNamespaces };
};
```

### 3.4 Extended CoreUser Model — `src/lib/models/core-user.ts`

Replace current interface:

```typescript
import type { UserPermissions } from '$lib/types/global';

export interface CoreUser {
  // Existing
  namespaceWriteDisabled: (namespace: string) => boolean;
  isActivityCommandsDisabled: boolean;

  // New — action-level checks (return true = action IS ALLOWED)
  permissions: UserPermissions | null;
  canTerminate: (namespace: string) => boolean;
  canReset: (namespace: string) => boolean;
  canSignal: (namespace: string) => boolean;
  canCancel: (namespace: string) => boolean;
  canUpdate: (namespace: string) => boolean;
  canSchedule: (namespace: string) => boolean;
  canBatch: (namespace: string) => boolean;
  canIssueActivityCommands: (namespace: string) => boolean;
}

export const CoreUserKey = 'CoreUser' as const;
```

### 3.5 Updated CoreUser Store — `src/lib/stores/core-user.ts`

```typescript
import { readable, type Readable } from 'svelte/store';
import { getContext, hasContext } from 'svelte';
import { type CoreUser, CoreUserKey } from '$lib/models/core-user';
import type { UserPermissions } from '$lib/types/global';

const allowAll = (): CoreUser => ({
  permissions: null,
  namespaceWriteDisabled: () => false,
  isActivityCommandsDisabled: false,
  canTerminate: () => true,
  canReset: () => true,
  canSignal: () => true,
  canCancel: () => true,
  canUpdate: () => true,
  canSchedule: () => true,
  canBatch: () => true,
  canIssueActivityCommands: () => true,
});

export const buildCoreUser = (
  permissions: UserPermissions | null,
): CoreUser => {
  if (!permissions || permissions.allowedNamespaces.length === 0) {
    return allowAll();
  }

  const ns = (namespace: string) => permissions.namespaces[namespace];

  return {
    permissions,
    namespaceWriteDisabled: (namespace) => !ns(namespace)?.write,
    isActivityCommandsDisabled: false,
    canTerminate: (namespace) => ns(namespace)?.actions.terminate ?? false,
    canReset: (namespace) => ns(namespace)?.actions.reset ?? false,
    canSignal: (namespace) => ns(namespace)?.actions.signal ?? false,
    canCancel: (namespace) => ns(namespace)?.actions.cancel ?? false,
    canUpdate: (namespace) => ns(namespace)?.actions.update ?? false,
    canSchedule: (namespace) => ns(namespace)?.actions.schedule ?? false,
    canBatch: (namespace) => ns(namespace)?.actions.batch ?? false,
    canIssueActivityCommands: (namespace) => ns(namespace)?.activities ?? false,
  };
};

export const defaultCoreUserStore: Readable<CoreUser> = readable(allowAll());

export const coreUserStore = (): Readable<CoreUser> => {
  if (!hasContext(CoreUserKey)) return defaultCoreUserStore;
  return getContext(CoreUserKey);
};
```

### 3.6 Layout Integration — `src/routes/(app)/+layout.ts`

Parse permissions from the access token after auth and pass them to the layout data:

```typescript
// Add this import
import { parsePermissionsFromToken } from '$lib/utilities/parse-permissions';

// Inside the load function, after `const user = getAuthUser();`:
const permissions = settings.auth.enabled
  ? parsePermissionsFromToken(user?.accessToken)
  : null;

return {
  user,
  settings,
  cluster,
  systemInfo,
  permissions, // ← new
};
```

### 3.7 CoreUser Context — `src/routes/(app)/+layout.svelte`

Set the CoreUser context from parsed permissions (add to the `<script>` block):

```typescript
import { setContext } from 'svelte';
import { readable } from 'svelte/store';
import { buildCoreUser } from '$lib/stores/core-user';
import { CoreUserKey } from '$lib/models/core-user';

let { data } = $props();

setContext(CoreUserKey, readable(buildCoreUser(data.permissions)));
```

### 3.8 Namespace Filtering — `src/lib/services/namespaces-service.ts`

After the existing `temporal-system` filter, add a user-permission filter:

```typescript
export async function fetchNamespaces(
  settings: Settings,
  request = fetch,
  allowedNamespaces?: string[], // ← new optional param
): Promise<void> {
  // ... existing code ...

  const _namespaces: DescribeNamespaceResponse[] = (results?.namespaces ?? [])
    .filter(
      (namespace: DescribeNamespaceResponse) =>
        showTemporalSystemNamespace ||
        namespace.namespaceInfo.name !== 'temporal-system',
    )
    // Filter to only namespaces the user has read access to
    .filter(
      (namespace: DescribeNamespaceResponse) =>
        !allowedNamespaces ||
        allowedNamespaces.length === 0 ||
        allowedNamespaces.includes(namespace.namespaceInfo.name),
    )
    .map(toNamespaceDetails);

  namespaces.set(_namespaces);
}
```

And in `src/routes/(app)/+layout.ts`, pass the allowed namespaces:

```typescript
fetchNamespaces(settings, fetch, permissions?.allowedNamespaces);
```

### 3.9 Per-Action Enabled Utilities

Each `workflow-*-enabled.ts` file gains an additional check against `CoreUser`.

**`src/lib/utilities/workflow-terminate-enabled.ts`**

```typescript
export const workflowTerminateEnabled = (
  settings: Settings,
  coreUser: CoreUser,
  namespace: string,
): boolean => {
  return (
    !settings.disableWriteActions &&
    !settings.workflowTerminateDisabled &&
    !coreUser.namespaceWriteDisabled(namespace) &&
    coreUser.canTerminate(namespace) // ← new
  );
};
```

Apply the same pattern to the other files:

| File                           | New check                                      |
| ------------------------------ | ---------------------------------------------- |
| `workflow-reset-enabled.ts`    | `coreUser.canReset(namespace)`                 |
| `workflow-signal-enabled.ts`   | `coreUser.canSignal(namespace)`                |
| `workflow-cancel-enabled.ts`   | `coreUser.canCancel(namespace)`                |
| `workflow-update-enabled.ts`   | `coreUser.canUpdate(namespace)`                |
| `activity-commands-enabled.ts` | `coreUser.canIssueActivityCommands(namespace)` |

**Schedule page guard** (check in the schedules route or create-schedule form):

```typescript
const scheduleActionsEnabled = (coreUser: CoreUser, namespace: string) =>
  !settings.disableWriteActions && coreUser.canSchedule(namespace);
```

**Batch actions guard** (in batch actions component):

```typescript
const batchEnabled = (coreUser: CoreUser, namespace: string) =>
  !settings.batchActionsDisabled && coreUser.canBatch(namespace);
```

---

## 4. Fallback Behaviour (Auth Disabled)

When `settings.auth.enabled = false` (local dev / no-auth mode):

- `parsePermissionsFromToken(undefined)` returns `{ namespaces: {}, allowedNamespaces: [] }`
- `buildCoreUser(null)` returns the `allowAll()` user — every permission check returns `true`
- Namespace list is not filtered (same as today)
- No change to existing no-auth behaviour

---

## 5. Data Flow Diagram

```
Keycloak issues JWT
  └── resource_access.temporal-ui.roles: [
        "temporal.default.workflow.read",
        "temporal.default.workflow.actions.signal"
      ]

+layout.ts (server load)
  └── parsePermissionsFromToken(accessToken)
        └── UserPermissions {
              namespaces: {
                default: { read: true, actions: { signal: true, ... } }
              },
              allowedNamespaces: ["default"]
            }
  └── fetchNamespaces(settings, fetch, ["default"])   → only "default" in store
  └── return { ..., permissions }

+layout.svelte
  └── setContext(CoreUserKey, readable(buildCoreUser(permissions)))

workflow-actions.svelte
  └── coreUser = coreUserStore()
  └── terminateEnabled = workflowTerminateEnabled(settings, $coreUser, namespace)
                       → false  (canTerminate returns false — role not in token)
  └── signalEnabled    = workflowSignalEnabled(settings, $coreUser, namespace)
                       → true   (canSignal returns true — role present)
```

---

## 6. Files Changed Summary

| File                                              | Change Type | Description                                                  |
| ------------------------------------------------- | ----------- | ------------------------------------------------------------ |
| `src/lib/types/global.ts`                         | Extend      | Add `NamespacePermissions`, `UserPermissions` types          |
| `src/lib/utilities/parse-permissions.ts`          | **New**     | Decode JWT, build `UserPermissions`                          |
| `src/lib/models/core-user.ts`                     | Extend      | Add `can*` methods and `permissions` field to interface      |
| `src/lib/stores/core-user.ts`                     | Extend      | Add `buildCoreUser(permissions)` factory                     |
| `src/routes/(app)/+layout.ts`                     | Modify      | Parse permissions, pass to `fetchNamespaces`, return in data |
| `src/routes/(app)/+layout.svelte`                 | Modify      | Set CoreUser context from parsed permissions                 |
| `src/lib/services/namespaces-service.ts`          | Modify      | Accept `allowedNamespaces` param, filter namespace list      |
| `src/lib/utilities/workflow-terminate-enabled.ts` | Modify      | Add `coreUser.canTerminate(namespace)` check                 |
| `src/lib/utilities/workflow-reset-enabled.ts`     | Modify      | Add `coreUser.canReset(namespace)` check                     |
| `src/lib/utilities/workflow-signal-enabled.ts`    | Modify      | Add `coreUser.canSignal(namespace)` check                    |
| `src/lib/utilities/workflow-cancel-enabled.ts`    | Modify      | Add `coreUser.canCancel(namespace)` check                    |
| `src/lib/utilities/workflow-update-enabled.ts`    | Modify      | Add `coreUser.canUpdate(namespace)` check                    |
| `src/lib/utilities/activity-commands-enabled.ts`  | Modify      | Add `coreUser.canIssueActivityCommands(namespace)` check     |

---

## 7. Testing Checklist

### Keycloak

- [ ] Client `temporal-ui` exists and is confidential
- [ ] Client roles follow `temporal.<namespace>.<permission>` convention
- [ ] Token mapper is set to include client roles in the access token
- [ ] Test user with restricted roles logs in and JWT contains expected `resource_access` claim

### UI

- [ ] User with `temporal.default.workflow.read` only → only `default` appears in namespace picker
- [ ] User with no `workflow.actions.terminate` → Terminate button is disabled in that namespace
- [ ] User with no `workflow.actions.signal` → Signal button is disabled
- [ ] User with no `workflow.actions.schedule` → Create Schedule button is hidden/disabled
- [ ] User with no `workflow.actions.reset` → Reset button is disabled
- [ ] Auth-disabled mode → all buttons enabled, all namespaces shown (no regression)
- [ ] User switches namespace → permission checks re-evaluate for the new namespace
- [ ] Token refresh (`/auth/refresh`) → permissions re-parsed from new token

---

## 8. Open Questions / Decisions Needed

1. **Namespace creation by admins**: Should Keycloak roles be auto-created when a new Temporal namespace is provisioned, or manually? An IDP sync script or Terraform provider for Keycloak can automate this.

2. **Super-admin role**: Do you need a `temporal.*.admin` wildcard role that grants all permissions on all namespaces? If so, `parsePermissionsFromToken` should detect it and return an `allowAll()` result.

3. **Backend enforcement**: The UI disables/hides buttons, but the Temporal backend (or a proxy layer) should also enforce these permissions via [Temporal authorization plugins](https://docs.temporal.io/self-hosted-guide/security#authorization) or a sidecar proxy. The UI changes are UX-only.

4. **Group-based assignment**: For large teams, consider Keycloak Groups (e.g. `temporal-default-operators`) with the composite roles assigned to the group, then add users to groups instead of assigning roles individually.

5. **Temporal Cloud**: This design applies only to self-hosted Temporal. For Temporal Cloud, namespace access is managed through Cloud accounts and is outside the scope of this document.

---

## Appendix A — Keycloak Setup via kcadm (Reference Implementation)

This appendix documents all `kcadm.sh` commands used to configure the Temporal UI realm, create roles, and provision users for this deployment.

### A.1 Environment

| Setting                   | Value                                  |
| ------------------------- | -------------------------------------- |
| Keycloak URL              | `http://10.167.240.227:8091/auth`      |
| Realm                     | `temporal-ui`                          |
| Client                    | `temporal-ui`                          |
| Client ID (internal UUID) | `fc1098b5-0398-4fc1-9fff-93339fb1b2a8` |
| kcadm location            | `/path/to/keycloak/bin/kcadm.sh`       |

```bash
KCADM="/path/to/keycloak/bin/kcadm.sh"

# Authenticate (run this before any other commands)
$KCADM config credentials \
  --server http://10.167.240.227:8091/auth \
  --realm master \
  --user admin \
  --password admin@123
```

---

### A.2 Namespace Groups

| Group       | Namespaces                                                         |
| ----------- | ------------------------------------------------------------------ |
| **ajiob2b** | `scm-jio-ajiob2b-fwd`, `scm-jio-ajiob2b-gw`                        |
| **grcb2b**  | `scm-jio-grcb2b-fwd`, `scm-jio-grcb2b-gw`                          |
| **ajiob2c** | `scm-jio-ajiob2c-fwd`, `scm-jio-ajiob2c-gw`, `scm-jio-ajiob2c-rfs` |
| **herald**  | `jio-herald-rugs`, `scm-jio-herald-plt-gw`                         |

---

### A.3 Permission Levels

| Level         | Roles granted per namespace                                                                                                                                                                                                                       | Count |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **viewer**    | `workflow.read`                                                                                                                                                                                                                                   | 1     |
| **operator**  | `workflow.read` + `workflow.actions.terminate` + `workflow.actions.reset` + `workflow.actions.signal` + `workflow.actions.cancel` + `workflow.actions.update` + `workflow.actions.schedule` + `workflow.actions.batch` + `workflow.actions.pause` | 9     |
| **developer** | All operator roles + `workflow.write` + `workflow.activities`                                                                                                                                                                                     | 11    |

---

### A.4 Create All Client Roles

The following script creates 11 roles per namespace (99 roles total across 9 namespaces + 11 for the `default` namespace):

```bash
KCADM="/path/to/keycloak/bin/kcadm.sh"
CLIENT_ID="fc1098b5-0398-4fc1-9fff-93339fb1b2a8"

NAMESPACES=(
  "scm-jio-ajiob2b-fwd"
  "scm-jio-ajiob2b-gw"
  "scm-jio-grcb2b-fwd"
  "scm-jio-grcb2b-gw"
  "scm-jio-ajiob2c-fwd"
  "scm-jio-ajiob2c-gw"
  "scm-jio-ajiob2c-rfs"
  "jio-herald-rugs"
  "scm-jio-herald-plt-gw"
)

PERMISSIONS=(
  "workflow.read"
  "workflow.write"
  "workflow.actions.terminate"
  "workflow.actions.reset"
  "workflow.actions.signal"
  "workflow.actions.cancel"
  "workflow.actions.update"
  "workflow.actions.schedule"
  "workflow.actions.batch"
  "workflow.actions.pause"
  "workflow.activities"
)

for ns in "${NAMESPACES[@]}"; do
  for perm in "${PERMISSIONS[@]}"; do
    ROLE_NAME="temporal.${ns}.${perm}"
    $KCADM create "clients/${CLIENT_ID}/roles" \
      -r temporal-ui \
      -s name="$ROLE_NAME" \
      -s description="${perm} on namespace ${ns}"
    echo "Created: $ROLE_NAME"
  done
done
```

> **Note:** `kcadm create` is idempotent-safe — re-running it on an existing role name returns a 409 conflict which can be ignored.

---

### A.5 Create Users

Password convention: `<username>@123`

```bash
KCADM="/path/to/keycloak/bin/kcadm.sh"

USERS=(
  "scm-jio-ajiob2b-viewer"
  "scm-jio-ajiob2b-operator"
  "scm-jio-ajiob2b-developer"
  "scm-jio-grcb2b-viewer"
  "scm-jio-grcb2b-operator"
  "scm-jio-grcb2b-developer"
  "scm-jio-ajiob2c-viewer"
  "scm-jio-ajiob2c-operator"
  "scm-jio-ajiob2c-developer"
  "jio-herald-viewer"
  "jio-herald-operator"
  "jio-herald-developer"
  "admin-viewer"
  "admin"
)

for username in "${USERS[@]}"; do
  PASSWORD="${username}@123"
  $KCADM create users -r temporal-ui \
    -s username="$username" \
    -s enabled=true \
    -s emailVerified=true
  $KCADM set-password -r temporal-ui \
    --username "$username" \
    --new-password "$PASSWORD" \
    --temporary false
  echo "Created user: $username  password: $PASSWORD"
done
```

---

### A.6 Assign Roles to Users

> **Important:** `kcadm add-roles` accepts a maximum of **8 `--rolename` arguments per call**.
> The script below batches roles in chunks of 8 to avoid the `Unmatched argument at index 9` error.

Save as `assign-roles.py` and run with `python3 assign-roles.py`:

```python
import subprocess, sys

KCADM  = "/path/to/keycloak/bin/kcadm.sh"
REALM  = "temporal-ui"
CLIENT = "temporal-ui"

VIEWER_PERMS = ["workflow.read"]
OPERATOR_PERMS = [
    "workflow.read",
    "workflow.actions.terminate", "workflow.actions.reset",
    "workflow.actions.signal",    "workflow.actions.cancel",
    "workflow.actions.update",    "workflow.actions.schedule",
    "workflow.actions.batch",     "workflow.actions.pause",
]
DEVELOPER_PERMS = OPERATOR_PERMS + ["workflow.write", "workflow.activities"]

GROUPS = {
    "ajiob2b": ["scm-jio-ajiob2b-fwd", "scm-jio-ajiob2b-gw"],
    "grcb2b":  ["scm-jio-grcb2b-fwd",  "scm-jio-grcb2b-gw"],
    "ajiob2c": ["scm-jio-ajiob2c-fwd",  "scm-jio-ajiob2c-gw", "scm-jio-ajiob2c-rfs"],
    "herald":  ["jio-herald-rugs",       "scm-jio-herald-plt-gw"],
}
ALL_NAMESPACES = [ns for nss in GROUPS.values() for ns in nss]

USERS = {}
for group, namespaces in GROUPS.items():
    prefix = "jio-herald" if group == "herald" else f"scm-jio-{group}"
    USERS[f"{prefix}-viewer"]    = (namespaces, VIEWER_PERMS)
    USERS[f"{prefix}-operator"]  = (namespaces, OPERATOR_PERMS)
    USERS[f"{prefix}-developer"] = (namespaces, DEVELOPER_PERMS)
USERS["admin-viewer"] = (ALL_NAMESPACES, VIEWER_PERMS)
USERS["admin"]        = (ALL_NAMESPACES, DEVELOPER_PERMS)

def run(args):
    return subprocess.run(["bash", KCADM] + args, capture_output=True, text=True)

def add_roles_chunked(username, role_names, chunk_size=8):
    for i in range(0, len(role_names), chunk_size):
        chunk = role_names[i:i+chunk_size]
        args  = ["add-roles", "-r", REALM, "--uusername", username, "--cclientid", CLIENT]
        for r in chunk:
            args += ["--rolename", r]
        result = run(args)
        if result.returncode != 0:
            print(f"  WARN: {result.stderr.strip()}", file=sys.stderr)
            return False
    return True

# Authenticate
run(["config", "credentials", "--server", "http://10.167.240.227:8091/auth",
     "--realm", "master", "--user", "admin", "--password", "admin@123"])

for username, (namespaces, perms) in sorted(USERS.items()):
    print(f"[{username}]")
    for ns in namespaces:
        roles = [f"temporal.{ns}.{p}" for p in perms]
        ok = add_roles_chunked(username, roles)
        print(f"  {'OK  ' if ok else 'FAIL'} {ns} ({len(roles)} roles)")
```

---

### A.7 User Reference Table

All users created in realm `temporal-ui`:

| Username                    | Password                        | Namespaces                                                   | Permission Level        | Roles Assigned |
| --------------------------- | ------------------------------- | ------------------------------------------------------------ | ----------------------- | -------------- |
| `scm-jio-ajiob2b-viewer`    | `scm-jio-ajiob2b-viewer@123`    | scm-jio-ajiob2b-fwd, scm-jio-ajiob2b-gw                      | viewer                  | 2              |
| `scm-jio-ajiob2b-operator`  | `scm-jio-ajiob2b-operator@123`  | scm-jio-ajiob2b-fwd, scm-jio-ajiob2b-gw                      | operator                | 18             |
| `scm-jio-ajiob2b-developer` | `scm-jio-ajiob2b-developer@123` | scm-jio-ajiob2b-fwd, scm-jio-ajiob2b-gw                      | developer               | 22             |
| `scm-jio-grcb2b-viewer`     | `scm-jio-grcb2b-viewer@123`     | scm-jio-grcb2b-fwd, scm-jio-grcb2b-gw                        | viewer                  | 2              |
| `scm-jio-grcb2b-operator`   | `scm-jio-grcb2b-operator@123`   | scm-jio-grcb2b-fwd, scm-jio-grcb2b-gw                        | operator                | 18             |
| `scm-jio-grcb2b-developer`  | `scm-jio-grcb2b-developer@123`  | scm-jio-grcb2b-fwd, scm-jio-grcb2b-gw                        | developer               | 22             |
| `scm-jio-ajiob2c-viewer`    | `scm-jio-ajiob2c-viewer@123`    | scm-jio-ajiob2c-fwd, scm-jio-ajiob2c-gw, scm-jio-ajiob2c-rfs | viewer                  | 3              |
| `scm-jio-ajiob2c-operator`  | `scm-jio-ajiob2c-operator@123`  | scm-jio-ajiob2c-fwd, scm-jio-ajiob2c-gw, scm-jio-ajiob2c-rfs | operator                | 27             |
| `scm-jio-ajiob2c-developer` | `scm-jio-ajiob2c-developer@123` | scm-jio-ajiob2c-fwd, scm-jio-ajiob2c-gw, scm-jio-ajiob2c-rfs | developer               | 33             |
| `jio-herald-viewer`         | `jio-herald-viewer@123`         | jio-herald-rugs, scm-jio-herald-plt-gw                       | viewer                  | 2              |
| `jio-herald-operator`       | `jio-herald-operator@123`       | jio-herald-rugs, scm-jio-herald-plt-gw                       | operator                | 18             |
| `jio-herald-developer`      | `jio-herald-developer@123`      | jio-herald-rugs, scm-jio-herald-plt-gw                       | developer               | 22             |
| `admin-viewer`              | `admin-viewer@123`              | all 9 namespaces                                             | viewer (read-only)      | 9              |
| `admin`                     | `admin@123`                     | all 9 namespaces                                             | developer (full access) | 99             |

**Permission summary per level:**

| Level         | Can view workflows | Can write/start | Can terminate/signal/cancel/reset/update/schedule/batch/pause | Can issue activity commands |
| ------------- | ------------------ | --------------- | ------------------------------------------------------------- | --------------------------- |
| **viewer**    | Yes                | No              | No                                                            | No                          |
| **operator**  | Yes                | No              | Yes (all 8 actions)                                           | No                          |
| **developer** | Yes                | Yes             | Yes (all 8 actions)                                           | Yes                         |

---

### A.8 Verify Role Assignments

```bash
KCADM="/path/to/keycloak/bin/kcadm.sh"

# Check role count for a single user
$KCADM get-roles -r temporal-ui \
  --uusername scm-jio-ajiob2b-operator \
  --cclientid temporal-ui

# Check role counts for all users (expected values in table above)
for username in \
  scm-jio-ajiob2b-viewer scm-jio-ajiob2b-operator scm-jio-ajiob2b-developer \
  scm-jio-grcb2b-viewer  scm-jio-grcb2b-operator  scm-jio-grcb2b-developer \
  scm-jio-ajiob2c-viewer scm-jio-ajiob2c-operator scm-jio-ajiob2c-developer \
  jio-herald-viewer jio-herald-operator jio-herald-developer \
  admin-viewer admin; do
    count=$($KCADM get-roles -r temporal-ui --uusername $username --cclientid temporal-ui \
            2>&1 | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d))" 2>/dev/null)
    echo "$username: $count roles"
done
```

Expected output:

```
scm-jio-ajiob2b-viewer:    2 roles   (1 perm × 2 namespaces)
scm-jio-ajiob2b-operator:  18 roles  (9 perms × 2 namespaces)
scm-jio-ajiob2b-developer: 22 roles  (11 perms × 2 namespaces)
scm-jio-grcb2b-viewer:     2 roles
scm-jio-grcb2b-operator:   18 roles
scm-jio-grcb2b-developer:  22 roles
scm-jio-ajiob2c-viewer:    3 roles   (1 perm × 3 namespaces)
scm-jio-ajiob2c-operator:  27 roles  (9 perms × 3 namespaces)
scm-jio-ajiob2c-developer: 33 roles  (11 perms × 3 namespaces)
jio-herald-viewer:         2 roles
jio-herald-operator:       18 roles
jio-herald-developer:      22 roles
admin-viewer:              9 roles   (1 perm × 9 namespaces)
admin:                     99 roles  (11 perms × 9 namespaces)
```

---

### A.9 Verify JWT Token Contents

After a user logs in, obtain their access token and inspect it:

```bash
# Get a token for a user (example: scm-jio-ajiob2b-viewer)
TOKEN=$(curl -s -X POST \
  "http://10.167.240.227:8091/auth/realms/temporal-ui/protocol/openid-connect/token" \
  -d "grant_type=password" \
  -d "client_id=temporal-ui" \
  -d "client_secret=fde15a41-9d3e-45c0-9043-250f2fd30bc1" \
  -d "username=scm-jio-ajiob2b-viewer" \
  -d "password=scm-jio-ajiob2b-viewer@123" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# Decode and show the roles claim
echo "$TOKEN" | cut -d. -f2 | \
  python3 -c "
import sys, base64, json
p = sys.stdin.read().strip()
p += '=' * (4 - len(p) % 4)
payload = json.loads(base64.b64decode(p))
roles = payload.get('resource_access', {}).get('temporal-ui', {}).get('roles', [])
print('Roles in JWT:')
for r in sorted(roles): print(' ', r)
"
```

Expected output for `scm-jio-ajiob2b-viewer`:

```
Roles in JWT:
  temporal.scm-jio-ajiob2b-fwd.workflow.read
  temporal.scm-jio-ajiob2b-gw.workflow.read
```

Expected output for `admin`:

```
Roles in JWT:
  temporal.jio-herald-rugs.workflow.actions.batch
  temporal.jio-herald-rugs.workflow.actions.cancel
  ... (99 roles total)
```

---

### A.10 Fix Keycloak Frontend URL (Required for Kubernetes)

If the K8s pod logs show:

```
unable to exchange token: ... lookup <hostname>... no such host
```

The Keycloak realm's **Frontend URL** is set to a hostname that K8s CoreDNS cannot resolve. Fix it to use the IP address:

```bash
KCADM="/path/to/keycloak/bin/kcadm.sh"

# Set the frontend URL to the IP-based URL
$KCADM update realms/temporal-ui \
  -r temporal-ui \
  -s 'attributes.frontendUrl=http://10.167.240.227:8091/auth'

# Verify — the issuer in the discovery doc should now use the IP
curl -s "http://10.167.240.227:8091/auth/realms/temporal-ui/.well-known/openid-configuration" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('issuer:', d['issuer'])"
```

Expected: `issuer: http://10.167.240.227:8091/auth/realms/temporal-ui`
