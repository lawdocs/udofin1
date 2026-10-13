import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme';

/** Minimum touch target of 48 dp (Android accessibility guidance). */
const TARGET = 48;

export function Screen({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.color.background }]}>
      <View style={{ padding: theme.space.lg, gap: theme.space.md, flex: 1 }}>{children}</View>
    </SafeAreaView>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{ color: theme.color.text, fontSize: theme.typography.size.xxl, fontWeight: '700' }}
    >
      {children}
    </Text>
  );
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const theme = useTheme();
  return (
    <Text
      style={{
        color: muted ? theme.color.textMuted : theme.color.text,
        fontSize: theme.typography.size.md,
      }}
    >
      {children}
    </Text>
  );
}

export function Button({
  title,
  onPress,
  disabled,
  busy,
  secondary,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  secondary?: boolean;
}) {
  const theme = useTheme();
  const inactive = disabled === true || busy === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: inactive, busy: busy === true }}
      disabled={inactive}
      onPress={onPress}
      style={{
        minHeight: TARGET,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: theme.color.primary,
        backgroundColor: secondary ? 'transparent' : theme.color.primary,
        opacity: inactive ? 0.6 : 1,
        paddingHorizontal: theme.space.md,
      }}
    >
      {busy ? (
        <ActivityIndicator color={secondary ? theme.color.primary : theme.color.onPrimary} />
      ) : (
        <Text
          style={{
            color: secondary ? theme.color.primary : theme.color.onPrimary,
            fontWeight: '600',
            fontSize: theme.typography.size.md,
          }}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  error,
  ...input
}: { label: string; error?: string | null } & TextInputProps) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space.xs }}>
      <Text style={{ color: theme.color.text, fontWeight: '600' }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={theme.color.textMuted}
        style={{
          minHeight: TARGET,
          borderWidth: 1,
          borderColor: error ? theme.color.danger : theme.color.border,
          borderRadius: theme.radius.md,
          paddingHorizontal: theme.space.md,
          color: theme.color.text,
          fontSize: theme.typography.size.lg,
        }}
        {...input}
      />
      {error ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ color: theme.color.danger }}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function Banner({
  tone,
  children,
}: {
  tone: 'info' | 'warning' | 'danger';
  children: ReactNode;
}) {
  const theme = useTheme();
  const colour =
    tone === 'danger'
      ? theme.color.danger
      : tone === 'warning'
        ? theme.color.warning
        : theme.color.info;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        borderWidth: 1,
        borderColor: colour,
        borderRadius: theme.radius.md,
        padding: theme.space.md,
      }}
    >
      <Text style={{ color: theme.color.text }}>{children}</Text>
    </View>
  );
}

export function Loading({ label }: { label: string }) {
  const theme = useTheme();
  return (
    <Screen>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={label}
        style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: theme.space.md }}
      >
        <ActivityIndicator size="large" color={theme.color.primary} />
        <Body muted>{label}</Body>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });

/** A selectable row (single choice). State is announced to screen readers and never colour-only. */
export function Choice({
  label,
  detail,
  selected,
  onPress,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={detail ? `${label}. ${detail}` : label}
      accessibilityState={{ selected, checked: selected }}
      onPress={onPress}
      style={{
        minHeight: TARGET,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.sm,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? theme.color.primary : theme.color.border,
        borderRadius: theme.radius.md,
        padding: theme.space.md,
      }}
    >
      <Text style={{ color: theme.color.text, fontSize: theme.typography.size.lg }}>
        {selected ? '●' : '○'}
      </Text>
      <View style={{ flex: 1 }}>
        <Text
          style={{ color: theme.color.text, fontSize: theme.typography.size.md, fontWeight: '600' }}
        >
          {label}
        </Text>
        {detail ? <Text style={{ color: theme.color.textMuted }}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

/** A labelled on/off row. Starts off unless the caller says otherwise; never pre-ticked on our behalf. */
export function CheckRow({
  label,
  checked,
  onToggle,
  disabled,
}: {
  label: string;
  checked: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled: disabled === true }}
      disabled={disabled}
      onPress={() => onToggle(!checked)}
      style={{
        minHeight: TARGET,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.sm,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <Text style={{ color: theme.color.text, fontSize: theme.typography.size.xl }}>
        {checked ? '☑' : '☐'}
      </Text>
      <Text style={{ color: theme.color.text, flex: 1, fontSize: theme.typography.size.md }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Card({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.color.border,
        borderRadius: theme.radius.md,
        padding: theme.space.md,
        gap: theme.space.sm,
      }}
    >
      {children}
    </View>
  );
}

export function Label({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={{ color: theme.color.text, fontWeight: '700' }}>{children}</Text>;
}

/** Scrollable screen for forms that can outgrow the display (large text sizes, small phones). */
export function ScrollScreen({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.color.background }]}>
      <ScrollView
        contentContainerStyle={{ padding: theme.space.lg, gap: theme.space.md }}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

/** A failed read: says what happened in the borrower's language and offers retry. */
export function ErrorState({
  message,
  retryLabel,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <View style={{ gap: 12 }}>
      <Banner tone="danger">{message}</Banner>
      <Button title={retryLabel} onPress={onRetry} />
    </View>
  );
}
