import type { UserPermissions } from '$lib/types/global';

export interface CoreUser {
  permissions: UserPermissions | null;
  namespaceWriteDisabled: (namespace: string) => boolean;
  isActivityCommandsDisabled: boolean;
  canTerminate: (namespace: string) => boolean;
  canReset: (namespace: string) => boolean;
  canSignal: (namespace: string) => boolean;
  canCancel: (namespace: string) => boolean;
  canUpdate: (namespace: string) => boolean;
  canSchedule: (namespace: string) => boolean;
  canBatch: (namespace: string) => boolean;
  canPause: (namespace: string) => boolean;
  canIssueActivityCommands: (namespace: string) => boolean;
}

export const CoreUserKey = 'CoreUser' as const;
