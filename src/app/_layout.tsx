import { DarkTheme, DefaultTheme, SplashScreen, Stack, ThemeProvider as NavigationThemeProvider } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Bootstrap } from '@/core/bootstrap/Bootstrap';
import { ThemeProvider, useTheme } from '@/core/theme/ThemeProvider';
import { useLocationsAutoRefresh } from '@/features/browse/locationsStore';
import { OperationsPanel } from '@/features/file_operations/components/OperationsPanel';
import { useVaultGuard } from '@/features/private_vault/VaultScreen';
import { ToastHost } from '@/shared/components/overlays';

void SplashScreen.preventAutoHideAsync();

// Expiry reminders should be visible even while Fileora is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

/** Tab bar height plus margin, so overlays sit above bottom bars on every screen. */
const BOTTOM_CHROME = 72;

function NavigationShell() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  useLocationsAutoRefresh();
  useVaultGuard();

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(theme.colors.background);
  }, [theme.colors.background]);

  const navigationTheme = useMemo(() => {
    const base = theme.scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: theme.colors.primary,
        background: theme.colors.background,
        card: theme.colors.surface,
        text: theme.colors.textPrimary,
        border: theme.colors.border,
        notification: theme.colors.accent,
      },
    };
  }, [theme]);

  return (
    <NavigationThemeProvider value={navigationTheme}>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: theme.colors.surface },
            headerTintColor: theme.colors.textPrimary,
            headerTitleStyle: { fontSize: theme.typography.heading.fontSize, fontWeight: theme.typography.heading.fontWeight },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: theme.colors.background },
            animation: 'slide_from_right',
            animationDuration: 260,
            headerTitleAlign: 'left',
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Fileora' }} />
          <Stack.Screen name="folder" options={{ title: '' }} />
          <Stack.Screen name="file" options={{ title: 'Details' }} />
          <Stack.Screen name="history" options={{ title: 'History' }} />
          <Stack.Screen name="trash" options={{ title: 'Trash' }} />
          <Stack.Screen name="settings" options={{ title: 'Settings' }} />
          <Stack.Screen name="storage-access" options={{ title: 'Storage access' }} />
          <Stack.Screen name="detective" options={{ title: 'Storage Detective' }} />
          <Stack.Screen name="detective-review" options={{ title: 'Review' }} />
          <Stack.Screen name="workspace" options={{ title: 'Workspace' }} />
          <Stack.Screen name="vault" options={{ title: 'Private Vault' }} />
          <Stack.Screen name="privacy" options={{ title: 'Privacy check' }} />
          <Stack.Screen name="expiry" options={{ title: 'Expiry radar' }} />
          <Stack.Screen name="compare" options={{ title: 'Compare' }} />
          <Stack.Screen name="changes" options={{ title: 'Change radar' }} />
          <Stack.Screen name="related" options={{ title: 'Related files' }} />
          <Stack.Screen name="handoff" options={{ title: 'Smart handoff' }} />
        </Stack>
        <OperationsPanel bottomOffset={insets.bottom + BOTTOM_CHROME} />
        <ToastHost bottomOffset={insets.bottom + BOTTOM_CHROME} />
      </View>
    </NavigationThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <Bootstrap>
          <ThemeProvider>
            <NavigationShell />
          </ThemeProvider>
        </Bootstrap>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
