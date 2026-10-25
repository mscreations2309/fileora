import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatCount } from '@/core/format/format';
import { usePreferences } from '@/core/preferences/preferences';
import { storage, toFileEntry } from '@/core/storage/storage';
import { useTheme } from '@/core/theme/ThemeProvider';
import { openFile } from '@/features/library/library';
import { ProgressBar, Sheet, SheetAction, showToast } from '@/shared/components/overlays';
import { AppText, Badge, Button, Card, Chip, EmptyState, Icon, IconButton, SectionHeader } from '@/shared/components/primitives';

import { CATEGORY_LABELS, daysUntil, isValidIsoDate, type DocumentCategory } from './dateExtraction';
import { confirmExpiry, detectInIndex, listExpiry, markRenewed, setStatus, useExpiryRevision, type ExpiryItem } from './repository';

const CATEGORIES = Object.keys(CATEGORY_LABELS) as DocumentCategory[];
const REMIND_OPTIONS = [7, 30, 60, 90];

function dueLabel(days: number): string {
  if (days < 0) return `Expired ${-days} ${days === -1 ? 'day' : 'days'} ago`;
  if (days === 0) return 'Expires today';
  return `In ${days} ${days === 1 ? 'day' : 'days'}`;
}

function ConfirmEditor({ item, onClose }: { item: ExpiryItem; onClose: () => void }) {
  const theme = useTheme();
  const [date, setDate] = useState(item.expiresOn);
  const [category, setCategory] = useState(item.category);
  const [remind, setRemind] = useState(item.remindDays);
  const valid = isValidIsoDate(date);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.modalRoot, { backgroundColor: theme.colors.scrim }]}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}>
          <View style={{ backgroundColor: theme.colors.surfaceRaised, borderRadius: theme.radii.xl, padding: theme.spacing.xl, gap: theme.spacing.md }}>
            <AppText variant="heading" accessibilityRole="header">
              {item.status === 'suggested' ? 'Confirm expiry date' : 'Edit reminder'}
            </AppText>
            <AppText variant="meta" tone="secondary" numberOfLines={2}>
              {item.name}
            </AppText>
            {item.sourceText ? (
              <Card style={{ padding: theme.spacing.md }}>
                <AppText variant="caption" tone="tertiary">
                  Found in the document
                </AppText>
                <AppText variant="body">{`“${item.sourceText}”`}</AppText>
              </Card>
            ) : null}
            <AppText variant="caption" tone="secondary">
              Expiry date (YYYY-MM-DD) — check it against the document
            </AppText>
            <TextInput
              value={date}
              onChangeText={setDate}
              keyboardType="numbers-and-punctuation"
              accessibilityLabel="Expiry date"
              style={[theme.typography.body, { color: theme.colors.textPrimary, borderWidth: 2, borderColor: valid ? theme.colors.primary : theme.colors.danger, borderRadius: theme.radii.md, paddingHorizontal: theme.spacing.md, minHeight: theme.touchTarget }]}
            />
            {!valid ? (
              <AppText variant="helper" tone="danger">
                Enter a real date like 2027-01-31.
              </AppText>
            ) : null}
            <AppText variant="caption" tone="secondary">
              Type of document
            </AppText>
            <View style={styles.wrap}>
              {CATEGORIES.map((c) => (
                <Chip key={c} label={CATEGORY_LABELS[c]} selected={category === c} onPress={() => setCategory(c)} />
              ))}
            </View>
            <AppText variant="caption" tone="secondary">
              Remind me before
            </AppText>
            <View style={styles.wrap}>
              {REMIND_OPTIONS.map((d) => (
                <Chip key={d} label={`${d} days`} selected={remind === d} onPress={() => setRemind(d)} />
              ))}
            </View>
            <Button
              label="Confirm and remind me"
              disabled={!valid}
              onPress={() => {
                onClose();
                void confirmExpiry(item, { expiresOn: date.trim(), category, remindDays: remind }).then(({ reminder }) =>
                  showToast(reminder ? 'Saved. Fileora will remind you before this date.' : 'Saved. Reminders are off because notifications are not allowed.', reminder ? 'success' : 'neutral'),
                );
              }}
            />
            <Button label="Cancel" variant="ghost" onPress={onClose} />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

function MonthCalendar({ items, onSelect }: { items: ExpiryItem[]; onSelect: (item: ExpiryItem) => void }) {
  const theme = useTheme();
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const byDay = new Map<number, ExpiryItem[]>();
  for (const item of items) {
    const [y, m, d] = item.expiresOn.split('-').map(Number);
    if (y === year && m === month + 1 && d) byDay.set(d, [...(byDay.get(d) ?? []), item]);
  }
  const cells: (number | null)[] = [...Array<null>(firstWeekday).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const today = new Date();
  const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(cursor);
  return (
    <Card style={{ padding: theme.spacing.md, gap: theme.spacing.sm }}>
      <View style={styles.row}>
        <IconButton icon="chevron-left" label="Previous month" onPress={() => setCursor(new Date(year, month - 1, 1))} />
        <AppText variant="bodyStrong" style={[styles.flex, { textAlign: 'center' }]}>
          {monthName}
        </AppText>
        <IconButton icon="chevron-right" label="Next month" onPress={() => setCursor(new Date(year, month + 1, 1))} />
      </View>
      <View style={styles.grid}>
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <AppText key={`${d}${i}`} variant="caption" tone="tertiary" style={styles.cellText}>
            {d}
          </AppText>
        ))}
        {cells.map((day, index) => {
          const dayItems = day ? (byDay.get(day) ?? []) : [];
          const isToday = day !== null && today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
          return (
            <Pressable
              key={index}
              disabled={dayItems.length === 0}
              accessibilityRole={dayItems.length ? 'button' : undefined}
              accessibilityLabel={day ? `${day} ${monthName}${dayItems.length ? `, ${dayItems.length} expiring` : ''}` : undefined}
              onPress={() => dayItems[0] && onSelect(dayItems[0])}
              style={[styles.cell, { borderRadius: theme.radii.sm, backgroundColor: dayItems.length ? theme.colors.warningSubtle : 'transparent', borderWidth: isToday ? 1 : 0, borderColor: theme.colors.primary }]}
            >
              <AppText variant="caption" tone={dayItems.length ? 'warning' : 'primary'}>
                {day ?? ''}
              </AppText>
              {dayItems.length ? <View style={[styles.dot, { backgroundColor: theme.colors.warning }]} /> : null}
            </Pressable>
          );
        })}
      </View>
    </Card>
  );
}

export function ExpiryRadarScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const revision = useExpiryRevision((s) => s.revision);
  const indexEnabled = usePreferences((s) => s.contentIndexEnabled);
  const [items, setItems] = useState<ExpiryItem[] | null>(null);
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [editing, setEditing] = useState<ExpiryItem | null>(null);
  const [menu, setMenu] = useState<ExpiryItem | null>(null);
  const [renewing, setRenewing] = useState<ExpiryItem | null>(null);
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null);

  const load = useCallback(() => {
    void listExpiry().then(setItems);
  }, []);
  useEffect(load, [load, revision]);

  const groups = useMemo(() => {
    const all = items ?? [];
    const active = all.filter((i) => i.status === 'confirmed');
    return {
      suggested: all.filter((i) => i.status === 'suggested'),
      overdue: active.filter((i) => daysUntil(i.expiresOn) < 0),
      upcoming: active.filter((i) => daysUntil(i.expiresOn) >= 0 && daysUntil(i.expiresOn) <= 90),
      later: active.filter((i) => daysUntil(i.expiresOn) > 90),
      completed: all.filter((i) => i.status === 'renewed' || i.status === 'done'),
    };
  }, [items]);

  const runScan = async () => {
    setScan({ done: 0, total: 0 });
    const added = await detectInIndex((done, total) => setScan({ done, total }));
    setScan(null);
    showToast(added ? `Found ${formatCount(added)} possible expiry ${added === 1 ? 'date' : 'dates'} to review` : 'No new expiry dates found', added ? 'success' : 'neutral');
  };

  const open = async (item: ExpiryItem) => {
    const raw = await storage.stat(item.uri).catch(() => null);
    if (!raw) {
      showToast('This document is no longer available.', 'error');
      return;
    }
    void openFile(toFileEntry(raw, item.parentUri, item.locationId ?? '')).catch(() => showToast('No app can open this file', 'error'));
  };

  const renderItem = (item: ExpiryItem) => {
    const days = daysUntil(item.expiresOn);
    return (
      <Pressable
        key={item.id}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}, ${CATEGORY_LABELS[item.category]}, ${item.status === 'suggested' ? 'suggested date' : dueLabel(days)}, ${item.expiresOn}`}
        onPress={() => (item.status === 'suggested' ? setEditing(item) : setMenu(item))}
        style={({ pressed }) => [styles.item, { padding: theme.spacing.md, gap: theme.spacing.md, backgroundColor: pressed ? theme.colors.surfaceSunken : theme.colors.surface, borderColor: theme.colors.border, borderRadius: theme.radii.lg }]}
      >
        <Icon name={item.status === 'suggested' ? 'calendar-question' : days < 0 ? 'calendar-alert' : 'calendar-clock'} color={item.status === 'suggested' ? theme.colors.textSecondary : days < 0 ? theme.colors.danger : days <= 30 ? theme.colors.warning : theme.colors.primary} />
        <View style={styles.flex}>
          <AppText variant="bodyStrong" numberOfLines={1}>
            {item.name}
          </AppText>
          <AppText variant="meta" tone="secondary">
            {`${CATEGORY_LABELS[item.category]} · ${item.expiresOn}${item.status === 'suggested' ? '' : ` · ${dueLabel(days)}`}`}
          </AppText>
          {item.status === 'suggested' && item.sourceText ? (
            <AppText variant="helper" tone="tertiary" numberOfLines={2}>
              {`From: “${item.sourceText}”`}
            </AppText>
          ) : null}
        </View>
        {item.status === 'suggested' ? <Badge label={item.confidence === 'low' ? 'Check carefully' : 'Suggested'} tone={item.confidence === 'low' ? 'warning' : 'brand'} /> : null}
      </Pressable>
    );
  };

  const section = (title: string, list: ExpiryItem[], note?: string) =>
    list.length === 0 ? null : (
      <View style={{ gap: theme.spacing.sm }}>
        <SectionHeader title={`${title} · ${list.length}`} />
        {note ? (
          <AppText variant="helper" tone="tertiary">
            {note}
          </AppText>
        ) : null}
        {list.map(renderItem)}
      </View>
    );

  return (
    <ScrollView style={{ backgroundColor: theme.colors.background }} contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: insets.bottom + theme.spacing.xxxl, gap: theme.spacing.md }}>
      <AppText variant="body" tone="secondary">
        Fileora reads dates near words like “expires” or “valid until”. Every date is a suggestion until you confirm it — reminders are not legal or financial advice.
      </AppText>
      <View style={[styles.row, { gap: theme.spacing.sm }]}>
        <Chip label="List" icon="view-list" selected={view === 'list'} onPress={() => setView('list')} />
        <Chip label="Calendar" icon="calendar-month-outline" selected={view === 'calendar'} onPress={() => setView('calendar')} />
      </View>
      {indexEnabled ? (
        <Button label="Find expiry dates in my documents" icon="calendar-search" variant="secondary" loading={scan !== null} onPress={() => void runScan()} />
      ) : (
        <AppText variant="helper" tone="tertiary">
          Turn on content search in Search to find dates across your documents, or use “Check for expiry date” in a file’s ⋮ menu.
        </AppText>
      )}
      {scan && scan.total > 0 ? <ProgressBar progress={scan.done / scan.total} /> : null}

      {items && items.length === 0 ? <EmptyState icon="calendar-clock" title="No documents tracked" message="Insurance policies, warranties, certificates and IDs with expiry dates will appear here once you confirm them." /> : null}

      {view === 'calendar' ? (
        <MonthCalendar items={[...groups.overdue, ...groups.upcoming, ...groups.later]} onSelect={setMenu} />
      ) : (
        <>
          {section('Needs your confirmation', groups.suggested, 'Tap to check the date against the document and turn on a reminder.')}
          {section('Overdue', groups.overdue)}
          {section('Due in the next 90 days', groups.upcoming)}
          {section('Later', groups.later)}
          {section('Renewed or done', groups.completed)}
        </>
      )}

      {editing ? <ConfirmEditor item={editing} onClose={() => setEditing(null)} /> : null}
      <Sheet visible={menu !== null} onClose={() => setMenu(null)} title={menu?.name} subtitle={menu ? `${CATEGORY_LABELS[menu.category]} · ${menu.expiresOn}` : undefined}>
        <SheetAction icon="open-in-app" label="Open document" onPress={() => { const i = menu; setMenu(null); if (i) void open(i); }} />
        <SheetAction icon="pencil-outline" label="Edit date or reminder" onPress={() => { const i = menu; setMenu(null); setEditing(i); }} />
        <SheetAction icon="autorenew" label="Renewed — link the new document" onPress={() => { const i = menu; setMenu(null); setRenewing(i); }} />
        <SheetAction icon="check" label="Mark as done" onPress={() => { const i = menu; setMenu(null); if (i) void setStatus(i, 'done'); }} />
        <SheetAction icon="close" label="Stop tracking" destructive onPress={() => { const i = menu; setMenu(null); if (i) void setStatus(i, 'dismissed'); }} />
      </Sheet>
      <Sheet visible={renewing !== null} onClose={() => setRenewing(null)} title="Which document replaces it?" subtitle="Pick the newer version. The old reminder stops.">
        {(items ?? [])
          .filter((i) => renewing && i.id !== renewing.id && i.status !== 'renewed' && i.expiresOn > renewing.expiresOn)
          .map((i) => (
            <SheetAction key={i.id} icon="file-document-outline" label={`${i.name} · ${i.expiresOn}`} onPress={() => { const old = renewing; setRenewing(null); if (old) void markRenewed(old, i).then(() => showToast('Linked to the newer document', 'success')); }} />
          ))}
        <AppText variant="helper" tone="tertiary" style={{ padding: theme.spacing.lg }}>
          Don’t see it? Check the new document for its expiry date first (⋮ › Check for expiry date), then come back.
        </AppText>
      </Sheet>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  item: { flexDirection: 'row', alignItems: 'center', borderWidth: 1 },
  modalRoot: { flex: 1, padding: 24 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  cellText: { width: `${100 / 7}%`, textAlign: 'center' },
  dot: { width: 5, height: 5, borderRadius: 3, marginTop: 2 },
});
