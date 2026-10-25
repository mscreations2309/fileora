import { deleteDatabaseAsync } from 'expo-sqlite';
import { SplashScreen } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { initDatabase } from '@/core/database/database';
import { presentError, toFileoraError, type FileoraError } from '@/core/errors/FileoraError';
import { logger } from '@/core/logging/logger';
import { usePreferences } from '@/core/preferences/preferences';
import { ThemeProvider, useTheme } from '@/core/theme/ThemeProvider';
import { Button } from '@/shared/components/primitives';
import { recoverInterruptedOperations } from '@/features/file_operations/operationsStore';

/**
 * Startup work is limited to what the first screen needs: open the database, apply migrations and
 * load preferences. No storage scanning happens here. Interrupted-operation cleanup runs afterwards
 * without blocking the UI.
 */
type StartupState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; error: FileoraError };

async function startup(): Promise<StartupState> {
  try {
    await initDatabase();
    await usePreferences.getState().hydrate();
    recoverInterruptedOperations().catch((error: unknown) => logger.warn('bootstrap', 'Interrupted-operation recovery failed', error));
    return { status: 'ready' };
  } catch (error) {
    logger.error('bootstrap', 'Startup failed', error);
    return { status: 'error', error: toFileoraError(error) };
  }
}

export function Bootstrap({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StartupState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void startup().then((next) => {
      if (active) setState(next);
      SplashScreen.hide();
    });
    return () => {
      active = false;
    };
  }, [attempt]);
  const start = () => setAttempt((n) => n + 1);

  if (state.status === 'loading') return null;
  if (state.status === 'error') {
    return (
      <ThemeProvider>
        <StartupError error={state.error} onRetry={start} />
      </ThemeProvider>
    );
  }
  return children;
}

/** Rendered without navigation (the database is unavailable), using default preferences. */
function StartupError({ error, onRetry }: { error: FileoraError; onRetry: () => void }) {
  const theme = useTheme();
  const [confirmReset, setConfirmReset] = useState(false);
  const presentation = presentError(error);
  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background, padding: theme.spacing.xl, gap: theme.spacing.lg }]}>
      <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>{presentation.title}</Text>
      <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>{presentation.guidance}</Text>
      <Button label="Try again" onPress={onRetry} />
      {confirmReset ? (
        <View style={{ gap: theme.spacing.sm }}>
          <Text style={[theme.typography.body, { color: theme.colors.danger }]}>
            This erases Fileora’s history, favorites, granted-folder list and Trash index. Your files are not deleted, but items in Trash will no longer be listed.
          </Text>
          <Button
            label="Reset Fileora data"
            variant="danger"
            onPress={() => {
              void deleteDatabaseAsync('fileora.db')
                .catch((cause: unknown) => logger.error('bootstrap', 'Reset failed', cause))
                .then(onRetry);
            }}
          />
        </View>
      ) : (
        <Button label="Reset Fileora data…" variant="ghost" onPress={() => setConfirmReset(true)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center' },
});
