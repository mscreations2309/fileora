import { useEffect } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';

import { usePreferences } from '@/core/preferences/preferences';
import { useTheme } from '@/core/theme/ThemeProvider';

import { VaultContents } from './VaultContents';
import { clearViewingCopies } from './vaultFiles';
import { lockVault, refreshVaultStatus, useVault } from './vaultKeys';
import { VaultOnboarding } from './VaultOnboarding';
import { VaultUnlock } from './VaultUnlock';

export function VaultScreen() {
  const theme = useTheme();
  const status = useVault((s) => s.status);
  useEffect(() => {
    void refreshVaultStatus();
  }, []);
  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.background }}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }
  if (status === 'notSetUp') return <VaultOnboarding />;
  if (status === 'locked') return <VaultUnlock />;
  return <VaultContents />;
}

/**
 * App-wide guard: locks the vault when Fileora goes to the background (if enabled) or after inactivity,
 * and removes temporary decrypted copies. Also cleans leftovers from a previous session at startup.
 */
export function useVaultGuard(): void {
  useEffect(() => {
    clearViewingCopies();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background' && usePreferences.getState().vaultLockOnBackground && useVault.getState().key) {
        // Lock the key now, but keep a just-opened temporary copy until the viewer app has read it.
        lockVault();
      } else if (state === 'active' && !useVault.getState().key) {
        clearViewingCopies();
      }
    });
    const timer = setInterval(() => {
      const { key, lastActivity } = useVault.getState();
      const limit = usePreferences.getState().vaultAutoLockMinutes * 60_000;
      if (key && Date.now() - lastActivity > limit) {
        clearViewingCopies();
        lockVault();
      }
    }, 15_000);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, []);
}
