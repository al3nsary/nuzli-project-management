import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * A12 user management: after any change to an account, a membership, an owner or a workspace,
 * every list that may show it is refreshed (users, the user drawer, every A12 list, the audit log).
 */
export function useInvalidateUserAdmin() {
  const qc = useQueryClient();
  return useCallback(
    () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['users'] }),
        qc.invalidateQueries({ queryKey: ['user'] }),
        qc.invalidateQueries({ queryKey: ['a12'] }),
        qc.invalidateQueries({ queryKey: ['registrations'] }),
        qc.invalidateQueries({ queryKey: ['audit'] }),
      ]),
    [qc],
  );
}
