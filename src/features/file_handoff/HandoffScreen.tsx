import { File } from 'expo-file-system';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming, ZoomIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { presentError, toFileoraError } from '@/core/errors/FileoraError';
import { formatBytes, formatCount, formatDuration, formatShortDate } from '@/core/format/format';
import { pickFolderUri } from '@/core/storage/locations';
import { useTheme } from '@/core/theme/ThemeProvider';
import { useLocations } from '@/features/browse/locationsStore';
import { ProgressBar, showToast } from '@/shared/components/overlays';
import { AppText, Badge, Button, Card, Chip, Divider, EmptyState, Icon, ListItem, SectionHeader } from '@/shared/components/primitives';
import { QrCode } from '@/shared/components/QrCode';

import {
  cancelSending,
  collectFiles,
  deviceName,
  handoffSupported,
  respondToPairing,
  send,
  setOutgoing,
  startReceiving,
  stopReceiving,
  transferHistory,
  useHandoff,
  type FileResult,
} from './handoff';
import { buildPairingPayload, isEmulatorAddress, parsePairingParams, parsePairingText, type HandoffTarget } from './pairing';
import { QrScanner } from './QrScanner';

const STATUS: Record<FileResult['status'], { label: string; tone: 'neutral' | 'success' | 'danger' | 'brand' }> = {
  pending: { label: 'Waiting', tone: 'neutral' },
  verified: { label: 'Verified', tone: 'brand' },
  imported: { label: 'Saved · verified', tone: 'success' },
  failed: { label: 'Failed check', tone: 'danger' },
  importFailed: { label: 'Not saved', tone: 'danger' },
};

function CodeCard({ code, mine }: { code: string; mine: 'send' | 'receive' }) {
  const theme = useTheme();
  return (
    <Animated.View entering={ZoomIn.springify().damping(15)}>
      <Card style={{ padding: theme.spacing.lg, alignItems: 'center', gap: theme.spacing.sm }} elevation="medium">
        <AppText variant="helper" tone="secondary">
          {mine === 'receive' ? 'Check that the sending device shows the same code' : 'The receiving device must show the same code'}
        </AppText>
        <AppText variant="display" style={{ letterSpacing: 6, fontFamily: 'monospace' }} accessibilityLabel={`Pairing code ${code.split('').join(' ')}`}>
          {`${code.slice(0, 3)} ${code.slice(3)}`}
        </AppText>
        <AppText variant="helper" tone="tertiary" style={{ textAlign: 'center' }}>
          If the codes differ, someone may be intercepting the connection. Decline it.
        </AppText>
      </Card>
    </Animated.View>
  );
}

function Progress() {
  const theme = useTheme();
  const { bytes, totalBytes, startedAt, results } = useHandoff();
  // A once-per-second clock keeps speed and time estimates current without reading time during render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;
  const speed = elapsed > 1 ? bytes / elapsed : 0;
  // Only show an estimate once the speed has had time to settle.
  const eta = speed > 0 && elapsed > 3 && totalBytes > bytes ? (totalBytes - bytes) / speed : null;
  const done = results.filter((r) => r.status !== 'pending').length;
  return (
    <Card style={{ padding: theme.spacing.md, gap: theme.spacing.sm }}>
      <AppText variant="bodyStrong">{`${formatBytes(bytes)} of ${formatBytes(totalBytes)} · ${formatCount(done)}/${formatCount(results.length)} files`}</AppText>
      <ProgressBar progress={totalBytes > 0 ? Math.min(1, bytes / totalBytes) : null} />
      <AppText variant="helper" tone="secondary">
        {`${speed > 0 ? `${formatBytes(speed)}/s` : 'Measuring speed…'}${eta !== null ? ` · about ${formatDuration(eta * 1000)} left` : ''}`}
      </AppText>
    </Card>
  );
}

function Results() {
  const theme = useTheme();
  const results = useHandoff((s) => s.results);
  if (results.length === 0) return null;
  return (
    <Card>
      {results.slice(0, 200).map((r, i) => (
        <View key={`${r.path}-${i}`}>
          {i > 0 ? <Divider inset={theme.spacing.lg} /> : null}
          <ListItem title={r.path} subtitle={r.detail ?? null} trailing={<Badge label={STATUS[r.status].label} tone={STATUS[r.status].tone} />} />
        </View>
      ))}
    </Card>
  );
}

/** A softly pulsing "live" dot, so it is obvious the device is listening right now. */
function Pulse() {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const ring = useSharedValue(0);
  useEffect(() => {
    if (!reduceMotion) ring.value = withRepeat(withTiming(1, { duration: 1600 }), -1);
  }, [reduceMotion, ring]);
  const halo = useAnimatedStyle(() => ({ opacity: 0.6 * (1 - ring.value), transform: [{ scale: 1 + ring.value * 1.6 }] }));
  return (
    <View style={{ width: 12, height: 12, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={[{ position: 'absolute', width: 12, height: 12, borderRadius: 6, backgroundColor: theme.colors.success }, halo]} />
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: theme.colors.success }} />
    </View>
  );
}

function EmulatorNote({ receiving }: { receiving: boolean }) {
  const theme = useTheme();
  return (
    <Card style={{ padding: theme.spacing.md, gap: theme.spacing.xs, borderColor: theme.colors.warning }}>
      <View style={{ flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'center' }}>
        <Icon name="monitor-cellphone" color={theme.colors.warning} />
        <AppText variant="bodyStrong">{receiving ? 'This is an emulator' : 'That address belongs to an emulator'}</AppText>
      </View>
      <AppText variant="helper" tone="secondary">
        {receiving
          ? 'Its 10.0.2.x address only exists inside the computer running it, so phones can’t connect to it. Receive on the phone instead and send from the emulator — the emulator can reach the phone over your Wi-Fi.'
          : 'Phones can’t reach an emulator’s 10.0.2.x address. Swap roles: receive on this phone and send from the emulator.'}
      </AppText>
    </Card>
  );
}

function ListeningCard() {
  const theme = useTheme();
  const { addresses, port, destination, message, emulator, hotspot, hotspotError } = useHandoff();
  const payload = addresses.length && port ? buildPairingPayload({ hosts: addresses, port, name: deviceName(), hotspot: hotspot ?? undefined }) : null;
  return (
    <>
      {emulator && !hotspot ? <EmulatorNote receiving /> : null}
      <Animated.View entering={FadeInDown.springify().damping(16)}>
        <Card style={{ padding: theme.spacing.lg, gap: theme.spacing.md, alignItems: 'center' }} elevation="medium">
          <View style={{ flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'center', alignSelf: 'flex-start' }}>
            <Pulse />
            <AppText variant="heading">Ready to receive</AppText>
          </View>
          {payload ? (
            <>
              <Animated.View entering={ZoomIn.delay(120).springify().damping(13)} style={[{ padding: theme.spacing.sm, borderRadius: 22, backgroundColor: '#FFFFFF' }, theme.elevation('medium')]}>
                <QrCode value={payload} size={216} accessibilityLabel={`Pairing code for ${deviceName()}. Scan it from Smart Handoff on the sending device.`} />
              </Animated.View>
              <AppText variant="body" tone="secondary" style={{ textAlign: 'center' }}>
                On the sending device, open Smart Handoff › Send › Scan QR code.
              </AppText>
              <View style={{ alignSelf: 'stretch' }}>
                <Divider />
              </View>
              <View style={{ alignSelf: 'stretch', gap: theme.spacing.xs }}>
                <AppText variant="helper" tone="tertiary">
                  No camera? Type one of these instead:
                </AppText>
                {addresses.map((address) => (
                  <AppText key={address} variant="bodyStrong" selectable style={{ fontFamily: 'monospace' }} tone={isEmulatorAddress(address) ? 'tertiary' : 'primary'}>
                    {`${address}:${port}`}
                  </AppText>
                ))}
              </View>
            </>
          ) : (
            <AppText variant="body" tone="warning">
              No Wi-Fi address found. Connect both devices to the same Wi-Fi network.
            </AppText>
          )}
          <AppText variant="helper" tone="tertiary" style={{ alignSelf: 'stretch' }}>{`Files will be saved to ${destination?.label ?? 'the chosen folder'}. You approve every transfer.`}</AppText>
          {hotspot ? (
            <View style={{ alignSelf: 'stretch', flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'center', padding: theme.spacing.sm, borderRadius: theme.radii.md, backgroundColor: theme.colors.primarySubtle }}>
              <Icon name="access-point-network" color={theme.colors.primary} />
              <AppText variant="helper" style={{ flex: 1 }}>{`Direct link on: “${hotspot.ssid}”. The other phone joins it by scanning — no shared Wi-Fi or internet needed.`}</AppText>
            </View>
          ) : hotspotError ? (
            <AppText variant="helper" tone="warning" style={{ alignSelf: 'stretch' }}>{`Direct link unavailable: ${hotspotError}. Both phones need to be on the same Wi-Fi.`}</AppText>
          ) : null}
          {message ? <AppText variant="helper" tone="danger">{message}</AppText> : null}
        </Card>
      </Animated.View>
    </>
  );
}

function ReceivePanel() {
  const theme = useTheme();
  const state = useHandoff();
  const locations = useLocations((s) => s.locations);
  const downloads = locations.find((l) => l.id === 'shortcut:Download');

  const begin = async (destination: { uri: string; label: string }) => {
    try {
      await startReceiving(destination);
    } catch (error) {
      showToast(presentError(toFileoraError(error)).title, 'error');
    }
  };

  if (state.role !== 'receive') {
    return (
      <View style={{ gap: theme.spacing.md }}>
        <AppText variant="body" tone="secondary">
          Receive files from another device running Fileora on the same Wi-Fi network. You’ll get a QR code for the sender to scan. Fileora only listens while this screen says so, and you approve every transfer.
        </AppText>
        {downloads ? <Button label={`Receive into ${downloads.label}`} icon="download-outline" onPress={() => void begin({ uri: downloads.rootUri, label: downloads.label })} /> : null}
        <Button label="Choose a folder and receive…" variant={downloads ? 'secondary' : 'primary'} icon="folder-download-outline" onPress={() => void pickFolderUri().then((f) => f && begin({ uri: f.uri, label: f.name }))} />
      </View>
    );
  }

  return (
    <View style={{ gap: theme.spacing.md }}>
      {state.phase === 'listening' ? <ListeningCard /> : null}
      {state.phase === 'pairing' && state.code ? (
        <>
          <CodeCard code={state.code} mine="receive" />
          <Card style={{ padding: theme.spacing.md, gap: theme.spacing.xs }}>
            <AppText variant="bodyStrong">{`${state.peer ?? 'A device'} wants to send ${formatCount(state.incoming?.fileCount ?? 0)} files (${formatBytes(state.incoming?.totalBytes ?? 0)})`}</AppText>
            {(state.incoming?.files ?? []).slice(0, 8).map((f) => (
              <AppText key={f} variant="meta" tone="secondary" numberOfLines={1}>
                {`• ${f}`}
              </AppText>
            ))}
          </Card>
          <Button label="Codes match — accept" icon="check" onPress={() => respondToPairing(true)} />
          <Button label="Decline" variant="secondary" onPress={() => respondToPairing(false)} />
        </>
      ) : null}
      {state.phase === 'transferring' ? <Progress /> : null}
      {state.phase === 'completed' ? (
        <AppText variant="heading" tone="success">
          {`Transfer complete: ${state.results.filter((r) => r.status === 'imported').length} of ${state.results.length} files saved and verified`}
        </AppText>
      ) : null}
      <Results />
      <Button label={state.phase === 'completed' ? 'Done' : 'Stop receiving'} variant="ghost" onPress={stopReceiving} />
    </View>
  );
}

function TargetCard({ target, onChange, disabled }: { target: HandoffTarget; onChange: () => void; disabled: boolean }) {
  const theme = useTheme();
  return (
    <Animated.View entering={ZoomIn.springify().damping(15)}>
      <Card style={{ padding: theme.spacing.md, gap: theme.spacing.md, flexDirection: 'row', alignItems: 'center' }} elevation="medium">
        <View style={{ width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primarySubtle }}>
          <Icon name="cellphone-check" color={theme.colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <AppText variant="bodyStrong" numberOfLines={1}>
            {target.name ?? 'Receiver'}
          </AppText>
          <AppText variant="meta" tone="secondary" numberOfLines={1} style={{ fontFamily: 'monospace' }}>
            {`${target.hosts[0] ?? ''}:${target.port}${target.hosts.length > 1 ? ` +${target.hosts.length - 1}` : ''}`}
          </AppText>
        </View>
        {disabled ? null : <Chip label="Rescan" icon="qrcode-scan" selected={false} onPress={onChange} />}
      </Card>
    </Animated.View>
  );
}

function SendPanel({ initialTarget }: { initialTarget: HandoffTarget | null }) {
  const theme = useTheme();
  const state = useHandoff();
  const [address, setAddress] = useState('');
  const [scanned, setScanned] = useState<HandoffTarget | null>(initialTarget);
  const [scanning, setScanning] = useState(false);
  const typed = parsePairingText(address);
  const target = scanned ?? typed;
  const hasFiles = state.role === 'send' && state.outgoing.length > 0;
  const onlyEmulator = target && !target.hotspot ? target.hosts.every(isEmulatorAddress) : false;

  const addFiles = async () => {
    const picked = await File.pickFileAsync({ multipleFiles: true }).catch(() => null);
    if (!picked || picked.canceled) return;
    const files = await collectFiles(picked.result.map((f) => ({ uri: f.uri, name: f.name, isDirectory: false, size: f.size })));
    setOutgoing([...(state.role === 'send' ? state.outgoing : []), ...files]);
  };

  const onScanned = (next: HandoffTarget) => {
    setScanned(next);
    // Files already chosen: connect straight away. The receiver still confirms the 6-digit code before anything is sent.
    if (hasFiles && (next.hotspot || !next.hosts.every(isEmulatorAddress))) void send(next);
  };

  const busy = state.phase === 'joining' || state.phase === 'preparing' || state.phase === 'pairing' || state.phase === 'transferring';
  return (
    <View style={{ gap: theme.spacing.md }}>
      <Card style={{ padding: theme.spacing.md, gap: theme.spacing.xs }}>
        <AppText variant="bodyStrong">{hasFiles ? `${formatCount(state.outgoing.length)} files · ${formatBytes(state.totalBytes)}` : 'No files selected'}</AppText>
        {state.role === 'send'
          ? state.outgoing.slice(0, 6).map((f) => (
              <AppText key={f.path} variant="meta" tone="secondary" numberOfLines={1}>
                {`• ${f.path}`}
              </AppText>
            ))
          : null}
        <AppText variant="helper" tone="tertiary">
          Tip: select files or folders in Browse and choose “Send to another device”. Folder structure is kept.
        </AppText>
        <Button label="Add files…" variant="secondary" compact icon="file-plus-outline" disabled={busy} onPress={() => void addFiles()} />
      </Card>

      {scanned ? (
        <TargetCard target={scanned} disabled={busy} onChange={() => setScanning(true)} />
      ) : (
        <>
          <Button label="Scan QR code" icon="qrcode-scan" disabled={busy} onPress={() => setScanning(true)} />
          <AppText variant="caption" tone="secondary">
            Or type the receiver’s address
          </AppText>
          <TextInput
            value={address}
            onChangeText={setAddress}
            placeholder="192.168.1.20:40123"
            placeholderTextColor={theme.colors.textTertiary}
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            accessibilityLabel="Receiver address"
            editable={!busy}
            style={[
              theme.typography.body,
              { color: theme.colors.textPrimary, borderWidth: 1.5, borderColor: typed ? theme.colors.primary : theme.colors.borderStrong, borderRadius: theme.radii.md, paddingHorizontal: theme.spacing.md, minHeight: theme.touchTarget, fontFamily: 'monospace' },
            ]}
          />
        </>
      )}
      {onlyEmulator ? <EmulatorNote receiving={false} /> : null}

      {!busy ? (
        <Button label="Connect and send" icon="send-outline" disabled={!target || !hasFiles} onPress={() => target && void send(target)} />
      ) : (
        <Button label="Cancel" variant="secondary" onPress={cancelSending} />
      )}
      {state.phase === 'joining' ? (
        <Animated.View entering={FadeIn}>
          <Card style={{ padding: theme.spacing.md, flexDirection: 'row', gap: theme.spacing.md, alignItems: 'center' }}>
            <Icon name="access-point-network" color={theme.colors.primary} />
            <AppText variant="body" style={{ flex: 1 }}>{`Connecting directly to ${state.target?.name ?? 'the other phone'}… Tap “Connect” if Android asks.`}</AppText>
          </Card>
        </Animated.View>
      ) : null}
      {state.phase === 'preparing' ? (
        <Animated.View entering={FadeIn}>
          <AppText variant="helper" tone="secondary">
            Checking files and connecting…
          </AppText>
        </Animated.View>
      ) : null}
      {state.phase === 'pairing' && state.code ? <CodeCard code={state.code} mine="send" /> : null}
      {state.phase === 'pairing' ? <AppText variant="helper" tone="secondary">Waiting for the other device to accept…</AppText> : null}
      {state.phase === 'transferring' ? <Progress /> : null}
      {state.phase === 'rejected' || state.phase === 'failed' || state.phase === 'cancelled' ? (
        <Card style={{ padding: theme.spacing.md, gap: theme.spacing.sm }}>
          <AppText variant="body" tone="danger">
            {state.message ?? (state.phase === 'cancelled' ? 'Cancelled.' : 'The transfer stopped.')}
          </AppText>
          {state.phase === 'failed' ? (
            <AppText variant="helper" tone="secondary">
              Check that both devices are on the same Wi-Fi and the other device still shows “Ready to receive”. Guest or public Wi-Fi often stops devices from reaching each other.
            </AppText>
          ) : null}
          {state.target && state.phase !== 'rejected' ? <Button label="Retry (resumes partial files)" icon="refresh" onPress={() => state.target && void send(state.target, true)} /> : null}
        </Card>
      ) : null}
      {state.phase === 'completed' ? (
        <AppText variant="heading" tone="success">
          {`Sent: ${state.results.filter((r) => r.status === 'verified').length} of ${state.results.length} files verified by the receiver`}
        </AppText>
      ) : null}
      <Results />
      <QrScanner visible={scanning} onClose={() => setScanning(false)} onScanned={onScanned} />
    </View>
  );
}

export function HandoffScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const role = useHandoff((s) => s.role);
  const phase = useHandoff((s) => s.phase);
  const params = useLocalSearchParams<{ h?: string; p?: string; n?: string; s?: string; k?: string }>();
  // Opened from a scanned pairing link (e.g. with the system camera): go straight to Send with that receiver.
  const [linkTarget] = useState(() => parsePairingParams(params));
  const [tab, setTab] = useState<'send' | 'receive'>(role === 'receive' && !linkTarget ? 'receive' : 'send');
  const [history, setHistory] = useState<Awaited<ReturnType<typeof transferHistory>>>([]);

  useEffect(() => {
    void transferHistory().then(setHistory);
  }, [phase]);

  if (!handoffSupported) {
    return <EmptyState icon="cellphone-arrow-down" title="Available on Android" message="Smart Handoff uses a direct local connection that is not available in this build yet." />;
  }

  return (
    <ScrollView style={{ backgroundColor: theme.colors.background }} contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: insets.bottom + theme.spacing.xxxl }} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
        <Chip label="Send" icon="upload-outline" selected={tab === 'send'} onPress={() => setTab('send')} />
        <Chip label="Receive" icon="download-outline" selected={tab === 'receive'} onPress={() => setTab('receive')} />
      </View>
      {tab === 'send' ? <SendPanel initialTarget={linkTarget} /> : <ReceivePanel />}
      <AppText variant="helper" tone="tertiary">
        Transfers go directly between the two devices over your local network, encrypted end to end, and every file is checked with SHA-256. The QR code only says where to connect — the 6-digit code still protects the pairing. Both apps must stay open during the transfer.
      </AppText>
      {history.length ? (
        <>
          <SectionHeader title="Transfer history" />
          <Card>
            {history.map((t, i) => (
              <View key={t.id}>
                {i > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                <ListItem
                  title={`${t.direction === 'send' ? 'Sent to' : 'Received from'} ${t.peer}`}
                  subtitle={`${formatCount(t.verified)}/${formatCount(t.fileCount)} verified · ${formatBytes(t.totalBytes)} · ${t.status}${t.finishedAt ? ` · ${formatShortDate(t.finishedAt)}` : ''}`}
                  leading={<Icon name={t.direction === 'send' ? 'upload-outline' : 'download-outline'} color={t.failed ? theme.colors.warning : theme.colors.primary} />}
                />
              </View>
            ))}
          </Card>
        </>
      ) : null}
    </ScrollView>
  );
}
