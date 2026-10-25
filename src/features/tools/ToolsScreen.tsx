import { router, type Href } from 'expo-router';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { AppText, Card, Divider, FadeIn, GradientTile, Icon, ListItem, SectionHeader, type IconName } from '@/shared/components/primitives';
import { TabScreen } from '@/shared/components/TabScreen';
import { PressableScale } from '@/shared/motion/PressableScale';

type Tool = { icon: IconName; title: string; description: string; href: Href; colors: [string, string] };

/** Signature features, each with its own gradient identity. */
const FEATURES: Tool[] = [
  { icon: 'shield-lock-outline', title: 'Private Vault', description: 'Encrypted, biometric-locked storage', href: '/vault', colors: ['#7C3AED', '#DB2777'] },
  { icon: 'database-search-outline', title: 'Storage Detective', description: 'Duplicates, big and old files', href: '/detective', colors: ['#F97316', '#E11D48'] },
  { icon: 'text-search', title: 'Search by meaning', description: 'Find files by what they say', href: '/search', colors: ['#00B3A4', '#2F8CFF'] },
  { icon: 'briefcase-outline', title: 'Workspaces', description: 'Group files by project', href: '/workspaces', colors: ['#0EA5E9', '#6366F1'] },
  { icon: 'eye-off-outline', title: 'Privacy scanner', description: 'Check before you share', href: '/browse', colors: ['#14B8A6', '#0F766E'] },
  { icon: 'calendar-clock', title: 'Expiry radar', description: 'Never miss a renewal', href: '/expiry', colors: ['#F59E0B', '#EF4444'] },
  { icon: 'file-compare', title: 'Change radar', description: 'See what changed', href: '/changes', colors: ['#8B5CF6', '#3B82F6'] },
  { icon: 'graph-outline', title: 'Relationships', description: 'Connected documents', href: '/browse', colors: ['#EC4899', '#8B5CF6'] },
  { icon: 'cellphone-arrow-down', title: 'Smart handoff', description: 'Verified device transfers', href: '/handoff', colors: ['#10B981', '#0EA5E9'] },
  { icon: 'laptop', title: 'Fileora Web', description: 'Manage files from a laptop', href: '/web', colors: ['#6366F1', '#06B6D4'] },
];

const UTILITIES: { icon: IconName; title: string; description: string; href: Href }[] = [
  { icon: 'history', title: 'Operation history', description: 'Every change, with undo where possible', href: '/history' },
  { icon: 'trash-can-outline', title: 'Trash', description: 'Restore deleted items', href: '/trash' },
  { icon: 'folder-key-outline', title: 'Storage access', description: 'Review what Fileora can see', href: '/storage-access' },
  { icon: 'cog-outline', title: 'Settings', description: 'Themes, colours and privacy', href: '/settings' },
];

export function ToolsScreen() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const columns = width > 600 ? 3 : 2;
  const cardWidth = (width - theme.spacing.lg * 2 - theme.spacing.md * (columns - 1)) / columns;
  return (
    <TabScreen title="Tools" subtitle="Everything Fileora can do">
      <View style={{ paddingHorizontal: theme.spacing.lg }}>
        <SectionHeader title="Features" />
        <View style={[styles.grid, { gap: theme.spacing.md }]}>
          {FEATURES.map((tool, index) => (
            <FadeIn key={tool.title} index={index}>
              <PressableScale
                haptic
                scaleTo={0.95}
                accessibilityRole="button"
                accessibilityLabel={`${tool.title}. ${tool.description}`}
                onPress={() => router.push(tool.href)}
                style={[styles.card, { width: cardWidth, padding: theme.spacing.lg, borderRadius: theme.radii.xl, backgroundColor: theme.colors.surface, borderColor: theme.colors.border, gap: theme.spacing.md }, theme.elevation('low')]}
              >
                <GradientTile icon={tool.icon} size={48} colors={tool.colors} />
                <View style={{ gap: 2 }}>
                  <AppText variant="bodyStrong" numberOfLines={1}>
                    {tool.title}
                  </AppText>
                  <AppText variant="helper" tone="secondary" numberOfLines={2}>
                    {tool.description}
                  </AppText>
                </View>
              </PressableScale>
            </FadeIn>
          ))}
        </View>
        <AppText variant="helper" tone="tertiary" style={{ paddingTop: theme.spacing.md }}>
          Privacy check, Related files, Compare and Move to Vault are also in every file’s ⋮ menu.
        </AppText>
        <SectionHeader title="Manage" />
        <FadeIn index={FEATURES.length}>
          <Card>
            {UTILITIES.map((tool, index) => (
              <View key={tool.title}>
                {index > 0 ? <Divider inset={76} /> : null}
                <ListItem
                  title={tool.title}
                  subtitle={tool.description}
                  leading={
                    <View style={[styles.utilIcon, { backgroundColor: theme.colors.primarySubtle, borderRadius: theme.radii.md }]}>
                      <Icon name={tool.icon} size={theme.iconSizes.md} color={theme.colors.primary} />
                    </View>
                  }
                  trailing={<Icon name="chevron-right" color={theme.colors.textTertiary} />}
                  onPress={() => router.push(tool.href)}
                />
              </View>
            ))}
          </Card>
        </FadeIn>
      </View>
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  card: { borderWidth: StyleSheet.hairlineWidth, minHeight: 150 },
  utilIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
