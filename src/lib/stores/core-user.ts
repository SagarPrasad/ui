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
  canPause: () => true,
  canIssueActivityCommands: () => true,
});

export const buildCoreUser = (
  permissions: UserPermissions | null,
): CoreUser => {
  if (!permissions) return allowAll();

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
    canPause: (namespace) => ns(namespace)?.actions.pause ?? false,
    canIssueActivityCommands: (namespace) => ns(namespace)?.activities ?? false,
  };
};

export const defaultCoreUserStore: Readable<CoreUser> = readable(allowAll());

export const coreUserStore = (): Readable<CoreUser> => {
  if (!hasContext(CoreUserKey)) return defaultCoreUserStore;
  return getContext(CoreUserKey);
};
