import { useEffect, useState } from 'react';
import { ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { presentError, toFileoraError } from '@/core/errors/FileoraError';
import { useTheme } from '@/core/theme/ThemeProvider';
import { showToast } from '@/shared/components/overlays';
import { AppText, Button, Card, Icon, ListItem, type IconName } from '@/shared/components/primitives';

import { SecretDialog } from './SecretDialog';
import { biometricsAvailable, passcodeSupported, setUpVault, validatePasscode } from './vaultKeys';

function Point({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
      <Icon name={icon} color={theme.colors.accent} />
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="bodyStrong">{title}</AppText>
        <AppText variant="body" tone="secondary">
          {text}
        </AppText>
      </View>
    </View>
  );
}

/** Explains the security model in plain language before anything is created. */
export function VaultOnboarding() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [biometrics, setBiometrics] = useState(false);
  const [useBiometrics, setUseBiometrics] = useState(true);
  const [askPasscode, setAskPasscode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void biometricsAvailable().then(setBiometrics);
  }, []);

  const create = async (passcode: string | null) => {
    setBusy(true);
    try {
      const code = await setUpVault({ passcode, useBiometrics: biometrics && useBiometrics });
      setAskPasscode(false);
      setRecoveryCode(code);
    } catch (error) {
      showToast(presentError(toFileoraError(error)).title, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (recoveryCode) {
    return (
      <ScrollView style={{ backgroundColor: theme.colors.background }} contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg, paddingBottom: insets.bottom + theme.spacing.xxl }}>
        <AppText variant="title" accessibilityRole="header">
          Save your recovery key
        </AppText>
        <AppText variant="body" tone="secondary">
          This key opens your vault if you forget your passcode or your biometrics change. It is shown only now. Write it down and keep it somewhere safe — not on this phone.
        </AppText>
        <Card style={{ padding: theme.spacing.lg, alignItems: 'center' }}>
          <AppText variant="heading" selectable style={{ fontFamily: 'monospace', letterSpacing: 1, textAlign: 'center' }} accessibilityLabel={`Recovery key: ${recoveryCode.split('').join(' ')}`}>
            {recoveryCode}
          </AppText>
        </Card>
        <ListItem title="I have written down my recovery key" subtitle="Without it, a forgotten passcode means the vault cannot be opened by anyone, including Fileora." onPress={() => setSaved((v) => !v)} trailing={<Switch value={saved} onValueChange={setSaved} accessibilityLabel="I have written down my recovery key" />} />
        <Button label="Open my vault" disabled={!saved} onPress={() => setRecoveryCode(null)} />
      </ScrollView>
    );
  }

  return (
    <ScrollView style={{ backgroundColor: theme.colors.background }} contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg, paddingBottom: insets.bottom + theme.spacing.xxl }}>
      <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
        <Icon name="shield-lock-outline" size={theme.iconSizes.hero} color={theme.colors.primary} />
        <AppText variant="title" accessibilityRole="header">
          Private Vault
        </AppText>
        <AppText variant="body" tone="secondary" style={{ textAlign: 'center' }}>
          An encrypted space for documents and photos only you can open.
        </AppText>
      </View>
      <Card style={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}>
        <Point icon="lock-outline" title="How it works" text="Files are encrypted on this device with AES-256 before they are stored. Their names are encrypted too. Nothing is uploaded." />
        <Point icon="fingerprint" title="How you open it" text={`${biometrics ? 'Your fingerprint or face unlocks a key kept in this phone’s secure hardware. ' : ''}${passcodeSupported ? 'A vault passcode always works as a backup.' : 'Your device passcode works as a backup.'}`} />
        <Point icon="key-variant" title="Recovery" text="You get a one-time recovery key. It opens the vault if you forget your passcode, and it is needed to restore an encrypted backup on another phone." />
        <Point icon="alert-outline" title="What cannot be recovered" text="If you lose your passcode, your biometrics and your recovery key, the vault cannot be decrypted — by you, by Fileora, or by anyone. Uninstalling Fileora deletes the vault unless you made a backup." />
      </Card>
      {biometrics ? (
        <ListItem title="Unlock with biometrics" subtitle="Uses this device’s fingerprint or face unlock." onPress={() => setUseBiometrics((v) => !v)} trailing={<Switch value={useBiometrics} onValueChange={setUseBiometrics} accessibilityLabel="Unlock with biometrics" />} />
      ) : (
        <AppText variant="helper" tone="tertiary">
          No fingerprint or face unlock is set up on this device, so you will use a passcode.
        </AppText>
      )}
      <Button label="Set up vault" icon="shield-lock-outline" loading={busy} onPress={() => (passcodeSupported ? setAskPasscode(true) : void create(null))} />
      <SecretDialog
        visible={askPasscode}
        title="Choose a vault passcode"
        message="At least 6 characters. This is separate from your phone’s lock screen."
        confirm
        confirmLabel="Create vault"
        validate={validatePasscode}
        busy={busy}
        onCancel={() => setAskPasscode(false)}
        onSubmit={(passcode) => void create(passcode)}
      />
    </ScrollView>
  );
}
