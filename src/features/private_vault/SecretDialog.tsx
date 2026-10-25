import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, TextInput, View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { AppText, Button } from '@/shared/components/primitives';

/** Masked entry for passcodes and recovery keys. With `confirm`, the value must be typed twice. */
export function SecretDialog({
  visible,
  title,
  message,
  confirm = false,
  masked = true,
  confirmLabel,
  validate,
  busy = false,
  error,
  onSubmit,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message?: string;
  confirm?: boolean;
  masked?: boolean;
  confirmLabel: string;
  validate?: (value: string) => string | null;
  busy?: boolean;
  error?: string | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const [value, setValue] = useState('');
  const [repeat, setRepeat] = useState('');
  const [touched, setTouched] = useState(false);
  const problem = (validate?.(value) ?? null) || (confirm && repeat !== value ? 'The two entries do not match.' : null);
  const inputStyle = [
    theme.typography.body,
    { color: theme.colors.textPrimary, borderWidth: theme.borderWidths.focus, borderColor: theme.colors.primary, borderRadius: theme.radii.md, paddingHorizontal: theme.spacing.md, minHeight: theme.touchTarget },
  ];
  const submit = () => {
    setTouched(true);
    if (!problem && value) onSubmit(value);
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.root, { backgroundColor: theme.colors.scrim }]}>
        <View accessibilityViewIsModal style={[styles.dialog, { backgroundColor: theme.colors.surfaceRaised, borderRadius: theme.radii.xl, padding: theme.spacing.xl, gap: theme.spacing.md }]}>
          <AppText variant="heading" accessibilityRole="header">
            {title}
          </AppText>
          {message ? (
            <AppText variant="body" tone="secondary">
              {message}
            </AppText>
          ) : null}
          <TextInput
            autoFocus
            value={value}
            onChangeText={setValue}
            secureTextEntry={masked}
            autoCapitalize={masked ? 'none' : 'characters'}
            autoCorrect={false}
            autoComplete="off"
            importantForAutofill="no"
            accessibilityLabel={title}
            onSubmitEditing={confirm ? undefined : submit}
            style={inputStyle}
          />
          {confirm ? (
            <TextInput
              value={repeat}
              onChangeText={setRepeat}
              secureTextEntry={masked}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              importantForAutofill="no"
              placeholder="Enter it again"
              placeholderTextColor={theme.colors.textTertiary}
              accessibilityLabel="Enter it again"
              onSubmitEditing={submit}
              style={inputStyle}
            />
          ) : null}
          {(touched && problem) || error ? (
            <AppText variant="helper" tone="danger" accessibilityLiveRegion="polite">
              {error ?? problem}
            </AppText>
          ) : null}
          <Button label={confirmLabel} onPress={submit} loading={busy} />
          <Button label="Cancel" variant="ghost" onPress={onCancel} disabled={busy} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', padding: 24 },
  dialog: { width: '100%', maxWidth: 440, alignSelf: 'center' },
});
