import type { NamespacePermissions, UserPermissions } from '$lib/types/global';

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
    pause: false,
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
): UserPermissions | null => {
  if (!accessToken) return null;

  const payload = decodeJwtPayload(accessToken);
  const clientRoles = (
    payload?.resource_access as Record<string, { roles: string[] }>
  )?.['temporal-ui']?.roles;

  if (!clientRoles || clientRoles.length === 0) return null;

  const namespaces: Record<string, NamespacePermissions> = {};

  for (const role of clientRoles) {
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
      case 'workflow.actions.pause':
        namespaces[ns].actions.pause = true;
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
