import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { presentError, toFileoraError } from '@/core/errors/FileoraError';
import { useTheme } from '@/core/theme/ThemeProvider';
import { AppText, Button, Icon } from '@/shared/components/primitives';

import { SecretDialog } from './SecretDialog';
import { unlockWithBiometrics, unlockWithPasscode, unlockWithRecoveryKey, useVault } from './vaultKeys';

export function VaultUnlock() {
  const theme = useTheme();
  const { biometricEnabled, passcodeEnabled } = useVault();
  const [mode, setMode] = useState<'none' | 'passcode' | 'recovery'>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);

  const tryBiometrics = async () => {
    setError(null);
    try {
      await unlockWithBiometrics();
    } catch (e) {
      setError(toFileoraError(e).message);
    }
  };

  // Prompt for biometrics once when the locked screen appears.
  const autoPrompted = useRef(false);
  useEffect(() => {
    if (!biometricEnabled || autoPrompted.current) return;
    autoPrompted.current = true;
    unlockWithBiometrics().catch((e: unknown) => setError(toFileoraError(e).message));
  }, [biometricEnabled]);

  const submit = async (value: string) => {
    if (attempts >= 5) {
      setError('Too many attempts. Wait a moment and try again.');
      setTimeout(() => setAttempts(0), 30_000);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'passcode') await unlockWithPasscode(value);
      else await unlockWithRecoveryKey(value);
      setMode('none');
    } catch (e) {
      setAttempts((n) => n + 1);
      const failure = toFileoraError(e);
      setError(failure.code === 'ERR_ACCESS_DENIED' ? failure.message : presentError(failure).title);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: theme.spacing.xl, gap: theme.spacing.md, backgroundColor: theme.colors.background }}>
      <Icon name="lock-outline" size={theme.iconSizes.hero} color={theme.colors.primary} />
      <AppText variant="title" accessibilityRole="header">
        Vault locked
      </AppText>
      <AppText variant="body" tone="secondary" style={{ textAlign: 'center' }}>
        Your files are encrypted. Unlock to view them.
      </AppText>
      {error && mode === 'none' ? (
        <AppText variant="helper" tone="danger" style={{ textAlign: 'center' }} accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}
      <View style={{ alignSelf: 'stretch', gap: theme.spacing.sm, marginTop: theme.spacing.lg }}>
        {biometricEnabled ? <Button label="Unlock with biometrics" icon="fingerprint" onPress={() => void tryBiometrics()} /> : null}
        {passcodeEnabled ? <Button label="Use passcode" icon="form-textbox-password" variant={biometricEnabled ? 'secondary' : 'primary'} onPress={() => { setError(null); setMode('passcode'); }} /> : null}
        <Button label="Use recovery key" variant="ghost" onPress={() => { setError(null); setMode('recovery'); }} />
      </View>
      <SecretDialog
        key={mode}
        visible={mode !== 'none'}
        title={mode === 'passcode' ? 'Vault passcode' : 'Recovery key'}
        message={mode === 'recovery' ? 'Enter the 32-character key you saved when you set up the vault.' : undefined}
        masked={mode === 'passcode'}
        confirmLabel="Unlock"
        busy={busy}
        error={error}
        onCancel={() => setMode('none')}
        onSubmit={(value) => void submit(value)}
      />
    </View>
  );
}
