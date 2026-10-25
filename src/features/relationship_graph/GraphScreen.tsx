import { File } from 'expo-file-system';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { GestureDetector, usePanGesture, usePinchGesture, useSimultaneousGestures } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { toFileoraError } from '@/core/errors/FileoraError';
import { categorize, mimeTypeFor } from '@/core/storage/fileTypes';
import { storage, toFileEntry } from '@/core/storage/storage';
import { useTheme } from '@/core/theme/ThemeProvider';
import { showInFolder } from '@/features/browse/navigation';
import { openFile } from '@/features/library/library';
import { FileIcon } from '@/shared/components/FileIcon';
import { showToast } from '@/shared/components/overlays';
import { AppText, Badge, Button, Card, Chip, EmptyState, IconButton, ListItem } from '@/shared/components/primitives';

import { dismissSuggestion, findRelated, linkFiles, unlinkFiles, useGraphHistory, type GraphEdge, type GraphNode } from './relationships';

const NODE = 56;

export function GraphScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ uri: string; parent: string; name: string; loc: string }>();
  const { trail, push, back, reset } = useGraphHistory();
  const [edges, setEdges] = useState<GraphEdge[] | null>(null);
  const [selected, setSelected] = useState<GraphEdge | null>(null);
  const [mode, setMode] = useState<'graph' | 'list'>('graph');
  const [error, setError] = useState<string | null>(null);

  // Start from the file the screen was opened for; keep the existing trail if it already ends there.
  useEffect(() => {
    const start: GraphNode = { uri: params.uri ?? '', parentUri: params.parent ?? '', locationId: params.loc ?? null, name: params.name ?? 'File', category: categorize(params.name ?? '', false, mimeTypeFor(params.name ?? '')), modifiedAt: null };
    const current = useGraphHistory.getState().trail;
    if (!current.some((n) => n.uri === start.uri)) reset(start);
  }, [params.uri, params.parent, params.loc, params.name, reset]);

  const center = trail[trail.length - 1] ?? null;

  const load = useCallback((node: GraphNode) => {
    findRelated(node)
      .then((result) => {
        setEdges(result);
        setError(null);
      })
      .catch((e: unknown) => setError(toFileoraError(e).message));
  }, []);

  useEffect(() => {
    if (center) load(center);
  }, [center, load]);

  const reload = () => {
    setSelected(null);
    setEdges(null);
    if (center) load(center);
  };

  // Zoom and pan.
  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const pan = usePanGesture({ onUpdate: (e) => { tx.value += e.changeX; ty.value += e.changeY; } });
  const pinch = usePinchGesture({ onUpdate: (e) => { scale.value = Math.min(3, Math.max(0.5, scale.value * e.scaleChange)); } });
  const gesture = useSimultaneousGestures(pan, pinch);
  const canvasStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }] }));

  const size = Math.min(width - theme.spacing.lg * 2, 420);
  const layout = useMemo(() => {
    const list = edges ?? [];
    const radius = size / 2 - NODE / 2 - 8;
    return list.map((edge, i) => {
      const angle = (i / Math.max(1, list.length)) * Math.PI * 2 - Math.PI / 2;
      // Stronger relationships sit closer to the centre.
      const r = radius * (edge.score >= 60 ? 0.62 : 1);
      return { edge, x: size / 2 + Math.cos(angle) * r, y: size / 2 + Math.sin(angle) * r, angle, r };
    });
  }, [edges, size]);

  const openNode = async (node: GraphNode) => {
    const raw = await storage.stat(node.uri).catch(() => null);
    if (!raw) {
      showToast(`“${node.name}” is no longer available.`, 'error');
      return;
    }
    void openFile(toFileEntry(raw, node.parentUri, node.locationId ?? '')).catch(() => showToast('No app can open this file', 'error'));
  };

  const linkPicked = async () => {
    if (!center) return;
    const picked = await File.pickFileAsync().catch(() => null);
    if (!picked || picked.canceled) return;
    const file = picked.result;
    await linkFiles(center, { uri: file.uri, parentUri: '', locationId: null, name: file.name, category: categorize(file.name, false, mimeTypeFor(file.name, file.type || null)), modifiedAt: null });
    showToast(`Linked “${file.name}”`, 'success');
    reload();
  };

  if (!center) return null;
  if (error) return <EmptyState tone="error" icon="alert-circle-outline" title="Could not find related files" message={error} action={{ label: 'Try again', onPress: reload }} />;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Stack.Screen options={{ title: 'Related files' }} />
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md, paddingBottom: insets.bottom + theme.spacing.xxxl }}>
        <View style={[styles.row, { gap: theme.spacing.sm }]}>
          {trail.length > 1 ? <IconButton icon="arrow-left" label="Previous file in graph" onPress={() => { setSelected(null); back(); }} /> : null}
          <FileIcon category={center.category} />
          <AppText variant="heading" numberOfLines={2} style={styles.flex}>
            {center.name}
          </AppText>
        </View>
        <View style={[styles.row, { gap: theme.spacing.sm }]}>
          <Chip label="Graph" icon="graph-outline" selected={mode === 'graph'} onPress={() => setMode('graph')} />
          <Chip label="List" icon="view-list" selected={mode === 'list'} onPress={() => setMode('list')} />
          <Button label="Link a file…" variant="ghost" compact icon="link-variant" onPress={() => void linkPicked()} />
        </View>
        <AppText variant="helper" tone="tertiary">
          Suggestions are based on shared numbers or names, workspaces, and when files were saved. They can be wrong — dismiss the ones that are.
        </AppText>

        {edges === null ? (
          <View style={{ padding: theme.spacing.xxl, alignItems: 'center', gap: theme.spacing.sm }}>
            <ActivityIndicator color={theme.colors.primary} />
            <AppText variant="helper" tone="secondary">
              Looking for connections on this device…
            </AppText>
          </View>
        ) : edges.length === 0 ? (
          <EmptyState icon="graph-outline" title="No related files found" message="Turning on content search helps Fileora spot documents that mention the same invoice or order numbers. You can also link files yourself." />
        ) : mode === 'graph' ? (
          <GestureDetector gesture={gesture}>
            <View style={{ height: size, overflow: 'hidden', borderRadius: theme.radii.lg, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border }} accessibilityLabel="Relationship graph. Use the list view for a screen-reader friendly version.">
              <Animated.View style={[{ width: size, height: size, alignSelf: 'center' }, canvasStyle]}>
                {layout.map(({ edge, angle, r }) => (
                  <View
                    key={`line-${edge.node.uri}`}
                    style={{
                      position: 'absolute',
                      left: size / 2,
                      top: size / 2,
                      width: r,
                      height: edge.manual ? 3 : edge.score >= 40 ? 2 : 1,
                      backgroundColor: edge.manual ? theme.colors.primary : theme.colors.borderStrong,
                      transform: [{ rotate: `${angle}rad` }],
                      transformOrigin: '0% 50%',
                    }}
                  />
                ))}
                <View style={[styles.node, { left: size / 2 - NODE / 2, top: size / 2 - NODE / 2, borderColor: theme.colors.primary, backgroundColor: theme.colors.primarySubtle }]}>
                  <FileIcon category={center.category} size={NODE - 14} />
                </View>
                {layout.map(({ edge, x, y }) => (
                  <Pressable
                    key={edge.node.uri}
                    accessibilityRole="button"
                    accessibilityLabel={`${edge.node.name}. ${edge.reasons.map((r) => r.text).join('. ')}`}
                    onPress={() => setSelected(edge)}
                    style={[styles.node, { left: x - NODE / 2, top: y - NODE / 2, borderColor: selected?.node.uri === edge.node.uri ? theme.colors.accent : theme.colors.border, backgroundColor: theme.colors.surfaceRaised }]}
                  >
                    <FileIcon category={edge.node.category} size={NODE - 18} />
                  </Pressable>
                ))}
              </Animated.View>
            </View>
          </GestureDetector>
        ) : (
          <Card>
            {edges.map((edge) => (
              <ListItem key={edge.node.uri} title={edge.node.name} subtitle={edge.reasons.map((r) => r.text).join(' · ')} leading={<FileIcon category={edge.node.category} />} onPress={() => setSelected(edge)} selected={selected?.node.uri === edge.node.uri} />
            ))}
          </Card>
        )}

        {selected ? (
          <Card style={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}>
            <View style={[styles.row, { gap: theme.spacing.sm }]}>
              <FileIcon category={selected.node.category} />
              <AppText variant="bodyStrong" numberOfLines={2} style={styles.flex}>
                {selected.node.name}
              </AppText>
              <Badge label={selected.manual ? 'Linked by you' : 'Suggested relationship'} tone={selected.manual ? 'brand' : 'neutral'} />
            </View>
            {selected.reasons.map((reason) => (
              <AppText key={reason.text} variant="helper" tone="secondary">
                {`• ${reason.text}`}
              </AppText>
            ))}
            <View style={[styles.row, { gap: theme.spacing.sm, flexWrap: 'wrap' }]}>
              <Button label="Open" compact icon="open-in-app" onPress={() => void openNode(selected.node)} />
              <Button label="Explore from here" compact variant="secondary" icon="graph-outline" onPress={() => { const node = selected.node; setSelected(null); setEdges(null); push(node); }} />
              {selected.node.parentUri ? <Button label="Show in folder" compact variant="ghost" onPress={() => void showInFolder({ parentUri: selected.node.parentUri, locationId: selected.node.locationId ?? '' })} /> : null}
              {selected.manual ? (
                <Button label="Unlink" compact variant="ghost" onPress={() => void unlinkFiles(center, selected.node).then(reload)} />
              ) : (
                <>
                  <Button label="Confirm link" compact variant="ghost" icon="link-variant" onPress={() => void linkFiles(center, selected.node).then(reload)} />
                  <Button label="Not related" compact variant="ghost" icon="close" onPress={() => void dismissSuggestion(center, selected.node).then(reload)} />
                </>
              )}
            </View>
          </Card>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  node: { position: 'absolute', width: NODE, height: NODE, borderRadius: NODE / 2, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
