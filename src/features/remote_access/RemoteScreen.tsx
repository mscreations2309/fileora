import { FileoraStorage } from 'fileora-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { Linking, ScrollView, View } from 'react-native';
import Animated, { FadeInDown, ZoomIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatShortDate } from '@/core/format/format';
import { useTheme } from '@/core/theme/ThemeProvider';
import { hotspotPermission } from '@/features/file_handoff/handoff';
import { ConfirmDialog, showToast } from '@/shared/components/overlays';
import { AppText, Button, Card, Divider, EmptyState, Icon, IconButton, ListItem, SectionHeader } from '@/shared/components/primitives';

import { forgetDevice, loadDevices, remoteSupported, respondToPairing, startRemote, stopRemote, useRemote } from './remote';

/** App-wide approval prompt: a laptop asked to pair (shown on whatever screen is open). */
export function RemotePairingHost() {
  const pairing = useRemote((s) => s.pairing);
  return (
    <ConfirmDialog
      visible={pairing !== null}
      title="Allow this laptop?"
      message={pairing ? `“${pairing.name}” wants to manage your files from a browser.\n\nOnly allow it if the laptop shows the code ${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}.` : ''}
      confirmLabel="Allow"
      onConfirm={() => void respondToPairing(true)}
      onCancel={() => void respondToPairing(false)}
    />
  );
}

function Address({ url, primary }: { url: string; primary: boolean }) {
  return (
    <AppText variant={primary ? 'title' : 'bodyStrong'} selectable tone={primary ? 'onGradient' : 'primary'} style={{ fontFamily: 'monospace' }}>
      {url}
    </AppText>
  );
}

function HotspotCard() {
  const theme = useTheme();
  const port = useRemote((s) => s.port);
  const [hotspot, setHotspot] = useState<{ ssid: string; passphrase: string; addresses: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => () => FileoraStorage?.hotspotStop(), []);

  const start = async () => {
    if (!FileoraStorage) return;
    setBusy(true);
    try {
      if (!(await hotspotPermission())) {
        showToast('Allow “Nearby devices” to create a hotspot', 'error');
        return;
      }
      setHotspot(await FileoraStorage.hotspotStart());
    } catch (error) {
      showToast(error instanceof Error ? error.message.replace(/^[^:]*failure:\s*/i, '') : 'Could not start a hotspot', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!hotspot) {
    return (
      <Card style={{ padding: theme.spacing.md, gap: theme.spacing.sm }}>
        <AppText variant="bodyStrong">No Wi-Fi where you are?</AppText>
        <AppText variant="helper" tone="secondary">
          This phone can create its own private hotspot. Join it from the laptop’s Wi-Fi menu, then open the address shown. No internet needed.
        </AppText>
        <Button label="Start a hotspot for the laptop" variant="secondary" icon="access-point-network" loading={busy} onPress={() => void start()} />
      </Card>
    );
  }
  return (
    <Animated.View entering={ZoomIn.springify().damping(15)}>
      <Card style={{ padding: theme.spacing.md, gap: theme.spacing.sm }} elevation="medium">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          <Icon name="access-point-network" color={theme.colors.primary} />
          <AppText variant="bodyStrong" style={{ flex: 1 }}>
            Hotspot on
          </AppText>
          <IconButton icon="close" label="Stop hotspot" onPress={() => {
            FileoraStorage?.hotspotStop();
            setHotspot(null);
          }} />
        </View>
        <AppText variant="helper" tone="secondary">1. On the laptop, join this Wi-Fi:</AppText>
        <AppText variant="bodyStrong" selectable style={{ fontFamily: 'monospace' }}>{`Name:      ${hotspot.ssid}\nPassword:  ${hotspot.passphrase}`}</AppText>
        <AppText variant="helper" tone="secondary">2. Then open in the browser:</AppText>
        {hotspot.addresses.length ? (
          hotspot.addresses.map((a) => (
            <AppText key={a} variant="bodyStrong" selectable tone="primary" style={{ fontFamily: 'monospace', color: theme.colors.primary }}>{`http://${a}:${port ?? ''}`}</AppText>
          ))
        ) : (
          <AppText variant="helper" tone="warning">The hotspot address is not ready yet — stop and start it again.</AppText>
        )}
      </Card>
    </Animated.View>
  );
}

export function RemoteScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { running, starting, port, addresses, devices, activity, error } = useRemote();
  const [forget, setForget] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    void loadDevices();
  }, []);

  if (!remoteSupported) {
    return <EmptyState icon="laptop" title="Available on Android" message="Fileora Web runs a small server on your phone, which this build cannot do yet." />;
  }

  const urls = addresses.map((a) => `http://${a}:${port ?? ''}`);
  return (
    <ScrollView style={{ backgroundColor: theme.colors.background }} contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: insets.bottom + theme.spacing.xxxl }}>
      <Animated.View entering={FadeInDown.springify().damping(16)}>
        <LinearGradient colors={running ? theme.colors.heroGradient : [theme.colors.surfaceSunken, theme.colors.surface]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[{ borderRadius: theme.radii.xl, padding: theme.spacing.lg, gap: theme.spacing.md }, theme.elevation('medium')]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
            <View style={{ width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: running ? 'rgba(255,255,255,0.2)' : theme.colors.primarySubtle }}>
              <Icon name="laptop" size={28} color={running ? '#FFFFFF' : theme.colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <AppText variant="heading" tone={running ? 'onGradient' : 'primary'}>
                {running ? 'Fileora Web is on' : 'Use Fileora from a laptop'}
              </AppText>
              <AppText variant="helper" tone={running ? 'onGradient' : 'secondary'} style={running ? { opacity: 0.85 } : undefined}>
                {running ? 'Open this address in any browser on the same network:' : 'Browse, upload, rename and delete from a browser — live, on your local network.'}
              </AppText>
            </View>
          </View>
          {running ? (
            urls.length ? (
              urls.map((u, i) => <Address key={u} url={u} primary={i === 0} />)
            ) : (
              <AppText variant="body" tone="onGradient">Connect this phone to Wi-Fi, or start a hotspot below.</AppText>
            )
          ) : null}
          <Button label={running ? 'Turn off' : 'Turn on'} variant={running ? 'secondary' : 'primary'} icon={running ? 'power' : 'laptop'} loading={starting} onPress={() => (running ? stopRemote() : void startRemote())} />
        </LinearGradient>
      </Animated.View>
      {error ? <AppText variant="helper" tone="danger">{error}</AppText> : null}

      {running ? (
        <>
          <HotspotCard />
          <Card style={{ padding: theme.spacing.md, gap: theme.spacing.xs }}>
            <AppText variant="bodyStrong">How it works</AppText>
            <AppText variant="helper" tone="secondary">
              {'• The first time, the laptop shows a 6-digit code — approve it here.\n• Works while the phone is locked; the “Fileora Web is on” notification shows it is running.\n• Deleting from the laptop moves files to Fileora Trash, so it can be undone.\n• Changes show on both screens within a second.'}
            </AppText>
            <Divider />
            <AppText variant="helper" tone="tertiary">
              Traffic stays on your Wi-Fi or this phone’s hotspot and is protected by its Wi-Fi password, not by extra encryption. Use it on networks you trust, and turn it off on public Wi-Fi.
            </AppText>
            <Button label="Battery settings (keep it running when locked)" variant="ghost" compact icon="battery-heart-variant" onPress={() => void Linking.openSettings()} />
          </Card>
        </>
      ) : null}

      <SectionHeader title="Approved laptops" />
      {devices.length === 0 ? (
        <AppText variant="helper" tone="tertiary">None yet. A laptop appears here after you approve its code.</AppText>
      ) : (
        <Card>
          {devices.map((d, i) => (
            <View key={d.id}>
              {i > 0 ? <Divider inset={theme.spacing.lg} /> : null}
              <ListItem
                title={d.name}
                subtitle={`Approved ${formatShortDate(d.createdAt)}${d.lastSeenAt ? ` · last used ${formatShortDate(d.lastSeenAt)}` : ''}`}
                leading={<Icon name="laptop" color={theme.colors.primary} />}
                trailing={<IconButton icon="link-off" label={`Remove ${d.name}`} onPress={() => setForget({ id: d.id, name: d.name })} />}
              />
            </View>
          ))}
        </Card>
      )}

      {activity.length ? (
        <>
          <SectionHeader title="Recent activity" />
          <Card>
            {activity.slice(0, 20).map((a, i) => (
              <View key={a.id}>
                {i > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                <ListItem title={a.text} subtitle={`${a.device} · ${new Date(a.at).toLocaleTimeString()}`} />
              </View>
            ))}
          </Card>
        </>
      ) : null}

      <ConfirmDialog
        visible={forget !== null}
        title={`Remove ${forget?.name ?? 'laptop'}?`}
        message="It is disconnected immediately and must be approved again to reconnect."
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (forget) void forgetDevice(forget.id);
          setForget(null);
        }}
        onCancel={() => setForget(null)}
      />
    </ScrollView>
  );
}
