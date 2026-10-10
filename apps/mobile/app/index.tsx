import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../src/theme';

/**
 * Foundation build only. No borrower journey is implemented yet; this screen exists so the
 * app shell, theming and navigation can be built and verified on devices.
 */
export default function FoundationScreen() {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.color.background }]}>
      <View style={{ padding: theme.space.lg, gap: theme.space.sm }}>
        <Text
          accessibilityRole="header"
          style={{
            color: theme.color.text,
            fontSize: theme.typography.size.xxl,
            fontWeight: '700',
          }}
        >
          Udofin
        </Text>
        <Text style={{ color: theme.color.textMuted, fontSize: theme.typography.size.md }}>
          Foundation build — borrower features are not implemented yet.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
